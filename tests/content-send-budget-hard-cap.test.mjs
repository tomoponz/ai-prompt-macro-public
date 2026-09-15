import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTENT_VERSION,
  CONVERSATION_KEY,
  SESSION_ID,
  TAB_ID,
  createWorkflowHarness
} from "./helpers/workflow-harness.mjs";

function workflowWith({ maxSends = 1, repeats = [1] } = {}) {
  return {
    schemaVersion: 1,
    id: "send-budget-regression",
    maxSends,
    steps: repeats.map((repeat, index) => ({
      id: `prompt-${index + 1}`,
      type: "prompt",
      delivery: "send",
      prompt: `PROMPT ${index + 1}`,
      repeat,
      delayAfterMs: 0
    }))
  };
}

async function assertStartFailsClosed(workflow, label, errorPattern = /送信上限/) {
  const harness = createWorkflowHarness();
  const response = await harness.start(workflow);
  await harness.settle();

  assert.equal(response.ok, false, `${label}: malformed workflow must be rejected`);
  assert.match(response.error, errorPattern);
  assert.equal(harness.page.clicks, 0, `${label}: rejection must happen before an irreversible click`);
  assert.equal(harness.stored(), null, `${label}: a rejected workflow must not create a Run`);
}

for (const [label, value] of [
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["non-numeric string", "not-a-number"],
  ["negative", -1],
  ["fraction", 1.5],
  ["null", null],
  ["object", { malformed: true }]
]) {
  test(`content runtime rejects malformed maxSends: ${label}`, async () => {
    await assertStartFailsClosed(workflowWith({ maxSends: value }), `maxSends=${label}`);
  });

  test(`content runtime rejects malformed repeat: ${label}`, async () => {
    await assertStartFailsClosed(workflowWith({ maxSends: 1, repeats: [value] }), `repeat=${label}`);
  });
}

test("content runtime rejects multiple repeat=50 blocks before the first click", async () => {
  await assertStartFailsClosed(
    workflowWith({ maxSends: 50, repeats: [50, 50] }),
    "two repeat=50 blocks"
  );
});

test("content runtime rejects the Issue #22 non-numeric maxSends plus two repeat=50 blocks", async () => {
  await assertStartFailsClosed(
    workflowWith({ maxSends: "not-a-number", repeats: [50, 50] }),
    "Issue #22 combined bypass"
  );
});

test("content runtime rejects more than 40 blocks before creating a Run", async () => {
  const workflow = {
    schemaVersion: 1,
    id: "too-many-blocks",
    maxSends: 1,
    steps: Array.from({ length: 41 }, (_, index) => ({
      id: `checkpoint-${index + 1}`,
      type: "checkpoint",
      label: `Checkpoint ${index + 1}`
    }))
  };
  await assertStartFailsClosed(workflow, "41 blocks", /実行範囲/);
});

test("content runtime keeps the exact 40-block boundary valid", () => {
  const harness = createWorkflowHarness();
  const normalized = harness.context.normalizeWorkflow({
    schemaVersion: 1,
    id: "forty-blocks",
    maxSends: 1,
    steps: Array.from({ length: 40 }, (_, index) => ({
      id: `checkpoint-${index + 1}`,
      type: "checkpoint",
      label: `Checkpoint ${index + 1}`
    }))
  });
  assert.equal(normalized.steps.length, 40);
  assert.equal(normalized.plannedSends, 0);
});

for (const [field, workflow] of [
  ["durationMs", {
    schemaVersion: 1,
    maxSends: 1,
    steps: [
      { id: "delay", type: "delay", durationMs: "not-a-number" },
      { id: "send", type: "prompt", delivery: "send", prompt: "MUST NOT SEND", repeat: 1, delayAfterMs: 0 }
    ]
  }],
  ["graceMs", {
    schemaVersion: 1,
    maxSends: 1,
    steps: [
      { id: "wait", type: "wait-until", at: "2020-01-02T03:04:05.000Z", latePolicy: "skip", graceMs: "not-a-number" },
      { id: "send", type: "prompt", delivery: "send", prompt: "MUST NOT SEND", repeat: 1, delayAfterMs: 0 }
    ]
  }],
  ["delayAfterMs", {
    schemaVersion: 1,
    maxSends: 1,
    steps: [
      { id: "send", type: "prompt", delivery: "send", prompt: "MUST NOT SEND", repeat: 1, delayAfterMs: "not-a-number" }
    ]
  }]
]) {
  test(`content runtime rejects malformed ${field} before creating execution authority`, async () => {
    await assertStartFailsClosed(workflow, field, /実行範囲|予約時刻/);
  });
}

test("content runtime rejects duplicate durable step IDs before the first block", async () => {
  await assertStartFailsClosed({
    schemaVersion: 1,
    maxSends: 1,
    steps: [
      { id: "duplicate", type: "checkpoint", label: "First" },
      { id: "duplicate", type: "prompt", delivery: "send", prompt: "MUST NOT SEND", repeat: 1, delayAfterMs: 0 }
    ]
  }, "duplicate IDs", /実行範囲/);
});

test("executeRun rejects an oversized durable workflow before executing its first block", async () => {
  const harness = createWorkflowHarness();
  const run = {
    schemaVersion: 1,
    runId: "oversized-durable-run",
    provider: "chatgpt",
    conversationKey: CONVERSATION_KEY,
    documentInstanceId: harness.context.instanceId,
    executionSessionId: SESSION_ID,
    contentVersion: CONTENT_VERSION,
    replacesRunId: null,
    boundTabId: TAB_ID,
    keepAwake: false,
    workflow: {
      schemaVersion: 1,
      maxSends: 1,
      steps: Array.from({ length: 41 }, (_, index) => ({
        id: `checkpoint-${index + 1}`,
        type: "checkpoint",
        label: `Checkpoint ${index + 1}`
      }))
    },
    plannedSends: 0,
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 },
    status: "running",
    phase: "ready",
    pauseReason: null,
    outbox: null,
    waitState: null
  };

  harness.context.localRunnerToken += 1;
  await harness.context.executeRun(run, harness.context.localRunnerToken);

  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.stored().status, "paused");
  assert.equal(harness.stored().lastErrorCode, "workflow_invalid");
  assert.equal(harness.stored().resumable, false);
  assert.equal(harness.stored().cursor.stepIndex, 0, "no oversized block may execute");
  assert.equal(
    harness.transcript.some((entry) => entry.type === "lease-acquire"),
    false,
    "validation must precede lease acquisition or page interaction"
  );
});

test("a stale alarm signal cannot satisfy a different scheduled timestamp", async () => {
  const harness = createWorkflowHarness();
  const scheduledAt = harness.now() + 10_000;
  const step = {
    id: "wait-signal-identity",
    type: "wait-until",
    at: new Date(scheduledAt).toISOString(),
    latePolicy: "run",
    graceMs: 300_000
  };
  const run = {
    runId: "signal-identity-run",
    workflow: { schemaVersion: 1, maxSends: 1, steps: [step] },
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 },
    status: "running",
    phase: "ready",
    waitState: null
  };
  harness.context.saveActiveRun = async () => {};
  harness.context.appendDiagnostic = async () => {};
  harness.context.assertRunCanContinue = async () => {};
  harness.context.armAlarm = async () => {};
  harness.context.clearAlarm = async () => {};
  harness.context.getAlarmSignal = async () => ({
    scheduledAt: scheduledAt - 5_000,
    firedAt: harness.now()
  });
  harness.context.waitForAlarmWake = async () => { harness.advance(10_000); };

  await harness.context.waitUntilBlock(run, step, harness.context.localRunnerToken);

  assert.ok(harness.now() >= scheduledAt, "a signal for an older schedule must not wake the new schedule early");
  assert.equal(run.cursor.stepIndex, 1);
});

test("runtime Wait Until keeps late pause, run, and skip semantics after Start preflight", async () => {
  for (const latePolicy of ["pause", "run", "skip"]) {
    const harness = createWorkflowHarness();
    const scheduledAt = harness.now() - 1001;
    const step = {
      id: `late-${latePolicy}`,
      type: "wait-until",
      at: new Date(scheduledAt).toISOString(),
      latePolicy,
      graceMs: 1000
    };
    const run = {
      runId: `late-${latePolicy}-run`,
      workflow: { schemaVersion: 1, maxSends: 1, steps: [step] },
      cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 },
      status: "running",
      phase: "ready",
      waitState: null
    };
    harness.context.saveActiveRun = async () => {};
    harness.context.appendDiagnostic = async () => {};
    harness.context.armAlarm = async () => {};
    harness.context.clearAlarm = async () => {};
    harness.context.getAlarmSignal = async () => ({ scheduledAt, firedAt: harness.now() });
    harness.context.assertRunCanContinue = async () => {
      if (run.status === "paused") throw Object.assign(new Error("paused"), { code: "paused" });
    };

    if (latePolicy === "pause") {
      await assert.rejects(
        harness.context.waitUntilBlock(run, step, harness.context.localRunnerToken),
        (error) => error?.code === "paused"
      );
      assert.equal(run.status, "paused");
      assert.equal(run.lastErrorCode, "schedule_late");
      assert.equal(run.cursor.stepIndex, 0);
    } else {
      await harness.context.waitUntilBlock(run, step, harness.context.localRunnerToken);
      assert.equal(run.status, "running");
      assert.equal(run.cursor.stepIndex, 1, `${latePolicy} must retain its existing cursor behavior`);
    }
  }
});

test("an explicit alarm cleanup failure is fail-closed before cursor advance", async () => {
  const harness = createWorkflowHarness();
  harness.context.chrome.runtime.sendMessage = async (message) => {
    if (message.type === "AIPM_CLEAR_ALARM") return { ok: false, error: "storage write failed" };
    return { ok: true };
  };
  await assert.rejects(
    harness.context.clearAlarm(
      { runId: "clear-failure-run", contentVersion: CONTENT_VERSION, executionSessionId: SESSION_ID },
      { id: "clear-failure-step" }
    ),
    (error) => error?.code === "alarm_failed"
  );
});

test("content runtime accepts exactly 50 planned sends and never clicks a 51st time", async () => {
  const harness = createWorkflowHarness();
  const response = await harness.start(workflowWith({ maxSends: 50, repeats: [50] }));
  await harness.settle();

  assert.equal(response.ok, true, `the exact hard-cap boundary must remain valid (got: ${response.error})`);
  assert.equal(harness.page.clicks, 50);
  assert.equal(harness.stored().cursor.sendsCompleted, 50);
  assert.equal(harness.stored().status, "completed");
});

test("the irreversible-click guard rejects a malformed durable Run even if normalization is bypassed", async () => {
  const harness = createWorkflowHarness();
  const step = {
    id: "corrupt-step",
    type: "prompt",
    delivery: "send",
    prompt: "MUST NOT SEND",
    repeat: 1,
    delayAfterMs: 0
  };
  const run = {
    workflow: { schemaVersion: 1, maxSends: Number.NaN, steps: [step] },
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 }
  };

  await assert.rejects(
    harness.context.sendPromptSafely(run, step, null, 0),
    (error) => error?.code === "send_budget_invalid"
  );
  assert.equal(harness.page.clicks, 0, "the last-line runtime guard must fail before a click");
});

test("the budget is revalidated after preparation and immediately before click", async () => {
  const harness = createWorkflowHarness();
  const saveActiveRun = harness.context.saveActiveRun;
  harness.context.saveActiveRun = async (run, transition) => {
    await saveActiveRun(run, transition);
    if (run.phase === "submitting") run.workflow.maxSends = Number.NaN;
  };

  const response = await harness.start(workflowWith());
  await harness.settle();

  assert.equal(response.ok, true, "the workflow is valid at Start");
  assert.equal(harness.page.clicks, 0, "budget corruption before click must not reach the send button");
  assert.equal(harness.stored().status, "paused");
  assert.equal(harness.stored().lastErrorCode, "send_budget_invalid");
  assert.equal(harness.stored().resumable, false, "a malformed durable budget must require a fresh Run");
});

test("the pre-click guard rejects expansion of a valid Run within the global cap", async () => {
  const harness = createWorkflowHarness();
  const saveActiveRun = harness.context.saveActiveRun;
  harness.context.saveActiveRun = async (run, transition) => {
    await saveActiveRun(run, transition);
    if (run.phase === "submitting" && run.workflow.steps.length === 1) {
      run.workflow.maxSends = 50;
      run.workflow.steps.push({
        id: "injected-future-step",
        type: "prompt",
        delivery: "send",
        prompt: "MUST NOT EXPAND THE APPROVED RUN",
        repeat: 49,
        delayAfterMs: 0
      });
    }
  };

  const response = await harness.start(workflowWith());
  await harness.settle();

  assert.equal(response.ok, true, "the original one-send workflow is valid at Start");
  assert.equal(harness.page.clicks, 0, "a changed future plan must fail before the current click");
  assert.equal(harness.stored().status, "paused");
  assert.equal(harness.stored().lastErrorCode, "workflow_invalid");
  assert.equal(harness.stored().resumable, false);
});

test("the pre-click guard binds the send to the original cursor position", async () => {
  const harness = createWorkflowHarness();
  const saveActiveRun = harness.context.saveActiveRun;
  harness.context.saveActiveRun = async (run, transition) => {
    await saveActiveRun(run, transition);
    if (run.phase === "submitting") run.cursor.stepIndex = 1;
  };
  const repeatedIdentityWorkflow = workflowWith({ maxSends: 2, repeats: [1, 1] });
  repeatedIdentityWorkflow.steps[1].prompt = repeatedIdentityWorkflow.steps[0].prompt;

  const response = await harness.start(repeatedIdentityWorkflow);
  await harness.settle();

  assert.equal(response.ok, true, "the workflow is valid at Start");
  assert.equal(harness.page.clicks, 0, "cursor drift must be caught even when adjacent steps look identical");
  assert.equal(harness.stored().status, "paused");
  assert.equal(harness.stored().lastErrorCode, "workflow_invalid");
  assert.equal(harness.stored().resumable, false);
});
