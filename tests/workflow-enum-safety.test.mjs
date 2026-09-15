import assert from "node:assert/strict";
import test from "node:test";
import { countPlannedSends, normalizeWorkflow } from "../src/workflow.js";
import { normalizeUiStateEntry } from "../src/ui-state-store.js";
import { readStartSourceForTab } from "../src/sidepanel-start-source.js";
import { installSidePanelHarness, tick } from "./helpers/sidepanel-harness.mjs";

const UI_KEY = "aipm.uiByTab.v2";
function entry(step = { type: "prompt", delivery: "send" }) {
  return {
    mode: "workflow", editorRevision: 1,
    workflow: { schemaVersion: 1, maxSends: 1, steps: [{ id: "one", prompt: "FIXTURE ONLY", ...step }] }
  };
}

for (const delivery of ["send", "draft"]) {
  test(`F2: known ${delivery} remains ${delivery} through the saved Start source`, async () => {
    const saved = normalizeUiStateEntry(entry({ type: "prompt", delivery }));
    const source = await readStartSourceForTab(1, {
      storageArea: { get: async () => ({ [UI_KEY]: { 1: saved } }) }
    });
    assert.equal(source.workflow.steps[0].delivery, delivery);
    assert.equal(source.summary.plannedSends, delivery === "send" ? 1 : 0);
  });
}

test("F2: schema 1 legacy missing own type/delivery fields explicitly migrate to prompt/send", async () => {
  // Before 6558e27, schema 1 presets had neither field and normalized prompts
  // had no delivery field. Only absence retains this historical migration.
  for (const step of [{}, { type: "prompt" }]) {
    const source = await readStartSourceForTab(1, {
      storageArea: { get: async () => ({ [UI_KEY]: { 1: entry(step) } }) }
    });
    assert.equal(source.workflow.steps[0].type, "prompt");
    assert.equal(source.workflow.steps[0].delivery, "send");
    assert.equal(countPlannedSends(source.workflow), 1);
  }
});

const invalidSteps = [
  ...["draft-v2", "future", "", null, undefined, 1, ["send"], {}].map((value) =>
    ({ field: "delivery", value, step: { type: "prompt", delivery: value } })),
  ...["prompt-v2", "unknown", "", null, undefined, 1, ["prompt"], {}].map((value) =>
    ({ field: "type", value, step: { type: value, delivery: "send" } }))
];

for (const { field, value, step } of invalidSteps) {
  test(`F2: explicit ${field}=${JSON.stringify(value)} is rejected before any Start dispatch`, async () => {
    const malformed = entry(step);
    const persisted = normalizeUiStateEntry(malformed);
    assert.deepEqual(persisted.workflow, malformed.workflow, "storage does not upgrade unknown enums");
    assert.throws(() => normalizeWorkflow(persisted.workflow));
    await assert.rejects(() => readStartSourceForTab(1, {
      storageArea: { get: async () => ({ [UI_KEY]: { 1: persisted } }) }
    }), (error) => error.code === "START_EDITOR_STATE_INVALID");

    const panel = await installSidePanelHarness({
      tabIds: [1], storageSeed: { "aipm.selectedTab.v1": 1, [UI_KEY]: { 1: entry() } }
    });
    try {
      await tick();
      // Change storage after restoration to exercise the real Start handler's
      // fresh source read, not merely an initialization-time validation failure.
      panel.storage.set(UI_KEY, { 1: persisted });
      await panel.click("start");
      assert.equal(panel.messages.filter((message) => message.payload?.type === "AIPM_START").length, 0,
        "no content Start means no Send can be authorized by this malformed source");
      assert.deepEqual(panel.storage.get(UI_KEY)[1].workflow, malformed.workflow);
    } finally {
      panel.restoreGlobals();
    }
  });
}

test("F2: future schema remains rejected at normalization and saved Start boundaries", async () => {
  const future = entry();
  future.workflow.schemaVersion = 2;
  assert.throws(() => normalizeWorkflow(future.workflow));
  await assert.rejects(() => readStartSourceForTab(1, {
    storageArea: { get: async () => ({ [UI_KEY]: { 1: future } }) }
  }), (error) => error.code === "START_EDITOR_STATE_INVALID");
});
