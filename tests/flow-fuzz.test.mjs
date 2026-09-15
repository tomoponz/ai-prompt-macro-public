import assert from "node:assert/strict";
import test from "node:test";

import { compileAipmFlow } from "../src/flow-compile.js";
import { AipmFlowError } from "../src/flow-script.js";
import { MAX_SENDS_PER_RUN, MAX_WORKFLOW_BLOCKS, countPlannedSends } from "../src/workflow.js";

function deterministicInputs(count) {
  let state = 0x41c6ce57;
  const alphabet = "flow send repeat checkpoint {}#\n\t\"_-/0123456789abcXYZ日本語";
  const inputs = [];
  for (let index = 0; index < count; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    if (index % 17 === 0) {
      const repeat = (state % 50) + 1;
      inputs.push(`\n# seed ${state}\nflow fuzz_${index} { repeat ${repeat} { send """value-${state}""" } }`);
      continue;
    }
    const length = state % 160;
    let value = "";
    for (let offset = 0; offset < length; offset += 1) {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      value += alphabet[state % alphabet.length];
    }
    inputs.push(value);
  }
  return inputs;
}

test("5000 deterministic fuzz inputs either compile safely or return classified Flow errors", () => {
  const inputs = deterministicInputs(5000);
  assert.equal(inputs.length, 5000);
  let compiledCount = 0;

  for (const source of inputs) {
    try {
      const first = compileAipmFlow(source);
      const second = compileAipmFlow(source);
      assert.deepEqual(first, second, "successful compilation must be deterministic");
      for (const flow of first.flows) {
        compiledCount += 1;
        assert.ok(flow.workflow.steps.length <= MAX_WORKFLOW_BLOCKS);
        assert.ok(flow.plannedSends <= MAX_SENDS_PER_RUN);
        assert.equal(flow.plannedSends, countPlannedSends(flow.workflow));
      }
    } catch (error) {
      assert.ok(error instanceof AipmFlowError, `unclassified throw for ${JSON.stringify(source.slice(0, 80))}: ${error}`);
      assert.match(error.code, /^[A-Z0-9_]{1,64}$/);
    }
  }

  assert.ok(compiledCount >= 250, "the deterministic corpus must exercise successful compilation too");
});
