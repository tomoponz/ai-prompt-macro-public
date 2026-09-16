import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { TextEncoder } from "node:util";
import { withTextDeliveryTransaction } from "./helpers/text-delivery-transaction.mjs";

const coreSource = fs.readFileSync(new URL("../src/content-core.js", import.meta.url), "utf8");
const runnerSource = fs.readFileSync(new URL("../src/content-runner.js", import.meta.url), "utf8");
const controllerSource = fs.readFileSync(new URL("../src/content-controller.js", import.meta.url), "utf8");

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createBootstrapRaceHarness({ blockAtSubmitted = null, recoveryFails = false } = {}) {
  class DummyElement {}
  class DummyTextArea extends DummyElement {}
  class DummyInput extends DummyElement {}

  const listeners = [];
  const diagnosticsStore = {};
  const recoveryReadStarted = deferred();
  const recoveryReadGate = deferred();
  const targetSubmittedReached = deferred();
  const targetSubmittedContinue = deferred();
  const recoveryPauseWriteStarted = deferred();
  const allowRecoveryPauseCommit = deferred();
  const recoveryPauseCommitted = deferred();
  const persistedRuns = [];
  let recoveryReadReleased = false;
  let targetSubmittedContinueReleased = false;
  let recoverySnapshot = null;
  let recoveryPauseInFlight = false;
  let runGetCount = 0;
  let submittedWriteCount = 0;
  let executeCount = 0;
  let storedRun = null;
  let sendCount = 0;
  let sentBeforeRecoverySettled = false;
  let initialRecoverySettled = false;
  let generating = false;
  const composer = { text: "" };

  function persist(run) {
    storedRun = clone(run);
    persistedRuns.push(clone(run));
  }

  function releaseRecoveryRead() {
    if (recoveryReadReleased) return;
    recoveryReadReleased = true;
    recoverySnapshot = clone(storedRun);
    recoveryReadGate.resolve();
  }

  function releaseTargetSubmitted() {
    if (targetSubmittedContinueReleased) return;
    targetSubmittedContinueReleased = true;
    targetSubmittedContinue.resolve();
  }

  const sendButton = {
    disabled: false,
    getAttribute() { return null; },
    click() {
      if (!initialRecoverySettled) sentBeforeRecoverySettled = true;
      sendCount += 1;
      composer.text = "";
      generating = true;
    }
  };

  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setImmediate,
    TextEncoder,
    crypto: webcrypto,
    Element: DummyElement,
    HTMLTextAreaElement: DummyTextArea,
    HTMLInputElement: DummyInput,
    InputEvent: class {},
    Event: class {},
    location: { origin: "https://chatgpt.com", pathname: "/c/bootstrap-race" },
    document: {
      querySelector() { return null; },
      querySelectorAll() { return []; },
      createRange() { return { selectNodeContents() {} }; },
      execCommand() { return true; },
      getElementById() { return null; },
      createElement() {
        return {
          id: "",
          style: { cssText: "" },
          textContent: "",
          remove() {}
        };
      },
      documentElement: { appendChild() {} }
    },
    window: { getSelection() { return null; } },
    getComputedStyle() { return { display: "block", visibility: "visible" }; },
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) { listeners.push(listener); }
        },
        async sendMessage(message) {
          if (message.type === "AIPM_RUN_GET") {
            runGetCount += 1;
            if (runGetCount === 1) {
              recoveryReadStarted.resolve();
              await recoveryReadGate.promise;
              if (recoveryFails) return { ok: false, error: "recovery-read-failed" };
              return { ok: true, run: clone(recoverySnapshot) };
            }
            return { ok: true, run: clone(storedRun) };
          }

          if (message.type === "AIPM_RUN_SET") {
            const incoming = clone(message.run);
            const transition = message.runTransition ?? "runner";
            const isRecoveryPause = incoming.status === "paused" &&
              incoming.phase === "ambiguous" &&
              incoming.lastErrorCode === "recovery_ambiguous";

            if (isRecoveryPause) {
              recoveryPauseInFlight = true;
              recoveryPauseWriteStarted.resolve();
              await allowRecoveryPauseCommit.promise;
              persist(incoming);
              recoveryPauseCommitted.resolve();
              return { ok: true, run: clone(incoming) };
            }

            if (incoming.outbox?.state === "confirmed" && recoveryPauseInFlight) {
              allowRecoveryPauseCommit.resolve();
              await recoveryPauseCommitted.promise;
            }

            const bypassesPause = storedRun?.runId === incoming.runId &&
              storedRun.status === "paused" && incoming.status === "running" && transition !== "resume";
            if (bypassesPause) {
              return {
                ok: false,
                errorCode: "RUN_STATE_CONFLICT",
                error: "newer Pause state cannot be overwritten by a stale runner update"
              };
            }

            persist(incoming);
            if (incoming.outbox?.state === "submitted") {
              submittedWriteCount += 1;
              if (submittedWriteCount === blockAtSubmitted) {
                targetSubmittedReached.resolve();
                await targetSubmittedContinue.promise;
              }
            }
            return { ok: true, run: clone(incoming) };
          }

          if (message.type === "AIPM_LEASE_ACQUIRE") {
            return {
              ok: true,
              lease: {
                conversationKey: message.conversationKey,
                executionSessionId: message.executionSessionId,
                nonce: `qa-bootstrap-lease-${sendCount}`
              }
            };
          }
          if (message.type === "AIPM_LEASE_RENEW") return { ok: true, renewed: true };
          if (message.type === "AIPM_LEASE_RELEASE") return { ok: true, released: true };
          return { ok: true };
        }
      },
      storage: {
        local: {
          async get(key) {
            if (typeof key === "string") return { [key]: diagnosticsStore[key] };
            return { ...diagnosticsStore };
          },
          async set(values) { Object.assign(diagnosticsStore, values); }
        }
      }
    }
  });

  vm.runInContext(coreSource, context, { filename: "content-core.js" });
  vm.runInContext(runnerSource, context, { filename: "content-runner.js" });

  context.ChatGptAdapter = withTextDeliveryTransaction({
    id: "chatgpt",
    matches: () => true,
    getConversationKey: () => "chatgpt:c:bootstrap-race",
    detectBlocker: () => null,
    getGenerationState: () => generating ? "generating" : "idle",
    findComposer: () => composer,
    getComposerText: () => composer.text,
    getComposerAttachmentState: () => ({ known: true, count: 0 }),
    writePrompt: (text) => { composer.text = text; },
    findSendButton: () => sendButton,
    isGenerating: () => generating
  });
  context.READY_STABLE_MS = 0;
  context.sha256 = async () => "qa-hash";
  context.sleep = async () => {
    if (generating) generating = false;
  };

  const actualExecuteRun = context.executeRun;
  context.executeRun = (...args) => {
    executeCount += 1;
    return actualExecuteRun(...args);
  };

  vm.runInContext(controllerSource, context, { filename: "content-controller.js" });

  if (context.initialRecoveryPromise && typeof context.initialRecoveryPromise.then === "function") {
    context.initialRecoveryPromise.then(
      () => { initialRecoverySettled = true; },
      () => { initialRecoverySettled = true; }
    );
  }

  function invoke(message) {
    return new Promise((resolve, reject) => {
      const listener = listeners[0];
      if (!listener) return reject(new Error("controller listener was not registered"));
      const handled = listener(message, {}, resolve);
      if (handled !== true) reject(new Error("controller message was not handled asynchronously"));
    });
  }

  async function waitForTerminalRun() {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (context.activeRunnerRunId === null && ["completed", "paused"].includes(storedRun?.status)) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`runner did not settle: sends=${sendCount}, status=${storedRun?.status}, phase=${storedRun?.phase}`);
  }

  return {
    context,
    invoke,
    recoveryReadStarted: recoveryReadStarted.promise,
    targetSubmittedReached: targetSubmittedReached.promise,
    recoveryPauseWriteStarted: recoveryPauseWriteStarted.promise,
    releaseRecoveryRead,
    releaseTargetSubmitted,
    waitForTerminalRun,
    getStoredRun: () => clone(storedRun),
    getPersistedRuns: () => clone(persistedRuns),
    getSendCount: () => sendCount,
    getExecuteCount: () => executeCount,
    getRunGetCount: () => runGetCount,
    getSentBeforeRecoverySettled: () => sentBeforeRecoverySettled
  };
}

function repeatFiveStartMessage(context) {
  return {
    type: "AIPM_START",
    serviceWorkerVersion: "0.4.1",
    executionSessionId: "session-bootstrap-race",
    expectedDocumentInstanceId: context.instanceId,
    expectedConversationKey: "chatgpt:c:bootstrap-race",
    bindingTabId: 91,
    workflow: {
      schemaVersion: 1,
      id: "qa-bootstrap-repeat-five",
      maxSends: 5,
      steps: [{
        id: "repeat-five",
        type: "prompt",
        delivery: "send",
        prompt: "continue",
        repeat: 5,
        delayAfterMs: 0
      }]
    }
  };
}

const timingWindows = [
  {
    name: "first-submit microtask window",
    blockAtSubmitted: 1,
    fallback: async () => {
      for (let turn = 0; turn < 500; turn += 1) await Promise.resolve();
    }
  },
  {
    name: "second-submit setImmediate window",
    blockAtSubmitted: 2,
    fallback: () => new Promise((resolve) => setImmediate(resolve))
  },
  {
    name: "third-submit timer window",
    blockAtSubmitted: 3,
    fallback: () => new Promise((resolve) => setTimeout(resolve, 0))
  },
  {
    name: "fourth-submit multi-turn window",
    blockAtSubmitted: 4,
    fallback: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
];

for (const timing of timingWindows) {
  test(`initial recovery serializes Repeat=5 across ${timing.name}`, async () => {
    const harness = createBootstrapRaceHarness({ blockAtSubmitted: timing.blockAtSubmitted });
    await harness.recoveryReadStarted;

    const startResponsePromise = harness.invoke(repeatFiveStartMessage(harness.context));
    const reachedBlockedSubmit = await Promise.race([
      harness.targetSubmittedReached.then(() => true),
      timing.fallback().then(() => false)
    ]);
    const sendsBeforeRecoveryRelease = harness.getSendCount();

    harness.releaseRecoveryRead();
    if (reachedBlockedSubmit) {
      await Promise.race([
        harness.recoveryPauseWriteStarted,
        new Promise((resolve) => setTimeout(resolve, 25))
      ]);
    }
    harness.releaseTargetSubmitted();

    const startResponse = await startResponsePromise;
    await harness.waitForTerminalRun();

    const storedRun = harness.getStoredRun();
    const sendCount = harness.getSendCount();
    const persistedRuns = harness.getPersistedRuns();
    const earlyCompletions = persistedRuns.filter((run) =>
      run?.status === "completed" && Number(run?.cursor?.sendsCompleted ?? 0) < 5
    );
    const diagnostic = `window=${timing.blockAtSubmitted}, beforeRecovery=${sendsBeforeRecoveryRelease}, sends=${sendCount}, execute=${harness.getExecuteCount()}, status=${storedRun?.status}, phase=${storedRun?.phase}, error=${storedRun?.lastErrorCode}`;

    assert.equal(startResponse.ok, true, diagnostic);
    assert.equal(harness.getSentBeforeRecoverySettled(), false, `no send may occur before initial recovery settles: ${diagnostic}`);
    assert.equal(sendsBeforeRecoveryRelease, 0, `initial recovery was still blocked: ${diagnostic}`);
    assert.equal(harness.getExecuteCount(), 1, `AIPM_START must create exactly one runner: ${diagnostic}`);
    assert.ok(sendCount <= 5, `Repeat=5 must never send six or more times: ${diagnostic}`);
    assert.equal(sendCount, 5, `Repeat=5 must not terminate after 1-4 sends: ${diagnostic}`);
    assert.equal(earlyCompletions.length, 0, `1-4 sends must never be persisted as completed: ${diagnostic}`);
    assert.equal(storedRun?.status, "completed", diagnostic);
    assert.equal(storedRun?.phase, "completed", diagnostic);
    assert.equal(storedRun?.cursor?.sendsCompleted, 5, diagnostic);
    assert.equal(storedRun?.cursor?.stepIndex, 1, diagnostic);
    assert.equal(storedRun?.cursor?.repeatIndex, 0, diagnostic);
    assert.ok(harness.getRunGetCount() >= 2, `recovery and Start must perform distinct Run reads: ${diagnostic}`);
  });
}

test("failed initial recovery rejects AIPM_START with zero sends and zero runners", async () => {
  const harness = createBootstrapRaceHarness({ recoveryFails: true });
  await harness.recoveryReadStarted;

  const startResponsePromise = harness.invoke(repeatFiveStartMessage(harness.context));
  for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
  const sendsBeforeRecoveryFailure = harness.getSendCount();
  harness.releaseRecoveryRead();
  harness.releaseTargetSubmitted();

  const response = await startResponsePromise;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(response.ok, false);
  assert.match(response.error, /recovery-read-failed/);
  assert.equal(sendsBeforeRecoveryFailure, 0, "a pending recovery failure must not allow an early send");
  assert.equal(harness.getSendCount(), 0, "failed initial recovery must fail closed without sending");
  assert.equal(harness.getExecuteCount(), 0, "failed initial recovery must not create a runner");
  assert.equal(harness.getSentBeforeRecoverySettled(), false);
  assert.equal(harness.getStoredRun(), null);
});
