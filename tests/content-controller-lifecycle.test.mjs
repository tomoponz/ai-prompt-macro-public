import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const postCommitDiagnosticHarness = `
var testPostCommitDiagnosticInFlight = testPostCommitDiagnosticInFlight || null;
function requireRuntimeCursorAuthority() { return true; }
async function confirmedOutboxMatchesCurrentPosition() { return true; }
function appendPostCommitDiagnostic(type, meta = {}) {
  if (testPostCommitDiagnosticInFlight) return false;
  const pending = Promise.resolve().then(() => appendDiagnostic(type, meta));
  testPostCommitDiagnosticInFlight = pending;
  const release = () => {
    if (testPostCommitDiagnosticInFlight === pending) testPostCommitDiagnosticInFlight = null;
  };
  void pending.then(release, release);
  return true;
}
`;
const source = `${postCommitDiagnosticHarness}\n${fs.readFileSync(
  new URL("../src/content-controller.js", import.meta.url),
  "utf8"
)}`;
const coreSource = fs.readFileSync(new URL("../src/content-core.js", import.meta.url), "utf8");

function controllerHarness() {
  const listeners = [];
  let runGetCount = 0;
  let runGetResponse = { ok: true, run: null };
  let runGetError = null;
  const runGetMessages = [];
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: () => "generated-run" },
    recoveryStarted: false,
    instanceId: "instance-test",
    SCHEMA_VERSION: 1,
    DIAGNOSTICS_KEY: "aipm.diagnostics.v1",
    ChatGptAdapter: {
      id: "chatgpt",
      getConversationKey: () => "chatgpt:c:test",
      matches: () => true,
      readPageObservation: () => ({ composer: {}, generationState: "idle", blocker: null })
    },
    chrome: {
      runtime: {
        async sendMessage(message) {
          if (message.type === "AIPM_RUN_GET") {
            runGetCount += 1;
            runGetMessages.push(structuredClone(message));
            if (runGetError) throw runGetError;
            return structuredClone(runGetResponse);
          }
          return { ok: true };
        },
        onMessage: {
          addListener(listener) {
            listeners.push(listener);
          }
        }
      },
      storage: {
        local: {
          async get() { return {}; }
        }
      }
    }
  });
  context.__AIPM_CONTENT_CORE__ = { version: "0.4.0", ready: true };
  return {
    context,
    listeners,
    getRunGetCount: () => runGetCount,
    getRunGetMessages: () => runGetMessages,
    setRunGetResponse: (response) => { runGetResponse = response; },
    setRunGetError: (error) => { runGetError = error; }
  };
}

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test("status forwards completion-oriented recovery into the inner Run observation", async () => {
  const harness = controllerHarness();
  vm.runInContext(source, harness.context);
  const recovery = {
    mode: "completion",
    identityAttempts: 10,
    readiness: "long",
    statusRecovery: "persistent"
  };
  const response = await new Promise((resolve) => {
    const handled = harness.listeners[0]({
      type: "AIPM_GET_STATUS",
      readOnlyObservation: true,
      readOnlyRecovery: recovery
    }, {}, resolve);
    assert.equal(handled, true);
  });
  assert.equal(response.ok, true);
  const inner = harness.getRunGetMessages().at(-1);
  assert.equal(inner.readOnlyObservation, true);
  assert.deepEqual(inner.readOnlyRecovery, recovery);
});

async function invokeStatusListener(harness) {
  return new Promise((resolve) => {
    const handled = harness.listeners[0]({
      type: "AIPM_GET_STATUS",
      readOnlyObservation: true
    }, {}, resolve);
    assert.equal(handled, true);
  });
}

for (const scenario of [
  {
    name: "READ_ONLY_CONTACT_BUSY code",
    input: { errorCode: "READ_ONLY_CONTACT_BUSY", errorPhase: "read-only-observation" },
    expected: { errorCode: "READ_ONLY_CONTACT_BUSY", errorPhase: "read-only-observation" }
  },
  {
    name: "READ_ONLY_BACKOFF code and retryAfterMs",
    input: { errorCode: "READ_ONLY_BACKOFF", errorPhase: "read-only-observation", retryAfterMs: 1200 },
    expected: { errorCode: "READ_ONLY_BACKOFF", errorPhase: "read-only-observation", retryAfterMs: 1200 }
  },
  {
    name: "RUN_OBSERVATION_TIMEOUT code and phase",
    input: { errorCode: "RUN_OBSERVATION_TIMEOUT", errorPhase: "run-observation" },
    expected: { errorCode: "RUN_OBSERVATION_TIMEOUT", errorPhase: "run-observation" }
  }
]) {
  test(`AIPM_GET_STATUS listener preserves safe ${scenario.name}`, async () => {
    const harness = controllerHarness();
    harness.setRunGetResponse({
      ok: false,
      ...scenario.input,
      error: "raw technical detail must not cross the listener"
    });
    vm.runInContext(source, harness.context);

    const response = await invokeStatusListener(harness);

    assert.equal(response.ok, false);
    assert.deepEqual(
      Object.fromEntries(Object.entries(response).filter(([key]) => key !== "ok" && key !== "error")),
      scenario.expected
    );
    assert.doesNotMatch(response.error, /raw technical|READ_ONLY_|RUN_OBSERVATION/);
    assert.equal(Object.hasOwn(response, "stack"), false);
  });
}

test("AIPM_GET_STATUS listener fails closed without leaking malformed ordinary errors", async () => {
  const harness = controllerHarness();
  const ordinaryError = new Error("raw database path and internal stack");
  ordinaryError.code = { arbitrary: true };
  ordinaryError.phase = { arbitrary: true };
  harness.setRunGetError(ordinaryError);
  vm.runInContext(source, harness.context);

  const response = await invokeStatusListener(harness);

  assert.equal(response.ok, false);
  assert.equal(response.error, "状態確認を完了できなかったため、安全のため操作を進めていません。");
  assert.deepEqual(Object.keys(response).sort(), ["error", "ok"]);
  assert.doesNotMatch(JSON.stringify(response), /raw database|stack|arbitrary/);
});

test("initial recovery serializes a Repeat=5 Start instead of invalidating its runner", async () => {
  const listeners = [];
  const recoveryRead = deferred();
  const continueAfterRecovery = deferred();
  let runGetCount = 0;
  let storedRun = null;
  let sendsCompleted = 0;
  let executeCount = 0;

  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: () => "bootstrap-race-run" },
    recoveryStarted: false,
    instanceId: "instance-test",
    SCHEMA_VERSION: 1,
    localRunnerToken: 0,
    startInFlight: false,
    ChatGptAdapter: {
      id: "chatgpt",
      getConversationKey: () => "chatgpt:c:test"
    },
    chrome: {
      runtime: {
        async sendMessage(message) {
          if (message.type === "AIPM_RUN_GET") {
            runGetCount += 1;
            if (runGetCount === 1) {
              await recoveryRead.promise;
              return { ok: true, run: clone(storedRun) };
            }
            return { ok: true, run: clone(storedRun) };
          }
          return { ok: true };
        },
        onMessage: {
          addListener(listener) {
            listeners.push(listener);
          }
        }
      },
      storage: {
        local: {
          async get() { return {}; }
        }
      }
    }
  });
  context.__AIPM_CONTENT_CORE__ = { version: "0.4.0", ready: true };

  vm.runInContext(source, context);

  context.normalizeWorkflow = (workflow) => ({ ...workflow, plannedSends: 5, maxSends: 5 });
  context.nowIso = () => "2026-08-21T00:00:00.000Z";
  context.appendDiagnostic = async () => {};
  context.saveActiveRun = async (run) => { storedRun = clone(run); };
  context.acquireLease = async () => null;
  context.releaseLease = async () => {};
  context.makeError = (code) => {
    const error = new Error(code);
    error.code = code;
    return error;
  };
  context.pauseRun = async (run, reason, phase) => {
    run.status = "paused";
    run.pauseReason = reason;
    run.phase = phase;
    storedRun = clone(run);
  };
  context.executeRun = (run, token) => {
    executeCount += 1;
    (async () => {
      for (let index = 0; index < 5; index += 1) {
        if (token !== context.localRunnerToken) return;
        sendsCompleted += 1;
        run.cursor.sendsCompleted = sendsCompleted;
        run.outbox = { state: "confirmed" };
        storedRun = clone(run);
        if (sendsCompleted === 3) await continueAfterRecovery.promise;
        await Promise.resolve();
      }
      run.outbox = null;
      run.status = "completed";
      run.phase = "completed";
      storedRun = clone(run);
    })();
  };

  const startResponse = new Promise((resolve) => {
    const handled = listeners[0]({
      type: "AIPM_START",
      workflow: {
        schemaVersion: 1,
        maxSends: 5,
        steps: [{ id: "quick", type: "prompt", delivery: "send", prompt: "continue", repeat: 5 }]
      },
      bindingTabId: 1,
      keepAwake: false,
      serviceWorkerVersion: "0.4.0",
      executionSessionId: "session-test",
      expectedDocumentInstanceId: "instance-test",
      expectedConversationKey: "chatgpt:c:test",
      expectedRunId: null
    }, {}, resolve);
    assert.equal(handled, true);
  });

  await flushAsync();
  const sendsBeforeRecoveryCompleted = sendsCompleted;

  recoveryRead.resolve();
  continueAfterRecovery.resolve();
  const response = await startResponse;
  await flushAsync();

  assert.equal(response.ok, true);
  assert.equal(sendsBeforeRecoveryCompleted, 0, "AIPM_START must not create a runner before initial recovery completes");
  assert.equal(sendsCompleted, 5, "Repeat=5 must not silently terminate at an intermediate count");
  assert.equal(executeCount, 1, "bootstrap recovery must not launch a second runner for the new Start");
  assert.equal(storedRun.status, "completed");
  assert.equal(storedRun.cursor.sendsCompleted, 5);
});

test("Start fails closed before runner creation when initial recovery cannot complete", async () => {
  const listeners = [];
  let executeCount = 0;
  let normalizeCount = 0;
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: () => "must-not-start" },
    recoveryStarted: false,
    instanceId: "instance-test",
    SCHEMA_VERSION: 1,
    localRunnerToken: 0,
    startInFlight: false,
    ChatGptAdapter: {
      id: "chatgpt",
      getConversationKey: () => "chatgpt:c:test"
    },
    chrome: {
      runtime: {
        async sendMessage(message) {
          if (message.type === "AIPM_RUN_GET") return { ok: false, error: "recovery-read-failed" };
          return { ok: true };
        },
        onMessage: {
          addListener(listener) { listeners.push(listener); }
        }
      },
      storage: { local: { async get() { return {}; } } }
    }
  });
  context.__AIPM_CONTENT_CORE__ = { version: "0.4.0", ready: true };
  vm.runInContext(source, context);
  context.normalizeWorkflow = () => { normalizeCount += 1; return { plannedSends: 5, maxSends: 5, steps: [] }; };
  context.executeRun = () => { executeCount += 1; };

  const response = await new Promise((resolve) => {
    listeners[0]({
      type: "AIPM_START",
      workflow: { schemaVersion: 1, maxSends: 5, steps: [] },
      serviceWorkerVersion: "0.4.0",
      executionSessionId: "session-test",
      expectedDocumentInstanceId: "instance-test",
      expectedConversationKey: "chatgpt:c:test",
      expectedRunId: null
    }, {}, resolve);
  });

  assert.equal(response.ok, false);
  assert.match(response.error, /recovery-read-failed/);
  assert.equal(normalizeCount, 0);
  assert.equal(executeCount, 0);
});

test("exhausted identity probes during initial recovery durably stop the exact Run without poisoning Start", async () => {
  const listeners = [];
  const failClosedCalls = [];
  let runGetCount = 0;
  let executeCount = 0;
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: () => "fresh-after-identity-stop" },
    recoveryStarted: false,
    instanceId: "instance-test",
    SCHEMA_VERSION: 1,
    localRunnerToken: 0,
    startInFlight: false,
    ChatGptAdapter: {
      id: "chatgpt",
      getConversationKey: () => "chatgpt:c:test"
    },
    async failClosedRunWithoutIdentity(runId, reason) {
      failClosedCalls.push({ runId, reason });
      return { runId, status: "paused", phase: "ambiguous", resumable: false };
    },
    chrome: {
      runtime: {
        async sendMessage(message) {
          if (message.type === "AIPM_RUN_GET") {
            runGetCount += 1;
            if (runGetCount === 1) {
              return {
                ok: false,
                errorCode: "DOCUMENT_IDENTITY_UNCONFIRMED",
                runId: "durable-run-needing-stop",
                error: "identity probes exhausted"
              };
            }
            return { ok: true, run: null };
          }
          return { ok: true };
        },
        onMessage: { addListener(listener) { listeners.push(listener); } }
      },
      storage: { local: { async get() { return {}; } } }
    }
  });
  context.__AIPM_CONTENT_CORE__ = { version: "0.4.0", ready: true };
  vm.runInContext(source, context);
  await context.initialRecoveryPromise;

  assert.deepEqual(failClosedCalls, [{
    runId: "durable-run-needing-stop",
    reason: "document_identity_unconfirmed"
  }]);

  context.normalizeWorkflow = (workflow) => ({ ...workflow, plannedSends: 1, maxSends: 1 });
  context.nowIso = () => "2026-08-22T00:00:00.000Z";
  context.saveActiveRun = async () => {};
  context.appendDiagnostic = async () => {};
  context.executeRun = () => { executeCount += 1; };
  const response = await context.startRun(
    { schemaVersion: 1, maxSends: 1, steps: [] },
    { bindingTabId: 1, executionSessionId: "session-test" },
    {
      serviceWorkerVersion: "0.4.0",
      executionSessionId: "session-test",
      expectedDocumentInstanceId: "instance-test",
      expectedConversationKey: "chatgpt:c:test",
      expectedRunId: null
    }
  );

  assert.equal(response.ok, true);
  assert.equal(executeCount, 1, "a resolved fail-closed recovery barrier must allow a fresh Start");
});

test("re-evaluating the controller in one document registers only one listener and recovery", async () => {
  const harness = controllerHarness();
  vm.runInContext(source, harness.context);
  await flushAsync();
  vm.runInContext(source, harness.context);
  await flushAsync();

  assert.equal(harness.listeners.length, 1);
  assert.equal(harness.getRunGetCount(), 1);
  assert.equal(harness.context.__AIPM_CONTENT_CONTROLLER_READY__, true);
});

test("new content rejects an old-style mutating command without a version handshake", async () => {
  const harness = controllerHarness();
  vm.runInContext(source, harness.context);
  await flushAsync();

  const response = await new Promise((resolve) => {
    const handled = harness.listeners[0]({ type: "AIPM_START", workflow: { id: "unsafe" } }, {}, resolve);
    assert.equal(handled, true);
  });
  assert.equal(response.ok, false);
  assert.match(response.error, /version/);
});

test("re-evaluating the content core does not redeclare lexicals or reset live runner state", () => {
  const session = new Map();
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: () => "core-instance" },
    sessionStorage: {
      getItem(key) { return session.get(key) ?? null; },
      setItem(key, value) { session.set(key, String(value)); }
    }
  });

  vm.runInContext(coreSource, context);
  context.localRunnerToken = 7;
  context.recoveryStarted = true;
  context.activeRunnerRunId = "live-run";
  context.activeRunnerToken = 7;
  context.activeRunnerExecutionSessionId = "live-session";
  vm.runInContext(coreSource, context);

  assert.equal(context.__AIPM_CONTENT_CORE__.version, "0.4.1");
  assert.equal(context.__AIPM_CONTENT_CORE__.ready, true);
  assert.equal(context.localRunnerToken, 7);
  assert.equal(context.recoveryStarted, true);
  assert.equal(context.activeRunnerRunId, "live-run");
  assert.equal(context.activeRunnerToken, 7);
  assert.equal(context.activeRunnerExecutionSessionId, "live-session");
});

test("concurrent Start requests create only one runner", async () => {
  const harness = controllerHarness();
  vm.runInContext(source, harness.context);
  await flushAsync();

  let releaseRunRead;
  const runRead = new Promise((resolve) => { releaseRunRead = resolve; });
  let executeCount = 0;
  harness.context.startInFlight = false;
  harness.context.getActiveRun = async () => {
    await runRead;
    return null;
  };
  harness.context.normalizeWorkflow = (workflow) => ({ ...workflow, plannedSends: 1 });
  harness.context.saveActiveRun = async () => {};
  harness.context.appendDiagnostic = async () => {};
  harness.context.executeRun = () => { executeCount += 1; };
  harness.context.nowIso = () => "2026-08-21T00:00:00.000Z";
  harness.context.localRunnerToken = 0;

  const controlMessage = {
    serviceWorkerVersion: "0.4.0",
    executionSessionId: "session-test",
    expectedDocumentInstanceId: "instance-test",
    expectedConversationKey: "chatgpt:c:test"
  };
  const options = { bindingTabId: 1, executionSessionId: "session-test" };
  const first = harness.context.startRun({ id: "one" }, options, controlMessage);
  const second = harness.context.startRun({ id: "two" }, options, controlMessage);
  const secondResponse = await second;
  releaseRunRead();
  const firstResponse = await first;

  assert.equal(firstResponse.ok, true);
  assert.equal(secondResponse.ok, false);
  assert.match(secondResponse.error, /進行中/);
  assert.equal(executeCount, 1);
});

test("a diagnostic write failure cannot leave a reported-failed latent running Start", async () => {
  const harness = controllerHarness();
  vm.runInContext(source, harness.context);
  await flushAsync();

  let storedRun = null;
  let executeCount = 0;
  harness.context.startInFlight = false;
  harness.context.localRunnerToken = 0;
  harness.context.getActiveRun = async () => null;
  harness.context.normalizeWorkflow = (workflow) => ({ ...workflow, plannedSends: 1, maxSends: 1 });
  harness.context.nowIso = () => "2026-08-23T00:00:00.000Z";
  harness.context.saveActiveRun = async (run) => { storedRun = { ...run }; };
  harness.context.appendDiagnostic = async () => { throw new Error("diagnostic storage unavailable"); };
  harness.context.executeRun = () => { executeCount += 1; };

  const response = await harness.context.startRun(
    { schemaVersion: 1, steps: [{ id: "prompt", prompt: "safe" }] },
    { bindingTabId: 1, executionSessionId: "session-test" },
    {
      serviceWorkerVersion: "0.4.0",
      executionSessionId: "session-test",
      expectedDocumentInstanceId: "instance-test",
      expectedConversationKey: "chatgpt:c:test",
      expectedRunId: null
    }
  );

  assert.equal(response.ok, true, "non-authoritative diagnostics must not turn a committed Start into failure");
  assert.equal(storedRun?.status, "running");
  assert.equal(executeCount, 1, "the committed Start must deterministically launch exactly one runner");
});

test("Start aborts if the conversation changes while existing Run state is loading", async () => {
  const harness = controllerHarness();
  vm.runInContext(source, harness.context);
  await flushAsync();

  let conversationKey = "chatgpt:c:before";
  let releaseRunRead;
  const runRead = new Promise((resolve) => { releaseRunRead = resolve; });
  let saveCount = 0;
  let executeCount = 0;
  harness.context.ChatGptAdapter.getConversationKey = () => conversationKey;
  harness.context.startInFlight = false;
  harness.context.getActiveRun = async () => {
    await runRead;
    return null;
  };
  harness.context.normalizeWorkflow = (workflow) => ({ ...workflow, plannedSends: 1 });
  harness.context.saveActiveRun = async () => { saveCount += 1; };
  harness.context.executeRun = () => { executeCount += 1; };
  harness.context.nowIso = () => "2026-08-21T00:00:00.000Z";

  const start = harness.context.startRun(
    { id: "conversation-race" },
    { bindingTabId: 1, executionSessionId: "session-test" },
    {
      serviceWorkerVersion: "0.4.0",
      executionSessionId: "session-test",
      expectedDocumentInstanceId: "instance-test",
      expectedConversationKey: "chatgpt:c:before"
    }
  );
  conversationKey = "chatgpt:c:after";
  releaseRunRead();
  const response = await start;

  assert.equal(response.ok, false);
  assert.match(response.error, /会話/);
  assert.equal(saveCount, 0);
  assert.equal(executeCount, 0);
});

test("content Start boundary rejects a stale-pause Wait Until before durable Run or Send", async () => {
  const harness = controllerHarness();
  vm.runInContext(source, harness.context);
  await flushAsync();

  const terminalRun = { runId: "previous-run", status: "completed" };
  let saveCount = 0;
  let executeCount = 0;
  harness.context.startInFlight = false;
  harness.context.localRunnerToken = 0;
  harness.context.getActiveRun = async () => terminalRun;
  harness.context.normalizeWorkflow = (workflow) => ({ ...workflow, plannedSends: 2, maxSends: 2 });
  harness.context.saveActiveRun = async () => { saveCount += 1; };
  harness.context.executeRun = () => { executeCount += 1; };
  harness.context.nowIso = () => "2026-08-25T00:00:00.000Z";

  const response = await harness.context.startRun(
    {
      schemaVersion: 1,
      maxSends: 2,
      steps: [
        { id: "prompt-a", type: "prompt", prompt: "A", repeat: 1 },
        { id: "stale", type: "wait-until", at: "2000-01-01T00:00:00.000Z", latePolicy: "pause", graceMs: 0 },
        { id: "prompt-b", type: "prompt", prompt: "B", repeat: 1 }
      ]
    },
    { bindingTabId: 1, executionSessionId: "session-test" },
    {
      serviceWorkerVersion: "0.4.0",
      executionSessionId: "session-test",
      expectedDocumentInstanceId: "instance-test",
      expectedConversationKey: "chatgpt:c:test",
      expectedRunId: "previous-run"
    }
  );

  assert.equal(response.ok, false);
  assert.match(response.error, /過去/);
  assert.equal(saveCount, 0, "rejected Start must not leave a durable running Run");
  assert.equal(executeCount, 0, "rejected Start must launch no runner, Send, or alarm");
  assert.equal(harness.context.localRunnerToken, 0);
  assert.deepEqual(terminalRun, { runId: "previous-run", status: "completed" });
});

test("a safe-boundary Pause invalidates the runner only after the Pause is durable", async () => {
  const harness = controllerHarness();
  vm.runInContext(source, harness.context);
  await flushAsync();

  let releaseRunRead;
  const runRead = new Promise((resolve) => { releaseRunRead = resolve; });
  const run = {
    runId: "active-run",
    executionSessionId: "session-test",
    status: "running",
    phase: "ready",
    outbox: null
  };
  harness.context.getActiveRun = async () => runRead;
  harness.context.saveActiveRun = async () => {};
  harness.context.appendDiagnostic = async () => {};
  harness.context.localRunnerToken = 4;
  harness.context.activeRunnerRunId = "active-run";
  harness.context.activeRunnerToken = 4;
  harness.context.activeRunnerExecutionSessionId = "session-test";

  const responsePromise = new Promise((resolve) => {
    harness.listeners[0]({
      type: "AIPM_PAUSE",
      serviceWorkerVersion: "0.4.0",
      executionSessionId: "session-test",
      expectedDocumentInstanceId: "instance-test",
      expectedConversationKey: "chatgpt:c:test",
      expectedRunId: "active-run",
      expectedStateRevision: null
    }, {}, resolve);
  });

  assert.equal(harness.context.localRunnerToken, 4, "Pause must not outrun its durable commit");
  releaseRunRead(run);
  const response = await responsePromise;
  assert.equal(response.ok, true);
  assert.equal(run.status, "paused");
  assert.equal(harness.context.localRunnerToken, 5);
});

test("Pause with an in-flight outbox is recorded durably without cancelling the ACK runner", async () => {
  const harness = controllerHarness();
  vm.runInContext(source, harness.context);
  await flushAsync();

  const run = {
    runId: "ack-run",
    executionSessionId: "session-test",
    status: "running",
    phase: "waiting-ack",
    outbox: { state: "submitted" }
  };
  let transition = null;
  harness.context.getActiveRun = async () => run;
  harness.context.saveActiveRun = async (_run, value) => { transition = value; };
  harness.context.appendDiagnostic = async () => {};
  harness.context.nowIso = () => "2026-08-24T00:00:00.000Z";
  harness.context.localRunnerToken = 6;
  harness.context.activeRunnerRunId = run.runId;
  harness.context.activeRunnerToken = 6;
  harness.context.activeRunnerExecutionSessionId = "session-test";

  const response = await harness.context.pauseCurrentRun({
    type: "AIPM_PAUSE",
    serviceWorkerVersion: "0.4.0",
    executionSessionId: "session-test",
    expectedDocumentInstanceId: "instance-test",
    expectedConversationKey: "chatgpt:c:test",
    expectedRunId: run.runId,
    expectedStateRevision: null
  });

  assert.equal(response.ok, true);
  assert.equal(transition, "pause-request");
  assert.equal(run.status, "running");
  assert.equal(run.pauseRequested, true);
  assert.equal(run.resumable, undefined, "Pause request must not invent delivery ambiguity");
  assert.equal(harness.context.localRunnerToken, 6, "the ACK runner must remain alive");
});

test("an invalid control handshake cannot cancel the active runner", async () => {
  const harness = controllerHarness();
  vm.runInContext(source, harness.context);
  await flushAsync();

  const run = { runId: "active-run", executionSessionId: "session-test", status: "running" };
  harness.context.getActiveRun = async () => run;
  harness.context.localRunnerToken = 8;
  harness.context.activeRunnerRunId = "active-run";
  harness.context.activeRunnerToken = 8;
  harness.context.activeRunnerExecutionSessionId = "session-test";

  const response = await new Promise((resolve) => {
    harness.listeners[0]({
      type: "AIPM_STOP",
      serviceWorkerVersion: "0.2.5",
      executionSessionId: "session-test",
      expectedDocumentInstanceId: "instance-test",
      expectedConversationKey: "chatgpt:c:test",
      expectedRunId: "active-run"
    }, {}, resolve);
  });

  assert.equal(response.ok, false);
  assert.equal(harness.context.localRunnerToken, 8);
  assert.equal(run.status, "running");
});

test("Resume fails closed for every persisted unfinished outbox", async () => {
  for (const state of ["prepared", "submitted", "confirmed"]) {
    const harness = controllerHarness();
    vm.runInContext(source, harness.context);
    await flushAsync();
    const run = {
      runId: `paused-${state}`,
      executionSessionId: "session-test",
      status: "paused",
      phase: state,
      resumable: true,
      outbox: { state }
    };
    let saveCount = 0;
    let executeCount = 0;
    harness.context.getActiveRun = async () => run;
    harness.context.saveActiveRun = async () => { saveCount += 1; };
    harness.context.executeRun = () => { executeCount += 1; };

    const response = await harness.context.resumeRun({
      serviceWorkerVersion: "0.4.0",
      executionSessionId: "session-test",
      expectedDocumentInstanceId: "instance-test",
      expectedConversationKey: "chatgpt:c:test",
      expectedRunId: run.runId,
      expectedStateRevision: null
    });

    assert.equal(response.ok, false, state);
    assert.equal(run.resumable, false, state);
    assert.equal(run.phase, "ambiguous", state);
    assert.equal(saveCount, 1, state);
    assert.equal(executeCount, 0, state);
  }
});

test("confirmed recovery timeout becomes non-resumable instead of replaying the cursor", async () => {
  const harness = controllerHarness();
  vm.runInContext(source, harness.context);
  await flushAsync();
  const run = {
    runId: "confirmed-recovery",
    provider: "chatgpt",
    conversationKey: "chatgpt:c:test",
    executionSessionId: "session-test",
    status: "running",
    phase: "generating",
    resumable: true,
    outbox: { state: "confirmed" }
  };
  let pausedPhase = null;
  let executeCount = 0;
  harness.context.recoveryStarted = false;
  harness.context.localRunnerToken = 0;
  harness.context.getActiveRun = async () => run;
  harness.context.acquireLease = async () => ({ conversationKey: run.conversationKey, nonce: "lease" });
  harness.context.waitForReadyStability = async () => {
    const error = new Error("timed out");
    error.code = "generation_timeout";
    throw error;
  };
  harness.context.pauseRun = async (_run, _reason, phase) => { pausedPhase = phase; };
  harness.context.releaseLease = async () => {};
  harness.context.executeRun = () => { executeCount += 1; };

  await harness.context.recoverIfNeeded();

  assert.equal(run.resumable, false);
  assert.equal(pausedPhase, "ambiguous");
  assert.equal(executeCount, 0);
});
