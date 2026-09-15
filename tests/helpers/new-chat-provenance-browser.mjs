import assert from "node:assert/strict";

// A negative evidence fixture, not an auto-adoption implementation. It exercises
// the installed production runner/core in an isolated, network-intercepted page.
export async function verifyNewChatProvenanceBoundary({ chat, worker, tabId, start, waitForSend, readRun, stop }) {
  const signatures = [];
  for (const project of [false, true]) {
    for (const cause of ["send-created-route", "previously-queued-route-switch"]) {
      await chat.goto(project ? "https://chatgpt.com/g/g-p-provenance/project" : "https://chatgpt.com/");
      await chat.evaluate(({ project, cause }) => {
        sessionStorage.removeItem("aipm.fixture.sends");
        const events = [];
        window.__provenanceEvents = events;
        navigation.addEventListener("navigate", event => events.push({
          type: event.navigationType, userInitiated: event.userInitiated,
          sameDocument: event.destination.sameDocument, sourceElement: Boolean(event.sourceElement)
        }));
        window.__provenanceUserInput = 0;
        for (const name of ["pointerdown", "keydown", "popstate", "pagehide"]) {
          addEventListener(name, event => { if (event.isTrusted) window.__provenanceUserInput += 1; }, true);
        }
        const replace = history.replaceState.bind(history);
        const destination = "/c/provenance-target";
        const send = document.querySelector("[data-testid='send-button']");
        if (cause === "send-created-route") {
          if (project) send.addEventListener("click", () => replace({}, "", destination));
          else history.replaceState = (state, unused) => replace(state, unused, destination);
        } else {
          // A route action queued before the Run can execute after the first Send.
          // It produces no new trusted input inside the proposed handoff window.
          // Suppress the normal route and deliver the queued SPA switch instead.
          history.replaceState = () => {};
          const queuedRoute = new Promise(resolve => send.addEventListener("click", resolve, { once: true }));
          void queuedRoute.then(() => replace({}, "", destination));
        }
      }, { project, cause });
      await worker.evaluate(async (id) => {
        await chrome.scripting.executeScript({ target: { tabId: id }, func: () => {
          const observation = { transaction: { active: true }, instance: instanceId, composer: ChatGptAdapter.findComposer() };
          globalThis.__aipmProvenanceTest = observation;
          startDeliveryAcceptanceWatch(observation.transaction, () => ChatGptAdapter.findStopButton());
        } });
      }, tabId);
      await start();
      await waitForSend();
      // A stable route plus the latched short generation and cleared original
      // composer is deliberately provided to both cases.
      await chat.waitForTimeout(300);
      const [observation] = await worker.evaluate(async (id) => chrome.scripting.executeScript({
        target: { tabId: id }, func: () => {
          const o = globalThis.__aipmProvenanceTest;
          const result = { generationSeen: o.transaction.generationSeen === true,
            sameInstance: o.instance === instanceId,
            sameComposer: o.composer === ChatGptAdapter.findComposer(),
            composerClear: composerIsEffectivelyEmpty(ChatGptAdapter.getComposerText(o.composer)),
            key: ChatGptAdapter.getConversationKey() };
          stopDeliveryAcceptanceWatch(o.transaction);
          delete globalThis.__aipmProvenanceTest;
          return result;
        }
      }), tabId);
      const signals = await chat.evaluate(() => ({ events: window.__provenanceEvents, userInput: window.__provenanceUserInput }));
      assert.deepEqual(observation.result, { generationSeen: true, sameInstance: true, sameComposer: true,
        composerClear: true, key: "chatgpt:c:provenance-target" });
      assert.deepEqual(signals, { events: [{ type: "replace", userInitiated: false, sameDocument: true, sourceElement: false }], userInput: 0 });
      signatures.push({ project, cause, ...observation.result, ...signals });
      const run = await readRun();
      assert.equal(run.pauseReason, "new-chat-confirmation-required");
      assert.equal(run.outbox.state, "submitted");
      assert.equal(run.cursor.sendsCompleted, 0, "uncertain first delivery is not credited automatically");
      assert.match(run.conversationKey, /^chatgpt:new:/);
      assert.equal(await chat.evaluate(() => JSON.parse(sessionStorage.getItem("aipm.fixture.sends")).length), 1);
      await stop(run);
    }
  }
  console.log(`New Chat provenance boundary PASS: ${signatures.length} root/project traces; indistinguishable signals, no auto-adoption or second Send`);
}
