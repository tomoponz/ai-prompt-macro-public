// T1 — post-durable failure matrix.
//
// Every authoritative transition in this product is "commit durably, then observe".
// The dangerous half is what happens *after* the durable write succeeds:
//
//   1. Run durable save succeeds
//   2. the diagnostic that follows it rejects
//   3. the diagnostic that follows it never settles
//   4. the next state observation rejects
//
// Issue #30 is exactly failure (2) at Start: a diagnostic storage failure turned a
// successful Start into a reported failure while leaving a durable `running` Run behind,
// which a later reload happily executed. The invariants proven here are:
//
//   - no latent unauthorized running Run is left behind
//   - a confirmed delivery is never downgraded by an observability failure
//   - the runner is never permanently blocked by an unsettled diagnostic
//   - duplicate Send count is always 0
import test from "node:test";
import assert from "node:assert/strict";

import { clickPositions, createWorkflowHarness } from "./helpers/workflow-harness.mjs";

const DIAGNOSTICS_KEY = "aipm.diagnostics.v1";

function twoSendWorkflow() {
  return {
    schemaVersion: 1,
    id: "post-durable",
    name: "Post Durable",
    maxSends: 2,
    steps: [{ id: "repeat", type: "prompt", delivery: "send", prompt: "POST DURABLE", repeat: 2, delayAfterMs: 0 }]
  };
}

function touchesDiagnostics(key) {
  if (typeof key === "string") return key === DIAGNOSTICS_KEY;
  if (Array.isArray(key)) return key.includes(DIAGNOSTICS_KEY);
  if (key && typeof key === "object") return Object.hasOwn(key, DIAGNOSTICS_KEY);
  return false;
}

// Fault (2): every diagnostic write rejects, from the very first one.
function rejectingDiagnostics() {
  const rejections = { count: 0 };
  const fail = ({ key, entries }) => {
    if (!touchesDiagnostics(key ?? entries)) return;
    rejections.count += 1;
    throw new Error("diagnostic storage is unavailable");
  };
  return {
    rejections,
    hooks: {
      onStorageGet: fail,
      onStorageSet: fail
    }
  };
}

// Fault (3): the first diagnostic write never settles. The admission gate in
// appendPostCommitDiagnostic must then simply drop later observability events instead of
// wedging the runner behind an uncancellable storage promise.
function neverSettlingDiagnostics() {
  const state = { held: 0 };
  return {
    state,
    hooks: {
      onStorageSet: ({ entries }) => {
        if (!touchesDiagnostics(entries)) return undefined;
        state.held += 1;
        return new Promise(() => {});
      }
    }
  };
}

function assertNoDuplicateSend(harness, context) {
  const positions = clickPositions(harness);
  assert.equal(
    new Set(positions).size,
    positions.length,
    `${context}: a logical send position was clicked more than once (${positions.join(", ")})`
  );
}

test("T1: a diagnostic rejection after the durable Start leaves no latent unauthorized Run", async () => {
  const { rejections, hooks } = rejectingDiagnostics();
  const harness = createWorkflowHarness(hooks);

  const started = await harness.start(twoSendWorkflow());
  await harness.settle();

  assert.ok(rejections.count > 0, "the diagnostic path must actually have been exercised");
  assert.equal(started.ok, true, "a durably committed Start must not report failure because logging failed");
  assert.ok(started.run?.runId, "the successful Start must return the Run it committed");

  // Issue #30: the reported outcome and the durable execution authority must agree, and
  // exactly one runner must have been launched.
  const stored = harness.stored();
  assert.equal(stored.status, "completed", "the Start that reported success must actually have run");
  assert.equal(harness.page.clicks, 2);
  assert.equal(stored.cursor.sendsCompleted, 2);
  assertNoDuplicateSend(harness, "diagnostic rejection at Start");

  // A reload after the fact must not find a second, latent running Run to execute.
  await harness.reload(1_000);
  assert.equal(harness.page.clicks, 2, "reload must not resurrect a Run that already completed");
});

test("T1: a diagnostic rejection never downgrades a confirmed delivery", async () => {
  let armed = true;
  let confirmedSeen = false;
  const rejections = { count: 0 };
  const failAfterConfirmed = ({ key, entries }) => {
    if (!confirmedSeen || !touchesDiagnostics(key ?? entries)) return;
    rejections.count += 1;
    throw new Error("diagnostic storage is unavailable");
  };

  const harness = createWorkflowHarness({
    onStorageGet: failAfterConfirmed,
    onStorageSet: failAfterConfirmed,
    onSave({ run }) {
      if (!armed || run.outbox?.state !== "confirmed") return;
      armed = false;
      confirmedSeen = true;
    }
  });

  await harness.start(twoSendWorkflow());
  await harness.settle();

  assert.equal(armed, false, "a confirmed outbox must have been persisted");
  assert.ok(rejections.count > 0, "the diagnostic after the confirmed commit must have failed");

  const confirmedSave = harness.saves().find((save) => save.outbox?.state === "confirmed");
  assert.ok(confirmedSave, "delivery certainty must be durable before any diagnostic runs");
  const stored = harness.stored();
  assert.equal(stored.status, "completed", "a confirmed delivery must not be demoted to ambiguous");
  assert.equal(stored.lastErrorCode, null);
  assert.equal(stored.cursor.sendsCompleted, 2, "each confirmed send must be committed exactly once");
  assert.equal(harness.page.clicks, 2);
  assertNoDuplicateSend(harness, "diagnostic rejection after confirmed");
});

test("T1: a diagnostic that never settles cannot block the runner", async () => {
  const { state, hooks } = neverSettlingDiagnostics();
  const harness = createWorkflowHarness(hooks);

  await harness.start(twoSendWorkflow());
  await harness.settle();

  assert.equal(state.held, 1, "exactly one unsettled diagnostic write may be admitted at a time");
  const stored = harness.stored();
  assert.equal(stored.status, "completed", "an unsettled observability write must not stall execution");
  assert.equal(harness.page.clicks, 2);
  assert.equal(stored.cursor.sendsCompleted, 2);
  assertNoDuplicateSend(harness, "never-settling diagnostic");
});

test("T1: a diagnostic rejection during Pause keeps the durable Pause authoritative", async () => {
  let armed = true;
  let failing = false;
  const fail = ({ key, entries }) => {
    if (!failing || !touchesDiagnostics(key ?? entries)) return;
    throw new Error("diagnostic storage is unavailable");
  };
  let harness;
  harness = createWorkflowHarness({
    onStorageGet: fail,
    onStorageSet: fail,
    async onSave({ run }) {
      if (!armed || run.phase !== "prepared" || run.outbox?.state !== "prepared") return;
      armed = false;
      failing = true;
      const pause = await harness.control("AIPM_PAUSE");
      assert.equal(pause.ok, true, "a durable Pause must succeed even when its diagnostic cannot be written");
    }
  });

  await harness.start(twoSendWorkflow());
  await harness.settle();

  assert.equal(armed, false);
  assert.equal(harness.page.clicks, 0, "Pause before the click must add no click");
  const stored = harness.stored();
  assert.equal(stored.status, "paused");
  assert.equal(stored.pauseReason, "user-pause");
  assert.equal(stored.resumable, true, "a losing diagnostic must not weaken the Pause into an ambiguous state");
  assert.equal(stored.outbox, null, "a provably unclicked preparation is discarded on Pause");
  assert.equal(stored.cursor.sendsCompleted, 0);
});

test("T1: the next state observation rejecting after a durable save never duplicates or downgrades", async () => {
  for (const targetOutbox of ["prepared", "submitted", "confirmed"]) {
    let armed = true;
    let rejectNextObservation = false;
    let rejections = 0;

    const harness = createWorkflowHarness({
      onSave({ run }) {
        if (!armed || run.outbox?.state !== targetOutbox) return;
        armed = false;
        rejectNextObservation = true;
      },
      onRunGet() {
        if (!rejectNextObservation) return null;
        rejectNextObservation = false;
        rejections += 1;
        throw new Error("Run observation transport failed");
      }
    });

    await harness.start(twoSendWorkflow());
    await harness.settle();

    const context = `observation rejection after outbox=${targetOutbox}`;
    assert.equal(armed, false, `${context}: the durable checkpoint must be reachable`);
    assert.equal(rejections, 1, `${context}: exactly one observation must have failed`);

    const stored = harness.stored();
    assertNoDuplicateSend(harness, context);
    assert.ok(harness.page.clicks <= 2, `${context}: the planned send budget must hold`);
    assert.ok(
      stored.cursor.sendsCompleted <= stored.workflow.maxSends,
      `${context}: sendsCompleted must never exceed maxSends`
    );

    if (targetOutbox === "confirmed") {
      // Delivery certainty is monotonic: a failed observation may leave the Run paused, but
      // it must not rewrite an already-confirmed outbox into an unconfirmed one.
      const outbox = stored.outbox;
      assert.ok(
        outbox == null || outbox.state === "confirmed",
        `${context}: a confirmed outbox must not be downgraded (saw ${outbox?.state})`
      );
    }
    if (stored.status === "paused") {
      assert.ok(stored.lastErrorCode, `${context}: a paused Run must record why it stopped`);
    }

    // Recovery after the transport recovers must still not duplicate the delivery.
    await harness.reload(1_000);
    assertNoDuplicateSend(harness, `${context} after reload`);
    assert.ok(harness.page.clicks <= 2, `${context} after reload: the planned send budget must hold`);
  }
});

test("T1: a diagnostic rejection at every durable checkpoint still sends each position once", async () => {
  // Sweep the fault across every durable write of a two-send Run, not just the first one.
  for (let checkpoint = 1; checkpoint <= 14; checkpoint += 1) {
    let saves = 0;
    let failing = false;
    let observed = 0;
    const fail = ({ key, entries }) => {
      if (!failing || !touchesDiagnostics(key ?? entries)) return;
      throw new Error("diagnostic storage is unavailable");
    };
    const harness = createWorkflowHarness({
      onStorageGet: fail,
      onStorageSet: fail,
      onSave() {
        saves += 1;
        if (saves === checkpoint) {
          failing = true;
          observed = saves;
        }
      }
    });

    await harness.start(twoSendWorkflow());
    await harness.settle();

    const context = `diagnostic rejection after durable save #${checkpoint}`;
    if (observed === 0) continue; // fewer durable writes than the sweep length
    assertNoDuplicateSend(harness, context);
    assert.ok(harness.page.clicks <= 2, `${context}: ${harness.page.clicks} clicks exceeded the plan`);
    const stored = harness.stored();
    assert.ok(
      ["completed", "paused", "running", "stopped"].includes(stored.status),
      `${context}: unexpected status ${stored.status}`
    );
    assert.ok(
      stored.cursor.sendsCompleted <= stored.workflow.maxSends,
      `${context}: sendsCompleted must never exceed maxSends`
    );
  }
});
