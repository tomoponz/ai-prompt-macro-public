import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const controllerSource = fs.readFileSync(
  new URL("../src/content-controller.js", import.meta.url), "utf8"
);

// Synthetic controller-only fixture. No page, real account, prompt, or response is read.
function bootstrapReadFailureHarness() {
  const listeners = [];
  const counters = { reads: 0, writes: 0, runners: 0 };
  let readAvailable = false;
  let storedRun = null;
  let readGate = null;
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: () => "synthetic-run" },
    instanceId: "synthetic-document",
    recoveryStarted: false,
    startInFlight: false,
    localRunnerToken: 0,
    activeRunnerRunId: null,
    activeRunnerExecutionSessionId: null,
    SCHEMA_VERSION: 1,
    DIAGNOSTICS_KEY: "synthetic-diagnostics",
    __AIPM_CONTENT_CORE__: { version: "0.4.2", ready: true },
    ChatGptAdapter: {
      id: "chatgpt",
      getConversationKey: () => "chatgpt:c:synthetic-lifecycle",
      matches: () => true,
      detectBlocker: () => null,
      readPageObservation: () => ({ composer: {}, generationState: "idle", blocker: null })
    },
    chrome: {
      runtime: {
        async sendMessage(message) {
          assert.equal(message.type, "AIPM_RUN_GET");
          counters.reads += 1;
          if (readAvailable && readGate) await readGate;
          return readAvailable
            ? { ok: true, run: structuredClone(storedRun) }
            : { ok: false, error: "synthetic-transient-storage-unavailable" };
        },
        onMessage: { addListener(listener) { listeners.push(listener); } }
      },
      storage: { local: { async get() { return {}; } } }
    },
    requireRuntimeCursorAuthority: () => true,
    // No composer exists in this bootstrap-only fixture. Input ownership and
    // complete prepared/confirmed recovery are exercised by the runner suites.
    captureInitialPromptAppend: async () => {},
    revokeInitialPromptAppend: () => {},
    outboxMatchesCurrentPosition: async (run) => {
      if (!run?.outbox?.id || !run.outbox.promptHash || !run.outbox.position) return false;
      throw new Error("Use the full runner fixture to validate a complete outbox");
    },
    currentStep: () => null,
    makeError: (code) => Object.assign(new Error(code), { code }),
    normalizeWorkflow: () => ({ schemaVersion: 1, plannedSends: 5, maxSends: 5, steps: [] }),
    nowIso: () => "2026-10-22T00:00:00.000Z",
    appendPostCommitDiagnostic: () => {},
    executeRun: () => { counters.runners += 1; }
  });
  vm.runInContext(controllerSource, context);
  context.renderStatusPill = () => {};
  context.saveActiveRun = async (run) => {
    counters.writes += 1;
    storedRun = structuredClone(run);
  };
  context.pauseRun = async (run, reason, phase) => {
    run.status = "paused";
    run.pauseReason = reason;
    run.phase = phase;
    await context.saveActiveRun(run);
  };
  const command = (overrides = {}) => new Promise((resolve) => {
    listeners[0]({
      type: "AIPM_START",
      workflow: {},
      serviceWorkerVersion: "0.4.2",
      executionSessionId: "synthetic-session",
      expectedDocumentInstanceId: "synthetic-document",
      expectedConversationKey: "chatgpt:c:synthetic-lifecycle",
      expectedRunId: null,
      ...overrides
    }, {}, resolve);
  });

  return {
    context,
    counters,
    makeStorageAvailable() { readAvailable = true; },
    setRun(run) { storedRun = structuredClone(run); },
    setReadGate(gate) { readGate = gate; },
    stored: () => structuredClone(storedRun),
    command,
    start: () => command()
  };
}

test("a failed bootstrap read cannot create a runner or mutate durable state", async () => {
  const fixture = bootstrapReadFailureHarness();
  await assert.rejects(fixture.context.initialRecoveryPromise, /synthetic-transient/);
  const response = await fixture.start();
  assert.equal(response.ok, false);
  assert.equal((await fixture.start()).ok, false, "a failed explicit retry must remain closed");
  assert.equal(fixture.counters.writes, 0);
  assert.equal(fixture.counters.runners, 0);
});

test("a fresh explicit Start can recover after a transient bootstrap read failure", async () => {
  const fixture = bootstrapReadFailureHarness();
  await assert.rejects(fixture.context.initialRecoveryPromise, /synthetic-transient/);
  assert.equal((await fixture.start()).ok, false);
  fixture.makeStorageAvailable();

  const response = await fixture.start();
  assert.equal(response.ok, true,
    "a stale rejected recovery promise must not permanently block Start after storage recovers");
  assert.ok(fixture.counters.reads >= 2, "fresh Start must recheck durable recovery before proceeding");
  assert.equal(fixture.counters.writes, 1);
  assert.equal(fixture.counters.runners, 1);
});

test("status and invalid commands cannot restart failed bootstrap recovery", async () => {
  const fixture = bootstrapReadFailureHarness();
  await assert.rejects(fixture.context.initialRecoveryPromise, /synthetic-transient/);
  fixture.makeStorageAvailable();
  const readsBefore = fixture.counters.reads;
  const status = await fixture.command({ type: "AIPM_GET_STATUS", readOnlyObservation: true });
  assert.equal(status.ok, true);
  assert.equal(fixture.context.recoveryStarted, false);
  assert.equal(fixture.counters.reads, readsBefore + 1, "status performs only its observation read");
  for (const type of ["AIPM_START", "AIPM_RESUME"]) {
    assert.equal((await fixture.command({ type, serviceWorkerVersion: "invalid" })).ok, false);
  }
  assert.equal(fixture.counters.reads, readsBefore + 1, "invalid controls cannot retry recovery");
  assert.equal(fixture.counters.writes, 0);
  assert.equal(fixture.counters.runners, 0);
});

test("concurrent explicit Starts share recovery and create one runner", async () => {
  const fixture = bootstrapReadFailureHarness();
  await assert.rejects(fixture.context.initialRecoveryPromise, /synthetic-transient/);
  fixture.makeStorageAvailable();
  let release;
  fixture.setReadGate(new Promise((resolve) => { release = resolve; }));
  const readsBefore = fixture.counters.reads;
  const first = fixture.start();
  const second = fixture.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fixture.counters.reads, readsBefore + 1, "only one recovery read may be outstanding");
  assert.equal(fixture.counters.runners, 0);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results.filter((response) => response.ok).length, 1);
  assert.equal(fixture.counters.writes, 1);
  assert.equal(fixture.counters.runners, 1);
});

function pausedRun(overrides = {}) {
  return {
    runId: "synthetic-existing-run",
    provider: "chatgpt",
    executionSessionId: "synthetic-session",
    conversationKey: "chatgpt:c:synthetic-lifecycle",
    status: "paused",
    phase: "ready",
    resumable: true,
    outbox: null,
    stateRevision: 1,
    ...overrides
  };
}

test("explicit Resume retries bootstrap before resuming a safely paused run", async () => {
  const fixture = bootstrapReadFailureHarness();
  await assert.rejects(fixture.context.initialRecoveryPromise, /synthetic-transient/);
  fixture.setRun(pausedRun());
  fixture.makeStorageAvailable();
  const response = await fixture.command({
    type: "AIPM_RESUME", expectedRunId: "synthetic-existing-run", expectedStateRevision: 1
  });
  assert.equal(response.ok, true);
  assert.equal(fixture.context.recoveryStarted, true);
  assert.equal(fixture.stored().status, "running");
  assert.equal(fixture.counters.runners, 1);
});

test("Resume recovery retries never replay paused submitting or submitted outboxes", async () => {
  for (const [phase, state] of [["submitting", "prepared"], ["waiting-ack", "submitted"]]) {
    const fixture = bootstrapReadFailureHarness();
    await assert.rejects(fixture.context.initialRecoveryPromise, /synthetic-transient/);
    fixture.setRun(pausedRun({ phase, outbox: { state } }));
    fixture.makeStorageAvailable();
    const response = await fixture.command({
      type: "AIPM_RESUME", expectedRunId: "synthetic-existing-run", expectedStateRevision: 1
    });
    assert.equal(response.ok, false, `${phase}/${state}`);
    assert.equal(fixture.stored().status, "paused");
    assert.equal(fixture.stored().phase, "ambiguous");
    assert.equal(fixture.stored().resumable, false);
    assert.equal(fixture.counters.runners, 0);
  }
});

test("stale or ineligible explicit controls cannot trigger recovery side effects", async () => {
  const cases = [
    { type: "AIPM_START", expectedRunId: "stale-run", status: "running" },
    { type: "AIPM_RESUME", expectedRunId: "stale-run", status: "running" },
    { type: "AIPM_RESUME", expectedStateRevision: 0, status: "paused" },
    { type: "AIPM_START", status: "running" },
    { type: "AIPM_START", status: "paused" },
    { type: "AIPM_RESUME", status: "running" }
  ];
  for (const { status, ...overrides } of cases) {
    const fixture = bootstrapReadFailureHarness();
    await assert.rejects(fixture.context.initialRecoveryPromise, /synthetic-transient/);
    const run = pausedRun({ status });
    fixture.setRun(run);
    fixture.makeStorageAvailable();
    const response = await fixture.command({
      expectedRunId: run.runId, expectedStateRevision: 1, ...overrides
    });
    assert.equal(response.ok, false);
    assert.equal(fixture.counters.runners, 0, "a rejected command must not restart the existing Run");
    assert.equal(fixture.counters.writes, 0);
    assert.deepEqual(fixture.stored(), run);
  }
});

test("Start cannot alter an existing ambiguous nonresumable Run during retry", async () => {
  const fixture = bootstrapReadFailureHarness();
  await assert.rejects(fixture.context.initialRecoveryPromise, /synthetic-transient/);
  const run = pausedRun({ phase: "ambiguous", resumable: false, outbox: { state: "submitted" } });
  fixture.setRun(run);
  fixture.makeStorageAvailable();
  const response = await fixture.command({ expectedRunId: run.runId });
  assert.equal(response.ok, false);
  assert.deepEqual(fixture.stored(), run);
  assert.equal(fixture.counters.writes, 0);
  assert.equal(fixture.counters.runners, 0);
});

test("Stop remains available without retrying failed bootstrap recovery", async () => {
  const fixture = bootstrapReadFailureHarness();
  await assert.rejects(fixture.context.initialRecoveryPromise, /synthetic-transient/);
  fixture.setRun(pausedRun({ status: "running" }));
  fixture.makeStorageAvailable();
  const readsBefore = fixture.counters.reads;
  const response = await fixture.command({
    type: "AIPM_STOP", expectedRunId: "synthetic-existing-run", expectedStateRevision: 1
  });
  assert.equal(response.ok, true);
  assert.equal(fixture.counters.reads, readsBefore + 1);
  assert.equal(fixture.context.recoveryStarted, false);
  assert.equal(fixture.stored().status, "stopped");
  assert.equal(fixture.counters.runners, 0);
});
