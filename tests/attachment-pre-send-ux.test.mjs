import { CURRENT_EXTENSION_VERSION } from "./helpers/extension-version.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { canResumePausedRun, displayDeliveredSendCount, projectRunUx } from "../src/run-ux.js";
import { projectDiagnostic, projectDiagnosticEvent, projectRunDiagnostic } from "../src/diagnostics-ux.js";
import { installSidePanelHarness } from "./helpers/sidepanel-harness.mjs";

const TIMEOUT = "paste_attachment_settlement_timeout";
const ready = { hasTarget: true, targetReady: true, pageReady: true, blocker: null };
const primaryText = (diagnostic) => [diagnostic.title, diagnostic.summary,
  diagnostic.safetyMeaning, diagnostic.nextAction].join(" ");
const pausedRun = (overrides = {}) => ({
  runId: "current-pre-send-run", status: "paused", phase: "ambiguous", stateRevision: 4,
  pauseReason: TIMEOUT, lastErrorCode: TIMEOUT, resumable: false,
  cursor: { stepIndex: 0, repeatIndex: 2, sendsCompleted: 2 }, plannedSends: 3,
  outbox: { state: "prepared", deliveryMode: "pending" },
  workflow: { recovery: { mode: "safe" }, maxSends: 3,
    steps: [{ id: "first", type: "prompt", repeat: 3 }] },
  ...overrides
});

test("settlement timeout with a prepared outbox explains this instruction stopped before Send", () => {
  const run = pausedRun();
  const before = structuredClone(run);
  const ux = projectRunUx({ ...ready, run });
  const diagnostic = projectRunDiagnostic(run);
  assert.equal(ux.kind, "fail-closed");
  assert.match(ux.reason, /時間内/);
  assert.match(ux.reason, /今回の指示.*送信前に停止/);
  assert.doesNotMatch(ux.reason, /送信状態を一意|送信結果を一意/);
  assert.match(ux.nextAction, /停止/);
  assert.match(ux.nextAction, /残りの手順と回数/);
  assert.match(diagnostic.summary, /時間内.*送信前に停止/);
  assert.doesNotMatch(primaryText(diagnostic), /内容を書き換えず|送信回数.*0|送信は0/);
  assert.equal(diagnostic.category, "ATTACHMENT");
  assert.equal(canResumePausedRun(run), false);
  assert.equal(displayDeliveredSendCount(run), 2, "pre-send copy must not erase earlier deliveries");
  assert.deepEqual(run, before, "presentation cannot change recovery or progress");
});

for (const state of ["submitted", "confirmed", "unknown", null]) {
  test(`timeout reason alone cannot label ${state ?? "missing"} delivery evidence as unsent`, () => {
    const run = pausedRun({ outbox: state ? { state } : null });
    const ux = projectRunUx({ ...ready, run });
    const diagnostic = projectRunDiagnostic(run);
    assert.doesNotMatch(ux.reason, /送信前に停止|送信ボタンを押す前|未送信です/);
    assert.doesNotMatch(primaryText(diagnostic), /送信前に停止|送信ボタンを押す前|未送信です|内容を書き換えず/);
    if (state === "confirmed") {
      assert.match(ux.reason, /送信は確認済み/);
      assert.match(diagnostic.summary, /送信は確認済み/);
    } else if (state === "submitted") {
      assert.match(diagnostic.summary, /未送信とは判断できません/);
    } else {
      assert.match(diagnostic.summary, /時間内.*確認できなかった記録/);
    }
  });
}

test("settlement timeout, unverified ready attachment, and post-click uncertainty stay distinct", () => {
  const timeout = projectRunUx({ ...ready, run: pausedRun() });
  const unverified = projectRunUx({ ...ready, run: pausedRun({
    phase: "attachment-blocked", pauseReason: "paste_attachment_unverified",
    lastErrorCode: "paste_attachment_unverified"
  }) });
  const ambiguous = projectRunUx({ ...ready, run: pausedRun({
    pauseReason: "submission_ambiguous", lastErrorCode: "submission_ambiguous",
    outbox: { state: "submitted" }
  }) });
  assert.match(timeout.reason, /時間内/);
  assert.match(unverified.reason, /内容.*照合できない/);
  assert.doesNotMatch(unverified.reason, /時間内/);
  assert.match(ambiguous.reason, /送信結果.*確認できない/);
  assert.doesNotMatch(ambiguous.reason, /送信前に停止/);
  assert.doesNotMatch(projectRunUx({ ...ready, run: pausedRun({
    pauseReason: "submission_ambiguous", lastErrorCode: "submission_ambiguous"
  }) }).reason, /送信前に停止/, "prepared alone must not relabel unrelated failure codes");
});

test("historical settlement timeout explains the observation without proving current delivery or exposing text", () => {
  for (const diagnostic of [
    projectDiagnostic({ code: TIMEOUT }),
    projectDiagnosticEvent({ type: "paste_attachment_settlement", reason: TIMEOUT,
      lastState: "attachment-pending", elapsedMs: 29120, runId: "older-run",
      prompt: "PRIVATE PROMPT", assistantText: "PRIVATE RESPONSE" })
  ]) {
    assert.match(diagnostic.summary, /時間内.*確認できなかった記録/);
    assert.doesNotMatch(primaryText(diagnostic), /送信前に停止|未送信です|内容を書き換えず/);
    assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE PROMPT|PRIVATE RESPONSE|older-run/);
  }
});

test("Side Panel renders pending, pre-send blocked, and post-click states without mixing an older success", async () => {
  const h = await installSidePanelHarness({ tabIds: [1] });
  let run = pausedRun({ status: "running", phase: "prepared", pauseReason: null,
    lastErrorCode: null, resumable: true });
  h.setRelayResponder(() => ({ ok: true, provider: "chatgpt", contentVersion: CURRENT_EXTENSION_VERSION,
    pageReady: true, generationState: "idle", blocker: null,
    conversationKey: "chatgpt:c:fixture", instanceId: "fixture-instance",
    run: structuredClone(run), diagnostics: [
      { type: "send_confirmed", runId: "different-older-run", at: "2026-10-23T08:00:00.000Z" }
    ] }));
  try {
    await h.click("refreshTabs");
    assert.equal(h.el("statusBadge").textContent, "実行中");
    assert.match(h.el("message").textContent, /入力内容と送信ボタンの状態を確認/);
    assert.doesNotMatch(h.el("message").textContent, /停止しました/);

    run = pausedRun();
    await h.click("refreshTabs");
    assert.match(h.el("message").textContent, /今回の指示.*送信前に停止/);
    assert.match(h.el("diagnosticsSummary").textContent, /時間内.*送信前に停止/);
    assert.match(h.el("progress").textContent, /送信 2\/3/);
    assert.equal(h.el("resume").disabled, true);
    assert.equal(h.el("stop").disabled, false);
    assert.match(h.el("nextAction").textContent, /残りの手順と回数/);

    run = pausedRun({ phase: "attachment-blocked", pauseReason: "paste_attachment_unverified",
      lastErrorCode: "paste_attachment_unverified" });
    await h.click("refreshTabs");
    assert.match(h.el("message").textContent, /内容.*照合できない/);
    assert.doesNotMatch(h.el("message").textContent, /時間内/);

    run = pausedRun({ pauseReason: "submission_ambiguous", lastErrorCode: "submission_ambiguous",
      outbox: { state: "submitted" } });
    await h.click("refreshTabs");
    assert.match(h.el("message").textContent, /送信結果.*確認できない/);
    assert.doesNotMatch(h.el("message").textContent, /送信前に停止/);
    assert.equal(h.messages.some((message) =>
      ["AIPM_START", "AIPM_RESUME"].includes(message.payload?.type)), false);
  } finally { h.restoreGlobals(); }
});
