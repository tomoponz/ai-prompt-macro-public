import assert from "node:assert/strict";
import test from "node:test";

import {
  AIPM_FLOW_VERSION,
  AipmFlowError,
  MAX_FLOW_NESTING,
  MAX_FLOW_REPEAT_COUNT,
  MAX_FLOW_TEXT_BYTES,
  parseAipmFlow
} from "../src/flow-script.js";

function parse(body) {
  return parseAipmFlow(body);
}

function expectCode(source, code) {
  assert.throws(
    () => parse(source),
    (error) => {
      assert.ok(error instanceof AipmFlowError);
      assert.equal(error.code, code);
      assert.ok(error.line >= 1);
      assert.ok(error.column >= 1);
      return true;
    }
  );
}

test("parses a single multiline send", () => {
  const result = parse('flow qa { send """review this""" }');
  assert.equal(result.version, AIPM_FLOW_VERSION);
  assert.equal(result.flows[0].name, "qa");
  assert.equal(result.flows[0].plannedSends, 1);
  assert.equal(result.flows[0].steps[0].prompt, "review this");
});

test("parses multiple sends", () => {
  const result = parse('flow qa { send """one""" send """two""" }');
  assert.equal(result.flows[0].plannedSends, 2);
});

test("parses finite repeat and counts sends statically", () => {
  const result = parse('flow qa { repeat 5 { send """next""" } }');
  assert.equal(result.flows[0].plannedSends, 5);
  assert.equal(result.flows[0].steps[0].count, 5);
});

test("parses checkpoint without consuming send budget", () => {
  const result = parse('flow qa { send """one""" checkpoint "最終確認" send """two""" }');
  assert.equal(result.flows[0].plannedSends, 2);
  assert.equal(result.flows[0].plannedActions, 3);
  assert.equal(result.flows[0].steps[1].type, "checkpoint");
  assert.equal(result.flows[0].steps[1].label, "最終確認");
});

test("allows fifty compactable sends plus one checkpoint", () => {
  const result = parse('flow qa { repeat 50 { send """x""" } checkpoint "確認" }');
  assert.equal(result.flows[0].plannedSends, 50);
  assert.equal(result.flows[0].plannedActions, 51);
});

test("treats braces and command-like text inside Prompt as plain Prompt text", () => {
  const prompt = 'if response contains { nope }\nrepeat 999 { send "x" }';
  const result = parse(`flow qa { send """${prompt}""" }`);
  assert.equal(result.flows[0].steps[0].prompt, prompt);
  assert.equal(result.flows[0].plannedSends, 1);
});

test("preserves Japanese multiline Prompt text", () => {
  const result = parse(`flow qa {
    send """
現在の実装をレビューしてください。
次に重要な問題を1つ探してください。
"""
  }`);
  assert.match(result.flows[0].steps[0].prompt, /現在の実装/);
  assert.match(result.flows[0].steps[0].prompt, /次に重要/);
});

test("dedents multiline Prompt text before exact composer delivery", () => {
  const result = parse(`flow qa {
    send """
      line1
        line2
      line3
    """
  }`);
  assert.equal(result.flows[0].steps[0].prompt, "line1\n  line2\nline3");
});

test("dedent preserves intentional leading and trailing whitespace after the common indent", () => {
  const trailingSpaces = "  ";
  const result = parse(`flow qa {
    send """
        first line
      second line${trailingSpaces}
    """
  }`);
  assert.equal(result.flows[0].steps[0].prompt, "  first line\nsecond line  ");
});

test("ignores hash line comments outside Prompt strings", () => {
  const result = parse(`
    # document comment
    flow qa { # flow comment
      send """# preserved inside Prompt""" # send comment
      repeat 2 { # repeat comment
        send """next"""
      }
    }
  `);
  assert.equal(result.flows[0].plannedSends, 3);
  assert.equal(result.flows[0].steps[0].prompt, "# preserved inside Prompt");
});

test("parses multiple flows without combining their send budgets", () => {
  const result = parse(`
    flow research { send """research""" }
    flow review { repeat 2 { send """review""" } }
  `);
  assert.deepEqual(result.flows.map((flow) => flow.plannedSends), [1, 2]);
});

test("accepts exactly 50 planned sends", () => {
  const result = parse('flow max { repeat 50 { send """x""" } }');
  assert.equal(result.flows[0].plannedSends, 50);
});

test("rejects 51 planned sends", () => {
  expectCode('flow max { repeat 51 { send """x""" } }', "TOO_MANY_SENDS");
});

for (const invalid of ["0", "-1", "1.5", "NaN", "Infinity", "abc"]) {
  test(`rejects invalid repeat value ${invalid}`, () => {
    expectCode(`flow qa { repeat ${invalid} { send """x""" } }`, "INVALID_REPEAT");
  });
}

test("rejects huge numeric repeat without numeric overflow", () => {
  expectCode(`flow qa { repeat ${"9".repeat(200)} { send """x""" } }`, "TOO_MANY_SENDS");
});

test("rejects oversized repeat even when its body sends nothing", () => {
  expectCode(`flow qa { repeat ${MAX_FLOW_REPEAT_COUNT + 1} { checkpoint "確認" } }`, "INVALID_REPEAT");
});

test("rejects nested checkpoint expansion before compile", () => {
  expectCode('flow qa { repeat 50 { repeat 50 { checkpoint "確認" } } }', "TOO_MANY_ACTIONS");
});

test("rejects more than 40 top-level checkpoint actions", () => {
  const body = Array.from({ length: 41 }, () => 'checkpoint "確認"').join(" ");
  expectCode(`flow qa { ${body} }`, "TOO_MANY_ACTIONS");
});

test("allows exactly 40 top-level checkpoint actions", () => {
  const body = Array.from({ length: 40 }, (_, index) => `checkpoint "確認 ${index}"`).join(" ");
  const result = parse(`flow qa { ${body} }`);
  assert.equal(result.flows[0].plannedActions, 40);
});

test("rejects empty checkpoint label", () => {
  expectCode('flow qa { checkpoint "   " }', "EMPTY_CHECKPOINT");
});

test("rejects unterminated checkpoint label", () => {
  expectCode('flow qa { checkpoint "確認 }', "UNTERMINATED_STRING");
});

test("parses bounded wait durations in every supported unit", () => {
  const result = parse("flow qa { wait 500ms wait 30s wait 5m wait 1h }");
  assert.deepEqual(result.flows[0].steps.map((step) => step.durationMs), [500, 30_000, 300_000, 3_600_000]);
  assert.equal(result.flows[0].plannedSends, 0);
  assert.equal(result.flows[0].plannedActions, 4);
});

test("parses wait-until with explicit late policy and grace", () => {
  const result = parse('flow qa { wait until "2026-08-25T09:00:00+09:00" late skip grace 30m }');
  assert.deepEqual(result.flows[0].steps[0], {
    type: "wait-until",
    at: "2026-08-25T00:00:00.000Z",
    latePolicy: "skip",
    graceMs: 1_800_000,
    offset: 10
  });
});

test("wait-until defaults to fail-safe pause and five-minute grace", () => {
  const result = parse('flow qa { wait until "2026-08-25T09:00:00Z" }');
  assert.equal(result.flows[0].steps[0].latePolicy, "pause");
  assert.equal(result.flows[0].steps[0].graceMs, 300_000);
});

for (const invalid of ["0s", "-1s", "1.5s", "NaNs", "Infinitys", "25h", "999999999999999999999999h"]) {
  test(`rejects invalid wait duration ${invalid}`, () => {
    expectCode(`flow qa { wait ${invalid} }`, "INVALID_DURATION");
  });
}

test("allows zero grace but rejects grace above the 24-hour cap", () => {
  const result = parse('flow qa { wait until "2026-08-25T09:00:00Z" grace 0ms }');
  assert.equal(result.flows[0].steps[0].graceMs, 0);
  expectCode('flow qa { wait until "2026-08-25T09:00:00Z" grace 25h }', "INVALID_DURATION");
});

for (const invalid of [
  "2026-08-25T09:00:00",
  "2026-02-30T09:00:00Z",
  "2026-08-25T25:00:00Z",
  "not-a-date"
]) {
  test(`rejects invalid or timezone-ambiguous timestamp ${invalid}`, () => {
    expectCode(`flow qa { wait until "${invalid}" }`, "INVALID_TIMESTAMP");
  });
}

test("rejects invalid and duplicate wait-until options", () => {
  expectCode('flow qa { wait until "2026-08-25T09:00:00Z" late retry }', "INVALID_LATE_POLICY");
  expectCode('flow qa { wait until "2026-08-25T09:00:00Z" late pause late run }', "DUPLICATE_WAIT_OPTION");
  expectCode('flow qa { wait until "2026-08-25T09:00:00Z" grace 1m grace 2m }', "DUPLICATE_WAIT_OPTION");
});

test("wait actions share the forty non-send action cap", () => {
  const body = Array.from({ length: 41 }, () => "wait 1s").join(" ");
  expectCode(`flow qa { ${body} }`, "TOO_MANY_ACTIONS");
});

test("still rejects genuinely unknown commands", () => {
  expectCode('flow qa { sleep 30s }', "UNKNOWN_COMMAND");
});

test("bounds user-controlled unknown command text in errors", () => {
  const token = "x".repeat(500);
  assert.throws(
    () => parse(`flow qa { ${token} }`),
    (error) => error instanceof AipmFlowError && error.message.length < 180 && !error.message.includes(token)
  );
});

test("rejects malformed braces", () => {
  expectCode('flow qa { send """x"""', "UNCLOSED_BLOCK");
});

test("rejects unterminated multiline string", () => {
  expectCode('flow qa { send """x }', "UNTERMINATED_STRING");
});

test("rejects empty flow", () => {
  expectCode("flow qa { }", "EMPTY_FLOW");
});

test("rejects duplicate flow names case-insensitively", () => {
  expectCode('flow qa { send """x""" } flow QA { send """y""" }', "DUPLICATE_FLOW_NAME");
});

test("rejects excessive repeat nesting", () => {
  let source = "flow deep { ";
  for (let i = 0; i < MAX_FLOW_NESTING + 1; i += 1) source += "repeat 1 { ";
  source += 'send """x""" ';
  for (let i = 0; i < MAX_FLOW_NESTING + 1; i += 1) source += "} ";
  source += "}";
  expectCode(source, "EXCESSIVE_NESTING");
});

test("rejects excessive input size", () => {
  const prompt = "あ".repeat(MAX_FLOW_TEXT_BYTES);
  expectCode(`flow qa { send """${prompt}""" }`, "INPUT_TOO_LARGE");
});

test("does not consult browser DOM or extension runtime while parsing", () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "document", { configurable: true, get() { throw new Error("DOM access"); } });
  Object.defineProperty(globalThis, "chrome", { configurable: true, get() { throw new Error("runtime access"); } });
  try {
    const result = parse('flow qa { send """safe""" }');
    assert.equal(result.flows[0].plannedSends, 1);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else delete globalThis.document;
    if (previousChrome) Object.defineProperty(globalThis, "chrome", previousChrome);
    else delete globalThis.chrome;
  }
});
