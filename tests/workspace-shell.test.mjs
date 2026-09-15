import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
const manifest = JSON.parse(read("../manifest.json"));
const workspaceHtml = read("../src/workspace.html");
const workspaceJs = read("../src/workspace.js");
const workspaceEditorJs = read("../src/workspace-editor.js");
const workspaceEditorStateJs = read("../src/workspace-editor-state.js");
const projectionJs = read("../src/workspace-projection.js");
const backgroundJs = read("../src/background.js");
const sidepanelHtml = read("../src/sidepanel.html");

/* Comments describe what the module must NOT do, so scans for forbidden API
   names have to run against code only. */
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const workspaceCode = stripComments(workspaceJs);
const workspaceSurfaceCode = stripComments(`${workspaceJs}\n${workspaceEditorJs}\n${workspaceEditorStateJs}`);
const projectionCode = stripComments(projectionJs);

const BASELINE_PERMISSIONS = ["storage", "sidePanel", "alarms", "scripting", "power"];
const BASELINE_HOST_PERMISSIONS = ["https://chatgpt.com/*"];

test("workspace page exists and loads only its own assets", () => {
  assert.ok(fs.existsSync(new URL("../src/workspace.html", import.meta.url)));
  assert.match(workspaceHtml, /href="ui-tokens\.css"/);
  assert.match(workspaceHtml, /href="workspace\.css"/);
  assert.match(workspaceHtml, /src="workspace\.js"/);
  assert.ok(fs.existsSync(new URL("../src/workspace-editor.js", import.meta.url)));
  assert.ok(fs.existsSync(new URL("../src/workspace-editor-state.js", import.meta.url)));
  /* Phase 3 added the help view, which reuses the existing local helper. */
  assert.match(workspaceHtml, /src="ux-guidance\.js"/);
});

test("permissions and host permissions are unchanged by Phase 2", () => {
  assert.deepEqual(manifest.permissions, BASELINE_PERMISSIONS);
  assert.deepEqual(manifest.host_permissions, BASELINE_HOST_PERMISSIONS);
  assert.equal("web_accessible_resources" in manifest, false);
});

test("Phase 2 needs no manifest registration for the workspace page", () => {
  /* An extension page opened with runtime.getURL needs no manifest entry. */
  assert.equal(JSON.stringify(manifest).includes("workspace"), false);
});

/* ---------------------------------------------- no renderer contact, no poll */

test("workspace never sends a runtime or tab message", () => {
  for (const forbidden of [
    "AIPM_RUN_GET", "AIPM_GET_STATUS", "AIPM_RELAY_TO_CHATGPT", "AIPM_LIST_CHATGPT_TABS",
    "AIPM_HAS_ACTIVE_RUNS", "AIPM_RUN_SET", "AIPM_",
    "runtime.sendMessage", "tabs.sendMessage", "sendMessage"
  ]) {
    assert.equal(workspaceSurfaceCode.includes(forbidden), false, `Workspace surface must not use ${forbidden}`);
  }
});

test("workspace never injects a script or queries ChatGPT tabs", () => {
  for (const forbidden of ["executeScript", "chrome.scripting", "chrome.tabs", "tabs.query", "chatgpt.com"]) {
    assert.equal(workspaceSurfaceCode.includes(forbidden), false, `Workspace surface must not use ${forbidden}`);
  }
});

test("workspace runs no timers, so opening it cannot add renderer pressure", () => {
  for (const forbidden of ["setInterval", "setTimeout", "requestAnimationFrame", "requestIdleCallback"]) {
    assert.equal(workspaceSurfaceCode.includes(forbidden), false, `Workspace surface must not use ${forbidden}`);
  }
});

test("workspace refreshes from storage.onChanged only", () => {
  assert.match(workspaceCode, /storage\?\.onChanged\?\.addListener/);
  assert.match(workspaceCode, /storage\?\.local/);
  /* The key prefix itself lives in the projection module and is reached through
     isActiveRunKey, so assert both halves of that contract. */
  assert.match(projectionJs, /aipm\.activeRun\.v2\.tab\./);
  assert.match(workspaceCode, /isActiveRunKey/);
});

test("unrelated local storage keys do not trigger a Run re-render", () => {
  /* The listener must gate the Run refresh on the active-Run prefix. */
  assert.match(workspaceCode, /keys\.some\(isActiveRunKey\)/);
  const listenerStart = workspaceJs.indexOf("function onStorageChanged");
  assert.ok(listenerStart > 0);
  const listener = workspaceJs.slice(listenerStart, listenerStart + 900);
  assert.ok(listener.includes("areaName"), "listener must distinguish storage areas");
});

test("projection module performs no I/O at all", () => {
  /* "storage" alone would match the storageSnapshot parameter name, so target
     the actual I/O surfaces instead. */
  for (const forbidden of ["chrome.", "fetch(", "localStorage", "indexedDB", "sendMessage", "setTimeout", "setInterval"]) {
    assert.equal(projectionCode.includes(forbidden), false, `projection must not reference ${forbidden}`);
  }
});

/* ------------------------------------------------------------- no mutation */

test("no Run mutation control exists in the Phase 4B workspace", () => {
  /* Editor/Library delete is local authoring state, so pin Run controls by both
     their labels and ids rather than banning legitimate editor operations. */
  const controlButtons = [...workspaceHtml.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter(([, attrs]) => !attrs.includes("data-filter") && !attrs.includes("data-view"))
    .map(([, attrs, body]) => ({ attrs, body }));
  for (const label of ["開始", "一時停止", "再開", "停止", "リトライ", "再試行", "送信"]) {
    for (const button of controlButtons) {
      assert.equal(button.body.includes(label), false, `${label} Run button must not exist in Phase 4B`);
    }
  }
  const deleteButtons = controlButtons.filter((button) => button.body.includes("削除"));
  assert.deepEqual(deleteButtons.map((button) => button.attrs.match(/id="([^"]+)"/)?.[1]), ["workspaceLibraryDelete"]);
  for (const id of ["startRun", "pauseRun", "resumeRun", "stopRun", "retryRun", "deleteRun", "confirmRun", "rebindRun"]) {
    assert.equal(workspaceHtml.includes(`id="${id}"`), false);
  }
});

test("every enabled workspace button is an allowlisted navigation, helper, or editor-only action", () => {
  const editorButtons = new Set([
    "loadEditorTarget", "reloadEditorTarget", "saveEditorState", "flowEditorTab", "workflowEditorTab",
    "copyWorkspaceFlow", "workspaceImportPaste", "workspaceExportFile", "workspaceLibrarySaveNew",
    "workspaceLibraryUpdate", "workspaceLibraryOpen", "workspaceLibraryDuplicate", "workspaceLibraryRename",
    "workspaceLibraryDelete", "workspaceLibraryCopy", "workspaceLibraryExport", "workspaceLoadWorkflowPreset",
    "workspaceAddPrompt", "workspaceAddDelay", "workspaceAddWaitUntil", "workspaceAddCheckpoint"
  ]);
  const enabled = [...workspaceHtml.matchAll(/<button(?![^>]*disabled)[^>]*>/g)].map((m) => m[0]);
  for (const button of enabled) {
    const id = button.match(/id="([^"]+)"/)?.[1] ?? null;
    const allowed = button.includes("data-filter")
      || button.includes("data-view")
      || button.includes('id="openSettings"')
      || button.includes('id="copyAiHelper"')
      || editorButtons.has(id);
    assert.ok(allowed, `unexpected enabled button: ${button}`);
  }
});

test("unimplemented navigation is disabled and labelled", () => {
  assert.ok(workspaceHtml.includes("準備中"));
  const soonCount = (workspaceHtml.match(/準備中/g) ?? []).length;
  assert.equal(soonCount, 2, "only schedule and history remain unimplemented in Phase 4B");
});

/* -------------------------------------------------- DOM safety and snapshot */

test("workspace never uses innerHTML for user controlled strings", () => {
  for (const forbidden of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
    assert.equal(workspaceCode.includes(forbidden), false, `workspace.js must not use ${forbidden}`);
  }
  assert.match(workspaceCode, /name\.textContent = runDisplayName\(row\)/);
});

test("workspace states that it shows a stored snapshot, not current authority", () => {
  assert.ok(workspaceHtml.includes("保存済み状態の表示です"));
  assert.ok(workspaceHtml.includes("現在も接続できることや、安全に操作できることを保証しません"));
});

test("workspace editor uses the shared editor fence but never the Side Panel selection key", () => {
  assert.equal(workspaceSurfaceCode.includes("aipm.selectedTab"), false);
  assert.match(workspaceEditorJs, /WorkspaceEditorSession/);
  assert.match(workspaceEditorStateJs, /readUiStateForTab/);
  assert.match(workspaceEditorStateJs, /mutateUiStateForTab/);
});

test("workspace reuses the shared appearance seam", () => {
  assert.match(workspaceCode, /settings-store\.js/);
  /* The attribute mapping moved into theme.js in the theme phase, so the
     workspace must delegate to it rather than keep a private copy. The seam
     itself is asserted where it now lives, in tests/production-theme.test.mjs. */
  assert.match(workspaceCode, /from "\.\/theme\.js"/);
  assert.match(workspaceCode, /applyAppearance\(document\.documentElement/);
  assert.equal(workspaceCode.includes("dataset.aipm"), false, "workspace must not map appearance attributes itself");
});

/* ------------------------------------------------------ untouched surfaces */

test("background gained no workspace specific message type", () => {
  assert.equal(backgroundJs.includes("workspace"), false, "background.js must not know about the workspace");
  assert.equal(backgroundJs.includes("AIPM_WORKSPACE"), false);
});

test("side panel keeps its Phase 1 shape and reaches the workspace", () => {
  for (const id of ["quickPanel", "workflowPanel", "flowPanel", "runCard", "openSettings"]) {
    assert.ok(sidepanelHtml.includes(`id="${id}"`), `#${id} must still exist`);
  }
  /* Phase 3 added the entry point. tests/workspace-navigation.test.mjs fixes
     how it opens; here it only has to exist. */
  assert.ok(sidepanelHtml.includes('id="openWorkspace"'));
});
