import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const readSource = (path) => fs
  .readFileSync(new URL(path, import.meta.url), "utf8")
  .replace(/\r\n?/g, "\n");

const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const content = ["../src/content-core.js", "../src/content-runner.js", "../src/content-controller.js"]
  .map(readSource)
  .join("\n");
const allSource = [
  "../src/content-core.js",
  "../src/content-runner.js",
  "../src/content-controller.js",
  "../src/sidepanel.js",
  "../src/sidepanel-flow-view.js",
  "../src/sidepanel-start-source.js",
  "../src/editor-date-time.js",
  "../src/tab-alias.js",
  "../src/tab-alias-ui.js",
  "../src/target-display.js",
  "../src/ux-guidance.js",
  "../src/flow-authoring.js",
  "../src/flow-library.js",
  "../src/execution-plan.js",
  "../src/background.js",
  "../src/workflow.js",
  "../src/workflow-step-counts.js"
].map(readSource).join("\n");
const background = readSource("../src/background.js");

test("manifest keeps permissions narrow", () => {
  assert.deepEqual([...manifest.permissions].sort(), ["alarms", "power", "scripting", "sidePanel", "storage"].sort());
  assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*"]);
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://chatgpt.com/*"]);
});

test("host permissions stay restricted to ChatGPT", () => {
  assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*"]);
});

test("forbidden broad permissions are absent", () => {
  const manifestText = JSON.stringify(manifest);
  for (const forbidden of ["<all_urls>", "history", "cookies", "webRequest", "tabs", "unlimitedStorage"]) {
    assert.equal(manifestText.includes(`\"${forbidden}\"`), false, `${forbidden} must not be requested`);
  }
});

test("keep-awake uses system level so display sleep remains available", () => {
  assert.match(background, /chrome\.power\.requestKeepAwake\("system"\)/);
  assert.doesNotMatch(background, /requestKeepAwake\("display"\)/);
  assert.match(background, /chrome\.power\.releaseKeepAwake\(\)/);
});

test("multi-tab titles remain display-only and raw URLs remain excluded", () => {
  const sidepanel = readSource("../src/sidepanel.js");
  assert.doesNotMatch(sidepanel, /\.title\b/);
  assert.doesNotMatch(sidepanel, /\.url\b|pendingUrl/);
  assert.match(sidepanel, /targetTabId/);
  assert.match(background, /chrome\.tabs\.query\(\{\}\)/);
  assert.doesNotMatch(background, /chrome\.tabs\.query\(\{\s*url\s*:/);
  const itemStart = background.indexOf("function tabListItem(tab, status, fallback = {})");
  const itemEnd = background.indexOf("async function requestTabStatus", itemStart);
  const itemBody = background.slice(itemStart, itemEnd);
  assert.match(itemBody, /displayTitle: normalizeTargetTitle\(tab\.displayTitle\)/);
  assert.doesNotMatch(itemBody, /\burl\b|pendingUrl/);
  const statusBody = background.slice(background.indexOf("function boundedTabStatus"), itemStart);
  assert.doesNotMatch(statusBody, /title/i);
  assert.match(background, /const origin = new URL\(candidateUrl\)\.origin/);
  assert.match(background, /chatGptOriginHint = origin === CHATGPT_ORIGIN/);
});

test("content code contains no assistant-response selectors", () => {
  for (const forbidden of [
    "data-message-author-role='assistant'",
    'data-message-author-role="assistant"',
    "assistant-message",
    ".markdown",
    ".prose"
  ]) {
    assert.equal(content.includes(forbidden), false, `forbidden response selector: ${forbidden}`);
  }
});

test("composer text reads can only originate from provider-specific composer selectors", () => {
  const core = readSource("../src/content-core.js");
  const start = core.indexOf("  findComposer() {");
  const end = core.indexOf("\n  },\n\n  findSendButton()", start);
  assert.ok(start >= 0 && end > start, "findComposer body must be locatable");
  const composerBody = core.slice(start, end);

  assert.match(composerBody, /#prompt-textarea/);
  assert.match(composerBody, /data-testid='prompt-textarea'/);
  assert.match(composerBody, /textarea\[name='prompt-textarea'\]/);
  assert.doesNotMatch(composerBody, /form textarea/);
  assert.doesNotMatch(composerBody, /form \[contenteditable/);
  assert.doesNotMatch(composerBody, /form div\[contenteditable/);
});

test("send-button ARIA fallbacks are scoped to the actual composer form", () => {
  const core = readSource("../src/content-core.js");
  const start = core.indexOf("  findSendButton() {");
  const end = core.indexOf("\n  },\n\n  findStopButton()", start);
  assert.ok(start >= 0 && end > start, "findSendButton body must be locatable");
  const sendBody = core.slice(start, end);

  assert.match(sendBody, /button\[data-testid='send-button'\]/);
  assert.match(sendBody, /const composer = this\.findComposer\(\)/);
  assert.match(sendBody, /composer\?\.closest\?\.\("form"\)/);
  assert.match(sendBody, /\], composerForm\)/);
  assert.doesNotMatch(sendBody, /form button\[aria-label/);
});

test("blocker detection never reads generic text surfaces", () => {
  const core = readSource("../src/content-core.js");
  const start = core.indexOf("  detectBlocker() {");
  const end = core.indexOf("\n  }\n};", start);
  assert.ok(start >= 0 && end > start, "detectBlocker body must be locatable");
  const blockerBody = core.slice(start, end);

  assert.doesNotMatch(blockerBody, /\.textContent\b|\.innerText\b/);
  assert.doesNotMatch(blockerBody, /\[role=['"](?:alert|status)['"]\]/);
  assert.doesNotMatch(blockerBody, /data-testid\*=['"](?:toast|modal)['"]/);
  assert.doesNotMatch(core, /function classifyStatusText\s*\(/);
  assert.match(blockerBody, /iframe\[src\*='captcha'\]/);
  assert.match(blockerBody, /\[role='dialog'\]\[aria-modal='true'\]/);
  assert.match(blockerBody, /dialog\[open\]/);
  assert.match(blockerBody, /header a\[href\^='\/auth\/login'\]/);
});

test("extension code has no network interception or telemetry API", () => {
  for (const forbidden of ["XMLHttpRequest", "navigator.sendBeacon", "chrome.webRequest", "chrome.cookies", "fetch("]) {
    assert.equal(allSource.includes(forbidden), false, `forbidden API: ${forbidden}`);
  }
});

test("diagnostics allowlist excludes prompt and output bodies", () => {
  const match = content.match(/for \(const key of \[(.*?)\]\) \{/s);
  assert.ok(match, "diagnostic metadata allowlist must exist");
  const allowlist = match[1];
  assert.equal(allowlist.includes('"prompt"'), false);
  assert.equal(allowlist.includes('"output"'), false);
  assert.equal(allowlist.includes('"response"'), false);
});

/*
  The delivery acceptance watch runs on every body mutation between the click and the
  moment a generation control is seen. It is the one place in the runtime with a standing
  view of the whole document during a send, so its Output-Blind boundary is pinned here
  rather than left to the file-wide selector scan: it may look for a control, and nothing
  else. No text reads, no assistant scoping, no serialization of anything it observes.
*/
test("the delivery acceptance watch observes controls only, never content", () => {
  const core = readSource("../src/content-core.js");
  const start = core.indexOf("function startDeliveryAcceptanceWatch(transaction, findGenerationControl) {");
  const end = core.indexOf("function stopDeliveryAcceptanceWatch(transaction) {", start);
  assert.ok(start >= 0 && end > start, "acceptance watch body must be locatable");
  const watchBody = core.slice(start, end);

  assert.doesNotMatch(watchBody, /\.textContent\b|\.innerText\b|\.innerHTML\b|\.value\b/);
  assert.doesNotMatch(watchBody, /assistant|message|markdown|prose|conversation/i);
  // characterData would deliver the text of every streamed token to this callback.
  assert.doesNotMatch(watchBody, /characterData/);
  assert.match(watchBody, /childList: true/, "the watch must observe structure only");
  assert.match(watchBody, /MAX_DELIVERY_ACCEPTANCE_WATCH_CHECKS/, "the watch must stay bounded");

  // The generation control it looks for is the same allowlisted Stop control the adapter
  // already exposes; the watch itself must not carry selectors of its own.
  assert.doesNotMatch(watchBody, /querySelector|\[data-testid/);

  const adapterStart = core.indexOf("  startDeliveryAcceptanceWatch(transaction) {");
  const adapterEnd = core.indexOf("\n  },", adapterStart);
  assert.ok(adapterStart >= 0 && adapterEnd > adapterStart);
  assert.match(core.slice(adapterStart, adapterEnd), /this\.findStopButton\(\)/);
});
