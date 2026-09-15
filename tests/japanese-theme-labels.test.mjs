/*
  Japanese theme label gate.

  Theme display names are presentation text for Japanese users. The canonical
  id is the only value that is stored, matched by CSS, migrated from a legacy
  value or read by the appearance runtime, so localizing a label may change
  what the Settings list says and nothing else. These assertions pin that
  boundary: exact labels, unchanged identifiers and axes, unchanged resolution
  functions, and no path from a label into a stored preference or a Run.
*/

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  THEME_OPTIONS,
  loadSettings,
  normalizeSettings,
  saveSettings
} from "../src/settings-store.js";
import {
  DEFAULT_THEME_ID,
  LEGACY_THEME_ALIASES,
  THEMES,
  THEME_GROUPS,
  THEME_IDS,
  effectiveAccent,
  normalizeThemeId,
  resolveThemeMode,
  themeAllowsAccent,
  themeById,
  themesByGroup
} from "../src/themes/registry.js";
import { applyAppearance } from "../src/theme.js";

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/* Catalogue order. Every field except displayName is the pre-localization value. */
const EXPECTED_THEMES = Object.freeze([
  // id, displayName, group, origin, stance, accentPolicy, decoration
  ["default", "標準", "standard", "production", "both", "customizable", null],
  ["clean-premium", "上質なシンプル", "standard", "ui-lab:clean", "both", "customizable", null],
  ["chatgpt-native", "ニュートラル", "product", "ui-lab:chatgpt-native", "both", "customizable", null],
  ["google-native", "すっきり実用", "product", "ui-lab:google-native", "both", "customizable", null],
  ["claude-native", "温かみのある紙面", "product", "production:claude-current", "both", "customizable", null],
  ["microsoft-fluent", "やわらかなガラス", "product", "ui-lab:fluent", "both", "customizable", null],
  ["apple-utility", "ミニマル", "product", "ui-lab:apple-utility", "both", "customizable", null],
  ["linear-saas", "ダーク業務UI", "product", "ui-lab:linear-saas", "dark", "customizable", null],
  ["terminal", "ターミナル", "operator", "ui-lab:terminal", "dark", "fixed", null],
  ["modern-terminal", "モダンターミナル", "operator", "ui-lab:modern-terminal", "dark", "fixed", null],
  ["mission-control", "管制室", "operator", "ui-lab:mission-control", "dark", "fixed", null],
  ["operator-dense", "高密度コンソール", "operator", "ui-lab:operator-dense", "dark", "customizable", null],
  ["industrial-control", "産業機器", "operator", "ui-lab:industrial", "light", "fixed", null],
  ["mecha", "メカ", "operator", "ui-lab:mecha", "dark", "fixed", null],
  ["neo-tech", "近未来", "operator", "ui-lab:neo", "dark", "fixed", null],
  ["swiss-information", "スイス式情報整理", "editorial", "ui-lab:swiss", "light", "fixed", null],
  ["technical-manual", "技術マニュアル", "editorial", "ui-lab:technical-manual", "light", "customizable", null],
  ["brutalist-utility", "無骨な実用", "editorial", "ui-lab:brutalist", "light", "fixed", null],
  ["monochrome-engineering", "モノクロ設計", "editorial", "ui-lab:mono-eng", "light", "fixed", null],
  ["scientific-instrument", "科学計測器", "editorial", "ui-lab:instrument", "light", "customizable", null],
  ["calm-productivity", "落ち着いた作業環境", "editorial", "ui-lab:calm", "light", "customizable", null],
  ["japanese-systems", "日本語業務システム", "editorial", "ui-lab:jp-systems", "light", "customizable", null],
  ["eva-command", "コマンド / 司令室", "eva", "ui-lab:eva", "both", "fixed", "hex-field"],
  ["eva-restrained", "コマンド / 控えめ", "eva", "production:eva", "both", "customizable", null]
].map(([id, displayName, group, origin, stance, accentPolicy, decoration]) =>
  Object.freeze({ id, displayName, group, origin, stance, accentPolicy, decoration })));

/* The English labels shipped before localization. None may remain a visible label. */
const RETIRED_ENGLISH_LABELS = Object.freeze([
  "Clean Premium", "Neutral Workspace", "Clean Utility", "Warm Editorial", "Soft Glass",
  "Minimal Utility", "Dark SaaS", "Terminal", "Modern Terminal", "Mission Control",
  "Data Dense Operator", "Industrial Control", "Mecha", "Neo Tech", "Swiss Information",
  "Technical Manual", "Brutalist Utility", "Monochrome Engineering", "Scientific Instrument",
  "Calm Productivity", "Japanese Systems UI", "EVA / Command", "EVA / Restrained"
]);

const EXPECTED_GROUPS = Object.freeze([
  { id: "standard", label: "標準" },
  { id: "product", label: "UIスタイル" },
  { id: "operator", label: "オペレーター / 技術" },
  { id: "editorial", label: "エディトリアル / 実用" },
  { id: "eva", label: "コマンド" }
]);

const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const SETTINGS_KEY = "aipm.settings.v1";

function memoryStorageArea() {
  const data = {};
  return {
    async get(key) {
      if (key == null) return structuredClone(data);
      return Object.hasOwn(data, key) ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(patch) {
      Object.assign(data, structuredClone(patch));
    },
    snapshot: () => structuredClone(data)
  };
}

test("the catalogue keeps exactly its 24 canonical ids, in order", () => {
  assert.equal(THEMES.length, 24);
  assert.deepEqual([...THEME_IDS], EXPECTED_THEMES.map((entry) => entry.id));
  assert.equal(new Set(THEME_IDS).size, 24);
  assert.deepEqual([...THEME_OPTIONS], [...THEME_IDS], "Settings offers ids, never labels");
  assert.equal(DEFAULT_THEME_ID, "default");
});

test("every theme shows its exact Japanese label and only the label changed", () => {
  assert.deepEqual(THEMES.map((entry) => ({ ...entry })), EXPECTED_THEMES.map((entry) => ({ ...entry })));
  for (const expected of EXPECTED_THEMES) {
    assert.deepEqual({ ...themeById(expected.id) }, { ...expected }, `${expected.id} entry`);
  }
});

test("labels are unique, Japanese and free of the retired English names", () => {
  const labels = THEMES.map((entry) => entry.displayName);
  assert.equal(new Set(labels).size, 24, "duplicate display name");
  for (const label of labels) {
    assert.equal(label, label.trim(), `${label} must not carry padding`);
    assert.match(label, JAPANESE, `${label} must be a Japanese label`);
  }
  const registryCode = stripComments(read("../src/themes/registry.js"));
  for (const retired of RETIRED_ENGLISH_LABELS) {
    assert.equal(labels.includes(retired), false, `${retired} must not remain a visible label`);
    assert.equal(registryCode.includes(`"${retired}"`), false, `${retired} must not remain in registry data`);
  }
});

test("group ids, order and labels are unchanged, and groups still partition the catalogue", () => {
  assert.deepEqual(THEME_GROUPS.map(({ id, label }) => ({ id, label })), EXPECTED_GROUPS);
  const grouped = themesByGroup();
  assert.deepEqual(grouped.map((group) => group.id), EXPECTED_GROUPS.map((group) => group.id));
  for (const group of grouped) {
    assert.deepEqual(
      group.themes.map((entry) => entry.id),
      EXPECTED_THEMES.filter((entry) => entry.group === group.id).map((entry) => entry.id),
      `${group.id} membership`
    );
  }
});

test("a label is never an identifier: values still resolve by id and the legacy eva alias", () => {
  assert.deepEqual({ ...LEGACY_THEME_ALIASES }, { eva: "eva-restrained" });
  assert.equal(normalizeThemeId("eva"), "eva-restrained");
  assert.notEqual(normalizeThemeId("eva"), "eva-command");
  assert.equal(normalizeSettings({ appearance: { theme: "eva" } }).appearance.theme, "eva-restrained");

  for (const entry of EXPECTED_THEMES) {
    assert.equal(normalizeThemeId(entry.id), entry.id, `${entry.id} must stay a valid id`);
  }
  for (const label of [...EXPECTED_THEMES.map((entry) => entry.displayName), ...RETIRED_ENGLISH_LABELS]) {
    assert.equal(normalizeThemeId(label), DEFAULT_THEME_ID, `${label} must not resolve as a theme id`);
    assert.equal(normalizeSettings({ appearance: { theme: label } }).appearance.theme, DEFAULT_THEME_ID);
    const root = { dataset: {} };
    applyAppearance(root, { theme: label });
    assert.equal(root.dataset.aipmTheme, DEFAULT_THEME_ID, `${label} must not paint a theme`);
  }
});

test("mode resolution and accent policy are unchanged for every theme", () => {
  for (const entry of EXPECTED_THEMES) {
    for (const requested of ["system", "light", "dark", undefined, "sepia"]) {
      for (const prefersDark of [true, false]) {
        const expected = entry.stance !== "both"
          ? entry.stance
          : requested === "light" || requested === "dark" ? requested : prefersDark ? "dark" : "light";
        assert.equal(
          resolveThemeMode(entry.id, requested, prefersDark),
          expected,
          `${entry.id} requested=${String(requested)} prefersDark=${prefersDark}`
        );
      }
    }
    const customizable = entry.accentPolicy === "customizable";
    assert.equal(themeAllowsAccent(entry.id), customizable, `${entry.id} accent policy`);
    assert.equal(effectiveAccent(entry.id, "violet"), customizable ? "violet" : "theme", `${entry.id} accent`);
  }
});

test("Settings renders labels as text and keeps the canonical id as the option value", () => {
  const optionsJs = read("../src/options.js");
  const start = optionsJs.indexOf("function buildThemeOptions() {");
  const end = optionsJs.indexOf("const STANCE_NOTE", start);
  assert.ok(start >= 0 && end > start, "buildThemeOptions body must be locatable");
  const body = optionsJs.slice(start, end);
  assert.match(body, /optgroup\.label = group\.label;/);
  assert.match(body, /option\.value = entry\.id;/);
  assert.match(body, /option\.textContent = entry\.displayName;/);
  assert.doesNotMatch(body, /innerHTML|insertAdjacentHTML|outerHTML/);
});

test("labels stay out of stylesheets and only the Settings renderer consumes them", () => {
  const css = [
    "../src/ui-tokens.css", "../src/themes/themes.css", "../src/themes/fidelity.css",
    "../src/themes/manual-ux.css", "../src/themes/eva-restrained.css",
    "../src/sidepanel.css", "../src/workspace.css", "../src/options.css"
  ].map((file) => stripCssComments(read(file))).join("\n");
  for (const entry of EXPECTED_THEMES) {
    if (entry.id !== DEFAULT_THEME_ID) {
      assert.ok(css.includes(`:root[data-aipm-theme="${entry.id}"]`), `${entry.id} CSS stays keyed by id`);
    }
    assert.equal(css.includes(entry.displayName), false, `${entry.displayName} must not reach CSS`);
  }

  const consumers = fs.readdirSync(new URL("../src/", import.meta.url), { recursive: true })
    .map((file) => String(file).replaceAll("\\", "/"))
    .filter((file) => file.endsWith(".js"))
    .filter((file) => stripComments(read(`../src/${file}`)).includes("displayName"))
    .sort();
  assert.deepEqual(consumers, ["options.js", "themes/registry.js"]);
});

test("the localized registry stays pure data with no runtime or Run surface", () => {
  const registryCode = stripComments(read("../src/themes/registry.js"));
  assert.doesNotMatch(registryCode, /^\s*import\s/m, "registry.js must import nothing");
  for (const name of [
    "chrome.", "sendMessage", "AIPM_", "activeRun", "runId", "outbox", "lease",
    "conversationKey", "selectedTabId", "executionSession", "storage", "document", "window"
  ]) {
    assert.equal(registryCode.includes(name), false, `registry.js must not reference ${name}`);
  }
});

test("choosing any theme stores only its id and leaves execution defaults byte-identical", async () => {
  const area = memoryStorageArea();
  await saveSettings(
    { defaults: { keepAwake: true, delaySeconds: 42, maxSends: 7, recoveryMode: "completion" } },
    area
  );
  const before = (await loadSettings(area)).settings;
  for (const entry of EXPECTED_THEMES) {
    await saveSettings({ appearance: { theme: entry.id } }, area);
    const stored = area.snapshot()[SETTINGS_KEY];
    assert.equal(stored.appearance.theme, entry.id, `${entry.id} is stored by canonical id`);
    assert.equal(JSON.stringify(stored).includes(entry.displayName), false, `${entry.displayName} is never persisted`);
  }
  const after = (await loadSettings(area)).settings;
  assert.deepEqual(after.defaults, before.defaults, "Run defaults must be untouched by appearance");
  assert.deepEqual(after.display, before.display, "display settings must be untouched by appearance");
  assert.deepEqual(Object.keys(area.snapshot()), [SETTINGS_KEY], "no key besides settings is written");
});
