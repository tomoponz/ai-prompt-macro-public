import test from "node:test";
import assert from "node:assert/strict";
import {
  clickPositions,
  clone,
  createWorkflowHarness,
  promptsSent,
  threePromptWorkflow
} from "./helpers/workflow-harness.mjs";

function quickRepeatWorkflow(repeat = 5, delayAfterMs = 15_000) {
  return {
    schemaVersion: 1,
    id: "quick-macro",
    name: "Quick Macro",
    maxSends: repeat,
    steps: [{ id: "quick", type: "prompt", delivery: "send", prompt: "REPEAT", repeat, delayAfterMs }]
  };
}

function assertOneClickPerPosition(harness, label) {
  const positions = clickPositions(harness);
  assert.equal(
    new Set(positions).size,
    positions.length,
    `${label}: a logical send position was clicked more than once (${positions.join(", ")})`
  );
}

// ---------------------------------------------------------------------------
// The core invariant, swept across every durable checkpoint: interrupting the
// runner at the k-th durable write and recovering must never click a logical
// send position twice, and must never exceed the planned send count.
// ---------------------------------------------------------------------------
async function sweepBoundary(workflow, plannedSends, breakAtSave) {
  let saveCount = 0;
  let fired = false;
  const harness = createWorkflowHarness({
    async onSave({ context }) {
      saveCount += 1;
      if (fired || saveCount !== breakAtSave) return;
      fired = true;
      context.localRunnerToken += 1;
    }
  });

  await harness.start(workflow);
  await harness.settle();
  if (fired) await harness.reload(1_000);
  return { harness, fired, plannedSends };
}

for (const [label, workflow, plannedSends, boundaries] of [
  ["Repeat=5", quickRepeatWorkflow(), 5, 26],
  ["A->Delay->B->Delay->C", threePromptWorkflow(), 3, 26]
]) {
  test(`STAGE4: ${label} never clicks one logical position twice across every reload boundary`, async () => {
    for (let boundary = 1; boundary <= boundaries; boundary += 1) {
      const { harness, fired } = await sweepBoundary(workflow, plannedSends, boundary);
      const context = `${label} boundary ${boundary}`;
      assert.equal(fired, true, `${context}: the interruption point must be reachable`);
      assertOneClickPerPosition(harness, context);
      assert.ok(
        harness.page.clicks <= plannedSends,
        `${context}: ${harness.page.clicks} clicks exceeded the planned ${plannedSends}`
      );
      const stored = harness.stored();
      assert.ok(
        stored.cursor.sendsCompleted <= stored.workflow.maxSends,
        `${context}: sendsCompleted ${stored.cursor.sendsCompleted} exceeded maxSends`
      );
      assert.ok(
        ["completed", "paused", "running", "stopped"].includes(stored.status),
        `${context}: unexpected terminal status ${stored.status}`
      );
      if (stored.status === "completed") {
        assert.equal(
          harness.page.clicks,
          plannedSends,
          `${context}: a completed Run must have sent every planned prompt exactly once`
        );
        assert.equal(stored.cursor.sendsCompleted, plannedSends, `${context}: completed cursor mismatch`);
      } else {
        assert.equal(stored.status, "paused", `${context}: an unfinished Run must fail closed, not idle`);
        assert.ok(stored.lastErrorCode, `${context}: a paused Run must record why it stopped`);
        assert.equal(stored.resumable, false, `${context}: an ambiguous delivery must not be auto-resumable`);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Control races against recovery.
// ---------------------------------------------------------------------------
test("STAGE4: Pause during confirmed recovery consumes the confirmed Send once, then pauses", async () => {
  let reloadArmed = true;
  const harness = createWorkflowHarness({
    async onSave({ run, context }) {
      if (!reloadArmed || run.outbox?.state !== "confirmed") return;
      reloadArmed = false;
      context.localRunnerToken += 1;
    }
  });

  await harness.start(quickRepeatWorkflow(5, 1_000));
  await harness.settle();
  assert.equal(reloadArmed, false, "a confirmed outbox must be persisted");
  assert.equal(harness.page.clicks, 1);

  // Pause lands while the durable state still holds the confirmed outbox.
  const pause = await harness.control("AIPM_PAUSE", { expectedRunId: harness.stored().runId });
  assert.equal(pause.ok, true, `Pause must be accepted (got: ${pause.error})`);
  const pendingPause = harness.stored();
  assert.equal(pendingPause.status, "running");
  assert.equal(pendingPause.pauseRequested, true, "Pause must remain durable while the exact Send is unresolved");
  assert.equal(pendingPause.outbox?.state, "confirmed");

  harness.context.recoveryStarted = false;
  await assert.doesNotReject(harness.context.recoverIfNeeded(), "recovery must not reject after a Pause");
  await harness.settle();

  assert.equal(harness.stored().status, "paused", "recovery must settle the pending Pause at the next boundary");
  assert.equal(harness.stored().cursor.sendsCompleted, 1, "the confirmed Send must be counted exactly once");
  assert.equal(harness.stored().outbox, null);
  assert.equal(harness.stored().resumable, true);
  assert.equal(harness.page.clicks, 1, "recovery must not send again after a Pause");
  assertOneClickPerPosition(harness, "pause-during-confirmed-recovery");
});

test("STAGE4: Stop during a run wins and a fresh Start still works in the same document", async () => {
  let stopArmed = true;
  const harness = createWorkflowHarness({
    async onSave({ run, context }) {
      if (!stopArmed || run.cursor.sendsCompleted !== 1) return;
      stopArmed = false;
      context.localRunnerToken += 1;
    }
  });

  await harness.start(quickRepeatWorkflow(5, 1_000));
  await harness.settle();
  assert.equal(stopArmed, false);

  const stop = await harness.control("AIPM_STOP", { expectedRunId: harness.stored().runId });
  assert.equal(stop.ok, true);
  assert.equal(harness.stored().status, "stopped");

  harness.context.recoveryStarted = false;
  await assert.doesNotReject(harness.context.recoverIfNeeded());
  await harness.settle();
  assert.equal(harness.stored().status, "stopped", "Stop takes priority over recovery");

  const clicksAfterStop = harness.page.clicks;
  const restart = await harness.start(quickRepeatWorkflow(2, 1_000));
  await harness.settle();

  assert.equal(restart.ok, true, `a fresh Start must work after Stop (got: ${restart.error})`);
  assert.equal(harness.stored().status, "completed");
  assert.equal(harness.page.clicks, clicksAfterStop + 2, "the fresh Run sends exactly its own planned sends");
});

test("STAGE4: a blocker detected while waiting for the ACK fails closed without another click", async () => {
  const harness = createWorkflowHarness();
  let blocker = null;
  harness.context.ChatGptAdapter.detectBlocker = () => blocker;
  harness.context.ChatGptAdapter.isGenerating = () => false;
  harness.context.ChatGptAdapter.getGenerationState = () => (blocker ? "ambiguous" : "idle");

  const originalClick = harness.context.ChatGptAdapter.findSendButton();
  const button = {
    disabled: false,
    getAttribute: () => null,
    click() {
      originalClick.click();
      blocker = "usage-limit";
    }
  };
  harness.context.ChatGptAdapter.findSendButton = () => button;

  await harness.start(quickRepeatWorkflow(5, 1_000));
  await harness.settle();

  const stored = harness.stored();
  assert.equal(harness.page.clicks, 1, "a blocker after the click must not trigger another send");
  assert.equal(stored.status, "paused");
  assert.equal(stored.resumable, false, "a blocked, unconfirmed submit must not be auto-resumable");
  assert.equal(stored.cursor.sendsCompleted, 0, "an unconfirmed submit must not count");
});

test("STAGE4: a Service Worker restart mid-run neither duplicates nor drops a send", async () => {
  let restartArmed = true;
  const harness = createWorkflowHarness({
    async onSave({ run, context }) {
      if (!restartArmed || run.cursor.sendsCompleted !== 2) return;
      restartArmed = false;
      // The worker is torn down and revived: durable storage survives, in-flight
      // in-memory lease bookkeeping does not, and the live runner is invalidated.
      context.localRunnerToken += 1;
    }
  });

  await harness.start(quickRepeatWorkflow(5, 1_000));
  await harness.settle();
  assert.equal(restartArmed, false);
  const before = harness.stored();

  harness.dropLeases();
  await harness.reload(2_000);

  assert.equal(harness.page.clicks, 5, "the run must finish its remaining sends exactly once each");
  assertOneClickPerPosition(harness, "service-worker-restart");
  assert.equal(harness.stored().status, "completed");
  assert.ok(harness.stored().cursor.sendsCompleted >= before.cursor.sendsCompleted);
});

test("STAGE4: a stale lease held by another document blocks a send instead of racing it", async () => {
  const harness = createWorkflowHarness();
  harness.seizeLease("other-document");

  await harness.start(quickRepeatWorkflow(3, 1_000));
  await harness.settle();

  const stored = harness.stored();
  assert.equal(harness.page.clicks, 0, "a conversation already leased elsewhere must not be written to");
  assert.equal(stored.status, "paused");
  assert.equal(stored.lastErrorCode, "lease_conflict");
  assert.equal(stored.resumable, false);
});

test("STAGE4: recovery on a conversation that changed under the Run refuses to act", async () => {
  let reloadArmed = true;
  const harness = createWorkflowHarness({
    async onSave({ run, context }) {
      if (!reloadArmed || run.cursor.sendsCompleted !== 1) return;
      reloadArmed = false;
      context.localRunnerToken += 1;
    }
  });

  await harness.start(quickRepeatWorkflow(5, 1_000));
  await harness.settle();
  assert.equal(reloadArmed, false);

  // The tab navigated to a different conversation before recovery ran.
  harness.context.ChatGptAdapter.getConversationKey = () => "chatgpt:c:some-other-conversation";
  harness.context.recoveryStarted = false;
  const clicksBefore = harness.page.clicks;
  await harness.context.recoverIfNeeded();
  await harness.settle();

  assert.equal(harness.page.clicks, clicksBefore, "recovery must never send into a different conversation");
  assert.notEqual(harness.stored().status, "completed");
});

test("STAGE4: every prompt of a 3-prompt workflow still lands exactly once after a mid-run reload", async () => {
  let reloadArmed = true;
  const harness = createWorkflowHarness({
    async onSave({ run, context }) {
      if (!reloadArmed || run.cursor.sendsCompleted !== 1) return;
      reloadArmed = false;
      context.localRunnerToken += 1;
    }
  });

  await harness.start(threePromptWorkflow());
  await harness.settle();
  assert.equal(reloadArmed, false);
  await harness.reload(5_000);

  assert.deepEqual(promptsSent(harness), ["PROMPT A", "PROMPT B", "PROMPT C"]);
  assertOneClickPerPosition(harness, "three-prompt-mid-run-reload");
  assert.equal(harness.stored().status, "completed");
  void clone;
});
