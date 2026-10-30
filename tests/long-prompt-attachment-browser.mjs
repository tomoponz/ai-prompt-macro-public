// Offline real DOM + production core/runner. The exact existing editor fixture is
// reused; storage/lease transport is emulated. No provider, extension, or worker.
// Payload hashes verify only exact-text dispatch records. Structural attachment
// recognition does not prove file contents. Scoped conversions may send; the
// queued-foreign-file case explicitly demonstrates the remaining ambiguity.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import { chromium } from "playwright-core";

const source = fs.readFileSync(new URL("./browser-fixture-e2e.mjs", import.meta.url), "utf8");
const begin = source.indexOf("function fixtureHtml() {");
const end = source.indexOf("async function eventually(", begin);
assert.ok(begin >= 0 && end > begin);
const html = vm.runInNewContext(`${source.slice(begin, end)}; fixtureHtml()`, {
  FIXTURE_SECRET: "SYNTHETIC OUTPUT MUST STAY BLIND"
});
const core = fs.readFileSync(new URL("../src/content-core.js", import.meta.url), "utf8");
const runner = fs.readFileSync(new URL("../src/content-runner.js", import.meta.url), "utf8");
const hash = text => createHash("sha256").update(text).digest("hex");
const long48 = "SYNTHETIC 48KiB\n".padEnd(48 * 1024, "A");
const long64 = "SYNTHETIC 64KiB\n".padEnd(64 * 1024, "B");
const reported80640 = "test".repeat(20_160);
const largeUnicode = "日本語🚀e\u0301👩‍💻<&>\n".repeat(6_000) + "終";
assert.equal(reported80640.length, 80_640);
assert.ok(largeUnicode.length >= 80_640);
const foreignPayload = "SYNTHETIC UNRELATED QUEUED FILE";
const cases = [
  { name: "known-limitation-unrelated-queued-tile", prompt: long48, repeat: 1, convert: true, foreign: true, delay: 60_000 },
  { name: "short-text", prompt: "SYNTHETIC SHORT INPUT", repeat: 1, convert: false },
  { name: "48KiB-exact-text-repeat3", prompt: long48, repeat: 3, convert: false },
  { name: "64KiB-exact-text-repeat3", prompt: long64, repeat: 3, convert: false },
  { name: "48KiB-converted-repeat3", prompt: long48, repeat: 3, convert: true },
  { name: "64KiB-converted-repeat3", prompt: long64, repeat: 3, convert: true },
  { name: "80640-ASCII-converted-repeat3", prompt: reported80640, repeat: 3, convert: true },
  { name: "large-Unicode-converted-repeat3", prompt: largeUnicode, repeat: 3, convert: true },
  { name: "unknown-residual-file-preview-before-short", prompt: "SYNTHETIC NEXT SHORT INPUT", repeat: 1,
    convert: false, negative: "unknown-existing" },
  { name: "five-second-pending", prompt: long48, repeat: 1, convert: true, delay: 5_000 },
  { name: "preexisting-attachment", prompt: long48, repeat: 1, convert: true, negative: "existing" },
  { name: "trusted-user-edit", prompt: long48, repeat: 1, convert: true, delay: 60_000, negative: "user" },
  { name: "route-change", prompt: long48, repeat: 1, convert: true, delay: 60_000, negative: "route" }
];

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.route("**/*", route => route.abort());
  await context.route("https://apm-fixture.test/**", route => route.fulfill({
    status: 200, contentType: "text/html", body: html
  }));
  for (const spec of cases) {
    const page = await context.newPage();
    await page.goto(`https://apm-fixture.test/c/c10-local-${spec.name}`);
    await page.addScriptTag({ content: core });
    await page.addScriptTag({ content: runner });
    await page.evaluate(({ spec, foreignHash }) => {
      sessionStorage.removeItem("aipm.fixture.sends");
      __AIPM_FIXTURE_LIVE_PASTED_TEXT__ = spec.convert;
      __AIPM_FIXTURE_LIVE_FILE_TILE_STYLE__ = true;
      __AIPM_FIXTURE_LIVE_PASTED_TEXT_DELAY_MS__ = spec.delay ?? 50;
      __AIPM_FIXTURE_LIVE_PASTED_TEXT_REPLACE_MS__ = 20;
      __AIPM_FIXTURE_LIVE_BUTTON_COUNT__ = 3;
      if (["existing", "unknown-existing"].includes(spec.negative)) __AIPM_FIXTURE_ADD_ATTACHMENT__();
      const initialAttachment = document.querySelector("[data-testid='file-thumbnail']");
      if (spec.negative === "unknown-existing") {
        // An existing file remains visible, but its remove semantics changed.
        // The generic entrypoint still sees the candidate; failing classification
        // must mean unknown, never a clean zero-attachment composer.
        initialAttachment.dataset.testid = "file-preview";
        initialAttachment.style.cssText = "min-height:32px;border:1px solid #777";
        initialAttachment.querySelector("button").setAttribute("aria-label", "Preview unavailable");
      }
      const composer = ChatGptAdapter.findComposer();
      const stats = { writes: 0, clickTimes: [], clickPositions: [], firstWriteAt: null,
        modes: [], pendingSeen: false, foreignTileSent: false, semanticHashes: [], trustedKeys: 0,
        failClosedRequests: [], attachmentButtonClicks: 0 };
      globalThis.longFixture = { stats, initialAttachment, composer, run: null, activeRun: null,
        initialAttachmentMarkup: initialAttachment?.outerHTML ?? null };
      const semanticFileHashes = new WeakMap();
      const send = document.querySelector("[data-testid='send-button']");
      send.addEventListener("click", () => {
        stats.clickTimes.push(Date.now());
        stats.clickPositions.push(`${longFixture.run.cursor.stepIndex}:${longFixture.run.cursor.repeatIndex}`);
        // Capture before the exact fixture handler clears attachments. This map
        // is an independent synthetic oracle; production cannot read it.
        const tile = document.querySelector("[role='group'].group\\/file-tile");
        if (tile && semanticFileHashes.has(tile)) {
          stats.foreignTileSent = true;
          stats.semanticHashes.push(semanticFileHashes.get(tile));
        }
      }, true);
      document.addEventListener("click", event => {
        if (event.target.closest("[role='group'].group\\/file-tile button, [data-testid='file-thumbnail'] button")) {
          stats.attachmentButtonClicks += 1;
        }
      }, true);
      composer.addEventListener("keydown", event => { if (event.isTrusted) stats.trustedKeys += 1; }, true);
      const originalWrite = ChatGptAdapter.writePrompt;
      ChatGptAdapter.writePrompt = function(...args) {
        stats.writes += 1;
        stats.firstWriteAt ??= Date.now();
        return originalWrite.apply(this, args);
      };
      const originalInspect = ChatGptAdapter.inspectPromptDelivery;
      ChatGptAdapter.inspectPromptDelivery = function(...args) {
        const observation = originalInspect.apply(this, args);
        if (observation?.diagnostic?.lastState === "attachment-pending") stats.pendingSeen = true;
        if (observation?.ok && observation.mode === "paste-attachment") {
          // Keep the latest structurally accepted synthetic tile, accounting for
          // the fixture's own temporary-to-final replacement before settlement.
          longFixture.observedAttachment = document.querySelector("[role='group'].group\\/file-tile");
          longFixture.observedAttachmentMarkup = longFixture.observedAttachment?.outerHTML ?? null;
        }
        return observation;
      };
      // Replace only extension transport. Settlement deadline/stability constants,
      // transactions, observer, guards, and acknowledgement remain production.
      saveActiveRun = async run => {
        longFixture.activeRun = structuredClone(run);
        if (["text", "paste-attachment"].includes(run.outbox?.deliveryMode)) stats.modes.push(run.outbox.deliveryMode);
      };
      getActiveRun = async () => structuredClone(longFixture.activeRun);
      acquireLease = async (conversationKey, runId, executionSessionId) => ({
        conversationKey, runId, executionSessionId, nonce: "synthetic-long-lease"
      });
      renewLease = async () => true;
      releaseLease = async () => {};
      appendDiagnostic = async () => {};
      // Record the real runner's stop-only request without pretending this
      // standalone adapter test executes background persistence.
      globalThis.chrome = { runtime: { sendMessage: async message => {
        if (message.type !== "AIPM_RUN_FAIL_CLOSED") throw new Error("Unexpected synthetic transport call");
        stats.failClosedRequests.push(structuredClone(message));
        return { ok: true, run: null };
      } } };
      READY_STABLE_MS = 20;
      POLL_MS = 15;
      if (spec.foreign) {
        // Independently pending file creation was queued BEFORE Run starts.
        // The harness releases its completion after observing pending paste,
        // avoiding a wall-clock race without changing its unrelated payload.
        // Normal paste conversion stays pending for 60s, beyond the unchanged
        // 30s deadline; only this unrelated tile becomes available in time.
        new Promise(resolve => { longFixture.releaseQueuedForeignFile = resolve; }).then(() => {
          __AIPM_FIXTURE_ADD_LIVE_FILE_TILE__();
          const tile = document.querySelector("[role='group'].group\\/file-tile");
          semanticFileHashes.set(tile, foreignHash);
          longFixture.foreignTile = tile;
        });
      }
      const workflow = normalizeWorkflow({
        schemaVersion: 1, id: "synthetic-long-prompt", maxSends: spec.repeat,
        steps: [{ id: "send", type: "prompt", delivery: "send", prompt: spec.prompt, repeat: spec.repeat, delayAfterMs: 0 }]
      });
      const run = {
        runId: "synthetic-long-run", provider: "chatgpt", conversationKey: ChatGptAdapter.getConversationKey(),
        executionSessionId: "synthetic-session", documentInstanceId: instanceId,
        contentVersion: __AIPM_CONTENT_CORE__.version, stateRevision: 1,
        status: "running", phase: "ready", resumable: true, workflow,
        cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 }, outbox: null, waitState: null
      };
      longFixture.run = run;
      longFixture.originalConversationKey = run.conversationKey;
      longFixture.activeRun = structuredClone(run);
      localRunnerToken += 1;
      longFixture.done = executeRun(run, localRunnerToken).then(() => {
        // Observe immediately at runner completion, before a later fixture-owned
        // replacement could be mistaken for a runner attachment mutation.
        longFixture.observedAttachmentUnchangedAtFinish = longFixture.observedAttachment?.isConnected === true &&
          longFixture.observedAttachment === document.querySelector("[role='group'].group\\/file-tile") &&
          longFixture.observedAttachment.outerHTML === longFixture.observedAttachmentMarkup;
      });
    }, { spec, foreignHash: hash(foreignPayload) });
    if (spec.foreign) {
      await page.waitForFunction(() => longFixture.stats.writes === 1 && longFixture.stats.pendingSeen);
      await page.evaluate(() => longFixture.releaseQueuedForeignFile());
    }
    if (["user", "route"].includes(spec.negative)) {
      await page.waitForFunction(() => longFixture.stats.writes === 1);
      if (spec.negative === "user") await page.keyboard.type("SYNTHETIC USER EDIT");
      else await page.evaluate(() => history.pushState({}, "", "/c/unrelated-route"));
    }
    const result = await page.evaluate(async () => {
      await longFixture.done;
      const hashes = await Promise.all(JSON.parse(sessionStorage.getItem("aipm.fixture.sends") || "[]").map(async text => {
        const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
        return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
      }));
      return {
        ...longFixture.stats, hashes, status: longFixture.activeRun.status,
        phase: longFixture.activeRun.phase,
        outboxState: longFixture.activeRun.outbox?.state ?? null,
        deliveryMode: longFixture.activeRun.outbox?.deliveryMode ?? null,
        reason: longFixture.activeRun.lastErrorCode ?? null,
        resumable: longFixture.activeRun.resumable,
        cursor: longFixture.activeRun.cursor,
        sendsCompleted: longFixture.activeRun.cursor.sendsCompleted,
        boundConversationKey: longFixture.activeRun.conversationKey,
        originalConversationKey: longFixture.originalConversationKey,
        currentConversationKey: ChatGptAdapter.getConversationKey(),
        attachmentKinds: __AIPM_FIXTURE_LAST_SEND_ATTACHMENT_KIND__,
        attachmentCount: __AIPM_FIXTURE_ATTACHMENT_COUNT__(),
        attachmentStateKnown: ChatGptAdapter.getComposerAttachmentState(longFixture.composer).known,
        originalAttachmentRetained: longFixture.initialAttachment?.isConnected === true,
        originalAttachmentUnchanged: longFixture.initialAttachment?.outerHTML === longFixture.initialAttachmentMarkup,
        observedAttachmentUnchanged: longFixture.observedAttachmentUnchangedAtFinish,
        foreignTileRetained: longFixture.foreignTile?.isConnected === true,
        userEditPresent: ChatGptAdapter.getComposerText(longFixture.composer).includes("SYNTHETIC USER EDIT"),
        finishedAt: Date.now(),
        deadlineMs: PROMPT_DELIVERY_SETTLEMENT_MAX_MS
      };
    });
    assert.equal(result.deadlineMs, 30_000, spec.name);
    assert.equal(result.attachmentButtonClicks, 0, spec.name);
    if (spec.negative) {
      if (spec.negative !== "route") assert.equal(result.status, "paused", spec.name);
      assert.equal(result.clickTimes.length, 0, spec.name);
      assert.deepEqual(result.hashes, [], spec.name);
      assert.equal(result.sendsCompleted, 0, spec.name);
      assert.deepEqual(result.cursor, { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 }, spec.name);
      if (spec.negative !== "route") assert.equal(result.resumable, false, spec.name);
      if (["existing", "unknown-existing"].includes(spec.negative)) {
        assert.equal(result.writes, 0);
        assert.equal(result.reason, spec.negative === "unknown-existing"
          ? "composer_attachment_unconfirmed" : "unexpected_attachment");
        assert.equal(result.originalAttachmentRetained, true);
        assert.equal(result.originalAttachmentUnchanged, true);
        if (spec.negative === "unknown-existing") {
          assert.equal(result.attachmentStateKnown, false);
          // Fixture counting uses the old thumbnail selector, so its zero is
          // deliberately not an oracle for actual absence. Retention checks above
          // verify the original visible file node remains untouched.
          assert.equal(result.attachmentCount, 0);
        } else {
          assert.equal(result.attachmentCount, 1);
        }
      } else {
        assert.equal(result.writes, 1);
        if (spec.negative === "user") {
          assert.ok(result.trustedKeys > 0);
          assert.equal(result.userEditPresent, true);
          assert.equal(result.reason, "paste_attachment_provenance_lost");
        } else {
          assert.equal(result.failClosedRequests.length, 1);
          assert.equal(result.failClosedRequests[0].type, "AIPM_RUN_FAIL_CLOSED");
          assert.equal(result.failClosedRequests[0].expectedRunId, "synthetic-long-run");
          assert.equal(result.boundConversationKey, result.originalConversationKey);
          assert.notEqual(result.boundConversationKey, result.currentConversationKey);
        }
      }
      console.log(`PASS ${spec.name}: zero clicks, protected input/route`);
    } else {
      assert.equal(result.status, "completed", `${spec.name}: ${result.reason}`);
      assert.equal(result.writes, spec.repeat);
      assert.equal(result.clickTimes.length, spec.repeat);
      assert.equal(result.sendsCompleted, spec.repeat);
      assert.deepEqual(result.hashes, Array(spec.repeat).fill(hash(spec.prompt)), spec.name);
      assert.deepEqual([...new Set(result.modes)], [spec.convert ? "paste-attachment" : "text"]);
      assert.equal(new Set(result.clickPositions).size, spec.repeat);
      assert.equal(result.attachmentCount, 0);
      if (spec.name === "five-second-pending") {
        assert.equal(result.pendingSeen, true);
        assert.ok(result.clickTimes[0] - result.firstWriteAt >= 5_000);
        assert.ok(result.clickTimes[0] - result.firstWriteAt < 30_000);
      }
      if (spec.foreign) {
        assert.equal(result.foreignTileSent, true);
        assert.deepEqual(result.semanticHashes, [hash(foreignPayload)]);
        assert.notEqual(result.semanticHashes[0], hash(spec.prompt));
        assert.equal(result.trustedKeys, 0);
        console.log("LIMITATION reproduced: a queued foreign tile with matching lifecycle observations is dispatched; no content-provenance claim");
      } else {
        console.log(`PASS ${spec.name}: ${spec.repeat} distinct clicks; synthetic dispatch records (not file-byte verification)`);
      }
    }
    await page.close();
  }
  console.log(`Long-prompt fixture: ${cases.length} assertions PASS; scoped conversions accepted, observable foreign interference rejected, indistinguishable queue risk demonstrated`);
  await context.close();
} finally {
  await browser.close();
}
