/*
  Phase 3: the Side Panel gains a Workspace entry point and loses explanation
  only sections, which move to the Workspace. These tests fix two things at
  once: that the navigation is permission free and renderer free, and that
  nothing functional was lost from the cockpit while the prose moved out.
*/
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
const manifest = JSON.parse(read("../manifest.json"));
const sidepanelHtml = read("../src/sidepanel.html");
const sidepanelJs = read("../src/sidepanel.js");
const workspaceHtml = read("../src/workspace.html");
const workspaceJs = read("../src/workspace.js");
const backgroundJs = read("../src/background.js");
const contentCore = read("../src/content-core.js");
const contentRunner = read("../src/content-runner.js");
const contentController = read("../src/content-controller.js");
const uxGuidance = read("../src/ux-guidance.js");

const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const sidepanelCode = stripComments(sidepanelJs);
const workspaceCode = stripComments(workspaceJs);

/* The sections Phase 3 moves out of the Side Panel, keyed by a sentence that
   appears nowhere else. */
const MOVED_HELP = [
  "AIに自動化の手順を作ってもらう",
  "PC本体が起動状態のままなら、画面だけが消灯しても実行できます",
  "各ChatGPTタブは個別の実行状態と自動化フロー編集状態を持ちます",
  "入力欄へ指示を入れるだけで自動送信せず、「確認が必要」で止まります",
  "1回の実行で自動送信できるのは最大50回です"
];

/* ------------------------------------------------- 1-3 the navigation itself */

test("side panel exposes a Workspace entry point", () => {
  assert.match(sidepanelHtml, /id="openWorkspace"/);
  assert.match(sidepanelHtml, /<button id="openWorkspace"[^>]*>ワークスペース<\/button>/);
  /* It sits with the settings entry point, not inside the Run controls. */
  assert.ok(sidepanelHtml.indexOf('id="openWorkspace"') < sidepanelHtml.indexOf('id="runCard"'));
});

test("the workspace URL is built with runtime.getURL", () => {
  assert.match(sidepanelCode, /chrome\.runtime\.getURL\("src\/workspace\.html"\)/);
  assert.ok(fs.existsSync(new URL("../src/workspace.html", import.meta.url)));
});

test("opening the workspace is a bare tabs.create and nothing else", () => {
  const start = sidepanelCode.indexOf("#openWorkspace");
  assert.ok(start > 0, "handler must exist");
  const handler = sidepanelCode.slice(start, start + 260);
  assert.match(handler, /chrome\.tabs\.create\(\{ url: chrome\.runtime\.getURL\("src\/workspace\.html"\) \}\)/);
  for (const forbidden of [
    "sendMessage", "executeScript", "chrome.scripting", "AIPM_",
    "windows.create", "storage", "sidePanel"
  ]) {
    assert.equal(handler.includes(forbidden), false, `workspace navigation must not use ${forbidden}`);
  }
});

/* -------------------------------------------- 4-5 no new contact with ChatGPT */

test("the side panel sends no message to a ChatGPT tab and injects no script", () => {
  for (const forbidden of ["tabs.sendMessage", "executeScript", "chrome.scripting"]) {
    assert.equal(sidepanelCode.includes(forbidden), false, `sidepanel.js must not use ${forbidden}`);
  }
});

test("tabs.create is the only chrome.tabs call the side panel makes", () => {
  const calls = [...sidepanelCode.matchAll(/chrome\.tabs\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(calls)].sort(), ["create"]);
});

/* ------------------------------------ 6, 24-25 workspace stays read-only, idle */

test("the workspace gained no mutation control in Phase 3", () => {
  for (const id of ["startRun", "pauseRun", "resumeRun", "stopRun", "retryRun", "deleteRun", "confirmRun", "rebindRun"]) {
    assert.equal(workspaceHtml.includes(`id="${id}"`), false, `#${id} must not exist`);
  }
  for (const forbidden of ["AIPM_", "sendMessage", "executeScript", "chrome.scripting", "chrome.tabs", "chatgpt.com"]) {
    assert.equal(workspaceCode.includes(forbidden), false, `workspace.js must not use ${forbidden}`);
  }
});

test("the workspace still runs no timer after the help view was added", () => {
  for (const forbidden of ["setInterval", "setTimeout", "requestAnimationFrame", "requestIdleCallback"]) {
    assert.equal(workspaceCode.includes(forbidden), false, `workspace.js must not use ${forbidden}`);
  }
  /* View switching is class work on markup that is already in the document, so
     it triggers no read of any kind. */
  assert.match(workspaceCode, /function setView\(next\)/);
  const start = workspaceCode.indexOf("function setView(next)");
  const body = workspaceCode.slice(start, workspaceCode.indexOf("function bind()"));
  for (const forbidden of ["chrome.", "fetch(", "await", "refreshFromStorage"]) {
    assert.equal(body.includes(forbidden), false, `setView must not use ${forbidden}`);
  }
});

test("only the nav buttons take part in view switching", () => {
  /* The root marker uses a different attribute name on purpose: data-view on
     the root would make the root element itself match the nav selector, so a
     click anywhere on the page would run the handler. */
  assert.match(workspaceCode, /document\.querySelectorAll\("button\[data-view\]"\)/);
  assert.equal(workspaceCode.includes('querySelectorAll("[data-view]")'), false);
  assert.match(workspaceCode, /el\.root\.dataset\.activeView = view/);
  const roots = [...workspaceHtml.matchAll(/<div class="workspace"[^>]*>/g)];
  assert.equal(roots.length, 1);
  assert.equal(roots[0][0].includes("data-view"), false);
  /* Every data-view holder in the markup is a button. */
  for (const [tag] of workspaceHtml.matchAll(/<[a-z]+[^>]*\bdata-view="[^"]*"[^>]*>/g)) {
    assert.ok(tag.startsWith("<button"), `data-view must sit on a button: ${tag}`);
  }
});

/* ----------------------------------------------- 7-16 nothing functional lost */

test("Run controls stay in the side panel", () => {
  for (const id of ["start", "pause", "resume", "stop"]) {
    assert.match(sidepanelHtml, new RegExp(`id="${id}"`), `#${id} must still exist`);
    assert.match(sidepanelCode, new RegExp(`el\\.${id}\\b`), `sidepanel.js must still drive #${id}`);
  }
});

test("Confirmation Required and fail-closed surfaces stay in the side panel", () => {
  assert.match(sidepanelHtml, /id="statusBadge"[^>]*>待機中</);
  assert.match(sidepanelHtml, /id="nextAction"/);
  assert.match(sidepanelHtml, /id="recoveryMode"/);
  assert.match(sidepanelHtml, /id="advancedRecovery"/);
  for (const id of ["statusRecovery", "readinessRecovery", "identityRetries"]) {
    assert.ok(sidepanelHtml.includes(`id="${id}"`), `#${id} must still exist`);
  }
});

test("target selection, aliases and keep-awake stay in the side panel", () => {
  for (const id of ["targetTab", "targetAlias", "refreshTabs", "keepAwake"]) {
    assert.ok(sidepanelHtml.includes(`id="${id}"`), `#${id} must still exist`);
  }
  assert.ok(sidepanelHtml.includes("スリープ防止"));
});

test("Phase 4D keeps only compact Quick authoring interactive in the side panel", () => {
  for (const id of ["quickPanel", "quickPrompt", "quickRepeat", "quickDelay"]) {
    assert.ok(sidepanelHtml.includes(`id="${id}"`), `#${id} must still exist`);
  }
  assert.match(sidepanelHtml, /id="authoringCompatibilityState"[^>]*\bhidden\b[^>]*\binert\b/);
  for (const id of ["flowEditorPanel", "workflowEditorPanel", "workspaceFlowText", "workspaceSteps"]) {
    assert.ok(workspaceHtml.includes(`id="${id}"`), `Workspace #${id} must exist`);
  }
});

test("Flow Library management is Workspace-primary", () => {
  for (const id of [
    "workspaceLibraryList", "workspaceLibrarySaveNew", "workspaceLibraryUpdate", "workspaceLibraryOpen",
    "workspaceLibraryRename", "workspaceLibraryDuplicate", "workspaceLibraryDelete", "workspaceLibraryFavorite",
    "workspaceLibrarySearch", "workspaceLibraryExport"
  ]) {
    assert.ok(workspaceHtml.includes(`id="${id}"`), `Workspace #${id} must exist`);
  }
});

test("Import, Export and Preview are Workspace-primary", () => {
  for (const id of ["workspaceImportFile", "workspaceImportPaste", "workspaceImportText", "workspaceExportFile", "copyWorkspaceFlow"]) {
    assert.ok(workspaceHtml.includes(`id="${id}"`), `Workspace #${id} must exist`);
  }
  for (const id of ["workspacePreviewName", "workspacePreviewCheckpoints", "workspacePreviewSends", "workspacePreviewBlocks"]) {
    assert.ok(workspaceHtml.includes(`id="${id}"`), `Workspace #${id} must exist`);
  }
});

test("Settings stays reachable from both surfaces", () => {
  assert.ok(sidepanelHtml.includes('id="openSettings"'));
  assert.ok(workspaceHtml.includes('id="openSettings"'));
  assert.match(sidepanelCode, /openOptionsPage/);
  assert.match(workspaceCode, /openOptionsPage/);
});

test("live diagnostics and the developer reload stay in the side panel", () => {
  /* These are not explanation: one is Run evidence, the other is a control. */
  assert.ok(sidepanelHtml.includes('id="diagnostics"'));
  assert.ok(sidepanelHtml.includes('id="reloadExtension"'));
  assert.ok(sidepanelHtml.includes('id="extensionVersion"'));
});

/* --------------------------------------------- 17-18 the move actually happened */

test("every moved help section now exists in the workspace", () => {
  for (const text of MOVED_HELP) {
    assert.ok(workspaceHtml.includes(text), `workspace must carry: ${text}`);
  }
  assert.match(workspaceHtml, /id="viewHelp"/);
  assert.match(workspaceHtml, /data-view="help"/);
  assert.match(workspaceHtml, /id="aiFlowGoal"/);
  assert.match(workspaceHtml, /id="copyAiHelper"/);
  assert.match(workspaceHtml, /src="ux-guidance\.js"/);
});

test("only the moved explanation left the side panel", () => {
  for (const text of MOVED_HELP) {
    assert.equal(sidepanelHtml.includes(text), false, `side panel must no longer carry: ${text}`);
  }
  assert.equal(sidepanelHtml.includes("ux-guidance.js"), false, "the helper script moved with its markup");
  for (const id of ["aiFlowGoal", "copyAiHelper", "aiHelperText"]) {
    assert.equal(sidepanelHtml.includes(`id="${id}"`), false);
  }
});

test("the AI helper keeps its output-blind, local-only contract after the move", () => {
  for (const forbidden of [
    "fetch(", "XMLHttpRequest", "sendBeacon", "chrome.runtime.sendMessage",
    "chrome.tabs", "executeScript", "AIPM_"
  ]) {
    assert.equal(uxGuidance.includes(forbidden), false, `ux-guidance.js must not use ${forbidden}`);
  }
  /* The clipboard write is still reached only from a click handler. */
  assert.match(uxGuidance, /copyButton\?\.addEventListener\("click", copyHelperText\)/);
  assert.match(uxGuidance, /navigator\.clipboard\?\.writeText/);
});

/* ----------------------------------------------------------- 19 output blind */

test("neither surface displays prompt or answer text from a Run", () => {
  for (const forbidden of ["assistantText", "responseText", "answerText", "promptHash", "documentInstanceId", "executionSessionId"]) {
    assert.equal(workspaceCode.includes(forbidden), false, `workspace.js must not read ${forbidden}`);
  }
  assert.ok(workspaceHtml.includes("AIの回答本文は取得・保存・解析しません"));
  assert.ok(workspaceHtml.includes("会話内容・入力内容・回答本文は取得しません"));
});

/* --------------------------------------- 20-23 permissions and authority files */

test("Phase 3 changes no permission and no host permission", () => {
  assert.deepEqual(manifest.permissions, ["storage", "sidePanel", "alarms", "scripting", "power"]);
  assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*"]);
  assert.equal("web_accessible_resources" in manifest, false);
  /* tabs.create on an own extension page needs no "tabs" permission. */
  assert.equal(manifest.permissions.includes("tabs"), false);
});

test("the workspace page still needs no manifest registration", () => {
  assert.equal(JSON.stringify(manifest).includes("workspace"), false);
});

test("background and content scripts know nothing about the workspace", () => {
  for (const [name, source] of [
    ["background.js", backgroundJs],
    ["content-core.js", contentCore],
    ["content-runner.js", contentRunner],
    ["content-controller.js", contentController]
  ]) {
    assert.equal(source.includes("workspace"), false, `${name} must not reference the workspace`);
    assert.equal(source.includes("openWorkspace"), false, `${name} must not reference the entry point`);
  }
});
