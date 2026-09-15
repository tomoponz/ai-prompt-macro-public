import assert from "node:assert/strict";
import test from "node:test";

import { buildExecutionPlan, summarizeExecutionPlan } from "../src/execution-plan.js";
import { compileAipmFlow } from "../src/flow-compile.js";
import { countPlannedSends } from "../src/workflow.js";

const compiled = compileAipmFlow(`flow partial {
  send """A"""
  wait 1s
  checkpoint "確認"
  send """B"""
  send """C"""
}`).flows[0];

test("this step only builds a fresh one-block plan without moving a runtime cursor", () => {
  const plan = buildExecutionPlan(compiled, { mode: "step", start: "4" });
  assert.equal(plan.partial, true);
  assert.equal(plan.workflow.steps.length, 1);
  assert.equal(plan.workflow.steps[0].prompt, "B");
  assert.equal(plan.rangeLabel, "手順 4 のみ");
  assert.equal(JSON.stringify(plan).includes("cursor"), false);
});

test("start from step and selected range preserve source order", () => {
  const from = buildExecutionPlan(compiled, { mode: "from", start: "4" });
  assert.deepEqual(from.workflow.steps.map((step) => step.prompt), ["B", "C"]);

  const range = buildExecutionPlan(compiled, { mode: "range", start: "1", end: "3" });
  assert.deepEqual(range.workflow.steps.map((step) => step.type), ["prompt", "delay", "checkpoint"]);
});

test("range repeat expands a new bounded plan with unique durable step IDs", () => {
  const plan = buildExecutionPlan(compiled, { mode: "range-repeat", start: "4", end: "5", repeat: "3" });
  assert.deepEqual(plan.workflow.steps.map((step) => step.prompt), ["B", "C", "B", "C", "B", "C"]);
  assert.equal(new Set(plan.workflow.steps.map((step) => step.id)).size, 6);
  assert.equal(countPlannedSends(plan.workflow), 6);
});

test("checkpoint resume builds a new plan after the selected checkpoint", () => {
  const checkpointId = compiled.workflow.steps.find((step) => step.type === "checkpoint").id;
  const plan = buildExecutionPlan(compiled, { mode: "after-checkpoint", checkpointId });
  assert.deepEqual(plan.workflow.steps.map((step) => step.prompt), ["B", "C"]);
  assert.match(plan.rangeLabel, /Checkpoint/);
});

test("partial plans revalidate sends=50 and blocks=40 after range expansion", () => {
  const send50 = compileAipmFlow('flow max { repeat 50 { send """X""" } }').flows[0];
  assert.throws(
    () => buildExecutionPlan(send50, { mode: "range-repeat", start: "1", end: "1", repeat: "2" }),
    /100回送信予定/
  );

  const fortyWaits = compileAipmFlow(`flow waits { ${Array.from({ length: 40 }, () => "wait 1s").join(" ")} }`).flows[0];
  assert.throws(
    () => buildExecutionPlan(fortyWaits, { mode: "range-repeat", start: "1", end: "40", repeat: "2" }),
    /80 blocks/
  );
});

test("invalid indices, huge repeat and empty checkpoint tails fail closed", () => {
  for (const spec of [
    { mode: "step", start: "0" },
    { mode: "range", start: "4", end: "2" },
    { mode: "range-repeat", start: "4", end: "5", repeat: "999999999999999999999" },
    { mode: "after-checkpoint", checkpointId: "stale-id" }
  ]) assert.throws(() => buildExecutionPlan(compiled, spec));

  const endCheckpoint = compileAipmFlow('flow end { send """A""" checkpoint "終端" }').flows[0];
  assert.throws(() => buildExecutionPlan(endCheckpoint, {
    mode: "after-checkpoint",
    checkpointId: endCheckpoint.workflow.steps[1].id
  }), /後に実行する手順がありません/);
});

test("Preview reports the generated plan rather than the source cursor", () => {
  const plan = buildExecutionPlan(compiled, { mode: "range-repeat", start: "1", end: "2", repeat: "2" });
  const summary = summarizeExecutionPlan(compiled, plan);
  assert.equal(summary.executionRange, "手順 1〜2 × 2");
  assert.equal(summary.plannedSends, 2);
  assert.equal(summary.blocks, 4);
  assert.equal(summary.waits, 2);
  assert.equal(summary.delaySteps, 2);
  assert.equal(summary.waitUntilSteps, 0);
  assert.equal(summary.checkpoints, 0);
  assert.equal(summary.repeatCycles, 2);
});
