// Offline synthetic DOM only: no extension, account, provider page or network.
// Optional runner path permits red/green verification against a pinned Git blob.
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";

const core = fs.readFileSync(new URL("../src/content-core.js", import.meta.url), "utf8");
const runner = fs.readFileSync(process.argv[2] ?? new URL("../src/content-runner.js", import.meta.url), "utf8");
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.route("**/*", route => route.abort());
  await context.route("https://apm-fixture.test/c/repeat-readiness", route => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><title>Offline repeat readiness fixture</title>"
  }));
  const page = await context.newPage();
  await page.goto("https://apm-fixture.test/c/repeat-readiness");
  for (const readiness of ["disabled", "aria-disabled", "absent"]) {
    await page.setContent(`<!doctype html><form data-chatgpt-composer>
      <textarea id="prompt-textarea"></textarea>
      <button id="send" type="button" data-testid="send-button">Send</button>
    </form>`);
    await page.addScriptTag({ content: core });
    await page.addScriptTag({ content: runner });
    const result = await page.evaluate(async readiness => {
      const composer = document.getElementById("prompt-textarea");
      const form = composer.closest("form");
      const send = document.getElementById("send");
      const clicks = [];
      const diagnostics = [];
      let writes = 0;
      let availableAt = 0;
      let activeRun = null;

      composer.addEventListener("input", () => {
        writes += 1;
        if (writes !== 2) return;
        // Longer than the production text-stability window, within its unchanged deadline.
        availableAt = Date.now() + 900;
        if (readiness === "disabled") send.disabled = true;
        if (readiness === "aria-disabled") send.setAttribute("aria-disabled", "true");
        if (readiness === "absent") send.remove();
        setTimeout(() => {
          send.disabled = false;
          send.removeAttribute("aria-disabled");
          if (!send.isConnected) form.append(send);
        }, 900);
      });
      send.addEventListener("click", () => {
        clicks.push({ position: activeRun.cursor.repeatIndex, at: Date.now() });
        composer.value = "";
        send.dataset.testid = "stop-button";
        setTimeout(() => { send.dataset.testid = "send-button"; }, 30);
      });

      // Replace only the extension control plane. The DOM adapter, transaction,
      // mutation observers, send boundary and repeat loop are production code.
      saveActiveRun = async run => { activeRun = structuredClone(run); };
      getActiveRun = async () => structuredClone(activeRun);
      acquireLease = async (conversationKey, runId, executionSessionId) => ({
        conversationKey, runId, executionSessionId, nonce: "fixture-lease"
      });
      renewLease = async () => true;
      releaseLease = async () => {};
      appendDiagnostic = async (type, meta) => { diagnostics.push({ type, meta }); };
      localRunnerToken += 1;
      // Keep the relevant production text-stability threshold (650ms).
      // Shorten only unrelated post-generation stability/polling for test speed.
      READY_STABLE_MS = 20;
      POLL_MS = 15;
      const workflow = normalizeWorkflow({
        schemaVersion: 1, id: "offline-repeat-readiness", maxSends: 3,
        steps: [{ id: "repeat", type: "prompt", delivery: "send", prompt: "SYNTHETIC", repeat: 3, delayAfterMs: 0 }]
      });
      const run = {
        runId: "offline-repeat-run", provider: "chatgpt",
        conversationKey: ChatGptAdapter.getConversationKey(),
        executionSessionId: "offline-session", contentVersion: __AIPM_CONTENT_CORE__.version, stateRevision: 1,
        status: "running", phase: "ready", resumable: true, workflow,
        cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 }, outbox: null, waitState: null
      };
      await saveActiveRun(run);
      await executeRun(run, localRunnerToken);
      return {
        status: run.status, reason: run.lastErrorCode ?? null,
        sendsCompleted: run.cursor.sendsCompleted, writes, clicks, availableAt,
        diagnosticTypes: diagnostics.map(entry => entry.type)
      };
    }, readiness);
    assert.equal(result.status, "completed", `${readiness}: ${JSON.stringify(result)}`);
    assert.equal(result.reason, null);
    assert.equal(result.sendsCompleted, 3);
    assert.equal(result.writes, 3, "never rewrite or retry the current attempt");
    assert.deepEqual(result.clicks.map(click => click.position), [0, 1, 2]);
    assert.ok(result.clicks[1].at >= result.availableAt, "second click must wait for actionability");
    console.log(`PASS ${readiness}: 3 repeats, 3 writes, 3 unique clicks`);
  }
  await context.close();
} finally {
  await browser.close();
}
