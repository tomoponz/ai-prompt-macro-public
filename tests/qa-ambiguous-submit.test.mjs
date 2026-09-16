import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { withTextDeliveryTransaction } from "./helpers/text-delivery-transaction.mjs";

const coreSource = fs.readFileSync(new URL("../src/content-core.js", import.meta.url), "utf8");
const runnerSource = fs.readFileSync(new URL("../src/content-runner.js", import.meta.url), "utf8");

function createRuntimeHarness() {
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
    location: { origin: "https://chatgpt.com", pathname: "/c/ambiguous" },
    document: {
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

test("ambiguous first submit in Repeat=3 never clicks a second time", async () => {
  const context = createRuntimeHarness();
  const conversationKey = "chatgpt:c:ambiguous";
  const composer = { text: "" };
  let sendCount = 0;

  const sendButton = {
    disabled: false,
    getAttribute() { return null; },
    click() {
      sendCount += 1;
      composer.text = "";
      // Adversarial case: the composer clears, but generation never becomes observable.
      // The runtime must treat this as ambiguous, not retry the same Repeat cursor.
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
  });

  let activeRun = null;
  context.sleep = async () => {};
  context.appendDiagnostic = async () => {};
  context.saveActiveRun = async (run) => { activeRun = run; };
  context.getActiveRun = async () => activeRun;
  context.acquireLease = async (key, runId, executionSessionId) => ({
    conversationKey: key,
    runId,
    executionSessionId,
    nonce: "lease-ambiguous"
  });
  context.renewLease = async () => true;
  context.releaseLease = async () => {};
  context.localRunnerToken = 1;
  context.ACK_TIMEOUT_MS = 0;

  const workflow = context.normalizeWorkflow({
    schemaVersion: 1,
    id: "qa-ambiguous-repeat",
    maxSends: 3,
    steps: [{
      id: "repeat",
      type: "prompt",
      delivery: "send",
      prompt: "continue",
      repeat: 3,
      delayAfterMs: 0
    }]
  });

  const run = {
    runId: "run-ambiguous-repeat",
    provider: "chatgpt",
    conversationKey,
    executionSessionId: "session-qa",
    contentVersion: "0.4.1",
    status: "running",
    phase: "ready",
    resumable: true,
    workflow,
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 },
    outbox: null,
    waitState: null
  };
  activeRun = run;

  await context.executeRun(run, 1);

  assert.equal(sendCount, 1, "ambiguous acknowledgement must never trigger an automatic retry");
  assert.equal(run.status, "paused");
  assert.equal(run.phase, "ambiguous");
  assert.equal(run.resumable, false);
  assert.equal(run.lastErrorCode, "submission_ambiguous");
  assert.equal(run.outbox?.state, "submitted");
  assert.equal(run.cursor.stepIndex, 0);
  assert.equal(run.cursor.repeatIndex, 0);
  assert.equal(run.cursor.sendsCompleted, 0);
});
