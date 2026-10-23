// Offline synthetic DOM only: no extension, account, provider page or network.
// Exercises the production ownership adapter. The contenteditable fixture models
// ProseMirror's handled paste contract; it does not claim to run ProseMirror itself.
// An optional core path supports red/green checks against a preserved baseline.
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";

const core = fs.readFileSync(process.argv[2] ?? new URL("../src/content-core.js", import.meta.url), "utf8");
const browser = await chromium.launch({ headless: true });
let passed = 0;
try {
  const context = await browser.newContext();
  await context.route("**/*", route => route.abort());
  await context.route("https://apm-fixture.test/c/**", route => route.fulfill({
    status: 200, contentType: "text/html", body: "<!doctype html><title>Offline owned draft fixture</title>"
  }));

  async function fixture(kind, title, check) {
    const page = await context.newPage();
    try {
      await page.goto("https://apm-fixture.test/c/owned-draft");
      await page.setContent(`<!doctype html><form data-chatgpt-composer>
        ${kind === "textarea" ? '<textarea id="prompt-textarea"></textarea>' :
          '<div id="prompt-textarea" class="ProseMirror" data-composer-markdown role="textbox" contenteditable="true"><p><br></p></div>'}
        <button id="send" type="button" data-testid="send-button">Send</button>
      </form>`);
      await page.addScriptTag({ content: core });
      const capabilities = await page.evaluate(kind => {
        const required = ["capturePausedPromptText", "inspectPausedPromptText", "adoptPausedPromptText", "disposePausedPromptText"];
        const missing = required.filter(name => typeof ChatGptAdapter[name] !== "function");
        if (missing.length) return { missing };
        const composer = document.getElementById("prompt-textarea");
        const events = [];
        const state = globalThis.fixture = {
          kind, composer, events, clicks: 0, writes: 0,
          prompt: "SYNTHETIC OWNED DRAFT", tx: null, receipt: null, adopted: null
        };
        for (const type of ["focus", "input", "change", "paste"]) {
          document.addEventListener(type, event => {
            if (event.target === composer) events.push({ type, trusted: event.isTrusted });
          }, true);
        }
        if (kind === "textarea") composer.addEventListener("input", () => { state.writes += 1; });
        else composer.addEventListener("paste", event => {
          // A synthetic editor consumes the production clipboard payload exactly once.
          event.preventDefault();
          const template = document.createElement("template");
          template.innerHTML = event.clipboardData.getData("text/html");
          composer.replaceChildren(...template.content.childNodes);
          state.writes += 1;
        });
        document.getElementById("send").addEventListener("click", () => { state.clicks += 1; });
        state.binding = Object.freeze({
          deliveryAttemptToken: "owned-attempt-1", runId: "owned-run", executionSessionId: "owned-session",
          stateRevision: 1, stepId: "owned-step", stepIndex: 0, repeatIndex: 0, sendsCompleted: 0,
          promptHash: "synthetic-owned-hash", documentInstanceId: instanceId,
          conversationKey: ChatGptAdapter.getConversationKey(), runnerToken: 1
        });
        state.newBinding = Object.freeze({ ...state.binding,
          deliveryAttemptToken: "owned-attempt-2", stateRevision: 3, runnerToken: 2
        });
        state.write = () => { state.tx = ChatGptAdapter.writePrompt(state.prompt, state.binding); };
        state.capture = () => {
          state.receipt = ChatGptAdapter.capturePausedPromptText(state.tx, state.prompt, state.binding);
          return Boolean(state.receipt);
        };
        state.finish = () => ChatGptAdapter.finishPromptDelivery(state.tx);
        state.inspect = () => ChatGptAdapter.inspectPausedPromptText(state.receipt, state.prompt, state.binding);
        state.adopt = () => {
          try {
            state.adopted = ChatGptAdapter.adoptPausedPromptText(state.receipt, state.prompt, state.newBinding);
            return { ok: Boolean(state.adopted), code: null };
          } catch (error) { return { ok: false, code: error?.code ?? null }; }
        };
        state.text = () => ChatGptAdapter.getComposerText(ChatGptAdapter.findComposer());
        state.snapshot = () => ({ text: state.text(), writes: state.writes, events: state.events.length, clicks: state.clicks });
        return {
          missing, navigation: typeof navigation?.addEventListener === "function" && Boolean(navigation.currentEntry)
        };
      }, kind);
      assert.deepEqual(capabilities.missing, [], `Ownership API unavailable in selected core: ${capabilities.missing.join(", ")}`);
      assert.equal(capabilities.navigation, true, "This browser fixture requires actual Navigation API lifecycle events");
      await check(page);
      passed += 1;
      console.log(`PASS ${kind}: ${title}`);
    } finally { await page.close(); }
  }

  async function captureAndFinish(page) {
    const result = await page.evaluate(() => {
      fixture.write();
      const captured = fixture.capture();
      fixture.finish();
      return { captured, valid: fixture.inspect(), originalActive: fixture.tx.active, ...fixture.snapshot() };
    });
    assert.equal(result.captured, true);
    assert.equal(result.valid, true, "Pause-like finish must retain the separate ownership capability");
    assert.equal(result.originalActive, false);
    assert.equal(result.writes, 1);
    assert.equal(result.clicks, 0);
    return result;
  }

  async function rejectPreservingText(page, before) {
    const result = await page.evaluate(() => ({ valid: fixture.inspect(), adoption: fixture.adopt(), ...fixture.snapshot() }));
    assert.equal(result.valid, false);
    assert.deepEqual(result.adoption, { ok: false, code: "draft_present" });
    assert.equal(result.text, before.text, "Rejection must preserve the current draft");
    assert.equal(result.events, before.events, "Rejection must not focus, write or emit input events");
    assert.equal(result.writes, before.writes);
    assert.equal(result.clicks, 0);
  }

  for (const kind of ["textarea", "prosemirror-contract"]) {
    await fixture(kind, "one write, no adoption events, fresh transaction, one local dispatch", async page => {
      const before = await captureAndFinish(page);
      const result = await page.evaluate(() => {
        const adoption = fixture.adopt();
        const after = fixture.snapshot();
        const fresh = fixture.adopted;
        const verification = ChatGptAdapter.inspectPromptDelivery(fresh, fixture.prompt, fixture.newBinding, "text");
        const originalBindingRejected = !ChatGptAdapter.inspectPromptDelivery(fresh, fixture.prompt, fixture.binding, "text").ok;
        const secondAdoption = fixture.adopt();
        if (adoption.ok && verification.ok) ChatGptAdapter.findSendButton().click();
        const answer = {
          adoption, after, verified: verification.ok, originalBindingRejected, secondAdoption,
          freshObject: fresh !== fixture.tx, originalActive: fixture.tx.active,
          sameEpoch: fresh.userMutationEpoch === fixture.tx.userMutationEpoch,
          sameTracker: fresh.tracker === fixture.tx.tracker,
          generationSeen: fresh.generationSeen, acceptanceChecks: fresh.acceptanceChecks,
          acceptanceObserver: fresh.acceptanceObserver === null, clicks: fixture.clicks
        };
        ChatGptAdapter.finishPromptDelivery(fresh);
        return answer;
      });
      assert.deepEqual(result.adoption, { ok: true, code: null });
      assert.deepEqual(result.after, { text: before.text, writes: before.writes, events: before.events, clicks: 0 });
      assert.equal(result.verified, true);
      assert.equal(result.originalBindingRejected, true);
      assert.equal(result.freshObject, true);
      assert.equal(result.originalActive, false);
      assert.equal(result.sameEpoch, true);
      assert.equal(result.sameTracker, true);
      assert.equal(result.generationSeen, false);
      assert.equal(result.acceptanceChecks, 0);
      assert.equal(result.acceptanceObserver, true);
      assert.deepEqual(result.secondAdoption, { ok: false, code: "draft_present" });
      assert.equal(result.clicks, 1);
    });

    await fixture(kind, "trusted edit and revert never restores ownership", async page => {
      await captureAndFinish(page);
      const composer = page.locator("#prompt-textarea");
      await composer.click();
      await composer.press("ControlOrMeta+A");
      await composer.pressSequentially("USER EDIT");
      await composer.press("ControlOrMeta+A");
      await composer.pressSequentially("SYNTHETIC OWNED DRAFT");
      const before = await page.evaluate(() => ({ ...fixture.snapshot(), trustedInput: fixture.events.some(e => e.type === "input" && e.trusted) }));
      assert.equal(before.text, "SYNTHETIC OWNED DRAFT", "The browser must actually restore the identical text");
      assert.equal(before.trustedInput, true, "Use real browser input, not a forged trusted flag");
      await rejectPreservingText(page, before);
    });

    for (const replacement of ["composer", "surface"]) {
      await fixture(kind, `${replacement} replacement rejects same text`, async page => {
        await captureAndFinish(page);
        const before = await page.evaluate(replacement => {
          const original = replacement === "composer" ? fixture.composer : fixture.composer.closest("form");
          const copy = original.cloneNode(true);
          if (replacement === "composer" && fixture.kind === "textarea") copy.value = original.value;
          if (replacement === "surface" && fixture.kind === "textarea") copy.querySelector("textarea").value = fixture.composer.value;
          original.replaceWith(copy);
          return fixture.snapshot();
        }, replacement);
        await rejectPreservingText(page, before);
      });
    }

    for (const method of ["pushState", "replaceState"]) {
      for (const timing of ["before capture", "after capture", "after adoption"]) {
        await fixture(kind, `${method} away/back ${timing} revokes ownership`, async page => {
          if (timing === "before capture") await page.evaluate(() => fixture.write());
          else await captureAndFinish(page);
          if (timing === "after adoption") {
            assert.deepEqual(await page.evaluate(() => fixture.adopt()), { ok: true, code: null });
          }
          await page.evaluate(method => {
            history[method]({}, "", "/c/elsewhere");
            history[method]({}, "", "/c/owned-draft");
          }, method);
          if (timing === "before capture") {
            const result = await page.evaluate(() => {
              const captured = fixture.capture();
              fixture.finish();
              return { captured, ...fixture.snapshot() };
            });
            assert.equal(result.captured, false, "Lifecycle proof must originate at the original write");
            assert.equal(result.text, "SYNTHETIC OWNED DRAFT");
            assert.equal(result.writes, 1);
            assert.equal(result.clicks, 0);
          } else if (timing === "after adoption") {
            const result = await page.evaluate(() => {
              const state = ChatGptAdapter.inspectPromptDelivery(fixture.adopted, fixture.prompt, fixture.newBinding, "text");
              ChatGptAdapter.finishPromptDelivery(fixture.adopted);
              return { ok: state.ok, ...fixture.snapshot() };
            });
            assert.equal(result.ok, false, "Ownership revocation must survive capability transfer to the fresh transaction");
            assert.equal(result.writes, 1);
            assert.equal(result.clicks, 0);
          } else {
            await rejectPreservingText(page, await page.evaluate(() => fixture.snapshot()));
          }
        });
      }
    }

    for (const invalidate of ["pagehide", "core reinjection", "explicit disposal"]) {
      await fixture(kind, `${invalidate} revokes retained capability`, async page => {
        const before = await captureAndFinish(page);
        if (invalidate === "core reinjection") await page.addScriptTag({ content: core });
        else await page.evaluate(invalidate => {
          if (invalidate === "pagehide") window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
          else ChatGptAdapter.disposePausedPromptText(fixture.receipt);
        }, invalidate);
        await rejectPreservingText(page, before);
      });
    }

    await fixture(kind, "same text alone and fabricated receipts confer no authority", async page => {
      const result = await page.evaluate(() => {
        if (fixture.kind === "textarea") fixture.composer.value = fixture.prompt;
        else {
          const paragraph = document.createElement("p");
          paragraph.textContent = fixture.prompt;
          fixture.composer.replaceChildren(paragraph);
        }
        const before = fixture.snapshot();
        const attempts = [null, {}, { active: true, pasteHandled: true, binding: fixture.binding }].map(receipt => {
          fixture.receipt = receipt;
          return { inspected: fixture.inspect(), adoption: fixture.adopt() };
        });
        return { before, after: fixture.snapshot(), attempts };
      });
      assert.deepEqual(result.after, result.before);
      for (const attempt of result.attempts) {
        assert.equal(attempt.inspected, false);
        assert.deepEqual(attempt.adoption, { ok: false, code: "draft_present" });
      }
    });

    await fixture(kind, "binding mismatch consumes capability without changing the draft", async page => {
      const before = await captureAndFinish(page);
      const result = await page.evaluate(() => {
        const correct = fixture.newBinding;
        fixture.newBinding = { ...correct, repeatIndex: 1 };
        const wrong = fixture.adopt();
        fixture.newBinding = correct;
        return { wrong, retry: fixture.adopt(), ...fixture.snapshot() };
      });
      assert.deepEqual(result.wrong, { ok: false, code: "draft_present" });
      assert.deepEqual(result.retry, { ok: false, code: "draft_present" });
      assert.equal(result.text, before.text);
      assert.equal(result.events, before.events);
      assert.equal(result.writes, 1);
      assert.equal(result.clicks, 0);
    });
  }
  console.log(`PASS ${passed} production-adapter browser cases; all routes intercepted, no service sends`);
  await context.close();
} finally { await browser.close(); }
