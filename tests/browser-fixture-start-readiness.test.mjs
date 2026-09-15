import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// These tests check fixture wiring and helper control flow, not browser E2E.
// Extract the actual functions so a copied implementation cannot mask drift.
const source = readFileSync(new URL("./browser-fixture-e2e.mjs", import.meta.url), "utf8");
function section(start, end) {
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin + start.length);
  assert.ok(begin >= 0 && finish > begin, `Fixture section missing: ${start}`);
  assert.equal(source.indexOf(start, begin + start.length), -1, `Fixture section is ambiguous: ${start}`);
  return source.slice(begin, finish);
}
const startSource = section("async function startQuickRun(", "async function stopRunAndWaitForTerminal(");
const keySource = section("function fixtureConversationKey(", "async function confirmStartReadiness(");
const readinessSource = section("async function confirmStartReadiness(", "async function selectReadyTarget(");
const page = { url: () => "https://chatgpt.com/c/current-fixture" };
const tabId = 17;

function startWith(overrides = {}) {
  return vm.runInNewContext(`${startSource}; startQuickRun`, {
    configureQuickRun: async () => {},
    confirmStartReadiness: async () => {},
    clickStartOnly: async () => {},
    ...overrides
  });
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("short-reply fixture selects current readiness and rechecks it after Quick configuration", () => {
  const body = section('  if (runsScenarioGroup("short-reply-delivery")) {', '      await waitForSendCount(firstChat, 1);');
  assert.match(body, /await selectReadyTarget\(sidePanel, firstChat, firstTabId\);/);
  assert.match(body, /await startQuickRun\(sidePanel, \{ prompt: shortReplyPrompt, repeat: 20, delaySeconds: 0 \},\s*\{ page: firstChat, tabId: firstTabId \}\);/);
  assert.match(body, /await installSlowIdentityProbe\(worker, firstTabId, \{ probeDelayMs: 120 \}\);/);
  assert.ok(body.indexOf("selectReadyTarget(") < body.indexOf("installSlowIdentityProbe("));
  assert.ok(body.indexOf("installSlowIdentityProbe(") < body.indexOf("startQuickRun("));
});

test("navigation fixture proves its initial Start before testing the later conversation change", () => {
  const body = section('  await firstChat.goto("https://chatgpt.com/c/navigation-start");', '  await firstChat.evaluate(() => history.pushState({}, "", "/c/navigation-changed"));');
  assert.match(body, /await selectReadyTarget\(sidePanel, firstChat, firstTabId\);/);
  assert.match(body, /await startQuickRun\(sidePanel, \{ prompt: "Navigation must stop", repeat: 3, delaySeconds: 1 \},\s*\{ page: firstChat, tabId: firstTabId \}\);/);
  assert.match(body, /await waitForSendCount\(firstChat, 1\);/);
});

test("the real Quick helper orders configure -> exact-target readiness -> one click", async () => {
  const panel = {};
  const config = { prompt: "fixture", repeat: 20, delaySeconds: 0 };
  const events = [];
  const start = startWith({
    configureQuickRun: async (actualPanel, actualConfig) => {
      assert.equal(actualPanel, panel);
      assert.equal(actualConfig, config);
      events.push("configure");
    },
    confirmStartReadiness: async (actualPanel, actualPage, actualTab, phase) => {
      assert.equal(actualPanel, panel);
      assert.equal(actualPage, page);
      assert.equal(actualTab, tabId);
      assert.equal(phase, "before Start");
      events.push("readiness");
    },
    clickStartOnly: async () => { events.push("click"); }
  });
  await start(panel, config, { page, tabId });
  assert.deepEqual(events, ["configure", "readiness", "click"]);
});

test("pending current-target readiness cannot produce a premature Start click", async () => {
  const entered = deferred();
  const release = deferred();
  let clicks = 0;
  const start = startWith({
    confirmStartReadiness: async () => { entered.resolve(); await release.promise; },
    clickStartOnly: async () => { clicks += 1; }
  });
  const pending = start({}, {}, { page, tabId });
  await entered.promise;
  assert.equal(clicks, 0);
  release.resolve();
  await pending;
  assert.equal(clicks, 1);
});

for (const failedBoundary of ["configureQuickRun", "confirmStartReadiness"]) {
  test(`${failedBoundary} failure produces zero Start clicks and no retry`, async () => {
    let calls = 0;
    let clicks = 0;
    const failure = new Error("synthetic fixture readiness failure");
    const start = startWith({
      [failedBoundary]: async () => { calls += 1; throw failure; },
      clickStartOnly: async () => { clicks += 1; }
    });
    await assert.rejects(start({}, {}, { page, tabId }), (error) => error === failure);
    assert.equal(calls, 1);
    assert.equal(clicks, 0);
  });
}

test("omitting readyTarget preserves intentional New Chat and negative-scenario helper behavior", async () => {
  let checks = 0;
  let clicks = 0;
  const start = startWith({
    confirmStartReadiness: async () => { checks += 1; },
    clickStartOnly: async () => { clicks += 1; }
  });
  await start({}, {});
  assert.equal(checks, 0);
  assert.equal(clicks, 1);
});

function healthyObservation() {
  return {
    response: { ok: true }, extensionVersion: "0.4.0",
    target: { status: {
      pageReady: true, conversationKey: "chatgpt:c:current-fixture",
      contentVersion: "0.4.0", discoveryError: null
    } }
  };
}
function checkedStart(observations, { selected = String(tabId), enabled = true } = {}) {
  let reads = 0;
  let clicks = 0;
  // Only the retry scheduler is replaced: the actual assertion function is used.
  const eventually = async (_description, operation) => {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await operation(); } catch (error) { lastError = error; }
    }
    throw lastError;
  };
  const panel = {
    evaluate: async (_callback, actualTabId) => {
      assert.equal(actualTabId, tabId);
      return observations[Math.min(reads++, observations.length - 1)];
    },
    locator: (selector) => {
      if (selector === "#targetTab") return { inputValue: async () => selected };
      assert.equal(selector, "#start");
      return { isEnabled: async () => enabled };
    }
  };
  const readiness = vm.runInNewContext(`${keySource}\n${readinessSource}; confirmStartReadiness`, {
    assert, URL, eventually
  });
  const start = startWith({
    confirmStartReadiness: readiness,
    clickStartOnly: async () => { clicks += 1; }
  });
  return { run: () => start(panel, {}, { page, tabId }), counts: () => ({ reads, clicks }) };
}

const invalidStates = {
  "not ready": (value) => { value.target.status.pageReady = false; },
  "old conversation with an enabled Start button": (value) => { value.target.status.conversationKey = "chatgpt:c:old-fixture"; },
  "content version mismatch": (value) => { value.target.status.contentVersion = "old"; },
  "discovery error": (value) => { value.target.status.discoveryError = "TAB_STATUS_TIMEOUT"; },
  "failed response": (value) => { value.response.ok = false; },
  "missing target": (value) => { value.target = null; }
};
for (const [name, mutate] of Object.entries(invalidStates)) {
  test(`current-target readiness rejects ${name} without clicking Start`, async () => {
    const value = healthyObservation();
    mutate(value);
    const harness = checkedStart([value]);
    await assert.rejects(harness.run());
    assert.deepEqual(harness.counts(), { reads: 3, clicks: 0 });
  });
}

test("a stale observation can recover through reads alone, followed by exactly one Start click", async () => {
  const stale = healthyObservation();
  stale.target.status.conversationKey = "chatgpt:c:old-fixture";
  const harness = checkedStart([stale, healthyObservation()]);
  await harness.run();
  assert.deepEqual(harness.counts(), { reads: 2, clicks: 1 });
});

test("fresh discovery cannot override a different selected tab", async () => {
  const harness = checkedStart([healthyObservation()], { selected: "18" });
  await assert.rejects(harness.run());
  assert.deepEqual(harness.counts(), { reads: 1, clicks: 0 });
});

test("fresh discovery cannot override a disabled Start button", async () => {
  const harness = checkedStart([healthyObservation()], { enabled: false });
  await assert.rejects(harness.run());
  assert.deepEqual(harness.counts(), { reads: 1, clicks: 0 });
});
