import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { DELAY_SECONDS_MAX, DELAY_SECONDS_MIN } from "../src/settings-store.js";

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
const manifest = JSON.parse(read("../manifest.json"));
const optionsHtml = read("../src/options.html");
const optionsJs = read("../src/options.js");
const sidepanelHtml = read("../src/sidepanel.html");
const sidepanelJs = read("../src/sidepanel.js");

/* Permission surface frozen at the Phase 1 baseline. Any addition must be a
   deliberate, separately reviewed change. */
const BASELINE_PERMISSIONS = ["storage", "sidePanel", "alarms", "scripting", "power"];
const BASELINE_HOST_PERMISSIONS = ["https://chatgpt.com/*"];

test("manifest stays valid MV3", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(typeof manifest.name, "string");
  assert.equal(typeof manifest.version, "string");
});

test("permission set is unchanged by the settings shell", () => {
  assert.deepEqual(manifest.permissions, BASELINE_PERMISSIONS);
});

test("host permission set is unchanged by the settings shell", () => {
  assert.deepEqual(manifest.host_permissions, BASELINE_HOST_PERMISSIONS);
});

test("no web_accessible_resources were introduced", () => {
  assert.equal("web_accessible_resources" in manifest, false);
});

test("options_ui is registered and opens in a browser tab", () => {
  assert.deepEqual(manifest.options_ui, { page: "src/options.html", open_in_tab: true });
  assert.ok(fs.existsSync(new URL("../src/options.html", import.meta.url)));
});

test("existing side panel registration is untouched", () => {
  assert.deepEqual(manifest.side_panel, { default_path: "src/sidepanel.html" });
  assert.equal(manifest.background.service_worker, "src/background.js");
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://chatgpt.com/*"]);
});

test("settings page loads only its own assets", () => {
  assert.match(optionsHtml, /href="ui-tokens\.css"/);
  assert.match(optionsHtml, /href="options\.css"/);
  assert.match(optionsHtml, /src="options\.js"/);
  /* The settings surface must not pull in Run/authority modules. */
  for (const name of ["background.js", "content-core.js", "content-runner.js", "content-controller.js"]) {
    assert.equal(optionsHtml.includes(name), false, `${name} must not be referenced`);
  }
});

test("settings page starts in a loading state so unread values are not shown as stored", () => {
  assert.match(optionsHtml, /aria-busy="true"/);
  assert.match(optionsJs, /setAttribute\("aria-busy", "false"\)/);
});

test("controls without an implementation are disabled rather than fake", () => {
  /* theme and accent left this list when the theme phase implemented them; the
     rule itself is unchanged, so anything still unbuilt must stay disabled. */
  for (const id of ["sidePanelSections", "manageData"]) {
    const pattern = new RegExp(`id="${id}"[^>]*disabled`);
    assert.match(optionsHtml, pattern, `${id} must be disabled while unimplemented`);
  }
  assert.ok(optionsHtml.includes("準備中"), "unimplemented controls must say so");
});

test("implemented appearance controls are enabled and offer their real options", () => {
  for (const id of ["theme", "accent", "mode", "density"]) {
    const pattern = new RegExp(`id="${id}"[^>]*disabled`);
    assert.doesNotMatch(optionsHtml, pattern, `${id} is implemented and must not be disabled`);
  }
  /* The theme list is built from themes/registry.js rather than hardcoded, so
     the catalogue and the selector cannot drift apart. Its contents are
     asserted against the registry in tests/production-theme.test.mjs. */
  assert.match(optionsHtml, /<select id="theme"><\/select>/);
  assert.match(optionsJs, /themesByGroup\(\)/);
  for (const mode of ["system", "light", "dark"]) {
    assert.ok(optionsHtml.includes(`<option value="${mode}">`), `${mode} must remain selectable`);
  }
});

test("defaults section states that existing editors and active Runs are preserved", () => {
  assert.ok(optionsHtml.includes("保存済みの実行内容と、実行中の自動化は変更しません"));
});

test("Options delay input and hint use the Settings runtime-aligned constants", () => {
  assert.equal(DELAY_SECONDS_MIN, 0);
  assert.equal(DELAY_SECONDS_MAX, 300);
  assert.match(optionsHtml, /id="delaySeconds"/);
  assert.match(optionsHtml, /id="delaySecondsHint"/);
  assert.doesNotMatch(optionsHtml, /delaySeconds[^>]*max="3600"/);
  assert.equal(optionsHtml.includes("0〜3600秒"), false);
  assert.match(optionsJs, /el\.delaySeconds\.min = String\(DELAY_SECONDS_MIN\)/);
  assert.match(optionsJs, /el\.delaySeconds\.max = String\(DELAY_SECONDS_MAX\)/);
  assert.match(optionsJs, /delaySecondsHint\.textContent = `\$\{DELAY_SECONDS_MIN\}〜\$\{DELAY_SECONDS_MAX\}秒。`/);
});

test("settings page sends no runtime messages and touches no Run state", () => {
  for (const forbidden of ["sendMessage", "AIPM_", "activeRun", "chrome.tabs", "chrome.scripting"]) {
    assert.equal(optionsJs.includes(forbidden), false, `options.js must not use ${forbidden}`);
  }
});

test("settings page never reports success on a failed save", () => {
  const savedIndex = optionsJs.indexOf('"保存しました"');
  const okGuardIndex = optionsJs.indexOf("if (result.ok)");
  assert.ok(okGuardIndex >= 0 && savedIndex > okGuardIndex, "success text must sit inside the ok branch");
  assert.ok(optionsJs.includes("保存できませんでした"));
});

test("side panel keeps its existing feature sections in Phase 1", () => {
  for (const id of ["quickPanel", "workflowPanel", "flowPanel", "runCard", "targetTab", "diagnostics"]) {
    assert.ok(sidepanelHtml.includes(`id="${id}"`), `#${id} must still exist in Phase 1`);
  }
  for (const label of ["Flowライブラリ", "読み込み / 書き出し", "復旧方針"]) {
    assert.ok(sidepanelHtml.includes(label), `${label} must still exist in Phase 1`);
  }
});

test("side panel gains only a settings entry point", () => {
  assert.ok(sidepanelHtml.includes('id="openSettings"'));
  assert.ok(sidepanelJs.includes("chrome.runtime.openOptionsPage"));
  /* The entry point must be optional so a missing element cannot throw. */
  assert.match(sidepanelJs, /querySelector\("#openSettings"\)\?\.addEventListener/);
});

test("side panel settings entry point carries no Run authority", () => {
  const start = sidepanelJs.indexOf('querySelector("#openSettings")');
  const block = sidepanelJs.slice(start, start + 220);
  for (const forbidden of ["AIPM_", "sendToContent", "sendRunControl", "expectedRunId"]) {
    assert.equal(block.includes(forbidden), false, `settings entry point must not use ${forbidden}`);
  }
});
