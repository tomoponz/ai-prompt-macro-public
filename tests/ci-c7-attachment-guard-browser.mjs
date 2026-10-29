// Exact C7 fixture DOM + production core/runner, with synthetic persistence and
// leases. No extension, service worker, account, or external request. This isolates
// the attachment guard after Run creation; it does not diagnose CI Start readiness.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { chromium } from "playwright-core";

const fixtureSource = fs.readFileSync(new URL("./browser-fixture-e2e.mjs", import.meta.url), "utf8");
const begin = fixtureSource.indexOf("function fixtureHtml() {");
const end = fixtureSource.indexOf("async function eventually(", begin);
assert.ok(begin >= 0 && end > begin, "The exact browser fixture function must be available");
const html = vm.runInNewContext(`${fixtureSource.slice(begin, end)}; fixtureHtml()`, {
  FIXTURE_SECRET: "SYNTHETIC C7 OUTPUT MUST STAY BLIND"
});
const core = fs.readFileSync(new URL("../src/content-core.js", import.meta.url), "utf8");
const runner = fs.readFileSync(new URL("../src/content-runner.js", import.meta.url), "utf8");
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.route("**/*", route => route.abort());
  await context.route("https://apm-fixture.test/c/c7-existing-attachment", route => route.fulfill({
    status: 200, contentType: "text/html", body: html
  }));
  const page = await context.newPage();
  await page.goto("https://apm-fixture.test/c/c7-existing-attachment");
  await page.evaluate(() => {
    sessionStorage.removeItem("aipm.fixture.sends");
    __AIPM_FIXTURE_ADD_ATTACHMENT__();
  });
  await page.addScriptTag({ content: core });
  await page.addScriptTag({ content: runner });
  const result = await page.evaluate(async () => {
    const composer = ChatGptAdapter.findComposer();
    const attachment = document.querySelector("[data-testid='file-thumbnail']");
    const remove = attachment.querySelector("button[aria-label='Remove file']");
    const attachmentMarkup = attachment.outerHTML;
    const initialKnown = getScopedComposerAttachmentState(composer).known;
    let writes = 0;
    let inputEvents = 0;
    let pasteEvents = 0;
    let sendClicks = 0;
    let removeClicks = 0;
    let activeRun = null;
    const saves = [];
    const nativeWrite = ChatGptAdapter.writePrompt;
    ChatGptAdapter.writePrompt = function(...args) {
      writes += 1;
      return nativeWrite.apply(this, args);
    };
    composer.addEventListener("input", () => { inputEvents += 1; });
    composer.addEventListener("paste", () => { pasteEvents += 1; });
    document.querySelector("[data-testid='send-button']").addEventListener("click", () => { sendClicks += 1; });
    remove.addEventListener("click", () => { removeClicks += 1; });

    // Model only durable storage and lease transport. No adapter/guard override.
    saveActiveRun = async run => {
      activeRun = structuredClone(run);
      saves.push({ runId: run.runId, status: run.status, reason: run.lastErrorCode ?? null });
    };
    getActiveRun = async () => structuredClone(activeRun);
    acquireLease = async (conversationKey, runId, executionSessionId) => ({
      conversationKey, runId, executionSessionId, nonce: "synthetic-c7-lease"
    });
    renewLease = async () => true;
    releaseLease = async () => {};
    appendDiagnostic = async () => {};
    READY_STABLE_MS = 20;
    POLL_MS = 15;
    const results = [];
    for (const runId of ["synthetic-c7-initial", "synthetic-c7-residual"]) {
      const workflow = normalizeWorkflow({
        schemaVersion: 1, id: "synthetic-c7-guard", maxSends: 1,
        steps: [{ id: "send", type: "prompt", delivery: "send", prompt: "SYNTHETIC C7 INPUT", repeat: 1, delayAfterMs: 0 }]
      });
      const run = {
        runId, replacesRunId: activeRun?.runId ?? null, provider: "chatgpt",
        conversationKey: ChatGptAdapter.getConversationKey(), documentInstanceId: instanceId,
        executionSessionId: "synthetic-c7-session", contentVersion: __AIPM_CONTENT_CORE__.version,
        stateRevision: 1, status: "running", phase: "ready", resumable: true, workflow,
        cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 }, outbox: null, waitState: null
      };
      await saveActiveRun(run);
      localRunnerToken += 1;
      await executeRun(run, localRunnerToken);
      results.push({ runId: activeRun.runId, status: activeRun.status,
        reason: activeRun.lastErrorCode, resumable: activeRun.resumable,
        outbox: activeRun.outbox, sendsCompleted: activeRun.cursor.sendsCompleted,
        attachmentCount: __AIPM_FIXTURE_ATTACHMENT_COUNT__(),
        sameAttachment: attachment === document.querySelector("[data-testid='file-thumbnail']"),
        sameRemove: remove === attachment.querySelector("button[aria-label='Remove file']"),
        attachmentUnchanged: attachment.outerHTML === attachmentMarkup });
      if (runId === "synthetic-c7-initial") {
        // Explicit synthetic Stop between the two Runs. Controller/background
        // Stop authority is outside this isolated guard test's claim.
        localRunnerToken += 1;
        await saveActiveRun({ ...activeRun, status: "stopped", phase: "stopped", pauseReason: "user-stop" });
      }
    }
    return { results, saves, initialKnown, writes, inputEvents, pasteEvents, sendClicks, removeClicks,
      fixtureSendCount: JSON.parse(sessionStorage.getItem("aipm.fixture.sends") || "[]").length,
      composerEmpty: composerIsEffectivelyEmpty(ChatGptAdapter.getComposerText(composer)) };
  });
  assert.equal(result.initialKnown, true);
  assert.equal(result.results.length, 2);
  assert.notEqual(result.results[0].runId, result.results[1].runId);
  for (const run of result.results) {
    assert.equal(run.status, "paused");
    assert.equal(run.reason, "unexpected_attachment");
    assert.equal(run.resumable, false);
    assert.equal(run.outbox, null);
    assert.equal(run.sendsCompleted, 0);
    assert.equal(run.attachmentCount, 1);
    assert.equal(run.sameAttachment, true);
    assert.equal(run.sameRemove, true);
    assert.equal(run.attachmentUnchanged, true);
  }
  assert.deepEqual(result.saves.map(save => save.status), ["running", "paused", "stopped", "running", "paused"]);
  for (const count of ["writes", "inputEvents", "pasteEvents", "sendClicks", "removeClicks", "fixtureSendCount"]) {
    assert.equal(result[count], 0, `${count} must stay zero for both blocked Runs`);
  }
  assert.equal(result.composerEmpty, true);
  console.log("PASS exact C7 initial + residual attachment: 2 distinct paused Runs, zero writes/clicks, original attachment untouched");
  await context.close();
} finally {
  await browser.close();
}
