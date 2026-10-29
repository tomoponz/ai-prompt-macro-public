import test from "node:test";
import assert from "node:assert/strict";
import { canResumePausedRun, displayDeliveredSendCount, nextActionForRun, projectRunState } from "../src/run-ux.js";

const available = { hasTarget: true, targetReady: true, pageReady: true };

function paused(phase, state, extra = {}) {
  return { status: "paused", phase, resumable: true, pauseReason: "send_unavailable",
    lastErrorCode: "send_unavailable", cursor: { sendsCompleted: 1 }, outbox: { state }, ...extra };
}

test("explicit pre-click recovery shows remaining input recheck, without claiming a send happened", () => {
  const run = paused("prepared", "prepared");
  const before = structuredClone(run);
  assert.equal(canResumePausedRun(run), true);
  assert.equal(projectRunState(run).kind, "confirmation-required");
  assert.match(projectRunState(run).reason, /送信前/);
  assert.doesNotMatch(projectRunState(run).reason, /送信開始後|送信は確認済み/);
  assert.match(nextActionForRun({ ...available, run }), /再開/);
  assert.match(nextActionForRun({ ...available, run }), /入力/);
  assert.equal(displayDeliveredSendCount(run), 1);
  assert.deepEqual(run, before, "presentation must not clear preparation or consume progress");
});

test("confirmed-wait recovery offers observation without resending the confirmed position", () => {
  const run = paused("confirmed-wait", "confirmed", {
    pauseReason: "generation_timeout", lastErrorCode: "generation_timeout"
  });
  const before = structuredClone(run);
  assert.equal(canResumePausedRun(run), true);
  assert.equal(projectRunState(run).kind, "confirmation-required");
  assert.match(projectRunState(run).reason, /送信は確認済み/);
  assert.match(projectRunState(run).reason, /再送せず/);
  assert.match(nextActionForRun({ ...available, run }), /再開/);
  assert.match(nextActionForRun({ ...available, run }), /再送せず/);
  assert.equal(displayDeliveredSendCount(run), 2);
  assert.deepEqual(run, before, "presentation must not advance the confirmed cursor");
});

for (const [phase, state] of [
  ["submitting", "prepared"], ["waiting-ack", "submitted"],
  ["prepared", "submitted"], ["confirmed-wait", "prepared"],
  ["ambiguous", "confirmed"], ["paused", "prepared"]
]) {
  test(`unmatched outbox phase ${phase}/${state} cannot enable Resume`, () => {
    const run = paused(phase, state);
    assert.equal(canResumePausedRun(run), false);
    assert.equal(projectRunState(run).kind, "fail-closed");
  });
}

for (const resumable of [false, undefined, null]) {
  test(`outbox recovery requires explicit runtime capability: ${String(resumable)}`, () => {
    for (const [phase, state] of [["prepared", "prepared"], ["confirmed-wait", "confirmed"]]) {
      assert.equal(canResumePausedRun(paused(phase, state, { resumable })), false);
    }
  });
}

test("blocked attachments, exhausted budgets and terminal runs do not become recoverable", () => {
  for (const code of ["paste_attachment_provenance_lost", "paste_attachment_settlement_timeout", "unexpected_attachment"]) {
    assert.equal(canResumePausedRun(paused("prepared", "prepared", { resumable: false, lastErrorCode: code })), false);
    assert.equal(canResumePausedRun(paused("prepared", "prepared", { resumable: true, lastErrorCode: code })), false);
  }
  assert.equal(canResumePausedRun(paused("prepared", "prepared", { lastErrorCode: "max_sends" })), false);
  assert.equal(canResumePausedRun(paused("confirmed-wait", "confirmed", { status: "stopped" })), false);
});
