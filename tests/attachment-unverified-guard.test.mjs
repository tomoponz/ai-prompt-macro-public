import test from "node:test";
import assert from "node:assert/strict";
import { createWorkflowHarness } from "./helpers/workflow-harness.mjs";
import { canResumePausedRun, projectRunState, nextActionForRun } from "../src/run-ux.js";
import { projectRunDiagnostic } from "../src/diagnostics-ux.js";

const workflow = {
  schemaVersion: 1, id: "unverified", name: "Unverified attachment", maxSends: 3,
  steps: [{ id: "long", type: "prompt", delivery: "send", prompt: "SYNTHETIC PRIVATE INPUT\n".repeat(3000), repeat: 3, delayAfterMs: 0 }]
};

test("scoped conversion completes Repeat3, cannot replay through Resume, and preserves later user attachments", async () => {
  const h = createWorkflowHarness({ convertPasteToAttachment: true });
  await h.ready();
  assert.equal((await h.start(workflow)).ok, true);
  await h.settle();
  assert.equal(h.stored().status, "completed");
  assert.equal(h.stored().cursor.sendsCompleted, 3);
  assert.equal(h.stored().outbox, null);
  assert.equal(h.page.clicks, 3);
  assert.deepEqual(h.clicks().map(entry => entry.position), ["0:0", "0:1", "0:2"]);
  assert.equal(h.transcript.filter(entry => entry.type === "write").length, 3);
  assert.equal(canResumePausedRun(h.stored()), false);
  assert.doesNotMatch(JSON.stringify(h.diagnostics()), /SYNTHETIC PRIVATE INPUT/);
  assert.equal((await h.control("AIPM_RESUME")).ok, false);
  await h.reload();
  assert.equal(h.page.clicks, 3);
  assert.equal((await h.control("AIPM_STOP")).ok, true);
  // Permission for a prior paste conversion does not authorize a later user file.
  h.page.attachmentCount = 1;
  await h.start(workflow);
  await h.settle();
  assert.equal(h.stored().lastErrorCode, "unexpected_attachment");
  assert.equal(h.page.attachmentCount, 1);
  assert.equal(h.page.clicks, 3);
  assert.equal(h.transcript.filter(entry => entry.type === "write").length, 3);
});

test("a converted candidate at the final pre-click check is also blocked", async () => {
  let reachedFinalBoundary = false;
  const h = createWorkflowHarness({ onSave({ run, page }) {
    if (run.phase !== "submitting") return;
    reachedFinalBoundary = true;
    page.text = "";
    page.attachmentCount = 1;
  } });
  await h.ready();
  await h.start(workflow);
  await h.settle();
  assert.equal(reachedFinalBoundary, true);
  assert.equal(h.page.clicks, 0);
  assert.equal(h.page.attachmentCount, 1);
  assert.equal(h.stored().resumable, false);
  assert.equal(h.stored().cursor.sendsCompleted, 0);
  assert.equal(h.stored().outbox.state, "prepared");
  // The locked TEXT mode must not be relaxed into a newly observed tile.
  assert.equal(h.stored().lastErrorCode, "paste_attachment_provenance_lost");
});

test("durably confirmed delivery is never relabelled as unsent by attachment copy", () => {
  const run = { status: "paused", phase: "attachment-blocked", resumable: false,
    pauseReason: "paste_attachment_unverified", outbox: { state: "confirmed" } };
  assert.match(projectRunState(run).reason, /送信は確認済み/);
  assert.doesNotMatch(projectRunState(run).reason, /送信前に停止/);
  assert.match(projectRunDiagnostic(run).summary, /送信は確認済み/);
  assert.doesNotMatch(projectRunDiagnostic(run).summary, /送信前に停止/);
  run.outbox.state = "submitted";
  assert.match(projectRunDiagnostic(run).summary, /未送信とは判断できません/);
  assert.doesNotMatch(projectRunDiagnostic(run).summary, /送信前に停止/);
});
