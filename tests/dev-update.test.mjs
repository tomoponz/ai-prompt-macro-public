import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function createReloadHarness(sendMessage) {
  let click;
  let reloads = 0;
  const requests = [];
  const message = { textContent: "" };
  const context = vm.createContext({
    document: {
      querySelector(selector) {
        if (selector === "#reloadExtension") return {
          addEventListener(type, handler) { assert.equal(type, "click"); click = handler; }
        };
        if (selector === "#reloadExtensionMessage") return message;
        return null;
      }
    },
    chrome: { runtime: {
      sendMessage(request) {
        requests.push(request.type);
        return sendMessage(request);
      },
      reload() { reloads += 1; }
    } }
  });
  vm.runInContext(read("src/dev-update.js"), context, { filename: "dev-update.js" });
  return { click: () => click(), requests, message, reloads: () => reloads };
}

function deferredResponse() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

for (const [label, response, expected] of [
  ["successful active run", { ok: true, active: true }, "active"],
  ["successful inactive state", { ok: true, active: false }, "reload"],
  ["Promise rejection", new Error("transport failed"), "unknown"],
  ["ok false", { ok: false, active: false }, "unknown"],
  ["undefined", undefined, "unknown"],
  ["empty object", {}, "unknown"],
  ["missing success", { active: false }, "unknown"],
  ["malformed success", { ok: "true", active: false }, "unknown"],
  ["missing active", { ok: true }, "unknown"],
  ...[null, "false", "true", 0, 1, {}, []].map((active) => [
    `malformed active ${JSON.stringify(active)}`, { ok: true, active }, "unknown"
  ])
]) {
  test(`production reload click handler: ${label}`, async () => {
    const harness = createReloadHarness(async () => {
      if (response instanceof Error) throw response;
      return response;
    });
    await harness.click();
    assert.deepEqual(harness.requests, ["AIPM_HAS_ACTIVE_RUNS"]);
    assert.equal(harness.reloads(), expected === "reload" ? 1 : 0);
    assert.match(harness.message.textContent, expected === "reload" ? /拡張を再読み込みします/ :
      expected === "active" ? /実行中または一時停止中/ : /実行状態を確認できない/);
  });
}

for (const active of [true, false]) {
  test(`production reload single-flight ignores duplicate clicks while active=${active} response is pending`, async () => {
    const response = deferredResponse();
    const harness = createReloadHarness(() => response.promise);
    const operationA = harness.click();
    const duplicateB = harness.click();
    const duplicateC = harness.click();
    const requestsBeforeResponse = harness.requests.length;
    assert.equal(harness.reloads(), 0, "no decision is made while A is pending");
    response.resolve({ ok: true, active });
    await Promise.all([operationA, duplicateB, duplicateC]);
    assert.equal(requestsBeforeResponse, 1, "B/C must not start another request before the first await settles");
    assert.equal(harness.requests.length, 1, "ignored duplicates must not be queued for later");
    assert.equal(harness.reloads(), active ? 0 : 1);
    assert.match(harness.message.textContent, active ? /実行中または一時停止中/ : /拡張を再読み込みします/);
  });
}

test("production reload clears in-flight after rejection and permits an explicit inactive retry", async () => {
  const firstResponse = deferredResponse();
  const nextResponse = deferredResponse();
  const harness = createReloadHarness(() => harness.requests.length === 1 ? firstResponse.promise : nextResponse.promise);
  const first = harness.click();
  firstResponse.reject(new Error("transport failed"));
  await first;
  assert.equal(harness.reloads(), 0);
  assert.match(harness.message.textContent, /実行状態を確認できない/);
  const retry = harness.click();
  const requestsDuringRetry = harness.requests.length;
  nextResponse.resolve({ ok: true, active: false });
  await retry;
  assert.equal(requestsDuringRetry, 2, "a failed check must not retain the in-flight flag");
  assert.equal(harness.reloads(), 1);
});

for (const [label, firstResponse] of [
  ["active refusal", { ok: true, active: true }],
  ["ok false", { ok: false }],
  ["undefined", undefined],
  ["malformed", { ok: true, active: "false" }]
]) {
  test(`production reload permits an explicit retry after ${label}`, async () => {
    const harness = createReloadHarness(async () => harness.requests.length === 1
      ? firstResponse : { ok: true, active: false });
    await harness.click();
    assert.equal(harness.reloads(), 0);
    await harness.click();
    assert.equal(harness.requests.length, 2);
    assert.equal(harness.reloads(), 1);
  });
}

test("PowerShell updater is fail-closed and fast-forward only", () => {
  const source = read("update-ai-prompt-macro.ps1");
  assert.match(source, /branch --show-current/);
  assert.match(source, /\$Branch -ne "main"/);
  assert.match(source, /status --porcelain/);
  assert.match(source, /pull --ff-only origin main/);
  assert.doesNotMatch(source, /reset --hard|clean -f|push --force|checkout -f/i);
});

test("PowerShell updater stays ASCII-only for Windows PowerShell 5.1", () => {
  const source = read("update-ai-prompt-macro.ps1");
  assert.equal(/[^\x00-\x7F]/.test(source), false);
});

test("double-click wrapper invokes the PowerShell updater", () => {
  const source = read("update-ai-prompt-macro.cmd");
  assert.match(source, /update-ai-prompt-macro\.ps1/);
  assert.match(source, /ExecutionPolicy Bypass/);
});

test("Side Panel exposes guarded development reload across all tab runs", () => {
  const html = read("src/sidepanel.html");
  const js = read("src/dev-update.js");
  assert.match(html, /id="reloadExtension"/);
  assert.match(html, /src="dev-update\.js"/);
  assert.match(js, /chrome\.runtime\.getManifest\(\)\.version/);
  assert.match(js, /AIPM_HAS_ACTIVE_RUNS/);
  assert.match(js, /response\?\.active === true/);
  assert.match(js, /chrome\.runtime\.reload\(\)/);
});

test("guarded reload safety copy explains the stop and next action without Run jargon", () => {
  const js = read("src/dev-update.js");
  assert.match(js, /実行状態を確認できないため、安全のため拡張を再読み込みしません。ChatGPTタブを確認してから、もう一度試してください。/);
  assert.match(js, /いずれかのChatGPTタブで自動化が実行中または一時停止中です。Side Panelで停止してから、拡張を再読み込みしてください。/);
  assert.doesNotMatch(js, /Run状態|一時停止中のRun/);
});

test("Side Panel routes messages through the background self-heal relay with explicit tab targeting", () => {
  const source = read("src/sidepanel.js");
  assert.match(source, /AIPM_RELAY_TO_CHATGPT/);
  assert.match(source, /targetTabId,\s*payload:\s*message/);
  assert.match(source, /const intentTabId = selectedTabId/);
  assert.match(source, /AIPM_LIST_CHATGPT_TABS/);
  assert.doesNotMatch(source, /async function getActiveTabId/);
});

test("development documentation describes the two-step browser refresh", () => {
  const docs = read("docs/DEVELOPMENT.md");
  assert.match(docs, /update-ai-prompt-macro\.cmd/);
  assert.match(docs, /拡張を再読み込み/);
  assert.match(docs, /Ctrl\+R/);
});
