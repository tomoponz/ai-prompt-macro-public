import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  RECOVERY_SAFETY_DESCRIPTION,
  normalizeRecoveryPolicy,
  recoveryModeDescription,
  recoveryModeLabel,
  recoveryRuntimeBounds
} from "../src/recovery-policy.js";
import { installSidePanelHarness, tick } from "./helpers/sidepanel-harness.mjs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function run(overrides = {}) {
  return {
    status: "running",
    phase: "ready",
    plannedSends: 40,
    cursor: { stepIndex: 0, sendsCompleted: 12 },
    workflow: { steps: [{ id: "s1", type: "prompt", repeat: 40 }] },
    resumable: true,
    outbox: null,
    ...overrides
  };
}

test("Side Panel renders state, progress, reason, next action, and connection as separate text", async () => {
  const harness = await installSidePanelHarness({ tabIds: [1] });
  let activeRun = run();
  harness.setRelayResponder(() => ({
    ok: true,
    provider: "chatgpt",
    contentVersion: "0.4.0",
    pageReady: true,
    generationState: "idle",
    blocker: null,
    conversationKey: "chatgpt:c:fixture",
    instanceId: "fixture-instance",
    run: structuredClone(activeRun),
    diagnostics: []
  }));
  try {
    await harness.click("refreshTabs");
    await tick();
    assert.equal(harness.el("statusBadge").textContent, "実行中");
    assert.match(harness.el("progress").textContent, /送信 12\/40/);
    assert.match(harness.el("message").textContent, /回答本文を読まず/);
    assert.match(harness.el("nextAction").textContent, /一時停止.*停止/);
    assert.equal(harness.el("connectionStatus").dataset.connection, "available");
    assert.match(harness.el("connectionStatus").textContent, /対象タブから応答/);

    activeRun = run({ status: "paused", pauseReason: "user-pause" });
    await harness.click("refreshTabs");
    assert.equal(harness.el("statusBadge").textContent, "一時停止中");
    assert.match(harness.el("message").textContent, /ユーザー操作/);
    assert.notEqual(harness.el("completionOutcome").dataset.outcome, "fail-closed");

    activeRun = run({ status: "paused", pauseReason: "manual-checkpoint" });
    await harness.click("refreshTabs");
    assert.equal(harness.el("statusBadge").textContent, "確認が必要");
    assert.match(harness.el("message").textContent, /確認ポイント/);

    activeRun = run({
      status: "paused",
      pauseReason: "submission_ambiguous",
      lastErrorMessage: "raw technical text must stay hidden",
      resumable: false
    });
    await harness.click("refreshTabs");
    assert.equal(harness.el("statusBadge").textContent, "安全のため停止");
    assert.equal(harness.el("completionOutcome").dataset.outcome, "fail-closed");
    assert.match(harness.el("message").textContent, /自動再送せず停止/);
    assert.doesNotMatch(harness.el("message").textContent, /raw technical text/);
  } finally {
    harness.restoreGlobals();
  }
});

test("Recovery display names match the existing bounded runtime differences", () => {
  const safe = normalizeRecoveryPolicy({ mode: "safe" });
  const completion = normalizeRecoveryPolicy({ mode: "completion" });
  assert.equal(recoveryModeLabel(safe), "標準");
  assert.equal(recoveryModeLabel(completion), "完了を優先");
  assert.match(recoveryModeDescription(safe), /ページを操作せずに状態を再確認します。確認には上限があります/);
  assert.match(recoveryModeDescription(completion), /安全条件は変えず/);
  assert.match(RECOVERY_SAFETY_DESCRIPTION, /送信結果が不明な指示は自動再送しません/);

  const safeBounds = recoveryRuntimeBounds(safe);
  const completionBounds = recoveryRuntimeBounds(completion);
  assert.ok(completionBounds.readinessTimeoutMs > safeBounds.readinessTimeoutMs);
  assert.ok(completionBounds.statusRetryAttempts > safeBounds.statusRetryAttempts);
  for (const key of [
    "identityRecoveryWindowMs",
    "identityRecoveryProbeLimit",
    "identityRecoveryBackoffBaseMs",
    "identityRecoveryBackoffMaxMs"
  ]) assert.equal(completionBounds[key], safeBounds[key], key);
});

test("Recovery display projection never mutates an active Run snapshot", () => {
  const activeRun = run({ workflow: { recovery: { mode: "safe" }, steps: [] } });
  const before = structuredClone(activeRun);
  recoveryModeLabel({ mode: "completion" });
  recoveryModeDescription({ mode: "completion" });
  recoveryRuntimeBounds({ mode: "completion" });
  assert.deepEqual(activeRun, before);
});

test("freshness stays render-only and Workspace stays storage-only", () => {
  const workspace = `${read("src/workspace.js")}\n${read("src/workspace-projection.js")}`;
  for (const forbidden of [
    "runtime.sendMessage",
    "tabs.sendMessage",
    "scripting.executeScript",
    "setInterval(",
    "setTimeout("
  ]) assert.equal(workspace.includes(forbidden), false, forbidden);
  for (const mutation of ["AIPM_START", "AIPM_PAUSE", "AIPM_RESUME", "AIPM_STOP"]) {
    assert.equal(workspace.includes(mutation), false, mutation);
  }
  assert.match(workspace, /freshnessLabel\(rawRun\.updatedAt, now\)/);
  assert.doesNotMatch(read("src/workspace-projection.js"), /canStartRun|canResumePausedRun|AIPM_START/);
});

test("status and recovery markup remains accessible and hides advanced controls by default", () => {
  const panel = read("src/sidepanel.html");
  const options = read("src/options.html");
  for (const id of ["statusBadge", "connectionStatus", "message", "nextAction", "advancedRecovery"]) {
    assert.match(panel, new RegExp(`id="${id}"`));
  }
  assert.match(panel, /id="advancedRecovery" class="recovery-advanced hidden"/);
  assert.match(panel, /id="connectionStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(panel, /id="message" aria-live="polite"/);
  assert.match(panel, /id="nextAction"[^>]*aria-live="polite"/);
  assert.match(options, /実行中の自動化は変更しません/);
  assert.match(options, /<option value="safe">標準<\/option>/);
  assert.match(options, /<option value="completion">完了を優先<\/option>/);
});

test("Output-Blind and user-text DOM boundaries remain explicit", () => {
  const projection = read("src/workspace-projection.js");
  const workspace = read("src/workspace.js");
  const panel = read("src/sidepanel.js");
  assert.doesNotMatch(`${projection}\n${workspace}\n${panel}`, /assistantResponse|assistantOutput|responseBody/);
  assert.doesNotMatch(workspace, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.match(workspace, /name\.textContent = runDisplayName\(row\)/);
  assert.match(workspace, /group\.textContent = row\.group/);
});
