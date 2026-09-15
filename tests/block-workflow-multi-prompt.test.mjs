import test from "node:test";
import assert from "node:assert/strict";
import {
  OUTPUT_BLIND_ADAPTER_SURFACE,
  clone,
  createWorkflowHarness,
  promptsSent
} from "./helpers/workflow-harness.mjs";

test("STAGE1: A -> Delay -> B -> Delay -> C sends all three prompts exactly once, in order", async () => {
  const harness = createWorkflowHarness();

  const response = await harness.start();
  await harness.settle();

  assert.equal(response.ok, true, `Start must succeed (got: ${response.error})`);
  assert.deepEqual(promptsSent(harness), ["PROMPT A", "PROMPT B", "PROMPT C"], "all three prompts, in order, once each");
  assert.equal(harness.page.clicks, 3, "exactly three irreversible clicks");
  assert.equal(harness.stored().status, "completed");
  assert.equal(harness.stored().phase, "completed");
  assert.equal(harness.stored().cursor.sendsCompleted, 3);
  assert.equal(harness.stored().outbox, null);
  assert.equal(harness.stored().waitState, null);
});

for (const failureMode of ["reject", "response"]) {
  test(`ISSUE27: ${failureMode} lease-release failure lets only the exact running owner finish`, async () => {
    const harness = createWorkflowHarness({ leaseReleaseFailure: failureMode });

    assert.equal((await harness.start()).ok, true);
    await harness.settle();

    assert.deepEqual(promptsSent(harness), ["PROMPT A", "PROMPT B", "PROMPT C"]);
    assert.equal(harness.page.clicks, 3);
    assert.equal(harness.stored().status, "completed");
    assert.equal(
      harness.transcript.filter((entry) => entry.type === "lease-recover").length,
      1,
      "the exact owner must re-adopt its existing nonce once, without opening takeover"
    );
    assert.equal(
      new Set(harness.clicks().map((click) => click.position)).size,
      3,
      "ambiguous cleanup acknowledgement cannot duplicate a Send"
    );
  });
}

test("STAGE1: no prompt is sent while the previous generation is still running", async () => {
  const harness = createWorkflowHarness();
  await harness.start();
  await harness.settle();

  const clicks = harness.clicks();
  assert.equal(clicks.length, 3);
  for (let index = 1; index < clicks.length; index += 1) {
    const previousGenerationEnd = clicks[index - 1].at + 4_000;
    assert.ok(
      clicks[index].at >= previousGenerationEnd,
      `send ${index + 1} started at +${clicks[index].at - clicks[0].at}ms, before the previous generation finished`
    );
  }
});

test("STAGE1: neither Delay block deadline is short-circuited", async () => {
  const harness = createWorkflowHarness();
  await harness.start();
  await harness.settle();

  const delayStarts = harness.transcript.filter((entry) => entry.type === "delay-block-start");
  const clicks = harness.clicks();
  assert.equal(delayStarts.length, 2, "both Delay blocks must run");
  assert.ok(clicks[1].at - delayStarts[0].at >= 20_000, "Prompt B must wait out Delay 1");
  assert.ok(clicks[2].at - delayStarts[1].at >= 20_000, "Prompt C must wait out Delay 2");
});

test("STAGE1: cursor, waitState and sendsCompleted stay consistent across every durable write", async () => {
  const harness = createWorkflowHarness();
  await harness.start();
  await harness.settle();

  const saves = harness.saves();
  let previousSends = 0;
  let previousStep = 0;
  for (const saved of saves) {
    assert.ok(saved.cursor.sendsCompleted >= previousSends, "sendsCompleted must never rewind");
    assert.ok(saved.cursor.sendsCompleted <= saved.workflow.maxSends, "sendsCompleted must never exceed maxSends");
    assert.ok(saved.cursor.stepIndex >= previousStep, "stepIndex must never rewind");
    assert.ok(saved.cursor.repeatIndex === 0, "single-repeat prompts must never leave repeatIndex set");
    if (saved.waitState) assert.equal(saved.waitState.kind, "delay");
    previousSends = saved.cursor.sendsCompleted;
    previousStep = saved.cursor.stepIndex;
  }
  const final = saves.at(-1);
  assert.equal(final.cursor.stepIndex, 5);
  assert.equal(final.cursor.sendsCompleted, 3);
});

test("STAGE1: Pause between prompts then Resume still yields exactly three sends", async () => {
  let pauseArmed = true;
  const harness = createWorkflowHarness({
    async onSave({ run, context }) {
      if (!pauseArmed || run.cursor.sendsCompleted !== 1 || run.waitState?.stepId !== "delay-1") return;
      pauseArmed = false;
      context.localRunnerToken += 1;
    }
  });

  await harness.start();
  await harness.settle();
  assert.equal(pauseArmed, false, "the simulated pause point must be reached");
  assert.equal(harness.page.clicks, 1, "the runner must be suspended after Prompt A");

  const pause = await harness.control("AIPM_PAUSE", { expectedRunId: harness.stored().runId });
  assert.equal(pause.ok, true, `Pause must succeed (got: ${pause.error})`);
  assert.equal(harness.stored().status, "paused");
  assert.equal(harness.stored().outbox, null, "pausing between prompts must not create delivery ambiguity");

  const resume = await harness.control("AIPM_RESUME", { expectedRunId: harness.stored().runId });
  await harness.settle();

  assert.equal(resume.ok, true, `Resume must succeed (got: ${resume.error})`);
  assert.deepEqual(promptsSent(harness), ["PROMPT A", "PROMPT B", "PROMPT C"]);
  assert.equal(harness.page.clicks, 3, "Pause/Resume must neither duplicate nor drop a prompt");
  assert.equal(harness.stored().status, "completed");
});

test("STAGE1: Pause inside a Delay block then Resume waits out the remaining delay", async () => {
  let pauseArmed = true;
  let persistedUntil = null;
  const harness = createWorkflowHarness({
    async onSave({ run, context }) {
      if (!pauseArmed || run.waitState?.stepId !== "delay-1") return;
      pauseArmed = false;
      persistedUntil = Number(run.waitState.until);
      context.localRunnerToken += 1;
    }
  });

  await harness.start();
  await harness.settle();
  assert.equal(pauseArmed, false, "the Delay block must persist a deadline");
  assert.ok(Number.isFinite(persistedUntil));

  await harness.control("AIPM_PAUSE", { expectedRunId: harness.stored().runId });
  const paused = harness.stored();
  assert.equal(paused.status, "paused");
  assert.equal(paused.waitState.stepId, "delay-1", "the delay deadline must survive the Pause");
  assert.equal(Number(paused.waitState.until), persistedUntil);

  // Idle most of the way through the delay, then resume.
  harness.advance(15_000);
  const resumedAt = harness.now();
  await harness.control("AIPM_RESUME", { expectedRunId: harness.stored().runId });
  await harness.settle();

  const clicks = harness.clicks();
  assert.equal(clicks.length, 3);
  assert.ok(clicks[1].at >= persistedUntil, "Prompt B must not fire before the persisted Delay 1 deadline");
  assert.ok(
    clicks[1].at < resumedAt + 20_000,
    `Resume must honour the remaining delay, not restart it (fired at +${clicks[1].at - resumedAt}ms after Resume)`
  );
  assert.deepEqual(promptsSent(harness), ["PROMPT A", "PROMPT B", "PROMPT C"]);
  assert.equal(harness.stored().status, "completed");
});

test("STAGE1: a reload inside the post-send fence does not consume the following Delay block", async () => {
  let reloadArmed = true;
  const harness = createWorkflowHarness({
    async onSave({ run, context }) {
      if (!reloadArmed || run.waitState?.scope !== "after-send" || run.cursor.sendsCompleted !== 1) return;
      reloadArmed = false;
      context.localRunnerToken += 1;
    }
  });

  await harness.start();
  await harness.settle();
  assert.equal(reloadArmed, false, "the post-send fence must be reached");
  assert.equal(harness.page.clicks, 1);

  await harness.reload(500);

  const delayStarts = harness.transcript.filter((entry) => entry.type === "delay-block-start");
  const clicks = harness.clicks();
  assert.equal(delayStarts.length, 2, "the Delay blocks must still run after the reload");
  assert.ok(
    clicks[1].at - delayStarts[0].at >= 20_000,
    "the post-send fence must not be mistaken for the Delay block's own deadline"
  );
  assert.deepEqual(promptsSent(harness), ["PROMPT A", "PROMPT B", "PROMPT C"]);
  assert.equal(harness.page.clicks, 3);
});

test("STAGE1: a reload between prompts resumes and still sends exactly three times", async () => {
  let reloadArmed = true;
  const harness = createWorkflowHarness({
    async onSave({ run, context }) {
      if (!reloadArmed || run.cursor.sendsCompleted !== 1 || run.waitState?.stepId !== "delay-1") return;
      reloadArmed = false;
      context.localRunnerToken += 1;
    }
  });

  await harness.start();
  await harness.settle();
  assert.equal(reloadArmed, false, "the simulated reload point must be reached");

  await harness.reload(15_000);

  assert.deepEqual(promptsSent(harness), ["PROMPT A", "PROMPT B", "PROMPT C"]);
  assert.equal(harness.page.clicks, 3, "a reload must not duplicate or skip a prompt");
  assert.equal(harness.stored().status, "completed");
});

test("STAGE1: a reload inside a Delay block keeps the persisted delay deadline", async () => {
  let reloadArmed = true;
  let persistedUntil = null;
  const harness = createWorkflowHarness({
    async onSave({ run, context }) {
      if (!reloadArmed || run.waitState?.stepId !== "delay-2") return;
      reloadArmed = false;
      persistedUntil = Number(run.waitState.until);
      context.localRunnerToken += 1;
    }
  });

  await harness.start();
  await harness.settle();
  assert.equal(reloadArmed, false);
  assert.equal(harness.page.clicks, 2, "the invalidated runner must stop before Prompt C");

  const reloadWallClock = await harness.reload(15_000);

  const clicks = harness.clicks();
  assert.equal(clicks.length, 3);
  assert.ok(
    clicks[2].at >= persistedUntil,
    `Prompt C fired at ${clicks[2].at} but the persisted Delay 2 deadline was ${persistedUntil}`
  );
  assert.ok(
    clicks[2].at < reloadWallClock + 20_000,
    `reload must resume the remaining Delay 2, not restart it (fired +${clicks[2].at - reloadWallClock}ms after reload)`
  );
  assert.equal(harness.stored().status, "completed");
});

test("STAGE1: an ambiguous submit is never auto-retried and never advances the cursor", async () => {
  const harness = createWorkflowHarness({ ackConfirms: false });

  await harness.start();
  await harness.settle();

  const stored = harness.stored();
  assert.equal(harness.page.clicks, 1, "an unconfirmed submit must not be retried");
  assert.equal(stored.status, "paused");
  assert.equal(stored.phase, "ambiguous");
  assert.equal(stored.lastErrorCode, "submission_ambiguous");
  assert.equal(stored.resumable, false);
  assert.equal(stored.cursor.sendsCompleted, 0, "an ambiguous submit must not count as completed");
  assert.equal(stored.cursor.stepIndex, 0, "an ambiguous submit must not advance the cursor");
});

test("ISSUE23-2: exhausted identity probes before click automatically fail-close with zero sends", async () => {
  let injectedFailures = 0;
  const harness = createWorkflowHarness({
    onRunSet({ message, page }) {
      if (injectedFailures === 0 && page.clicks === 0 && message.run?.phase === "prepared") {
        injectedFailures += 1;
        return {
          ok: false,
          errorCode: "DOCUMENT_IDENTITY_UNCONFIRMED",
          error: "現在のdocument identityを再確認できないためRun更新を拒否しました。"
        };
      }
      return null;
    }
  });

  await harness.start();
  await harness.settle();

  const stopped = harness.stored();
  assert.equal(injectedFailures, 1);
  assert.equal(harness.page.clicks, 0, "identity-unconfirmed cannot reach the irreversible click");
  assert.equal(stopped.status, "paused");
  assert.equal(stopped.phase, "ambiguous");
  assert.equal(stopped.resumable, false);
  assert.equal(stopped.pauseReason, "document_identity_unconfirmed");
  assert.deepEqual(stopped.cursor, { repeatIndex: 0, sendsCompleted: 0, stepIndex: 0 });
  assert.equal(harness.transcript.filter((entry) => entry.type === "fail-closed").length, 1);
});

test("ISSUE23-4: identity failure after the irreversible click stays ambiguous and non-retriable", async () => {
  let injectedFailures = 0;
  const harness = createWorkflowHarness({
    onRunSet({ message, page }) {
      if (injectedFailures === 0 && page.clicks === 1 && message.run?.phase === "waiting-ack") {
        injectedFailures += 1;
        return {
          ok: false,
          errorCode: "DOCUMENT_IDENTITY_UNCONFIRMED",
          error: "現在のdocument identityを再確認できないためRun更新を拒否しました。"
        };
      }
      return null;
    }
  });

  await harness.start();
  await harness.settle();

  const stopped = harness.stored();
  assert.equal(injectedFailures, 1);
  assert.equal(harness.page.clicks, 1, "an ambiguous delivery is never clicked twice");
  assert.equal(stopped.status, "paused");
  assert.equal(stopped.phase, "ambiguous");
  assert.equal(stopped.resumable, false);
  assert.equal(stopped.pauseReason, "document_identity_unconfirmed");
  assert.equal(stopped.outbox?.state, "prepared", "the unfinished durable outbox is preserved");
  assert.deepEqual(stopped.cursor, { repeatIndex: 0, sendsCompleted: 0, stepIndex: 0 });
  assert.deepEqual(harness.clicks().map((entry) => entry.position), ["0:0"]);
  assert.equal(harness.transcript.filter((entry) => entry.type === "fail-closed").length, 1);

  const resume = await harness.control("AIPM_RESUME", { expectedRunId: stopped.runId });
  await harness.settle();
  assert.equal(resume.ok, false, "an ambiguous Run cannot be resumed automatically");
  assert.equal(harness.page.clicks, 1, "Resume cannot replay the ambiguous Send");
});

test("STAGE1: maxSends is never exceeded and the run stays Output-Blind", async () => {
  const harness = createWorkflowHarness();
  await harness.start();
  await harness.settle();

  assert.ok(harness.page.clicks <= harness.stored().workflow.maxSends);
  for (const member of harness.adapterCalls) {
    assert.ok(OUTPUT_BLIND_ADAPTER_SURFACE.has(member), `unexpected adapter member used: ${member}`);
  }
  assert.equal(harness.adapterCalls.has("getComposerText"), true, "the harness must actually exercise the adapter");
});

test("STAGE2: a zombie runner from before a reload cannot roll back adopted state", async () => {
  let reloadArmed = true;
  let zombieRun = null;
  const harness = createWorkflowHarness({
    async onSave({ run, context }) {
      if (!reloadArmed || run.cursor.sendsCompleted !== 1 || run.waitState?.stepId !== "delay-1") return;
      reloadArmed = false;
      zombieRun = clone(run);
      context.localRunnerToken += 1;
    }
  });

  await harness.start();
  await harness.settle();
  assert.equal(reloadArmed, false);
  await harness.reload(15_000);

  assert.equal(harness.page.clicks, 3);
  assert.equal(harness.stored().status, "completed");

  // The pre-reload runner wakes up late and tries to write the state it last observed.
  const beforeZombie = harness.stored();
  await assert.rejects(
    harness.context.saveActiveRun({ ...zombieRun, status: "running", phase: "ready" }),
    (error) => error?.code === "run_state_conflict",
    "a zombie writer must be rejected, not merged"
  );
  const afterZombie = harness.stored();
  assert.equal(afterZombie.status, "completed", "the completed Run must survive a zombie write");
  assert.equal(afterZombie.cursor.sendsCompleted, beforeZombie.cursor.sendsCompleted);
  assert.equal(harness.page.clicks, 3, "a rejected zombie write must not cause another send");
});
