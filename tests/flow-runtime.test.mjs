import assert from "node:assert/strict";
import test from "node:test";

import { compileAipmFlow } from "../src/flow-compile.js";
import { createWorkflowHarness, promptsSent } from "./helpers/workflow-harness.mjs";

test("compiled Flow executes through the existing runtime with clicks exactly equal to planned sends", async () => {
  const compiled = compileAipmFlow(`flow runtime {
    repeat 2 {
      send """A"""
      repeat 2 { send """B""" }
    }
    send """C"""
  }`).flows[0];
  const harness = createWorkflowHarness();

  const response = await harness.start(compiled.workflow);
  await harness.settle();

  assert.equal(response.ok, true);
  assert.equal(harness.clicks().length, compiled.plannedSends);
  assert.deepEqual(promptsSent(harness), ["A", "B", "B", "A", "B", "B", "C"]);
  assert.equal(harness.stored().status, "completed");
});

test("compiled Flow wait persists its deadline across target-tab reload", async () => {
  let reloadArmed = true;
  let persistedUntil = null;
  const harness = createWorkflowHarness({
    async onSave({ run, context }) {
      if (!reloadArmed || run.waitState?.stepId !== "flow-1-delay-2") return;
      reloadArmed = false;
      persistedUntil = Number(run.waitState.until);
      context.localRunnerToken += 1;
    }
  });
  const compiled = compileAipmFlow('flow reload_wait { send """A""" wait 20s send """B""" }').flows[0];

  await harness.start(compiled.workflow);
  await harness.settle();
  assert.equal(reloadArmed, false);
  assert.deepEqual(promptsSent(harness), ["A"]);

  await harness.reload(15_000);
  assert.deepEqual(promptsSent(harness), ["A", "B"]);
  assert.ok(harness.clicks()[1].at >= persistedUntil);
  assert.equal(harness.stored().status, "completed");
});

test("compiled Flow wait-until survives reload without an early or duplicate Send", async () => {
  let reloadArmed = true;
  const harness = createWorkflowHarness({
    async onSave({ run, context }) {
      if (!reloadArmed || run.waitState?.stepId !== "flow-1-wait-until-2") return;
      reloadArmed = false;
      context.localRunnerToken += 1;
    }
  });
  const scheduledAt = harness.now() + 20_000;
  const compiled = compileAipmFlow(`flow scheduled_reload {
    send """A"""
    wait until "${new Date(scheduledAt).toISOString()}" late pause grace 5m
    send """B"""
  }`).flows[0];

  await harness.start(compiled.workflow);
  await harness.settle();
  assert.equal(reloadArmed, false);
  assert.deepEqual(promptsSent(harness), ["A"]);

  await harness.reload(15_000);
  assert.deepEqual(promptsSent(harness), ["A", "B"]);
  assert.ok(harness.clicks()[1].at >= scheduledAt);
  assert.equal(harness.stored().status, "completed");
});

test("durable Stop during compiled Flow wait prevents every remaining Send", async () => {
  let stopArmed = true;
  const harness = createWorkflowHarness({
    async onSave({ run, context }) {
      if (!stopArmed || run.waitState?.stepId !== "flow-1-delay-2") return;
      stopArmed = false;
      context.localRunnerToken += 1;
    }
  });
  const compiled = compileAipmFlow('flow stop_wait { send """A""" wait 30s repeat 3 { send """B""" } }').flows[0];

  await harness.start(compiled.workflow);
  await harness.settle();
  assert.deepEqual(promptsSent(harness), ["A"]);

  const stopped = await harness.control("AIPM_STOP");
  await harness.settle();
  assert.equal(stopped.ok, true);
  assert.equal(harness.stored().status, "stopped");
  assert.deepEqual(promptsSent(harness), ["A"]);
});
