// Historical Test Escape regression — one sequence, five boundaries.
//
// The escape this repository actually suffered was not a missing unit test. Every
// individual component passed, and so did the browser fixture; the real Edge session still
// failed. The reason is that the failure lived in the *seam* between boundaries:
//
//   confirmed Send -> cleanup failure -> reload -> recovery -> next Prompt
//
// Issue #27 is the cleanup half (an unconfirmed lease release self-wedging the same running
// Run on its next prompt) and Issue #30 is the observability half (a diagnostic storage
// failure leaving a latent Run). Neither is visible from a single-component test, so this
// file deliberately chains them: a confirmed send, an unconfirmed lease release, a failing
// diagnostic store, a page reload, automatic recovery, and then the next irreversible send.
import test from "node:test";
import assert from "node:assert/strict";

import { clickPositions, createWorkflowHarness, promptsSent, threePromptWorkflow } from "./helpers/workflow-harness.mjs";

const DIAGNOSTICS_KEY = "aipm.diagnostics.v1";

function repeatWorkflow(repeat = 3) {
  return {
    schemaVersion: 1,
    id: "escape",
    name: "Escape",
    maxSends: repeat,
    steps: [{ id: "escape-send", type: "prompt", delivery: "send", prompt: "ESCAPE", repeat, delayAfterMs: 1_000 }]
  };
}

function touchesDiagnostics(key) {
  if (typeof key === "string") return key === DIAGNOSTICS_KEY;
  if (Array.isArray(key)) return key.includes(DIAGNOSTICS_KEY);
  if (key && typeof key === "object") return Object.hasOwn(key, DIAGNOSTICS_KEY);
  return false;
}

function assertEachPositionOnce(harness, context) {
  const positions = clickPositions(harness);
  assert.equal(
    new Set(positions).size,
    positions.length,
    `${context}: a logical send position was clicked more than once (${positions.join(", ")})`
  );
}

for (const releaseFailure of ["reject", "ok-false"]) {
  test(`ESCAPE: confirmed Send -> lease release ${releaseFailure} -> diagnostic failure -> reload -> recovery -> next Prompt`, async () => {
    let diagnosticsFailing = false;
    let reloadArmed = true;
    let confirmedSeen = 0;
    const failDiagnostics = ({ key, entries }) => {
      if (!diagnosticsFailing || !touchesDiagnostics(key ?? entries)) return;
      throw new Error("diagnostic storage is unavailable");
    };

    let competingResult = null;
    let harness;
    harness = createWorkflowHarness({
      // Boundary 1: the cleanup right after the first confirmed send is never acknowledged.
      leaseReleaseFailure: releaseFailure,
      // Boundary 2: observability storage starts failing at the same moment.
      onStorageGet: failDiagnostics,
      onStorageSet: failDiagnostics,
      onRunGet() {
        // Boundary 4: sampled at the first read *after* the unacknowledged release, which
        // is the exact window in which the stale lease is still stored.
        if (competingResult || !harness.transcript.some((entry) => entry.type === "lease-release-failed")) {
          return null;
        }
        competingResult = harness.competingAcquire("some-other-document");
        return null;
      },
      onSave({ run, context }) {
        // `generating/confirmed` is written exactly once per delivered send, so it is the
        // unambiguous "this send is proven" event.
        if (run.outbox?.state !== "confirmed" || run.phase !== "generating") return;
        confirmedSeen += 1;
        if (confirmedSeen === 1) diagnosticsFailing = true;
        // Boundary 3: the page reloads once the second send is durably confirmed.
        if (reloadArmed && confirmedSeen === 2) {
          reloadArmed = false;
          context.localRunnerToken += 1;
        }
      }
    });

    await harness.start(repeatWorkflow(3));
    await harness.settle();

    assert.equal(reloadArmed, false, "the reload boundary must be reached");
    assert.ok(diagnosticsFailing, "the diagnostic boundary must be reached");
    const releaseFailures = harness.transcript.filter((entry) => entry.type === "lease-release-failed");
    assert.equal(releaseFailures.length, 1, "exactly one lease release must have failed");

    // The conversation lease was never confirmed released, so a competing document must
    // still have been fenced out while this Run owned it.
    assert.ok(competingResult, "the competing-acquire probe must have run inside the stale-lease window");
    assert.equal(
      competingResult.lease,
      null,
      "a competing document must not be able to seize the conversation while its owner is running"
    );

    const clicksBeforeRecovery = harness.page.clicks;
    assert.ok(clicksBeforeRecovery >= 2, `expected at least two sends before the reload, saw ${clicksBeforeRecovery}`);

    // Boundary 5: recovery adopts the durable snapshot and runs the remaining prompt.
    diagnosticsFailing = false;
    await harness.reload(2_000);

    const stored = harness.stored();
    assertEachPositionOnce(harness, `escape/${releaseFailure}`);
    assert.equal(harness.page.clicks, 3, "every planned position must send exactly once across the whole sequence");
    assert.equal(stored.status, "completed", "an unconfirmed cleanup must not permanently wedge the Run");
    assert.equal(stored.cursor.sendsCompleted, 3);
    assert.equal(stored.outbox, null);
    assert.deepEqual(promptsSent(harness), ["ESCAPE", "ESCAPE", "ESCAPE"]);
  });
}

test("ESCAPE: the same seam with a Stop landing during recovery ends terminal, never mid-send", async () => {
  let reloadArmed = true;
  const harness = createWorkflowHarness({
    leaseReleaseFailure: "reject",
    onSave({ run, context }) {
      if (!reloadArmed || run.outbox?.state !== "confirmed") return;
      reloadArmed = false;
      context.localRunnerToken += 1;
    }
  });

  await harness.start(repeatWorkflow(3));
  await harness.settle();
  assert.equal(reloadArmed, false);
  const clicksBefore = harness.page.clicks;

  const stop = await harness.control("AIPM_STOP");
  await harness.settle();
  assert.equal(stop.ok, true);

  harness.context.recoveryStarted = false;
  await harness.context.recoverIfNeeded();
  await harness.settle();

  assert.equal(harness.stored().status, "stopped", "Stop must win over the recovery that follows it");
  assert.equal(harness.page.clicks, clicksBefore, "recovery after Stop must not send");
  assertEachPositionOnce(harness, "escape + stop during recovery");
});

test("ESCAPE: a three-prompt workflow survives the same seam between two different prompts", async () => {
  // The single-step repeat above shares one step id. This variant proves the same seam
  // across genuinely different prompts, where a wrong recovery would be visible as a
  // reordered or duplicated prompt body rather than just a count.
  let diagnosticsFailing = false;
  let reloadArmed = true;
  const failDiagnostics = ({ key, entries }) => {
    if (!diagnosticsFailing || !touchesDiagnostics(key ?? entries)) return;
    throw new Error("diagnostic storage is unavailable");
  };

  const harness = createWorkflowHarness({
    leaseReleaseFailure: "ok-false",
    onStorageGet: failDiagnostics,
    onStorageSet: failDiagnostics,
    onSave({ run, context }) {
      if (run.outbox?.state === "confirmed" && run.cursor.sendsCompleted === 0) diagnosticsFailing = true;
      if (reloadArmed && run.cursor.sendsCompleted === 1 && run.phase === "delay") {
        reloadArmed = false;
        context.localRunnerToken += 1;
      }
    }
  });

  await harness.start(threePromptWorkflow());
  await harness.settle();
  assert.equal(reloadArmed, false, "the mid-workflow reload boundary must be reached");

  diagnosticsFailing = false;
  await harness.reload(5_000);

  assert.deepEqual(
    promptsSent(harness),
    ["PROMPT A", "PROMPT B", "PROMPT C"],
    "each distinct prompt must be delivered exactly once, in order"
  );
  assertEachPositionOnce(harness, "three-prompt escape seam");
  assert.equal(harness.stored().status, "completed");
  assert.equal(harness.stored().cursor.sendsCompleted, 3);
});
