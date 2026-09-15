import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DELAY_MS,
  MAX_SENDS_PER_RUN,
  MAX_WAIT_MS,
  WORKFLOW_PRESETS,
  advanceCursor,
  clonePreset,
  countPlannedActions,
  countPlannedSends,
  classifyWaitUntilAtStart,
  defaultBlock,
  normalizeQuickConfig,
  normalizeWorkflow,
  preflightWorkflowStartSchedule,
  quickConfigToWorkflow
} from "../src/workflow.js";

test("quick config becomes a bounded workflow", () => {
  const workflow = quickConfigToWorkflow({ prompt: "  改善して  ", repeat: "3", delaySeconds: "2" });
  assert.equal(workflow.steps[0].prompt, "改善して");
  assert.equal(workflow.steps[0].repeat, 3);
  assert.equal(workflow.steps[0].delayAfterMs, 2000);
  assert.equal(workflow.maxSends, 3);
});

test("quick workflow clamps to the global hard cap", () => {
  const workflow = quickConfigToWorkflow({ prompt: "x", repeat: "999", delaySeconds: "0" });
  assert.equal(workflow.maxSends, MAX_SENDS_PER_RUN);
  assert.equal(workflow.steps[0].repeat, MAX_SENDS_PER_RUN);
});

test("Quick delay accepts 300 seconds and clamps larger Settings-era values", () => {
  for (const [delaySeconds, expectedMs] of [[299, 299_000], [300, MAX_DELAY_MS], [301, MAX_DELAY_MS], [3600, MAX_DELAY_MS]]) {
    const quick = normalizeQuickConfig({ prompt: "x", repeat: 1, delaySeconds });
    assert.equal(quick.delayAfterMs, expectedMs, `delaySeconds=${delaySeconds}`);
  }
  assert.equal(MAX_DELAY_MS, 300_000);
});

test("standalone Delay keeps its separate 24-hour bound", () => {
  const workflow = normalizeWorkflow({
    schemaVersion: 1,
    maxSends: 1,
    steps: [
      { id: "wait", type: "delay", durationMs: MAX_WAIT_MS + 1 },
      { id: "send", type: "prompt", prompt: "x", repeat: 1 }
    ]
  });
  assert.equal(workflow.steps[0].durationMs, MAX_WAIT_MS);
  assert.equal(MAX_WAIT_MS, 24 * 60 * 60 * 1000);
  assert.notEqual(MAX_WAIT_MS, MAX_DELAY_MS);
});

test("normalizes sequential workflow and counts planned sends", () => {
  const workflow = normalizeWorkflow({
    schemaVersion: 1,
    id: "custom",
    name: "Custom",
    maxSends: 4,
    steps: [
      { id: "a", prompt: "A", repeat: 2, delayAfterMs: 0 },
      { id: "b", prompt: "B", repeat: 2, delayAfterMs: 1000 }
    ]
  });
  assert.equal(countPlannedSends(workflow), 4);
});

test("rejects workflows whose planned sends exceed maxSends", () => {
  assert.throws(() => normalizeWorkflow({
    schemaVersion: 1,
    maxSends: 2,
    steps: [{ id: "a", prompt: "A", repeat: 3 }]
  }), /maxSends/);
});

test("cursor advances within repeats then to the next step", () => {
  const workflow = normalizeWorkflow({
    schemaVersion: 1,
    maxSends: 3,
    steps: [
      { id: "a", prompt: "A", repeat: 2 },
      { id: "b", prompt: "B", repeat: 1 }
    ]
  });
  let cursor = { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 };
  cursor = advanceCursor(workflow, cursor);
  assert.deepEqual(cursor, { stepIndex: 0, repeatIndex: 1, sendsCompleted: 1, done: false });
  cursor = advanceCursor(workflow, cursor);
  assert.deepEqual(cursor, { stepIndex: 1, repeatIndex: 0, sendsCompleted: 2, done: false });
  cursor = advanceCursor(workflow, cursor);
  assert.deepEqual(cursor, { stepIndex: 2, repeatIndex: 0, sendsCompleted: 3, done: true });
});

test("checkpoint advances without consuming a send", () => {
  const workflow = normalizeWorkflow({
    schemaVersion: 1,
    maxSends: 1,
    steps: [
      { id: "review", type: "checkpoint", label: "Review" },
      { id: "send", prompt: "Continue", repeat: 1 }
    ]
  });
  const cursor = advanceCursor(workflow, { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 });
  assert.equal(cursor.sendsCompleted, 0);
  assert.equal(cursor.stepIndex, 1);
});


test("block workflow supports delay, scheduled wait, checkpoint, send and draft", () => {
  const workflow = normalizeWorkflow({
    schemaVersion: 1,
    maxSends: 2,
    steps: [
      { id: "wait", type: "wait-until", at: "2030-01-02T03:04:05.000Z", latePolicy: "pause", graceMs: 300000 },
      { id: "send", type: "prompt", delivery: "send", prompt: "A", repeat: 2 },
      { id: "delay", type: "delay", durationMs: 5000 },
      { id: "draft", type: "prompt", delivery: "draft", prompt: "B", repeat: 9 },
      { id: "check", type: "checkpoint", label: "Review" }
    ]
  });
  assert.equal(countPlannedSends(workflow), 2);
  assert.equal(countPlannedActions(workflow), 6);
  assert.equal(workflow.steps[0].at, "2030-01-02T03:04:05.000Z");
  assert.equal(workflow.steps[3].repeat, 1);
  assert.equal(workflow.steps[3].delivery, "draft");
});

test("wait-until rejects an invalid timestamp", () => {
  assert.throws(() => normalizeWorkflow({
    schemaVersion: 1,
    maxSends: 1,
    steps: [{ id: "wait", type: "wait-until", at: "not-a-date" }]
  }), /時刻/);
});

test("Start schedule preflight classifies fixed-clock wait boundaries without changing policy", () => {
  const scheduledAt = Date.parse("2030-01-02T03:04:05.000Z");
  const base = {
    id: "wait",
    type: "wait-until",
    at: new Date(scheduledAt).toISOString(),
    latePolicy: "pause",
    graceMs: 1000
  };

  assert.equal(classifyWaitUntilAtStart(base, scheduledAt - 1).state, "future");
  assert.equal(classifyWaitUntilAtStart(base, scheduledAt).state, "future");
  assert.equal(classifyWaitUntilAtStart(base, scheduledAt + 999).state, "past-within-grace");
  assert.equal(classifyWaitUntilAtStart(base, scheduledAt + 1000).state, "past-within-grace");
  assert.equal(classifyWaitUntilAtStart(base, scheduledAt + 1001).state, "stale-pause");
  assert.equal(classifyWaitUntilAtStart({ ...base, latePolicy: "run" }, scheduledAt + 1001).state, "stale-run");
  assert.equal(classifyWaitUntilAtStart({ ...base, latePolicy: "skip" }, scheduledAt + 1001).state, "stale-skip");
});

test("Start schedule preflight rejects a later stale-pause block before Prompt A and leaves input unchanged", () => {
  const workflow = normalizeWorkflow({
    schemaVersion: 1,
    maxSends: 2,
    steps: [
      { id: "prompt-a", type: "prompt", prompt: "A", repeat: 1 },
      { id: "stale", type: "wait-until", at: "2030-01-02T03:04:05.000Z", latePolicy: "pause", graceMs: 1000 },
      { id: "prompt-b", type: "prompt", prompt: "B", repeat: 1 }
    ]
  });
  const before = structuredClone(workflow);
  const result = preflightWorkflowStartSchedule(workflow, Date.parse("2030-01-02T03:04:06.001Z"));

  assert.equal(result.ok, false);
  assert.equal(result.blocker?.state, "stale-pause");
  assert.equal(result.blocker?.stepId, "stale");
  assert.deepEqual(workflow, before);
});

test("Start schedule preflight preserves stale run and skip policies", () => {
  const now = Date.parse("2030-01-02T03:04:06.001Z");
  for (const latePolicy of ["run", "skip"]) {
    const workflow = normalizeWorkflow({
      schemaVersion: 1,
      maxSends: 1,
      steps: [
        { id: "wait", type: "wait-until", at: "2030-01-02T03:04:05.000Z", latePolicy, graceMs: 1000 },
        { id: "prompt", type: "prompt", prompt: "A", repeat: 1 }
      ]
    });
    const result = preflightWorkflowStartSchedule(workflow, now);
    assert.equal(result.ok, true, `${latePolicy} must retain its existing runtime meaning`);
    assert.equal(result.observations[0].state, `stale-${latePolicy}`);
  }
});

test("workflow step IDs must be unique before schedule identities are created", () => {
  assert.throws(() => normalizeWorkflow({
    schemaVersion: 1,
    maxSends: 1,
    steps: [
      { id: "duplicate", type: "wait-until", at: "2030-01-02T03:04:05.000Z" },
      { id: "duplicate", type: "wait-until", at: "2030-01-03T03:04:05.000Z" }
    ]
  }), /ID.*重複|重複.*ID/);
});

test("non-send blocks advance without consuming send budget", () => {
  const workflow = normalizeWorkflow({
    schemaVersion: 1,
    maxSends: 1,
    steps: [
      { id: "delay", type: "delay", durationMs: 1000 },
      { id: "draft", type: "prompt", delivery: "draft", prompt: "Draft me" },
      { id: "send", type: "prompt", delivery: "send", prompt: "Send me" }
    ]
  });
  let cursor = { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 };
  cursor = advanceCursor(workflow, cursor);
  assert.equal(cursor.sendsCompleted, 0);
  cursor = advanceCursor(workflow, cursor);
  assert.equal(cursor.sendsCompleted, 0);
  cursor = advanceCursor(workflow, cursor);
  assert.equal(cursor.sendsCompleted, 1);
});

test("default scheduled block is valid and future-dated", () => {
  const block = defaultBlock("wait-until");
  assert.equal(block.type, "wait-until");
  assert.ok(Number.isFinite(Date.parse(block.at)));
});

test("built-in workflows are valid and bounded", () => {
  for (const preset of WORKFLOW_PRESETS) {
    const normalized = normalizeWorkflow(preset);
    assert.ok(countPlannedSends(normalized) <= MAX_SENDS_PER_RUN);
  }
});

test("clonePreset does not mutate the source preset", () => {
  const copy = clonePreset("continuous-improvement");
  copy.steps[0].prompt = "changed";
  assert.notEqual(copy.steps[0].prompt, WORKFLOW_PRESETS[0].steps[0].prompt);
});
