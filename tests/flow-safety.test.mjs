import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { compileAipmFlow } from "../src/flow-compile.js";
import { MAX_SENDS_PER_RUN, MAX_WORKFLOW_BLOCKS, STEP_TYPES } from "../src/workflow.js";

const flowSource = await readFile(new URL("../src/flow-script.js", import.meta.url), "utf8");
const compileSource = await readFile(new URL("../src/flow-compile.js", import.meta.url), "utf8");
const runnerSource = await readFile(new URL("../src/content-runner.js", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));

test("Flow remains Output-Blind and contains no dynamic execution or network primitive", () => {
  const combined = `${flowSource}\n${compileSource}`;
  for (const forbidden of [
    /assistant(?:-|_)?output/i,
    /response\s+(?:contains|branch)/i,
    /\beval\s*\(/,
    /\bFunction\s*\(/,
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /chrome\./,
    /document\./
  ]) assert.doesNotMatch(combined, forbidden);
});

test("Flow compiles only to existing Workflow step types", () => {
  const result = compileAipmFlow('flow safe { send """A""" wait 1s wait until "2026-08-25T09:00:00Z" checkpoint "確認" repeat 2 { send """B""" } }');
  const types = new Set(result.flows[0].workflow.steps.map((step) => step.type));
  assert.deepEqual([...types].sort(), ["checkpoint", "delay", "prompt", "wait-until"]);
  assert.ok([...types].every((type) => STEP_TYPES.includes(type)));
});

test("shared UI and runtime limits stay at blocks=40 and sends=50", () => {
  assert.equal(MAX_WORKFLOW_BLOCKS, 40);
  assert.equal(MAX_SENDS_PER_RUN, 50);
  assert.match(runnerSource, /MAX_WORKFLOW_STEPS\s*=\s*40/);
  assert.match(runnerSource, /MAX_SENDS_PER_RUN/);
});

test("Flow adds no extension permissions", () => {
  assert.deepEqual(manifest.permissions, ["storage", "sidePanel", "alarms", "scripting", "power"]);
  assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*"]);
});
