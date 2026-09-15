import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/background.js", import.meta.url), "utf8");

test("tab discovery does not depend on URL-filtered tabs.query", () => {
  assert.match(source, /chrome\.tabs\.query\(\{\}\)/);
  assert.doesNotMatch(source, /chrome\.tabs\.query\(\{\s*url\s*:/);
});

test("tab discovery bounds receiver status and reduces URL access to an exact-origin boolean", () => {
  assert.match(source, /requestTabStatus\(tab\.id\)/);
  assert.match(source, /contentVersion:/);
  assert.match(source, /displayTitle = normalizeTargetTitle\(tab\.title\)/);
  assert.match(source, /const origin = new URL\(candidateUrl\)\.origin/);
  assert.match(source, /chatGptOriginHint = origin === CHATGPT_ORIGIN/);
  assert.match(source, /chatGptOriginHint/);
});

test("tab discovery self-heals only after a read-only ChatGPT origin probe", () => {
  const injectionStart = source.indexOf("async function injectContentScript(tabId");
  const injectionEnd = source.indexOf("async function resolveRelayTab", injectionStart);
  assert.ok(injectionStart >= 0 && injectionEnd > injectionStart);
  const body = source.slice(injectionStart, injectionEnd);
  const probeIndex = body.indexOf("inspectContentScript(tabId, { freshAuthority })");
  const originGuardIndex = body.indexOf("probe.origin && probe.origin !== CHATGPT_ORIGIN");
  const injectIndex = body.indexOf("files: [\"src/content-core.js\"");
  assert.ok(probeIndex >= 0);
  assert.ok(originGuardIndex > probeIndex);
  assert.ok(injectIndex > originGuardIndex);
});

test("tab enumeration failures are not converted into an empty array", () => {
  const queryStart = source.indexOf("async function getOpenBrowserTabs()");
  const queryEnd = source.indexOf("async function getOpenTabRuns", queryStart);
  assert.ok(queryStart >= 0 && queryEnd > queryStart);
  const body = source.slice(queryStart, queryEnd);
  assert.match(body, /\(\) => chrome\.tabs\.query\(\{\}\)/);
  assert.match(body, /TAB_ENUMERATION_TIMEOUT/);
  assert.doesNotMatch(body, /return\s+\[\]/);
});
