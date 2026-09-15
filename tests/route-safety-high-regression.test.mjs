import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { productionComposerIsEffectivelyEmpty } from "./helpers/production-composer-semantics.mjs";
import { withTextDeliveryTransaction } from "./helpers/text-delivery-transaction.mjs";

const readSource = (path) => fs
  .readFileSync(new URL(path, import.meta.url), "utf8")
  .replace(/\r\n?/g, "\n");

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
const runnerSource = `${postCommitDiagnosticHarness}\n${readSource("../src/content-runner.js")}`;
const controllerSource = `${postCommitDiagnosticHarness}\n${readSource("../src/content-controller.js")}`;
const backgroundSource = readSource("../src/background.js");
const coreSource = readSource("../src/content-core.js");

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

function unknownIdentityError() {
  const error = new Error("conversation_identity_unknown");
  error.code = "conversation_identity_unknown";
  return error;
}

function extractedFunction(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} must be locatable`);
  return source.slice(start, end);
}

function failClosedBackgroundHarness(initialRun) {
  const tabId = 77;
  const key = `run-${tabId}`;
  let durableRun = clone(initialRun);
  let documentProbeCalls = 0;

  const context = vm.createContext({
    console,
    EXTENSION_VERSION: "0.4.0",
    activeRunKey: (id) => `run-${id}`,
    serializeRunState: async (_id, operation) => operation(),
    nextStateRevision: (run) => Number(run?.stateRevision ?? 0) + 1,
    reconcilePowerAfterMutation: async () => null,
    senderOwnsCurrentTopDocument: async () => {
      documentProbeCalls += 1;
      throw new Error("document probe unavailable");
    },
    readCurrentTopDocument: async () => {
      documentProbeCalls += 1;
      throw new Error("document probe unavailable");
    },
    chrome: {
      storage: {
        local: {
          async get(requestedKey) {
            assert.equal(requestedKey, key);
            return durableRun ? { [key]: clone(durableRun) } : {};
          },
          async set(entries) {
            if (entries[key]) durableRun = clone(entries[key]);
          }
        }
      }
    }
  });

  vm.runInContext(
    extractedFunction(
      backgroundSource,
      "async function failClosedRunForTab",
      "\nasync function requireNewChatConfirmationForTab"
    ),
    context
  );

  return {
    context,
    tabId,
    stored: () => clone(durableRun),
    probeCalls: () => documentProbeCalls
  };
}

test("HIGH-1: fail-closed Run stop is durable even when the top-document probe is unavailable", async () => {
  const harness = failClosedBackgroundHarness({
    runId: "run-A",
    executionSessionId: "session-test",
    conversationKey: "chatgpt:c:A",
    status: "running",
    phase: "ready",
    resumable: true,
    stateRevision: 8,
    cursor: { stepIndex: 1, repeatIndex: 0, sendsCompleted: 1 }
  });

  const response = await harness.context.failClosedRunForTab(harness.tabId, {
    type: "AIPM_RUN_FAIL_CLOSED",
    serviceWorkerVersion: "0.4.0",
    expectedRunId: "run-A"
  });

  assert.equal(response.ok, true);
  assert.equal(harness.probeCalls(), 0, "identity fail-closed must not depend on a document probe");
  assert.equal(harness.stored().status, "paused");
  assert.equal(harness.stored().phase, "ambiguous");
  assert.equal(harness.stored().resumable, false);
  assert.equal(harness.stored().pauseReason, "conversation-identity-unknown");
  assert.equal(harness.stored().stateRevision, 9);
});

test("HIGH-1: stale exact-run caller cannot stop a different Run and the safety API has no send authority", async () => {
  const harness = failClosedBackgroundHarness({
    runId: "new-run",
    status: "running",
    phase: "ready",
    resumable: true,
    stateRevision: 1
  });

  const response = await harness.context.failClosedRunForTab(harness.tabId, {
    serviceWorkerVersion: "0.4.0",
    expectedRunId: "old-run"
  });

  assert.equal(response.ok, true);
  assert.equal(response.staleRun, true);
  assert.equal(harness.stored().status, "running");
  const body = extractedFunction(
    backgroundSource,
    "async function failClosedRunForTab",
    "\nasync function requireNewChatConfirmationForTab"
  );
  assert.doesNotMatch(body, /senderOwnsCurrentTopDocument|readCurrentTopDocument|conversationCompatible/);
  assert.doesNotMatch(body, /tabs\.sendMessage|AIPM_LEASE_ACQUIRE|click\(/);
});

function controllerContext({ conversationKey, durableRun, failClosed }) {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    __AIPM_CONTENT_CONTROLLER_READY__: true,
    __AIPM_CONTENT_CORE__: { version: "0.4.0", ready: true },
    instanceId: "document-instance",
    recoveryStarted: false,
    localRunnerToken: 0,
    startInFlight: false,
    activeRunnerRunId: durableRun?.runId ?? null,
    activeRunnerToken: 1,
    activeRunnerExecutionSessionId: durableRun?.executionSessionId ?? "session-test",
    alarmWakeResolvers: new Map(),
    STATUS_PILL_ID: "aipm-status-pill",
    DIAGNOSTICS_KEY: "diagnostics",
    ChatGptAdapter: {
      id: "chatgpt",
      getConversationKey: conversationKey,
      detectBlocker: () => null
    },
    failClosedRunWithoutIdentity: failClosed,
    chrome: {
      runtime: { async sendMessage() { return { ok: true, run: clone(durableRun) }; } },
      storage: { local: { async get() { return {}; } } }
    }
  });
  vm.runInContext(controllerSource, context);
  return context;
}

test("HIGH-1: /c/A -> unknown -> /c/A reload cannot revive stale running state", async () => {
  let durableRun = {
    runId: "run-A",
    provider: "chatgpt",
    executionSessionId: "session-test",
    conversationKey: "chatgpt:c:A",
    status: "running",
    phase: "ready",
    resumable: true,
    outbox: null,
    cursor: { stepIndex: 1, repeatIndex: 0, sendsCompleted: 1 }
  };
  let failClosedCalls = 0;

  const unknown = controllerContext({
    conversationKey: () => { throw unknownIdentityError(); },
    durableRun,
    failClosed: async (expectedRunId) => {
      failClosedCalls += 1;
      assert.equal(expectedRunId, "run-A");
      durableRun = {
        ...durableRun,
        status: "paused",
        phase: "ambiguous",
        resumable: false,
        pauseReason: "conversation-identity-unknown"
      };
      return clone(durableRun);
    }
  });

  await assert.rejects(
    unknown.getActiveRun(),
    (error) => error?.code === "conversation_identity_unknown"
  );
  assert.equal(failClosedCalls, 1);
  assert.notEqual(durableRun.status, "running");

  let executeCount = 0;
  let sendClicks = 0;
  const reloaded = controllerContext({
    conversationKey: () => "chatgpt:c:A",
    durableRun,
    failClosed: async () => { throw new Error("must not be needed"); }
  });
  reloaded.getActiveRun = async () => clone(durableRun);
  reloaded.renderStatusPill = () => {};
  reloaded.executeRun = () => { executeCount += 1; sendClicks += 1; };

  await reloaded.recoverActiveRun();
  assert.equal(executeCount, 0, "full reload must not auto-resume the fail-closed Run");
  assert.equal(sendClicks, 0, "full reload must produce zero Send clicks");
});

function newChatSendHarness({ startKey, routeAfterClick = null } = {}) {
  let currentKey = startKey;
  let composerText = "";
  let clickCount = 0;
  let canonicalLeaseAcquires = 0;
  const saves = [];
  let run = null;

  const composer = {};
  const sendButton = {
    disabled: false,
    getAttribute: () => null,
    click() {
      clickCount += 1;
      composerText = "";
      if (routeAfterClick) currentKey = routeAfterClick;
    }
  };

  const context = vm.createContext({
    console,
    MAX_SENDS_PER_RUN: 50,
    localRunnerToken: 11,
    instanceId: "new-chat-document",
    GENERATION_TIMEOUT_MS: 1_000,
    ACK_TIMEOUT_MS: 100,
    LEASE_HEARTBEAT_MS: 100,
    READY_STABLE_MS: 0,
    POLL_MS: 1,
    crypto: { randomUUID: () => "outbox-id" },
    __AIPM_CONTENT_CORE__: { version: "0.4.0", ready: true },
    nowIso: () => "2026-08-22T00:00:00.000Z",
    makeError(code) {
      const error = new Error(code);
      error.code = code;
      return error;
    },
    blockerToError: () => new Error("blocker"),
    sha256: async () => "prompt-hash",
    saveActiveRun: async (value) => { saves.push(clone(value)); },
    appendDiagnostic: async () => {},
    sleep: async () => {},
    composerIsEffectivelyEmpty: productionComposerIsEffectivelyEmpty,
    composerTextMatchesExpected: (expected, actual) => expected === actual,
    isConversationTransitionAllowed: (value, actualKey) => value?.conversationKey === actualKey,
    renewLease: async () => true,
    acquireLease: async (conversationKey) => {
      if (String(conversationKey).startsWith("chatgpt:c:")) canonicalLeaseAcquires += 1;
      return { conversationKey, nonce: "lease", executionSessionId: "session-test" };
    },
    releaseLease: async () => {},
    chrome: {
      runtime: {
        async sendMessage(message) {
          if (message.type === "AIPM_RUN_NEW_CHAT_CONFIRM_REQUIRED") {
            return {
              ok: true,
              run: {
                ...clone(run),
                status: "paused",
                phase: "new-chat-confirmation-required",
                resumable: false,
                pauseReason: "new-chat-confirmation-required",
                lastErrorCode: "new-chat-confirmation-required",
                outbox: {
                  ...clone(run.outbox),
                  state: "submitted",
                  submittedAt: "2026-08-22T00:00:00.001Z"
                }
              }
            };
          }
          if (message.type === "AIPM_RUN_FAIL_CLOSED") {
            return { ok: true, run: { ...clone(run), status: "paused", resumable: false } };
          }
          return { ok: true };
        }
      }
    },
    ChatGptAdapter: {
      getConversationKey: () => currentKey,
      detectBlocker: () => null,
      findComposer: () => composer,
      getComposerText: () => composerText,
      getComposerAttachmentState: () => ({ known: true, count: 0 }),
      writePrompt(text) { composerText = text; },
      findSendButton: () => sendButton,
      getGenerationState: () => clickCount === 0 ? "idle" : "generating",
      isGenerating: () => clickCount > 0
    }
  });
  context.ChatGptAdapter = withTextDeliveryTransaction(context.ChatGptAdapter);
  vm.runInContext(runnerSource, context);
  context.waitUntilReady = async () => {};
  context.assertRunCanContinue = async () => {};

  const step = {
    id: "step-1",
    type: "prompt",
    delivery: "send",
    prompt: "first prompt",
    repeat: 1
  };
  run = {
    runId: "new-chat-run",
    executionSessionId: "session-test",
    conversationKey: startKey,
    workflow: { maxSends: 2, steps: [step] },
    cursor: { sendsCompleted: 0, stepIndex: 0, repeatIndex: 0 },
    outbox: null
  };

  return {
    context,
    run,
    lease: { conversationKey: startKey, nonce: "new-chat-lease", executionSessionId: "session-test" },
    step,
    clicks: () => clickCount,
    canonicalLeaseAcquires: () => canonicalLeaseAcquires,
    saves
  };
}

for (const scenario of [
  ["root New Chat remains one-shot after its normal canonical route appears", "chatgpt:new:root:doc", "chatgpt:c:newly-created"],
  ["root New Chat does not auto-adopt a programmatic existing conversation", "chatgpt:new:root:doc", "chatgpt:c:existing"],
  ["Project New Chat remains one-shot after a canonical route appears", "chatgpt:new:project:g-p-one:doc", "chatgpt:c:project-conversation"],
  ["browser back/forward cannot cause New Chat auto-migration", "chatgpt:new:root:doc", "chatgpt:c:history-target"]
]) {
  test(`HIGH-2: ${scenario[0]}`, async () => {
    const harness = newChatSendHarness({ startKey: scenario[1], routeAfterClick: scenario[2] });

    await assert.rejects(
      harness.context.sendPromptSafely(harness.run, harness.step, harness.lease, 11),
      (error) => error?.code === "user_stop"
    );

    assert.equal(harness.clicks(), 1, "the first New Chat Send is allowed exactly once");
    assert.equal(harness.canonicalLeaseAcquires(), 0, "no canonical lease may be acquired automatically");
    assert.match(harness.run.conversationKey, /^chatgpt:new:/, "automatic execution must retain the New Chat identity");
    assert.equal(harness.run.status, "paused");
    assert.equal(harness.run.phase, "new-chat-confirmation-required");
    assert.equal(harness.run.pauseReason, "new-chat-confirmation-required");
    assert.equal(harness.run.outbox.state, "submitted");
  });
}

test("HIGH-2: trusted-input and Navigation API proof machinery is completely removed", () => {
  assert.doesNotMatch(runnerSource, /globalThis\.navigation|NavigateEvent|beginSubmitNavigationProof|reconcileSubmitNavigation/);
  assert.doesNotMatch(runnerSource, /pointerdown|touchstart|userInitiated|navigationType|migrationProof/);
  assert.doesNotMatch(coreSource, /navigation-api-programmatic/);
});

test("HIGH-2: background has no generic New Chat -> canonical compatibility path", () => {
  const body = extractedFunction(
    backgroundSource,
    "function conversationCompatible",
    "\n\n// Reads the tab's current top document"
  );
  assert.match(body, /run\.conversationKey !== currentConversationKey/);
  assert.doesNotMatch(body, /submitted|confirmed/);
  assert.doesNotMatch(body, /startsWith\("chatgpt:c:"\)/);
});

function confirmationRun() {
  return {
    runId: "confirmation-run",
    provider: "chatgpt",
    executionSessionId: "session-test",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:new:root:old-document",
    status: "paused",
    phase: "new-chat-confirmation-required",
    pauseReason: "new-chat-confirmation-required",
    resumable: false,
    workflow: {
      maxSends: 2,
      steps: [
        { id: "first", type: "prompt", delivery: "send", prompt: "first", repeat: 1, delayAfterMs: 0 },
        { id: "second", type: "prompt", delivery: "send", prompt: "second", repeat: 1, delayAfterMs: 0 }
      ]
    },
    cursor: { sendsCompleted: 0, stepIndex: 0, repeatIndex: 0 },
    outbox: { id: "outbox", stepId: "first", state: "submitted", promptHash: "hash" },
    waitState: null
  };
}

test("HIGH-2: reload on canonical route keeps confirmation-required Run paused with zero auto-send", async () => {
  const run = confirmationRun();
  let executeCount = 0;
  const context = controllerContext({
    conversationKey: () => "chatgpt:c:current",
    durableRun: run,
    failClosed: async () => null
  });
  context.getActiveRun = async () => clone(run);
  context.renderStatusPill = () => {};
  context.executeRun = () => { executeCount += 1; };

  await context.recoverActiveRun();
  assert.equal(executeCount, 0);
  assert.equal(run.status, "paused");
  assert.equal(run.cursor.sendsCompleted, 0);
});

test("HIGH-2: explicit Resume is the only path that adopts the canonical target and counts the first Send", async () => {
  const run = confirmationRun();
  let confirmMessage = null;
  let savedRun = null;
  let executeCount = 0;

  const context = controllerContext({
    conversationKey: () => "chatgpt:c:confirmed-by-user",
    durableRun: run,
    failClosed: async () => null
  });
  context.getActiveRun = async () => run;
  context.currentStep = (value) => value.workflow.steps[value.cursor.stepIndex] ?? null;
  context.advanceCursor = (value, wasSend) => {
    if (wasSend) value.cursor.sendsCompleted += 1;
    value.cursor.stepIndex += 1;
    value.cursor.repeatIndex = 0;
  };
  context.postSendDelayFence = () => null;
  context.saveActiveRun = async (value) => { savedRun = clone(value); };
  context.appendDiagnostic = async () => {};
  context.executeRun = () => { executeCount += 1; };
  context.ChatGptAdapter.detectBlocker = () => null;
  context.chrome.runtime.sendMessage = async (message) => {
    if (message.type !== "AIPM_RUN_CONFIRM_NEW_CHAT_TARGET") return { ok: true };
    confirmMessage = clone(message);
    return {
      ok: true,
      run: {
        ...clone(run),
        conversationKey: message.conversationKey,
        documentInstanceId: message.documentInstanceId
      }
    };
  };

  const response = await context.resumeRun({
    type: "AIPM_RESUME",
    serviceWorkerVersion: "0.4.0",
    executionSessionId: "session-test",
    expectedDocumentInstanceId: "document-instance",
    expectedConversationKey: "chatgpt:c:confirmed-by-user",
    expectedRunId: "confirmation-run",
    expectedStateRevision: run.stateRevision ?? null
  });

  assert.equal(response.ok, true);
  assert.equal(confirmMessage.conversationKey, "chatgpt:c:confirmed-by-user");
  assert.equal(confirmMessage.expectedRunId, "confirmation-run");
  assert.equal(savedRun.conversationKey, "chatgpt:c:confirmed-by-user");
  assert.equal(savedRun.status, "running");
  assert.equal(savedRun.cursor.sendsCompleted, 1, "explicit confirmation counts the already-clicked first Send exactly once");
  assert.equal(savedRun.cursor.stepIndex, 1);
  assert.equal(savedRun.outbox, null);
  assert.equal(executeCount, 1, "only explicit Resume may restart the workflow on the canonical target");
});

test("safety baseline keeps ambiguous submits non-retriable and same-conversation leases exact", () => {
  assert.match(runnerSource, /"submission_ambiguous"/);
  assert.match(runnerSource, /\["submitted", "confirmed"\]\.includes\(run\?\.outbox\?\.state\)/);
  assert.match(backgroundSource, /function leaseStorageKey\(conversationKey\) \{\s*return `\$\{LEASE_KEY_PREFIX\}\$\{encodeURIComponent\(conversationKey\)\}`;/);
  assert.match(coreSource, /function isConversationTransitionAllowed\(run, actualKey\) \{\s*return run\?\.conversationKey === actualKey;/);
});
