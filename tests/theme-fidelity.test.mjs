import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { THEMES } from "../src/themes/registry.js";

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
const css = read("../src/themes/fidelity.css");
const themesCss = read("../src/themes/themes.css");
const sidepanelHtml = read("../src/sidepanel.html");
const workspaceHtml = read("../src/workspace.html");
const optionsHtml = read("../src/options.html");

const LAB_THEME_IDS = THEMES
  .filter((theme) => theme.origin.startsWith("ui-lab:"))
  .map((theme) => theme.id);

function sectionFor(id) {
  const marker = `/* ===== ${id} <=`;
  const start = css.indexOf(marker);
  assert.ok(start >= 0, `${id} needs a fidelity section`);
  const nextTheme = css.indexOf("\n/* ===== ", start + marker.length);
  const common = css.indexOf("/* UI Lab state fills", start + marker.length);
  const end = nextTheme >= 0 ? nextTheme : common >= 0 ? common : css.length;
  return css.slice(start, end);
}

test("component fidelity covers all 21 ported UI Lab designs", () => {
  assert.equal(LAB_THEME_IDS.length, 21);
  assert.equal([...css.matchAll(/\/\* ===== ([a-z0-9-]+) <= UI Lab/g)].length, 21);
  for (const id of LAB_THEME_IDS) assert.ok(sectionFor(id).length > 1_000, `${id} is token-only`);
});

test("all three real surfaces load fidelity after their structural stylesheet", () => {
  for (const [name, html, structural] of [
    ["Side Panel", sidepanelHtml, "sidepanel.css"],
    ["Workspace", workspaceHtml, "workspace.css"],
    ["Settings", optionsHtml, "options.css"]
  ]) {
    const structuralAt = html.indexOf(`href="${structural}"`);
    const fidelityAt = html.indexOf('href="themes/fidelity.css"');
    assert.ok(structuralAt >= 0 && fidelityAt > structuralAt,
      `${name} must apply fidelity after structural layout CSS`);
  }
});

test("every UI Lab theme styles the complete production component system", () => {
  const mandatoryRoles = [
    ".card", ".run-state-badge", ".status-badge", ".progress-track",
    "button.primary", "button.danger", ".diagnostics-card",
    ".nav-links button", ".detail-grid > div"
  ];
  for (const id of LAB_THEME_IDS) {
    const section = sectionFor(id);
    for (const role of mandatoryRoles) {
      assert.ok(section.includes(role), `${id} does not style ${role}`);
    }
  }
});

test("compiled selectors target production roles, not dead UI Lab mock classes", () => {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const dead of [
    ".app-shell", ".surface", ".job-row", ".state-badge",
    ".primary-button", ".danger-button", ".info-cell", ".nav-button",
    ".diagnostic-list"
  ]) {
    assert.equal(withoutComments.includes(dead), false, `dead source selector leaked: ${dead}`);
  }
});

test("state semantics cover both Side Panel and Workspace attributes", () => {
  for (const token of [
    "--state-ready-bg", "--state-running-bg", "--state-paused-bg",
    "--state-needs-bg", "--state-stopped-bg", "--state-completed-bg"
  ]) {
    for (const id of LAB_THEME_IDS) assert.ok(sectionFor(id).includes(token), `${id} needs ${token}`);
  }
  for (const state of ["idle", "running", "paused", "confirmation-required", "fail-closed", "completed"]) {
    assert.ok(css.includes(`data-state="${state}"`), `Side Panel ${state} mapping`);
  }
  for (const safety of ["unknown", "running", "user-paused", "confirmation-required", "fail-closed", "completed"]) {
    assert.ok(css.includes(`data-safety="${safety}"`), `Workspace ${safety} mapping`);
  }
});

test("danger remains an explicit action and stopped remains a distinct state", () => {
  assert.match(css, /:is\(button\.danger,\.danger-action\) \{\s*color: var\(--aipm-status-stop\);\s*border-color: var\(--aipm-status-stop\);/s);
  assert.match(css, /data-state="fail-closed"[\s\S]*background: var\(--state-stopped-bg\);/);
  assert.match(css, /data-safety="fail-closed"/);
});

test("each design family retains its load-bearing component signature", () => {
  const signatures = {
    "clean-premium": "linear-gradient(90deg,#2563eb,#60a5fa)",
    "mecha": "clip-path: polygon",
    "neo-tech": "inset 3px 0 0 #26d7ff",
    "terminal": 'content:">_ "',
    "chatgpt-native": "border-radius: 10px",
    "google-native": "border: 1px solid color-mix(in srgb, var(--aipm-border) 52%, transparent)",
    "microsoft-fluent": "inset 3px 0 0 var(--aipm-accent)",
    "apple-utility": "border-radius: 12px",
    "linear-saas": "height: 2px",
    "modern-terminal": 'content: "["',
    "mission-control": "border-left: 5px solid var(--caution)",
    "industrial-control": "min-height: 52px",
    "swiss-information": "padding: 14px 0 0",
    "technical-manual": "counter-increment: aipm-section",
    "brutalist-utility": "border: 3px solid var(--aipm-border)",
    "operator-dense": "min-height: 34px",
    "calm-productivity": "text-transform: none",
    "scientific-instrument": "height: 13px",
    "monochrome-engineering": "border-style: dashed",
    "japanese-systems": "line-height: 1.85",
    "eva-command": "COMMAND / LOCAL"
  };
  assert.deepEqual(Object.keys(signatures).sort(), [...LAB_THEME_IDS].sort());
  for (const [id, signature] of Object.entries(signatures)) {
    assert.ok(sectionFor(id).includes(signature), `${id} lost ${signature}`);
  }
});

test("EVA Command restores its full dark/light component system", () => {
  const eva = sectionFor("eva-command");
  for (const signature of [
    'data-aipm-mode="light"', "COMMAND / LOCAL", ".target-card",
    ".run-card", ".diagnostics-card", ".nav-links button",
    "repeating-linear-gradient(-45deg", "border-left: 7px solid",
    '"FOT-Matisse Pro EB"'
  ]) assert.ok(eva.includes(signature), `EVA missing ${signature}`);
  assert.match(themesCss, /\.aipm-hex-tile[\s\S]*height: calc\(var\(--hex-size\) \* \.8660254038\)/);
  assert.match(themesCss, /\.aipm-hex-tile::after[\s\S]*content: "\\25B2\\A\\25BC"/);
});

test("the fidelity layer is presentation-only", () => {
  const declarations = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const forbidden of [
    "chrome.", "AIPM_START", "AIPM_STOP", "AIPM_PAUSE", "AIPM_RESUME",
    "sendMessage", "executeScript", "activeRun", "lease", "conversationId"
  ]) assert.equal(declarations.includes(forbidden), false, `CSS must not contain ${forbidden}`);
});

test("the fidelity layer cannot reveal hidden UI or create blocking decoration", () => {
  const declarations = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(declarations, /\[hidden\]/);
  assert.doesNotMatch(declarations, /@font-face|https?:\/\//);
  assert.doesNotMatch(declarations, /@keyframes|\banimation(?:-name)?:/);
  assert.doesNotMatch(declarations, /position:\s*(?:fixed|sticky)\b/);

  for (const selector of [".aipm-hex-field", ".aipm-hex-tile", "::before", "::after"]) {
    if (declarations.includes(selector)) {
      assert.ok(declarations.includes("pointer-events: none"),
        `${selector} decoration must not intercept controls`);
    }
  }
});

test("no theme hides a canonical production status or progress component", () => {
  for (const id of LAB_THEME_IDS) {
    const section = sectionFor(id);
    for (const role of [".run-state-badge", ".status-badge", ".progress-track"]) {
      const escaped = role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.doesNotMatch(section, new RegExp(`${escaped}\\s*\\{[^}]*display:\\s*none`, "s"),
        `${id} must not hide ${role}`);
    }
  }
});
