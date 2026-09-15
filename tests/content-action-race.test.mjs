import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { productionComposerIsEffectivelyEmpty } from "./helpers/production-composer-semantics.mjs";
import { withTextDeliveryTransaction } from "./helpers/text-delivery-transaction.mjs";

const postCommitDiagnosticHarness = `
var testPostCommitDiagnosticInFlight = testPostCommitDiagnosticInFlight || null;
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
  new URL("../src/content-runner.js", import.meta.url),
  "utf8"
)}`;

function actionHarness({
  cancelOnGuard = null,
  draftOnGuard = null,
  finalRenewed = true,
  blockerOnCheck = null,
  initialComposerText = "",
  transformWrittenPrompt = (text) => text
} = {}) {
  let guardCount = 0;
  let writeCount = 0;
  let clickCount = 0;
  let renewCount = 0;
  let blockerChecks = 0;
  let composerText = String(initialComposerText);
  const composer = {};
  const sendButton = {
    disabled: false,
    getAttribute: () => null,
    click() { clickCount += 1; }
  };
  const adapter = withTextDeliveryTransaction({
    detectBlocker: () => {
      blockerChecks += 1;
      return blockerChecks === blockerOnCheck ? "ui-blocked" : null;
    },
    getConversationKey: () => "chatgpt:c:race",
    findComposer: () => composer,
    getComposerText: () => composerText,
    getComposerAttachmentState: () => ({ known: true, count: 0 }),
    writePrompt(text) {
      writeCount += 1;
      composerText = transformWrittenPrompt(text);
    },
    findSendButton: () => sendButton,
    getGenerationState: () => "idle",
    isGenerating: () => false
  });
  const context = vm.createContext({
    console,
    MAX_SENDS_PER_RUN: 50,
    localRunnerToken: 11,
    instanceId: "race-document",
    GENERATION_TIMEOUT_MS: 1_000,
    LEASE_HEARTBEAT_MS: 100,
    POLL_MS: 1,
    crypto: { randomUUID: () => "outbox-id" },
    nowIso: () => "2026-08-21T00:00:00.000Z",
    makeError(code) {
      const error = new Error(code);
      error.code = code;
      return error;
    },
    blockerToError: () => new Error("blocker"),
    sha256: async () => "prompt-hash",
    saveActiveRun: async () => {},
    appendDiagnostic: async () => {},
    waitUntilReady: async () => {},
    sleep: async () => {},
    composerIsEffectivelyEmpty: productionComposerIsEffectivelyEmpty,
    composerTextMatchesExpected: (expected, actual) => expected === actual,
    isConversationTransitionAllowed: (run, actualKey) => run?.conversationKey === actualKey,
    renewLease: async () => {
      renewCount += 1;
      return renewCount < 3 || finalRenewed;
    },
    ChatGptAdapter: adapter
  });
  vm.runInContext(source, context);
  context.assertRunCanContinue = async () => {
    guardCount += 1;
    if (guardCount === draftOnGuard) composerText = "user draft typed during await";
    if (guardCount === cancelOnGuard) context.localRunnerToken += 1;
  };
  return {
    context,
    counts: () => ({ guardCount, writeCount, clickCount, renewCount, blockerChecks, composerText })
  };
}

function makeRun() {
  return {
    runId: "race-run",
    executionSessionId: "session-test",
    conversationKey: "chatgpt:c:race",
    workflow: { maxSends: 1, steps: [step] },
    cursor: { sendsCompleted: 0, stepIndex: 0, repeatIndex: 0 },
    outbox: null
  };
}

const step = {
  id: "step-1",
  type: "prompt",
  delivery: "send",
  prompt: "safe prompt",
  repeat: 1
};
const lease = { conversationKey: "chatgpt:c:race", nonce: "lease", executionSessionId: "session-test" };

test("a control intent resolving with the final write guard prevents DOM mutation", async () => {
  const harness = actionHarness({ cancelOnGuard: 1 });
  await assert.rejects(
    harness.context.sendPromptSafely(makeRun(), step, lease, 11),
    (error) => error?.code === "user_stop"
  );
  assert.equal(harness.counts().writeCount, 0);
  assert.equal(harness.counts().clickCount, 0);
});

test("a user draft typed after the first empty check is preserved before Send preparation writes", async () => {
  const harness = actionHarness({ draftOnGuard: 2, cancelOnGuard: 3 });
  await assert.rejects(
    harness.context.sendPromptSafely(makeRun(), step, lease, 11),
    (error) => error?.code === "draft_present"
  );
  assert.equal(harness.counts().writeCount, 0);
  assert.equal(harness.counts().clickCount, 0);
  assert.equal(harness.counts().composerText, "user draft typed during await");
});

test("a control intent after submitting persistence prevents the irreversible click", async () => {
  const harness = actionHarness({ cancelOnGuard: 3 });
  await assert.rejects(
    harness.context.sendPromptSafely(makeRun(), step, lease, 11),
    (error) => error?.code === "user_stop"
  );
  assert.equal(harness.counts().writeCount, 1);
  assert.equal(harness.counts().clickCount, 0);
});

test("the click is blocked when the final serialized lease renewal fails", async () => {
  const harness = actionHarness({ finalRenewed: false });
  await assert.rejects(
    harness.context.sendPromptSafely(makeRun(), step, lease, 11),
    (error) => error?.code === "lease_conflict"
  );
  assert.equal(harness.counts().writeCount, 1);
  assert.equal(harness.counts().renewCount, 3);
  assert.equal(harness.counts().clickCount, 0);
});

test("a blocker that appears after submitting persistence prevents the irreversible click", async () => {
  const harness = actionHarness({ blockerOnCheck: 3 });
  await assert.rejects(
    harness.context.sendPromptSafely(makeRun(), step, lease, 11),
    /blocker/
  );
  assert.equal(harness.counts().writeCount, 1);
  assert.equal(harness.counts().blockerChecks, 3);
  assert.equal(harness.counts().clickCount, 0);
});

test("a composer verification mismatch prevents the irreversible click", async () => {
  const harness = actionHarness({ transformWrittenPrompt: (text) => `${text} altered` });
  await assert.rejects(
    harness.context.sendPromptSafely(makeRun(), step, lease, 11),
    (error) => error?.code === "composer_verification_failed"
  );
  assert.equal(harness.counts().writeCount, 1);
  assert.equal(harness.counts().clickCount, 0);
});

test("a control intent resolving with the Draft guard prevents composer writes", async () => {
  const harness = actionHarness({ cancelOnGuard: 1 });
  await assert.rejects(
    harness.context.prepareDraft(makeRun(), step, 11),
    (error) => error?.code === "user_stop"
  );
  assert.equal(harness.counts().writeCount, 0);
  assert.equal(harness.counts().clickCount, 0);
});

test("Draft delivery preserves user text typed after its first empty check", async () => {
  const harness = actionHarness({ draftOnGuard: 2, cancelOnGuard: 3 });
  await assert.rejects(
    harness.context.prepareDraft(makeRun(), step, 11),
    (error) => error?.code === "draft_present"
  );
  assert.equal(harness.counts().writeCount, 0);
  assert.equal(harness.counts().composerText, "user draft typed during await");
});

test("PDT5 draft path treats a minimal ProseMirror newline residue as effectively empty", async () => {
  const harness = actionHarness({ initialComposerText: "\n" });
  await harness.context.prepareDraft(makeRun(), step, 11);
  assert.equal(harness.counts().writeCount, 1);
  assert.equal(harness.counts().clickCount, 0);
  assert.equal(harness.counts().composerText, step.prompt);
});

test("generation stability wait renews the serialized lease before its TTL can expire", async () => {
  let clock = 0;
  let polls = 0;
  let renewCount = 0;
  class FakeDate extends Date {
    static now() { return clock; }
  }
  const run = { runId: "heartbeat-run", status: "running", conversationKey: "chatgpt:c:heartbeat" };
  const context = vm.createContext({
    console,
    Date: FakeDate,
    localRunnerToken: 3,
    LEASE_HEARTBEAT_MS: 5_000,
    POLL_MS: 5_000,
    GENERATION_TIMEOUT_MS: 30_000,
    READY_STABLE_MS: 0,
    getActiveRun: async () => run,
    isConversationTransitionAllowed: (candidate, actualKey) => candidate?.conversationKey === actualKey,
    renewLease: async () => {
      renewCount += 1;
      return true;
    },
    sleep: async (ms) => { clock += ms; },
    makeError(code) {
      const error = new Error(code);
      error.code = code;
      return error;
    },
    blockerToError: () => new Error("blocker"),
    ChatGptAdapter: {
      detectBlocker: () => null,
      getConversationKey: () => "chatgpt:c:heartbeat",
      getGenerationState: () => {
        polls += 1;
        return polls < 4 ? "generating" : "idle";
      }
    }
  });
  vm.runInContext(source, context);

  await context.waitForReadyStability(
    run,
    3,
    { conversationKey: "chatgpt:c:heartbeat", nonce: "lease", executionSessionId: "session-test" }
  );

  assert.equal(renewCount, 4);
  assert.equal(clock, 15_000);
});
