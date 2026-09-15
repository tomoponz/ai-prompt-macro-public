// T7 — alarm and stale-signal torture.
//
// Issue #29: schedule and wake-signal identity used to be only `(runId, stepId)`, step ids
// were not required to be unique, and alarm cleanup ignored an explicit `{ ok: false }`.
// Together, a partial storage failure plus an id collision let one Wait Until's wake signal
// authorize a *different, still-future* Wait Until, and the Prompt behind it ran early.
//
// The invariant proven here is blunt: an old signal must never authorize a new Wait.
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SESSION_ID,
  EXTENSION_VERSION,
  alarmName,
  installBackgroundHarness
} from "./helpers/background-harness.mjs";
import { createWorkflowHarness } from "./helpers/workflow-harness.mjs";
import { normalizeWorkflow } from "../src/workflow.js";

const harness = await installBackgroundHarness();

const CLOCK_START = 1_700_000_000_000;

function armMessage(runId, stepId, whenMs, overrides = {}) {
  return {
    type: "AIPM_ARM_ALARM",
    runId,
    stepId,
    whenMs,
    serviceWorkerVersion: EXTENSION_VERSION,
    executionSessionId: DEFAULT_SESSION_ID,
    ...overrides
  };
}

function signalMessage(runId, stepId, overrides = {}) {
  return {
    type: "AIPM_GET_ALARM_SIGNAL",
    runId,
    stepId,
    serviceWorkerVersion: EXTENSION_VERSION,
    executionSessionId: DEFAULT_SESSION_ID,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Duplicate and malformed step ids
// ---------------------------------------------------------------------------

test("T7: duplicate step ids are rejected by the authoring normalizer", () => {
  assert.throws(() => normalizeWorkflow({
    schemaVersion: 1,
    maxSends: 1,
    steps: [
      { id: "dup", type: "wait-until", at: new Date(CLOCK_START).toISOString(), latePolicy: "run", graceMs: 0 },
      { id: "dup", type: "wait-until", at: new Date(CLOCK_START + 1).toISOString(), latePolicy: "run", graceMs: 0 },
      { id: "send", type: "prompt", delivery: "send", prompt: "P", repeat: 1, delayAfterMs: 0 }
    ]
  }), /重複/);
  // Ids that sanitize to the same value collide too, and must be rejected the same way.
  assert.throws(() => normalizeWorkflow({
    schemaVersion: 1,
    maxSends: 1,
    steps: [
      { id: "Wait One", type: "delay", durationMs: 1 },
      { id: "wait-one", type: "delay", durationMs: 1 },
      { id: "send", type: "prompt", delivery: "send", prompt: "P", repeat: 1, delayAfterMs: 0 }
    ]
  }), /重複/);
});

test("T7: the content runtime refuses to Start a workflow with duplicate step ids", async () => {
  const content = createWorkflowHarness();
  const started = await content.start({
    schemaVersion: 1,
    id: "dup-start",
    name: "Duplicate ids",
    maxSends: 1,
    steps: [
      { id: "dup", type: "delay", durationMs: 1 },
      { id: "dup", type: "delay", durationMs: 1 },
      { id: "send", type: "prompt", delivery: "send", prompt: "P", repeat: 1, delayAfterMs: 0 }
    ]
  });
  await content.settle();

  assert.equal(started.ok, false, "the execution boundary must not accept colliding step identities");
  assert.equal(content.stored(), null, "no durable Run may be created");
  assert.equal(content.page.clicks, 0);
});

test("T7: a recovered durable workflow with duplicate or malformed step ids cannot send", async () => {
  for (const [label, brokenIds] of [
    ["duplicate", ["dup", "dup"]],
    ["empty", ["", "wait-b"]],
    ["non-string", [7, "wait-b"]]
  ]) {
    const content = createWorkflowHarness();
    await content.start({
      schemaVersion: 1,
      id: "recover-ids",
      name: "Recover ids",
      maxSends: 1,
      steps: [
        { id: "wait-a", type: "delay", durationMs: 60_000 },
        { id: "wait-b", type: "delay", durationMs: 60_000 },
        { id: "send", type: "prompt", delivery: "send", prompt: "P", repeat: 1, delayAfterMs: 0 }
      ]
    });
    // Corrupt the durable workflow the way stale/hand-edited storage would, then reload.
    content.injectDurableRun((run) => {
      const next = structuredClone(run);
      next.workflow.steps[0].id = brokenIds[0];
      next.workflow.steps[1].id = brokenIds[1];
      next.cursor = { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 };
      next.status = "running";
      next.phase = "ready";
      next.waitState = null;
      return next;
    });
    content.context.localRunnerToken += 1;
    await content.settle();
    await content.reload(1_000);

    const context = `recovered workflow with ${label} step ids`;
    assert.equal(content.page.clicks, 0, `${context}: a workflow that cannot be identified must not send`);
    const stored = content.stored();
    assert.notEqual(stored.status, "completed", `${context}: such a Run must not claim completion`);
    assert.equal(stored.lastErrorCode, "workflow_invalid", `${context}: it must fail closed with a bounded code`);
    assert.equal(stored.resumable, false, `${context}: it must not be auto-resumable`);
  }
});

// ---------------------------------------------------------------------------
// Cleanup failure must block the cursor, not be treated as success
// ---------------------------------------------------------------------------

function scheduleThenSendWorkflow() {
  return {
    schemaVersion: 1,
    id: "alarm-cleanup",
    name: "Alarm Cleanup",
    maxSends: 1,
    steps: [
      {
        id: "wait",
        type: "wait-until",
        at: new Date(CLOCK_START - 1_000).toISOString(),
        latePolicy: "run",
        graceMs: 5 * 60 * 1000
      },
      { id: "send", type: "prompt", delivery: "send", prompt: "AFTER WAIT", repeat: 1, delayAfterMs: 0 }
    ]
  };
}

test("T7: an alarm cleanup that answers ok:false blocks the cursor instead of advancing it", async () => {
  const content = createWorkflowHarness({
    onAlarm: ({ operation }) => (operation === "clear_alarm"
      ? { ok: false, error: "schedule cleanup could not be persisted" }
      : null)
  });
  await content.start(scheduleThenSendWorkflow());
  await content.settle();

  assert.equal(content.page.clicks, 0, "an unconfirmed schedule cleanup must not release the following Send");
  const stored = content.stored();
  assert.equal(stored.status, "paused");
  assert.equal(stored.lastErrorCode, "alarm_failed");
  assert.equal(stored.cursor.stepIndex, 0, "the cursor must not advance past the uncleaned Wait");
});

test("T7: an alarm cleanup whose transport rejects blocks the cursor the same way", async () => {
  const content = createWorkflowHarness({
    onAlarm: ({ operation }) => {
      if (operation !== "clear_alarm") return null;
      throw new Error("alarm cleanup transport failed");
    }
  });
  await content.start(scheduleThenSendWorkflow());
  await content.settle();

  assert.equal(content.page.clicks, 0);
  const stored = content.stored();
  assert.equal(stored.status, "paused");
  assert.equal(stored.lastErrorCode, "alarm_failed");
  assert.equal(stored.cursor.stepIndex, 0);
});

// ---------------------------------------------------------------------------
// Stale signal must not authorize a new Wait
// ---------------------------------------------------------------------------

test("T7: a wake signal for a different scheduled time never satisfies the current Wait", async () => {
  const futureAt = new Date(CLOCK_START + 60 * 60 * 1000).toISOString();
  let signalReads = 0;
  const content = createWorkflowHarness({
    onAlarm: ({ operation }) => {
      if (operation !== "get_alarm_signal") return null;
      signalReads += 1;
      // A leftover signal from an earlier Wait that shared this step id.
      return {
        ok: true,
        signal: {
          runId: content.stored()?.runId ?? null,
          stepId: "wait",
          scheduledAt: CLOCK_START - 3_600_000,
          firedAt: CLOCK_START - 3_600_000,
          executionSessionId: "session-block-workflow"
        }
      };
    }
  });

  await content.start({
    schemaVersion: 1,
    id: "stale-signal",
    name: "Stale Signal",
    maxSends: 1,
    steps: [
      { id: "wait", type: "wait-until", at: futureAt, latePolicy: "run", graceMs: 0 },
      { id: "send", type: "prompt", delivery: "send", prompt: "AFTER WAIT", repeat: 1, delayAfterMs: 0 }
    ]
  });

  // Give the runner real time to consume the stale signal several times.
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.ok(signalReads >= 1, "the stale signal must actually have been offered to the runner");
  assert.equal(content.page.clicks, 0, "an old signal must never release a still-future Wait");
  assert.equal(content.stored().phase, "waiting-time", "the Run must still be waiting for its own deadline");
  assert.equal(content.stored().cursor.stepIndex, 0);

  const stop = await content.control("AIPM_STOP");
  await content.settle();
  assert.equal(stop.ok, true);
  assert.equal(content.page.clicks, 0);
});

test("T7: a wake signal for the exact scheduled time does release the Wait", async () => {
  const scheduledAt = CLOCK_START + 60 * 60 * 1000;
  const content = createWorkflowHarness({
    onAlarm: ({ operation, storedRun }) => {
      if (operation !== "get_alarm_signal") return null;
      return {
        ok: true,
        signal: {
          runId: storedRun?.runId ?? null,
          stepId: "wait",
          scheduledAt,
          firedAt: scheduledAt,
          executionSessionId: "session-block-workflow"
        }
      };
    }
  });

  await content.start({
    schemaVersion: 1,
    id: "exact-signal",
    name: "Exact Signal",
    maxSends: 1,
    steps: [
      { id: "wait", type: "wait-until", at: new Date(scheduledAt).toISOString(), latePolicy: "run", graceMs: 0 },
      { id: "send", type: "prompt", delivery: "send", prompt: "AFTER WAIT", repeat: 1, delayAfterMs: 0 }
    ]
  });
  await content.settle();

  assert.equal(content.page.clicks, 1, "the matching signal is the one that authorizes the Wait");
  assert.equal(content.stored().status, "completed");
});

// ---------------------------------------------------------------------------
// Background: signal storage identity
// ---------------------------------------------------------------------------

test("T7: re-arming the same logical step clears the stale persisted signal first", async () => {
  const tabId = 7001;
  const runId = "rearm-run";
  const name = alarmName(runId, "dup");

  await harness.invoke(armMessage(runId, "dup", Date.now() - 1_000), { tab: { id: tabId } });
  assert.ok(harness.signals()[name], "the first schedule must fire immediately and persist a signal");
  const firstSignal = harness.signals()[name];

  // The second Wait Until with the same step id is armed for a genuinely future time.
  const futureWhen = Date.now() + 60 * 60 * 1000;
  await harness.invoke(armMessage(runId, "dup", futureWhen), { tab: { id: tabId } });

  assert.equal(
    harness.signals()[name],
    undefined,
    "arming a new schedule must remove any leftover wake signal for the same identity"
  );
  const read = await harness.invoke(signalMessage(runId, "dup"), { tab: { id: tabId } });
  assert.equal(read.signal, null, "a re-armed step must not read the previous step's wake signal");
  assert.equal(harness.schedules()[name].whenMs, futureWhen);
  assert.notEqual(firstSignal.scheduledAt, futureWhen);
});

test("T7: a persisted signal from another browser session is never returned", async () => {
  const tabId = 7002;
  const runId = "session-signal-run";
  const name = alarmName(runId, "wait");
  harness.storageData["aipm.alarmSignals.v1"] = {
    ...harness.signals(),
    [name]: {
      runId,
      stepId: "wait",
      scheduledAt: Date.now() - 1_000,
      firedAt: Date.now() - 1_000,
      executionSessionId: "a-previous-browser-session"
    }
  };

  const read = await harness.invoke(signalMessage(runId, "wait"), { tab: { id: tabId } });
  assert.equal(read.signal, null, "a wake signal from a previous browser session must not authorize a Wait");

  const foreignCaller = await harness.invoke(
    signalMessage(runId, "wait", { executionSessionId: "a-previous-browser-session" }),
    { tab: { id: tabId } }
  );
  assert.equal(foreignCaller.ok, false, "a caller from a previous browser session must be refused outright");
});

test("T7: a signal survives a reload but still carries its exact scheduled time", async () => {
  const tabId = 7003;
  const runId = "reload-signal-run";
  const scheduledAt = Date.now() - 5_000;
  await harness.invoke(armMessage(runId, "wait", scheduledAt), { tab: { id: tabId } });

  const name = alarmName(runId, "wait");
  assert.ok(harness.signals()[name], "an already-due schedule fires immediately");

  // "Reload" is just a new content document asking the same question.
  const read = await harness.invoke(signalMessage(runId, "wait"), { tab: { id: tabId } });
  assert.equal(read.signal.scheduledAt, scheduledAt, "the signal must name the exact deadline it belongs to");
  assert.ok(Number.isFinite(read.signal.firedAt));
  assert.equal(read.signal.executionSessionId, DEFAULT_SESSION_ID);
});

test("T7: a schedule cleanup whose durable write fails answers ok:false rather than pretending", async () => {
  const tabId = 7004;
  const runId = "cleanup-fail-run";
  await harness.invoke(armMessage(runId, "wait", Date.now() + 60_000), { tab: { id: tabId } });
  const name = alarmName(runId, "wait");
  assert.ok(harness.schedules()[name]);

  harness.setStorageSetFault((values) => {
    if (Object.hasOwn(values, "aipm.schedules.v1")) throw new Error("schedule store unavailable");
  });
  let response;
  try {
    response = await harness.invoke({
      type: "AIPM_CLEAR_ALARM",
      runId,
      stepId: "wait",
      serviceWorkerVersion: EXTENSION_VERSION,
      executionSessionId: DEFAULT_SESSION_ID
    }, { tab: { id: tabId } });
  } finally {
    harness.setStorageSetFault(null);
  }

  assert.equal(response.ok, false, "a cleanup that could not be persisted must not be reported as done");
  assert.ok(harness.schedules()[name], "the stale schedule really is still there, which is why ok:false matters");
});

test("T7: a malformed arm request is refused and arms nothing", async () => {
  const tabId = 7005;
  for (const bad of [
    { runId: "", stepId: "wait", whenMs: Date.now() + 1_000 },
    { runId: "ok", stepId: "", whenMs: Date.now() + 1_000 },
    { runId: "ok", stepId: "wait", whenMs: Number.NaN },
    { runId: "ok", stepId: "wait", whenMs: "soon" },
    { runId: "ok", stepId: "wait", whenMs: undefined }
  ]) {
    const before = Object.keys(harness.schedules()).length;
    const response = await harness.invoke(
      armMessage(bad.runId, bad.stepId, bad.whenMs),
      { tab: { id: tabId } }
    );
    assert.equal(response.ok, false, `${JSON.stringify(bad)}: a malformed schedule must be refused`);
    assert.equal(
      Object.keys(harness.schedules()).length,
      before,
      `${JSON.stringify(bad)}: a refused schedule must not be persisted`
    );
  }
});
