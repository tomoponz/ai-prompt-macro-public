import assert from "node:assert/strict";
import test from "node:test";

import { buildAipmFlowMetaPrompt, MAX_AI_FLOW_GOAL_CHARS } from "../src/flow-authoring.js";
import { compileAipmFlow } from "../src/flow-compile.js";
import { buildExecutionPlan, summarizeExecutionPlan } from "../src/execution-plan.js";

const releaseFlowSource = `flow release {
  repeat 2 { send """改善""" wait 1s }
  wait until "2026-08-25T09:00:00+09:00"
  checkpoint "確認"
}`;

test("compiler preview reports source repeat commands and expanded step counts", () => {
  const compiled = compileAipmFlow(releaseFlowSource).flows[0];
  assert.equal(compiled.plannedSends, 2);
  assert.deepEqual(compiled.preview, {
    repeatCommands: 1,
    waits: 3,
    delaySteps: 2,
    waitUntilSteps: 1,
    checkpoints: 1
  });
});

test("full Flow preview derives sends and steps from the execution plan", () => {
  const compiled = compileAipmFlow(releaseFlowSource).flows[0];
  const plan = buildExecutionPlan(compiled, { mode: "full" });
  const expected = {
    flowName: "release",
    selectedFlow: "release",
    executionRange: "Flow全体",
    plannedSends: 2,
    blocks: 6,
    repeatCommands: 1,
    repeatCycles: 1,
    waits: 3,
    delaySteps: 2,
    waitUntilSteps: 1,
    checkpoints: 1
  };
  assert.deepEqual(summarizeExecutionPlan(compiled, plan), expected);

  const staleCounts = {
    ...compiled,
    plannedSends: 999,
    preview: {
      repeatCommands: 1,
      waits: 999,
      delaySteps: 999,
      waitUntilSteps: 999,
      checkpoints: 999
    }
  };
  assert.deepEqual(summarizeExecutionPlan(staleCounts, plan), expected);
});

test("invalid or absent compiled Flow cannot produce an execution plan or preview", () => {
  assert.throws(() => buildExecutionPlan(null), /有効なcompiled Flow/);
  assert.throws(() => buildExecutionPlan({ workflow: { steps: null } }), /1つ以上のblock/);
  const compiled = compileAipmFlow(releaseFlowSource).flows[0];
  const plan = buildExecutionPlan(compiled);
  assert.equal(summarizeExecutionPlan(null, plan), null);
  assert.equal(summarizeExecutionPlan(compiled, null), null);
});

test("AI Flow goal is Unicode-safe and hard bounded", () => {
  const prompt = buildAipmFlowMetaPrompt("界".repeat(MAX_AI_FLOW_GOAL_CHARS + 100));
  const goalSection = prompt.split("目的（上限を超えたため先頭部分のみ）:\n")[1].split("\n\n目的の末尾が省略されています。")[0];
  assert.equal(Array.from(goalSection.match(/界/g) ?? []).length, MAX_AI_FLOW_GOAL_CHARS);
});

test("AI Flow authoring remains a pure local text transform", () => {
  const previousFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const previousChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "fetch", { configurable: true, get() { throw new Error("network access"); } });
  Object.defineProperty(globalThis, "chrome", { configurable: true, get() { throw new Error("runtime access"); } });
  try {
    assert.match(buildAipmFlowMetaPrompt("日本語の目的"), /日本語の目的/);
  } finally {
    if (previousFetch) Object.defineProperty(globalThis, "fetch", previousFetch);
    else delete globalThis.fetch;
    if (previousChrome) Object.defineProperty(globalThis, "chrome", previousChrome);
    else delete globalThis.chrome;
  }
});
