// T3 — unfinished outbox recovery torture.
//
// The outbox is the only durable evidence of what happened to an irreversible click.
// Four durable snapshots straddle that click:
//
//   prepared/prepared      the click provably has NOT happened
//   submitting/prepared    the snapshot straddles the click
//   waiting-ack/submitted  the click happened, delivery is unresolved
//   generating/confirmed   delivery is proven
//
// Each one is combined with reload, generic Resume, replacement Run, Stop and the New Chat
// confirmation path. The property under test is that a *generic* Resume never increases
// Send authority: the only exception is the explicit New Chat confirmation, and only after
// the user has moved to a canonical conversation.
import test from "node:test";
import assert from "node:assert/strict";

import { clickPositions, createWorkflowHarness } from "./helpers/workflow-harness.mjs";

const PROMPT = "OUTBOX RECOVERY";

function workflow(steps = 1) {
  return {
    schemaVersion: 1,
    id: "outbox-recovery",
    name: "Outbox Recovery",
    maxSends: steps,
    steps: [{ id: "send", type: "prompt", delivery: "send", prompt: PROMPT, repeat: steps, delayAfterMs: 0 }]
  };
}

// Reach one exact durable snapshot by invalidating the live runner at the save that writes
// it. The durable state is then left untouched for the follow-up action.
const SNAPSHOTS = {
  "prepared/prepared": {
    matches: (run) => run.phase === "prepared" && run.outbox?.state === "prepared",
    clicksAtSnapshot: 0,
    provablyUnclicked: true
  },
  "submitting/prepared": {
    matches: (run) => run.phase === "submitting" && run.outbox?.state === "prepared",
    clicksAtSnapshot: 0,
    provablyUnclicked: false
  },
  "waiting-ack/submitted": {
    matches: (run) => run.phase === "waiting-ack" && run.outbox?.state === "submitted",
    clicksAtSnapshot: 1,
    provablyUnclicked: false
  },
  "generating/confirmed": {
    matches: (run) => run.phase === "generating" && run.outbox?.state === "confirmed",
    clicksAtSnapshot: 1,
    provablyUnclicked: false
  }
};

async function reachSnapshot(name, options = {}) {
  const snapshot = SNAPSHOTS[name];
  let armed = true;
  const harness = createWorkflowHarness({
    ...options,
    onSave({ run, context }) {
      if (!armed || !snapshot.matches(run)) return;
      armed = false;
      // The live runner is invalidated exactly here, the way a reload or a Service Worker
      // teardown would end it, leaving this durable snapshot behind.
      context.localRunnerToken += 1;
    }
  });
  await harness.start(options.workflow ?? workflow(1));
  await harness.settle();
  assert.equal(armed, false, `${name}: the durable snapshot must be reachable`);
  assert.equal(harness.page.clicks, snapshot.clicksAtSnapshot, `${name}: unexpected click count at snapshot`);
  return harness;
}

function assertNoDuplicate(harness, context) {
  const positions = clickPositions(harness);
  assert.equal(
    new Set(positions).size,
    positions.length,
    `${context}: a logical send position was clicked more than once (${positions.join(", ")})`
  );
}

test("T3: reload recovery only re-arms the snapshot that proves the click never happened", async () => {
  for (const [name, snapshot] of Object.entries(SNAPSHOTS)) {
    const harness = await reachSnapshot(name);
    await harness.reload(1_000);

    const stored = harness.stored();
    const context = `${name} + reload`;
    assertNoDuplicate(harness, context);

    if (snapshot.provablyUnclicked) {
      // Pre-submit checkpoint: the unsent preparation is discarded and the identical
      // position is retried exactly once.
      assert.equal(harness.page.clicks, 1, `${context}: the unsent position must be retried exactly once`);
      assert.equal(stored.status, "completed", `${context}: the retried Run must be able to finish`);
      assert.equal(stored.cursor.sendsCompleted, 1);
    } else if (name === "generating/confirmed") {
      // Delivery certainty is monotonic: recovery commits the confirmed send once and does
      // not click again.
      assert.equal(harness.page.clicks, 1, `${context}: a confirmed delivery must not be re-clicked`);
      assert.equal(stored.cursor.sendsCompleted, 1, `${context}: the confirmed send is committed exactly once`);
      assert.equal(stored.outbox, null, `${context}: the outbox is cleared once its send is committed`);
    } else {
      assert.equal(harness.page.clicks, snapshot.clicksAtSnapshot, `${context}: recovery must not click`);
      assert.equal(stored.status, "paused", `${context}: an unresolved delivery must fail closed`);
      assert.equal(stored.resumable, false, `${context}: an unresolved delivery must not be auto-resumable`);
      assert.equal(stored.lastErrorCode, "recovery_ambiguous");
      assert.ok(stored.outbox, `${context}: the evidence of the unresolved delivery must be retained`);
    }
  }
});

test("T3: a generic Resume never grants Send authority to an unresolved delivery", async () => {
  for (const name of ["submitting/prepared", "waiting-ack/submitted"]) {
    const harness = await reachSnapshot(name);
    await harness.reload(1_000);
    const clicksBefore = harness.page.clicks;

    const resume = await harness.control("AIPM_RESUME");
    await harness.settle();

    const context = `${name} + reload + Resume`;
    assert.equal(resume.ok, false, `${context}: Resume must be refused`);
    assert.equal(harness.page.clicks, clicksBefore, `${context}: a refused Resume must not send`);
    const stored = harness.stored();
    assert.equal(stored.status, "paused");
    assert.equal(stored.resumable, false);
    assert.equal(stored.phase, "ambiguous", `${context}: the refusal must be recorded as review-required`);
    assertNoDuplicate(harness, context);

    // Repeating the refused Resume must stay refused, not wear the guard down.
    const again = await harness.control("AIPM_RESUME");
    await harness.settle();
    assert.equal(again.ok, false, `${context}: a repeated Resume must stay refused`);
    assert.equal(harness.page.clicks, clicksBefore);
  }
});

test("T3: a replacement Run cannot start over an unresolved delivery, and Stop clears it cleanly", async () => {
  for (const name of ["submitting/prepared", "waiting-ack/submitted"]) {
    const harness = await reachSnapshot(name);
    await harness.reload(1_000);
    const clicksBefore = harness.page.clicks;

    const blocked = await harness.start(workflow(1));
    await harness.settle();
    const context = `${name} + replacement Run`;
    assert.equal(blocked.ok, false, `${context}: a replacement Run must not start over an active Run`);
    assert.equal(harness.page.clicks, clicksBefore, `${context}: a refused Start must not send`);

    const stop = await harness.control("AIPM_STOP");
    await harness.settle();
    assert.equal(stop.ok, true, `${context}: Stop must always be available`);
    assert.equal(harness.stored().status, "stopped");

    const restart = await harness.start(workflow(1));
    await harness.settle();
    assert.equal(restart.ok, true, `${context}: a fresh Run must be possible after Stop`);
    assert.equal(harness.stored().outbox, null, `${context}: the old outbox must not survive into the new Run`);
    assert.equal(
      harness.stored().cursor.sendsCompleted,
      1,
      `${context}: the fresh Run counts only its own sends`
    );
    assert.equal(harness.page.clicks, clicksBefore + 1, `${context}: the fresh Run sends exactly once`);
  }
});

test("T3: Stop at every unfinished outbox snapshot is terminal and refuses later Resume", async () => {
  for (const [name, snapshot] of Object.entries(SNAPSHOTS)) {
    const harness = await reachSnapshot(name);
    const clicksBefore = harness.page.clicks;

    const stop = await harness.control("AIPM_STOP");
    await harness.settle();
    const context = `${name} + Stop`;
    assert.equal(stop.ok, true);
    assert.equal(harness.stored().status, "stopped");
    assert.equal(harness.page.clicks, clicksBefore, `${context}: Stop must not send`);

    // Reload plus Resume after Stop must both be inert.
    await harness.reload(1_000);
    assert.equal(harness.stored().status, "stopped", `${context}: Stop must survive reload recovery`);
    const resume = await harness.control("AIPM_RESUME");
    await harness.settle();
    assert.equal(resume.ok, false, `${context}: a stopped Run must refuse Resume`);
    assert.equal(harness.page.clicks, snapshot.clicksAtSnapshot, `${context}: nothing may send after Stop`);
  }
});

test("T3: Pause at the provably unclicked snapshot discards the preparation and Resume retries once", async () => {
  let armed = true;
  let harness;
  harness = createWorkflowHarness({
    async onSave({ run }) {
      if (!armed || run.phase !== "prepared" || run.outbox?.state !== "prepared") return;
      armed = false;
      const pause = await harness.control("AIPM_PAUSE");
      assert.equal(pause.ok, true);
    }
  });

  await harness.start(workflow(1));
  await harness.settle();

  assert.equal(armed, false);
  assert.equal(harness.page.clicks, 0);
  const paused = harness.stored();
  assert.equal(paused.status, "paused");
  assert.equal(paused.outbox, null, "a provably unclicked preparation is the only outbox Pause may discard");
  assert.equal(paused.resumable, true);

  const resume = await harness.control("AIPM_RESUME");
  await harness.settle();
  assert.equal(resume.ok, true);
  assert.equal(harness.page.clicks, 1, "Resume retries the identical position exactly once");
  assertNoDuplicate(harness, "pause at prepared then resume");
});

// ---------------------------------------------------------------------------
// New Chat: the one explicit-confirmation exception
// ---------------------------------------------------------------------------

const NEW_CHAT_KEY = "chatgpt:new:root:torture-instance";

async function newChatHarness() {
  const harness = createWorkflowHarness({ conversationKey: NEW_CHAT_KEY });
  await harness.start(workflow(2));
  await harness.settle();
  return harness;
}

test("T3: the first New Chat send pauses for explicit confirmation and a generic Resume adds no authority", async () => {
  const harness = await newChatHarness();

  assert.equal(harness.page.clicks, 1, "New Chat is one-shot: exactly one automatic send");
  const paused = harness.stored();
  assert.equal(paused.status, "paused");
  assert.equal(paused.phase, "new-chat-confirmation-required");
  assert.equal(paused.pauseReason, "new-chat-confirmation-required");
  assert.equal(paused.resumable, false);
  assert.equal(paused.outbox?.state, "submitted", "the delivered click must be recorded, not guessed away");
  assert.equal(paused.cursor.sendsCompleted, 0, "the cursor must not advance before the target is confirmed");

  // Still on the New Chat route: Resume must refuse, because no canonical conversation has
  // been confirmed yet.
  const premature = await harness.control("AIPM_RESUME");
  await harness.settle();
  assert.equal(premature.ok, false, "Resume before a canonical conversation must be refused");
  assert.match(premature.error, /canonical/);
  assert.equal(harness.page.clicks, 1, "a refused Resume must not send");
  assert.equal(harness.stored().cursor.sendsCompleted, 0);
});

test("T3: only an explicit Resume on a canonical conversation adopts the New Chat target", async () => {
  const harness = await newChatHarness();

  harness.setConversationKey("chatgpt:c:adopted-after-new-chat");
  const resume = await harness.control("AIPM_RESUME");
  await harness.settle();

  assert.equal(resume.ok, true, `explicit confirmation must be accepted (got: ${resume.error})`);
  const stored = harness.stored();
  assert.equal(stored.conversationKey, "chatgpt:c:adopted-after-new-chat");
  assert.equal(stored.cursor.sendsCompleted, 2, "the confirmed first send counts exactly once, then the second runs");
  assert.equal(harness.page.clicks, 2);
  assertNoDuplicate(harness, "new chat explicit confirmation");
});

test("T3: a New Chat confirmation Run cannot be adopted by reload recovery alone", async () => {
  const harness = await newChatHarness();
  const clicksBefore = harness.page.clicks;

  // The user reloads on a canonical conversation without ever pressing Resume.
  harness.setConversationKey("chatgpt:c:adopted-after-new-chat");
  await harness.reload(1_000);

  assert.equal(harness.page.clicks, clicksBefore, "reload must not silently adopt a New Chat target");
  const stored = harness.stored();
  assert.equal(stored.status, "paused");
  assert.equal(stored.pauseReason, "new-chat-confirmation-required");
  assert.equal(stored.conversationKey, NEW_CHAT_KEY, "the Run must stay bound to its unconfirmed route");
  assert.equal(stored.cursor.sendsCompleted, 0);
});

test("T3: Stop on an unconfirmed New Chat Run is terminal and no later Resume can adopt it", async () => {
  const harness = await newChatHarness();

  const stop = await harness.control("AIPM_STOP");
  await harness.settle();
  assert.equal(stop.ok, true);
  assert.equal(harness.stored().status, "stopped");

  harness.setConversationKey("chatgpt:c:adopted-after-new-chat");
  const resume = await harness.control("AIPM_RESUME");
  await harness.settle();
  assert.equal(resume.ok, false, "a stopped New Chat Run must not be adoptable");
  assert.equal(harness.page.clicks, 1, "nothing may send after Stop");
  assert.equal(harness.stored().status, "stopped");
});
