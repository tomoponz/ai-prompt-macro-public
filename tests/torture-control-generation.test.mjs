// T8 — Stop monotonicity, and T9 — stale control generation.
//
// Issue #26 (a stale Side Panel control intent rebinding to a replacement Run) and
// Issue #31 (a Stop lost across reload before durable persistence) are both "the control
// the user authorized is not the control that executes" bugs. Both are relay-level
// properties, so this suite drives the real Service Worker.
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SESSION_ID,
  EXTENSION_VERSION,
  activeRunKey,
  deferred,
  installBackgroundHarness,
  makeRun
} from "./helpers/background-harness.mjs";

const harness = await installBackgroundHarness();

function tabFor(tabId) {
  return { id: tabId, active: true, windowId: 1, url: "https://chatgpt.com/" };
}

function useTab(tabId) {
  harness.setTabs([tabFor(tabId)]);
  harness.setDocument(tabId, { documentId: `document-${tabId}`, documentInstanceId: `instance-${tabId}` });
  harness.setStatusResponder(tabId, () => ({
    ...harness.defaultStatus(tabId),
    run: harness.storedRun(tabId)
  }));
  return tabId;
}

function controlPayload(type, run, overrides = {}) {
  return {
    type,
    expectedRunId: run?.runId ?? null,
    expectedStateRevision: run?.stateRevision ?? null,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// T9 — stale control generation
// ---------------------------------------------------------------------------

test("T9: a held Resume(A) cannot be rebound to replacement Run B", async () => {
  const tabId = useTab(910);
  const runA = makeRun({
    runId: "run-A",
    boundTabId: tabId,
    status: "paused",
    phase: "checkpoint",
    pauseReason: "manual-checkpoint",
    stateRevision: 7
  });
  harness.putRun(tabId, runA);

  // Hold the Resume(A) relay inside its status preflight, exactly where a slow Service
  // Worker would sit while the user keeps clicking.
  const gate = deferred();
  let held = false;
  harness.setStatusResponder(tabId, async () => {
    if (!held) {
      held = true;
      await gate.promise;
    }
    return { ...harness.defaultStatus(tabId), run: harness.storedRun(tabId) };
  });

  const resumeA = harness.relay(controlPayload("AIPM_RESUME", runA), tabId);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(held, true, "the Resume relay must actually be parked in its preflight");

  // While Resume(A) is parked: A is stopped and replacement Run B is started and reaches
  // its own manual checkpoint.
  const runB = makeRun({
    runId: "run-B",
    boundTabId: tabId,
    status: "paused",
    phase: "checkpoint",
    pauseReason: "manual-checkpoint",
    stateRevision: 2
  });
  harness.putRun(tabId, runB);

  const deliveredBefore = harness.commandsDelivered(tabId).length;
  gate.resolve();
  const response = await resumeA;

  assert.equal(response.ok, false, "a Resume authorized for Run A must not execute against Run B");
  assert.equal(response.relayErrorCode, "STALE_CONTROL_INTENT");
  assert.equal(
    harness.commandsDelivered(tabId).length,
    deliveredBefore,
    "no control command may reach the content script for the wrong Run generation"
  );
  assert.equal(harness.storedRun(tabId).runId, "run-B");
  assert.equal(harness.storedRun(tabId).status, "paused", "Run B must stay paused at its own checkpoint");
});

test("T9: the same generation replacement is refused for Pause as well as Resume", async () => {
  for (const type of ["AIPM_PAUSE", "AIPM_RESUME"]) {
    const tabId = useTab(type === "AIPM_PAUSE" ? 911 : 912);
    const runA = makeRun({ runId: `${type}-A`, boundTabId: tabId, stateRevision: 4 });
    harness.putRun(tabId, runA);

    const gate = deferred();
    let held = false;
    harness.setStatusResponder(tabId, async () => {
      if (!held) {
        held = true;
        await gate.promise;
      }
      return { ...harness.defaultStatus(tabId), run: harness.storedRun(tabId) };
    });

    const pending = harness.relay(controlPayload(type, runA), tabId);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const runB = makeRun({ runId: `${type}-B`, boundTabId: tabId, stateRevision: 1 });
    harness.putRun(tabId, runB);
    const deliveredBefore = harness.commandsDelivered(tabId).length;
    gate.resolve();
    const response = await pending;

    assert.equal(response.ok, false, `${type}: a stale control intent must not act on the replacement Run`);
    assert.equal(response.relayErrorCode, "STALE_CONTROL_INTENT");
    assert.equal(
      harness.commandsDelivered(tabId).length,
      deliveredBefore,
      `${type}: nothing may be delivered for the wrong Run generation`
    );
    assert.equal(harness.storedRun(tabId).runId, `${type}-B`);
    assert.equal(harness.storedRun(tabId).status, "running", `${type}: Run B must be untouched`);
  }
});

// Stop deliberately takes the other route: it is a monotonic revoke committed to the exact
// user-observed Run *before* any document contact (Issue #31), so it cannot be lost by a
// reload racing the handler. The generation property it must hold is that the commit and
// the delivered cleanup both stay bound to Run A even if the tab has moved on.
test("T9: a held Stop(A) commits to exactly Run A and never renames itself to Run B", async () => {
  const tabId = useTab(917);
  const runA = makeRun({ runId: "stop-gen-A", boundTabId: tabId, stateRevision: 6 });
  harness.putRun(tabId, runA);

  const gate = deferred();
  let held = false;
  harness.setStatusResponder(tabId, async () => {
    if (!held) {
      held = true;
      await gate.promise;
    }
    return { ...harness.defaultStatus(tabId), run: harness.storedRun(tabId) };
  });

  const stopA = harness.relay(controlPayload("AIPM_STOP", runA), tabId);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(held, true, "the Stop relay must be parked in its document preflight");
  assert.equal(
    harness.storedRun(tabId).status,
    "stopped",
    "Stop must already be durable before any document contact, so a reload cannot lose it"
  );

  // A replacement Run B now exists in the same tab.
  const runB = makeRun({ runId: "stop-gen-B", boundTabId: tabId, stateRevision: 1 });
  harness.putRun(tabId, runB);
  gate.resolve();
  const response = await stopA;

  assert.equal(response.ok, true);
  assert.equal(response.stopCommitted, true);
  assert.equal(response.run.runId, "stop-gen-A", "the committed Stop must name the Run the user saw");
  const delivered = harness.commandsDelivered(tabId).at(-1);
  assert.equal(delivered.payload.type, "AIPM_STOP");
  assert.equal(delivered.payload.expectedRunId, "stop-gen-A", "cleanup must stay bound to Run A");
  assert.equal(harness.storedRun(tabId).runId, "stop-gen-B");
  assert.equal(harness.storedRun(tabId).status, "running", "Run B must not be stopped by Run A's intent");
});

test("T9: a control intent for the right Run but a stale revision is refused", async () => {
  const tabId = useTab(913);
  const run = makeRun({ runId: "run-revision", boundTabId: tabId, status: "paused", stateRevision: 9 });
  harness.putRun(tabId, run);

  const deliveredBefore = harness.commandsDelivered(tabId).length;
  const response = await harness.relay(
    controlPayload("AIPM_RESUME", run, { expectedStateRevision: 8 }),
    tabId
  );

  assert.equal(response.ok, false);
  assert.equal(response.relayErrorCode, "STALE_CONTROL_INTENT");
  assert.equal(harness.commandsDelivered(tabId).length, deliveredBefore);
});

test("T9: a control intent with no revision at all is refused for Pause and Resume", async () => {
  for (const type of ["AIPM_PAUSE", "AIPM_RESUME"]) {
    const tabId = useTab(type === "AIPM_PAUSE" ? 914 : 915);
    const run = makeRun({ runId: `${type}-norev`, boundTabId: tabId, status: "paused", stateRevision: 3 });
    harness.putRun(tabId, run);

    const deliveredBefore = harness.commandsDelivered(tabId).length;
    const response = await harness.relay({ type, expectedRunId: run.runId }, tabId);

    assert.equal(response.ok, false, `${type}: a missing revision must not be treated as "any revision"`);
    assert.equal(response.relayErrorCode, "STALE_CONTROL_INTENT");
    assert.equal(harness.commandsDelivered(tabId).length, deliveredBefore);
  }
});

test("T9: the delivered control carries the caller's Run id, never the preflight's", async () => {
  const tabId = useTab(916);
  const run = makeRun({ runId: "run-exact", boundTabId: tabId, status: "paused", stateRevision: 5 });
  harness.putRun(tabId, run);

  const response = await harness.relay(controlPayload("AIPM_RESUME", run), tabId);
  assert.equal(response.ok, true);

  const delivered = harness.commandsDelivered(tabId).at(-1);
  assert.equal(delivered.payload.type, "AIPM_RESUME");
  assert.equal(delivered.payload.expectedRunId, "run-exact", "background must not overwrite caller authority");
  assert.equal(delivered.payload.expectedStateRevision, 5);
});

// ---------------------------------------------------------------------------
// T8 — Stop monotonicity
// ---------------------------------------------------------------------------

test("T8: Stop is durable before any document contact, so a failed contact cannot lose it", async () => {
  const cases = [
    {
      name: "content unreachable",
      arrange: (tabId) => {
        harness.setStatusResponder(tabId, () => { throw new Error("Could not establish connection."); });
        harness.setContentProbe(tabId, { origin: null, corePresent: false, controllerReady: false, version: null });
      }
    },
    {
      name: "document replaced during Stop",
      arrange: (tabId) => {
        harness.setIdentityPlan(tabId, [
          { documentInstanceId: `instance-${tabId}`, documentId: `document-${tabId}` },
          { documentInstanceId: "instance-after-reload", documentId: "document-after-reload" },
          { documentInstanceId: "instance-after-reload", documentId: "document-after-reload" },
          { documentInstanceId: "instance-after-reload", documentId: "document-after-reload" }
        ]);
      }
    },
    {
      name: "document identity unavailable during Stop",
      arrange: (tabId) => {
        harness.setIdentityPlan(tabId, [
          { documentInstanceId: `instance-${tabId}`, documentId: `document-${tabId}` },
          { error: new Error("executeScript blocked") },
          { error: new Error("executeScript blocked") },
          { error: new Error("executeScript blocked") }
        ]);
      }
    },
    {
      name: "command delivery rejected",
      arrange: (tabId) => {
        harness.setCommandResponder(tabId, () => { throw new Error("Message port closed"); });
      }
    }
  ];

  let tabId = 920;
  for (const scenario of cases) {
    tabId += 1;
    useTab(tabId);
    const run = makeRun({ runId: `stop-${tabId}`, boundTabId: tabId, stateRevision: 2 });
    harness.putRun(tabId, run);
    scenario.arrange(tabId);

    const response = await harness.relay(controlPayload("AIPM_STOP", run), tabId);

    const context = `Stop with ${scenario.name}`;
    assert.equal(response.ok, true, `${context}: Stop must report success once it is durable`);
    assert.equal(response.stopCommitted, true, `${context}: Stop must be reported as committed`);
    const stored = harness.storedRun(tabId);
    assert.equal(stored.status, "stopped", `${context}: the durable Run must be terminal`);
    assert.equal(stored.phase, "stopped");
    assert.equal(stored.pauseReason, "user-stop");
    assert.equal(stored.waitState, null, `${context}: a stopped Run must not keep a pending wait`);
  }
});

test("T8: a Stop whose cleanup delivery times out is still durable and is never retried", async () => {
  const tabId = useTab(930);
  const run = makeRun({ runId: "stop-timeout", boundTabId: tabId, stateRevision: 2 });
  harness.putRun(tabId, run);
  harness.setCommandResponder(tabId, () => new Promise(() => {}));

  const response = await harness.relay(controlPayload("AIPM_STOP", run), tabId);

  assert.equal(response.ok, true);
  assert.equal(response.stopCommitted, true);
  assert.equal(response.cleanupDelivered, false, "an unacknowledged cleanup must not be reported as delivered");
  assert.equal(harness.storedRun(tabId).status, "stopped");
  assert.equal(
    harness.commandsDelivered(tabId).length,
    1,
    "an ambiguous cleanup delivery must never be automatically retried"
  );
});

test("T8: after Stop reaches the exact Run, no later runner write can revive it", async () => {
  const tabId = useTab(931);
  const run = makeRun({ runId: "stop-monotonic", boundTabId: tabId, stateRevision: 2 });
  harness.putRun(tabId, run);

  const stopped = await harness.relay(controlPayload("AIPM_STOP", run), tabId);
  assert.equal(stopped.stopCommitted, true);

  const sender = {
    tab: { id: tabId },
    documentId: `document-${tabId}`
  };
  // A content script that never saw the Stop tries to keep going.
  for (const attempt of [
    { ...run, status: "running", phase: "ready", stateRevision: 2 },
    { ...run, status: "running", phase: "submitting", outbox: { id: "o1", state: "prepared" }, stateRevision: 3 },
    { ...run, status: "paused", phase: "paused", stateRevision: 3 },
    { ...run, status: "completed", phase: "completed", stateRevision: 3 }
  ]) {
    const response = await harness.invoke({
      type: "AIPM_RUN_SET",
      run: attempt,
      runTransition: "runner",
      conversationKey: run.conversationKey,
      documentInstanceId: `instance-${tabId}`
    }, sender);
    assert.equal(response.ok, false, `a stale runner write (${attempt.status}/${attempt.phase}) must be refused`);
    assert.equal(harness.storedRun(tabId).status, "stopped", "the terminal Stop must stay terminal");
  }
});

test("T8: a Stop naming a Run that already changed is refused and touches nothing", async () => {
  const tabId = useTab(932);
  const live = makeRun({ runId: "live-run", boundTabId: tabId, stateRevision: 4 });
  harness.putRun(tabId, live);

  const response = await harness.relay(
    { type: "AIPM_STOP", expectedRunId: "a-run-that-is-gone" },
    tabId
  );

  assert.equal(response.ok, false);
  assert.equal(response.relayErrorCode, "STALE_CONTROL_INTENT");
  assert.equal(harness.storedRun(tabId).status, "running", "an unrelated Run must not be stopped");
  assert.equal(harness.storedRun(tabId).stateRevision, 4, "a refused Stop must not bump the revision");
});

test("T8: a Stop with no expected Run id is refused before any durable write", async () => {
  const tabId = useTab(933);
  const live = makeRun({ runId: "unnamed-stop", boundTabId: tabId, stateRevision: 4 });
  harness.putRun(tabId, live);

  const response = await harness.relay({ type: "AIPM_STOP" }, tabId);
  assert.equal(response.ok, false);
  assert.equal(response.relayErrorCode, "STALE_CONTROL_INTENT");
  assert.equal(harness.storedRun(tabId).status, "running");
});

test("T8: Stop revokes the pending Wait Until schedule so a later alarm cannot authorize a Wait", async () => {
  const tabId = useTab(934);
  const run = makeRun({
    runId: "stop-schedule",
    boundTabId: tabId,
    phase: "waiting-time",
    waitState: { kind: "wait-until", stepId: "w1", scheduledAt: Date.now() + 60_000, armedAt: Date.now() },
    stateRevision: 3
  });
  harness.putRun(tabId, run);

  const armed = await harness.invoke({
    type: "AIPM_ARM_ALARM",
    runId: run.runId,
    stepId: "w1",
    whenMs: Date.now() + 60_000,
    serviceWorkerVersion: EXTENSION_VERSION,
    executionSessionId: DEFAULT_SESSION_ID
  }, { tab: { id: tabId } });
  assert.equal(armed.ok, true);
  assert.equal(Object.keys(harness.schedules()).some((name) => name.includes("stop-schedule")), true);

  const response = await harness.relay(controlPayload("AIPM_STOP", run), tabId);
  assert.equal(response.stopCommitted, true);
  assert.equal(harness.storedRun(tabId).status, "stopped");
  assert.equal(harness.storedRun(tabId).waitState, null);
  assert.equal(
    Object.keys(harness.schedules()).some((name) => name.includes("stop-schedule")),
    false,
    "a stopped Run must not keep an armed schedule that could later wake a Wait"
  );
});

test("T8: Stop is committed even when the durable schedule cleanup fails", async () => {
  const tabId = useTab(935);
  const run = makeRun({ runId: "stop-cleanup-fail", boundTabId: tabId, stateRevision: 3 });
  harness.putRun(tabId, run);

  const realClear = globalThis.chrome.alarms.clear;
  globalThis.chrome.alarms.clear = async () => { throw new Error("alarm store unavailable"); };
  harness.storageData["aipm.schedules.v1"] = {
    [`aipm.wait.${encodeURIComponent(run.runId)}.w1`]: {
      runId: run.runId,
      stepId: "w1",
      whenMs: Date.now() + 60_000,
      tabId,
      executionSessionId: DEFAULT_SESSION_ID,
      armedAt: Date.now()
    }
  };
  try {
    const response = await harness.relay(controlPayload("AIPM_STOP", run), tabId);
    assert.equal(response.ok, true);
    assert.equal(response.stopCommitted, true);
    assert.equal(response.scheduleCleanupFailed, true, "the caller must be told cleanup did not complete");
  } finally {
    globalThis.chrome.alarms.clear = realClear;
  }

  // The terminal Run state is the execution authority: a failed best-effort cleanup can
  // never make recovery executable again.
  const stored = harness.storedRun(tabId);
  assert.equal(stored.status, "stopped");
  assert.equal(stored.waitState, null);
  assert.equal(
    stored.executionSessionId,
    DEFAULT_SESSION_ID,
    "the stopped Run must stay bound to this browser session"
  );
});

test("T8: a stopped Run offers no Send authority to a fresh read", async () => {
  const tabId = useTab(936);
  const run = makeRun({ runId: "stop-then-read", boundTabId: tabId, stateRevision: 2 });
  harness.putRun(tabId, run);
  await harness.relay(controlPayload("AIPM_STOP", run), tabId);

  const read = await harness.invoke({
    type: "AIPM_RUN_GET",
    conversationKey: run.conversationKey,
    documentInstanceId: `instance-${tabId}`
  }, { tab: { id: tabId }, documentId: `document-${tabId}` });

  assert.equal(read.ok, true);
  assert.equal(read.run.status, "stopped", "recovery must observe the terminal Stop");
  assert.equal(read.run.runId, run.runId);
  assert.equal(harness.storageData[activeRunKey(tabId)].status, "stopped");
});
