import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  THEMES,
  THEME_IDS,
  effectiveAccent,
  normalizeThemeId,
  resolveThemeMode,
  themeAllowsAccent,
  themeById
} from "../src/themes/registry.js";
import { THEME_OPTIONS } from "../src/settings-store.js";

const themesCss = fs.readFileSync(new URL("../src/themes/themes.css", import.meta.url), "utf8");
const fidelityCss = fs.readFileSync(new URL("../src/themes/fidelity.css", import.meta.url), "utf8");
const manualCss = fs.readFileSync(new URL("../src/themes/manual-ux.css", import.meta.url), "utf8");

function declarationBlock(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? "";
}

function expectTokens(block, expected) {
  for (const [token, value] of Object.entries(expected)) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(block, new RegExp(`${token}:\\s*${escaped}(?:;|$)`), `${token} must be ${value}`);
  }
}

const light = declarationBlock(themesCss, ':root[data-aipm-theme="claude-native"]');
const dark = declarationBlock(themesCss,
  ':root[data-aipm-theme="claude-native"][data-aipm-mode="dark"]');
const lightBody = declarationBlock(fidelityCss,
  ':root[data-aipm-theme="claude-native"][data-aipm-mode="light"] body');
const darkBody = declarationBlock(fidelityCss,
  ':root[data-aipm-theme="claude-native"][data-aipm-mode="dark"] body');

test("Claude Native is one bounded canonical Product theme", () => {
  assert.equal(THEMES.length, 24);
  assert.equal(THEME_IDS.length, 24);
  assert.equal(THEME_OPTIONS.length, 24);
  assert.equal(new Set(THEME_IDS).size, 24);
  assert.equal(THEME_IDS.filter((id) => id === "claude-native").length, 1);
  assert.deepEqual(themeById("claude-native"), {
    id: "claude-native",
    displayName: "温かみのある紙面",
    group: "product",
    origin: "production:claude-current",
    stance: "both",
    accentPolicy: "customizable",
    decoration: null
  });
  assert.equal(normalizeThemeId("unknown-claude-lookalike"), "default");
});

test("Claude Native light maps the measured warm current palette", () => {
  expectTokens(light, {
    "--aipm-bg": "#fcfcfb",
    "--aipm-surface": "#ffffff",
    "--aipm-surface-raised": "#f9f9f7",
    "--aipm-surface-sunken": "#edece8",
    "--aipm-text": "#0b0b0b",
    "--aipm-secondary-text": "#52514e",
    "--aipm-muted": "#898781",
    "--aipm-border": "rgb(11 11 11 / 10%)",
    "--aipm-accent": "#2a78d6",
    "--aipm-accent-ink": "#184f95",
    "--aipm-brand-detail": "#c6613f"
  });
  assert.match(lightBody, /box-shadow:\s*none/);
});

test("Claude Native dark maps the measured warm current palette", () => {
  expectTokens(dark, {
    "--aipm-bg": "#151515",
    "--aipm-surface": "#1a1a19",
    "--aipm-surface-raised": "#20201f",
    "--aipm-surface-sunken": "#0b0b0b",
    "--aipm-text": "#f0efec",
    "--aipm-secondary-text": "#c3c2b7",
    "--aipm-muted": "#898781",
    "--aipm-border": "rgb(255 255 255 / 10%)",
    "--aipm-accent-ink": "#6da7ec"
  });
  assert.match(darkBody, /box-shadow:\s*none/);
});

test("Claude Native explicit Mode and customizable Accent axes remain independent", () => {
  assert.equal(resolveThemeMode("claude-native", "light", true), "light");
  assert.equal(resolveThemeMode("claude-native", "dark", false), "dark");
  assert.equal(resolveThemeMode("claude-native", "system", true), "dark");
  assert.equal(themeAllowsAccent("claude-native"), true);
  assert.equal(effectiveAccent("claude-native", "violet"), "violet");
  for (const mode of ["light", "dark"]) {
    for (const accent of ["theme", "amber", "violet", "green"]) {
      const selector = `:root[data-aipm-theme="claude-native"][data-aipm-mode="${mode}"]` +
        `[data-aipm-accent="${accent}"]`;
      const block = declarationBlock(manualCss, selector);
      assert.ok(block, `${mode}/${accent} needs a late-cascade rule`);
      assert.match(block, /--aipm-accent-(?:soft|ink):/);
    }
  }
  assert.doesNotMatch(`${lightBody}\n${darkBody}`, /--aipm-accent:\s*#/,
    "body palettes must not shadow the Accent axis");
});

test("Claude functional blue and terracotta brand identity stay separate", () => {
  assert.match(light, /--aipm-accent:\s*#2a78d6/);
  assert.match(light, /--aipm-brand-detail:\s*#c6613f/);
  const claudeSection = fidelityCss.split("/* ===== claude-native")[1]
    .split("/* ===== microsoft-fluent")[0];
  assert.match(claudeSection,
    /border-left:\s*3px solid var\(--aipm-brand-detail\)/,
    "terracotta is restricted to a small identity rail");
  for (const selector of ["button.primary", "primary-action", "progress-fill", "focus"]) {
    assert.doesNotMatch(claudeSection,
      new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^}]*#c6613f`));
  }
  assert.doesNotMatch(`${light}\n${dark}`, /--aipm-status-[^:]+:\s*#c6613f/);
});

test("Claude directly measured composer geometry maps to prompt/editor roles", () => {
  const claudeSection = fidelityCss.split("/* ===== claude-native")[1]
    .split("/* ===== microsoft-fluent")[0];
  assert.match(claudeSection, /:is\(textarea,.editor-card\)[^]*border-radius:\s*14px/);
  assert.match(claudeSection, /:is\(textarea,.editor-card\)[^]*padding:\s*10px/);
  assert.match(claudeSection, /textarea\s*\{[^}]*font-size:\s*16px[^}]*line-height:\s*22px/s);
  assert.match(claudeSection, /box-shadow:\s*0 4px 20px rgb\(0 0 0 \/ 3\.5%\)/);
});

test("Claude status meaning and Density remain independent of appearance taste", () => {
  for (const block of [light, dark]) {
    for (const token of ["--aipm-status-running", "--aipm-status-paused",
      "--aipm-status-warning", "--aipm-status-stop", "--aipm-status-done"]) {
      assert.ok(block.includes(`${token}:`), `${token} is required`);
    }
  }
  const claudeCss = [light, dark, lightBody, darkBody].join("\n");
  assert.doesNotMatch(claudeCss, /--aipm-density-/);
  assert.match(fidelityCss, /claude-native[^]*min-height:\s*var\(--aipm-control-height\)/);
});

test("Claude Native ships no Anthropic or remote font asset", () => {
  const claudeCss = [light, dark, fidelityCss.split("/* ===== claude-native")[1]
    .split("/* ===== microsoft-fluent")[0]].join("\n");
  assert.doesNotMatch(claudeCss, /anthropic-sans/i);
  assert.doesNotMatch(claudeCss, /@font-face|url\(\s*["']?https?:/i);
  assert.match(light, /system-ui,\s*"Segoe UI",\s*Roboto,\s*Helvetica,\s*Arial/);
});
