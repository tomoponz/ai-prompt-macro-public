import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_COMPILED_FLOW_STEPS,
  compileAipmFlow
} from "../src/flow-compile.js";
import { AipmFlowError } from "../src/flow-script.js";
import { countPlannedSends } from "../src/workflow.js";

function expectCode(source, code) {
  assert.throws(
    () => compileAipmFlow(source),
    (error) => {
      assert.ok(error instanceof AipmFlowError);
      assert.equal(error.code, code);
      return true;
    }
  );
}

test("compiles sends through the existing normalized Workflow model", () => {
  const result = compileAipmFlow('flow qa { send """one""" send """two""" }');
  const compiled = result.flows[0];

  assert.equal(compiled.name, "qa");
  assert.equal(compiled.plannedSends, 2);
  assert.equal(compiled.workflow.schemaVersion, 1);
  assert.equal(compiled.workflow.maxSends, 2);
  assert.deepEqual(compiled.workflow.steps.map((step) => step.prompt), ["one", "two"]);
  assert.ok(compiled.workflow.steps.every((step) => step.type === "prompt" && step.delivery === "send"));
  assert.equal(countPlannedSends(compiled.workflow), 2);
});

test("compiles checkpoint through the existing Workflow model without consuming send budget", () => {
  const result = compileAipmFlow('flow qa { send """one""" checkpoint "最終確認" send """two""" }');
  const workflow = result.flows[0].workflow;

  assert.deepEqual(workflow.steps.map((step) => step.type), ["prompt", "checkpoint", "prompt"]);
  assert.equal(workflow.steps[1].label, "最終確認");
  assert.equal(result.flows[0].plannedSends, 2);
  assert.equal(countPlannedSends(workflow), 2);
});

test("compiles wait and wait-until through the existing normalized Workflow model", () => {
  const result = compileAipmFlow(`flow scheduled {
    send """prepare"""
    wait 30s
    wait until "2026-08-25T09:00:00+09:00" late run grace 10m
    checkpoint "確認"
  }`);
  const workflow = result.flows[0].workflow;

  assert.deepEqual(workflow.steps.map((step) => step.type), ["prompt", "delay", "wait-until", "checkpoint"]);
  assert.equal(workflow.steps[1].durationMs, 30_000);
  assert.equal(workflow.steps[2].at, "2026-08-25T00:00:00.000Z");
  assert.equal(workflow.steps[2].latePolicy, "run");
  assert.equal(workflow.steps[2].graceMs, 600_000);
  assert.equal(new Set(workflow.steps.map((step) => step.id)).size, workflow.steps.length);
  assert.equal(result.flows[0].plannedSends, 1);
});

test("compiles wait-only Flow without manufacturing a planned Send", () => {
  const result = compileAipmFlow("flow timer { wait 1h }");
  assert.equal(result.flows[0].plannedSends, 0);
  assert.equal(countPlannedSends(result.flows[0].workflow), 0);
  assert.equal(result.flows[0].workflow.maxSends, 1);
});

test("statically expands repeat blocks while preserving execution order", () => {
  const result = compileAipmFlow(`flow qa {
    repeat 2 {
      send """A"""
      send """B"""
    }
    send """C"""
  }`);

  assert.deepEqual(
    result.flows[0].workflow.steps.map((step) => step.prompt),
    ["A", "B", "A", "B", "C"]
  );
  assert.equal(result.flows[0].plannedSends, 5);
});

test("statically expands checkpoints inside repeat blocks in order", () => {
  const result = compileAipmFlow(`flow qa {
    repeat 2 {
      checkpoint "確認"
      send """A"""
    }
  }`);

  assert.deepEqual(result.flows[0].workflow.steps.map((step) => step.type), ["checkpoint", "prompt", "checkpoint", "prompt"]);
  assert.equal(result.flows[0].plannedSends, 2);
});

test("compacts adjacent identical sends so an exact-50 repeat stays within the existing Workflow model", () => {
  const result = compileAipmFlow('flow max { repeat 50 { send """x""" } }');
  const workflow = result.flows[0].workflow;

  assert.equal(workflow.steps.length, 1);
  assert.equal(workflow.steps[0].repeat, 50);
  assert.equal(workflow.maxSends, 50);
  assert.equal(countPlannedSends(workflow), 50);
});

test("compiles exact-50 repeated sends followed by checkpoint", () => {
  const result = compileAipmFlow('flow max { repeat 50 { send """x""" } checkpoint "確認" }');
  const workflow = result.flows[0].workflow;

  assert.deepEqual(workflow.steps.map((step) => step.type), ["prompt", "checkpoint"]);
  assert.equal(workflow.steps[0].repeat, 50);
  assert.equal(result.flows[0].plannedSends, 50);
  assert.equal(countPlannedSends(workflow), 50);
});

test("compiles exactly forty distinct sends at the shared Workflow block cap", () => {
  const body = Array.from(
    { length: MAX_COMPILED_FLOW_STEPS },
    (_, index) => `send """prompt-${index}"""`
  ).join(" ");
  const result = compileAipmFlow(`flow max_distinct { ${body} }`);
  const workflow = result.flows[0].workflow;

  assert.equal(MAX_COMPILED_FLOW_STEPS, 40);
  assert.equal(workflow.steps.length, 40);
  assert.equal(workflow.maxSends, 40);
  assert.equal(countPlannedSends(workflow), 40);
});

test("rejects forty-one compiled Workflow blocks", () => {
  const body = Array.from({ length: 41 }, (_, index) => `send """prompt-${index}"""`).join(" ");
  expectCode(`flow too_many_blocks { ${body} }`, "WORKFLOW_TOO_MANY_BLOCKS");
});

test("compilation is deterministic and agrees with the parser send count", () => {
  const source = `flow deterministic { repeat 3 { send """A""" checkpoint "確認" } send """B""" }`;
  const first = compileAipmFlow(source);
  const second = compileAipmFlow(source);
  assert.deepEqual(first, second);
  assert.equal(first.flows[0].plannedSends, countPlannedSends(first.flows[0].workflow));
});

test("compiles multiple flows independently with collision-safe workflow ids", () => {
  const result = compileAipmFlow(`
    flow foo { send """research""" }
    flow foo- { repeat 2 { send """review""" } }
  `);

  assert.deepEqual(result.flows.map((flow) => flow.name), ["foo", "foo-"]);
  assert.deepEqual(result.flows.map((flow) => flow.plannedSends), [1, 2]);
  assert.notEqual(result.flows[0].workflow.id, result.flows[1].workflow.id);
});

test("does not bypass parser send-budget validation", () => {
  expectCode('flow max { repeat 51 { send """x""" } }', "TOO_MANY_SENDS");
});

test("does not consult browser DOM or extension runtime while compiling", () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "document", { configurable: true, get() { throw new Error("DOM access"); } });
  Object.defineProperty(globalThis, "chrome", { configurable: true, get() { throw new Error("runtime access"); } });
  try {
    const result = compileAipmFlow('flow qa { send """safe""" }');
    assert.equal(result.flows[0].plannedSends, 1);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else delete globalThis.document;
    if (previousChrome) Object.defineProperty(globalThis, "chrome", previousChrome);
    else delete globalThis.chrome;
  }
});
