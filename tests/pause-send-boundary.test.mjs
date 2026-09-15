import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTENT_VERSION,
  CONVERSATION_KEY,
  SESSION_ID,
  createWorkflowHarness,
  promptsSent
} from "./helpers/workflow-harness.mjs";

function quickRepeatWorkflow(repeat = 5, { leadingDelay = false } = {}) {
  const prompt = {
    id: "edge-repeat",
    type: "prompt",
    delivery: "send",
    prompt: "回答は EDGE-TEST だけにしてください。",
    repeat,
    delayAfterMs: 0
  };
  return {
    schemaVersion: 1,
    id: "pause-send-boundary",
    name: "Pause Send Boundary",
    maxSends: repeat,
    steps: leadingDelay
      ? [{ id: "before-send", type: "delay", durationMs: 5_000 }, prompt]
      : [prompt]
  };
}

function controlMessage(harness, type) {
  const run = harness.stored();
  return {
    type,
    serviceWorkerVersion: CONTENT_VERSION,
    executionSessionId: SESSION_ID,
    expectedDocumentInstanceId: harness.context.instanceId,
    expectedConversationKey: CONVERSATION_KEY,
    expectedRunId: run?.runId ?? null,
    expectedStateRevision: run?.stateRevision ?? null
  };
}

function assertPausedAt(harness, sendsCompleted) {
  const run = harness.stored();
  assert.equal(run.status, "paused");
  assert.equal(run.pauseReason, "user-pause");
  assert.equal(run.resumable, true);
  assert.equal(run.pauseRequested, false);
  assert.equal(run.outbox, null);
  assert.equal(run.cursor.sendsCompleted, sendsCompleted);
}

test("Pause before Send prevents every additional Send until explicit Resume", async () => {
  let armed = true;
  let harness;
  harness = createWorkflowHarness({
    async onSave({ run }) {
      if (!armed || run.phase !== "delay" || run.cursor.sendsCompleted !== 0) return;
      armed = false;
      const response = await harness.control("AIPM_PAUSE");
      assert.equal(response.ok, true);
    }
  });

  await harness.start(quickRepeatWorkflow(5, { leadingDelay: true }));
  await harness.settle();

  assert.equal(armed, false);
  assert.equal(harness.page.clicks, 0, "Pause before Send must add no click");
  assertPausedAt(harness, 0);

  const resume = await harness.control("AIPM_RESUME");
  await harness.settle();
  assert.equal(resume.ok, true);
  assert.equal(harness.stored().status, "completed");
  assert.equal(harness.page.clicks, 5);
});
test("Pause during pre-Send preparation settles before the irreversible click", async () => {
  let armed = true;
  let harness;
  harness = createWorkflowHarness({
    async onSave({ run }) {
      if (!armed || run.phase !== "prepared" || run.outbox?.state !== "prepared") return;
      armed = false;
      const response = await harness.control("AIPM_PAUSE");
      assert.equal(response.ok, true);
    }
  });

  await harness.start(quickRepeatWorkflow());
  await harness.settle();

  assert.equal(armed, false);
  assert.equal(harness.page.clicks, 0);
  assertPausedAt(harness, 0);
});

test("Repeat=5 Pause during Send #2 ACK confirms #2 exactly once, then Resume completes #3-#5", async () => {
  let armed = true;
  let pauseResponse = null;
  let harness;
  harness = createWorkflowHarness({
    async onRunSet({ message, storedRun, page }) {
      if (!armed || message.run?.phase !== "waiting-ack" || page.clicks !== 2) return null;
      armed = false;
      assert.equal(storedRun.phase, "submitting", "Pause must land across the click/ACK persistence window");
      pauseResponse = await harness.control("AIPM_PAUSE");
      return null;
    }
  });

  await harness.start(quickRepeatWorkflow());
  await harness.settle();

  assert.equal(armed, false);
  assert.equal(pauseResponse?.ok, true);
  assert.equal(harness.page.clicks, 2);
  assertPausedAt(harness, 2);
  assert.deepEqual(promptsSent(harness), [
    "回答は EDGE-TEST だけにしてください。",
    "回答は EDGE-TEST だけにしてください。"
  ]);

  const resume = await harness.control("AIPM_RESUME");
  await harness.settle();

  assert.equal(resume.ok, true);
  assert.equal(harness.stored().status, "completed");
  assert.equal(harness.stored().cursor.sendsCompleted, 5);
  assert.equal(harness.page.clicks, 5);
  assert.equal(new Set(harness.clicks().map((entry) => entry.position)).size, 5, "no repeat cursor may click twice");
});

test("Pause during ACK with an actually ambiguous outcome remains fail-closed and is never retried", async () => {
  let armed = true;
  let harness;
  harness = createWorkflowHarness({
    ackConfirms: false,
    async onRunSet({ message }) {
      if (!armed || message.run?.phase !== "waiting-ack") return null;
      armed = false;
      const response = await harness.control("AIPM_PAUSE");
      assert.equal(response.ok, true);
      return null;
    }
  });

  await harness.start(quickRepeatWorkflow(3));
  await harness.settle();

  const run = harness.stored();
  assert.equal(armed, false);
  assert.equal(harness.page.clicks, 1);
  assert.equal(run.status, "paused");
  assert.equal(run.phase, "ambiguous");
  assert.equal(run.resumable, false);
  assert.equal(run.lastErrorCode, "submission_ambiguous");
  assert.equal(run.outbox?.state, "submitted");
  assert.equal(run.cursor.sendsCompleted, 0);

  const resume = await harness.control("AIPM_RESUME");
  assert.equal(resume.ok, false);
  assert.equal(harness.page.clicks, 1, "ambiguous delivery must never be retried");
});

test("Stop wins over a pending Pause and no later Resume can Send", async () => {
  let armed = true;
  let harness;
  harness = createWorkflowHarness({
    async onRunSet({ message }) {
      if (!armed || message.run?.phase !== "waiting-ack") return null;
      armed = false;
      const pause = await harness.control("AIPM_PAUSE");
      assert.equal(pause.ok, true);
      const stop = await harness.control("AIPM_STOP");
      assert.equal(stop.ok, true);
      return null;
    }
  });

  await harness.start(quickRepeatWorkflow());
  await harness.settle();

  assert.equal(armed, false);
  assert.equal(harness.stored().status, "stopped");
  assert.equal(harness.stored().pauseRequested, false);
  assert.equal(harness.page.clicks, 1);

  const resume = await harness.control("AIPM_RESUME");
  await harness.settle();
  assert.equal(resume.ok, false);
  assert.equal(harness.stored().status, "stopped");
  assert.equal(harness.page.clicks, 1, "Stop must prevent all later Send activity");
});
