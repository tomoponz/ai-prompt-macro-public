import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
const manifest = JSON.parse(read("../manifest.json"));
const packageJson = JSON.parse(read("../package.json"));
const sidepanel = read("../src/sidepanel.html");
const sidepanelJs = read("../src/sidepanel.js");
const workspace = read("../src/workspace.html");
const background = read("../src/background.js");
const controller = read("../src/content-controller.js");
const runner = read("../src/content-runner.js");
const workflow = read("../src/workflow.js");

test("FR1: Practical 0.4.0 preserves the exact Strict content-script chain and narrow authority", () => {
  assert.equal(manifest.version, "0.4.0");
  assert.equal(packageJson.version, "0.4.0");
  assert.equal(manifest.default_locale, "ja");
  assert.deepEqual(manifest.permissions, ["storage", "sidePanel", "alarms", "scripting", "power"]);
  assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*"]);
  assert.deepEqual(manifest.content_scripts[0].js, [
    "src/content-core.js",
    "src/content-runner.js",
    "src/content-controller.js"
  ]);
  assert.equal(JSON.stringify(manifest).includes("<all_urls>"), false);
  for (const path of manifest.content_scripts[0].js) {
    assert.equal(fs.existsSync(new URL(`../${path}`, import.meta.url)), true, `${path} must exist`);
  }
});

test("FR2: Quick, Workflow, Flow, Library, saved automation and partial execution remain present", () => {
  for (const id of [
    "savedAutomation", "quickPanel", "quickPrompt", "quickRepeat", "quickDelay",
    "authoringCompatibilityState", "workflowPanel", "flowPanel", "flowLibraryList",
    "flowImportText", "flowExecutionMode", "flowRangeControls", "flowCheckpointControls"
  ]) assert.ok(sidepanel.includes(`id="${id}"`), `Side Panel must retain #${id}`);
  for (const id of [
    "viewEditor", "flowEditorPanel", "workflowEditorPanel", "workspaceFlowText",
    "workspaceLibraryList", "workspaceImportText", "workspaceExecutionMode", "workspaceSteps"
  ]) assert.ok(workspace.includes(`id="${id}"`), `Workspace must retain #${id}`);
});

test("FR3: explicit target, aliases, controls, diagnostics and Keep Awake remain present", () => {
  for (const id of [
    "targetTab", "targetAlias", "targetColor", "targetGroup", "refreshTabs", "keepAwake",
    "start", "pause", "resume", "stop", "progress", "diagnostics", "reloadExtension"
  ]) assert.ok(sidepanel.includes(`id="${id}"`), `Side Panel must retain #${id}`);
  assert.match(sidepanelJs, /selectedTabId/);
  assert.match(background, /tabId/);
  assert.match(background, /executionSessionId/);
});

test("FR4: bounded execution, durable reload and exactly-once delivery guards remain wired", () => {
  assert.match(workflow, /MAX_SENDS_PER_RUN\s*=\s*50/);
  assert.match(runner, /MAX_SENDS_PER_RUN/);
  assert.match(runner, /send_clicked/);
  assert.match(controller, /outbox/);
  assert.match(controller, /AIPM_RESUME/);
  assert.match(controller, /AIPM_STOP/);
  assert.match(background, /document-lifetime-grant/);
  assert.match(background, /bound-content-sender/);
});

test("FR5: Output-Blind remains explicit and assistant body fields do not enter UI projection", () => {
  const surfaces = `${sidepanel}\n${workspace}`;
  assert.match(surfaces, /回答本文は取得・保存・解析しません|回答本文は取得しません/);
  for (const forbidden of ["assistantText", "responseText", "answerText", "assistantMessageBody"]) {
    assert.equal(surfaces.includes(forbidden), false, `${forbidden} must not enter extension surfaces`);
  }
});

test("FR6: Japanese locale assets and Japanese primary navigation are packaged", () => {
  const ja = JSON.parse(read("../_locales/ja/messages.json"));
  const en = JSON.parse(read("../_locales/en/messages.json"));
  assert.equal(ja.extensionName.message, "AI Prompt Macro");
  assert.ok(ja.extensionDescription.message.includes("最大50回"));
  assert.ok(en.extensionDescription.message.length > 0);
  assert.match(sidepanel, />実行コントロール</);
  assert.match(sidepanel, />ワークスペース</);
  assert.match(workspace, />ワークスペース</);
});
