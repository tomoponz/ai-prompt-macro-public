// Offline Chromium DOM + production core (and one runner integration scenario).
// This models a handled editor paste; it does NOT load ProseMirror or ChatGPT.
// All navigation is intercepted, all other requests are aborted, and no extension,
// service worker, user profile, provider account, or system clipboard is involved.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { chromium } from "playwright-core";

const core = fs.readFileSync(new URL("../src/content-core.js", import.meta.url), "utf8");
const runner = fs.readFileSync(new URL("../src/content-runner.js", import.meta.url), "utf8");
const hash = text => createHash("sha256").update(text, "utf8").digest("hex");
const browser = await chromium.launch({ headless: true });
let passed = 0;
try {
  const context = await browser.newContext();
  await context.route("**/*", route => route.abort());
  await context.route("https://apm-fixture.test/c/**", route => route.fulfill({
    status: 200, contentType: "text/html", body: "<!doctype html><title>Offline append fixture</title>"
  }));

  async function fixture(name, options, check) {
    const page = await context.newPage();
    try {
      await page.goto("https://apm-fixture.test/c/approved-append");
      await page.setContent(`<!doctype html><form data-chatgpt-composer>
        <div id="prompt-textarea" class="ProseMirror" data-composer-markdown role="textbox" contenteditable="true" style="min-height:40px;width:600px"><p></p></div>
        <button type="button" data-testid="send-button">Send</button>
      </form>`);
      await page.addScriptTag({ content: core });
      const ready = await page.evaluate(options => {
        const composer = ChatGptAdapter.findComposer();
        const state = globalThis.appendFixture = {
          composer, options, writes: 0, clicks: 0, events: [], caretEndChecks: [],
          plan: null, transaction: null, receipt: null, retainedNode: null
        };
        if (options.atomic) {
          const token = document.createElement("span");
          token.setAttribute("contenteditable", "false");
          token.setAttribute("data-arbitrary-tool", "preserve-semantic-state");
          token.textContent = options.prefix;
          composer.firstElementChild.append(token);
          state.retainedNode = token;
        } else {
          composer.replaceChildren(...options.prefix.split("\n").map(line => {
            const paragraph = document.createElement("p");
            paragraph.textContent = line;
            return paragraph;
          }));
        }
        state.binding = Object.freeze({
          deliveryAttemptToken: "append-attempt-1", runId: "append-run", executionSessionId: "append-session",
          stateRevision: 1, stepId: "append-step", stepIndex: 0, repeatIndex: 0, sendsCompleted: 0,
          promptHash: "synthetic-macro-hash", inputHash: "synthetic-combined-hash",
          documentInstanceId: instanceId, conversationKey: ChatGptAdapter.getConversationKey(), runnerToken: 1
        });
        for (const type of ["paste", "input", "keydown"]) {
          composer.addEventListener(type, event => state.events.push({ type, trusted: event.isTrusted }), true);
        }
        composer.addEventListener("paste", event => {
          event.preventDefault();
          state.writes += 1;
          const range = window.getSelection().getRangeAt(0);
          const atEnd = range.collapsed && range.startContainer === composer && range.startOffset === composer.childNodes.length;
          state.caretEndChecks.push(atEnd);
          // The first append must put the actual native selection at the editor's
          // end, not replace a selection or start at its first paragraph.
          if (state.writes === 1 && !atEnd) throw new Error("Append caret was not at the native DOM end");
          if (options.convertSuffix) {
            state.addAttachment();
            return;
          }
          // Minimal ProseMirror-like paragraph joining contract. Native Range
          // insertion preserves existing node objects; this is not a real editor.
          const template = document.createElement("template");
          template.innerHTML = event.clipboardData.getData("text/html");
          const paragraphs = [...template.content.children];
          const first = paragraphs.shift();
          const appendRange = document.createRange();
          appendRange.selectNodeContents(composer.lastElementChild);
          appendRange.collapse(false);
          const content = document.createDocumentFragment();
          content.append(...first.childNodes);
          appendRange.insertNode(content);
          composer.append(...paragraphs);
        });
        document.querySelector("[data-testid='send-button']").addEventListener("click", () => { state.clicks += 1; });
        state.addAttachment = (unknown = false) => {
          const tile = document.createElement("div");
          tile.dataset.testid = "file-preview";
          tile.style.cssText = "width:100px;height:30px";
          if (!unknown) {
            const remove = document.createElement("button");
            remove.type = "button"; remove.setAttribute("aria-label", "Remove attachment");
            remove.textContent = "Remove"; tile.append(remove);
          }
          composer.closest("form").append(tile);
          return tile;
        };
        state.prepare = () => { state.plan = ChatGptAdapter.preparePromptAppend(options.macro); return Boolean(state.plan); };
        state.write = () => {
          try {
            state.transaction = ChatGptAdapter.writePrompt(options.macro, state.binding, state.plan);
            return { ok: true, code: null };
          } catch (error) { return { ok: false, code: error?.code ?? null }; }
        };
        state.observe = () => ChatGptAdapter.inspectPromptDelivery(state.transaction, state.plan.expectedText, state.binding);
        state.snapshot = () => ({
          text: ChatGptAdapter.getComposerText(composer), writes: state.writes, clicks: state.clicks,
          retained: !state.retainedNode || composer.contains(state.retainedNode),
          caretEndChecks: state.caretEndChecks, trustedKey: state.events.some(event => event.type === "keydown" && event.trusted)
        });
        return { navigation: Boolean(navigation.currentEntry), api: typeof ChatGptAdapter.preparePromptAppend === "function" };
      }, options);
      assert.deepEqual(ready, { navigation: true, api: true });
      await check(page);
      passed += 1;
      console.log(`PASS ${name}`);
    } finally { await page.close(); }
  }

  for (const spec of [
    { prefix: "Initial instruction", macro: "Next instruction", atomic: false },
    { prefix: "Initial instruction\n", macro: "Next instruction\nThird line", atomic: false },
    { prefix: "任意ツール", macro: "日本語🚀e\u0301 <&>\n".repeat(6_000) + "終", atomic: true },
    { prefix: "", macro: "Preserve invisible token", atomic: true }
  ]) {
    await fixture(`native-end append preserves ${spec.atomic ? "structured" : "ordinary"} input (${spec.macro.length} chars)`, spec, async page => {
      const result = await page.evaluate(() => {
        const prepared = appendFixture.prepare();
        const first = appendFixture.write();
        const state = appendFixture.observe();
        const repeated = appendFixture.write();
        return { prepared, first, repeated, verified: state.ok, mode: state.mode, ...appendFixture.snapshot() };
      });
      const expected = spec.prefix + (spec.prefix.endsWith("\n") ? "" : "\n") + spec.macro;
      assert.equal(result.prepared, true);
      assert.deepEqual(result.first, { ok: true, code: null });
      assert.deepEqual(result.repeated, { ok: false, code: "draft_present" });
      assert.equal(hash(result.text), hash(expected));
      assert.equal(result.retained, true);
      assert.equal(result.verified, true);
      assert.equal(result.mode, "text");
      assert.equal(result.writes, 1);
      assert.equal(result.clicks, 0);
      assert.deepEqual(result.caretEndChecks, [true]);
    });
  }

  await fixture("trusted key without text mutation revokes the captured append", {
    prefix: "Keep initial", macro: "Do not append after interference"
  }, async page => {
    await page.evaluate(() => { appendFixture.prepare(); appendFixture.composer.focus(); });
    await page.keyboard.press("ArrowLeft");
    const result = await page.evaluate(() => ({ write: appendFixture.write(), ...appendFixture.snapshot() }));
    assert.equal(result.trustedKey, true);
    assert.equal(result.text, "Keep initial");
    assert.deepEqual(result.write, { ok: false, code: "draft_present" });
    assert.equal(result.writes, 0);
    assert.equal(result.clicks, 0);
  });

  for (const replaceAtomic of [false, true]) {
    await fixture(`paused combined input ${replaceAtomic ? "rejects same-text atomic replacement" : "adopts without another paste"}`, {
      prefix: "Selected arbitrary tool", macro: "Instruction", atomic: true
    }, async page => {
      const result = await page.evaluate(replaceAtomic => {
        appendFixture.prepare(); appendFixture.write();
        const { transaction, plan, binding } = appendFixture;
        const receipt = ChatGptAdapter.capturePausedPromptText(transaction, plan.expectedText, binding);
        ChatGptAdapter.finishPromptDelivery(transaction);
        if (replaceAtomic) appendFixture.retainedNode.replaceWith(appendFixture.retainedNode.cloneNode(true));
        const valid = ChatGptAdapter.inspectPausedPromptText(receipt, plan.expectedText, binding);
        const next = { ...binding, deliveryAttemptToken: "append-attempt-2", stateRevision: 4, runnerToken: 2 };
        let adoption;
        try {
          const adopted = ChatGptAdapter.adoptPausedPromptText(receipt, plan.expectedText, next);
          adoption = { ok: ChatGptAdapter.inspectPromptDelivery(adopted, plan.expectedText, next).ok, code: null };
          ChatGptAdapter.finishPromptDelivery(adopted);
        } catch (error) { adoption = { ok: false, code: error?.code ?? null }; }
        return { captured: Boolean(receipt), valid, adoption, ...appendFixture.snapshot() };
      }, replaceAtomic);
      assert.equal(result.captured, true);
      assert.equal(result.valid, !replaceAtomic);
      assert.deepEqual(result.adoption, replaceAtomic ? { ok: false, code: "draft_present" } : { ok: true, code: null });
      assert.equal(result.text, "Selected arbitrary tool\nInstruction");
      assert.equal(result.writes, 1);
      assert.equal(result.clicks, 0);
    });
  }

  await fixture("a scoped converted suffix retains the initial structured prefix", {
    prefix: "Selected arbitrary tool", macro: "test".repeat(20_160), atomic: true, convertSuffix: true
  }, async page => {
    const result = await page.evaluate(() => {
      appendFixture.prepare(); appendFixture.write();
      const observed = appendFixture.observe();
      return { ok: observed.ok, mode: observed.mode, count: observed.attachmentState?.count, ...appendFixture.snapshot() };
    });
    assert.equal(result.ok, true);
    assert.equal(result.mode, "paste-attachment");
    assert.equal(result.count, 1);
    assert.equal(result.text, "Selected arbitrary tool");
    assert.equal(result.retained, true);
    assert.equal(result.clicks, 0);
  });

  await fixture("an unclassified residual tile blocks the exact combined text path", {
    prefix: "Keep prefix", macro: "Short macro"
  }, async page => {
    const result = await page.evaluate(() => {
      appendFixture.prepare(); appendFixture.write(); appendFixture.addAttachment(true);
      const observed = appendFixture.observe();
      return { ok: observed.ok, reason: observed.reason, ...appendFixture.snapshot() };
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "attachment-unconfirmed");
    assert.equal(result.text, "Keep prefix\nShort macro");
    assert.equal(result.clicks, 0);
  });

  await fixture("core plus runner includes the initial prefix once across Repeat3", {
    prefix: "Initial selected tool", macro: "Synthetic repeated instruction", atomic: true
  }, async page => {
    await page.addScriptTag({ content: runner });
    const result = await page.evaluate(async () => {
      const state = appendFixture;
      state.sent = [];
      const send = ChatGptAdapter.findSendButton();
      send.addEventListener("click", () => {
        state.sent.push(ChatGptAdapter.getComposerText(state.composer));
        // Provider response is modeled with structural controls only. No answer
        // body is generated or read, and this button has no external action.
        state.composer.replaceChildren(document.createElement("p"));
        const stop = document.createElement("button");
        stop.dataset.testid = "stop-button"; stop.type = "button"; stop.textContent = "Stop";
        state.composer.closest("form").append(stop);
        setTimeout(() => stop.remove(), 100);
      });
      saveActiveRun = async run => { state.activeRun = structuredClone(run); };
      getActiveRun = async () => structuredClone(state.activeRun);
      acquireLease = async (conversationKey, runId, executionSessionId) => ({ conversationKey, runId, executionSessionId, nonce: "offline-append-lease" });
      renewLease = async () => true;
      releaseLease = async () => {};
      appendDiagnostic = async () => {};
      globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: true }) } };
      READY_STABLE_MS = 20; POLL_MS = 20;
      const workflow = normalizeWorkflow({ schemaVersion: 1, id: "offline-append", maxSends: 3,
        steps: [{ id: "send", type: "prompt", delivery: "send", prompt: state.options.macro, repeat: 3, delayAfterMs: 0 }] });
      const run = { runId: "offline-append-run", provider: "chatgpt", conversationKey: ChatGptAdapter.getConversationKey(),
        executionSessionId: "offline-session", documentInstanceId: instanceId, contentVersion: __AIPM_CONTENT_CORE__.version,
        stateRevision: 1, status: "running", phase: "ready", resumable: true, workflow,
        cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 }, outbox: null, waitState: null };
      await captureInitialPromptAppend(run);
      state.activeRun = structuredClone(run);
      localRunnerToken += 1;
      await executeRun(run, localRunnerToken);
      return { sent: state.sent, status: state.activeRun.status, reason: state.activeRun.lastErrorCode ?? null,
        count: state.activeRun.cursor.sendsCompleted, writes: state.writes, clicks: state.clicks,
        initialRequirementRemaining: Boolean(state.activeRun.initialInputRequirement) };
    });
    assert.equal(result.status, "completed", result.reason);
    assert.deepEqual(result.sent, ["Initial selected tool\nSynthetic repeated instruction", "Synthetic repeated instruction", "Synthetic repeated instruction"]);
    assert.equal(result.count, 3);
    assert.equal(result.writes, 3);
    assert.equal(result.clicks, 3);
    assert.equal(result.initialRequirementRemaining, false);
  });
  console.log(`Approved append offline DOM PASS: ${passed} scenarios; editor paste modeled, no real provider operation`);
} finally {
  await browser.close();
}
