/*
  Current ChatGPT fidelity contract.

  This is deliberately source-level and presentation-only. The canonical
  browser renderer proves the same rules on all three extension surfaces; this
  file makes palette and cascade drift fail quickly before that visual gate.
*/

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
const tokenCss = read("../src/themes/themes.css");
const fidelityCss = read("../src/themes/fidelity.css");
const manualCss = read("../src/themes/manual-ux.css");
const sharedCss = read("../src/ui-tokens.css");

function block(source, selector) {
  const start = source.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing selector: ${selector}`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  return source.slice(open + 1, close);
}

function value(body, property) {
  return new RegExp(`${property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*([^;]+)`)
    .exec(body)?.[1].replace(/!important/g, "").trim() ?? null;
}

const base = block(tokenCss, ':root[data-aipm-theme="chatgpt-native"]');
const dark = block(tokenCss, ':root[data-aipm-theme="chatgpt-native"][data-aipm-mode="dark"]');
const lightBody = block(fidelityCss,
  ':root[data-aipm-theme="chatgpt-native"][data-aipm-mode="light"] body');
const darkBody = block(fidelityCss,
  ':root[data-aipm-theme="chatgpt-native"][data-aipm-mode="dark"] body');

test("ChatGPT Native light tokens match the measured current ChatGPT palette", () => {
  const expected = {
    "--aipm-bg": "#fcfcfc",
    "--aipm-surface": "#f9f9f9",
    "--aipm-surface-raised": "#ececec",
    "--aipm-surface-sunken": "#e3e3e3",
    "--aipm-text": "#0d0d0d",
    "--aipm-muted": "#5d5d5d",
    "--aipm-text-tertiary": "#8f8f8f",
    "--aipm-border-soft": "rgb(0 0 0 / 5%)",
    "--aipm-border": "rgb(0 0 0 / 10%)",
    "--aipm-border-strong": "rgb(0 0 0 / 15%)",
    "--aipm-selected-bg": "rgb(0 0 0 / 5%)",
    "--aipm-input-bg": "rgb(233 233 233 / 50%)",
    "--aipm-hover-bg": "#ececec",
    "--aipm-accent-bg": "#3a83f7",
    "--aipm-accent": "#2c67c5",
    "--aipm-accent-ink": "#2c67c5"
  };
  for (const [property, expectedValue] of Object.entries(expected)) {
    assert.equal(value(base, property), expectedValue, property);
  }
  assert.equal(value(base, "--aipm-surface-shadow"), "none");
  assert.equal(value(base, "--aipm-font-sans"),
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif');
});

test("ChatGPT Native dark tokens match the measured current ChatGPT palette", () => {
  const expected = {
    "--aipm-bg": "#000000",
    "--aipm-surface": "#212121",
    "--aipm-surface-raised": "#2f2f2f",
    "--aipm-surface-sunken": "#303030",
    "--aipm-text": "#ffffff",
    "--aipm-muted": "#cdcdcd",
    "--aipm-text-tertiary": "#afafaf",
    "--aipm-border-soft": "rgb(255 255 255 / 5%)",
    "--aipm-border": "rgb(255 255 255 / 10%)",
    "--aipm-border-strong": "rgb(255 255 255 / 15%)",
    "--aipm-selected-bg": "rgb(255 255 255 / 10%)",
    "--aipm-input-bg": "rgb(50 50 50 / 85%)",
    "--aipm-hover-bg": "#2f2f2f",
    "--aipm-accent-bg": "#3a83f7",
    "--aipm-accent-ink": "#63a8f8"
  };
  for (const [property, expectedValue] of Object.entries(expected)) {
    assert.equal(value(dark, property), expectedValue, property);
  }
});

test("explicit data-aipm-mode owns luminance without a system-media fallback selector", () => {
  assert.match(fidelityCss,
    /:root\[data-aipm-theme="chatgpt-native"\]\[data-aipm-mode="light"\] body\s*\{/);
  assert.match(fidelityCss,
    /:root\[data-aipm-theme="chatgpt-native"\]\[data-aipm-mode="dark"\] body\s*\{/);
  assert.doesNotMatch(fidelityCss,
    /:root\[data-aipm-theme="chatgpt-native"\]:not\(\[data-aipm-mode="dark"\]\) body/);
  assert.match(sharedCss,
    /@media \(prefers-color-scheme: dark\)[\s\S]*data-aipm-accent="amber"\]:not\(\[data-aipm-mode="light"\]\)/);
  assert.match(sharedCss,
    /:root\[data-aipm-mode="dark"\]\[data-aipm-accent="amber"\]/);
});

test("theme blue is fallback-only and every explicit Accent override wins", () => {
  assert.equal(value(base, "--aipm-accent-bg"), "#3a83f7");
  assert.equal(value(base, "--aipm-accent"), "#2c67c5");
  const darkTheme = block(manualCss,
    ':root[data-aipm-theme="chatgpt-native"][data-aipm-mode="dark"][data-aipm-accent="theme"]');
  assert.equal(value(darkTheme, "--aipm-accent"), "#3a83f7");
  assert.equal(value(darkTheme, "--aipm-accent-ink"), "#63a8f8");

  const custom = {
    amber: ["#8a5a12", "#c8873a"],
    violet: ["#63479c", "#9273cf"],
    green: ["#2f6b4a", "#4fa07c"]
  };
  for (const [accent, [lightValue, darkValue]] of Object.entries(custom)) {
    const light = block(manualCss,
      `:root[data-aipm-theme="chatgpt-native"][data-aipm-mode="light"][data-aipm-accent="${accent}"]`);
    assert.equal(value(light, "--aipm-accent"), lightValue, `${accent}/light`);
    assert.equal(value(light, "--aipm-accent-bg"), lightValue, `${accent}/light background`);
    assert.equal(value(light, "--aipm-accent-ink"), lightValue, `${accent}/light ink`);
    assert.match(light, /--aipm-accent:[^;]+!important/);

    const darkRule = block(manualCss,
      `:root[data-aipm-theme="chatgpt-native"][data-aipm-mode="dark"][data-aipm-accent="${accent}"]`);
    assert.equal(value(darkRule, "--aipm-accent"), darkValue, `${accent}/dark`);
    assert.equal(value(darkRule, "--aipm-accent-bg"), darkValue, `${accent}/dark background`);
    assert.equal(value(darkRule, "--aipm-accent-ink"), darkValue, `${accent}/dark ink`);
  }
  assert.equal(lightBody.includes("--aipm-accent:"), false,
    "a closer body declaration must not shadow the Accent axis");
});

test("status grounds keep the current ChatGPT success warning and error families distinct", () => {
  assert.equal(value(lightBody, "--state-running-bg"), "#def3e5");
  assert.equal(value(lightBody, "--state-paused-bg"), "#fdf5f1");
  assert.equal(value(lightBody, "--state-stopped-bg"), "#fff0f0");
  assert.equal(value(darkBody, "--state-running-bg"), "#1f4e25");
  assert.equal(value(darkBody, "--state-paused-bg"), "#45240d");
  assert.equal(value(darkBody, "--state-stopped-bg"), "#4d100e");
  assert.equal(value(darkBody, "--state-running-fg"), "#effaf3");
  assert.equal(value(darkBody, "--state-paused-fg"), "#f1a275");
  assert.equal(value(darkBody, "--state-stopped-fg"), "#ff8583");

  for (const body of [lightBody, darkBody]) {
    const inks = ["ready", "running", "paused", "needs", "stopped", "completed"]
      .map((role) => value(body, `--state-${role}-fg`));
    assert.equal(new Set(inks).size, inks.length, "each state keeps a distinct ink");
  }
});

test("current ChatGPT component treatment stays flat, quiet and theme-scoped", () => {
  assert.match(fidelityCss,
    /data-aipm-theme="chatgpt-native"[^}]*input:not\(\[type="checkbox"\]\),select,textarea\)[\s\S]*?background: var\(--aipm-input-bg\)/);
  assert.match(fidelityCss,
    /data-aipm-theme="chatgpt-native"[^}]*run-row\.is-selected[\s\S]*?background: var\(--aipm-selected-bg\)/);
  assert.match(fidelityCss,
    /data-aipm-theme="chatgpt-native"[^}]*:hover:not\(:disabled\)[\s\S]*?background: var\(--aipm-hover-bg\)/);
  assert.doesNotMatch([base, dark, lightBody, darkBody].join("\n"),
    /linear-gradient|drop-shadow|url\(|@import/);
  assert.doesNotMatch([base, dark, lightBody, darkBody].join("\n"),
    /https?:\/\/|chrome\.|sendMessage|AIPM_|conversationKey|runId/);
});
