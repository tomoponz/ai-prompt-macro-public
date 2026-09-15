import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVE_RUN_KEY_PREFIX,
  conversationFingerprint,
  filterRuns,
  freshnessLabel,
  isActiveRunKey,
  projectDiagnostics,
  projectRun,
  projectRunList,
  runDisplayName,
  runIdDisplay,
  tabIdFromRunKey
} from "../src/workspace-projection.js";

const NOW = Date.parse("2026-08-28T12:00:00.000Z");

/* A realistic persisted Run, including the fields that must never be projected. */
function rawRun(overrides = {}) {
  return {
    schemaVersion: 3,
    runId: "1a2b3c4d-5e6f-7890-abcd-ef0123456789",
    provider: "chatgpt",
    conversationKey: "chatgpt:c:6a8f1234567890abcdef",
    documentInstanceId: "instance-super-secret-value",
    executionSessionId: "session-super-secret-value",
    contentVersion: "0.4.0",
    boundTabId: 42,
    keepAwake: true,
    workflow: {
      name: "リリース前チェック",
      maxSends: 5,
      recovery: { mode: "completion" },
      steps: [
        { id: "s1", type: "prompt", delivery: "send", prompt: "これは絶対に表示してはいけないPrompt本文です" },
        { id: "s2", type: "checkpoint", label: "内容を確認" }
      ]
    },
    plannedSends: 40,
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 12 },
    status: "running",
    phase: "ready",
    pauseReason: null,
    lastErrorCode: null,
    resumable: true,
    outbox: { id: "outbox-1", stepId: "s1", promptHash: "deadbeef", state: "confirmed", position: {} },
    startedAt: "2026-08-28T11:00:00.000Z",
    updatedAt: "2026-08-28T11:52:00.000Z",
    ...overrides
  };
}

const runKey = (tabId) => `${ACTIVE_RUN_KEY_PREFIX}${tabId}`;

test("active Run key prefix matches the background implementation", () => {
  assert.equal(ACTIVE_RUN_KEY_PREFIX, "aipm.activeRun.v2.tab.");
  assert.equal(isActiveRunKey(runKey(42)), true);
  assert.equal(tabIdFromRunKey(runKey(42)), 42);
  for (const key of ["aipm.activeRun.v1", "aipm.diagnostics.v1", ACTIVE_RUN_KEY_PREFIX, null, 7]) {
    assert.equal(isActiveRunKey(key), false);
  }
});

test("projection exposes only the allowlisted fields", () => {
  const projection = projectRun(rawRun(), { tabId: 42, alias: "調査A", now: NOW });
  assert.deepEqual(Object.keys(projection).sort(), [
    "alias", "color", "conversationFingerprint", "currentStepLabel", "currentStepNumber", "diagnostic", "freshnessLabel",
    "group", "keepAwake", "lastErrorCode", "malformed", "maxSends", "observationLabel", "outboxState", "pauseReason",
    "progressCompleted", "progressPercent", "progressTotal", "reasonLabel", "recoveryMode", "resumable",
    "runIdDisplay", "safetyLabel", "safetyState", "snapshotLabel", "startedAt", "status", "statusKnown",
    "statusLabel", "tabId", "totalSteps", "updatedAt", "visibilityStatusLabel", "workflowName"
  ]);
});

test("prompt text is never projected", () => {
  const serialized = JSON.stringify(projectRun(rawRun(), { tabId: 42, now: NOW }));
  assert.equal(serialized.includes("絶対に表示してはいけない"), false);
  assert.equal(serialized.includes("prompt"), false);
});

test("document identity, instance id and execution session are never projected", () => {
  const serialized = JSON.stringify(projectRun(rawRun(), { tabId: 42, now: NOW }));
  for (const secret of ["instance-super-secret-value", "session-super-secret-value", "documentInstanceId", "executionSessionId"]) {
    assert.equal(serialized.includes(secret), false, `${secret} must not be projected`);
  }
});

test("outbox internals are dropped and only its state survives", () => {
  const projection = projectRun(rawRun(), { tabId: 42, now: NOW });
  assert.equal(projection.outboxState, "confirmed");
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes("deadbeef"), false, "promptHash must not be projected");
  assert.equal(serialized.includes("outbox-1"), false);
});

test("full conversation key is never projected, only a short fingerprint", () => {
  const projection = projectRun(rawRun(), { tabId: 42, now: NOW });
  assert.equal(projection.conversationFingerprint, "6a8f12");
  assert.equal(JSON.stringify(projection).includes("chatgpt:c:"), false);
  assert.ok(projection.conversationFingerprint.length <= 6);
  assert.equal(conversationFingerprint("chatgpt:new:1730000000"), "new");
  assert.equal(conversationFingerprint("not-a-key"), null);
  assert.equal(conversationFingerprint(null), null);
});

test("run id is shortened for display", () => {
  assert.equal(runIdDisplay("1a2b3c4d-5e6f-7890"), "1a2b3c4d");
  assert.equal(runIdDisplay(null), null);
});

test("current step label describes the step type, never the prompt", () => {
  const send = projectRun(rawRun(), { tabId: 1, now: NOW });
  assert.equal(send.currentStepLabel, "入力して送信");
  const checkpoint = projectRun(rawRun({ cursor: { stepIndex: 1, sendsCompleted: 3 } }), { tabId: 1, now: NOW });
  assert.equal(checkpoint.currentStepLabel, "内容を確認");
  const draft = projectRun(
    rawRun({ workflow: { ...rawRun().workflow, steps: [{ id: "d", type: "prompt", delivery: "draft", prompt: "秘密" }] } }),
    { tabId: 1, now: NOW }
  );
  assert.equal(draft.currentStepLabel, "入力だけして確認");
  assert.equal(JSON.stringify(draft).includes("秘密"), false);
  for (const type of ["wait-until", "schedule"]) {
    const scheduledRun = rawRun({
      workflow: { ...rawRun().workflow, steps: [{ id: "scheduled", type, at: "2026-09-20T09:00:00+09:00" }] }
    });
    const before = structuredClone(scheduledRun);
    const schedule = projectRun(scheduledRun, { tabId: 1, now: NOW });
    assert.equal(schedule.currentStepLabel, "指定時刻まで待つ");
    assert.equal(schedule.statusLabel, "実行中の保存記録");
    assert.deepEqual(scheduledRun, before, "a display label must not migrate the stored step type");
  }
});

test("progress and step numbers are derived from the snapshot", () => {
  const projection = projectRun(rawRun(), { tabId: 42, alias: "調査A", now: NOW });
  assert.equal(projection.progressCompleted, 12);
  assert.equal(projection.progressTotal, 40);
  assert.equal(projection.progressPercent, 30);
  assert.equal(projection.currentStepNumber, 1);
  assert.equal(projection.totalSteps, 2);
  assert.equal(projection.maxSends, 5);
  assert.equal(projection.recoveryMode, "completion");
  assert.equal(projection.malformed, false);
  assert.equal(projection.statusLabel, "実行中の保存記録");
  assert.equal(projection.observationLabel, "現在の接続状態は未確認");

  const completed = projectRun(rawRun({ status: "completed", cursor: { stepIndex: 1, sendsCompleted: 39 } }), {
    tabId: 42,
    now: NOW
  });
  assert.equal(completed.progressPercent, 100, "Completed is presented as 100% without changing its stored cursor");
  assert.equal(completed.progressCompleted, 39);
});

test("alias is used for the display name with a safe fallback", () => {
  assert.equal(runDisplayName(projectRun(rawRun(), { tabId: 1, alias: "調査A", now: NOW })), "調査A");
  assert.equal(runDisplayName(projectRun(rawRun(), { tabId: 1, alias: null, now: NOW })), "タブ #1");
  assert.equal(runDisplayName(projectRun(rawRun(), { tabId: 1, alias: "   ", now: NOW })), "タブ #1");
  assert.equal(runDisplayName(null), "ChatGPTの実行記録");
});

test("color and group are projected only from bounded presentation metadata", () => {
  const projection = projectRun(rawRun(), {
    tabId: 9,
    presentation: { alias: "Release", color: "purple", group: "テスト" },
    now: NOW
  });
  assert.equal(projection.alias, "Release");
  assert.equal(projection.color, "purple");
  assert.equal(projection.group, "テスト");
  assert.equal(projection.observationLabel, "現在の接続状態は未確認");
  assert.equal(projection.snapshotLabel, "保存記録 · 更新 8分前");

  const invalid = projectRun(rawRun(), {
    tabId: 9,
    presentation: {
      alias: "A".repeat(100),
      color: "red; background:url(javascript:1)",
      group: "G".repeat(100)
    },
    now: NOW
  });
  assert.equal(Array.from(invalid.alias).length, 40);
  assert.equal(Array.from(invalid.group).length, 40);
  assert.equal(invalid.color, "default");
});

test("safety states never claim a paused Run is fine", () => {
  const failClosed = projectRun(rawRun({ status: "paused", resumable: false, pauseReason: "document_identity_unconfirmed" }), { tabId: 1, now: NOW });
  assert.equal(failClosed.safetyState, "fail-closed");
  assert.ok(failClosed.safetyLabel.includes("安全停止"));
  assert.equal(failClosed.visibilityStatusLabel, "安全のため停止");

  const userPause = projectRun(rawRun({ status: "paused", resumable: true, pauseReason: "user-pause", outbox: null }), { tabId: 1, now: NOW });
  assert.equal(userPause.safetyState, "user-paused");
  assert.equal(userPause.visibilityStatusLabel, "一時停止中");

  const needs = projectRun(rawRun({ status: "paused", resumable: true, pauseReason: "manual-checkpoint", outbox: null }), { tabId: 1, now: NOW });
  assert.equal(needs.safetyState, "confirmation-required");
  assert.equal(needs.visibilityStatusLabel, "確認が必要");
  assert.match(needs.reasonLabel, /確認ポイント/);
});

test("unknown status is reported as unknown and never as healthy", () => {
  const projection = projectRun(rawRun({ status: "exploded" }), { tabId: 1, now: NOW });
  assert.equal(projection.status, null);
  assert.equal(projection.statusKnown, false);
  assert.equal(projection.statusLabel, "状態不明");
  assert.equal(projection.safetyState, "unknown");
  assert.equal(projection.malformed, true);
  for (const healthy of ["実行中", "完了", "正常"]) {
    assert.equal(projection.statusLabel, healthy === "状態不明" ? healthy : projection.statusLabel);
    assert.notEqual(projection.statusLabel, healthy);
  }
});

test("malformed and partial Runs never crash the projection", () => {
  for (const bad of [null, undefined, 0, "run", [], true]) {
    assert.equal(projectRun(bad, { tabId: 1, now: NOW }), null);
  }
  const partial = projectRun({ runId: "abc" }, { tabId: 1, now: NOW });
  assert.equal(partial.malformed, true);
  assert.equal(partial.statusKnown, false);
  assert.equal(partial.progressCompleted, null);
  assert.equal(partial.progressPercent, null);
  assert.equal(partial.totalSteps, null);

  const broken = projectRun(rawRun({ cursor: "nope", workflow: [], plannedSends: "many", updatedAt: "not-a-date" }), { tabId: 1, now: NOW });
  assert.equal(broken.malformed, true);
  assert.equal(broken.updatedAt, null);
  assert.equal(broken.freshnessLabel, null);
});

test("run list projects only active Run keys and ignores everything else", () => {
  const snapshot = {
    [runKey(1)]: rawRun({ updatedAt: "2026-08-28T11:00:00.000Z" }),
    [runKey(2)]: rawRun({ status: "paused", updatedAt: "2026-08-28T11:59:00.000Z" }),
    "aipm.diagnostics.v1": [{ at: "x", type: "run_started" }],
    "aipm.flowLibrary.v1": [{ id: "f" }],
    "aipm.leases.v1": { lease: true },
    "aipm.settings.v1": { version: 1 },
    "aipm.activeRun.v1": rawRun()
  };
  const rows = projectRunList(snapshot, { aliases: { 1: "調査A" }, now: NOW });
  assert.equal(rows.length, 2);
  /* Most recently updated first. */
  assert.equal(rows[0].tabId, 2);
  assert.equal(rows[1].alias, "調査A");
});

test("same conversation and same alias remain two exact-tab rows with distinct presentation", () => {
  const sameConversation = "chatgpt:c:same-conversation";
  const rows = projectRunList({
    [runKey(17)]: rawRun({ conversationKey: sameConversation, status: "running" }),
    [runKey(29)]: rawRun({ conversationKey: sameConversation, status: "paused" })
  }, {
    presentations: {
      "17": { alias: "Claude", color: "blue", group: "調査1" },
      "29": { alias: "Claude", color: "green", group: "調査2" }
    },
    now: NOW
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map((row) => row.tabId)), new Set([17, 29]));
  assert.deepEqual(new Set(rows.map((row) => row.group)), new Set(["調査1", "調査2"]));
  assert.deepEqual(new Set(rows.map((row) => row.color)), new Set(["blue", "green"]));
  assert.equal(new Set(rows.map((row) => row.conversationFingerprint)).size, 1);
});

test("empty storage yields an empty list", () => {
  assert.deepEqual(projectRunList({}, { now: NOW }), []);
  assert.deepEqual(projectRunList(null, { now: NOW }), []);
});

test("unusable Run values are dropped from the list rather than shown as normal", () => {
  const rows = projectRunList({ [runKey(1)]: null, [runKey(2)]: "broken", [runKey(3)]: rawRun() }, { now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tabId, 3);
});

test("status filter narrows the list without mutating it", () => {
  const rows = projectRunList({
    [runKey(1)]: rawRun({ status: "running" }),
    [runKey(2)]: rawRun({ status: "paused" }),
    [runKey(3)]: rawRun({ status: "completed" })
  }, { now: NOW });
  assert.equal(filterRuns(rows, "all").length, 3);
  assert.equal(filterRuns(rows, "paused").length, 1);
  assert.equal(filterRuns(rows, "unknown-filter").length, 3);
  assert.equal(rows.length, 3);
});

test("freshness is informational and never asserts a lifecycle conclusion", () => {
  assert.equal(freshnessLabel("2026-08-28T11:52:00.000Z", NOW), "更新 8分前");
  assert.equal(freshnessLabel("2026-08-28T09:00:00.000Z", NOW), "更新 3時間前");
  assert.equal(freshnessLabel("2026-08-25T12:00:00.000Z", NOW), "更新 3日前");
  assert.equal(freshnessLabel("2026-08-28T11:59:40.000Z", NOW), "更新 1分以内");
  assert.equal(freshnessLabel(null, NOW), null);
  for (const word of ["停止", "失敗", "正常", "健全"]) {
    assert.equal(freshnessLabel("2026-08-25T12:00:00.000Z", NOW).includes(word), false);
  }
});

test("freshness projection does not mutate or add authority to the stored Run", () => {
  const stored = rawRun();
  const before = structuredClone(stored);
  const early = projectRun(stored, { tabId: 42, now: NOW });
  const late = projectRun(stored, { tabId: 42, now: NOW + 86_400_000 });
  assert.notEqual(early.freshnessLabel, late.freshnessLabel);
  assert.deepEqual(stored, before);
  for (const projection of [early, late]) {
    assert.equal("lease" in projection, false);
    assert.equal("documentInstanceId" in projection, false);
    assert.equal("executionSessionId" in projection, false);
  }
});

test("diagnostics are bounded, matched by short run id, and carry no free text", () => {
  const list = [
    { at: "2026-08-28T11:50:00.000Z", type: "run_started", runId: "1a2b3c4d-5e6f", phase: "ready" },
    { at: "2026-08-28T11:51:00.000Z", type: "send_confirmed", runId: "1a2b3c4d-5e6f", durationMs: 112 },
    { at: "2026-08-28T11:51:30.000Z", type: "send_confirmed", runId: "9999zzzz-0000" },
    { at: "x", type: "bad type with spaces", runId: "1a2b3c4d-5e6f" },
    null,
    "junk"
  ];
  const entries = projectDiagnostics(list, "1a2b3c4d");
  assert.equal(entries.length, 2);
  assert.equal(entries[0].code, "send_confirmed");
  assert.equal(entries[0].details.durationMs, 112);
  assert.equal(entries[0].category, "DELIVERY");
  assert.equal(JSON.stringify(entries[0]).includes("phase"), true);
  assert.deepEqual(projectDiagnostics(null, "1a2b3c4d"), []);
  assert.deepEqual(projectDiagnostics(list, null), []);
});

test("full initialize-then-change flow works from storage values alone", () => {
  /* Mirrors the Workspace lifecycle: snapshot -> select -> storage change. */
  let snapshot = { [runKey(7)]: rawRun({ cursor: { stepIndex: 0, sendsCompleted: 1 }, updatedAt: "2026-08-28T11:00:00.000Z" }) };
  let rows = projectRunList(snapshot, { aliases: { 7: "調査A" }, now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].progressCompleted, 1);

  /* Run updated. */
  snapshot = { [runKey(7)]: rawRun({ cursor: { stepIndex: 1, sendsCompleted: 9 }, updatedAt: "2026-08-28T11:58:00.000Z" }) };
  rows = projectRunList(snapshot, { aliases: { 7: "調査A" }, now: NOW });
  assert.equal(rows[0].progressCompleted, 9);
  assert.equal(rows[0].freshnessLabel, "更新 2分前");

  /* Run removed. */
  rows = projectRunList({}, { now: NOW });
  assert.equal(rows.length, 0);
});
