import test from "node:test";
import assert from "node:assert/strict";

import { CONTENT_VERSION, CONVERSATION_KEY, SESSION_ID, TAB_ID, createWorkflowHarness } from "./helpers/workflow-harness.mjs";

function mismatchedConfirmedRun(instanceId) {
  return {
    schemaVersion: 1,
    runId: "c6-outbox-mismatch",
    provider: "chatgpt",
    contentVersion: CONTENT_VERSION,
    executionSessionId: SESSION_ID,
    conversationKey: CONVERSATION_KEY,
    documentInstanceId: instanceId,
    boundDocumentId: null,
    boundTabId: TAB_ID,
    workflow: {
      schemaVersion: 1,
      id: "outbox",
      name: "Outbox",
      maxSends: 2,
      steps: [{ id: "current-step", type: "prompt", delivery: "send", prompt: "CURRENT", repeat: 2, delayAfterMs: 0 }]
    },
    plannedSends: 2,
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 },
    status: "running",
    phase: "generating",
    pauseRequested: false,
    pauseRequestedAt: null,
    pauseRequestBaseRevision: null,
    pauseRequestRevision: null,
    pauseReason: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    resumable: true,
    outbox: {
      id: "forged-confirmed",
      stepId: "different-step",
      promptHash: "0".repeat(64),
      state: "confirmed",
      preparedAt: "2026-08-22T00:00:00.000Z",
      confirmedAt: "2026-08-22T00:00:01.000Z"
    },
    waitState: null,
    stateRevision: 3,
    startedAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:01.000Z"
  };
}

test("R7: mismatched confirmed outbox cannot advance the current durable cursor", async () => {
  const harness = createWorkflowHarness();
  await harness.ready();
  harness.injectDurableRun(mismatchedConfirmedRun(harness.context.instanceId));
  await harness.reload(1_000);

  const stored = harness.stored();
  assert.equal(harness.page.clicks, 0);
  assert.deepEqual(stored.cursor, { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 });
  assert.equal(stored.status, "paused");
  assert.equal(stored.resumable, false);
  assert.equal(stored.lastErrorCode, "recovery_ambiguous");
});
