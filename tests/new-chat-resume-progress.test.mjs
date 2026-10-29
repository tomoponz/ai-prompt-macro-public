import test from "node:test";
import assert from "node:assert/strict";

import { canResumePausedRun, displayDeliveredSendCount } from "../src/run-ux.js";
import { clickPositions, createWorkflowHarness, promptsSent } from "./helpers/workflow-harness.mjs";

// These are production controller/runner tests with a modeled background and DOM.
// The setup constructs a legacy first-click checkpoint; current production Start
// requires a canonical conversation. Real background identity/serialization tests
// separately cover navigation and document replacement. harness.reload() below is
// a same-VM recovery pass, not proof of browser reload or document-lifetime safety.
const NEW_CHAT_KEY = "chatgpt:new:root:resume-progress-fixture";
const CANONICAL_KEY = "chatgpt:c:resume-progress-fixture";
const FIRST_PROMPT = "SYNTHETIC FIRST PROMPT";
const NEXT_PROMPT = "SYNTHETIC NEXT PROMPT";
const CONFIRMATION = "new-chat-confirmation-required";

function workflow() {
  return {
    schemaVersion: 1,
    id: "new-chat-resume-progress",
    name: "New Chat resume progress",
    maxSends: 4,
    steps: [
      { id: "first", type: "prompt", delivery: "send", prompt: FIRST_PROMPT, repeat: 3, delayAfterMs: 0 },
      { id: "next", type: "prompt", delivery: "send", prompt: NEXT_PROMPT, repeat: 1, delayAfterMs: 0 }
    ]
  };
}

const progress = (run) => ({
  stepIndex: run.cursor.stepIndex,
  repeatIndex: run.cursor.repeatIndex,
  sendsCompleted: run.cursor.sendsCompleted
});

const isAdoption = (message) => message.type === "AIPM_RUN_CONFIRM_NEW_CHAT_TARGET";
const isResumeSave = (message) => message.type === "AIPM_RUN_SET" && message.runTransition === "resume";

function interceptOnce(harness, matches, effect) {
  const runtime = harness.context.chrome.runtime;
  const original = runtime.sendMessage;
  let triggered = false;
  runtime.sendMessage = async function(message) {
    if (triggered || !matches(message)) return original.call(runtime, message);
    triggered = true;
    return effect(message, () => original.call(runtime, message));
  };
  return { triggered: () => triggered, restore: () => { runtime.sendMessage = original; } };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function holdCommittedReply(harness, matches) {
  const entered = deferred();
  const release = deferred();
  const interception = interceptOnce(harness, matches, async (_message, deliver) => {
    const response = await deliver();
    entered.resolve(response);
    await release.promise;
    return response;
  });
  return { ...interception, entered: entered.promise, release: release.resolve };
}

function assertPendingFirstSend(harness, conversationKey = CANONICAL_KEY) {
  const run = harness.stored();
  assert.equal(run.status, "paused");
  assert.equal(run.phase, CONFIRMATION);
  assert.equal(run.pauseReason, CONFIRMATION);
  assert.equal(run.conversationKey, conversationKey);
  assert.equal(run.outbox?.state, "submitted");
  assert.deepEqual(progress(run), { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 });
  assert.deepEqual(clickPositions(harness), ["0:0"]);
}

async function loseAdoptionReply(harness) {
  const fault = interceptOnce(harness, isAdoption, async (_message, deliver) => {
    assert.equal((await deliver()).ok, true, "adoption must commit before its reply is lost");
    throw new Error("Synthetic adoption reply loss after commit");
  });
  try {
    assert.equal((await harness.control("AIPM_RESUME")).ok, false);
    await harness.settle();
    assert.equal(fault.triggered(), true);
    assertPendingFirstSend(harness);
  } finally { fault.restore(); }
}

async function firstSendPaused(options = {}) {
  const harness = createWorkflowHarness({ conversationKey: NEW_CHAT_KEY, ...options });
  await harness.ready();
  assert.equal((await harness.start(workflow())).ok, true);
  await harness.settle();
  const paused = harness.stored();
  assert.equal(paused.status, "paused");
  assert.equal(paused.phase, CONFIRMATION);
  assert.equal(paused.pauseReason, CONFIRMATION);
  assert.equal(paused.outbox?.state, "submitted");
  assert.deepEqual(progress(paused), { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 });
  assert.equal(displayDeliveredSendCount(paused), 0, "an unconfirmed first click is not displayed as confirmed delivery");
  assert.equal(canResumePausedRun(paused), true, "the existing Resume action offers explicit confirmation");
  assert.deepEqual(clickPositions(harness), ["0:0"]);
  assert.deepEqual(promptsSent(harness), [FIRST_PROMPT]);
  return harness;
}

function assertCompletedOnce(harness) {
  const completed = harness.stored();
  assert.equal(completed.status, "completed");
  assert.equal(completed.conversationKey, CANONICAL_KEY);
  assert.deepEqual(progress(completed), { stepIndex: 2, repeatIndex: 0, sendsCompleted: 4 });
  assert.equal(displayDeliveredSendCount(completed), 4);
  assert.deepEqual(clickPositions(harness), ["0:0", "0:1", "0:2", "1:0"]);
  assert.deepEqual(promptsSent(harness), [FIRST_PROMPT, FIRST_PROMPT, FIRST_PROMPT, NEXT_PROMPT]);
}

test("New Chat explicit Resume counts the first send once, preserves two remaining repeats, then sends the next prompt", async () => {
  const resumeWrites = [];
  const harness = await firstSendPaused({
    onRunSet({ message }) {
      if (message.runTransition === "resume") resumeWrites.push(message.run);
    }
  });
  const pausedWorkflow = harness.stored().workflow;

  const premature = await harness.control("AIPM_RESUME");
  await harness.settle();
  assert.equal(premature.ok, false, "Resume requires a canonical conversation");
  assert.equal(harness.page.clicks, 1);

  harness.setConversationKey(CANONICAL_KEY);
  await harness.settle();
  assert.equal(harness.stored().conversationKey, NEW_CHAT_KEY, "a changed route alone does not adopt a target");
  assert.equal(harness.page.clicks, 1);

  assert.equal((await harness.control("AIPM_RESUME")).ok, true);
  await harness.settle();
  assert.equal(resumeWrites.length, 1);
  assert.deepEqual(progress(resumeWrites[0]), { stepIndex: 0, repeatIndex: 1, sendsCompleted: 1 });
  assert.equal(resumeWrites[0].outbox, null);
  assert.equal(displayDeliveredSendCount(resumeWrites[0]), 1);
  assert.deepEqual(resumeWrites[0].workflow, pausedWorkflow, "confirmation must preserve the remaining workflow");
  assertCompletedOnce(harness);

  assert.equal((await harness.control("AIPM_RESUME")).ok, false, "a completed Run cannot replay on another Resume");
  await harness.settle();
  assertCompletedOnce(harness);
});

test("two concurrent explicit Resume requests cannot confirm or send a New Chat position twice", async () => {
  const harness = await firstSendPaused();
  harness.setConversationKey(CANONICAL_KEY);
  const results = await Promise.all([harness.control("AIPM_RESUME"), harness.control("AIPM_RESUME")]);
  await harness.settle();
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(harness.transcript.filter((entry) => entry.type === "new-chat-target-confirmed").length, 1);
  assertCompletedOnce(harness);
});

test("a canonical route and reload do not adopt or replay an unconfirmed first New Chat send", async () => {
  const harness = await firstSendPaused();
  const pausedWorkflow = harness.stored().workflow;
  harness.setConversationKey(CANONICAL_KEY);
  await harness.reload(10_000);
  const paused = harness.stored();
  assert.equal(paused.status, "paused");
  assert.equal(paused.pauseReason, CONFIRMATION);
  assert.equal(paused.conversationKey, NEW_CHAT_KEY);
  assert.deepEqual(progress(paused), { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 });
  assert.deepEqual(paused.workflow, pausedWorkflow);
  assert.deepEqual(clickPositions(harness), ["0:0"]);
  assert.equal(harness.transcript.filter((entry) => entry.type === "new-chat-target-confirmed").length, 0);
});

test("Stop at New Chat confirmation preserves the pending workflow but rejects all later Resume sends", async () => {
  const harness = await firstSendPaused();
  const pausedWorkflow = harness.stored().workflow;
  assert.equal((await harness.control("AIPM_STOP")).ok, true);
  await harness.settle();
  harness.setConversationKey(CANONICAL_KEY);
  assert.equal((await harness.control("AIPM_RESUME")).ok, false);
  await harness.settle();
  assert.equal(harness.stored().status, "stopped");
  assert.deepEqual(harness.stored().workflow, pausedWorkflow);
  assert.deepEqual(progress(harness.stored()), { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 });
  assert.deepEqual(clickPositions(harness), ["0:0"]);
});

test("Stop immediately after New Chat confirmation prevents remaining repeats without replaying its counted first send", async () => {
  let harness;
  let stopResult;
  let stopArmed = true;
  harness = await firstSendPaused({
    async onRunGet({ storedRun }) {
      if (stopArmed && storedRun?.status === "running" && storedRun?.conversationKey === CANONICAL_KEY &&
          storedRun.cursor.sendsCompleted === 1) {
        stopArmed = false;
        stopResult = await harness.control("AIPM_STOP");
      }
    }
  });
  harness.setConversationKey(CANONICAL_KEY);
  assert.equal((await harness.control("AIPM_RESUME")).ok, true);
  await harness.settle();
  assert.equal(stopArmed, false);
  assert.equal(stopResult.ok, true);
  assert.equal(harness.stored().status, "stopped");
  assert.deepEqual(progress(harness.stored()), { stepIndex: 0, repeatIndex: 1, sendsCompleted: 1 });
  assert.deepEqual(clickPositions(harness), ["0:0"]);
  assert.equal((await harness.control("AIPM_RESUME")).ok, false);
  await harness.settle();
  assert.deepEqual(clickPositions(harness), ["0:0"]);
});

// A precommit rejection leaves the first click recorded but not yet counted.
// An explicit retry must complete that same confirmation without replaying it.
// The harness uses production runner/controller code and models background adoption.
test("an explicit second Resume recovers a rejected New Chat progress save without replay or double counting", async () => {
  let rejectResume = true;
  const harness = await firstSendPaused({
    onRunSet({ message }) {
      if (rejectResume && message.runTransition === "resume") {
        rejectResume = false;
        return { ok: false, errorCode: "RUN_STATE_CONFLICT", error: "Synthetic precommit Resume failure" };
      }
    }
  });
  harness.setConversationKey(CANONICAL_KEY);
  assert.equal((await harness.control("AIPM_RESUME")).ok, false);
  await harness.settle();
  assert.equal(rejectResume, false);

  const stranded = harness.stored();
  assert.equal(stranded.conversationKey, CANONICAL_KEY, "target adoption committed before progress failed");
  assert.equal(stranded.status, "paused");
  assert.equal(stranded.phase, CONFIRMATION);
  assert.equal(stranded.pauseReason, CONFIRMATION);
  assert.equal(stranded.outbox?.state, "submitted");
  assert.deepEqual(progress(stranded), { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 });
  assert.equal(canResumePausedRun(stranded), true, "the retained confirmation permits an explicit retry");
  assert.deepEqual(clickPositions(harness), ["0:0"]);

  const retry = await harness.control("AIPM_RESUME");
  await harness.settle();
  assert.equal(retry.ok, true, "explicit Resume must recover the partially committed confirmation");
  assertCompletedOnce(harness);
  assert.equal((await harness.control("AIPM_RESUME")).ok, false);
  await harness.settle();
  assertCompletedOnce(harness);
});

for (const failure of ["rejected", "thrown"]) {
  test(`an adoption ${failure} before commit leaves the legacy checkpoint unchanged until explicit retry`, async () => {
    const harness = await firstSendPaused();
    const before = harness.stored();
    const saveCount = harness.saves().length;
    harness.setConversationKey(CANONICAL_KEY);
    const fault = interceptOnce(harness, isAdoption, async () => {
      if (failure === "thrown") throw new Error("Synthetic adoption failure before commit");
      return { ok: false, error: "Synthetic adoption rejection before commit" };
    });
    try {
      assert.equal((await harness.control("AIPM_RESUME")).ok, false);
      await harness.settle();
      assert.equal(fault.triggered(), true);
      assert.deepEqual(harness.stored(), before);
      assert.equal(harness.saves().length, saveCount);
      assertPendingFirstSend(harness, NEW_CHAT_KEY);
      assert.equal((await harness.control("AIPM_RESUME")).ok, true);
      await harness.settle();
      assertCompletedOnce(harness);
    } finally { fault.restore(); }
  });
}

test("a lost committed adoption reply is recoverable by one explicit Resume without another target write", async () => {
  const harness = await firstSendPaused();
  harness.setConversationKey(CANONICAL_KEY);
  await loseAdoptionReply(harness);
  const adoptedRevision = harness.stored().stateRevision;
  const gate = holdCommittedReply(harness, isAdoption);
  const retry = harness.control("AIPM_RESUME");
  try {
    const response = await gate.entered;
    assert.equal(response.ok, true);
    assert.equal(response.run.stateRevision, adoptedRevision, "idempotent adoption must not create another revision");
    assertPendingFirstSend(harness);
    assert.equal(harness.stored().stateRevision, adoptedRevision);
    gate.release();
    assert.equal((await retry).ok, true);
    await harness.settle();
    assertCompletedOnce(harness);
  } finally { gate.release(); gate.restore(); await retry; }
});

test("a thrown progress save before commit retains one uncounted click for explicit retry", async () => {
  const harness = await firstSendPaused();
  harness.setConversationKey(CANONICAL_KEY);
  const fault = interceptOnce(harness, isResumeSave, async () => {
    throw new Error("Synthetic progress failure before commit");
  });
  try {
    assert.equal((await harness.control("AIPM_RESUME")).ok, false);
    await harness.settle();
    assert.equal(fault.triggered(), true);
    assertPendingFirstSend(harness);
    assert.equal((await harness.control("AIPM_RESUME")).ok, true);
    await harness.settle();
    assertCompletedOnce(harness);
  } finally { fault.restore(); }
});

test("a committed progress reply loss is already counted once and explicit Pause then Resume continues the remainder", async () => {
  const harness = await firstSendPaused();
  harness.setConversationKey(CANONICAL_KEY);
  const fault = interceptOnce(harness, isResumeSave, async (_message, deliver) => {
    assert.equal((await deliver()).ok, true, "progress must commit before the reply is lost");
    throw new Error("Synthetic progress reply loss after commit");
  });
  try {
    assert.equal((await harness.control("AIPM_RESUME")).ok, false);
    await harness.settle();
    assert.equal(fault.triggered(), true);
    const committed = harness.stored();
    assert.equal(committed.status, "running");
    assert.equal(committed.outbox, null);
    assert.deepEqual(progress(committed), { stepIndex: 0, repeatIndex: 1, sendsCompleted: 1 });
    assert.deepEqual(clickPositions(harness), ["0:0"], "a failed reply must not invent a runner launch");
    assert.equal((await harness.control("AIPM_RESUME")).ok, false, "running progress cannot be confirmed a second time");
    assert.equal((await harness.control("AIPM_PAUSE")).ok, true);
    await harness.settle();
    assert.equal(harness.stored().pauseReason, "user-pause");
    assert.deepEqual(progress(harness.stored()), progress(committed));
    assert.equal((await harness.control("AIPM_RESUME")).ok, true);
    await harness.settle();
    assertCompletedOnce(harness);
  } finally { fault.restore(); }
});

test("two concurrent explicit retries of a partially committed confirmation count the first send once", async () => {
  const harness = await firstSendPaused();
  harness.setConversationKey(CANONICAL_KEY);
  await loseAdoptionReply(harness);
  const gate = holdCommittedReply(harness, isAdoption);
  const first = harness.control("AIPM_RESUME");
  try {
    assert.equal((await gate.entered).ok, true);
    const second = harness.control("AIPM_RESUME");
    gate.release();
    const results = await Promise.all([first, second]);
    await harness.settle();
    assert.equal(results.filter((result) => result.ok).length, 1);
    assertCompletedOnce(harness);
  } finally { gate.release(); gate.restore(); await first; }
});

test("Stop committed before an adoption reply returns prevents its later progress write", async () => {
  const harness = await firstSendPaused();
  harness.setConversationKey(CANONICAL_KEY);
  const gate = holdCommittedReply(harness, isAdoption);
  const resume = harness.control("AIPM_RESUME");
  try {
    assert.equal((await gate.entered).ok, true);
    assertPendingFirstSend(harness);
    assert.equal((await harness.control("AIPM_STOP")).ok, true);
    gate.release();
    assert.equal((await resume).ok, false);
    await harness.settle();
    assert.equal(harness.stored().status, "stopped");
    assert.deepEqual(progress(harness.stored()), { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 });
    assert.deepEqual(clickPositions(harness), ["0:0"]);
    assert.equal((await harness.control("AIPM_RESUME")).ok, false);
  } finally { gate.release(); gate.restore(); await resume; }
});

for (const control of ["AIPM_PAUSE", "AIPM_STOP"]) {
  test(`${control} between progress commit and reply prevents any remaining automatic Send`, async () => {
    const pausedRead = deferred();
    let observePaused = false;
    const harness = await firstSendPaused({
      onRunGet({ message, storedRun }) {
        if (observePaused && message.readOnlyObservation === true && storedRun?.status === "paused" &&
            storedRun.pauseReason === "user-pause") {
          observePaused = false;
          pausedRead.resolve();
        }
      }
    });
    harness.setConversationKey(CANONICAL_KEY);
    const gate = holdCommittedReply(harness, isResumeSave);
    const resume = harness.control("AIPM_RESUME");
    try {
      assert.equal((await gate.entered).ok, true);
      assert.deepEqual(progress(harness.stored()), { stepIndex: 0, repeatIndex: 1, sendsCompleted: 1 });
      assert.equal((await harness.control(control)).ok, true);
      observePaused = control === "AIPM_PAUSE";
      gate.release();
      await resume;
      // A live runner intentionally waits while paused. Observe that boundary,
      // then explicitly resume before awaiting the runner's final completion.
      if (control === "AIPM_PAUSE") await pausedRead.promise;
      else await harness.settle();
      assert.equal(harness.stored().status, control === "AIPM_PAUSE" ? "paused" : "stopped");
      assert.deepEqual(progress(harness.stored()), { stepIndex: 0, repeatIndex: 1, sendsCompleted: 1 });
      assert.deepEqual(clickPositions(harness), ["0:0"]);
      if (control === "AIPM_PAUSE") {
        assert.equal((await harness.control("AIPM_RESUME")).ok, true);
        await harness.settle();
        assertCompletedOnce(harness);
      } else {
        assert.equal((await harness.control("AIPM_RESUME")).ok, false);
        assert.deepEqual(clickPositions(harness), ["0:0"]);
      }
    } finally {
      gate.release();
      gate.restore();
      await resume;
      if (harness.stored().status === "paused") await harness.control("AIPM_STOP");
      await harness.settle();
    }
  });
}

test("a recovery pass leaves a partially committed confirmation paused until a fresh explicit Resume", async () => {
  const harness = await firstSendPaused();
  harness.setConversationKey(CANONICAL_KEY);
  await loseAdoptionReply(harness);
  const before = harness.stored();
  await harness.reload(10_000);
  assertPendingFirstSend(harness);
  assert.deepEqual(harness.stored(), before);
  assert.equal((await harness.control("AIPM_RESUME")).ok, true);
  await harness.settle();
  assertCompletedOnce(harness);
});
