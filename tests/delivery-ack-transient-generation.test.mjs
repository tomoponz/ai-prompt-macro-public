import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { withTextDeliveryTransaction } from "./helpers/text-delivery-transaction.mjs";

const coreSource = fs.readFileSync(new URL("../src/content-core.js", import.meta.url), "utf8");
const runnerSource = fs.readFileSync(new URL("../src/content-runner.js", import.meta.url), "utf8");

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A minimal DOM host that supports exactly what the delivery acceptance watch needs:
 * a document.body to observe and a MutationObserver contract. `notify()` models the
 * browser delivering a mutation batch, so the production watch runs its real code path.
 */
function createObservableDocument() {
  const observers = new Set();
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  return {
    MutationObserver: FakeMutationObserver,
    observerCount: () => observers.size,
    notify() {
      for (const observer of [...observers]) observer.callback([{}]);
    }
  };
}

function createRuntimeHarness(dom) {
  class DummyElement {}
  class DummyTextArea extends DummyElement {}
  class DummyInput extends DummyElement {}

  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    crypto: webcrypto,
    TextEncoder,
    Element: DummyElement,
    HTMLTextAreaElement: DummyTextArea,
    HTMLInputElement: DummyInput,
    InputEvent: class {},
    Event: class {},
    MutationObserver: dom?.MutationObserver,
    location: { origin: "https://chatgpt.com", pathname: "/c/transient-generation" },
    document: {
      body: dom ? {} : null,
      querySelector() { return null; },
      querySelectorAll() { return []; },
      createRange() { return { selectNodeContents() {} }; },
      execCommand() { return true; }
    },
    window: { getSelection() { return null; } },
    getComputedStyle() { return { display: "block", visibility: "visible" }; },
    chrome: {
      runtime: { async sendMessage() { return { ok: true }; } },
      storage: { local: { async get() { return {}; }, async set() {} } }
    }
  });

  vm.runInContext(coreSource, context);
  vm.runInContext(runnerSource, context);
  return context;
}

function repeatWorkflow(context, { repeat, maxSends }) {
  return context.normalizeWorkflow({
    schemaVersion: 1,
    id: "ack-latch",
    maxSends,
    steps: [{
      id: "single",
      type: "prompt",
      delivery: "send",
      prompt: "回答は C11-LIVE-TEST だけにしてください。",
      repeat,
      delayAfterMs: 0
    }]
  });
}

function newRun(workflow, conversationKey, suffix) {
  return {
    runId: `run-${suffix}`,
    provider: "chatgpt",
    conversationKey,
    executionSessionId: `session-${suffix}`,
    contentVersion: "0.4.1",
    status: "running",
    phase: "ready",
    resumable: true,
    workflow,
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 },
    outbox: null,
    waitState: null
  };
}

/**
 * Models one live ChatGPT send whose assistant reply is short.
 *
 * Real ordering reproduced here:
 *   1. the irreversible click clears the composer synchronously and mounts the
 *      generation (Stop) control,
 *   2. that control is retired again after `generationWindowMs`, because a short
 *      reply finishes quickly,
 *   3. every durable write and cross-context guard the runner performs after the
 *      click (saveActiveRun, getActiveRun, renewLease) costs `controlPlaneLatencyMs`,
 *      which is what a busy renderer plus a service-worker round trip actually cost.
 *
 * When the control-plane latency exceeds the generation window, the runner's first
 * post-click sample lands after the generation control is already gone. The composer
 * stayed cleared throughout, so delivery really did happen and no retry is ever safe.
 */
async function runShortReplyDelivery({
  generationWindowMs,
  controlPlaneLatencyMs,
  repeat = 1,
  withObservableDom = true,
  readyStableMs = null,
  pollMs = null
}) {
  const dom = withObservableDom ? createObservableDocument() : null;
  const context = createRuntimeHarness(dom);
  const conversationKey = "chatgpt:c:transient-generation";
  const composer = { text: "" };
  let sendCount = 0;
  let stopButtonVisible = false;

  const sendButton = {
    disabled: false,
    getAttribute() { return null; },
    click() {
      sendCount += 1;
      composer.text = "";
      stopButtonVisible = true;
      dom?.notify();
      setTimeout(() => {
        stopButtonVisible = false;
        dom?.notify();
      }, generationWindowMs);
    }
  };

  context.ChatGptAdapter = withTextDeliveryTransaction({
    id: "chatgpt",
    getConversationKey: () => conversationKey,
    detectBlocker: () => null,
    getGenerationState: () => (stopButtonVisible ? "generating" : "idle"),
    findComposer: () => composer,
    getComposerText: () => composer.text,
    getComposerAttachmentState: () => ({ known: true, count: 0 }),
    writePrompt: (text) => { composer.text = text; },
    findSendButton: () => sendButton,
    isGenerating: () => stopButtonVisible
  }, context);

  let activeRun = null;
  context.sleep = realSleep;
  context.appendDiagnostic = async () => {};
  // Every durable write and every read-only control-plane observation crosses the
  // content-script -> service-worker boundary in production. Model that cost.
  context.saveActiveRun = async (run) => {
    await realSleep(controlPlaneLatencyMs);
    activeRun = run;
  };
  context.getActiveRun = async () => {
    await realSleep(controlPlaneLatencyMs);
    return activeRun;
  };
  context.acquireLease = async (key, runId, executionSessionId) => ({
    conversationKey: key,
    runId,
    executionSessionId,
    nonce: "lease-transient"
  });
  context.renewLease = async () => {
    await realSleep(controlPlaneLatencyMs);
    return true;
  };
  context.releaseLease = async () => {};
  context.localRunnerToken = 1;
  // Neither ready-stability nor the poll period is what this fixture exercises. What matters
  // is the ordering it enforces: the control-plane latency before the first post-click sample
  // must exceed the generation window. Scaling both down keeps that ordering exact while
  // keeping the suite's real-timer footprint small.
  if (readyStableMs !== null) context.READY_STABLE_MS = readyStableMs;
  if (pollMs !== null) context.POLL_MS = pollMs;

  const run = newRun(
    repeatWorkflow(context, { repeat, maxSends: repeat + 1 }),
    conversationKey,
    "transient-generation"
  );
  activeRun = run;

  await context.executeRun(run, 1);
  return { run, sendCount, dom };
}

test("the acceptance watch latches a generation control that appears and is retired between samples", () => {
  const dom = createObservableDocument();
  const context = createRuntimeHarness(dom);
  let stopButtonVisible = false;
  const transaction = { active: true };

  context.startDeliveryAcceptanceWatch(transaction, () => (stopButtonVisible ? {} : null));
  assert.equal(transaction.generationSeen, false, "no generation may be latched before one starts");
  assert.equal(dom.observerCount(), 1, "the watch must observe the document while unlatched");

  // The whole generation happens between two of the runner's 300ms samples.
  stopButtonVisible = true;
  dom.notify();
  stopButtonVisible = false;
  dom.notify();

  assert.equal(transaction.generationSeen, true, "the transient generation edge must be latched");
  assert.equal(dom.observerCount(), 0, "the watch must disconnect as soon as it has latched");
});

test("the acceptance watch never latches without a generation control", () => {
  const dom = createObservableDocument();
  const context = createRuntimeHarness(dom);
  const transaction = { active: true };

  context.startDeliveryAcceptanceWatch(transaction, () => null);
  for (let i = 0; i < 10; i += 1) dom.notify();

  assert.equal(transaction.generationSeen, false, "absent evidence must never be latched");
  context.stopDeliveryAcceptanceWatch(transaction);
  assert.equal(dom.observerCount(), 0);
});

test("the acceptance watch is bounded and stops checking after its cap", () => {
  const dom = createObservableDocument();
  const context = createRuntimeHarness(dom);
  const transaction = { active: true };
  let checks = 0;

  context.startDeliveryAcceptanceWatch(transaction, () => { checks += 1; return null; });
  for (let i = 0; i < 3000; i += 1) dom.notify();

  assert.equal(transaction.generationSeen, false);
  assert.ok(checks <= 2048, `watch must stay bounded, ran ${checks} checks`);
});

test("a short reply whose generation ends before the first post-click observation is still confirmed", async () => {
  // The generation window (20ms) closes well before the runner can complete the durable
  // save plus the read-only run observation plus the lease renewal that precede its first
  // post-click sample (3 x 60ms).
  const { run, sendCount } = await runShortReplyDelivery({
    generationWindowMs: 20,
    controlPlaneLatencyMs: 60,
    pollMs: 60
  });

  assert.equal(sendCount, 1, "the irreversible send must happen exactly once");
  assert.equal(
    run.lastErrorCode,
    undefined,
    "a delivered send whose generation signal was transient must not become submission_ambiguous"
  );
  assert.equal(run.outbox, null, "the confirmed outbox must be cleared once the cursor advances");
  assert.equal(run.status, "completed");
  assert.equal(run.cursor.sendsCompleted, 1);
});

test("a long Repeat run delivers every send exactly once when every generation is transient", async () => {
  const { run, sendCount } = await runShortReplyDelivery({
    generationWindowMs: 10,
    controlPlaneLatencyMs: 30,
    repeat: 20,
    readyStableMs: 10,
    pollMs: 30
  });

  assert.equal(sendCount, 20, "Repeat=20 must click Send exactly twenty times");
  assert.equal(run.status, "completed");
  assert.equal(run.cursor.sendsCompleted, 20);
  assert.equal(run.lastErrorCode, undefined);
});

test("an undelivered send is still ambiguous when no acceptance evidence ever appears", async () => {
  const dom = createObservableDocument();
  const context = createRuntimeHarness(dom);
  const conversationKey = "chatgpt:c:never-generates";
  const composer = { text: "" };
  let sendCount = 0;

  const sendButton = {
    disabled: false,
    getAttribute() { return null; },
    click() {
      sendCount += 1;
      // The composer clears, but generation never starts: delivery is genuinely unproven.
      composer.text = "";
      dom.notify();
    }
  };

  context.ChatGptAdapter = withTextDeliveryTransaction({
    id: "chatgpt",
    getConversationKey: () => conversationKey,
    detectBlocker: () => null,
    getGenerationState: () => "idle",
    findComposer: () => composer,
    getComposerText: () => composer.text,
    getComposerAttachmentState: () => ({ known: true, count: 0 }),
    writePrompt: (text) => { composer.text = text; },
    findSendButton: () => sendButton,
    isGenerating: () => false
  }, context);

  let activeRun = null;
  context.sleep = async () => {};
  context.appendDiagnostic = async () => {};
  context.saveActiveRun = async (run) => { activeRun = run; };
  context.getActiveRun = async () => activeRun;
  context.acquireLease = async (key, runId, executionSessionId) => ({
    conversationKey: key,
    runId,
    executionSessionId,
    nonce: "lease-never"
  });
  context.renewLease = async () => true;
  context.releaseLease = async () => {};
  context.localRunnerToken = 1;
  context.ACK_TIMEOUT_MS = 0;

  const run = newRun(repeatWorkflow(context, { repeat: 1, maxSends: 2 }), conversationKey, "never-generates");
  activeRun = run;

  await context.executeRun(run, 1);

  assert.equal(sendCount, 1, "an ambiguous acknowledgement must never trigger an automatic retry");
  assert.equal(run.status, "paused");
  assert.equal(run.resumable, false);
  assert.equal(run.lastErrorCode, "submission_ambiguous");
  assert.equal(run.cursor.sendsCompleted, 0);
  assert.equal(run.outbox?.state, "submitted");
});

test("a delayed composer clear is confirmed without requiring both signals at one sample", async () => {
  const dom = createObservableDocument();
  const context = createRuntimeHarness(dom);
  const conversationKey = "chatgpt:c:delayed-clear";
  const composer = { text: "" };
  let sendCount = 0;
  let stopButtonVisible = false;

  const sendButton = {
    disabled: false,
    getAttribute() { return null; },
    click() {
      sendCount += 1;
      // Reverse ordering: generation starts and ends first, and the composer only
      // clears afterwards. Neither signal is ever true at the same instant.
      stopButtonVisible = true;
      dom.notify();
      setTimeout(() => {
        stopButtonVisible = false;
        dom.notify();
        setTimeout(() => { composer.text = ""; }, 200);
      }, 50);
    }
  };

  context.ChatGptAdapter = withTextDeliveryTransaction({
    id: "chatgpt",
    getConversationKey: () => conversationKey,
    detectBlocker: () => null,
    getGenerationState: () => (stopButtonVisible ? "generating" : "idle"),
    findComposer: () => composer,
    getComposerText: () => composer.text,
    getComposerAttachmentState: () => ({ known: true, count: 0 }),
    writePrompt: (text) => { composer.text = text; },
    findSendButton: () => sendButton,
    isGenerating: () => stopButtonVisible
  }, context);

  let activeRun = null;
  context.sleep = realSleep;
  context.appendDiagnostic = async () => {};
  context.saveActiveRun = async (run) => { activeRun = run; };
  context.getActiveRun = async () => activeRun;
  context.acquireLease = async (key, runId, executionSessionId) => ({
    conversationKey: key,
    runId,
    executionSessionId,
    nonce: "lease-delayed"
  });
  context.renewLease = async () => true;
  context.releaseLease = async () => {};
  context.localRunnerToken = 1;

  const run = newRun(repeatWorkflow(context, { repeat: 1, maxSends: 2 }), conversationKey, "delayed-clear");
  activeRun = run;

  await context.executeRun(run, 1);

  assert.equal(sendCount, 1);
  assert.equal(run.status, "completed");
  assert.equal(run.cursor.sendsCompleted, 1);
  assert.equal(run.lastErrorCode, undefined);
});

test("acceptance evidence from an earlier send cannot confirm a later one", async () => {
  const dom = createObservableDocument();
  const context = createRuntimeHarness(dom);
  const previous = { active: true, binding: { deliveryAttemptToken: "attempt-1", runId: "r", executionSessionId: "s", stepId: "single", stateRevision: 1, promptHash: "h", stepIndex: 0, repeatIndex: 0 } };

  context.startDeliveryAcceptanceWatch(previous, () => ({}));
  dom.notify();
  assert.equal(previous.generationSeen, true, "the earlier send observed its own generation");

  // A fresh transaction for the next send starts with no latched evidence, and the
  // adapter refuses to report the earlier transaction's evidence under a new binding.
  const next = { active: true, binding: { ...previous.binding, deliveryAttemptToken: "attempt-2", stateRevision: 2 } };
  assert.notEqual(next.generationSeen, true);
  assert.equal(
    context.ChatGptAdapter.hasObservedDeliveryGeneration(previous, next.binding),
    false,
    "evidence bound to a previous send must never be readable under a later binding"
  );
});
