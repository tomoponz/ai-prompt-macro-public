// Offline headless DOM fixture: production core + runner, with an in-memory
// extension control plane. No extension, account, provider request, or profile.
// This tests observable provenance and the current one-shot policy; it does not
// replace background/controller authority or cross-context race integration tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";

const core = fs.readFileSync(new URL("../src/content-core.js", import.meta.url), "utf8");
const runner = fs.readFileSync(new URL("../src/content-runner.js", import.meta.url), "utf8");
const origin = "https://apm-fixture.test";
const html = `<!doctype html><title>Offline New Chat provenance fixture</title>
  <form data-chatgpt-composer><textarea id="prompt-textarea"></textarea>
    <button type="button" data-testid="send-button">Send</button></form>
  <article data-message-author-role="assistant">SYNTHETIC OUTPUT MUST NOT BE READ</article>`;
const cases = [
  ...[false, true].flatMap(project => ["send-created-route", "previously-queued-route-switch"]
    .map(cause => ({ project, cause, change: "none" }))),
  ...["composer-replaced", "surface-replaced", "pause-request", "stop"]
    .map(change => ({ project: false, cause: "send-created-route", change }))
];
const signatures = new Map();
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.route("**/*", route => route.abort());
  await context.route(`${origin}/**`, route => route.fulfill({
    status: 200, contentType: "text/html", body: html
  }));
  for (const fixtureCase of cases) {
    const page = await context.newPage();
    await page.goto(origin + (fixtureCase.project ? "/g/g-p-provenance/project" : "/"));
    await page.addScriptTag({ content: core });
    await page.addScriptTag({ content: runner });
    const result = await page.evaluate(async ({ cause, change }) => {
      const originalComposer = ChatGptAdapter.findComposer();
      const originalSurface = originalComposer.closest("form");
      const originalInstance = instanceId;
      const originalKey = ChatGptAdapter.getConversationKey();
      const send = originalSurface.querySelector("[data-testid='send-button']");
      const assistant = document.querySelector("[data-message-author-role='assistant']");
      let outputReads = 0;
      for (const property of ["textContent", "innerText", "innerHTML"]) {
        Object.defineProperty(assistant, property, { get() {
          outputReads += 1;
          throw new Error("Assistant output is outside this fixture's observation contract");
        } });
      }
      const events = [];
      let userInput = 0;
      navigation.addEventListener("navigate", event => events.push({
        type: event.navigationType, userInitiated: event.userInitiated,
        sameDocument: event.destination.sameDocument, sourceElement: Boolean(event.sourceElement)
      }));
      for (const type of ["pointerdown", "keydown", "popstate", "pagehide"]) {
        addEventListener(type, event => { if (event.isTrusted) userInput += 1; }, true);
      }
      let activeRun = null;
      let clicks = 0;
      let writes = 0;
      let delivery = null;
      let ackBeforeFinish = null;
      const messages = [];
      const acquiredKeys = [];
      const nativeWatch = ChatGptAdapter.startDeliveryAcceptanceWatch;
      ChatGptAdapter.startDeliveryAcceptanceWatch = function(transaction) {
        delivery = transaction;
        return nativeWatch.call(this, transaction);
      };
      const nativeFinish = ChatGptAdapter.finishPromptDelivery;
      ChatGptAdapter.finishPromptDelivery = function(transaction) {
        ackBeforeFinish = this.getPromptDeliveryAckState(transaction, transaction.binding, "text");
        return nativeFinish.call(this, transaction);
      };
      originalComposer.addEventListener("input", () => { writes += 1; });

      const move = () => history.replaceState({}, "", "/c/provenance-target");
      let deliverQueuedRoute;
      if (cause === "previously-queued-route-switch") {
        // An unrelated route action is already pending before this Run. The
        // fixture gate aligns its completion after Send without new user input.
        const queued = new Promise(resolve => { deliverQueuedRoute = resolve; });
        void queued.then(move);
      }
      send.addEventListener("click", () => {
        clicks += 1;
        originalComposer.value = "";
        send.dataset.testid = "stop-button";
        if (change === "composer-replaced") originalComposer.replaceWith(originalComposer.cloneNode());
        if (change === "surface-replaced") originalSurface.replaceWith(originalSurface.cloneNode(true));
        if (change === "pause-request") activeRun.pauseRequested = true;
        if (change === "stop") {
          localRunnerToken += 1;
          activeRun.status = "stopped";
          activeRun.phase = "stopped";
          activeRun.pauseReason = "user-stop";
        }
        // Use the same scheduling boundary for both causes, so event-loop timing
        // is not an accidental substitute for a dispatch-to-destination proof.
        if (cause === "send-created-route") queueMicrotask(move);
        else deliverQueuedRoute();
        setTimeout(() => {
          const control = document.querySelector("[data-testid='stop-button']");
          if (control) control.dataset.testid = "send-button";
        }, 30);
      });

      // The extension control plane, including Pause/Stop, is emulated. Real
      // adapter transactions, DOM observation, final click guards, and the repeat
      // loop remain in use. This does not test background/controller races.
      saveActiveRun = async run => {
        if (activeRun?.status === "stopped" && run.status !== "stopped") {
          throw Object.assign(new Error("Synthetic terminal Run guard"), { code: "run_state_conflict" });
        }
        activeRun = structuredClone(run);
      };
      getActiveRun = async () => structuredClone(activeRun);
      acquireLease = async (conversationKey, runId, executionSessionId) => {
        acquiredKeys.push(conversationKey);
        return { conversationKey, runId, executionSessionId, nonce: "synthetic-lease" };
      };
      renewLease = async () => true;
      releaseLease = async () => {};
      appendDiagnostic = async () => {};
      globalThis.chrome = { runtime: { async sendMessage(message) {
        messages.push(message.type);
        if (message.type === "AIPM_RUN_NEW_CHAT_CONFIRM_REQUIRED") {
          const safe = activeRun?.runId === message.expectedRunId && activeRun.status === "running" &&
            activeRun.conversationKey.startsWith("chatgpt:new:") && activeRun.phase === "submitting" &&
            activeRun.outbox?.state === "prepared";
          if (!safe) return { ok: false, error: "Synthetic confirmation checkpoint rejected" };
          activeRun = { ...activeRun, status: "paused", phase: "new-chat-confirmation-required",
            pauseReason: "new-chat-confirmation-required", resumable: false,
            outbox: { ...activeRun.outbox, state: "submitted", submittedAt: new Date().toISOString() },
            stateRevision: activeRun.stateRevision + 1 };
          return { ok: true, run: structuredClone(activeRun) };
        }
        if (message.type === "AIPM_RUN_FAIL_CLOSED") return { ok: true, run: structuredClone(activeRun) };
        throw new Error(`Unexpected fixture control message: ${message.type}`);
      } } };
      localRunnerToken += 1;
      READY_STABLE_MS = 20;
      POLL_MS = 15;
      const workflow = normalizeWorkflow({
        schemaVersion: 1, id: "new-chat-provenance", maxSends: 3,
        steps: [{ id: "send", type: "prompt", delivery: "send", prompt: "SYNTHETIC INPUT", repeat: 3, delayAfterMs: 0 }]
      });
      const run = {
        runId: "synthetic-run", provider: "chatgpt", conversationKey: originalKey,
        executionSessionId: "synthetic-session", contentVersion: __AIPM_CONTENT_CORE__.version,
        stateRevision: 1, status: "running", phase: "ready", resumable: true, workflow,
        cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 }, outbox: null, waitState: null
      };
      await saveActiveRun(run);
      await executeRun(run, localRunnerToken);
      await new Promise(resolve => setTimeout(resolve, 100));
      return {
        signals: {
          generationSeen: delivery?.generationSeen === true,
          sameInstance: originalInstance === instanceId,
          sameComposer: originalComposer === ChatGptAdapter.findComposer(),
          sameSurface: originalSurface === ChatGptAdapter.findComposer()?.closest("form"),
          composerClear: composerIsEffectivelyEmpty(ChatGptAdapter.getComposerText(originalComposer)),
          key: ChatGptAdapter.getConversationKey(), events, userInput, ackBeforeFinish
        },
        clicks, writes, outputReads, status: activeRun.status, reason: activeRun.pauseReason,
        outboxState: activeRun.outbox?.state, sendsCompleted: activeRun.cursor.sendsCompleted,
        originalKeyRetained: activeRun.conversationKey === originalKey,
        canonicalLeaseAcquisitions: acquiredKeys.filter(key => key.startsWith("chatgpt:c:")).length,
        confirmationRequests: messages.filter(type => type === "AIPM_RUN_NEW_CHAT_CONFIRM_REQUIRED").length,
        targetAdoptions: messages.filter(type => type === "AIPM_RUN_CONFIRM_NEW_CHAT_TARGET").length
      };
    }, fixtureCase);
    const label = `${fixtureCase.project ? "project" : "root"}/${fixtureCase.cause}/${fixtureCase.change}`;
    assert.equal(result.clicks, 1, label);
    assert.equal(result.writes, 1, label);
    assert.equal(result.sendsCompleted, 0, label);
    assert.equal(result.originalKeyRetained, true, label);
    assert.equal(result.canonicalLeaseAcquisitions, 0, label);
    assert.equal(result.confirmationRequests, 1, label);
    assert.equal(result.targetAdoptions, 0, label);
    assert.equal(result.outputReads, 0, label);
    assert.equal(result.signals.generationSeen, true, label);
    assert.equal(result.signals.sameInstance, true, label);
    assert.equal(result.signals.composerClear, true, label);
    assert.equal(result.signals.key, "chatgpt:c:provenance-target", label);
    assert.equal(result.signals.userInput, 0, label);
    assert.deepEqual(result.signals.events,
      [{ type: "replace", userInitiated: false, sameDocument: true, sourceElement: false }], label);
    if (fixtureCase.change === "stop") {
      assert.equal(result.status, "stopped", label);
      assert.equal(result.reason, "user-stop", label);
      assert.equal(result.outboxState, "prepared", label);
    } else {
      assert.equal(result.status, "paused", label);
      assert.equal(result.reason, "new-chat-confirmation-required", label);
      assert.equal(result.outboxState, "submitted", label);
    }
    const replaced = fixtureCase.change.endsWith("replaced");
    assert.equal(result.signals.sameComposer, !replaced, label);
    assert.equal(result.signals.sameSurface, fixtureCase.change !== "surface-replaced", label);
    assert.deepEqual(result.signals.ackBeforeFinish,
      { known: !replaced, cleared: !replaced }, label);
    if (fixtureCase.change === "none") {
      const pair = String(fixtureCase.project);
      if (signatures.has(pair)) assert.deepEqual(result.signals, signatures.get(pair),
        "A queued unrelated route must not be distinguished by these identical observations");
      else signatures.set(pair, result.signals);
    }
    console.log(`PASS ${label}: one click, no automatic adoption, no guarded assistant-property reads`);
    await page.close();
  }
  console.log(`New Chat provenance PASS: ${cases.length} cases; root/project route causes have identical observed metadata`);
  await context.close();
} finally {
  await browser.close();
}
