import test from "node:test";
import assert from "node:assert/strict";
import {
  OUTPUT_BLIND_ADAPTER_SURFACE,
  clickPositions,
  createWorkflowHarness,
  promptsSent,
  threePromptWorkflow
} from "./helpers/workflow-harness.mjs";

const EXPECTED_ORDER = ["PROMPT A", "PROMPT B", "PROMPT C"];

// Every scenario must satisfy the same contract, whatever interruption it models.
function assertScenarioContract(harness, { expectSent, expectStatus, label }) {
  const sent = promptsSent(harness);
  const positions = clickPositions(harness);

  assert.deepEqual(sent, EXPECTED_ORDER.slice(0, expectSent), `${label}: wrong prompts or wrong order`);
  assert.equal(harness.page.clicks, expectSent, `${label}: unexpected click count`);
  assert.ok(harness.page.clicks <= 3, `${label}: a fourth send must be impossible`);
  assert.equal(new Set(positions).size, positions.length, `${label}: a logical position was clicked twice`);

  const stored = harness.stored();
  if (expectStatus === "completed") {
    assert.equal(stored.status, "completed", `${label}: the run must complete`);
    assert.equal(stored.cursor.sendsCompleted, 3, `${label}: completed cursor mismatch`);
    assert.equal(stored.outbox, null, `${label}: a completed run must hold no delivery state`);
    assert.equal(stored.waitState, null, `${label}: a completed run must hold no wait state`);
  } else {
    assert.equal(stored.status, expectStatus, `${label}: expected an intentional ${expectStatus}`);
    if (expectStatus === "paused") {
      assert.ok(stored.lastErrorCode, `${label}: a fail-closed pause must record its reason`);
    }
  }

  for (const member of harness.adapterCalls) {
    assert.ok(
      OUTPUT_BLIND_ADAPTER_SURFACE.has(member),
      `${label}: Output-Blind violation, adapter member "${member}" was used`
    );
  }
}

test("SCENARIO A: normal run sends A, B, C exactly once and completes", async () => {
  const harness = createWorkflowHarness();
  harness.pinCurrentDocument();

  const response = await harness.start(threePromptWorkflow());
  await harness.settle();

  assert.equal(response.ok, true, `Start must succeed (got: ${response.error})`);
  assertScenarioContract(harness, { expectSent: 3, expectStatus: "completed", label: "A/normal" });
});

test("SCENARIO B: a reload right after Prompt A still delivers B and C exactly once", async () => {
  let armed = true;
  const harness = createWorkflowHarness({
    async onSave({ run, context }) {
      if (!armed || run.cursor.sendsCompleted !== 1 || run.phase !== "delay") return;
      armed = false;
      context.localRunnerToken += 1;
    }
  });
  harness.pinCurrentDocument();

  await harness.start(threePromptWorkflow());
  await harness.settle();
  assert.equal(armed, false, "the post-Prompt-A interruption must be reachable");
  assert.equal(harness.page.clicks, 1);

  await harness.reload(2_000);

  assertScenarioContract(harness, { expectSent: 3, expectStatus: "completed", label: "B/reload-after-A" });
});

test("SCENARIO C: a reload inside a Delay block resumes the remaining delay, not a fresh one", async () => {
  let armed = true;
  let persistedUntil = null;
  const harness = createWorkflowHarness({
    async onSave({ run, context }) {
      if (!armed || run.waitState?.stepId !== "delay-1") return;
      armed = false;
      persistedUntil = Number(run.waitState.until);
      context.localRunnerToken += 1;
    }
  });
  harness.pinCurrentDocument();

  await harness.start(threePromptWorkflow());
  await harness.settle();
  assert.equal(armed, false);

  const reloadedAt = await harness.reload(15_000);

  const clicks = harness.clicks();
  assert.ok(clicks[1].at >= persistedUntil, "C: Prompt B must not jump the persisted deadline");
  assert.ok(clicks[1].at < reloadedAt + 20_000, "C: the delay must resume, not restart");
  assertScenarioContract(harness, { expectSent: 3, expectStatus: "completed", label: "C/reload-in-delay" });
});

test("SCENARIO D: Pause after Prompt B then Resume finishes with C and no repeat of A or B", async () => {
  let armed = true;
  const harness = createWorkflowHarness({
    async onSave({ run, context }) {
      if (!armed || run.cursor.sendsCompleted !== 2 || run.phase !== "delay") return;
      armed = false;
      context.localRunnerToken += 1;
    }
  });
  harness.pinCurrentDocument();

  await harness.start(threePromptWorkflow());
  await harness.settle();
  assert.equal(armed, false);
  assert.equal(harness.page.clicks, 2);

  const pause = await harness.control("AIPM_PAUSE", { expectedRunId: harness.stored().runId });
  assert.equal(pause.ok, true, `D: Pause must succeed (got: ${pause.error})`);
  assert.equal(harness.stored().status, "paused");

  const resume = await harness.control("AIPM_RESUME", { expectedRunId: harness.stored().runId });
  await harness.settle();
  assert.equal(resume.ok, true, `D: Resume must succeed (got: ${resume.error})`);

  assertScenarioContract(harness, { expectSent: 3, expectStatus: "completed", label: "D/pause-resume-after-B" });
});

test("SCENARIO E: a Service Worker restart mid-run loses no send and duplicates none", async () => {
  let armed = true;
  const harness = createWorkflowHarness({
    async onSave({ run, context }) {
      if (!armed || run.cursor.sendsCompleted !== 1) return;
      armed = false;
      context.localRunnerToken += 1;
    }
  });
  harness.pinCurrentDocument();

  await harness.start(threePromptWorkflow());
  await harness.settle();
  assert.equal(armed, false);

  // Worker teardown: durable Run state survives, in-memory lease bookkeeping does not.
  harness.dropLeases();
  await harness.reload(3_000);

  assertScenarioContract(harness, { expectSent: 3, expectStatus: "completed", label: "E/worker-restart" });
});

test("SCENARIO F: a stale document cannot drive the workflow after a new document takes over", async () => {
  let armed = true;
  const harness = createWorkflowHarness({
    async onSave({ run, context }) {
      if (!armed || run.cursor.sendsCompleted !== 1) return;
      armed = false;
      context.localRunnerToken += 1;
    }
  });
  harness.pinCurrentDocument();

  await harness.start(threePromptWorkflow());
  await harness.settle();
  assert.equal(armed, false);
  const clicksBefore = harness.page.clicks;
  const storedBefore = harness.stored();

  // A different document is now the tab's top document.
  harness.rotateDocument("instance-new-document");

  // The stale document tries to recover and drive the Run. Its read is refused, so recovery
  // fails closed. Poisoning that document's recovery barrier is harmless and intended: it is
  // no longer the tab's top document, so background refuses its commands anyway.
  harness.context.recoveryStarted = false;
  await assert.rejects(
    harness.context.recoverIfNeeded(),
    /現在のdocument/,
    "F: a stale document must fail closed rather than adopt the Run"
  );
  await harness.settle();

  assert.equal(harness.page.clicks, clicksBefore, "F: a stale document must never send");
  assert.equal(
    harness.stored().cursor.sendsCompleted,
    storedBefore.cursor.sendsCompleted,
    "F: a stale document must not move the cursor"
  );
  assert.equal(harness.stored().status, storedBefore.status, "F: a stale document must not change status");

  // A stale Start attempt must be refused too.
  const staleStart = await harness.start(threePromptWorkflow());
  await harness.settle();
  assert.equal(staleStart.ok, false, "F: a stale document must not be able to Start");
  assert.equal(harness.page.clicks, clicksBefore, "F: a refused Start must not send");
});

test("SCENARIO G: Stop mid-workflow halts immediately and never sends the remaining prompts", async () => {
  let armed = true;
  const harness = createWorkflowHarness({
    async onSave({ run, context }) {
      if (!armed || run.cursor.sendsCompleted !== 1 || run.phase !== "delay") return;
      armed = false;
      context.localRunnerToken += 1;
    }
  });
  harness.pinCurrentDocument();

  await harness.start(threePromptWorkflow());
  await harness.settle();
  assert.equal(armed, false);

  const stop = await harness.control("AIPM_STOP", { expectedRunId: harness.stored().runId });
  assert.equal(stop.ok, true, `G: Stop must succeed (got: ${stop.error})`);

  // Recovery must not undo the Stop.
  harness.context.recoveryStarted = false;
  await assert.doesNotReject(harness.context.recoverIfNeeded());
  await harness.settle();

  assertScenarioContract(harness, { expectSent: 1, expectStatus: "stopped", label: "G/stop" });
  assert.equal(harness.stored().waitState, null, "G: Stop must clear any pending wait");
});

test("SCENARIO H: maxSends below the planned sends refuses to start at all", async () => {
  const harness = createWorkflowHarness();
  harness.pinCurrentDocument();

  const response = await harness.start(threePromptWorkflow({ maxSends: 2 }));
  await harness.settle();

  assert.equal(response.ok, false, "H: a workflow that plans more sends than maxSends must be refused");
  assert.equal(harness.page.clicks, 0, "H: a refused Start must not send anything");
  assert.equal(harness.stored(), null, "H: a refused Start must not persist a Run");
});

test("SCENARIO H: a corrupted cursor claiming maxSends refuses to send again", async () => {
  const harness = createWorkflowHarness();
  harness.pinCurrentDocument();

  await harness.start(threePromptWorkflow());
  await harness.settle();
  assertScenarioContract(harness, { expectSent: 3, expectStatus: "completed", label: "H/at-boundary" });

  // Forge a completed count onto the first position. Runtime cursor validation must
  // reject that inconsistent durable claim before the absolute send ceiling is reached.
  const completed = harness.stored();
  const beyond = {
    ...completed,
    status: "running",
    phase: "ready",
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: completed.workflow.maxSends }
  };
  harness.context.localRunnerToken += 1;
  await harness.context.executeRun(beyond, harness.context.localRunnerToken);

  assert.equal(harness.page.clicks, 3, "H: maxSends must be a hard ceiling on irreversible clicks");
  assert.equal(beyond.lastErrorCode, "send_budget_invalid");
  assert.equal(beyond.resumable, false, "H: an exhausted Run must require a fresh bounded Start");
});
