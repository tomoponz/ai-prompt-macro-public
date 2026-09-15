import test from "node:test";
import assert from "node:assert/strict";

import { CONTENT_VERSION, CONVERSATION_KEY, SESSION_ID, TAB_ID, createWorkflowHarness } from "./helpers/workflow-harness.mjs";

function invalidScheduleRun(instanceId) {
  return {
    schemaVersion: 1,
    runId: "c6-invalid-schedule",
    provider: "chatgpt",
    contentVersion: CONTENT_VERSION,
    executionSessionId: SESSION_ID,
    conversationKey: CONVERSATION_KEY,
    documentInstanceId: instanceId,
    boundDocumentId: null,
    boundTabId: TAB_ID,
    workflow: {
      schemaVersion: 1,
      id: "invalid-schedule",
      name: "Invalid schedule",
      maxSends: 1,
      steps: [
        { id: "wait", type: "wait-until", at: "not-a-date", latePolicy: "pause", graceMs: 1_000 },
        { id: "p1", type: "prompt", delivery: "send", prompt: "P", repeat: 1, delayAfterMs: 0 }
      ]
    },
    plannedSends: 1,
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 },
    status: "running",
    phase: "ready",
    pauseRequested: false,
    pauseRequestedAt: null,
    pauseRequestBaseRevision: null,
    pauseRequestRevision: null,
    pauseReason: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    resumable: true,
    outbox: null,
    waitState: null,
    stateRevision: 3,
    startedAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z"
  };
}

test("R6: structurally invalid recovered Run is not generically resumable", async () => {
  const harness = createWorkflowHarness();
  await harness.ready();
  harness.injectDurableRun(invalidScheduleRun(harness.context.instanceId));
  await harness.reload(1_000);

  const stored = harness.stored();
  assert.equal(harness.page.clicks, 0);
  assert.equal(stored.status, "paused");
  assert.equal(stored.lastErrorCode, "schedule_invalid");
  assert.equal(stored.resumable, false);

  const resume = await harness.control("AIPM_RESUME");
  await harness.settle();
  assert.equal(resume.ok, false);
  assert.equal(harness.page.clicks, 0);
});
