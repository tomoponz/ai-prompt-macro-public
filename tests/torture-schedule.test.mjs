// T6 — schedule torture.
//
// A Wait Until step is the only place where the product converts elapsed wall-clock time
// into Send authority. Issue #28 showed how a single malformed grace value silently turned
// the default fail-closed "pause when late" policy into "run late". The dangerous edges
// are the exact boundary values and the async gap between the moment the Side Panel checks
// the schedule and the moment background durably commits the Start.
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SESSION_ID,
  installBackgroundHarness,
  makeRun
} from "./helpers/background-harness.mjs";
import { classifyWaitUntilAtStart, preflightWorkflowStartSchedule } from "../src/workflow.js";
import { createWorkflowHarness } from "./helpers/workflow-harness.mjs";

const harness = await installBackgroundHarness();

const GRACE_MS = 5 * 60 * 1000;
const NOW = 1_800_000_000_000;

function waitStep(latePolicy, latenessMs, graceMs = GRACE_MS) {
  return {
    id: "wait",
    type: "wait-until",
    at: new Date(NOW - latenessMs).toISOString(),
    latePolicy,
    graceMs
  };
}

// ---------------------------------------------------------------------------
// Exact boundary values
// ---------------------------------------------------------------------------

test("T6: the late boundary is exact - grace is inside, grace + 1ms is outside", () => {
  for (const latePolicy of ["pause", "run", "skip"]) {
    assert.equal(
      classifyWaitUntilAtStart(waitStep(latePolicy, -1), NOW).state,
      "future",
      `${latePolicy}: a schedule 1ms in the future is future`
    );
    assert.equal(
      classifyWaitUntilAtStart(waitStep(latePolicy, 0), NOW).state,
      "future",
      `${latePolicy}: the scheduled instant itself is not late`
    );
    assert.equal(
      classifyWaitUntilAtStart(waitStep(latePolicy, 1), NOW).state,
      "past-within-grace",
      `${latePolicy}: 1ms late is inside grace`
    );
    assert.equal(
      classifyWaitUntilAtStart(waitStep(latePolicy, GRACE_MS), NOW).state,
      "past-within-grace",
      `${latePolicy}: exactly grace is still inside grace`
    );
    assert.equal(
      classifyWaitUntilAtStart(waitStep(latePolicy, GRACE_MS + 1), NOW).state,
      `stale-${latePolicy}`,
      `${latePolicy}: grace + 1ms is stale`
    );
  }
});

test("T6: a zero grace makes any lateness stale, and only stale-pause blocks Start", () => {
  assert.equal(classifyWaitUntilAtStart(waitStep("pause", 0, 0), NOW).state, "future");
  assert.equal(classifyWaitUntilAtStart(waitStep("pause", 1, 0), NOW).state, "stale-pause");

  assert.equal(preflightWorkflowStartSchedule({ steps: [waitStep("pause", GRACE_MS, GRACE_MS)] }, NOW).ok, true);
  assert.equal(preflightWorkflowStartSchedule({ steps: [waitStep("pause", GRACE_MS + 1, GRACE_MS)] }, NOW).ok, false);
  // `run` and `skip` are explicit user decisions about lateness, so they do not block Start.
  assert.equal(preflightWorkflowStartSchedule({ steps: [waitStep("run", GRACE_MS + 1, GRACE_MS)] }, NOW).ok, true);
  assert.equal(preflightWorkflowStartSchedule({ steps: [waitStep("skip", GRACE_MS + 1, GRACE_MS)] }, NOW).ok, true);
});

test("T6: an unusable schedule value blocks Start rather than being clamped away", () => {
  for (const broken of [
    { at: "not-a-date", latePolicy: "pause", graceMs: GRACE_MS },
    { at: new Date(NOW).toISOString(), latePolicy: "pause", graceMs: "not-a-number" },
    { at: new Date(NOW).toISOString(), latePolicy: "pause", graceMs: Number.NaN },
    { at: new Date(NOW).toISOString(), latePolicy: "pause", graceMs: -1 }
  ]) {
    const step = { id: "wait", type: "wait-until", ...broken };
    assert.equal(
      classifyWaitUntilAtStart(step, NOW).state,
      "invalid",
      `${JSON.stringify(broken)}: an unusable schedule must classify as invalid`
    );
    assert.equal(
      preflightWorkflowStartSchedule({ steps: [step] }, NOW).ok,
      false,
      `${JSON.stringify(broken)}: an unusable schedule must block Start`
    );
  }
  // A non-finite "now" is a programming error, not a silently permissive default.
  assert.throws(() => classifyWaitUntilAtStart(waitStep("pause", 1), Number.NaN), /有限の現在時刻/);
});

// ---------------------------------------------------------------------------
// preflight -> async boundary -> clock crosses grace -> background durable save
// ---------------------------------------------------------------------------

test("T6: a Start that becomes stale during its async boundary is refused at the durable save", async () => {
  const tabId = 6001;
  harness.setTabs([{ id: tabId, active: true, windowId: 1, url: "https://chatgpt.com/" }]);
  harness.setDocument(tabId, { documentId: `document-${tabId}`, documentInstanceId: `instance-${tabId}` });

  const staleAt = new Date(Date.now() - (GRACE_MS + 5_000)).toISOString();
  const run = makeRun({
    runId: "start-stale",
    boundTabId: tabId,
    boundDocumentId: `document-${tabId}`,
    documentInstanceId: `instance-${tabId}`,
    workflow: {
      schemaVersion: 1,
      id: "stale-start",
      name: "Stale Start",
      maxSends: 1,
      steps: [
        { id: "wait", type: "wait-until", at: staleAt, latePolicy: "pause", graceMs: GRACE_MS },
        { id: "p1", type: "prompt", delivery: "send", prompt: "P1", repeat: 1, delayAfterMs: 0 }
      ]
    }
  });

  const response = await harness.invoke({
    type: "AIPM_RUN_SET",
    run,
    runTransition: "start",
    conversationKey: run.conversationKey,
    documentInstanceId: `instance-${tabId}`
  }, { tab: { id: tabId }, documentId: `document-${tabId}` });

  assert.equal(response.ok, false, "background must re-check the schedule at the durable save, not trust the caller");
  assert.equal(response.errorCode, "SCHEDULE_START_STALE");
  assert.equal(harness.storedRun(tabId), null, "no durable running Run may be created");
  assert.equal(Object.keys(harness.schedules()).length, 0, "no schedule may be armed for a refused Start");
  assert.equal(harness.alarms.size, 0, "no alarm may be armed for a refused Start");
});

test("T6: a Start whose schedule is still within grace at the durable save is accepted", async () => {
  const tabId = 6002;
  harness.setTabs([{ id: tabId, active: true, windowId: 1, url: "https://chatgpt.com/" }]);
  harness.setDocument(tabId, { documentId: `document-${tabId}`, documentInstanceId: `instance-${tabId}` });

  const run = makeRun({
    runId: "start-fresh",
    boundTabId: tabId,
    boundDocumentId: `document-${tabId}`,
    documentInstanceId: `instance-${tabId}`,
    workflow: {
      schemaVersion: 1,
      id: "fresh-start",
      name: "Fresh Start",
      maxSends: 1,
      steps: [
        { id: "wait", type: "wait-until", at: new Date(Date.now() + 60_000).toISOString(), latePolicy: "pause", graceMs: GRACE_MS },
        { id: "p1", type: "prompt", delivery: "send", prompt: "P1", repeat: 1, delayAfterMs: 0 }
      ]
    }
  });

  const response = await harness.invoke({
    type: "AIPM_RUN_SET",
    run,
    runTransition: "start",
    conversationKey: run.conversationKey,
    documentInstanceId: `instance-${tabId}`
  }, { tab: { id: tabId }, documentId: `document-${tabId}` });

  assert.equal(response.ok, true);
  assert.equal(harness.storedRun(tabId).status, "running");
});

// ---------------------------------------------------------------------------
// Content runtime late policies
// ---------------------------------------------------------------------------

const CLOCK_START = 1_700_000_000_000;
const RUNTIME_GRACE_MS = 5_000;
const LEAD_DELAY_MS = 10_000;

// A Wait Until whose deadline is in the future at Start but exactly `latenessAfterDelay`
// milliseconds in the past by the time the runner reaches it. That is the only way the
// runtime late policy is reachable at all: a schedule that is already stale-pause at Start
// is refused by the Start preflight, which is asserted separately below.
function scheduleWorkflow({ latePolicy, latenessAfterDelay, graceMs = RUNTIME_GRACE_MS }) {
  return {
    schemaVersion: 1,
    id: "schedule-runtime",
    name: "Schedule Runtime",
    maxSends: 1,
    steps: [
      { id: "lead", type: "delay", durationMs: LEAD_DELAY_MS },
      {
        id: "wait",
        type: "wait-until",
        at: new Date(CLOCK_START + LEAD_DELAY_MS - latenessAfterDelay).toISOString(),
        latePolicy,
        graceMs
      },
      { id: "after", type: "prompt", delivery: "send", prompt: "AFTER WAIT", repeat: 1, delayAfterMs: 0 }
    ]
  };
}

// The harness replaces `sleep` with a pure clock advance, which turns the runner's paused
// polling loop into an unbroken microtask chain. Yielding one real macrotask per sleep lets
// the test observe and control that loop the way a user would.
function withYieldingSleep(content) {
  const advance = content.context.sleep;
  content.context.sleep = async (ms) => {
    await advance(ms);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return content;
}

async function waitForRunState(content, predicate, label) {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (predicate(content.stored())) return content.stored();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for ${label} (saw ${JSON.stringify(content.stored()?.pauseReason)})`);
}

test("T6: at exactly grace the schedule is not late, so the following Send proceeds", async () => {
  for (const latePolicy of ["pause", "run", "skip"]) {
    const content = createWorkflowHarness();
    await content.start(scheduleWorkflow({ latePolicy, latenessAfterDelay: RUNTIME_GRACE_MS }));
    await content.settle();

    const context = `latePolicy=${latePolicy} at exactly grace`;
    assert.equal(content.page.clicks, 1, `${context}: the following Send must run normally`);
    assert.equal(content.stored().status, "completed", `${context}: the Run must complete`);
    assert.equal(content.stored().pauseReason, null, `${context}: exactly grace must not be treated as late`);
  }
});

test("T6: one millisecond past grace applies run and skip exactly, without pausing", async () => {
  for (const latePolicy of ["run", "skip"]) {
    const content = createWorkflowHarness();
    await content.start(scheduleWorkflow({ latePolicy, latenessAfterDelay: RUNTIME_GRACE_MS + 1 }));
    await content.settle();

    const stored = content.stored();
    const context = `latePolicy=${latePolicy} one millisecond past grace`;
    // Both are explicit user decisions about lateness, so the Send behind the Wait runs.
    assert.equal(content.page.clicks, 1, `${context}: unexpected Send click count`);
    assert.equal(stored.status, "completed", `${context}: unexpected status`);
  }
});

test("T6: one millisecond past grace fails closed under the default pause policy", async () => {
  const content = withYieldingSleep(createWorkflowHarness());
  await content.start(scheduleWorkflow({ latePolicy: "pause", latenessAfterDelay: RUNTIME_GRACE_MS + 1 }));

  const paused = await waitForRunState(content, (run) => run?.pauseReason === "schedule-late", "schedule-late pause");
  assert.equal(paused.status, "paused");
  assert.equal(paused.phase, "wait-until-late");
  assert.equal(paused.lastErrorCode, "schedule_late");
  assert.equal(paused.resumable, true, "a late schedule is a human decision, not an ambiguous delivery");
  assert.equal(content.page.clicks, 0, "the Send behind a late Wait must not run without confirmation");

  const resume = await content.control("AIPM_RESUME");
  await content.settle();

  assert.equal(resume.ok, true, `an explicit late acceptance must be possible (got: ${resume.error})`);
  assert.equal(content.page.clicks, 1, "the following Send runs exactly once after explicit acceptance");
  assert.equal(content.stored().status, "completed");
  assert.equal(content.stored().pauseReason, null);
});

test("T6: a stale-pause Wait Until leaves no durable running Run, no Send and no alarm", async () => {
  const content = createWorkflowHarness();
  const started = await content.start({
    schemaVersion: 1,
    id: "stale-pause",
    name: "Stale Pause",
    maxSends: 1,
    steps: [
      {
        id: "wait",
        type: "wait-until",
        at: new Date(CLOCK_START - (GRACE_MS + 60_000)).toISOString(),
        latePolicy: "pause",
        graceMs: GRACE_MS
      },
      { id: "after", type: "prompt", delivery: "send", prompt: "AFTER WAIT", repeat: 1, delayAfterMs: 0 }
    ]
  });
  await content.settle();

  assert.equal(started.ok, false, "a stale pause schedule must refuse Start outright");
  assert.match(started.error, /猶予時間/);
  assert.equal(content.stored(), null, "durable running Run count must be 0");
  assert.equal(content.page.clicks, 0, "Send count must be 0");
  assert.equal(
    content.transcript.filter((entry) => entry.type === "AIPM_ARM_ALARM").length,
    0,
    "Alarm count must be 0"
  );
});

test("T6: Stop on a schedule-late Run is terminal and clears the wait state", async () => {
  const content = withYieldingSleep(createWorkflowHarness());
  await content.start(scheduleWorkflow({ latePolicy: "pause", latenessAfterDelay: RUNTIME_GRACE_MS + 1 }));
  await waitForRunState(content, (run) => run?.pauseReason === "schedule-late", "schedule-late pause");

  const stop = await content.control("AIPM_STOP");
  await content.settle();
  assert.equal(stop.ok, true);
  assert.equal(content.stored().status, "stopped");
  assert.equal(content.stored().waitState, null);
  assert.equal(content.page.clicks, 0);

  await content.reload(1_000);
  assert.equal(content.stored().status, "stopped", "a stopped schedule must not be revived by recovery");
  assert.equal(content.page.clicks, 0);
});

test("T6: an armed schedule survives only inside its own execution session", async () => {
  const tabId = 6003;
  const armed = await harness.invoke({
    type: "AIPM_ARM_ALARM",
    runId: "session-schedule",
    stepId: "wait",
    whenMs: Date.now() + 60_000,
    serviceWorkerVersion: "0.4.1",
    executionSessionId: DEFAULT_SESSION_ID
  }, { tab: { id: tabId } });
  assert.equal(armed.ok, true);

  const foreign = await harness.invoke({
    type: "AIPM_ARM_ALARM",
    runId: "foreign-schedule",
    stepId: "wait",
    whenMs: Date.now() + 60_000,
    serviceWorkerVersion: "0.4.1",
    executionSessionId: "a-previous-browser-session"
  }, { tab: { id: tabId } });
  assert.equal(foreign.ok, false, "a schedule from another browser session must not be armed");
  assert.equal(
    Object.values(harness.schedules()).some((schedule) => schedule.runId === "foreign-schedule"),
    false
  );
});
