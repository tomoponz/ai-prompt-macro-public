import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  TAB_ALIAS_MAX_LENGTH,
  TAB_COLOR_PRESETS,
  TAB_GROUP_MAX_LENGTH,
  TAB_PRESENTATION_STORAGE_KEY,
  formatTabAliasLabel,
  normalizeTabAlias,
  normalizeTabAliasMap,
  normalizeTabColor,
  normalizeTabGroup,
  normalizeTabPresentationMap,
  tabAliasFor,
  tabPresentationFor,
  withTabAlias,
  withTabPresentation
} from "../src/tab-alias.js";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const ui = read("src/tab-alias-ui.js");
const html = read("src/sidepanel.html");
const packageJson = read("package.json");

test("tab aliases are normalized and bounded without splitting Unicode characters", () => {
  assert.equal(normalizeTabAlias("  AI\n\tGuardian  "), "AI Guardian");
  const longAlias = "😀".repeat(TAB_ALIAS_MAX_LENGTH + 5);
  const normalized = normalizeTabAlias(longAlias);
  assert.equal(Array.from(normalized).length, TAB_ALIAS_MAX_LENGTH);
  assert.equal(normalized, "😀".repeat(TAB_ALIAS_MAX_LENGTH));
});

test("presentation metadata accepts legacy aliases and bounds group and color", () => {
  const legacy = normalizeTabPresentationMap({ "101": "Review" });
  assert.deepEqual(legacy, {
    "101": { alias: "Review", color: "default", group: "" }
  });
  assert.equal(TAB_PRESENTATION_STORAGE_KEY, "aipm.tabAliases.v1");
  assert.deepEqual(TAB_COLOR_PRESETS, [
    "default", "blue", "green", "yellow", "orange", "red", "purple"
  ]);
  assert.equal(normalizeTabColor("url(javascript:alert(1))"), "default");
  assert.equal(normalizeTabColor("blue"), "blue");
  assert.equal(
    Array.from(normalizeTabGroup("😀".repeat(TAB_GROUP_MAX_LENGTH + 4))).length,
    TAB_GROUP_MAX_LENGTH
  );
});

test("tab alias maps remain isolated by tab id and blank aliases remove only that tab", () => {
  let aliases = normalizeTabAliasMap({ "101": "Review", invalid: "ignored", "-1": "ignored" });
  aliases = withTabAlias(aliases, 104, "AI Guardian");
  assert.equal(tabAliasFor(aliases, 101), "Review");
  assert.equal(tabAliasFor(aliases, 104), "AI Guardian");

  aliases = withTabAlias(aliases, 101, "   ");
  assert.equal(tabAliasFor(aliases, 101), "");
  assert.equal(tabAliasFor(aliases, 104), "AI Guardian");
});

test("alias, color and group remain isolated by exact tab id", () => {
  let presentations = withTabPresentation({}, 101, {
    alias: "Claude",
    color: "blue",
    group: "調査"
  });
  presentations = withTabPresentation(presentations, 202, {
    alias: "Claude",
    color: "green",
    group: "テスト"
  });
  assert.deepEqual(tabPresentationFor(presentations, 101), {
    alias: "Claude", color: "blue", group: "調査"
  });
  assert.deepEqual(tabPresentationFor(presentations, 202), {
    alias: "Claude", color: "green", group: "テスト"
  });
  assert.equal(Object.keys(presentations).length, 2);
});

test("presentation text stays plain and bounded instead of becoming markup or CSS", () => {
  const value = withTabPresentation({}, 7, {
    alias: "<img src=x onerror=alert(1)>",
    color: "red; background:url(javascript:alert(1))",
    group: "<script>alert(1)</script>"
  });
  assert.equal(tabPresentationFor(value, 7).alias, "<img src=x onerror=alert(1)>");
  assert.equal(tabPresentationFor(value, 7).group, "<script>alert(1)</script>");
  assert.equal(tabPresentationFor(value, 7).color, "default");
});

test("alias labels preserve tab id, conversation and run-status authority labels", () => {
  const base = "タブ #104 · 会話 abcdef12… · 実行 2/5";
  assert.equal(formatTabAliasLabel(base, "AI Guardian"), `AI Guardian · ${base}`);
  assert.equal(formatTabAliasLabel(base, ""), base);
});

test("twenty tab aliases remain distinct while every authoritative tab id stays visible", () => {
  let aliases = {};
  const labels = [];
  for (let index = 1; index <= 20; index += 1) {
    const tabId = 1_000 + index;
    aliases = withTabAlias(aliases, tabId, `作業 ${index}`);
    const base = `タブ #${tabId} · 会話 ${String(index).padStart(8, "0")}… · 実行 ${index % 5}/5`;
    const label = formatTabAliasLabel(base, tabAliasFor(aliases, tabId));
    assert.match(label, new RegExp(`タブ #${tabId}\\b`));
    labels.push(label);
  }
  assert.equal(Object.keys(aliases).length, 20);
  assert.equal(new Set(labels).size, 20);
});

test("Side Panel exposes bounded display-only presentation controls", () => {
  assert.match(html, /id="targetAlias"[^>]*maxlength="40"/);
  assert.match(html, /id="targetGroup"[^>]*maxlength="40"/);
  assert.match(html, /id="targetColor"/);
  assert.match(html, /id="targetPresentationSummary"/);
  assert.match(html, /id="targetAliasHint"/);
  assert.match(html, /src="tab-alias-ui\.js"/);
  assert.match(html, /表示情報はタブを見分けるためだけに使い、送信先や実行可否の判定には使いません/);
  assert.match(ui, /表示情報はタブを見分けるためだけに使い、送信先や実行可否の判定には使いません/);
  assert.doesNotMatch(ui, /Run権限|現在のRun/);
});

test("presentation UI reuses browser-session storage and never enters runtime authority", () => {
  assert.match(ui, /chrome\.storage\.session\.get\(TAB_PRESENTATION_STORAGE_KEY\)/);
  assert.match(ui, /chrome\.storage\.session\.set\(/);
  assert.doesNotMatch(ui, /chrome\.storage\.local/);
  assert.doesNotMatch(ui, /chrome\.runtime\.sendMessage|AIPM_START|AIPM_RELAY_TO_CHATGPT/);
  assert.doesNotMatch(ui, /setInterval|setTimeout|executeScript/);
  assert.match(ui, /option\.dataset\.aipmBaseLabel/);
  assert.match(ui, /targetPresentationName\.textContent/);
  assert.match(ui, /targetPresentationGroup\.textContent/);
});

test("presentation edits stay bound to the tab active when editing began", () => {
  assert.match(ui, /editingTabId = selectedTabId\(\)/);
  assert.match(ui, /const tabId = Number\.isInteger\(editingTabId\) \? editingTabId : selectedTabId\(\)/);
  assert.match(ui, /document\.activeElement === control && editingControl === control/);
  assert.match(ui, /let saveQueue = Promise\.resolve\(\)/);
  assert.match(ui, /saveQueue\.catch\(\(\) => \{\}\)\.then/);
});

test("presentation storage failure remains a bounded display-only error", () => {
  assert.match(ui, /表示情報を保存できませんでした。送信先や実行可否の判定には影響しません。/);
  assert.match(ui, /一時的な表示情報を保存できません。送信先や実行可否の判定には影響しません。/);
  assert.match(ui, /表示情報を読み込めませんでした。送信先や実行可否の判定には影響しません。/);
  assert.doesNotMatch(ui, /error\.message|String\(error\)|throw error/);
});

test("syntax check covers both alias modules", () => {
  assert.match(packageJson, /node --check src\/tab-alias\.js/);
  assert.match(packageJson, /node --check src\/tab-alias-ui\.js/);
});
