// Local, headless fixture only. Exercises the production adapter with real browser
// attribute mutations; no provider page, user profile, or network is used.
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";

const source = fs.readFileSync(process.argv[2] ?? new URL("../src/content-core.js", import.meta.url), "utf8");
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.route("**/*", route => route.abort());
  await context.route("https://apm-fixture.test/", route => route.fulfill({
    status: 200, contentType: "text/html", body: "<!doctype html><title>Local fixture</title>"
  }));
  const page = await context.newPage();
  await page.goto("https://apm-fixture.test/");
  for (const composerKind of ["legacy", "current"]) {
    for (const attribute of ["data-testid", "aria-label", "hidden", "style", "class"]) {
      await page.setContent(`<!doctype html><style>.concealed { display:none }</style>
        <form data-chatgpt-composer>
          <div ${composerKind === "legacy" ? 'id="prompt-textarea"' : 'data-composer-markdown'}
            class="ProseMirror" contenteditable="true" role="textbox"><p><br></p></div>
          <button id="control" type="button" data-testid="send-button" aria-label="Send prompt">Control</button>
        </form>`);
      await page.addScriptTag({ content: source });
      const before = await page.evaluate(attribute => {
        const control = document.getElementById("control");
        if (attribute === "aria-label") control.removeAttribute("data-testid");
        if (["hidden", "style", "class"].includes(attribute)) {
          control.dataset.testid = "stop-button";
          control.setAttribute("aria-label", "Stop generating");
          if (attribute === "hidden") control.hidden = true;
          if (attribute === "style") control.style.display = "none";
          if (attribute === "class") control.className = "concealed";
        }
        globalThis.fixtureTransaction = { active: true };
        ChatGptAdapter.startDeliveryAcceptanceWatch(fixtureTransaction);
        return { composer: Boolean(ChatGptAdapter.findComposer()), generating: ChatGptAdapter.isGenerating(), latched: fixtureTransaction.generationSeen };
      }, attribute);
      assert.deepEqual(before, { composer: true, generating: false, latched: false });
      await page.evaluate(attribute => {
        const control = document.getElementById("control");
        if (attribute === "data-testid") control.dataset.testid = "stop-button";
        if (attribute === "aria-label") control.setAttribute("aria-label", "Stop generating");
        if (attribute === "hidden") control.hidden = false;
        if (attribute === "style") control.style.display = "block";
        if (attribute === "class") control.className = "";
      }, attribute);
      // A new evaluate runs after the browser has delivered the mutation microtask.
      assert.equal(await page.evaluate(() => fixtureTransaction.generationSeen), true,
        `${composerKind}: ${attribute}-only generation must be latched before polling`);
      await page.evaluate(attribute => {
        const control = document.getElementById("control");
        if (attribute === "data-testid") control.dataset.testid = "send-button";
        if (attribute === "aria-label") control.setAttribute("aria-label", "Send prompt");
        if (attribute === "hidden") control.hidden = true;
        if (attribute === "style") control.style.display = "none";
        if (attribute === "class") control.className = "concealed";
      }, attribute);
      const after = await page.evaluate(() => {
        const result = { latched: fixtureTransaction.generationSeen, generating: ChatGptAdapter.isGenerating(), disconnected: fixtureTransaction.acceptanceObserver === null };
        ChatGptAdapter.finishPromptDelivery(fixtureTransaction);
        return result;
      });
      assert.deepEqual(after, { latched: true, generating: false, disconnected: true });
      console.log(`PASS ${composerKind} composer: ${attribute}-only transient generation`);
    }
  }
} finally {
  await browser.close();
}
