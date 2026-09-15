import assert from "node:assert/strict";
import test from "node:test";

import { buildExecutionPlan } from "../src/execution-plan.js";
import { compileAipmFlow } from "../src/flow-compile.js";
import {
  createFlowLibraryEntry,
  exportFlowText,
  upsertFlowLibraryEntry
} from "../src/flow-library.js";
import { createWorkflowHarness, promptsSent } from "./helpers/workflow-harness.mjs";

const SOURCE = `flow library_partial {
  send """A"""
  send """B"""
  wait 1s
  checkpoint "確認"
  send """C"""
}`;

test("Library source is recompiled before a partial plan is generated", () => {
  const entry = createFlowLibraryEntry({ source: SOURCE, name: "Library + partial" }, { id: "combined", now: 1 });
  const library = upsertFlowLibraryEntry(null, entry);
  const reopenedSource = exportFlowText(library.entries[0]);
  const recompiled = compileAipmFlow(reopenedSource).flows[0];
  const plan = buildExecutionPlan(recompiled, { mode: "range", start: "2", end: "3" });

  assert.deepEqual(plan.workflow.steps.map((step) => step.type), ["prompt", "delay"]);
  assert.equal(plan.workflow.steps[0].prompt, "B");
  assert.equal(JSON.stringify(library).includes("workflow"), false);
});

test("range repeat executes each selected Prompt exactly once per planned cycle", async () => {
  const compiled = compileAipmFlow('flow range { send """A""" send """B""" }').flows[0];
  const plan = buildExecutionPlan(compiled, { mode: "range-repeat", start: "1", end: "2", repeat: "3" });
  const harness = createWorkflowHarness();

  const started = await harness.start(plan.workflow);
  await harness.settle();
  assert.equal(started.ok, true);
  assert.deepEqual(promptsSent(harness), ["A", "B", "A", "B", "A", "B"]);
  assert.equal(new Set(harness.clicks().map((click) => click.position)).size, 6);
  assert.equal(harness.stored().status, "completed");
});

test("range repeat can execute the exact 50-send boundary without a duplicate or 51st Send", async () => {
  const source = 'flow exact_fifty { repeat 5 { send """EXACT-50""" } }';
  const compiled = compileAipmFlow(source).flows[0];
  const plan = buildExecutionPlan(compiled, {
    mode: "range-repeat",
    start: "1",
    end: "1",
    repeat: "10"
  });
  const harness = createWorkflowHarness();

  assert.equal(plan.workflow.maxSends, 50);
  assert.equal((await harness.start(plan.workflow)).ok, true);
  await harness.settle();

  assert.equal(harness.page.clicks, 50);
  assert.equal(new Set(harness.clicks().map((click) => click.position)).size, 50);
  assert.ok(promptsSent(harness).every((prompt) => prompt === "EXACT-50"));
  assert.equal(harness.stored().cursor.sendsCompleted, 50);
  assert.equal(harness.stored().status, "completed");
});

test("durable Stop during range execution prevents the remaining generated plan", async () => {
  let stopArmed = true;
  const harness = createWorkflowHarness({
    async onSave({ run, context }) {
      if (!stopArmed || run.cursor.sendsCompleted !== 2 || run.waitState?.scope !== "after-send") return;
      stopArmed = false;
      context.localRunnerToken += 1;
    }
  });
  const compiled = compileAipmFlow('flow range_stop { send """A""" send """B""" }').flows[0];
  const plan = buildExecutionPlan(compiled, { mode: "range-repeat", start: "1", end: "2", repeat: "3" });

  await harness.start(plan.workflow);
  await harness.settle();
  assert.deepEqual(promptsSent(harness), ["A", "B"]);

  const stopped = await harness.control("AIPM_STOP");
  await harness.settle();
  assert.equal(stopped.ok, true);
  assert.equal(harness.stored().status, "stopped");
  assert.deepEqual(promptsSent(harness), ["A", "B"]);
});
