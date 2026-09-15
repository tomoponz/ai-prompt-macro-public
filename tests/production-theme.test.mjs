/*
  Theme catalogue gate.

  The catalogue changed how the three surfaces LOOK and nothing else. These
  tests fix that claim in place: the catalogue is complete and bounded, every
  theme is real, appearance is shared, and nothing here can reach a decision
  that governs a Run.

  Two assertions are load-bearing:

    1. `--aipm-status-*` (meaning) is separated from `--aipm-accent*` (taste).
       If an accent rule could write a status token, changing the accent would
       silently change what "safety stop" looks like.

    2. A stored legacy `"eva"` migrates to `eva-restrained`, never to
       `eva-command`. They are different designs that briefly shared a name;
       resolving the wrong way would change an existing user's panel.
*/

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  ACCENT_OPTIONS,
  DENSITY_OPTIONS,
  DEFAULT_SETTINGS,
  MODE_OPTIONS,
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
import { applyAppearance, startAppearanceSync } from "../src/theme.js";
import { syncThemeDecoration } from "../src/themes/decoration.js";
import { projectRunState } from "../src/run-ux.js";

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");

const tokensCss = read("../src/ui-tokens.css");
const themesCss = read("../src/themes/themes.css");
const sidepanelCss = read("../src/sidepanel.css");
const workspaceCss = read("../src/workspace.css");
const optionsCss = read("../src/options.css");
const sidepanelHtml = read("../src/sidepanel.html");
const workspaceHtml = read("../src/workspace.html");
const optionsHtml = read("../src/options.html");
const themeJs = read("../src/theme.js");
const registryJs = read("../src/themes/registry.js");
const optionsJs = read("../src/options.js");
const workspaceJs = read("../src/workspace.js");
const sidepanelJs = read("../src/sidepanel.js");
const manifest = JSON.parse(read("../manifest.json"));

const ALL_CSS = { tokensCss, themesCss, sidepanelCss, workspaceCss, optionsCss };
const SURFACE_CSS = { sidepanelCss, workspaceCss, optionsCss };

const EXPECTED_THEME_COUNT = 24;

const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const stripHtmlComments = (html) => html.replace(/<!--[\s\S]*?-->/g, "");
const themeCode = stripComments(themeJs);
const registryCode = stripComments(registryJs);

const STATUS_TOKENS = [
  "--aipm-status-running",
  "--aipm-status-paused",
  "--aipm-status-warning",
  "--aipm-status-stop",
  "--aipm-status-done"
];

function declarationBlocks(css) {
  const blocks = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = pattern.exec(stripCssComments(css))) !== null) {
    blocks.push({ selector: match[1].trim().replace(/\s+/g, " "), body: match[2] });
  }
  return blocks;
}

function disabledRules(css) {
  return declarationBlocks(css)
    .filter((block) => block.selector.replace(/:not\(:disabled\)/g, "").includes(":disabled"));
}

function displayValue(body) {
  const match = /display:\s*([a-z-]+)/.exec(body);
  return match ? match[1] : null;
}

function hexChannels(value) {
  const hex = /#([0-9a-f]{6})\b/i.exec(value);
  if (!hex) return null;
  const n = Number.parseInt(hex[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/* The token block a theme actually declares, merged base-then-mode. */
function themeTokens(id, mode = null) {
  const wanted = mode
    ? `:root[data-aipm-theme="${id}"][data-aipm-mode="${mode}"]`
    : `:root[data-aipm-theme="${id}"]`;
  const block = declarationBlocks(themesCss).find((b) => b.selector === wanted);
  if (!block) return null;
  return Object.fromEntries([...block.body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)]
    .map((m) => [m[1], m[2].trim()]));
}

const fakeRoot = () => ({ dataset: {} });

function memoryStorageArea(seed = {}) {
  const data = { ...seed };
  const reads = [];
  const writes = [];
  return {
    reads,
    writes,
    async get(key) {
      reads.push(key);
      if (key == null) return { ...data };
      return Object.hasOwn(data, key) ? { [key]: data[key] } : {};
    },
    async set(patch) {
      writes.push(patch);
      Object.assign(data, patch);
    },
    snapshot: () => ({ ...data })
  };
}

/* ========================================================= 1. catalogue ==
   Exactly 24 real themes — no placeholders, no duplicates, no orphans.
   ======================================================================= */

test("catalogue holds exactly 24 canonical themes", () => {
  assert.equal(THEMES.length, EXPECTED_THEME_COUNT);
  assert.equal(THEME_IDS.length, EXPECTED_THEME_COUNT);
  assert.equal(THEME_OPTIONS.length, EXPECTED_THEME_COUNT, "settings must offer the whole catalogue");
});

test("every theme id is unique and every display name is real", () => {
  assert.equal(new Set(THEME_IDS).size, EXPECTED_THEME_COUNT, "duplicate theme id");
  for (const entry of THEMES) {
    assert.match(entry.id, /^[a-z][a-z0-9-]*$/, `bad id: ${entry.id}`);
    assert.equal(typeof entry.displayName, "string");
    assert.ok(entry.displayName.trim().length > 0, `${entry.id} needs a display name`);
    assert.ok(["both", "light", "dark"].includes(entry.stance), `${entry.id} stance`);
    assert.ok(["customizable", "fixed"].includes(entry.accentPolicy), `${entry.id} accentPolicy`);
    assert.ok(THEME_GROUPS.some((g) => g.id === entry.group), `${entry.id} group`);
  }
  assert.equal(new Set(THEMES.map((t) => t.displayName)).size, EXPECTED_THEME_COUNT, "duplicate display name");
});

test("every catalogue theme has real CSS, and no CSS is orphaned", () => {
  /* `default` is the system-colour theme and lives in ui-tokens.css. */
  const declared = new Set([...themesCss.matchAll(/:root\[data-aipm-theme="([a-z0-9-]+)"\]/g)]
    .map((m) => m[1]));

  for (const id of THEME_IDS) {
    if (id === DEFAULT_THEME_ID) continue;
    assert.ok(declared.has(id), `${id} is in the registry but has no CSS block`);
  }
  for (const id of declared) {
    assert.ok(THEME_IDS.includes(id), `${id} has CSS but is not in the registry (orphan)`);
  }
  assert.equal(declared.size, EXPECTED_THEME_COUNT - 1);
});

test("no theme is a placeholder: each declares a full palette and its own geometry", () => {
  const required = ["--aipm-bg", "--aipm-surface", "--aipm-text", "--aipm-muted",
    "--aipm-border", "--aipm-accent", ...STATUS_TOKENS];
  for (const id of THEME_IDS) {
    if (id === DEFAULT_THEME_ID) continue;
    const tokens = themeTokens(id);
    assert.ok(tokens, `${id} has no base block`);
    for (const token of required) {
      assert.ok(tokens[token], `${id} must define ${token}`);
    }
  }
});

test("every group is populated and the groups partition the catalogue", () => {
  const grouped = themesByGroup();
  const total = grouped.reduce((sum, g) => sum + g.themes.length, 0);
  assert.equal(total, EXPECTED_THEME_COUNT, "groups must cover every theme exactly once");
  for (const group of grouped) {
    assert.ok(group.themes.length > 0, `${group.id} must not be empty`);
    assert.ok(group.label.trim().length > 0);
  }
});

/* ========================================================= 2. migration ==
   A stored value must never be silently reinterpreted as a different design.
   ======================================================================= */

test("legacy \"eva\" migrates to the restrained design it has always meant", () => {
  assert.equal(LEGACY_THEME_ALIASES.eva, "eva-restrained");
  assert.equal(normalizeThemeId("eva"), "eva-restrained");
  assert.equal(normalizeSettings({ appearance: { theme: "eva" } }).appearance.theme, "eva-restrained");
  /* The faithful UI Lab port is a DIFFERENT design and must not inherit "eva". */
  assert.notEqual(normalizeThemeId("eva"), "eva-command");
  assert.ok(THEME_IDS.includes("eva-command"));
  assert.ok(THEME_IDS.includes("eva-restrained"));
});

test("\"default\" stays valid and every unknown value fails safely to it", () => {
  assert.equal(normalizeThemeId("default"), "default");
  assert.equal(DEFAULT_SETTINGS.appearance.theme, "default");
  for (const hostile of ["eva-dark", "nerv-magi", "", null, undefined, 42, {}, [],
    'x"] { display: none } :root[y="']) {
    assert.equal(normalizeThemeId(hostile), "default", `${JSON.stringify(hostile)} must fall back`);
    const root = fakeRoot();
    applyAppearance(root, { theme: hostile });
    assert.ok(THEME_IDS.includes(root.dataset.aipmTheme));
  }
});

test("migration is deterministic and touches nothing but the theme field", () => {
  const before = normalizeSettings({
    appearance: { theme: "eva", mode: "dark", accent: "violet", density: "compact" },
    defaults: { keepAwake: true, delaySeconds: 42, maxSends: 7, recoveryMode: "completion" },
    display: { diagnosticsLevel: "detailed" }
  });
  const again = normalizeSettings({
    appearance: { theme: "eva", mode: "dark", accent: "violet", density: "compact" },
    defaults: { keepAwake: true, delaySeconds: 42, maxSends: 7, recoveryMode: "completion" },
    display: { diagnosticsLevel: "detailed" }
  });
  assert.deepEqual(before, again, "migration must be deterministic");
  assert.equal(before.appearance.theme, "eva-restrained");
  assert.deepEqual(before.defaults, {
    keepAwake: true, delaySeconds: 42, maxSends: 7, recoveryMode: "completion"
  });
  assert.deepEqual(before.display, { diagnosticsLevel: "detailed" });
  /* Idempotent: migrating an already-migrated value is a no-op. */
  assert.equal(normalizeThemeId(before.appearance.theme), "eva-restrained");
});

/* ============================================================= 3. stance ==
   A single-stance design is pinned, never given a fabricated palette.
   ======================================================================= */

test("stance is honoured: single-stance themes pin, both-stance themes follow", () => {
  for (const entry of THEMES) {
    if (entry.stance === "both") continue;
    for (const requested of ["system", "light", "dark"]) {
      for (const prefersDark of [true, false]) {
        assert.equal(
          resolveThemeMode(entry.id, requested, prefersDark),
          entry.stance,
          `${entry.id} must pin to ${entry.stance}`
        );
      }
    }
  }
  for (const id of THEMES.filter((t) => t.stance === "both").map((t) => t.id)) {
    assert.equal(resolveThemeMode(id, "light", true), "light");
    assert.equal(resolveThemeMode(id, "dark", false), "dark");
    assert.equal(resolveThemeMode(id, "system", true), "dark");
    assert.equal(resolveThemeMode(id, "system", false), "light");
  }
});

test("both-stance themes actually ship the dark palette they promise", () => {
  for (const entry of THEMES.filter((t) => t.stance === "both")) {
    if (entry.id === DEFAULT_THEME_ID) continue;
    const dark = themeTokens(entry.id, "dark") ?? themeTokens(entry.id, "light");
    assert.ok(dark, `${entry.id} claims both stances but ships one block only`);
  }
  /* And a light-only theme must not be given a dark block it was never designed for. */
  for (const entry of THEMES.filter((t) => t.stance === "light")) {
    assert.equal(themeTokens(entry.id, "dark"), null, `${entry.id} is light-only`);
  }
});

test("Settings tells the truth about a pinned mode and a fixed accent", () => {
  assert.match(optionsJs, /STANCE_NOTE/);
  assert.match(optionsJs, /el\.mode\.disabled = entry\.stance !== "both"/);
  assert.ok(optionsJs.includes("このテーマはライト表示専用です"));
  assert.ok(optionsJs.includes("このテーマはダーク表示専用です"));
  assert.ok(optionsJs.includes("ここでの選択は保存されますが、このテーマの表示には適用しません"));
});

/* ============================================================= 4. accent ==
   Taste may not overwrite identity, and may never touch meaning.
   ======================================================================= */

test("a fixed-accent theme keeps its own accent without losing the stored choice", () => {
  const fixed = THEMES.filter((t) => t.accentPolicy === "fixed");
  assert.ok(fixed.length > 0, "some designs must own their accent");
  for (const entry of fixed) {
    assert.equal(themeAllowsAccent(entry.id), false);
    assert.equal(effectiveAccent(entry.id, "violet"), "theme", `${entry.id} must ignore the accent`);
    const root = fakeRoot();
    applyAppearance(root, { theme: entry.id, accent: "violet" });
    assert.equal(root.dataset.aipmAccent, "theme");
  }
  /* The preference itself survives: it is not rewritten, only unapplied. */
  const stored = normalizeSettings({ appearance: { theme: "swiss-information", accent: "violet" } });
  assert.equal(stored.appearance.accent, "violet", "the stored preference must be preserved");
  /* And it returns as soon as a customizable theme is chosen. */
  const back = fakeRoot();
  applyAppearance(back, { theme: "clean-premium", accent: "violet" });
  assert.equal(back.dataset.aipmAccent, "violet");
});

test("no accent rule may write a status token", () => {
  const start = tokensCss.indexOf("================================================================ accent ==");
  const end = tokensCss.indexOf("=============================================================== density ==");
  assert.ok(start > 0 && end > start, "accent section must be delimited");
  const accentSection = tokensCss.slice(start, end);
  assert.ok(accentSection.includes("--aipm-accent:"), "sanity: the accent section sets accents");
  for (const token of STATUS_TOKENS) {
    assert.equal(accentSection.includes(token), false,
      `accent rules must never set ${token}; status meaning would follow taste`);
  }
});

/* ====================================================== 5. status meaning ==
   Identical in all 24 themes, and never carried by colour alone.
   ======================================================================= */

test("the meaning-to-hue mapping holds in every theme that ships hex statuses", () => {
  let checked = 0;
  for (const id of THEME_IDS) {
    if (id === DEFAULT_THEME_ID) continue;
    for (const mode of [null, "dark", "light"]) {
      const tokens = themeTokens(id, mode);
      if (!tokens || !tokens["--aipm-status-running"]) continue;
      const value = (t) => hexChannels(tokens[t]);
      const running = value("--aipm-status-running");
      const stop = value("--aipm-status-stop");
      const warning = value("--aipm-status-warning");
      if (!running || !stop || !warning) continue;
      checked += 1;
      const where = `${id}${mode ? `/${mode}` : ""}`;
      /* Universal in every theme, including the monochrome ones: stop is the
         one state that always keeps colour, and it can never be confused with
         running. UI Lab records the same rule in themes/README.md. */
      assert.ok(stop.r > stop.g && stop.r > stop.b, `${where}: stop must stay red-dominant`);
      assert.notDeepEqual(running, stop, `${where}: running and stop must not collapse`);

      /* Swiss Information and Monochrome Engineering deliberately encode most
         states with border treatment and keep only `stopped` in colour, so an
         achromatic warning is a design decision rather than a defect. Where a
         theme DOES use hue for warning, that hue must still read as amber. */
      const chroma = (c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
      if (chroma(warning) > 24) {
        assert.ok(warning.r >= warning.g && warning.g > warning.b, `${where}: warning must stay amber`);
      } else {
        assert.ok(chroma(stop) > 24, `${where}: a monochrome theme must still keep stop in colour`);
      }
    }
  }
  assert.ok(checked >= 20, `expected the whole catalogue to be checked, saw ${checked}`);
});

test("status labels come from Run facts, never from a stylesheet", () => {
  assert.equal(projectRunState(null).label, "待機中");
  assert.equal(projectRunState({ status: "running" }).label, "実行中");
  assert.equal(projectRunState({ status: "completed" }).label, "完了");
  assert.equal(projectRunState({ status: "stopped" }).label, "停止済み");
  assert.equal(projectRunState({ status: "paused", pauseReason: "user-pause" }).label, "一時停止中");
  assert.equal(projectRunState({ status: "paused", pauseReason: "manual-checkpoint" }).label, "確認が必要");
  assert.equal(projectRunState({ status: "paused", resumable: false }).label, "安全のため停止");
  assert.equal(projectRunState({ status: "wat" }).label, "状態不明");
  const css = `${sidepanelCss}\n${workspaceCss}\n${themesCss}`;
  for (const label of ["待機中", "実行中", "一時停止中", "確認が必要", "安全のため停止", "完了", "停止済み", "状態不明"]) {
    assert.equal(css.includes(label), false, `stylesheets must not author the status label ${label}`);
  }
});

test("no status is expressed by colour alone", () => {
  assert.match(sidepanelHtml, /id="statusBadge"[^>]*>待機中</);
  assert.match(sidepanelJs, /el\.statusBadge\.textContent/);
  assert.match(workspaceJs, /badge\.textContent = row\.visibilityStatusLabel/);
  assert.match(sidepanelCss, /\.completion-outcome\[data-outcome="fail-closed"\] \{ border-left-color/);
  assert.match(workspaceCss, /\.status-badge\[data-safety="unknown"\] \{ border-style: dashed;/);
});

/* ========================================================= 6. isolation ==
   No theme may affect another, the base tokens, or anything structural.
   ======================================================================= */

test("every rule in the catalogue stylesheet is scoped to exactly one theme", () => {
  const blocks = declarationBlocks(themesCss);
  assert.ok(blocks.length >= EXPECTED_THEME_COUNT - 1);
  for (const block of blocks) {
    /* One deliberate exception: the ornament's hard default-off. It is
       unscoped precisely so that no theme can ever show it by accident, and it
       only ever sets display:none. */
    if (block.selector.trim() === ".aipm-theme-decoration") {
      assert.match(block.body, /^\s*display:\s*none;\s*$/,
        "the unscoped ornament rule may only turn it off");
      continue;
    }
    const ids = [...block.selector.matchAll(/\[data-aipm-theme="([a-z0-9-]+)"\]/g)].map((m) => m[1]);
    assert.equal(ids.length >= 1, true, `unscoped rule: ${block.selector}`);
    assert.equal(new Set(ids).size, 1, `rule spans two themes: ${block.selector}`);
    assert.ok(THEME_IDS.includes(ids[0]), `unknown theme in selector: ${block.selector}`);
  }
});

test("theme CSS never touches authority attributes or hidden-element visibility", () => {
  for (const forbidden of ["data-state", "data-connection", "data-safety", "aria-busy",
    "data-outcome", "data-severity"]) {
    assert.equal(
      new RegExp(`\\[${forbidden}`).test(stripCssComments(themesCss)),
      false,
      `theme CSS must not target ${forbidden}`
    );
  }
  const revealing = declarationBlocks(themesCss)
    .filter((b) => b.selector.includes("[hidden]") || b.selector.includes("[inert]"));
  assert.deepEqual(revealing, [], "theme CSS must not address hidden or inert content at all");
});

test("no stylesheet can reveal a hidden element", () => {
  for (const [name, css] of Object.entries(SURFACE_CSS)) {
    assert.match(css, /\[hidden\] \{ display: none !important; \}/, `${name} must pin [hidden]`);
  }
  for (const [name, css] of Object.entries(ALL_CSS)) {
    const revealing = declarationBlocks(css)
      .filter((block) => block.selector.includes("[hidden]"))
      .filter((block) => {
        const display = displayValue(block.body);
        return display !== null && display !== "none";
      });
    assert.deepEqual(revealing.map((b) => b.selector), [],
      `${name} must not give [hidden] a visible display`);
  }
});

test("the compatibility authoring block is still hidden and inert", () => {
  assert.match(sidepanelHtml, /<section id="authoringCompatibilityState" hidden inert aria-hidden="true">/);
});

/* ====================================================== 7. distinctness ==
   23 names must not resolve to a handful of designs.
   ======================================================================= */

function signature(id) {
  const t = themeTokens(id) ?? {};
  return JSON.stringify([
    t["--aipm-bg"], t["--aipm-surface"], t["--aipm-text"], t["--aipm-accent"],
    t["--aipm-radius"], t["--aipm-border-width"], t["--aipm-badge-radius"],
    t["--aipm-progress-height"], t["--aipm-font-sans"], t["--aipm-label-transform"]
  ]);
}

test("known distinct pairs never resolve to the same design", () => {
  const pairs = [
    ["chatgpt-native", "google-native"],
    ["terminal", "modern-terminal"],
    ["eva-command", "eva-restrained"],
    ["swiss-information", "brutalist-utility"],
    ["mecha", "neo-tech"],
    ["clean-premium", "calm-productivity"],
    ["microsoft-fluent", "apple-utility"],
    ["operator-dense", "mission-control"],
    ["monochrome-engineering", "swiss-information"]
  ];
  for (const [a, b] of pairs) {
    assert.notEqual(signature(a), signature(b), `${a} and ${b} must stay visually distinct`);
  }
});

test("every ported theme has a distinct signature, so no name is a duplicate design", () => {
  const seen = new Map();
  for (const id of THEME_IDS) {
    if (id === DEFAULT_THEME_ID) continue;
    const sig = signature(id);
    assert.equal(seen.has(sig), false, `${id} is identical to ${seen.get(sig)}`);
    seen.set(sig, id);
  }
  assert.equal(seen.size, EXPECTED_THEME_COUNT - 1);
});

test("no theme leaves its accent unreadable against its own accent text", () => {
  /* Guards the class of bug where a palette extraction falls back to the text
     colour: an accent equal to the colour printed on top of it is invisible. */
  const luminance = (c) => {
    const lin = (v) => {
      const n = v / 255;
      return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  };
  const weak = [];
  for (const id of THEME_IDS) {
    if (id === DEFAULT_THEME_ID) continue;
    for (const mode of [null, "dark", "light"]) {
      const t = themeTokens(id, mode);
      if (!t?.["--aipm-accent"]) continue;
      const accent = hexChannels(t["--aipm-accent"]);
      const onAccent = hexChannels(t["--aipm-accent-text"] ?? "");
      if (!accent || !onAccent) continue;
      const a = luminance(accent);
      const b = luminance(onAccent);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (ratio < 4.5) {
        weak.push(`${id}${mode ? `/${mode}` : ""} = ${ratio.toFixed(2)}:1`);
      }
    }
  }
  assert.deepEqual(weak, [], `accent text below AA: ${weak.join(", ")}`);
});

test("a theme owns geometry and typography, not only colour", () => {
  const radii = new Set();
  const fonts = new Set();
  const widths = new Set();
  for (const id of THEME_IDS) {
    if (id === DEFAULT_THEME_ID) continue;
    const t = themeTokens(id) ?? {};
    radii.add(t["--aipm-radius"]);
    fonts.add(t["--aipm-font-sans"]);
    widths.add(t["--aipm-border-width"]);
  }
  assert.ok(radii.size >= 6, `themes must differ in radius, saw ${radii.size} values`);
  assert.ok(fonts.size >= 8, `themes must differ in type stack, saw ${fonts.size} values`);
  assert.ok(widths.size >= 3, `themes must differ in frame weight, saw ${widths.size} values`);

  /* And the surfaces must actually consume those tokens, or the geometry would
     be inert and every theme would collapse into a palette swap. */
  for (const [name, css] of Object.entries(SURFACE_CSS)) {
    assert.ok(css.includes("var(--aipm-border-width)"), `${name} must consume the frame weight`);
    assert.ok(css.includes("var(--aipm-button-radius)"), `${name} must consume the control radius`);
    assert.ok(css.includes("var(--aipm-label-transform)"), `${name} must consume the label voice`);
  }
});

/* ======================================================== 8. decoration ==
   The only ornament is CSS-only, so it cannot leak, focus, or persist.
   ======================================================================= */

test("the only decorated theme declares it, and the ornament is scoped to it", () => {
  const decorated = THEMES.filter((t) => t.decoration !== null);
  assert.deepEqual(decorated.map((t) => t.id), ["eva-command"]);

  /* Every ornament rule is scoped to the owning theme, so even a leaked node
     would render nothing under any other theme. */
  const ornament = declarationBlocks(themesCss)
    .filter((b) => b.selector.includes("aipm-hex-tile") || b.selector.includes("aipm-theme-decoration"));
  assert.ok(ornament.length >= 8, `expected the ported tile geometry, saw ${ornament.length} rules`);
  for (const rule of ornament) {
    const scoped = rule.selector.includes('[data-aipm-theme="eva-command"]');
    const isDefaultOff = rule.selector.trim() === ".aipm-theme-decoration"
      && /display:\s*none/.test(rule.body);
    assert.ok(scoped || isDefaultOff,
      `ornament rule must be theme-scoped or a hard default-off: ${rule.selector}`);
  }
  /* Hidden by default, so an ornament can never appear under another theme. */
  const off = ornament.find((r) => r.selector.trim() === ".aipm-theme-decoration");
  assert.ok(off && /display:\s*none/.test(off.body), "the ornament must default to display:none");

  const field = ornament.find((r) => r.selector.includes("aipm-theme-decoration")
    && r.body.includes("position: fixed"));
  assert.ok(field, "the ornament must be a fixed overlay");
  assert.match(field.body, /pointer-events: none;/, "the ornament must never take pointer input");
  assert.match(field.body, /overflow: hidden;/,
    "the ornament must be clipped so it cannot widen the document");
  assert.match(themesCss, /body > \*:not\(\.aipm-theme-decoration\) \{[^}]*z-index: 1;/s,
    "functional content must paint above the ornament");
});

test("the ornament module carries no data and cannot be focused", () => {
  const decorationJs = read("../src/themes/decoration.js");
  const code = stripComments(decorationJs);
  for (const name of ["sendMessage", "AIPM_", "activeRun", "chrome.", "runId", "outbox",
    "lease", "executionSession", "textContent", "innerHTML", "tabIndex", "addEventListener",
    "fetch(", "setTimeout", "setInterval"]) {
    assert.equal(code.includes(name), false, `decoration.js must not reference ${name}`);
  }
  /* Out of the accessibility tree and the tab order, with no focusable child. */
  assert.match(decorationJs, /setAttribute\("aria-hidden", "true"\)/);
  assert.match(decorationJs, /setAttribute\("inert", ""\)/);
  assert.equal(/createElement\("(a|button|input|select|textarea)"\)/.test(decorationJs), false,
    "the ornament must contain no focusable element");
  /* Only these two element kinds are created: an empty span and its plate. */
  const created = [...decorationJs.matchAll(/createElement\("([a-z]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(created)].sort(), ["div", "i", "span"]);
});

test("the ornament is single-rooted, theme-gated, and removed on switch", () => {
  /* A minimal document double: enough surface for the module, nothing more. */
  const makeDoc = () => {
    const children = [];
    const doc = {
      body: {
        children,
        prepend: (node) => children.unshift(node),
        querySelectorAll: (sel) => {
          assert.equal(sel, ".aipm-theme-decoration");
          return children.filter((c) => c.className === "aipm-theme-decoration");
        }
      },
      createElement: (tag) => {
        const node = {
          tag, className: "", attributes: {}, style: new Map(), childNodes: [],
          setAttribute(k, v) { this.attributes[k] = v; },
          append(child) { this.childNodes.push(child); child.parent = this; },
          remove() {
            const i = children.indexOf(this);
            if (i >= 0) children.splice(i, 1);
          }
        };
        node.style.setProperty = (k, v) => node.style.set(k, v);
        return node;
      }
    };
    return { doc, children };
  };

  const { doc, children } = makeDoc();
  const roots = () => children.filter((c) => c.className === "aipm-theme-decoration");

  /* Undecorated themes get nothing at all. */
  for (const id of THEME_IDS.filter((t) => t !== "eva-command")) {
    syncThemeDecoration(doc, id);
    assert.equal(roots().length, 0, `${id} must have no ornament`);
  }

  /* The decorated theme gets exactly one root, and repeat calls do not add. */
  syncThemeDecoration(doc, "eva-command");
  assert.equal(roots().length, 1);
  syncThemeDecoration(doc, "eva-command");
  syncThemeDecoration(doc, "eva-command");
  assert.equal(roots().length, 1, "repeat application must not duplicate the root");

  const field = roots()[0];
  assert.equal(field.attributes["aria-hidden"], "true");
  assert.equal(field.attributes.inert, "");
  assert.equal(field.childNodes.length, 13, "the ported UI Lab cluster is 13 tiles");
  for (const tile of field.childNodes) {
    assert.match(tile.className, /^aipm-hex-tile tone-(dim|red|violet|green)$/);
    assert.ok(tile.style.has("--hx") && tile.style.has("--hy"));
    assert.equal(tile.childNodes.length, 1, "each tile holds only its inner plate");
    assert.equal(tile.childNodes[0].tag, "i");
  }

  /* Switching away removes it; no stale ornament can survive. */
  syncThemeDecoration(doc, "swiss-information");
  assert.equal(roots().length, 0, "a theme switch must remove the ornament");

  /* Even a document that somehow acquired two roots converges to one. */
  syncThemeDecoration(doc, "eva-command");
  children.unshift({ className: "aipm-theme-decoration", remove() {
    const i = children.indexOf(this);
    if (i >= 0) children.splice(i, 1);
  } });
  assert.equal(roots().length, 2);
  syncThemeDecoration(doc, "eva-command");
  assert.equal(roots().length, 1, "a duplicate root must be collapsed, not tolerated");
});

/* ========================================================== 9. authority ==
   Appearance cannot reach a Run.
   ======================================================================= */

test("the registry and the theme module reach no runtime, Run or Send surface", () => {
  const forbidden = [
    "sendMessage", "AIPM_", "activeRun", "chrome.tabs", "chrome.scripting", "executeScript",
    "chatgpt.com", "outbox", "lease", "executionSession", "conversationKey", "runId",
    "setInterval", "setTimeout", "fetch("
  ];
  for (const name of forbidden) {
    assert.equal(themeCode.includes(name), false, `theme.js must not reference ${name}`);
    assert.equal(registryCode.includes(name), false, `registry.js must not reference ${name}`);
  }
  /* The registry is pure data plus pure functions: no I/O at all. */
  for (const name of ["chrome.", "document", "window", "localStorage", "storage"]) {
    assert.equal(registryCode.includes(name), false, `registry.js must not reference ${name}`);
  }
});

test("appearance sync reads the settings key, writes nothing, and ignores Run keys", async () => {
  const area = memoryStorageArea({
    "aipm.settings.v1": { appearance: { theme: "swiss-information", mode: "dark", accent: "violet" } },
    "aipm.activeRun.v2.tab.123": { runId: "must-not-be-read", status: "running" }
  });
  const changeListeners = [];
  const root = fakeRoot();
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    storage: { local: area, onChanged: { addListener: (fn) => changeListeners.push(fn) } }
  };
  try {
    await startAppearanceSync({ root, media: { matches: true }, storage: globalThis.chrome.storage });
  } finally {
    globalThis.chrome = previousChrome;
  }

  assert.deepEqual(root.dataset, {
    aipmTheme: "swiss-information",
    /* light-only stance pins the mode; fixed accent ignores the stored violet */
    aipmMode: "light",
    aipmAccent: "theme",
    aipmDensity: "comfortable"
  });
  assert.deepEqual(area.reads, ["aipm.settings.v1"], "only the settings key may be read");
  assert.deepEqual(area.writes, [], "appearance sync must never write");
  assert.equal(changeListeners.length, 1);
});

test("cycling every theme performs no storage write and never mutates Run state", async () => {
  const area = memoryStorageArea({ "aipm.settings.v1": { appearance: { theme: "default" } } });
  const changeListeners = [];
  const root = fakeRoot();
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    storage: { local: area, onChanged: { addListener: (fn) => changeListeners.push(fn) } }
  };
  try {
    await startAppearanceSync({ root, media: { matches: false }, storage: globalThis.chrome.storage });
    const readsAfterInit = area.reads.length;
    for (const id of THEME_IDS) {
      for (const listener of changeListeners) {
        listener({ "aipm.settings.v1": { newValue: { appearance: { theme: id } } } }, "local");
      }
      assert.equal(root.dataset.aipmTheme, id, `${id} must become the single active theme`);
      assert.ok(THEME_IDS.includes(root.dataset.aipmTheme));
    }
    assert.equal(area.reads.length, readsAfterInit, "a theme switch must not re-read storage");
    assert.deepEqual(area.writes, [], "a theme switch must not write storage");
    /* The Run record seeded alongside settings is untouched and unread. */
    assert.equal(area.snapshot()["aipm.activeRun.v2.tab.123"], undefined);
  } finally {
    globalThis.chrome = previousChrome;
  }
});

test("an appearance change leaves every execution default byte-identical", async () => {
  const area = memoryStorageArea();
  await saveSettings(
    { defaults: { keepAwake: true, delaySeconds: 42, maxSends: 7, recoveryMode: "completion" } },
    area
  );
  const before = (await loadSettings(area)).settings;
  for (const theme of THEME_IDS) {
    await saveSettings({ appearance: { theme } }, area);
  }
  const after = (await loadSettings(area)).settings;
  assert.deepEqual(after.defaults, before.defaults, "Run defaults must be untouched by appearance");
  assert.deepEqual(after.display, before.display, "display settings must be untouched by appearance");
  assert.deepEqual(Object.keys(area.snapshot()), ["aipm.settings.v1"], "one key, the pre-existing one");
});

test("no Run decision branches on a presentation attribute", () => {
  const decisionSurface = stripComments(sidepanelJs);
  for (const marker of ["dataset.aipmTheme", "dataset.aipmMode", "dataset.aipmAccent", "dataset.aipmDensity"]) {
    assert.equal(decisionSurface.includes(marker), false, `sidepanel.js must not branch on ${marker}`);
  }
  assert.match(sidepanelJs, /startAppearanceSync/);
});

/* ======================================================= 10. guardrails ==
   The things the catalogue promised NOT to do.
   ======================================================================= */

test("all three surfaces load the base tokens and the catalogue, in that order", () => {
  for (const [name, html] of Object.entries({ sidepanelHtml, workspaceHtml, optionsHtml })) {
    assert.match(html, /href="ui-tokens\.css"/, `${name} must load the base seam`);
    assert.match(html, /href="themes\/themes\.css"/, `${name} must load the catalogue`);
    assert.ok(html.indexOf("ui-tokens.css") < html.indexOf("themes/themes.css"),
      `${name} must load base tokens before theme overrides`);
  }
});

test("Settings offers the whole catalogue, grouped, from the registry", () => {
  assert.match(optionsHtml, /<select id="theme"><\/select>/, "options are built from the registry");
  assert.match(optionsJs, /buildThemeOptions/);
  assert.match(optionsJs, /createElement\("optgroup"\)/);
  assert.match(optionsJs, /option\.textContent = entry\.displayName/, "no markup interpolation");
  /* No theme may be gated behind a flag or hidden from the list. */
  for (const forbidden of ["experimental", "featureFlag", "devMode", "advancedOnly", "Math.random"]) {
    assert.equal(optionsJs.includes(forbidden), false, `themes must not be gated by ${forbidden}`);
  }
});

test("no font file is bundled, fetched or declared", () => {
  for (const [name, css] of Object.entries(ALL_CSS)) {
    assert.equal(css.includes("@font-face"), false, `${name} must declare no font face`);
    assert.equal(css.includes("url("), false, `${name} must fetch no external asset`);
    assert.equal(/@import/.test(css), false, `${name} must import nothing`);
  }
  assert.ok(fs.readdirSync(new URL("../src/", import.meta.url))
    .every((f) => !/\.(woff2?|ttf|otf|eot)$/i.test(f)));
  /* EVA / Command may PREFER a locally installed face, but only via fallback. */
  const eva = themeTokens("eva-command") ?? {};
  assert.match(eva["--aipm-font-sans"] ?? "", /Matisse/);
  assert.match(eva["--aipm-font-sans"] ?? "", /serif$/, "must end in a generic fallback");
});

test("there is no decorative or looping animation anywhere", () => {
  for (const [name, css] of Object.entries(ALL_CSS)) {
    assert.equal(css.includes("@keyframes"), false, `${name} must define no keyframes`);
    assert.equal(/\banimation(-name)?:/.test(css), false, `${name} must run no animation`);
    assert.equal(css.includes("infinite"), false, `${name} must not loop anything`);
  }
  const transitions = [...Object.values(ALL_CSS).join("\n").matchAll(/transition:\s*([^;]+);/g)]
    .map((m) => m[1].trim());
  assert.deepEqual(transitions, ["width .2s ease"]);
});

test("focus, motion and disabled treatment survive the catalogue", () => {
  assert.match(tokensCss, /:focus-visible \{\s*outline: 2px solid var\(--aipm-focus\);/);
  assert.equal(tokensCss.includes("outline: 2px solid var(--aipm-accent)"), false,
    "focus must not depend on a themeable accent");
  for (const [name, css] of Object.entries(ALL_CSS)) {
    assert.equal(/outline:\s*(none|0)/.test(css), false, `${name} must not remove focus outlines`);
  }
  assert.match(tokensCss, /@media \(prefers-reduced-motion: reduce\)/);
  for (const [name, css] of Object.entries(SURFACE_CSS)) {
    const declared = disabledRules(css).map((r) => r.body).join("\n");
    for (const signal of ["opacity", "cursor", "border-style"]) {
      assert.ok(declared.includes(signal), `${name}: disabled needs the non-colour signal ${signal}`);
    }
  }
  /* Every theme defines its own focus colour, so focus is never invisible. */
  for (const id of THEME_IDS) {
    if (id === DEFAULT_THEME_ID) continue;
    assert.ok((themeTokens(id) ?? {})["--aipm-focus"], `${id} must define a focus colour`);
  }
});

test("no fake instrumentation was introduced", () => {
  const surfaces = [
    stripHtmlComments(sidepanelHtml), stripHtmlComments(workspaceHtml), stripHtmlComments(optionsHtml),
    ...Object.values(ALL_CSS).map(stripCssComments)
  ].join("\n").toLowerCase();
  for (const fake of ["radar", "reticle", "waveform", "oscillo", "sysmeter", "cpu-", "scanline", "glitch"]) {
    assert.equal(surfaces.includes(fake), false, `no fake instrumentation: ${fake}`);
  }
});

test("manifest, permissions and host permissions are untouched by the catalogue", () => {
  assert.deepEqual(manifest.permissions, ["storage", "sidePanel", "alarms", "scripting", "power"]);
  assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*"]);
  assert.equal("web_accessible_resources" in manifest, false);
  assert.deepEqual(manifest.side_panel, { default_path: "src/sidepanel.html" });
  assert.equal(manifest.background.service_worker, "src/background.js");
});

test("appearance normalization is total for every axis", () => {
  for (const hostile of [null, undefined, "dark", 0, [], { theme: ["eva"] },
    { mode: "system " }, { density: "compact; --aipm-bg: red" }]) {
    const { appearance } = normalizeSettings({ appearance: hostile });
    assert.ok(THEME_OPTIONS.includes(appearance.theme));
    assert.ok(MODE_OPTIONS.includes(appearance.mode));
    assert.ok(ACCENT_OPTIONS.includes(appearance.accent));
    assert.ok(DENSITY_OPTIONS.includes(appearance.density));
  }
});

test("the Side Panel reflows safely at and above a 320px viewport", () => {
  assert.match(sidepanelCss, /body \{[^}]*min-width: 0;/s);
  assert.match(sidepanelCss, /\.actions \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  const narrow = sidepanelCss.slice(sidepanelCss.indexOf("@media (max-width: 380px)"));
  assert.match(narrow, /\.actions button \{[^}]*min-height: 40px;/);
  assert.match(narrow, /\.run-summary \{[^}]*flex-wrap: wrap;/);
  assert.equal(/body \{[^}]*min-width:\s*[1-9]\d*px;/s.test(sidepanelCss), false,
    "the document body must not impose a viewport wider than the Side Panel");
});

test("the Workspace still contacts no renderer and mutates no Run", () => {
  const code = stripComments(workspaceJs);
  for (const forbidden of ["chrome.tabs", "chrome.scripting", "executeScript", "chatgpt.com",
    "sendMessage", "AIPM_START", "AIPM_STOP", "AIPM_PAUSE", "AIPM_RESUME"]) {
    assert.equal(code.includes(forbidden), false, `workspace.js must not use ${forbidden}`);
  }
  assert.match(code, /applyAppearance\(document\.documentElement/);
});

test("the Settings page sends no runtime message and holds no Run state", () => {
  const code = stripComments(optionsJs);
  for (const forbidden of ["sendMessage", "AIPM_", "activeRun", "chrome.tabs", "chrome.scripting"]) {
    assert.equal(code.includes(forbidden), false, `options.js must not use ${forbidden}`);
  }
  assert.ok(optionsHtml.includes("実行中の自動化には影響しません"));
});

/* ============================================ 11. retained coverage ==

   Every assertion below existed in the pre-catalogue theme gate. The catalogue
   rewrote that file wholesale, and an audit of base 2f40082 against this branch
   found these checks had been dropped even though the headline test count moved
   by only one. They are restored here, adapted where the catalogue changed the
   architecture, so this branch keeps strictly more coverage than its base.
   ======================================================================= */

test("retained: both EVA designs keep a light light-base and a dark dark-base", () => {
  /* Was "A: EVA Light is a distinct warm base, not an inversion of EVA Dark".
     There are now two EVA designs, so both are checked. */
  /* A theme declares its NATIVE stance in its base block and the other stance
     in a mode block, so which block is light differs per theme: eva-restrained
     is light-native, eva-command is dark-native. Resolve by the declared
     color-scheme rather than assuming a layout. */
  const bgFor = (id, scheme) => {
    for (const mode of [null, "light", "dark"]) {
      const wanted = mode
        ? `:root[data-aipm-theme="${id}"][data-aipm-mode="${mode}"]`
        : `:root[data-aipm-theme="${id}"]`;
      const block = declarationBlocks(themesCss).find((b) => b.selector === wanted);
      if (!block) continue;
      if (block.body.includes(`color-scheme: ${scheme};`)) {
        return hexChannels(/--aipm-bg:\s*([^;]+);/.exec(block.body)?.[1] ?? "");
      }
    }
    return null;
  };
  for (const id of ["eva-restrained", "eva-command"]) {
    const light = bgFor(id, "light");
    const dark = bgFor(id, "dark");
    assert.ok(light, `${id} needs a light base`);
    assert.ok(dark, `${id} needs a dark base`);
    assert.ok(light.r > 200 && light.g > 200, `${id} light base must be light`);
    assert.ok(dark.r < 60 && dark.g < 60, `${id} dark base must be dark`);
    assert.ok(light.r < 255, `${id} light base must be low-glare, not pure white`);
  }
  /* EVA / Restrained keeps the warm paper base this repository already shipped. */
  const restrained = bgFor("eva-restrained", "light");
  assert.ok(restrained.r > restrained.b, "eva-restrained light base must stay warm");
});

test("retained: Settings states that appearance decides nothing", () => {
  /* Was "H: the Settings page states that appearance is presentation only". */
  assert.ok(
    optionsHtml.includes("実行の可否・送信・停止・復旧の判断には一切使いません"),
    "the appearance group must say what it cannot do"
  );
});

test("retained: the spacing scale is shared rather than re-invented per surface", () => {
  for (const step of ["--aipm-space-1", "--aipm-space-2", "--aipm-space-3", "--aipm-space-4"]) {
    assert.ok(tokensCss.includes(`${step}:`), `${step} must exist`);
  }
  assert.match(tokensCss, /:root\[data-aipm-density="compact"\] \{[^}]*--aipm-space-1: 3px;/s);
});

test("retained: surfaces read tokens instead of inventing a palette", () => {
  /* A raw system colour in a surface sheet would bypass all 23 themes. The
     `default` theme legitimately uses them, but only inside ui-tokens.css. */
  for (const [name, css] of Object.entries(SURFACE_CSS)) {
    for (const systemColour of ["Canvas", "CanvasText", "ButtonFace", "Highlight"]) {
      assert.equal(
        new RegExp(`:\\s*${systemColour}\\b`).test(css),
        false,
        `${name} must not use the system colour ${systemColour} directly`
      );
    }
  }
  /* Theme blocks must be self-contained hex, never system colours. */
  for (const systemColour of ["Canvas", "CanvasText"]) {
    assert.equal(new RegExp(`:\\s*${systemColour}\\b`).test(themesCss), false,
      `themes.css must not depend on ${systemColour}`);
  }
});

test("retained: every accent option is bounded and every one is defined", () => {
  assert.deepEqual(ACCENT_OPTIONS, ["theme", "amber", "violet", "green"]);
  for (const accent of ACCENT_OPTIONS) {
    if (accent === "theme") continue;
    assert.ok(tokensCss.includes(`:root[data-aipm-accent="${accent}"]`),
      `${accent} must have a light definition`);
    assert.ok(tokensCss.includes(`:root[data-aipm-mode="dark"][data-aipm-accent="${accent}"]`),
      `${accent} must have a dark definition`);
  }
  const root = fakeRoot();
  applyAppearance(root, { theme: "clean-premium", accent: "neon-pink" });
  assert.equal(root.dataset.aipmAccent, "theme", "an unknown accent must fall back");
});

test("retained: advanced diagnostics remain native details/summary on both surfaces", () => {
  assert.match(sidepanelHtml, /<details id="diagnosticsAdvanced" class="diagnostics-advanced">/);
  assert.match(sidepanelHtml, /<summary>技術詳細を表示<\/summary>/);
  assert.match(workspaceHtml, /<details id="sideDiagnosticsAdvanced" class="diag-advanced">/);
  for (const [name, css] of Object.entries(ALL_CSS)) {
    assert.equal(/summary\s*\{[^}]*display:\s*none/.test(css), false, `${name} must not hide summary`);
  }
});

test("retained: the diagnostics level preference is still wired and still display-only", () => {
  assert.match(sidepanelJs, /el\.diagnosticsAdvanced\.open = diagnosticsLevelIsDetailed\(diagnosticsLevel\)/);
  assert.match(workspaceJs, /el\.sideDiagnosticsAdvanced\.open = diagnosticsLevelIsDetailed\(diagnosticsLevel\)/);
});

test("retained: diagnostics stay visually subordinate to the primary Run status", () => {
  assert.match(sidepanelCss, /\.run-card \{[^}]*border-width: 2px;/s);
  assert.match(sidepanelCss, /\.run-state-badge \{[^}]*font-weight: 800;/s);
  assert.match(sidepanelCss, /\.diagnostics-summary,\s*\n\.diagnostics-safety \{[^}]*font-size: var\(--aipm-font-meta\)/s);
  assert.equal(/\.diagnostics-card \{[^}]*position: sticky/s.test(sidepanelCss), false);
  assert.match(sidepanelCss, /\.diagnostics-details dd \{[^}]*font-family: var\(--aipm-font-mono\)/s);
  assert.ok(sidepanelHtml.indexOf('id="runCard"') < sidepanelHtml.indexOf('id="diagnosticsHeading"'));
});

test("retained: the Workspace narrow-width breakpoints survive the catalogue", () => {
  for (const query of ["@media (max-width: 1180px)", "@media (max-width: 820px)", "@media (max-width: 1240px)"]) {
    assert.ok(workspaceCss.includes(query), `${query} must remain`);
  }
  assert.match(workspaceCss, /\.workspace \{[^}]*grid-template-columns:[^}]*minmax\(0, 1fr\)/s);
  assert.match(workspaceCss, /\.col-nav, \.col-main, \.col-side \{[^}]*min-width: 0;/s);
});

test("retained: nothing in the Side Panel can force horizontal overflow", () => {
  assert.equal(/(?<![-a-z])width:\s*\d{3,}px/.test(sidepanelCss), false,
    "no fixed multi-hundred-pixel width");
  assert.match(sidepanelCss, /\.grid2 > div \{[^}]*min-width: 0;/s);
  assert.match(sidepanelCss, /\.card \{[^}]*min-width: 0;/s);
});

test("retained: a shared focus-visible ring covers every interactive element", () => {
  const roles = /:where\(([^)]*)\):focus-visible/.exec(tokensCss)[1];
  for (const role of ["a", "button", "input", "select", "textarea", "summary", "[tabindex]"]) {
    assert.ok(roles.includes(role), `${role} must be covered by the focus ring`);
  }
});

test("retained: appearance round-trips through the existing settings store", async () => {
  const area = memoryStorageArea();
  const written = await saveSettings(
    { appearance: { theme: "japanese-systems", mode: "dark", accent: "violet", density: "compact" } },
    area
  );
  assert.equal(written.ok, true);
  const reloaded = await loadSettings(area);
  assert.equal(reloaded.ok, true);
  assert.deepEqual(reloaded.settings.appearance, {
    theme: "japanese-systems", mode: "dark", accent: "violet", density: "compact"
  });
  assert.deepEqual(Object.keys(area.snapshot()), ["aipm.settings.v1"]);
});

test("retained: a failed appearance write is never reported as stored", async () => {
  const result = await saveSettings({ appearance: { theme: "swiss-information" } }, {});
  assert.equal(result.ok, false);
  assert.equal(result.settings.appearance.theme, "swiss-information", "the edit is kept on screen");
});

test("retained: an explicit mode wins over the host preference in both directions", () => {
  /* Only meaningful for a both-stance design; a pinned theme is covered by the
     stance test above. */
  const forcedLight = fakeRoot();
  applyAppearance(forcedLight, { theme: "clean-premium", mode: "light" }, true);
  assert.equal(forcedLight.dataset.aipmMode, "light");
  const forcedDark = fakeRoot();
  applyAppearance(forcedDark, { theme: "clean-premium", mode: "dark" }, false);
  assert.equal(forcedDark.dataset.aipmMode, "dark");
  const systemDark = fakeRoot();
  applyAppearance(systemDark, { theme: "clean-premium", mode: "system" }, true);
  assert.equal(systemDark.dataset.aipmMode, "dark");
});

test("retained: a settings read failure still paints, using bounded defaults", async () => {
  const root = fakeRoot();
  const previousChrome = globalThis.chrome;
  globalThis.chrome = { storage: { local: { get: () => { throw new Error("storage exploded"); } } } };
  try {
    await startAppearanceSync({ root, media: { matches: false }, storage: globalThis.chrome.storage });
  } finally {
    globalThis.chrome = previousChrome;
  }
  assert.deepEqual(root.dataset, {
    aipmTheme: "default", aipmAccent: "theme", aipmDensity: "comfortable", aipmMode: "light"
  });
});

test("retained: an unrelated storage key neither repaints nor re-reads", async () => {
  const area = memoryStorageArea({
    "aipm.settings.v1": { appearance: { theme: "mecha" } },
    "aipm.activeRun.v2.tab.9": { runId: "must-not-be-read", status: "running" }
  });
  const listeners = [];
  const root = fakeRoot();
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    storage: { local: area, onChanged: { addListener: (fn) => listeners.push(fn) } }
  };
  try {
    await startAppearanceSync({ root, media: { matches: false }, storage: globalThis.chrome.storage });
    assert.equal(root.dataset.aipmTheme, "mecha");
    const readsBefore = area.reads.length;
    for (const listener of listeners) {
      listener({ "aipm.activeRun.v2.tab.9": { newValue: { status: "paused" } } }, "local");
    }
    assert.equal(root.dataset.aipmTheme, "mecha", "an unrelated key must not change the theme");
    assert.equal(area.reads.length, readsBefore, "an unrelated key must not trigger a read");
    /* A settings change on a non-local area must also be ignored. */
    for (const listener of listeners) {
      listener({ "aipm.settings.v1": { newValue: { appearance: { theme: "terminal" } } } }, "session");
    }
    assert.equal(root.dataset.aipmTheme, "mecha", "only the local area may repaint");
  } finally {
    globalThis.chrome = previousChrome;
  }
});
