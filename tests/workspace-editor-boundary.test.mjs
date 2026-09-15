import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
const manifest = JSON.parse(read("../manifest.json"));
const html = read("../src/workspace.html");
const css = read("../src/workspace.css");
const workspace = read("../src/workspace.js");
const editor = read("../src/workspace-editor.js");
const state = read("../src/workspace-editor-state.js");
const sidePanel = read("../src/sidepanel.js");
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = stripComments(`${workspace}\n${editor}\n${state}`);

const BASELINE_PERMISSIONS = ["storage", "sidePanel", "alarms", "scripting", "power"];
const BASELINE_HOST_PERMISSIONS = ["https://chatgpt.com/*"];

test("Phase 4B exposes Flow, Workflow, Library, Import, Export and Preview", () => {
  for (const id of [
    "viewEditor", "workspaceFlowText", "workspaceFlowSelector", "workspacePreviewSends",
    "workspaceWorkflowName", "workspaceSteps", "workspaceWorkflowError",
    "workspaceLibraryList", "workspaceLibrarySaveNew", "workspaceLibraryUpdate",
    "workspaceLibraryOpen", "workspaceLibraryDuplicate", "workspaceLibraryRename",
    "workspaceLibraryDelete", "workspaceLibrarySearch", "workspaceLibraryFavorite",
    "workspaceImportText", "workspaceImportFile", "workspaceImportPaste", "workspaceExportFile"
  ]) assert.ok(html.includes(`id="${id}"`), `#${id} must exist`);
});

test("Phase 4B reuses the production compiler, planner, workflow, library and editor fence", () => {
  for (const moduleName of [
    "flow-compile.js", "flow-library.js", "flow-script.js", "execution-plan.js",
    "workflow.js", "ui-state-store.js"
  ]) assert.ok(`${editor}\n${state}`.includes(moduleName), `${moduleName} must be reused`);
  assert.match(state, /readUiStateForTab/);
  assert.match(state, /mutateUiStateForTab/);
  assert.match(state, /expectedRevision/);
  assert.match(editor, /normalizeWorkflow/);
  assert.match(editor, /compileAipmFlow/);
  assert.match(editor, /mutateFlowLibrary/);
});

test("Phase 4C keeps Side Panel and Workspace validation and Library fencing on the same shared modules", () => {
  for (const source of [sidePanel, editor]) {
    for (const moduleName of ["flow-compile.js", "execution-plan.js", "workflow.js", "flow-library.js"]) {
      assert.ok(source.includes(moduleName), `${moduleName} must be shared by both surfaces`);
    }
    assert.match(source, /compileAipmFlow\(/);
    assert.match(source, /buildExecutionPlan\(/);
    assert.match(source, /normalizeWorkflow\(/);
    assert.match(source, /mutateFlowLibrary\([^;]*expectedRevision/s);
    for (const duplicated of [
      "function compileAipmFlow", "function buildExecutionPlan", "function normalizeWorkflow"
    ]) assert.equal(source.includes(duplicated), false, `${duplicated} must not be surface-local`);
  }
});

test("Workspace adds no renderer contact, Run message, or polling surface", () => {
  for (const forbidden of [
    "runtime.sendMessage", "tabs.sendMessage", "executeScript", "chrome.scripting",
    "chrome.tabs", "tabs.query", "chatgpt.com", "AIPM_RUN", "AIPM_GET_STATUS",
    "setInterval", "setTimeout", "requestAnimationFrame", "requestIdleCallback"
  ]) assert.equal(code.includes(forbidden), false, `${forbidden} must not enter Workspace Phase 4B`);
});

test("Workspace selection is memory-only and never writes the Side Panel selected-tab key", () => {
  assert.equal(code.includes("aipm.selectedTab.v1"), false);
  assert.equal(code.includes("SELECTED_TAB_KEY"), false);
  assert.match(editor, /let knownEditorTabIds = \[\]/);
  assert.match(editor, /parseExactTabId/);
});

test("Workspace has no Run controls and its editor state has no Run authority fields", () => {
  for (const id of ["startRun", "pauseRun", "resumeRun", "stopRun", "rebindRun", "confirmRun"]) {
    assert.equal(html.includes(`id="${id}"`), false);
  }
  const stateBody = state.slice(state.indexOf("export function createWorkspaceEditorState"));
  for (const forbidden of [
    "run.workflow", "cursor", "stateRevision", "executionSessionId", "documentInstanceId",
    "leaseId", "outbox", "conversationKey"
  ]) assert.equal(stripComments(stateBody).includes(forbidden), false, `${forbidden} must not be stored by Workspace`);
});

test("Workspace performs editor writes only through the shared fenced modules", () => {
  assert.equal(editor.includes("chrome.storage.local.set"), false);
  assert.equal(state.includes("chrome.storage.local.set"), false);
  assert.equal(editor.includes("persistFlowLibrary"), false, "Library writes must use mutateFlowLibrary's lock");
  assert.match(editor, /mutateFlowLibrary/);
  assert.match(state, /WorkspaceEditorSession/);
  assert.match(state, /this\.stale/);
  assert.match(state, /this\.dirty/);
});

test("permissions, host permissions and manifest registration are unchanged", () => {
  assert.deepEqual(manifest.permissions, BASELINE_PERMISSIONS);
  assert.deepEqual(manifest.host_permissions, BASELINE_HOST_PERMISSIONS);
  assert.equal(JSON.stringify(manifest).includes("workspace"), false);
});

test("Workspace remains responsive without absolute-positioned editor layout", () => {
  assert.match(css, /\.editor-grid\s*\{[\s\S]*display:\s*grid/);
  assert.match(css, /@media \(max-width: 1240px\)/);
  assert.match(css, /@media \(max-width: 820px\)/);
  const editorCss = css.slice(css.indexOf("Phase 4B editor"));
  const withoutVisuallyHiddenFileInput = editorCss.replace(/\.file-button input\s*\{[^}]*\}/, "");
  assert.equal(withoutVisuallyHiddenFileInput.includes("position: absolute"), false);
});
