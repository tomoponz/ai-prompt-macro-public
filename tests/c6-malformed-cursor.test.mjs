import test from "node:test";
import assert from "node:assert/strict";

import { CONTENT_VERSION, CONVERSATION_KEY, SESSION_ID, TAB_ID, createWorkflowHarness } from "./helpers/workflow-harness.mjs";

function durableRun(instanceId) {
  return {
    schemaVersion: 1,
    runId: "c6-malformed-cursor",
    provider: "chatgpt",
    contentVersion: CONTENT_VERSION,
    executionSessionId: SESSION_ID,
    conversationKey: CONVERSATION_KEY,
    documentInstanceId: instanceId,
    boundDocumentId: null,
    boundTabId: TAB_ID,
    workflow: {
      schemaVersion: 1,
      id: "cursor",
      name: "Cursor",
      maxSends: 1,
      steps: [{ id: "p1", type: "prompt", delivery: "send", prompt: "P", repeat: 1, delayAfterMs: 0 }]
    },
    plannedSends: 1,
    cursor: { stepIndex: Number.NaN, repeatIndex: 0, sendsCompleted: 0 },
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

test("R5: malformed durable cursor fails closed instead of becoming completed", async () => {
  const harness = createWorkflowHarness();
  await harness.ready();
  harness.injectDurableRun(durableRun(harness.context.instanceId));
  await harness.reload(1_000);

  const stored = harness.stored();
  assert.equal(harness.page.clicks, 0);
  assert.equal(stored.status, "paused");
  assert.notEqual(stored.phase, "completed");
  assert.equal(stored.resumable, false);
  assert.equal(stored.lastErrorCode, "send_budget_invalid");
});
