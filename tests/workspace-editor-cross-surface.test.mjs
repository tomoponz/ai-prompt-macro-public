import assert from "node:assert/strict";
import test from "node:test";

import { WorkspaceEditorSession } from "../src/workspace-editor-state.js";
import { installSidePanelHarness, tick } from "./helpers/sidepanel-harness.mjs";

const UI_KEY = "aipm.uiByTab.v2";
const TAB = 1;

function entry(revision = 4, prompt = "BASE") {
  return {
    mode: "quick",
    keepAwake: false,
    recovery: { mode: "safe", identityAttempts: 3, readiness: "normal", statusRecovery: "normal" },
    quick: { preset: "review", prompt, repeat: "3", delay: "1.5" },
    workflow: { schemaVersion: 1, id: "wf", name: "workflow", maxSends: 1, recovery: { mode: "safe" }, steps: [] },
    flow: { text: "flow base { }", selectedIndex: 0, openedLibraryId: null, execution: { mode: "full" } },
    editorRevision: revision,
    updatedAt: 1
  };
}

async function panel() {
  const harness = await installSidePanelHarness({
    tabIds: [TAB],
    storageSeed: {
      "aipm.selectedTab.v1": TAB,
      [UI_KEY]: { [TAB]: entry() }
    }
  });
  await tick();
  return harness;
}

async function triggerPanelSave(harness) {
  harness.el("keepAwake").checked = !harness.el("keepAwake").checked;
  await harness.change("keepAwake");
  await tick();
}

test("real Side Panel save makes an already-open Workspace writer stale", async () => {
  const harness = await panel();
  try {
    const workspace = new WorkspaceEditorSession();
    await workspace.open(TAB);
    const workspaceDraft = workspace.snapshot();
    workspaceDraft.flow.text = "workspace unsaved DOM";
    workspace.replaceState(workspaceDraft);

    harness.el("quickPrompt").value = "SIDE PANEL WON";
    await triggerPanelSave(harness);
    const setsAfterPanel = harness.storage.get(UI_KEY)[TAB].editorRevision;
    assert.equal(setsAfterPanel, 5);

    const result = await workspace.save();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "stale");
    assert.equal(harness.storage.get(UI_KEY)[TAB].quick.prompt, "SIDE PANEL WON");
    assert.equal(workspace.snapshot().flow.text, "workspace unsaved DOM");
  } finally {
    harness.restoreGlobals();
  }
});

test("Workspace save makes the real Side Panel stale while its unsaved DOM remains", async () => {
  const harness = await panel();
  try {
    const workspace = new WorkspaceEditorSession();
    await workspace.open(TAB);
    const workspaceState = workspace.snapshot();
    workspaceState.flow.text = "flow workspace { }";
    workspace.replaceState(workspaceState);

    harness.el("quickPrompt").value = "SIDE PANEL UNSAVED DOM";
    const result = await workspace.save();
    assert.equal(result.ok, true);
    const map = structuredClone(harness.storage.get(UI_KEY));
    harness.fireStorageChanged({ [UI_KEY]: { newValue: map } }, "local");
    assert.match(harness.el("editorStateNotice").textContent, /別の画面/);

    const revisionBefore = map[TAB].editorRevision;
    await triggerPanelSave(harness);
    assert.equal(harness.storage.get(UI_KEY)[TAB].editorRevision, revisionBefore);
    assert.equal(harness.storage.get(UI_KEY)[TAB].flow.text, "flow workspace { }");
    assert.equal(harness.el("quickPrompt").value, "SIDE PANEL UNSAVED DOM");
  } finally {
    harness.restoreGlobals();
  }
});
