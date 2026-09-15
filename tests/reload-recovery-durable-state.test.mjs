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
const runnerSource = `${postCommitDiagnosticHarness}\n${fs.readFileSync(
  new URL("../src/content-runner.js", import.meta.url),
  "utf8"
)}`;
const controllerSource = fs.readFileSync(new URL("../src/content-controller.js", import.meta.url), "utf8");

const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

const DELAY_AFTER_MS = 15_000;

function repeatFiveWorkflow() {
  return {
    schemaVersion: 1,
    id: "quick-repeat-five",
    maxSends: 5,
    plannedSends: 5,
    steps: [{
      id: "quick-repeat-five",
      type: "prompt",
      delivery: "send",
      prompt: "continue",
      repeat: 5,
      delayAfterMs: DELAY_AFTER_MS
    }]
  };
}

function repeatFiveRun(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: "reload-repeat-five",
    provider: "chatgpt",
    conversationKey: "chatgpt:c:project-conversation",
    documentInstanceId: "old-document-instance",
    executionSessionId: "session-test",
    contentVersion: "0.4.0",
    replacesRunId: null,
    boundTabId: 215,
    keepAwake: false,
    workflow: repeatFiveWorkflow(),
    plannedSends: 5,
    cursor: { stepIndex: 0, repeatIndex: 1, sendsCompleted: 1 },
    status: "running",
    phase: "ready",
    pauseReason: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    resumable: true,
    outbox: null,
    waitState: null,
    checkpointLabel: null,
    startedAt: "2026-08-21T10:00:00.000Z",
    updatedAt: "2026-08-21T10:00:15.000Z",
    ...clone(overrides)
  };
}

function outboxAt(state, extra = {}) {
  return {
    id: "outbox-repeat-2",
    stepId: "quick-repeat-five",
    promptHash: "hash:continue",
    position: { stepIndex: 0, repeatIndex: 1, sendsCompleted: 1 },
    state,
    preparedAt: "2026-08-21T10:00:15.000Z",
    ...extra
  };
}

// ---------------------------------------------------------------------------
// Recovery harness: exercises the real recoverIfNeeded() against a durable
// snapshot, with executeRun() stubbed so we can observe what recovery hands to
// the runner without running the runner itself.
// ---------------------------------------------------------------------------
function createRecoveryHarness(snapshot, options = {}) {
  const { onReadyStability = null, rejectStoppedRevival = false } = options;
  let storedRun = clone(snapshot);
  const executedRuns = [];
  const counters = { execute: 0, pause: 0, save: 0, lease: 0, readyWait: 0, saveConflict: 0 };

  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    recoveryStarted: false,
    localRunnerToken: 0,
    instanceId: "new-document-instance",
    MAX_SENDS_PER_RUN: 50,
    __AIPM_CONTENT_CONTROLLER_READY__: true,
    composerIsEffectivelyEmpty: productionComposerIsEffectivelyEmpty,
    crypto: { randomUUID: () => "recovery-uuid" },
    sha256: async (text) => `hash:${text}`,
    ChatGptAdapter: {
      id: "chatgpt",
      getConversationKey: () => "chatgpt:c:project-conversation",
      detectBlocker: () => null
    },
    chrome: {
      runtime: {
        async sendMessage() { return { ok: true, run: clone(storedRun) }; }
      },
      storage: { local: { async get() { return {}; } } }
    }
  });

  vm.runInContext(runnerSource, context, { filename: "content-runner.js" });
  vm.runInContext(controllerSource, context, { filename: "content-controller.js" });

  context.nowIso = () => "2026-08-21T10:00:30.000Z";
  context.renderStatusPill = () => {};
  context.appendDiagnostic = async () => {};
  context.makeError = (code) => {
    const error = new Error(code);
    error.code = code;
    return error;
  };
  context.getActiveRun = async () => clone(storedRun);
  context.saveActiveRun = async (run) => {
    counters.save += 1;
    if (rejectStoppedRevival && storedRun?.status === "stopped" && run.status !== "stopped") {
      counters.saveConflict += 1;
      const error = new Error("新しいPause/Stop/完了状態を古いrunner更新で上書きできません。");
      error.code = "run_state_conflict";
      throw error;
    }
    storedRun = clone(run);
  };
  context.pauseRun = async (run, reason, phase = "paused") => {
    counters.pause += 1;
    run.status = "paused";
    run.phase = phase;
    run.pauseReason = reason;
    await context.saveActiveRun(run);
  };
  context.acquireLease = async (conversationKey, _runId, executionSessionId) => {
    counters.lease += 1;
    return { conversationKey, executionSessionId, nonce: "reload-lease" };
  };
  context.releaseLease = async () => {};
  context.waitForReadyStability = async (run, token) => {
    counters.readyWait += 1;
    if (onReadyStability) await onReadyStability({ run, token, context, stop: () => { storedRun = { ...storedRun, status: "stopped", phase: "stopped", pauseReason: "user-stop", waitState: null }; } });
  };
  context.executeRun = (run) => {
    counters.execute += 1;
    executedRuns.push(clone(run));
  };

  return {
    context,
    recover: () => context.recoverIfNeeded(),
    stored: () => clone(storedRun),
    executed: () => clone(executedRuns),
    counters
  };
}

// ---------------------------------------------------------------------------
// A. phase="prepared" + outbox.state="prepared" is a provable pre-submit
//    checkpoint: the durable write happens before the composer write, and the
//    click happens strictly after the acknowledged phase="submitting" write.
// ---------------------------------------------------------------------------
test("A: a prepared pre-submit checkpoint resumes the same repeat without duplicating a send", async () => {
  const snapshot = repeatFiveRun({ phase: "prepared", outbox: outboxAt("prepared") });
  const harness = createRecoveryHarness(snapshot);

  await harness.recover();

  const stored = harness.stored();
  const executed = harness.executed()[0];
  assert.equal(harness.counters.pause, 0, "a provably unclicked checkpoint must not fail closed");
  assert.notEqual(stored.lastErrorCode, "recovery_ambiguous");
  assert.equal(stored.status, "running");
  assert.equal(stored.outbox, null, "the unclicked outbox must be discarded, not replayed as delivery state");
  assert.equal(harness.counters.execute, 1, "recovery must resume exactly one runner");
  assert.deepEqual(
    executed.cursor,
    snapshot.cursor,
    "the same logical send position is retried; the cursor must never advance from an unsent prepare"
  );
  assert.equal(executed.cursor.sendsCompleted, 1, "sendsCompleted must not be rolled forward by an unsent prepare");
  assert.equal(executed.outbox, null);
});

// ---------------------------------------------------------------------------
// B. phase="submitting" + outbox.state="prepared" straddles the irreversible
//    click, so it can never be auto-retried.
// ---------------------------------------------------------------------------
test("B: a submitting/prepared snapshot straddles the click and stays fail-closed", async () => {
  const snapshot = repeatFiveRun({ phase: "submitting", outbox: outboxAt("prepared") });
  const harness = createRecoveryHarness(snapshot);

  await harness.recover();

  const stored = harness.stored();
  assert.equal(stored.status, "paused");
  assert.equal(stored.phase, "ambiguous");
  assert.equal(stored.lastErrorCode, "recovery_ambiguous");
  assert.equal(stored.resumable, false);
  assert.equal(harness.counters.execute, 0, "an ambiguous submit must never be resent automatically");
  assert.deepEqual(stored.cursor, snapshot.cursor, "an ambiguous submit must not advance the cursor");
});

// ---------------------------------------------------------------------------
// C. outbox.state="submitted" is always fail-closed.
// ---------------------------------------------------------------------------
for (const [name, snapshot] of [
  ["waiting-ack", repeatFiveRun({ phase: "waiting-ack", outbox: outboxAt("submitted", { submittedAt: "2026-08-21T10:00:15.100Z" }) })],
  ["submitting", repeatFiveRun({ phase: "submitting", outbox: outboxAt("submitted", { submittedAt: "2026-08-21T10:00:15.100Z" }) })]
]) {
  test(`C: a submitted outbox (${name}) stays fail-closed after reload`, async () => {
    const harness = createRecoveryHarness(snapshot);

    await harness.recover();

    const stored = harness.stored();
    assert.equal(stored.status, "paused");
    assert.equal(stored.phase, "ambiguous");
    assert.equal(stored.lastErrorCode, "recovery_ambiguous");
    assert.equal(stored.resumable, false);
    assert.equal(harness.counters.execute, 0);
    assert.deepEqual(stored.cursor, snapshot.cursor);
  });
}

// ---------------------------------------------------------------------------
// D. outbox.state="confirmed" is consumed exactly once.
// ---------------------------------------------------------------------------
test("D: a confirmed outbox is consumed exactly once and never resent", async () => {
  const snapshot = repeatFiveRun({
    phase: "generating",
    outbox: outboxAt("confirmed", { submittedAt: "2026-08-21T10:00:15.100Z", confirmedAt: "2026-08-21T10:00:15.200Z" })
  });
  const harness = createRecoveryHarness(snapshot);

  await harness.recover();

  const stored = harness.stored();
  const executed = harness.executed()[0];
  assert.equal(harness.counters.lease, 1);
  assert.equal(harness.counters.readyWait, 1);
  assert.equal(harness.counters.pause, 0);
  assert.equal(harness.counters.execute, 1);
  assert.equal(stored.outbox, null);
  assert.equal(stored.cursor.sendsCompleted, 2, "a confirmed send counts exactly once");
  assert.equal(stored.cursor.repeatIndex, 2);
  assert.equal(executed.cursor.sendsCompleted, 2, "the resumed runner must not replay the confirmed repeat");
  assert.equal(executed.waitState?.kind, "delay", "the delayAfter fence must be armed for the consumed send");
  assert.equal(executed.waitState?.scope, "after-send");
});

test("D: the recovery guard cannot consume the same confirmed outbox twice", async () => {
  const harness = createRecoveryHarness(repeatFiveRun({
    phase: "generating",
    outbox: outboxAt("confirmed", { confirmedAt: "2026-08-21T10:00:15.200Z" })
  }));

  await Promise.all([harness.recover(), harness.recover()]);

  assert.equal(harness.counters.execute, 1);
  assert.equal(harness.stored().cursor.sendsCompleted, 2);
});

// ---------------------------------------------------------------------------
// E. A persisted delayAfter deadline survives reload.
// ---------------------------------------------------------------------------
test("E: recovery hands the persisted delay fence to the runner instead of dropping it", async () => {
  const until = Date.now() + DELAY_AFTER_MS;
  const snapshot = repeatFiveRun({
    phase: "delay",
    outbox: null,
    waitState: { kind: "delay", scope: "after-send", stepId: "quick-repeat-five", stepIndex: 0, repeatIndex: 1, until }
  });
  const harness = createRecoveryHarness(snapshot);

  await harness.recover();

  const executed = harness.executed()[0];
  assert.equal(harness.counters.execute, 1);
  assert.equal(executed.waitState?.kind, "delay");
  assert.equal(executed.waitState?.until, until, "the persisted deadline must not be lost by reload recovery");
  assert.deepEqual(executed.cursor, snapshot.cursor);
});

// ---------------------------------------------------------------------------
// Runner harness: drives the real executeRun()/sendPromptSafely() against a
// fake composer with a virtual clock.
// ---------------------------------------------------------------------------
function createRunnerHarness(initialRun, options = {}) {
  const { onSave = null } = options;
  let clock = 1_000_000;
  let generationEndsAt = -1;
  let storedRun = clone(initialRun);
  const page = { text: "", clicks: 0, clickTimes: [] };
  const saves = [];
  const pending = [];

  class FakeDate extends Date {
    static now() { return clock; }
  }

  const sendButton = {
    disabled: false,
    getAttribute: () => null,
    click() {
      page.clicks += 1;
      page.clickTimes.push(clock);
      page.text = "";
      generationEndsAt = clock + 2_000;
    }
  };
  const composer = { id: "composer" };
  const adapter = withTextDeliveryTransaction({
    id: "chatgpt",
    getConversationKey: () => "chatgpt:c:project-conversation",
    detectBlocker: () => null,
    findComposer: () => composer,
    getComposerText: () => page.text,
    getComposerAttachmentState: () => ({ known: true, count: 0 }),
    writePrompt: (text) => { page.text = text; },
    findSendButton: () => sendButton,
    isGenerating: () => clock < generationEndsAt,
    getGenerationState: () => (clock < generationEndsAt ? "generating" : "idle"),
    isComposerWritable: () => true
  });

  const context = vm.createContext({
    console,
    Date: FakeDate,
    crypto: { randomUUID: () => `outbox-${page.clicks + 1}` },
    localRunnerToken: 1,
    activeRunnerRunId: null,
    activeRunnerToken: null,
    activeRunnerExecutionSessionId: null,
    recoveryStarted: false,
    startInFlight: false,
    instanceId: "runner-document",
    __AIPM_CONTENT_CONTROLLER_READY__: true,
    __AIPM_CONTENT_CORE__: { version: "0.4.0", ready: true },
    SCHEMA_VERSION: 1,
    MAX_SENDS_PER_RUN: 50,
    POLL_MS: 100,
    ACK_TIMEOUT_MS: 15_000,
    GENERATION_TIMEOUT_MS: 30 * 60 * 1000,
    READY_STABLE_MS: 0,
    LEASE_HEARTBEAT_MS: 5_000,
    composerIsEffectivelyEmpty: productionComposerIsEffectivelyEmpty,
    ChatGptAdapter: adapter,
    chrome: {
      runtime: {
        async sendMessage() { return { ok: true, run: clone(storedRun) }; },
        onMessage: { addListener() {} }
      },
      storage: { local: { async get() { return {}; } } }
    }
  });

  vm.runInContext(runnerSource, context, { filename: "content-runner.js" });
  vm.runInContext(controllerSource, context, { filename: "content-controller.js" });

  context.nowIso = () => new Date(clock).toISOString();
  context.sleep = async (ms) => { clock += Math.max(1, Number(ms) || 0); };
  context.sha256 = async (text) => `hash:${text}`;
  context.renderStatusPill = () => {};
  context.appendDiagnostic = async () => {};
  context.makeError = (code) => {
    const error = new Error(code);
    error.code = code;
    return error;
  };
  context.composerTextMatchesExpected = (expected, actual) => String(expected).trim() === String(actual).trim();
  context.isConversationTransitionAllowed = (run, actualKey) => run?.conversationKey === actualKey;
  context.getActiveRun = async () => clone(storedRun);
  context.saveActiveRun = async (run) => {
    storedRun = clone(run);
    saves.push(clone(run));
    if (onSave) await onSave({ run: clone(run), context, page });
  };
  context.acquireLease = async (conversationKey, _runId, executionSessionId) => ({ conversationKey, executionSessionId, nonce: "lease" });
  context.renewLease = async () => true;
  context.releaseLease = async () => {};
  context.migrateLeaseIfNeeded = async (lease) => lease;

  // recoverIfNeeded() launches executeRun() without awaiting it, exactly as it does in
  // the extension. Track those promises so tests can wait for the resumed runner.
  const realExecuteRun = context.executeRun;
  context.executeRun = (...args) => {
    const result = realExecuteRun(...args);
    pending.push(Promise.resolve(result).catch(() => {}));
    return result;
  };

  return {
    context,
    page,
    saves,
    stored: () => clone(storedRun),
    now: () => clock,
    setStored: (run) => { storedRun = clone(run); },
    async settle() {
      while (pending.length > 0) await pending.shift();
    }
  };
}

function freshRepeatRun() {
  return repeatFiveRun({ cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 }, phase: "ready" });
}

test("E: a persisted delay deadline fences the next send until it expires", async () => {
  const harness = createRunnerHarness(repeatFiveRun());
  const startedAt = harness.now();
  const until = startedAt + DELAY_AFTER_MS;
  const run = repeatFiveRun({
    phase: "delay",
    waitState: { kind: "delay", scope: "after-send", stepId: "quick-repeat-five", stepIndex: 0, repeatIndex: 1, until }
  });
  harness.setStored(run);

  await harness.context.executeRun(run, harness.context.localRunnerToken);

  const clickedAt = harness.page.clickTimes[0] ?? null;
  assert.notEqual(clickedAt, null, "the run must continue after the fence expires");
  assert.ok(
    clickedAt >= until,
    `the next send must wait for the persisted deadline (clicked at +${clickedAt - startedAt}ms, deadline +${DELAY_AFTER_MS}ms)`
  );
  assert.equal(harness.stored().cursor.sendsCompleted, 5);
});

test("E: the delayAfter deadline is committed in the same durable write that advances the cursor", async () => {
  const harness = createRunnerHarness(freshRepeatRun());
  const run = freshRepeatRun();

  await harness.context.executeRun(run, harness.context.localRunnerToken);

  const advanceSave = harness.saves.find((saved) => saved.cursor.sendsCompleted === 1 && saved.outbox === null);
  assert.ok(advanceSave, "a durable write must commit the first completed send");
  assert.equal(
    advanceSave.waitState?.kind,
    "delay",
    "the post-send delay deadline must be durable as soon as the cursor advances"
  );
  assert.equal(advanceSave.waitState?.scope, "after-send");
  assert.equal(advanceSave.waitState?.stepIndex, 0);
  assert.equal(advanceSave.waitState?.repeatIndex, 1);
  assert.ok(Number.isFinite(Number(advanceSave.waitState?.until)));
});

// ---------------------------------------------------------------------------
// F. Stop during confirmed recovery must win and must not poison the barrier.
// ---------------------------------------------------------------------------
test("F: Stop during confirmed recovery keeps the Run stopped and resolves the recovery barrier", async () => {
  const snapshot = repeatFiveRun({
    phase: "generating",
    outbox: outboxAt("confirmed", { confirmedAt: "2026-08-21T10:00:15.200Z" })
  });
  const harness = createRecoveryHarness(snapshot, {
    rejectStoppedRevival: true,
    onReadyStability: async ({ stop }) => {
      stop();
      const error = new Error("user_stop");
      error.code = "user_stop";
      throw error;
    }
  });

  await assert.doesNotReject(harness.recover(), "a Stop during recovery must not reject the recovery barrier");

  const stored = harness.stored();
  assert.equal(stored.status, "stopped", "Stop takes priority over recovery");
  assert.equal(stored.phase, "stopped");
  assert.equal(harness.counters.execute, 0, "a stopped Run must not get a recovery runner");
});

test("F: a Stop racing bootstrap recovery cannot block a fresh Start in the same document", async () => {
  // Faithful bootstrap: the controller registers its listener and starts initial recovery
  // on evaluation, exactly as it does after Ctrl+R, and the Stop lands while recovery is
  // holding the lease for a confirmed outbox.
  const listeners = [];
  let storedRun = repeatFiveRun({
    phase: "generating",
    outbox: outboxAt("confirmed", { confirmedAt: "2026-08-21T10:00:15.200Z" })
  });
  let executeCount = 0;
  let stopApplied = false;
  let revivalRejections = 0;

  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: () => "fresh-start-run" },
    sha256: async (text) => `hash:${text}`,
    recoveryStarted: false,
    localRunnerToken: 0,
    startInFlight: false,
    activeRunnerRunId: null,
    activeRunnerToken: null,
    activeRunnerExecutionSessionId: null,
    instanceId: "instance-test",
    SCHEMA_VERSION: 1,
    MAX_SENDS_PER_RUN: 50,
    POLL_MS: 1,
    READY_STABLE_MS: 0,
    ACK_TIMEOUT_MS: 15_000,
    GENERATION_TIMEOUT_MS: 30_000,
    LEASE_HEARTBEAT_MS: 5_000,
    STATUS_PILL_ID: "aipm-status-pill",
    DIAGNOSTICS_KEY: "aipm.diagnostics.v1",
    __AIPM_CONTENT_CORE__: { version: "0.4.0", ready: true },
    composerIsEffectivelyEmpty: productionComposerIsEffectivelyEmpty,
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {}, remove() {} }),
      documentElement: { appendChild() {} }
    },
    nowIso: () => "2026-08-21T10:00:30.000Z",
    sleep: async () => {},
    appendDiagnostic: async () => {},
    makeError: (code) => {
      const error = new Error(code);
      error.code = code;
      return error;
    },
    blockerToError: () => new Error("blocker"),
    isConversationTransitionAllowed: (run, actualKey) => run?.conversationKey === actualKey,
    composerTextMatchesExpected: (expected, actual) => String(expected).trim() === String(actual).trim(),
    ChatGptAdapter: {
      id: "chatgpt",
      getConversationKey: () => "chatgpt:c:project-conversation",
      detectBlocker: () => null,
      getGenerationState: () => "idle",
      isGenerating: () => false
    },
    chrome: {
      runtime: {
        async sendMessage(message) {
          if (message.type === "AIPM_RUN_GET") return { ok: true, run: clone(storedRun) };
          if (message.type === "AIPM_LEASE_ACQUIRE") {
            if (!stopApplied) {
              // The user hits Stop while recovery is still deciding what to do.
              stopApplied = true;
              storedRun = { ...storedRun, status: "stopped", phase: "stopped", pauseReason: "user-stop", waitState: null };
            }
            return { ok: true, lease: { conversationKey: message.conversationKey, nonce: "lease", executionSessionId: message.executionSessionId } };
          }
          if (message.type === "AIPM_RUN_SET") {
            const next = message.run;
            // Mirror background: a stopped Run is never revived by an older writer.
            if (storedRun && next.runId === storedRun.runId && storedRun.status === "stopped" && next.status !== "stopped") {
              revivalRejections += 1;
              return { ok: false, errorCode: "RUN_STATE_CONFLICT", error: "新しいPause/Stop/完了状態を古いrunner更新で上書きできません。" };
            }
            storedRun = clone(next);
            return { ok: true, run: clone(storedRun) };
          }
          return { ok: true };
        },
        onMessage: { addListener(listener) { listeners.push(listener); } }
      },
      storage: { local: { async get() { return {}; }, async set() {} } }
    },
    acquireLease: async (conversationKey, _runId, executionSessionId) => {
      const response = await context.chrome.runtime.sendMessage({ type: "AIPM_LEASE_ACQUIRE", conversationKey, executionSessionId });
      return response.lease;
    },
    renewLease: async () => true,
    releaseLease: async () => {}
  });

  vm.runInContext(runnerSource, context, { filename: "content-runner.js" });
  vm.runInContext(controllerSource, context, { filename: "content-controller.js" });
  context.executeRun = () => { executeCount += 1; };

  await assert.doesNotReject(
    context.initialRecoveryPromise,
    "a Stop racing bootstrap recovery must not poison the recovery barrier"
  );
  assert.equal(storedRun.status, "stopped", "Stop takes priority over recovery");
  assert.equal(revivalRejections, 0, "recovery must not even attempt to revive a stopped Run");

  const response = await new Promise((resolve) => {
    listeners[0]({
      type: "AIPM_START",
      workflow: repeatFiveWorkflow(),
      bindingTabId: 215,
      keepAwake: false,
      serviceWorkerVersion: "0.4.0",
      executionSessionId: "session-test",
      expectedDocumentInstanceId: "instance-test",
      expectedConversationKey: "chatgpt:c:project-conversation",
      expectedRunId: "reload-repeat-five"
    }, {}, resolve);
  });

  assert.equal(response.ok, true, `a fresh Start must succeed after a stopped recovery (got: ${response.error})`);
  assert.equal(executeCount, 1);
});

// ---------------------------------------------------------------------------
// G. Repeat=5 never exceeds five clicks, with or without a reload.
// ---------------------------------------------------------------------------
test("G: Repeat=5 sends exactly five times with no reload", async () => {
  const harness = createRunnerHarness(freshRepeatRun());
  const run = freshRepeatRun();

  await harness.context.executeRun(run, harness.context.localRunnerToken);

  assert.equal(harness.page.clicks, 5, "Repeat=5 must click exactly five times");
  assert.equal(harness.stored().cursor.sendsCompleted, 5);
  assert.equal(harness.stored().status, "completed");
});

test("G: a reload inside the delayAfter fence still yields exactly five clicks", async () => {
  let reloadArmed = true;
  const harness = createRunnerHarness(freshRepeatRun(), {
    async onSave({ run, context }) {
      if (!reloadArmed) return;
      if (run.cursor.sendsCompleted !== 2 || run.waitState?.scope !== "after-send") return;
      reloadArmed = false;
      // Ctrl+R: the live runner is invalidated, and a new document recovers the
      // durable snapshot that was just committed.
      context.localRunnerToken += 1;
    }
  });
  const run = freshRepeatRun();

  await harness.context.executeRun(run, harness.context.localRunnerToken);
  assert.equal(reloadArmed, false, "the simulated reload must actually fire");

  harness.context.recoveryStarted = false;
  await harness.context.recoverIfNeeded();
  await harness.settle();

  assert.ok(harness.page.clicks <= 5, `Repeat=5 must never exceed five clicks (got ${harness.page.clicks})`);
  assert.equal(harness.page.clicks, 5, "the reloaded run must finish the remaining repeats exactly once each");
  assert.equal(harness.stored().cursor.sendsCompleted, 5);
});

test("G: a reload at a prepared pre-submit checkpoint still yields exactly five clicks", async () => {
  let reloadArmed = true;
  const harness = createRunnerHarness(freshRepeatRun(), {
    async onSave({ run, context, page }) {
      if (!reloadArmed) return;
      if (run.phase !== "prepared" || run.outbox?.state !== "prepared" || run.cursor.sendsCompleted !== 2) return;
      reloadArmed = false;
      context.localRunnerToken += 1;
      page.text = "";
    }
  });
  const run = freshRepeatRun();

  await harness.context.executeRun(run, harness.context.localRunnerToken);
  assert.equal(reloadArmed, false, "the simulated reload must actually fire");
  assert.equal(harness.page.clicks, 2, "the invalidated runner must not click after the reload");

  harness.context.recoveryStarted = false;
  await harness.context.recoverIfNeeded();
  await harness.settle();

  assert.equal(harness.page.clicks, 5, "the retried pre-submit position must send once, not twice");
  assert.equal(harness.stored().cursor.sendsCompleted, 5);
});
