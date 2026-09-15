import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

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

const light = declarationBlock(themesCss, ':root[data-aipm-theme="google-native"]');
const dark = declarationBlock(themesCss,
  ':root[data-aipm-theme="google-native"][data-aipm-mode="dark"]');
const lightBody = declarationBlock(fidelityCss,
  ':root[data-aipm-theme="google-native"][data-aipm-mode="light"] body');
const darkBody = declarationBlock(fidelityCss,
  ':root[data-aipm-theme="google-native"][data-aipm-mode="dark"] body');

test("Google Native light maps the measured current Gemini palette", () => {
  expectTokens(light, {
    "--aipm-bg": "#fdfcfc",
    "--aipm-surface": "#ffffff",
    "--aipm-surface-raised": "#f0f4f9",
    "--aipm-surface-sunken": "#f2f0f0",
    "--aipm-text": "#1f1f1f",
    "--aipm-secondary-text": "#444746",
    "--aipm-muted": "#5f6368",
    "--aipm-border": "#c4c7c5",
    "--aipm-accent": "#0b57d0"
  });
  assert.match(light, /--aipm-surface-shadow:\s*none/);
  assert.match(lightBody, /box-shadow:\s*none/);
});

test("Google Native dark maps the measured current Gemini palette", () => {
  expectTokens(dark, {
    "--aipm-bg": "#0f0f0f",
    "--aipm-surface": "#1f1f1f",
    "--aipm-surface-raised": "#1e1f20",
    "--aipm-surface-sunken": "#171717",
    "--aipm-text": "#e3e3e3",
    "--aipm-secondary-text": "rgb(255 255 255 / 55%)",
    "--aipm-muted": "#8e918f",
    "--aipm-border": "rgb(255 255 255 / 12%)"
  });
  assert.match(darkBody, /box-shadow:\s*none/);
  assert.match(manualCss,
    /google-native"\]\[data-aipm-mode="dark"\]\[data-aipm-accent="theme"\][^]*--aipm-accent:\s*#a8c7fa/);
});

test("Google Native uses explicit Mode selectors without a system-media override", () => {
  assert.ok(lightBody, "explicit light body palette must exist");
  assert.ok(darkBody, "explicit dark body palette must exist");
  assert.doesNotMatch(fidelityCss,
    /google-native"\]:not\(\[data-aipm-mode="dark"\]\) body/);
  const media = fidelityCss.match(/@media\s*\(prefers-color-scheme:[^)]+\)[\s\S]*?google-native/g) ?? [];
  assert.equal(media.length, 0, "system media must not override the resolved explicit Mode");
});

test("Google Native keeps the independent Accent axis in both modes", () => {
  for (const mode of ["light", "dark"]) {
    for (const accent of ["theme", "amber", "violet", "green"]) {
      const selector = `:root[data-aipm-theme="google-native"][data-aipm-mode="${mode}"]` +
        `[data-aipm-accent="${accent}"]`;
      const block = declarationBlock(manualCss, selector);
      assert.ok(block, `${mode}/${accent} needs an explicit late-cascade rule`);
      if (accent === "theme") assert.match(block, /--aipm-accent:/);
      else assert.match(block, /--aipm-accent-soft:/);
    }
  }
  assert.match(fidelityCss, /--aipm-accent-container:\s*var\(--aipm-accent-soft\)/);
  assert.match(fidelityCss, /color:\s*var\(--aipm-accent\)/);
});

test("Google Native keeps semantic status tokens and Density independent", () => {
  expectTokens(light, {
    "--aipm-status-running": "#10653a",
    "--aipm-status-paused": "#7a4d00",
    "--aipm-status-warning": "#8b3a04",
    "--aipm-status-stop": "#a1160f",
    "--aipm-status-done": "#10357f"
  });
  expectTokens(dark, {
    "--aipm-status-running": "#81c995",
    "--aipm-status-paused": "#8ab4f8",
    "--aipm-status-warning": "#fdd663",
    "--aipm-status-stop": "#f28b82",
    "--aipm-status-done": "#81c995"
  });
  const googleCss = [light, dark, lightBody, darkBody].join("\n");
  assert.doesNotMatch(googleCss, /--aipm-density-/);
  assert.match(fidelityCss, /google-native[^]*min-height:\s*var\(--aipm-control-height\)/);
});

test("Google Native ordinary sections are flat 12px roles and inputs stay evidence-bounded", () => {
  const googleSection = fidelityCss.split("/* ===== google-native")[1]
    .split("/* ===== microsoft-fluent")[0];
  assert.match(googleSection, /border-radius:\s*12px/);
  assert.match(googleSection, /box-shadow:\s*none/);
  assert.doesNotMatch(googleSection, /box-shadow:\s*0 1px 2px rgba\(60,64,67/);
  assert.match(googleSection, /Gemini chat composer was not part of the measured evidence/);
  assert.match(googleSection, /:is\(input,select,textarea\)/);
});
