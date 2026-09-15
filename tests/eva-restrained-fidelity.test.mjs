import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { themeById, resolveThemeMode } from "../src/themes/registry.js";

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
const css = read("../src/themes/eva-restrained.css");
const themeJs = read("../src/theme.js");

const executableCss = css.replace(/\/\*[\s\S]*?\*\//g, "");

test("EVA Restrained remains a both-stance everyday EVA design", () => {
  const entry = themeById("eva-restrained");
  assert.equal(entry.id, "eva-restrained");
  assert.equal(entry.stance, "both");
  assert.equal(entry.accentPolicy, "customizable");
  assert.equal(resolveThemeMode(entry.id, "light", true), "light");
  assert.equal(resolveThemeMode(entry.id, "dark", false), "dark");
});

test("dedicated restrained EVA layer is loaded after manual production fixes", () => {
  const manualAt = themeJs.indexOf("MANUAL_UX_STYLESHEET");
  const restrainedAt = themeJs.indexOf("EVA_RESTRAINED_STYLESHEET");
  assert.ok(manualAt >= 0 && restrainedAt > manualAt);
  assert.match(themeJs, /themes\/eva-restrained\.css/);
  assert.match(themeJs, /link\.dataset\[EVA_RESTRAINED_MARKER\] = "true"/);
  assert.match(themeJs, /ensurePresentationStylesheet\(root\.ownerDocument \?\? null\);\s+ensureEvaRestrainedStylesheet\(root\.ownerDocument \?\? null\);/);
});

test("dark Restrained uses warm-black monitor surfaces and amber structure", () => {
  for (const signature of [
    "--aipm-bg: #090604",
    "--aipm-surface: #130d08",
    "--aipm-surface-cockpit: #1a0f08",
    "--eva-orange-strong: #f07a18",
    "--eva-amber: #e8a332",
    "--eva-yellow: #ffc04a",
    "linear-gradient(90deg, #cf431c 0%, var(--eva-orange-strong) 52%, var(--eva-yellow) 100%)",
    "repeating-linear-gradient("
  ]) assert.ok(css.includes(signature), `missing restrained EVA signature: ${signature}`);
});

test("Restrained carries EVA identity through components rather than hex decoration", () => {
  for (const selector of [
    ".run-card",
    ".target-card",
    ".progress-track",
    "button.primary",
    "button.danger",
    ".nav-links button.is-selected",
    ".diagnostics-safety",
    "input,select,textarea"
  ]) assert.ok(css.includes(selector), `missing component treatment: ${selector}`);

  assert.doesNotMatch(executableCss, /\.aipm-hex-tile|tone-red|tone-violet|tone-green/);
  assert.doesNotMatch(executableCss, /radar|gauge|robot|mascot/i);
});

test("status semantics remain distinct from the orange structural language", () => {
  assert.match(css, /--aipm-status-running:\s*#83c47a/);
  assert.match(css, /--aipm-status-paused:\s*#73a8d6/);
  assert.match(css, /--aipm-status-warning:\s*#efaa42/);
  assert.match(css, /--aipm-status-stop:\s*#ef6747/);
  assert.match(css, /--state-running-fg:\s*#8bd184/);
  assert.match(css, /--state-paused-fg:\s*#86b7e1/);
  assert.match(css, /--state-stopped-fg:\s*#ff8263/);
});

test("light stance is not the old generic beige theme", () => {
  assert.match(css, /data-aipm-mode="light"/);
  assert.match(css, /--aipm-bg:\s*#f1e5d5/);
  assert.match(css, /--aipm-border-strong:\s*#9b5825/);
  assert.match(css, /--state-needs-fg:\s*#9b570e/);
});

test("restrained EVA layer is presentation-only and non-animated", () => {
  for (const forbidden of [
    "chrome.", "sendMessage", "AIPM_START", "AIPM_STOP", "outbox",
    "executionSession", "conversationKey", "documentId", "runId", "lease"
  ]) assert.equal(executableCss.includes(forbidden), false, `CSS must not reference ${forbidden}`);

  assert.doesNotMatch(executableCss, /@keyframes|\banimation(?:-name)?:/);
  assert.doesNotMatch(executableCss, /position:\s*(?:fixed|sticky)\b/);
  assert.doesNotMatch(executableCss, /https?:\/\/|@font-face/);
});
