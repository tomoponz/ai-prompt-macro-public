import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { withTextDeliveryTransaction } from "./helpers/text-delivery-transaction.mjs";

const coreSource = fs.readFileSync(new URL("../src/content-core.js", import.meta.url), "utf8");
const runnerSource = fs.readFileSync(new URL("../src/content-runner.js", import.meta.url), "utf8");
const controllerSource = fs.readFileSync(new URL("../src/content-controller.js", import.meta.url), "utf8");

const DIAGNOSTICS_KEY = "aipm.diagnostics.v1";
const clone = (value) => value == null ? value : structuredClone(value);

function createHarness(options = {}) {
  const failDiagnosticTypes = new Set(options.failDiagnosticTypes ?? []);
  const neverSettleDiagnosticTypes = new Set(options.neverSettleDiagnosticTypes ?? []);
  let storedRun = clone(options.initialRun ?? null);
  let diagnostics = [];
  let clock = 1_000_000;
  let generationEndsAt = -1;
  let failedRunSet = false;
  let interruptedAfterConfirmed = false;
  let activeDiagnosticWrites = 0;
  let maxDiagnosticWrites = 0;
  let context;
  const page = { composerText: "", clicks: 0 };
  const diagnosticAttempts = [];
  const diagnosticEntries = [];
  const runSetAttempts = [];
  const pendingRunners = [];

  class FakeDate extends Date {
    static now() { return clock; }
  }

  const sendButton = {
    disabled: false,
    getAttribute() { return null; },
    click() {
      page.clicks += 1;
      page.composerText = "";
      generationEndsAt = clock + 5;
    }
  };
  const composer = { id: "composer" };

  const adapter = withTextDeliveryTransaction({
    id: "chatgpt",
    matches: () => true,
    getConversationKey: () => "chatgpt:c:delivery-certainty",
    detectBlocker: () => null,
    findComposer: () => composer,
    getComposerText: () => page.composerText,
    getComposerAttachmentState: () => ({ known: true, count: 0 }),
    writePrompt: (text) => { page.composerText = text; },
    findSendButton: () => sendButton,
    findStopButton: () => null,
    getGenerationState: () => clock < generationEndsAt ? "generating" : "idle",
    isGenerating: () => clock < generationEndsAt,
    isComposerWritable: () => true,
    readPageObservation() {
      return {
        composer,
        stopButton: null,
        blocker: null,
        generationState: this.getGenerationState()
      };
    }
  });

  context = vm.createContext({
    console,
    Date: FakeDate,
    setTimeout,
    clearTimeout,
    TextEncoder,
    crypto: {
      randomUUID: () => `uuid-${clock}-${page.clicks}`,
      subtle: webcrypto.subtle
    },
    __AIPM_CONTENT_CONTROLLER_READY__: true,
    localRunnerToken: 1,
    ChatGptAdapter: adapter,
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {}, remove() {} }),
      documentElement: { appendChild() {} }
    },
    chrome: {
      runtime: {
        async sendMessage(message) {
          switch (message.type) {
            case "AIPM_RUN_GET":
              return { ok: true, run: clone(storedRun) };
            case "AIPM_RUN_SET": {
              runSetAttempts.push(clone(message.run));
              if (options.neverSettleRunSet?.(message.run) === true) {
                return new Promise(() => {});
              }
              if (options.identityFailureOnRunSet?.(message.run) === true) {
                return {
                  ok: false,
                  errorCode: "DOCUMENT_IDENTITY_UNCONFIRMED",
                  error: "safe identity failure",
                  identityObservation: {
                    outcome: "unavailable",
                    reason: "timeout",
                    attempt: 3,
                    totalAttempts: 3,
                    durationMs: 512
                  }
                };
              }
              const shouldFail = !failedRunSet && options.failRunSet?.(message.run) === true;
              if (shouldFail) {
                failedRunSet = true;
                return { ok: false, error: "durable Run persistence unavailable" };
              }
              storedRun = clone(message.run);
              if (options.interruptAfterConfirmed === true && !interruptedAfterConfirmed &&
                  storedRun?.outbox?.state === "confirmed") {
                interruptedAfterConfirmed = true;
                context.localRunnerToken += 1;
              }
              return { ok: true, run: clone(storedRun) };
            }
            case "AIPM_LEASE_ACQUIRE":
              return {
                ok: true,
                lease: {
                  conversationKey: message.conversationKey,
                  nonce: "lease",
                  executionSessionId: message.executionSessionId
                }
              };
            case "AIPM_LEASE_RENEW":
              return { ok: true, renewed: true };
            case "AIPM_LEASE_RELEASE":
              return { ok: true };
            case "AIPM_RUN_FAIL_CLOSED":
              if (storedRun?.runId !== message.expectedRunId) {
                return { ok: false, error: "stale Run" };
              }
              storedRun = {
                ...storedRun,
                status: "paused",
                phase: "ambiguous",
                resumable: false,
                pauseReason: "document_identity_unconfirmed",
                lastErrorCode: "document_identity_unconfirmed"
              };
              return { ok: true, run: clone(storedRun) };
            default:
              return { ok: true };
          }
        },
        onMessage: { addListener() {} }
      },
      storage: {
        local: {
          async get(key) {
            if (key === DIAGNOSTICS_KEY) return { [DIAGNOSTICS_KEY]: clone(diagnostics) };
            return {};
          },
          async set(values) {
            if (!Object.hasOwn(values, DIAGNOSTICS_KEY)) return;
            const next = clone(values[DIAGNOSTICS_KEY]);
            const type = next.at(-1)?.type ?? null;
            diagnosticAttempts.push(type);
            diagnosticEntries.push(next.at(-1) ?? null);
            activeDiagnosticWrites += 1;
            maxDiagnosticWrites = Math.max(maxDiagnosticWrites, activeDiagnosticWrites);
            if (neverSettleDiagnosticTypes.has(type)) return new Promise(() => {});
            if (failDiagnosticTypes.has(type)) {
              activeDiagnosticWrites -= 1;
              throw new Error(`diagnostic storage failed: ${type}`);
            }
            diagnostics = next;
            activeDiagnosticWrites -= 1;
          }
        }
      }
    }
  });

  vm.runInContext(coreSource, context, { filename: "content-core.js" });
  vm.runInContext(runnerSource, context, { filename: "content-runner.js" });
  vm.runInContext(controllerSource, context, { filename: "content-controller.js" });

  context.ChatGptAdapter = adapter;
  context.renderStatusPill = () => {};
  context.nowIso = () => new Date(clock).toISOString();
  context.sleep = async (ms) => { clock += Math.max(1, Number(ms) || 0); };
  context.POLL_MS = 1;
  context.RUN_OBSERVATION_INTERVAL_MS = 1;
  context.READY_STABLE_MS = 0;

  const realExecuteRun = context.executeRun;
  context.executeRun = (...args) => {
    const result = Promise.resolve(realExecuteRun(...args));
    pendingRunners.push(result);
    return result;
  };

  return {
    context,
    page,
    diagnosticAttempts,
    diagnosticEntries,
    runSetAttempts,
    maxDiagnosticWrites: () => maxDiagnosticWrites,
    stored: () => clone(storedRun),
    setStored(run) { storedRun = clone(run); },
    async settle() {
      while (pendingRunners.length > 0) await pendingRunners.shift();
    },
    makeRun(repeat = 1) {
      const workflow = context.normalizeWorkflow({
        schemaVersion: 1,
        id: `delivery-certainty-${repeat}`,
        maxSends: repeat,
        steps: [{
          id: "prompt",
          type: "prompt",
          delivery: "send",
          prompt: "EDGE-TEST",
          repeat,
          delayAfterMs: 0
        }]
      });
      return {
        schemaVersion: 1,
        runId: `run-${repeat}`,
        provider: "chatgpt",
        conversationKey: adapter.getConversationKey(),
        documentInstanceId: context.instanceId,
        executionSessionId: "session-test",
        contentVersion: "0.4.0",
        boundTabId: 1,
        workflow,
        plannedSends: repeat,
        cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 },
        status: "running",
        phase: "ready",
        pauseReason: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        resumable: true,
        outbox: null,
        waitState: null
      };
    }
  };
}

test("confirmed diagnostic storage failure preserves certainty and advances each cursor exactly once", async () => {
  const harness = createHarness({ failDiagnosticTypes: ["send_confirmed"] });
  const run = harness.makeRun(2);
  harness.setStored(run);

  await harness.context.executeRun(run, harness.context.localRunnerToken);

  const stored = harness.stored();
  assert.equal(harness.page.clicks, 2, "Repeat=2 must still click exactly twice");
  assert.equal(stored.status, "completed");
  assert.equal(stored.phase, "completed");
  assert.equal(stored.cursor.sendsCompleted, 2);
  assert.equal(stored.cursor.stepIndex, 1);
  assert.equal(stored.outbox, null);
  assert.notEqual(stored.phase, "ambiguous");
  assert.equal(harness.diagnosticAttempts.filter((type) => type === "send_confirmed").length, 2);
});

test("completion diagnostic storage failure cannot demote a durable completed Run", async () => {
  const harness = createHarness({ failDiagnosticTypes: ["run_completed"] });
  const run = harness.makeRun(1);
  harness.setStored(run);

  await harness.context.executeRun(run, harness.context.localRunnerToken);

  const stored = harness.stored();
  assert.equal(harness.page.clicks, 1);
  assert.equal(stored.status, "completed");
  assert.equal(stored.phase, "completed");
  assert.equal(stored.cursor.sendsCompleted, 1);

  const reload = createHarness({ initialRun: stored });
  reload.context.recoveryStarted = false;
  await reload.context.recoverIfNeeded();
  await reload.settle();
  assert.equal(reload.stored().status, "completed");
  assert.equal(reload.page.clicks, 0, "a completed Run must not send after reload");
});

test("Stop remains terminal when run_stopped diagnostic storage fails", async () => {
  const harness = createHarness({ failDiagnosticTypes: ["run_stopped"] });
  const run = harness.makeRun(1);
  harness.setStored(run);

  const response = await harness.context.stopCurrentRun({
    type: "AIPM_STOP",
    serviceWorkerVersion: "0.4.0",
    executionSessionId: run.executionSessionId,
    expectedDocumentInstanceId: run.documentInstanceId,
    expectedConversationKey: run.conversationKey,
    expectedRunId: run.runId,
    expectedStateRevision: null
  });

  assert.equal(response.ok, true);
  const stopped = harness.stored();
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.phase, "stopped");
  assert.equal(stopped.pauseReason, "user-stop");

  const reload = createHarness({ initialRun: stopped });
  reload.context.recoveryStarted = false;
  await reload.context.recoverIfNeeded();
  await reload.settle();
  assert.equal(reload.stored().status, "stopped");
  assert.equal(reload.page.clicks, 0, "Stop must prevent reload recovery sends");
  const resume = await reload.context.resumeRun({
    type: "AIPM_RESUME",
    serviceWorkerVersion: "0.4.0",
    executionSessionId: stopped.executionSessionId,
    expectedDocumentInstanceId: reload.context.instanceId,
    expectedConversationKey: stopped.conversationKey,
    expectedRunId: stopped.runId,
    expectedStateRevision: null
  });
  assert.equal(resume.ok, false, "a stopped Run must not be resumable");
});

test("reload consumes a confirmed outbox once after its diagnostic failed", async () => {
  const first = createHarness({
    failDiagnosticTypes: ["send_confirmed"],
    interruptAfterConfirmed: true
  });
  const run = first.makeRun(1);
  first.setStored(run);

  await first.context.executeRun(run, first.context.localRunnerToken);

  const confirmed = first.stored();
  assert.equal(first.page.clicks, 1);
  assert.equal(confirmed.status, "running");
  assert.equal(confirmed.outbox?.state, "confirmed");
  assert.equal(confirmed.cursor.sendsCompleted, 0);

  const reload = createHarness({ initialRun: confirmed });
  reload.context.recoveryStarted = false;
  await reload.context.recoverIfNeeded();
  await reload.settle();

  const recovered = reload.stored();
  assert.equal(reload.page.clicks, 0, "confirmed recovery must not click Send again");
  assert.equal(recovered.cursor.sendsCompleted, 1);
  assert.equal(recovered.outbox, null);
  assert.equal(recovered.status, "completed");
});

test("authoritative confirmed persistence failure remains fail-closed and never retries", async () => {
  const harness = createHarness({
    failRunSet: (run) => run?.status === "running" && run?.phase === "generating" && run?.outbox?.state === "confirmed"
  });
  const run = harness.makeRun(1);
  harness.setStored(run);

  await harness.context.executeRun(run, harness.context.localRunnerToken);

  const stored = harness.stored();
  assert.equal(harness.page.clicks, 1, "a failed authoritative commit must never retry the click");
  assert.equal(stored.status, "paused");
  assert.equal(stored.phase, "ambiguous");
  assert.equal(stored.resumable, false);
  assert.equal(stored.lastErrorCode, "run_state_save_failed");
  assert.equal(stored.cursor.sendsCompleted, 0);

  const reload = createHarness({ initialRun: stored });
  reload.context.recoveryStarted = false;
  await reload.context.recoverIfNeeded();
  await reload.settle();
  assert.equal(reload.page.clicks, 0);
  assert.equal(reload.stored().phase, "ambiguous");
});

test("N1: never-settling confirmed diagnostic cannot block cursor progress or completion", async () => {
  const harness = createHarness({ neverSettleDiagnosticTypes: ["send_confirmed"] });
  const run = harness.makeRun(2);
  harness.setStored(run);

  await harness.context.executeRun(run, harness.context.localRunnerToken);

  const stored = harness.stored();
  assert.equal(harness.page.clicks, 2);
  assert.equal(stored.cursor.sendsCompleted, 2);
  assert.equal(stored.status, "completed");
  assert.equal(stored.outbox, null);
});

test("N2: never-settling completion diagnostic cannot block a terminal completed Run", async () => {
  const harness = createHarness({ neverSettleDiagnosticTypes: ["run_completed"] });
  const run = harness.makeRun(1);
  harness.setStored(run);

  await harness.context.executeRun(run, harness.context.localRunnerToken);

  assert.equal(harness.stored().status, "completed");
  assert.equal(harness.stored().phase, "completed");
  assert.equal(harness.stored().cursor.sendsCompleted, 1);
});

test("N3: never-settling Stop diagnostic cannot block the control response or terminal Stop", async () => {
  const harness = createHarness({ neverSettleDiagnosticTypes: ["run_stopped"] });
  const run = harness.makeRun(1);
  harness.setStored(run);

  const response = await harness.context.stopCurrentRun({
    type: "AIPM_STOP",
    serviceWorkerVersion: "0.4.0",
    executionSessionId: run.executionSessionId,
    expectedDocumentInstanceId: run.documentInstanceId,
    expectedConversationKey: run.conversationKey,
    expectedRunId: run.runId,
    expectedStateRevision: null
  });

  assert.equal(response.ok, true);
  assert.equal(harness.stored().status, "stopped");
  assert.equal(harness.stored().phase, "stopped");
  assert.equal(harness.page.clicks, 0);
});

test("N4: reload consumes confirmed delivery once after its diagnostic never settles", async () => {
  const first = createHarness({
    neverSettleDiagnosticTypes: ["send_confirmed"],
    interruptAfterConfirmed: true
  });
  const run = first.makeRun(1);
  first.setStored(run);

  await first.context.executeRun(run, first.context.localRunnerToken);
  const confirmed = first.stored();
  assert.equal(first.page.clicks, 1);
  assert.equal(confirmed.outbox?.state, "confirmed");
  assert.equal(confirmed.cursor.sendsCompleted, 0);

  const reload = createHarness({ initialRun: confirmed });
  reload.context.recoveryStarted = false;
  await reload.context.recoverIfNeeded();
  await reload.settle();

  assert.equal(reload.page.clicks, 0);
  assert.equal(reload.stored().cursor.sendsCompleted, 1);
  assert.equal(reload.stored().status, "completed");
});

test("N5: never-settling authoritative confirmed persistence remains awaited", async () => {
  const harness = createHarness({
    neverSettleRunSet: (run) => run?.phase === "generating" && run?.outbox?.state === "confirmed"
  });
  const run = harness.makeRun(1);
  harness.setStored(run);
  let settled = false;

  void harness.context.executeRun(run, harness.context.localRunnerToken).then(
    () => { settled = true; },
    () => { settled = true; }
  );
  const boundaryDeadline = Date.now() + 5_000;
  while (Date.now() < boundaryDeadline &&
      !harness.runSetAttempts.some((saved) => saved?.outbox?.state === "confirmed")) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(
    harness.runSetAttempts.some((saved) => saved?.outbox?.state === "confirmed"),
    true,
    "the test must reach the authoritative confirmed persistence boundary"
  );
  assert.equal(settled, false, "authoritative persistence must never be detached");
  assert.equal(harness.page.clicks, 1);
  assert.equal(harness.stored().outbox?.state, "submitted");
  assert.equal(harness.stored().cursor.sendsCompleted, 0);
});

test("N6: one never-settling post-commit diagnostic cannot create a pending backlog", async () => {
  const harness = createHarness({ neverSettleDiagnosticTypes: ["send_clicked"] });
  const run = harness.makeRun(3);
  harness.setStored(run);

  await harness.context.executeRun(run, harness.context.localRunnerToken);

  assert.equal(harness.page.clicks, 3);
  assert.equal(harness.stored().status, "completed");
  assert.equal(harness.stored().cursor.sendsCompleted, 3);
  assert.equal(
    harness.diagnosticAttempts.filter((type) => type === "send_clicked").length,
    1,
    "later post-commit diagnostics must be dropped while one write is unresolved"
  );
  assert.equal(harness.maxDiagnosticWrites(), 1, "diagnostic storage outstanding must remain bounded at one");
});

test("C2 I9: identity diagnostic rejection cannot alter the durable fail-closed authority result", async () => {
  const harness = createHarness({
    identityFailureOnRunSet: (run) => run?.phase === "prepared",
    failDiagnosticTypes: ["document_identity_unconfirmed"]
  });
  const run = harness.makeRun(1);
  harness.setStored(run);

  await harness.context.executeRun(run, harness.context.localRunnerToken);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.stored().status, "paused");
  assert.equal(harness.stored().phase, "ambiguous");
  assert.equal(harness.stored().resumable, false);
  assert.equal(harness.stored().pauseReason, "document_identity_unconfirmed");
  assert.equal(harness.runSetAttempts.length, 1, "diagnostic failure must not create another Run transition");
  assert.deepEqual(harness.diagnosticEntries.at(-1), {
    at: new Date(1_000_000).toISOString(),
    type: "document_identity_unconfirmed",
    runId: run.runId,
    phase: "ambiguous",
    reason: "timeout",
    status: "paused",
    boundary: "run-read",
    episodeId: "identity-unknown",
    outcome: "unavailable",
    attempt: 3,
    totalAttempts: 3,
    durationMs: 512,
    consecutiveUnavailable: 3,
    recoveryElapsedMs: 512,
    failureCode: "IDENTITY_PROBE_TIMEOUT",
    identitySource: "probe"
  });
});

test("C2 I10: never-settling identity diagnostic cannot hold control or create a pending backlog", async () => {
  const harness = createHarness({
    identityFailureOnRunSet: (run) => run?.phase === "prepared",
    neverSettleDiagnosticTypes: ["document_identity_unconfirmed"]
  });
  const run = harness.makeRun(1);
  harness.setStored(run);
  let settled = false;

  await harness.context.executeRun(run, harness.context.localRunnerToken).then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  const admittedAgain = harness.context.appendPostCommitDiagnostic("document_identity_unconfirmed", {
    reason: "unknown",
    outcome: "unavailable",
    attempt: 3,
    totalAttempts: 3,
    durationMs: 500
  });

  assert.equal(settled, true, "the fail-closed control path must not await observability");
  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.stored().status, "paused");
  assert.equal(harness.stored().phase, "ambiguous");
  assert.equal(admittedAgain, false, "a pending diagnostic must coalesce later writes");
  assert.equal(harness.diagnosticAttempts.length, 1);
  assert.equal(harness.maxDiagnosticWrites(), 1);
});
