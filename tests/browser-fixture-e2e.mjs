import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { parseBrowserProfile, scenarioGroupsForProfile } from "./browser-profiles.mjs";
import { buildAipmFlowMetaPrompt } from "../src/flow-authoring.js";
import { verifyNewChatProvenanceBoundary } from "./helpers/new-chat-provenance-browser.mjs";

const TEST_TIMEOUT_MS = 25_000;
const LONG_RUN_TIMEOUT_MS = 240_000;
const FIXTURE_SECRET = "AIPM_ASSISTANT_OUTPUT_MUST_STAY_BLIND_7c92f1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserProfile = parseBrowserProfile(process.argv.slice(2));
/*
  Diagnostic narrowing, inert unless AIPM_BROWSER_ONLY is set. It can only ever
  REMOVE groups from the profile the caller asked for, never add one, and
  `bootstrap` is always retained because every other group depends on it. With
  the variable unset this is exactly `scenarioGroupsForProfile(profile)`, so no
  released profile changes shape.
*/
const onlyGroupIds = String(process.env.AIPM_BROWSER_ONLY ?? "")
  .split(",").map((part) => part.trim()).filter(Boolean);
const c102RaceOnly = String(process.env.AIPM_C102_RACE_ONLY ?? "")
  .split(",").map((part) => part.trim()).filter(Boolean);
for (const race of c102RaceOnly) {
  if (!new Set(["user", "stop"]).has(race)) {
    throw new Error(`Unknown AIPM_C102_RACE_ONLY case: ${race}`);
  }
}
const selectedScenarioGroups = scenarioGroupsForProfile(browserProfile)
  .filter((group) => onlyGroupIds.length === 0 ||
    group.id === "bootstrap" || onlyGroupIds.includes(group.id));
const selectedScenarioGroupIds = new Set(selectedScenarioGroups.map((group) => group.id));
const browserProfileStartedAt = Date.now();

function runsScenarioGroup(groupId) {
  if (!selectedScenarioGroupIds.has("bootstrap")) {
    throw new Error(`Browser profile ${browserProfile} is missing its bootstrap group`);
  }
  return selectedScenarioGroupIds.has(groupId);
}

function existingFile(candidate) {
  return candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : null;
}

function browserExecutable() {
  const requested = process.env.AIPM_BROWSER_PATH?.trim();
  if (requested) {
    const resolved = existingFile(path.resolve(requested));
    if (!resolved) throw new Error(`AIPM_BROWSER_PATH does not point to a browser executable: ${requested}`);
    return resolved;
  }
  const cached = existingFile(chromium.executablePath());
  if (cached) return cached;
  throw new Error(
    "No extension-capable Chromium was found. Install Playwright Chromium or set AIPM_BROWSER_PATH to Chromium/Chrome for Testing."
  );
}

function fixtureHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Private fixture title for display only</title>
  <style>
    body { margin: 24px; font: 16px system-ui; }
    form { display: grid; gap: 12px; width: 640px; }
    #prompt-textarea { min-height: 90px; padding: 12px; border: 1px solid #777; white-space: pre-wrap; }
    [data-testid='file-thumbnail'], [data-testid='file-tile'], [data-testid='composer-pasted-text-card'] { min-height: 32px; padding: 8px; border: 1px solid #777; }
    button { width: 140px; min-height: 40px; }
  </style>
</head>
<body>
  <div data-message-author-role="assistant">${FIXTURE_SECRET}<section data-testid="composer-pasted-text-card" role="group"><button type="button" data-testid="remove-pasted-text-button"></button></section><section role="group" class="group/file-tile"><button type="button" aria-label="synthetic ordinary history action"></button><button type="button" aria-label="synthetic prefix REMOVE synthetic suffix" class="behavior-btn"><svg></svg></button></section></div>
  <div id="fixture-composer-surface" data-testid="composer-surface">
    <header id="fixture-live-attachments"></header>
    <div id="fixture-composer-inner">
      <form>
        <div id="fixture-attachments"></div>
        <div id="prompt-textarea" data-testid="prompt-textarea" class="ProseMirror" contenteditable="true"
          autocomplete="off" inputmode="text" translate="no" role="textbox" aria-multiline="true">
          <p dir="auto" data-empty-paragraph="true" data-placeholder="ChatGPT に質問" class="placeholder"><br class="ProseMirror-trailingBreak"></p>
        </div>
        <button type="button" data-testid="send-button" aria-label="Send prompt">Send</button>
      </form>
    </div>
  </div>
  <script>
    const composer = document.querySelector("#prompt-textarea");
    const sendButton = document.querySelector("[data-testid='send-button']");
    const composerForm = composer.closest("form");
    const attachmentHost = document.querySelector("#fixture-attachments");
    const liveAttachmentHost = document.querySelector("#fixture-live-attachments");
    let editorState = "";
    let pendingPasteText = "";
    const editorStats = { pasteEvents: 0, acceptedSlices: 0, rejectedSlices: 0 };
    globalThis.__AIPM_FIXTURE_PROSEMIRROR__ = editorStats;
    globalThis.__AIPM_FIXTURE_LAST_PROSEMIRROR_DOC__ = null;
    globalThis.__AIPM_FIXTURE_SEND_ACTIONABILITY_EVENTS__ = [];
    const recordSendActionability = (event) => {
      const events = globalThis.__AIPM_FIXTURE_SEND_ACTIONABILITY_EVENTS__;
      if (Array.isArray(events) && events.length < 8) events.push(event);
    };
    sendButton.disabled = true;

    const paragraphs = () => [...composer.children];
    const attachmentCount = () => attachmentHost.querySelectorAll("[data-testid='file-thumbnail']").length +
      liveAttachmentHost.querySelectorAll("[data-testid='file-tile'], [data-fixture-live-file-tile='true']").length;
    globalThis.__AIPM_FIXTURE_LIVE_FORCE_SEND_DISABLED__ = false;
    const syncEditorState = () => {
      editorState = paragraphs().map((paragraph) => paragraph.textContent || "").join("\\n");
      sendButton.disabled = globalThis.__AIPM_FIXTURE_LIVE_FORCE_SEND_DISABLED__ === true ||
        (editorState.length === 0 && attachmentCount() === 0);
    };
    const appendAtAncestorDepth = (node, ancestor, depth, label) => {
      let branch = node;
      for (let currentDepth = 1; currentDepth < depth; currentDepth += 1) {
        const wrapper = document.createElement("div");
        wrapper.dataset.fixtureDepth = label + "-" + currentDepth;
        wrapper.append(branch);
        branch = wrapper;
      }
      ancestor.append(branch);
    };
    globalThis.__AIPM_FIXTURE_SET_LIVE_DEPTHS__ = (composerDepth, tileDepth) => {
      composer.remove();
      liveAttachmentHost.remove();
      appendAtAncestorDepth(composer, composerForm, composerDepth, "composer");
      appendAtAncestorDepth(liveAttachmentHost, composerForm, tileDepth - 1, "tile-host");
      composerForm.append(sendButton);
      syncEditorState();
    };
    globalThis.__AIPM_FIXTURE_ATTACHMENT_COUNT__ = attachmentCount;
    globalThis.__AIPM_FIXTURE_ADD_ATTACHMENT__ = () => {
      const chip = document.createElement("div");
      chip.dataset.testid = "file-thumbnail";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.setAttribute("aria-label", "Remove file");
      remove.addEventListener("click", () => {
        chip.remove();
        syncEditorState();
      });
      chip.append(remove);
      attachmentHost.append(chip);
      syncEditorState();
    };
    globalThis.__AIPM_FIXTURE_CLEAR_ATTACHMENTS__ = () => {
      attachmentHost.replaceChildren();
      liveAttachmentHost.replaceChildren();
      syncEditorState();
    };
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT__ = false;
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_DELAY_MS__ = 350;
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_REPLACE_MS__ = 80;
    globalThis.__AIPM_FIXTURE_LIVE_ADD_EXTRA__ = false;
    globalThis.__AIPM_FIXTURE_LIVE_KEEP_TEXT__ = false;
    globalThis.__AIPM_FIXTURE_LIVE_OUTSIDE_SURFACE__ = false;
    globalThis.__AIPM_FIXTURE_LIVE_TEMPORARY_UNRECOGNIZED__ = false;
    globalThis.__AIPM_FIXTURE_LIVE_FILE_TILE_STYLE__ = false;
    globalThis.__AIPM_FIXTURE_LIVE_DERIVED_REMOVE_COUNT__ = 1;
    globalThis.__AIPM_FIXTURE_LIVE_BUTTON_COUNT__ = 2;
    globalThis.__AIPM_FIXTURE_LIVE_SEND_ACTIONABLE_DELAY_MS__ = 0;
    globalThis.__AIPM_FIXTURE_LAST_SEND_ATTACHMENT_KIND__ = [];
    globalThis.__AIPM_FIXTURE_POST_SEND_RESIDUE__ = "empty";
    globalThis.__AIPM_FIXTURE_CLEAR_READBACKS__ = [];
    const makeLivePastedTextCard = (phase) => {
      if (phase === "temporary" && globalThis.__AIPM_FIXTURE_LIVE_TEMPORARY_UNRECOGNIZED__ === true) {
        const placeholder = document.createElement("div");
        placeholder.dataset.fixturePhase = phase;
        return placeholder;
      }
      const card = document.createElement("div");
      card.dataset.fixturePhase = phase;
      card.setAttribute("role", "group");
      if (globalThis.__AIPM_FIXTURE_LIVE_FILE_TILE_STYLE__ === true) {
        card.dataset.fixtureLiveFileTile = "true";
        card.classList.add("group/file-tile");
        card.setAttribute("aria-label", "synthetic live file tile");
        const removeCount = Math.max(0, Math.min(2,
          Number(globalThis.__AIPM_FIXTURE_LIVE_DERIVED_REMOVE_COUNT__) || 0));
        const buttonCount = Math.max(removeCount, Math.min(9,
          Number(globalThis.__AIPM_FIXTURE_LIVE_BUTTON_COUNT__) || 0));
        for (let index = 0; index < removeCount; index += 1) {
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "behavior-btn";
          remove.setAttribute("aria-label", "synthetic prefix " + (index === 0 ? "REMOVE" : "削除") + " synthetic suffix");
          remove.append(document.createElementNS("http://www.w3.org/2000/svg", "svg"));
          remove.addEventListener("click", () => {
            card.remove();
            syncEditorState();
          });
          card.append(remove);
        }
        while (card.querySelectorAll("button").length < buttonCount) {
          const filler = document.createElement("button");
          filler.type = "button";
          filler.setAttribute("aria-label", "synthetic secondary ordinary action");
          filler.append(document.createElementNS("http://www.w3.org/2000/svg", "svg"));
          card.append(filler);
        }
        return card;
      }
      card.dataset.testid = "file-tile";
      const controls = document.createElement("div");
      const remove = document.createElement("button");
      remove.type = "button";
      remove.dataset.testid = "remove-attachment-button";
      remove.addEventListener("click", () => {
        card.remove();
        syncEditorState();
      });
      controls.append(remove);
      card.append(controls);
      return card;
    };
    globalThis.__AIPM_FIXTURE_ADD_LIVE_FILE_TILE__ = () => {
      liveAttachmentHost.append(makeLivePastedTextCard("pre-existing"));
      syncEditorState();
    };
    globalThis.__AIPM_FIXTURE_CONVERT_NEXT_PASTE__ = false;
    globalThis.__AIPM_FIXTURE_CONVERT_ALL_PASTES__ = false;
    globalThis.__AIPM_FIXTURE_ADD_EXTRA_AFTER_NEXT_PASTE__ = false;
    globalThis.__AIPM_FIXTURE_PAUSE_AFTER_CONVERSION_MS__ = 0;
    const renderParagraph = (paragraph, text) => {
      paragraph.removeAttribute("data-empty-paragraph");
      paragraph.removeAttribute("data-placeholder");
      paragraph.classList.remove("placeholder");
      paragraph.replaceChildren();
      if (text) {
        paragraph.append(document.createTextNode(text));
      } else {
        paragraph.dataset.emptyParagraph = "true";
        const trailingBreak = document.createElement("br");
        trailingBreak.className = "ProseMirror-trailingBreak";
        paragraph.append(trailingBreak);
      }
    };
    const resetComposer = () => {
      const paragraph = document.createElement("p");
      paragraph.dir = "auto";
      paragraph.dataset.placeholder = "ChatGPT に質問";
      paragraph.className = "placeholder";
      renderParagraph(paragraph, "");
      paragraph.dataset.placeholder = "ChatGPT に質問";
      paragraph.className = "placeholder";
      composer.replaceChildren(paragraph);
      syncEditorState();
    };
    const clearComposerAfterSend = () => {
      if (globalThis.__AIPM_FIXTURE_POST_SEND_RESIDUE__ === "two-empty-paragraphs") {
        const makeEmptyParagraph = () => {
          const paragraph = document.createElement("p");
          paragraph.dir = "auto";
          renderParagraph(paragraph, "");
          return paragraph;
        };
        composer.replaceChildren(makeEmptyParagraph(), makeEmptyParagraph());
        syncEditorState();
      } else if (globalThis.__AIPM_FIXTURE_POST_SEND_RESIDUE__ === "zwsp") {
        const paragraph = document.createElement("p");
        paragraph.dir = "auto";
        renderParagraph(paragraph, "\u200b");
        composer.replaceChildren(paragraph);
        syncEditorState();
      } else {
        resetComposer();
      }
      globalThis.__AIPM_FIXTURE_CLEAR_READBACKS__.push(editorState);
    };

    // Models ProseMirror's separation between DOM and transaction state. The fixture's
    // sendable editorState changes only when its paste handler consumes a valid slice.
    composer.addEventListener("paste", (event) => {
      editorStats.pasteEvents += 1;
      const plainText = (event.clipboardData?.getData("text/plain") ?? "").replace(/\\r\\n?/g, "\\n");
      pendingPasteText = plainText;
      const html = event.clipboardData?.getData("text/html") ?? "";
      const template = document.createElement("template");
      template.innerHTML = html;
      const sliceParagraphs = [...template.content.children];
      const slice = sliceParagraphs[0];
      const lines = sliceParagraphs.map((paragraph) => paragraph.textContent || "");
      if (slice?.getAttribute("data-pm-slice") !== "0 0 []" || sliceParagraphs.length === 0 || sliceParagraphs.some((node) => node.tagName !== "P") || template.content.querySelector("br") || lines.join("\\n") !== plainText) {
        editorStats.rejectedSlices += 1;
        return;
      }
      event.preventDefault();
      editorStats.acceptedSlices += 1;
      globalThis.__AIPM_FIXTURE_LAST_PROSEMIRROR_DOC__ = [...lines];
      if (globalThis.__AIPM_FIXTURE_CONVERT_NEXT_PASTE__ === true ||
          globalThis.__AIPM_FIXTURE_CONVERT_ALL_PASTES__ === true) {
        globalThis.__AIPM_FIXTURE_CONVERT_NEXT_PASTE__ = false;
        resetComposer();
        globalThis.__AIPM_FIXTURE_ADD_ATTACHMENT__();
        if (globalThis.__AIPM_FIXTURE_ADD_EXTRA_AFTER_NEXT_PASTE__ === true) {
          globalThis.__AIPM_FIXTURE_ADD_EXTRA_AFTER_NEXT_PASTE__ = false;
          globalThis.__AIPM_FIXTURE_ADD_ATTACHMENT__();
        }
        const pauseMs = Math.max(0, Number(globalThis.__AIPM_FIXTURE_PAUSE_AFTER_CONVERSION_MS__) || 0);
        globalThis.__AIPM_FIXTURE_PAUSE_AFTER_CONVERSION_MS__ = 0;
        const pauseUntil = performance.now() + pauseMs;
        while (performance.now() < pauseUntil) {
          // Test-only main-thread stall: once it releases, the runner's 120ms settle timer
          // begins and Playwright can inject a real trusted event inside that window.
        }
        return;
      }
      if (globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT__ === true) {
        const sendActionableDelayMs = Math.max(
          0,
          Number(globalThis.__AIPM_FIXTURE_LIVE_SEND_ACTIONABLE_DELAY_MS__) || 0
        );
        globalThis.__AIPM_FIXTURE_LIVE_FORCE_SEND_DISABLED__ = sendActionableDelayMs > 0;
        if (sendActionableDelayMs > 0) recordSendActionability("forced-disabled:true");
        if (globalThis.__AIPM_FIXTURE_LIVE_KEEP_TEXT__ === true) {
          composer.replaceChildren(...lines.map((line) => {
            const paragraph = document.createElement("p");
            paragraph.dir = "auto";
            renderParagraph(paragraph, line);
            return paragraph;
          }));
        } else {
          // Production evidence reached settlement timeout with no send, then acquired its
          // final file tile much later. Model that conversion-pending interval as an empty
          // ProseMirror immediately after the handled paste, not as stable exact TEXT.
          resetComposer();
        }
        syncEditorState();
        const delayMs = Math.max(0, Number(globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_DELAY_MS__) || 0);
        const replaceMs = Math.max(0, Number(globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_REPLACE_MS__) || 0);
        setTimeout(() => {
          const temporary = makeLivePastedTextCard("temporary");
          if (globalThis.__AIPM_FIXTURE_LIVE_OUTSIDE_SURFACE__ === true) document.body.append(temporary);
          else liveAttachmentHost.replaceChildren(temporary);
          if (globalThis.__AIPM_FIXTURE_LIVE_ADD_EXTRA__ === true) {
            liveAttachmentHost.append(makeLivePastedTextCard("unknown-extra"));
          }
          syncEditorState();
          setTimeout(() => {
            if (!temporary.isConnected) return;
            temporary.replaceWith(makeLivePastedTextCard("final"));
            syncEditorState();
            if (sendActionableDelayMs > 0) {
              setTimeout(() => {
                globalThis.__AIPM_FIXTURE_LIVE_FORCE_SEND_DISABLED__ = false;
                recordSendActionability("forced-disabled:false");
                syncEditorState();
              }, sendActionableDelayMs);
            }
          }, replaceMs);
        }, delayMs);
        return;
      }
      composer.replaceChildren(...lines.map((line) => {
        const paragraph = document.createElement("p");
        paragraph.dir = "auto";
        renderParagraph(paragraph, line);
        return paragraph;
      }));
      syncEditorState();
    });

    const readSends = () => JSON.parse(sessionStorage.getItem("aipm.fixture.sends") || "[]");
    sendButton.addEventListener("click", () => {
      if (globalThis.__AIPM_FIXTURE_SEND_ACTIONABILITY_EVENTS__?.includes("forced-disabled:true")) {
        recordSendActionability("send-click");
      }
      const sends = readSends();
      sends.push(attachmentCount() === 1 ? pendingPasteText : editorState);
      globalThis.__AIPM_FIXTURE_LAST_SEND_ATTACHMENT_KIND__.push(
        liveAttachmentHost.querySelector("[data-testid='file-tile'], [data-fixture-live-file-tile='true']") ? "pasted-text" :
          (attachmentHost.querySelector("[data-testid='file-thumbnail']") ? "file-thumbnail" : "text")
      );
      sessionStorage.setItem("aipm.fixture.sends", JSON.stringify(sends));
      attachmentHost.replaceChildren();
      liveAttachmentHost.replaceChildren();
      pendingPasteText = "";
      clearComposerAfterSend();
      if (location.pathname !== "/c/ambiguous-reload") {
        const stop = document.createElement("button");
        stop.type = "button";
        stop.dataset.testid = "stop-button";
        stop.setAttribute("aria-label", "Stop generating");
        stop.textContent = "Stop";
        document.body.append(stop);
        // The Issue #23 long-run fixture keeps a realistic generation window so one
        // bounded identity reconfirmation cannot hide the entire ACK signal.
        // Attachment Repeat fixtures must expose the generation signal for longer
        // than the production 300ms observation interval. This models an active
        // generation window without changing production polling or timeouts.
        // The short-reply fixture is the opposite calibration on purpose: a generation
        // window far shorter than one production observation interval, which is what a
        // one-line assistant reply actually produces. Delivery must still be confirmed.
        const generationMs = location.pathname.startsWith("/c/parallel-repeat-")
          ? 500
          : (location.pathname.startsWith("/c/short-reply-")
            ? 30
          : (location.pathname === "/c/issue23-repeat-40" ||
            location.pathname.startsWith("/c/c11-") ||
            location.pathname.startsWith("/c/c9-paste") ||
            location.pathname.startsWith("/c/c10-") ? 2000 : 80));
        setTimeout(() => stop.remove(), generationMs);
      }
      if (location.pathname === "/" && sends.length === 1) {
        history.replaceState({}, "", "/c/generated-fixture-conversation");
      }
    });
  </script>
</body>
</html>`;
}

async function eventually(description, operation, timeoutMs = TEST_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`${description} did not become true within ${timeoutMs}ms`, { cause: lastError });
}

async function fixtureSends(page) {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem("aipm.fixture.sends") || "[]"));
}

async function configureC103LiveDepth(
  page,
  { tileDepth = 7, sendActionableDelayMs = 0, addPreExisting = false, buttonCount = 2 } = {}
) {
  await page.evaluate(({
    configuredTileDepth,
    configuredSendDelay,
    configuredPreExisting,
    configuredButtonCount
  }) => {
    sessionStorage.removeItem("aipm.fixture.sends");
    globalThis.__AIPM_FIXTURE_SET_LIVE_DEPTHS__(6, configuredTileDepth);
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT__ = true;
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_DELAY_MS__ = 350;
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_REPLACE_MS__ = 80;
    globalThis.__AIPM_FIXTURE_LIVE_TEMPORARY_UNRECOGNIZED__ = true;
    globalThis.__AIPM_FIXTURE_LIVE_FILE_TILE_STYLE__ = true;
    globalThis.__AIPM_FIXTURE_LIVE_DERIVED_REMOVE_COUNT__ = 1;
    globalThis.__AIPM_FIXTURE_LIVE_BUTTON_COUNT__ = configuredButtonCount;
    globalThis.__AIPM_FIXTURE_LIVE_SEND_ACTIONABLE_DELAY_MS__ = configuredSendDelay;
    globalThis.__AIPM_FIXTURE_LAST_SEND_ATTACHMENT_KIND__ = [];
    globalThis.__AIPM_FIXTURE_SEND_ACTIONABILITY_EVENTS__ = [];
    if (configuredPreExisting) globalThis.__AIPM_FIXTURE_ADD_LIVE_FILE_TILE__();
  }, {
    configuredTileDepth: tileDepth,
    configuredSendDelay: sendActionableDelayMs,
    configuredPreExisting: addPreExisting,
    configuredButtonCount: buttonCount
  });
}

async function waitForSendCount(page, expected, timeoutMs = TEST_TIMEOUT_MS) {
  return eventually(`fixture send count ${expected}`, async () => {
    const sends = await fixtureSends(page);
    assert.equal(sends.length, expected);
    return sends;
  }, timeoutMs);
}

async function waitForLiveRunSendCount(page, worker, tabId, runId, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastSends = [];
  let lastRun = null;
  while (Date.now() < deadline) {
    const [sends, run] = await Promise.all([fixtureSends(page), activeRunFor(worker, tabId)]);
    lastSends = sends;
    lastRun = run;
    if (sends.length > expected) {
      throw new Error(`Run exceeded the planned send count: ${sends.length}/${expected}`);
    }
    if (run?.runId === runId && ["paused", "stopped"].includes(run.status)) {
      throw new Error(`Run became ${run.status} at ${sends.length}/${expected}: ${JSON.stringify({
        phase: run.phase,
        resumable: run.resumable,
        pauseReason: run.pauseReason,
        lastErrorCode: run.lastErrorCode,
        lastErrorMessage: run.lastErrorMessage,
        cursor: run.cursor,
        outbox: run.outbox
      })}`);
    }
    if (run?.runId === runId && run.status === "completed") {
      if (sends.length === expected && run.cursor?.sendsCompleted === expected && run.outbox == null) return sends;
      throw new Error(`Run completed with inconsistent durable progress: ${JSON.stringify({
        sends: sends.length,
        expected,
        cursor: run.cursor,
        outbox: run.outbox
      })}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const probeStats = await worker.evaluate(() => {
    const stats = globalThis.__AIPM_ISSUE23_PROBE_STATS__;
    return stats ? { calls: stats.calls, failures: stats.failures, failedAt: [...stats.failedAt] } : null;
  }).catch(() => null);
  const diagnostics = await worker.evaluate(async () => {
    const stored = await chrome.storage.local.get("aipm.diagnostics.v1");
    const entries = Array.isArray(stored["aipm.diagnostics.v1"])
      ? stored["aipm.diagnostics.v1"]
      : [];
    return entries.slice(-12);
  }).catch(() => []);
  throw new Error(`live Run ${runId} did not reach ${expected} sends within ${timeoutMs}ms: ${JSON.stringify({
    sends: lastSends.length,
    status: lastRun?.status ?? null,
    phase: lastRun?.phase ?? null,
    cursor: lastRun?.cursor ?? null,
    outbox: lastRun?.outbox ?? null,
    probeStats,
    diagnostics
  })}`);
}

async function activeRunFor(worker, tabId) {
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  return worker.evaluate(async (storageKey) => {
    const stored = await chrome.storage.local.get(storageKey);
    return stored[storageKey] ?? null;
  }, key);
}

async function installC11IdentityBlackout(worker, tabId, { blackoutMs, contactDelayMs }) {
  await worker.evaluate(({ targetTabId, durationMs, delayMs }) => {
    const original = chrome.scripting.executeScript;
    globalThis.__AIPM_C11_BLACKOUT__ = {
      original,
      targetTabId,
      until: Date.now() + durationMs,
      contactDelayMs: delayMs,
      calls: 0,
      failures: 0,
      outstanding: 0,
      maxOutstanding: 0
    };
    chrome.scripting.executeScript = async function c11DocumentIdentityBlackout(details) {
      const state = globalThis.__AIPM_C11_BLACKOUT__;
      const isTargetIdentityProbe = details?.target?.tabId === state.targetTabId &&
        String(details?.func ?? "").includes("__AIPM_DOCUMENT_INSTANCE_ID__");
      if (!isTargetIdentityProbe) return state.original.call(chrome.scripting, details);

      state.calls += 1;
      if (Date.now() >= state.until) return state.original.call(chrome.scripting, details);

      state.outstanding += 1;
      state.maxOutstanding = Math.max(state.maxOutstanding, state.outstanding);
      try {
        await new Promise((resolve) => setTimeout(resolve, state.contactDelayMs));
        state.failures += 1;
        throw new Error("C11 fixture document identity blackout");
      } finally {
        state.outstanding -= 1;
      }
    };
  }, { targetTabId: tabId, durationMs: blackoutMs, delayMs: contactDelayMs });
}

/*
  Delays every document-identity probe without ever failing one.

  This is what a busy ChatGPT renderer does to the runner's post-click path: the durable
  write, the read-only run observation, and the lease renewal each end in an executeScript
  that needs the page's main thread, so the first acceptance sample arrives hundreds of
  milliseconds after the click. Combined with a 30ms generation window it deterministically
  reproduces the live shape — the send landed, the evidence was simply gone before anyone
  looked — without weakening any production timeout.
*/
async function installSlowIdentityProbe(worker, tabId, { probeDelayMs }) {
  await worker.evaluate(({ targetTabId, delayMs }) => {
    const original = chrome.scripting.executeScript;
    globalThis.__AIPM_SLOW_PROBE__ = { original, targetTabId, calls: 0 };
    chrome.scripting.executeScript = async function slowDocumentIdentityProbe(details) {
      const state = globalThis.__AIPM_SLOW_PROBE__;
      const isTargetIdentityProbe = details?.target?.tabId === state.targetTabId &&
        String(details?.func ?? "").includes("__AIPM_DOCUMENT_INSTANCE_ID__");
      if (!isTargetIdentityProbe) return state.original.call(chrome.scripting, details);
      state.calls += 1;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return state.original.call(chrome.scripting, details);
    };
  }, { targetTabId: tabId, delayMs: probeDelayMs });
}

async function removeSlowIdentityProbe(worker) {
  return worker.evaluate(() => {
    const state = globalThis.__AIPM_SLOW_PROBE__;
    if (!state) return 0;
    chrome.scripting.executeScript = state.original;
    globalThis.__AIPM_SLOW_PROBE__ = null;
    return state.calls;
  });
}

async function currentFixtureDocumentIdentity(worker, tabId) {
  return worker.evaluate(async (targetTabId) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId: targetTabId, frameIds: [0] },
      func: () => globalThis.__AIPM_DOCUMENT_INSTANCE_ID__ ?? null
    });
    const top = results.find((entry) => entry?.frameId === 0) ?? null;
    return {
      documentId: typeof top?.documentId === "string" ? top.documentId : null,
      documentInstanceId: typeof top?.result === "string" ? top.result : null
    };
  }, tabId);
}

/*
  Reproduces the supplied Edge failure at its real boundary. Initial Start and Send probes
  stay fast. Once the first send is durably confirmed, each later identity contact first
  occupies the same renderer with a long isolated-world task. The page never navigates and
  its document identifiers are asserted unchanged before any failure is rethrown.
*/
async function installPostConfirmedRendererStall(worker, tabId, { rendererStallMs }) {
  await worker.evaluate(({ targetTabId, stallMs }) => {
    const original = chrome.scripting.executeScript;
    const runKey = `aipm.activeRun.v2.tab.${targetTabId}`;
    globalThis.__AIPM_POST_CONFIRMED_RENDERER_STALL__ = {
      original,
      targetTabId,
      runKey,
      stallMs,
      identityCalls: 0,
      postConfirmedIdentityCalls: 0,
      stalledCalls: 0
    };
    chrome.scripting.executeScript = async function postConfirmedRendererStall(details) {
      const state = globalThis.__AIPM_POST_CONFIRMED_RENDERER_STALL__;
      const isTargetIdentityProbe = details?.target?.tabId === state.targetTabId &&
        String(details?.func ?? "").includes("__AIPM_DOCUMENT_INSTANCE_ID__");
      if (!isTargetIdentityProbe) return state.original.call(chrome.scripting, details);
      state.identityCalls += 1;
      const stored = await chrome.storage.local.get(state.runKey);
      const run = stored[state.runKey] ?? null;
      if (run?.outbox?.state === "confirmed" && Number(run?.cursor?.sendsCompleted) === 0) {
        state.postConfirmedIdentityCalls += 1;
        state.stalledCalls += 1;
        await state.original.call(chrome.scripting, {
          target: { tabId: state.targetTabId, frameIds: [0] },
          func: (durationMs) => {
            const deadline = performance.now() + durationMs;
            while (performance.now() < deadline) {
              // Intentionally occupy the renderer without changing DOM or document identity.
            }
          },
          args: [state.stallMs]
        });
      }
      return state.original.call(chrome.scripting, details);
    };
  }, { targetTabId: tabId, stallMs: rendererStallMs });
}

async function restorePostConfirmedRendererStall(worker) {
  return worker.evaluate(() => {
    const state = globalThis.__AIPM_POST_CONFIRMED_RENDERER_STALL__;
    if (!state) return null;
    chrome.scripting.executeScript = state.original;
    delete globalThis.__AIPM_POST_CONFIRMED_RENDERER_STALL__;
    return {
      identityCalls: state.identityCalls,
      postConfirmedIdentityCalls: state.postConfirmedIdentityCalls,
      stalledCalls: state.stalledCalls
    };
  });
}

async function c11IdentityBlackoutStats(worker) {
  return worker.evaluate(() => {
    const state = globalThis.__AIPM_C11_BLACKOUT__;
    if (!state) return null;
    return {
      calls: state.calls,
      failures: state.failures,
      outstanding: state.outstanding,
      maxOutstanding: state.maxOutstanding,
      remainingMs: Math.max(0, state.until - Date.now())
    };
  });
}

async function restoreC11IdentityProbe(worker) {
  return worker.evaluate(() => {
    const state = globalThis.__AIPM_C11_BLACKOUT__;
    if (!state) return null;
    chrome.scripting.executeScript = state.original;
    delete globalThis.__AIPM_C11_BLACKOUT__;
    return {
      calls: state.calls,
      failures: state.failures,
      outstanding: state.outstanding,
      maxOutstanding: state.maxOutstanding
    };
  });
}

async function waitForDurableConfirmedPosition(worker, tabId, expected) {
  return eventually(`durable confirmed send count ${expected}`, async () => {
    const run = await activeRunFor(worker, tabId);
    assert.equal(run?.status, "running");
    assert.equal(run?.cursor?.sendsCompleted, expected);
    assert.equal(run?.outbox, null, "safe reload position must have no unfinished outbox");
    return run;
  });
}

async function tabIdFor(worker, page) {
  const url = new URL(page.url());
  return eventually(`tab id for ${url.pathname}`, async () => {
    const tabs = await worker.evaluate(async () => chrome.tabs.query({}));
    const match = tabs.find((tab) => {
      if (typeof tab.url !== "string") return false;
      const candidate = new URL(tab.url);
      return candidate.origin === url.origin && candidate.pathname === url.pathname;
    });
    assert.ok(Number.isInteger(match?.id), `No browser tab matched ${url.pathname}`);
    return match.id;
  });
}

async function selectTarget(sidePanel, tabId) {
  await eventually(`Side Panel target option ${tabId}`, async () => {
    const values = await sidePanel.locator("#targetTab option").evaluateAll((options) => options.map((option) => option.value));
    assert.ok(values.includes(String(tabId)));
  });
  await sidePanel.locator("#targetTab").selectOption(String(tabId));
  await eventually(`target tab ${tabId} ready`, async () => {
    assert.equal(await sidePanel.locator("#targetTab").inputValue(), String(tabId));
    assert.equal(await sidePanel.locator("#start").isEnabled(), true);
  });
}

async function configureQuickRun(sidePanel, { prompt, repeat, delaySeconds }) {
  await sidePanel.locator("#quickTab").click();
  await sidePanel.locator("#quickPrompt").fill(prompt);
  await sidePanel.locator("#quickRepeat").fill(String(repeat));
  await sidePanel.locator("#quickDelay").fill(String(delaySeconds));
}

async function clickStartOnly(sidePanel) {
  await sidePanel.locator("#start").click();
}

async function startQuickRun(sidePanel, config, readyTarget = null) {
  await configureQuickRun(sidePanel, config);
  /* Scenarios that established readiness against a specific document re-confirm
     it here, so the Start click cannot land on a status observation that went
     stale while the Quick Run was being configured. */
  if (readyTarget) {
    await confirmStartReadiness(sidePanel, readyTarget.page, readyTarget.tabId, "before Start");
  }
  await clickStartOnly(sidePanel);
}

async function stopRunAndWaitForTerminal(sidePanel, worker, tabId, description) {
  await sidePanel.locator("#stop").click();
  await eventually(description, async () => {
    assert.equal((await activeRunFor(worker, tabId))?.status, "stopped");
  });
}

function fixtureConversationKey(page) {
  const match = new URL(page.url()).pathname.match(/^\/c\/([a-zA-Z0-9-]+)$/);
  assert.ok(match, `Fixture ChatGPT URL must identify one conversation: ${page.url()}`);
  return `chatgpt:c:${match[1]}`;
}

/*
  Confirms the target tab is ready to Start against the CURRENT document.

  Readiness is re-checkable on purpose. `selectReadyTarget` establishes it after
  selection, and `startQuickRun` re-establishes it immediately before the click:
  configuring a Quick Run performs four page round-trips, during which the panel
  re-polls status and the background re-observes the document. A check that only
  ran before that window could pass and then go stale before Start was pressed.
*/
async function confirmStartReadiness(sidePanel, page, tabId, phase) {
  const expectedConversationKey = fixtureConversationKey(page);

  await eventually(`target tab ${tabId} current document status ready (${phase})`, async () => {
    const observation = await sidePanel.evaluate(async (targetTabId) => {
      const response = await chrome.runtime.sendMessage({ type: "AIPM_LIST_CHATGPT_TABS" });
      return {
        response,
        extensionVersion: chrome.runtime.getManifest().version,
        target: response?.tabs?.find((item) => item.tabId === targetTabId) ?? null
      };
    }, tabId);

    assert.equal(observation.response?.ok, true);
    assert.equal(observation.target?.status?.pageReady, true);
    assert.equal(observation.target?.status?.conversationKey, expectedConversationKey);
    assert.equal(observation.target?.status?.contentVersion, observation.extensionVersion);
    assert.equal(observation.target?.status?.discoveryError, null);
  });

  await eventually(`target tab ${tabId} remains selectable after current document discovery (${phase})`, async () => {
    assert.equal(await sidePanel.locator("#targetTab").inputValue(), String(tabId));
    assert.equal(await sidePanel.locator("#start").isEnabled(), true);
  });
}

async function selectReadyTarget(sidePanel, page, tabId) {
  await selectTarget(sidePanel, tabId);
  await confirmStartReadiness(sidePanel, page, tabId, "after selection");
}

async function verifyCompactPanelLayout(panel, directory, mode) {
  for (const width of [320, 360, 400]) {
    await panel.setViewportSize({ width, height: 700 });
    await panel.evaluate(() => scrollTo(0, 0));
    const layout = await panel.evaluate((inputMode) => {
      const box = (selector) => document.querySelector(selector).getBoundingClientRect();
      const ordered = ["#targetCard", ".entry-modes", inputMode === "quick" ? "#quickPanel" : "#flowEntryPanel",
        "#startSection", "#runCard", "#savedAutomation", "#recoverySettings", "#diagnosticsCard", "#devSettings"];
      const start = box("#start");
      return {
        width: document.documentElement.scrollWidth, viewport: innerWidth,
        ordered: ordered.every((selector, index) => index === 0 || box(selector).top >= box(ordered[index - 1]).bottom),
        startBottom: start.bottom, startHeight: start.height,
        runHeight: box("#runCard").height,
        quickRows: box("#quickRepeat").top === box("#quickDelay").top,
        bodyFont: Number.parseFloat(getComputedStyle(document.body).fontSize)
      };
    }, mode);
    assert.ok(layout.width <= layout.viewport, `${width}px ${mode}: no horizontal overflow`);
    assert.equal(layout.ordered, true, `${mode}: target/input/Start/status/settings DOM and visual order`);
    assert.ok(layout.runHeight < 80, "idle status occupies one compact row");
    assert.ok(layout.startHeight >= 34 && layout.bodyFont >= 12, "density must retain usable type and click targets");
    // The complete core Quick journey fits one 700px viewport; a multi-Flow,
    // three-step preview takes at most a short extra scroll, even at 320px.
    assert.ok(layout.startBottom <= (mode === "quick" ? 700 : 1050), `${width}px ${mode}: Start at ${layout.startBottom}px`);
    if (mode === "quick") assert.equal(layout.quickRows, true, "repeat and wait stay side by side");
    await panel.screenshot({ path: path.join(directory, `${mode}-idle-${width}.png`), fullPage: true });
    console.log(`Compact Side Panel ${mode} ${width}px: ${JSON.stringify(layout)}`);
  }
}

async function verifyActivePanelLayout(panel, directory, state, screenshotName = state) {
  for (const width of [320, 360, 400]) {
    await panel.setViewportSize({ width, height: 700 });
    assert.equal(await panel.locator("#runCard").getAttribute("data-state"), state);
    assert.equal(await panel.locator("#runDetails").isVisible(), true);
    assert.equal(await panel.locator("#startSection").isVisible(), false);
    assert.equal(await panel.locator("#runCard").evaluate((node) =>
      Boolean(node.compareDocumentPosition(document.querySelector("#targetCard")) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
    await panel.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    const stop = await panel.locator("#stop").boundingBox();
    assert.ok(stop && stop.x >= 0 && stop.x + stop.width <= width && stop.y >= 0 && stop.y + stop.height <= 700);
    for (const id of ["pause", "resume", "stop"]) {
      const box = await panel.locator(`#${id}`).boundingBox();
      assert.ok(box && box.width >= 44 && box.height >= 40, `${width}px ${id}: usable control target`);
    }
    assert.equal(await panel.locator("#stop").isEnabled(), true);
    assert.ok(await panel.locator("#nextAction").innerText());
    assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await panel.screenshot({ path: path.join(directory, `${screenshotName}-${width}.png`) });
  }
}

async function verifySidePanelFlowEntry({ context, worker, extensionId, otherChat }) {
  // A separate routed fixture tab keeps the established delivery scenarios and
  // their per-tab editor state independent of this new authoring journey.
  const chat = await context.newPage();
  const panel = await context.newPage();
  const pageErrors = [];
  panel.on("pageerror", (error) => pageErrors.push(error.message));
  const screenshotDirectory = path.join(os.tmpdir(), "aipm-flow-entry-browser");
  fs.mkdirSync(screenshotDirectory, { recursive: true });
  try {
    await chat.goto("https://chatgpt.com/c/sidepanel-flow-entry");
    const tabId = await tabIdFor(worker, chat);
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel.html`);
    await selectReadyTarget(panel, chat, tabId);
    for (const id of ["targetDisplaySettings", "recoverySettings", "diagnosticsCard", "devSettings", "flowGuide", "flowPreviewDetails"]) {
      assert.equal(await panel.locator(`#${id}`).evaluate((node) => node.open), false, `${id} defaults closed`);
    }
    assert.equal(await panel.locator("#targetAlias").isVisible(), false);
    assert.equal(await panel.locator("#recoveryMode").isVisible(), false);
    assert.equal(await panel.locator("#diagnosticsTitle").isVisible(), false);
    assert.equal(await panel.locator("#reloadExtension").isVisible(), false);
    for (const [id, child] of [["targetDisplaySettings", "targetAlias"], ["recoverySettings", "recoveryMode"],
      ["diagnosticsCard", "diagnosticsTitle"], ["devSettings", "reloadExtension"]]) {
      await panel.locator(`#${id} > summary`).focus();
      await panel.keyboard.press("Enter");
      assert.equal(await panel.locator(`#${child}`).isVisible(), true, `${id} opens by keyboard`);
      await panel.keyboard.press("Enter");
      assert.equal(await panel.locator(`#${child}`).isVisible(), false);
    }
    await verifyCompactPanelLayout(panel, screenshotDirectory, "quick");
    assert.deepEqual(await fixtureSends(chat), [], "disclosure never starts or sends");
    const oldQuick = "OLD SAVED QUICK MUST NOT BE SENT";
    await configureQuickRun(panel, { prompt: oldQuick, repeat: 1, delaySeconds: 0 });
    await panel.locator("#quickDelay").press("Tab");
    await eventually("Flow entry starts from a different saved Quick source", async () => {
      const entry = await worker.evaluate(async (targetTabId) =>
        (await chrome.storage.local.get("aipm.uiByTab.v2"))["aipm.uiByTab.v2"]?.[String(targetTabId)], tabId);
      assert.equal(entry?.mode, "quick");
      assert.equal(entry?.quick?.prompt, oldQuick);
    });

    await panel.getByRole("button", { name: "手順を貼り付け", exact: true }).click();
    assert.equal(await panel.locator("#flowSelectorField").isVisible(), false, "one Flow needs no extra selector");
    await panel.locator("#flowGuide > summary").click();
    await panel.evaluate(() => {
      globalThis.__AIPM_GUIDE_COPIES__ = [];
      globalThis.__AIPM_GUIDE_COPY_FAIL__ = false;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          async writeText(text) {
            if (globalThis.__AIPM_GUIDE_COPY_FAIL__) throw new Error("fixture clipboard denied");
            globalThis.__AIPM_GUIDE_COPIES__.push(text);
          }
        }
      });
    });
    assert.equal(await panel.locator("#flowGuideText").inputValue(), buildAipmFlowMetaPrompt());
    await panel.getByRole("button", { name: "AI用の作成ガイドをコピー", exact: true }).click();
    await eventually("empty-goal guide copies the exact shared specification", async () => {
      assert.deepEqual(await panel.evaluate(() => globalThis.__AIPM_GUIDE_COPIES__), [buildAipmFlowMetaPrompt()]);
    });
    const goal = "日本語の手順を二段階で進める";
    await panel.getByRole("textbox", { name: "やりたいこと（任意）", exact: true }).fill(goal);
    await panel.locator("#copyFlowGuide").focus();
    await panel.keyboard.press("Enter");
    await eventually("keyboard guide copy includes the optional goal", async () => {
      assert.deepEqual(await panel.evaluate(() => globalThis.__AIPM_GUIDE_COPIES__), [
        buildAipmFlowMetaPrompt(), buildAipmFlowMetaPrompt(goal)
      ]);
    });
    await panel.evaluate(() => { globalThis.__AIPM_GUIDE_COPY_FAIL__ = true; });
    await panel.locator("#copyFlowGuide").click();
    await eventually("clipboard failure exposes the entire manually selectable guide", async () => {
      assert.equal(await panel.locator("#flowGuideDetails").evaluate((node) => node.open), true);
      assert.equal(await panel.locator("#flowGuideText").inputValue(), buildAipmFlowMetaPrompt(goal));
      assert.equal(await panel.locator("#flowGuideText").evaluate((node) =>
        document.activeElement === node && node.selectionStart === 0 && node.selectionEnd === node.value.length), true);
      assert.match(await panel.locator("#flowGuideCopyStatus").innerText(), /Ctrl\+C/);
    });
    assert.equal(await panel.locator("#flowGoal").inputValue(), goal);
    assert.deepEqual(await fixtureSends(chat), [], "guide copy must not submit a Prompt");
    assert.equal(await activeRunFor(worker, tabId), null, "guide copy must not create a Run");
    await panel.screenshot({ path: path.join(screenshotDirectory, "guide-copy-fallback.png"), fullPage: true });
    await panel.locator("#flowGuide > summary").click();

    for (const source of [
      'flow invalid { draft """送信しない""" }',
      'flow invalid { repeat 51 { send """上限超過""" } }',
      `flow invalid { send """${"x".repeat(65_537)}""" }`
    ]) {
      await panel.getByRole("textbox", { name: "AIが作った手順（AIPM Flow）", exact: true }).fill(source);
      await eventually("invalid Flow cannot keep a stale executable preview", async () => {
        assert.equal(await panel.locator("#flowError").isVisible(), true);
        assert.equal(await panel.locator("#start").isEnabled(), false);
        assert.equal(await panel.locator("#flowPlanSteps li").count(), 0);
        assert.match(await panel.locator("#flowError").innerText(), /\d+行 \d+列/);
      });
    }

    const prompt = "新しいFlowで確認した指示\n行と空白を保持する。";
    const source = `flow unselected { send """DO NOT SEND UNSELECTED FLOW""" }
flow selected {
  send """${prompt}"""
  wait 1h
  send """停止後には送らない次の指示"""
}`;
    await panel.locator("#flowText").fill(source);
    await eventually("multiple Flow choices come from the pasted source", async () => {
      assert.equal(await panel.locator("#flowSelector option").count(), 2);
      assert.equal(await panel.locator("#flowSelectorField").isVisible(), true);
    });
    await panel.getByRole("combobox", { name: "実行するFlow", exact: true }).selectOption("1");
    await eventually("Flow entry previews the selected full execution plan", async () => {
      assert.match(await panel.locator("#flowInputStatus").innerText(), /形式と上限を確認済み/);
      assert.equal(await panel.locator("#flowPreviewSelected").textContent(), "selected");
      assert.equal(await panel.locator("#flowPlannedSends").innerText(), "2");
      assert.equal(await panel.locator("#flowPreviewRange").textContent(), "Flow全体");
      assert.equal(await panel.locator("#flowSavedRange").isVisible(), false);
      assert.equal(await panel.locator("#flowPlanSteps li").count(), 3);
      assert.equal(await panel.locator("#flowPlanSteps pre").first().textContent(), prompt);
      assert.match(await panel.locator("#flowPreviewTarget").innerText(), /Private fixture title/);
      assert.equal(await panel.locator("#targetTab").inputValue(), String(tabId));
      assert.match(await panel.locator("#start").innerText(), /自動送信.*2回/);
    });
    assert.deepEqual(await fixtureSends(chat), [], "input, validation and preview must not send");
    assert.equal(await activeRunFor(worker, tabId), null, "preview must not create a Run");
    await otherChat.bringToFront();
    assert.equal(await panel.locator("#targetTab").inputValue(), String(tabId), "visiting the authoring AI tab must not retarget execution");

    await verifyCompactPanelLayout(panel, screenshotDirectory, "flow");
    assert.equal(await panel.locator("#flowPreviewRange").isVisible(), false);
    await panel.locator("#flowPreviewDetails > summary").focus();
    await panel.keyboard.press("Enter");
    assert.equal(await panel.locator("#flowPreviewRange").isVisible(), true);
    assert.equal(await panel.locator("#flowPreviewRange").innerText(), "Flow全体");
    await panel.keyboard.press("Enter");
    assert.equal(await panel.locator("#flowPlanSteps pre").first().isVisible(), false);
    await panel.locator("#flowPlanSteps summary").first().click();
    assert.equal(await panel.locator("#flowPlanSteps pre").first().isVisible(), true);
    assert.equal(await panel.locator("#flowPlanSteps pre").first().textContent(), prompt);
    for (const width of [320, 360, 400]) {
      await panel.setViewportSize({ width, height: 700 });
      const layout = await panel.evaluate(() => {
        const controls = [...document.querySelectorAll("#flowEntryPanel textarea, #flowEntryPanel select, #flowEntryPanel button, .entry-modes button")]
          .filter((node) => node.getClientRects().length > 0);
        return {
          width: document.documentElement.scrollWidth,
          viewport: innerWidth,
          clipped: controls.filter((node) => {
            const box = node.getBoundingClientRect();
            return box.left < -0.5 || box.right > innerWidth + 0.5;
          }).map((node) => node.id),
          unlabelled: controls.filter((node) => node.tagName !== "BUTTON" &&
            !node.labels?.length && !node.getAttribute("aria-label")).map((node) => node.id)
        };
      });
      assert.ok(layout.width <= layout.viewport, `${width}px Flow entry must not overflow horizontally`);
      assert.deepEqual(layout.clipped, [], `${width}px Flow controls must fit`);
      assert.deepEqual(layout.unlabelled, [], "Flow inputs require accessible labels");
      await panel.screenshot({ path: path.join(screenshotDirectory, `flow-preview-${width}.png`), fullPage: true });
    }

    await confirmStartReadiness(panel, chat, tabId, "before reviewed Flow Start");
    await panel.evaluate(() => {
      globalThis.__AIPM_FLOW_START_MESSAGES__ = [];
      const message = document.querySelector("#message");
      new MutationObserver(() => {
        if (globalThis.__AIPM_FLOW_START_MESSAGES__.length < 40) {
          globalThis.__AIPM_FLOW_START_MESSAGES__.push(message.textContent);
        }
      }).observe(message, { childList: true, characterData: true, subtree: true });
    });
    await panel.locator("#start").click();
    const startedRun = await eventually("the reviewed Flow replaces the old saved Quick source before Start", async () => {
      const run = await activeRunFor(worker, tabId);
      assert.equal(run?.status, "running");
      assert.equal(run?.cursor?.sendsCompleted, 1);
      assert.equal(run?.plannedSends, 2);
      assert.deepEqual(run?.workflow?.steps.filter((step) => step.type === "prompt").map((step) => step.prompt), [
        prompt, "停止後には送らない次の指示"
      ]);
      return run;
    });
    assert.deepEqual(await fixtureSends(chat), [prompt]);
    await verifyActivePanelLayout(panel, screenshotDirectory, "running");
    await eventually("Pause reveals Resume while preserving Stop", async () => {
      // A fresh user operation is required after a revision conflict; never
      // bypass the production expectedRunId/expectedStateRevision checks.
      if (await panel.locator("#runCard").getAttribute("data-state") !== "user-paused") {
        await panel.locator("#refreshTabs").click();
        if (await panel.locator("#pause").isEnabled()) await panel.locator("#pause").click();
      }
      assert.equal(await panel.locator("#runCard").getAttribute("data-state"), "user-paused");
      assert.equal(await panel.locator("#resume").isEnabled(), true);
    });
    await verifyActivePanelLayout(panel, screenshotDirectory, "user-paused");
    await eventually("Resume restores active controls", async () => {
      if (await panel.locator("#runCard").getAttribute("data-state") !== "running") {
        await panel.locator("#refreshTabs").click();
        if (await panel.locator("#resume").isEnabled()) await panel.locator("#resume").click();
      }
      assert.equal(await panel.locator("#runCard").getAttribute("data-state"), "running");
      assert.equal(await panel.locator("#pause").isEnabled(), true);
    });
    await panel.locator("#flowText").fill('flow later { send """編集後の別指示""" }');
    await panel.locator("#quickTab").click();
    await panel.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await eventually("Stop remains reachable while another input is being edited", async () => {
      assert.equal(await panel.locator("#stop").isEnabled(), true);
      assert.equal(await panel.locator("#runCard").getAttribute("data-active"), "true");
      assert.equal(await panel.locator("#runCard").evaluate((node) => getComputedStyle(node).position), "sticky");
      const box = await panel.locator("#stop").boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 400 && box.y >= 0 && box.y + box.height <= 700);
      const run = await activeRunFor(worker, tabId);
      assert.equal(run?.runId, startedRun.runId);
      assert.deepEqual(run?.workflow, startedRun.workflow, "later edits must not alter the active Run snapshot");
    });
    await panel.screenshot({ path: path.join(screenshotDirectory, "flow-active-stop.png"), fullPage: true });
    await panel.screenshot({ path: path.join(screenshotDirectory, "flow-active-stop-viewport.png") });
    console.log(`Flow entry fixture screenshots: ${screenshotDirectory}`);
    await stopRunAndWaitForTerminal(panel, worker, tabId, "Flow authoring fixture Run stopped");
    assert.deepEqual(await fixtureSends(chat), [prompt], "Stop must prevent the later instruction");
    await panel.locator("#flowTab").click();
    const longCheckpoint = "長い確認事項を最後まで確認してください。".repeat(60);
    await panel.locator("#flowText").fill(`flow confirm { checkpoint "表示された指示を確認してください" checkpoint "${longCheckpoint}" send """確認せずには送らない""" }`);
    await confirmStartReadiness(panel, chat, tabId, "before checkpoint presentation");
    await panel.locator("#start").click();
    await eventually("checkpoint expands confirmation guidance", async () => {
      assert.equal(await panel.locator("#runCard").getAttribute("data-state"), "confirmation-required");
      assert.match(await panel.locator("#message").innerText(), /表示された指示を確認してください/);
      assert.equal(await panel.locator("#resume").isEnabled(), true);
    });
    await verifyActivePanelLayout(panel, screenshotDirectory, "confirmation-required");
    await panel.locator("#refreshTabs").click();
    await panel.locator("#resume").click();
    await eventually("long checkpoint remains readable with Stop outside the scrolling guidance", async () => {
      assert.ok((await panel.locator("#message").innerText()).includes(longCheckpoint));
      assert.equal(await panel.locator("#runGuidance").evaluate((node) => node.scrollHeight > node.clientHeight), true);
      assert.equal(await panel.locator("#runGuidance #stop").count(), 0);
    });
    await verifyActivePanelLayout(panel, screenshotDirectory, "confirmation-required", "long-checkpoint");
    await stopRunAndWaitForTerminal(panel, worker, tabId, "confirmation fixture Run stopped");
    assert.deepEqual(await fixtureSends(chat), [prompt], "checkpoint disclosure and Stop never send the next instruction");
  } catch (error) {
    const diagnostics = await panel.evaluate(async () => {
      const text = (id) => document.getElementById(id)?.textContent;
      const selectedTab = document.getElementById("targetTab")?.value;
      const stored = await chrome.storage.local.get("aipm.uiByTab.v2");
      return {
        selectedTab,
        message: text("message"),
        nextAction: text("nextAction"),
        editorNotice: text("editorStateNotice"),
        flowInputStatus: text("flowInputStatus"),
        flowError: text("flowError"),
        flowPlanError: text("flowPlanError"),
        startMessages: globalThis.__AIPM_FLOW_START_MESSAGES__,
        storedEditor: stored["aipm.uiByTab.v2"]?.[selectedTab]
      };
    });
    console.error("Side Panel Flow fixture failure:", JSON.stringify({ pageErrors, ...diagnostics }));
    await panel.screenshot({ path: path.join(screenshotDirectory, "flow-entry-failure.png"), fullPage: true });
    throw error;
  } finally {
    await panel.close();
    await chat.close();
  }
}

async function runC102UserRace({ sidePanel, page, tabId, worker, prompt }) {
  await page.goto("https://chatgpt.com/c/c10-2-user-race");
  const pasteCountBeforeRace = await page.evaluate(() => {
    sessionStorage.removeItem("aipm.fixture.sends");
    globalThis.__AIPM_FIXTURE_SET_LIVE_DEPTHS__(6, 7);
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT__ = true;
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_DELAY_MS__ = 5_000;
    globalThis.__AIPM_FIXTURE_LIVE_TEMPORARY_UNRECOGNIZED__ = true;
    globalThis.__AIPM_FIXTURE_LIVE_FILE_TILE_STYLE__ = true;
    return globalThis.__AIPM_FIXTURE_PROSEMIRROR__.pasteEvents;
  });
  const composerBox = await page.locator("#prompt-textarea").boundingBox();
  assert.ok(composerBox);
  await selectReadyTarget(sidePanel, page, tabId);
  await configureQuickRun(sidePanel, { prompt, repeat: 1, delaySeconds: 0 });
  await confirmStartReadiness(sidePanel, page, tabId, "before C10.2 user-race Start");

  /* Only the irreversible click remains concurrent with the trusted user input. */
  const startPromise = clickStartOnly(sidePanel);
  await page.waitForFunction(
    (before) => globalThis.__AIPM_FIXTURE_PROSEMIRROR__.pasteEvents > before,
    pasteCountBeforeRace,
    { polling: "raf", timeout: TEST_TIMEOUT_MS }
  );
  await page.mouse.click(
    composerBox.x + composerBox.width / 2,
    composerBox.y + composerBox.height / 2
  );
  await startPromise;
  await eventually("C10.2 user interaction invalidates fallback provenance", async () => {
    assert.equal((await activeRunFor(worker, tabId))?.status, "paused");
  });
  assert.deepEqual(await fixtureSends(page), []);
  await stopRunAndWaitForTerminal(
    sidePanel,
    worker,
    tabId,
    "C10.2 user-race Run reaches terminal Stop before the Stop-race scenario"
  );
}

async function runC102StopRace({ sidePanel, page, tabId, worker, prompt }) {
  await page.goto("https://chatgpt.com/c/c10-2-stop-race");
  const pasteCountBeforeStop = await page.evaluate(() => {
    sessionStorage.removeItem("aipm.fixture.sends");
    globalThis.__AIPM_FIXTURE_SET_LIVE_DEPTHS__(6, 7);
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT__ = true;
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_DELAY_MS__ = 5_000;
    globalThis.__AIPM_FIXTURE_LIVE_TEMPORARY_UNRECOGNIZED__ = true;
    globalThis.__AIPM_FIXTURE_LIVE_FILE_TILE_STYLE__ = true;
    return globalThis.__AIPM_FIXTURE_PROSEMIRROR__.pasteEvents;
  });
  await selectReadyTarget(sidePanel, page, tabId);
  await configureQuickRun(sidePanel, { prompt, repeat: 1, delaySeconds: 0 });
  await confirmStartReadiness(sidePanel, page, tabId, "before C10.2 Stop-race Start");

  /* Stop still races the in-flight Start; only configuration/readiness moved out. */
  const startPromise = clickStartOnly(sidePanel);
  await page.waitForFunction(
    (before) => globalThis.__AIPM_FIXTURE_PROSEMIRROR__.pasteEvents > before,
    pasteCountBeforeStop,
    { polling: "raf", timeout: TEST_TIMEOUT_MS }
  );
  await sidePanel.locator("#stop").click();
  await startPromise;
  await eventually("C10.2 Stop wins over late fallback settlement", async () => {
    assert.equal((await activeRunFor(worker, tabId))?.status, "stopped");
  });
  assert.deepEqual(await fixtureSends(page), []);
}

console.log(`Browser profile: ${browserProfile}`);
console.log(`Browser groups: ${selectedScenarioGroups.map((group) => group.id).join(", ")}`);

const browserPath = browserExecutable();
const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), "aipm-browser-e2e-"));
let context;

try {
  context = await chromium.launchPersistentContext(profilePath, {
    executablePath: browserPath,
    headless: true,
    viewport: { width: 1000, height: 760 },
    args: [
      `--disable-extensions-except=${repoRoot}`,
      `--load-extension=${repoRoot}`
    ]
  });

  const worker = context.serviceWorkers().find((candidate) => candidate.url().endsWith("/src/background.js"))
    ?? await context.waitForEvent("serviceworker", {
      timeout: 10_000,
      predicate: (candidate) => candidate.url().endsWith("/src/background.js")
    });
  const extensionId = new URL(worker.url()).host;

  await context.route("https://chatgpt.com/**", async (route) => {
    if (route.request().resourceType() === "document") {
      await route.fulfill({ status: 200, contentType: "text/html", body: fixtureHtml() });
      return;
    }
    await route.abort();
  });

  const firstChat = await context.newPage();
  const secondChat = await context.newPage();
  await Promise.all([
    firstChat.goto("https://chatgpt.com/c/fixture-first"),
    secondChat.goto("https://chatgpt.com/c/fixture-second")
  ]);

  const composerFixture = await firstChat.evaluate(() => {
    const composer = document.querySelector("#prompt-textarea");
    return {
      tagName: composer?.tagName,
      proseMirror: composer?.classList.contains("ProseMirror"),
      contenteditable: composer?.getAttribute("contenteditable"),
      directChildren: [...(composer?.children ?? [])].map((node) => node.tagName),
      trailingBreak: composer?.querySelector(":scope > p > br.ProseMirror-trailingBreak") !== null
    };
  });
  assert.deepEqual(composerFixture, {
    tagName: "DIV",
    proseMirror: true,
    contenteditable: "true",
    directChildren: ["P"],
    trailingBreak: true
  });

  const firstTabId = await tabIdFor(worker, firstChat);
  const secondTabId = await tabIdFor(worker, secondChat);
  assert.notEqual(firstTabId, secondTabId, "fixture tabs must have distinct browser identities");

  if (runsScenarioGroup("settings-wiring")) {
    /* Settings Wiring: exercise the real Options page and two exact tabs before
       the long reliability fixture. The temporary tabs are closed and their
       editor entries cleaned before the main fixture starts. */
    const settingsChatA = await context.newPage();
    const settingsChatB = await context.newPage();
    await Promise.all([
      settingsChatA.goto("https://chatgpt.com/c/settings-fixture-a"),
      settingsChatB.goto("https://chatgpt.com/c/settings-fixture-b")
    ]);
    const settingsTabA = await tabIdFor(worker, settingsChatA);
    const settingsTabB = await tabIdFor(worker, settingsChatB);
    await worker.evaluate(async () => {
    await chrome.storage.local.set({
      "aipm.settings.v1": {
        defaults: {
          keepAwake: true,
          delaySeconds: 2,
          maxSends: 20,
          recoveryMode: "completion"
        }
      }
    });
  });
  const settingsPanel = await context.newPage();
  await settingsPanel.goto(`chrome-extension://${extensionId}/src/sidepanel.html`);
  await selectTarget(settingsPanel, settingsTabA);
  await eventually("Settings X initializes only missing editor A", async () => {
    assert.equal(await settingsPanel.locator("#keepAwake").isChecked(), true);
    assert.equal(await settingsPanel.locator("#quickDelay").inputValue(), "2");
    assert.equal(await settingsPanel.locator("#workflowMaxSends").inputValue(), "20");
    assert.equal(await settingsPanel.locator("#recoveryMode").inputValue(), "completion");
  });

  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/src/options.html`);
  await optionsPage.locator("#keepAwake").uncheck();
  await optionsPage.locator("#delaySeconds").fill("9");
  await optionsPage.locator("#delaySeconds").press("Tab");
  await optionsPage.locator("#maxSends").fill("12");
  await optionsPage.locator("#maxSends").press("Tab");
  await optionsPage.locator("#recoveryMode").selectOption("safe");
  await eventually("Options persists Settings Y", async () => {
    const stored = await worker.evaluate(async () =>
      (await chrome.storage.local.get("aipm.settings.v1"))["aipm.settings.v1"]
    );
    assert.equal(stored?.defaults?.keepAwake, false);
    assert.equal(stored?.defaults?.delaySeconds, 9);
    assert.equal(stored?.defaults?.maxSends, 12);
    assert.equal(stored?.defaults?.recoveryMode, "safe");
  });
  assert.equal(await settingsPanel.locator("#quickDelay").inputValue(), "2", "Settings change must not replace editor A DOM");
  assert.equal(await settingsPanel.locator("#workflowMaxSends").inputValue(), "20");
  assert.equal(await settingsPanel.locator("#recoveryMode").inputValue(), "completion");

  await selectTarget(settingsPanel, settingsTabB);
  await eventually("Settings Y initializes only new editor B", async () => {
    assert.equal(await settingsPanel.locator("#keepAwake").isChecked(), false);
    assert.equal(await settingsPanel.locator("#quickDelay").inputValue(), "9");
    assert.equal(await settingsPanel.locator("#workflowMaxSends").inputValue(), "12");
    assert.equal(await settingsPanel.locator("#recoveryMode").inputValue(), "safe");
  });
  await eventually("editor A was saved with X and editor B remains unsaved", async () => {
    const map = await worker.evaluate(async () =>
      (await chrome.storage.local.get("aipm.uiByTab.v2"))["aipm.uiByTab.v2"] ?? {}
    );
    assert.equal(map[String(settingsTabA)]?.quick?.delay, "2");
    assert.equal(map[String(settingsTabA)]?.workflow?.maxSends, 20);
    assert.equal(Object.hasOwn(map, String(settingsTabB)), false);
  });
  await Promise.all([settingsPanel.close(), optionsPage.close()]);
  await Promise.all([settingsChatA.close(), settingsChatB.close()]);
  await worker.evaluate(async () => chrome.storage.local.remove("aipm.settings.v1"));
    await eventually("temporary Settings editor entries cleaned on tab close", async () => {
      const map = await worker.evaluate(async () =>
        (await chrome.storage.local.get("aipm.uiByTab.v2"))["aipm.uiByTab.v2"] ?? {}
      );
      assert.equal(Object.hasOwn(map, String(settingsTabA)), false);
      assert.equal(Object.hasOwn(map, String(settingsTabB)), false);
    });
  }

  const sidePanel = await context.newPage();
  await sidePanel.goto(`chrome-extension://${extensionId}/src/sidepanel.html`);

  await eventually("two ChatGPT targets", async () => {
    assert.equal(await sidePanel.locator("#targetTab option").count(), 2);
    const text = await sidePanel.locator("#targetTab").innerText();
    assert.match(text, /Private fixture title/);
    assert.doesNotMatch(text, /fixture-first|fixture-second/);
  });

  if (runsScenarioGroup("sidepanel-multitab")) {
    // Use real host-permission Tab.title and window APIs through the production panel.
    await firstChat.evaluate(() => { document.title = "公開準備の相談"; });
    await secondChat.evaluate(() => { document.title = "公開準備の相談"; });
    await selectTarget(sidePanel, firstTabId);
    await worker.evaluate(async (id) => chrome.tabs.update(id, { active: true }), secondTabId);
    await sidePanel.evaluate(() => document.querySelector("#refreshTabs").click());
    await eventually("same-title targets retain selected and displayed identity separately", async () => {
      assert.equal(await sidePanel.locator("#targetTab").inputValue(), String(firstTabId));
      assert.match(await sidePanel.locator(`#targetTab option[value="${firstTabId}"]`).innerText(), /公開準備の相談 · 操作対象/);
      assert.match(await sidePanel.locator(`#targetTab option[value="${secondTabId}"]`).innerText(), /公開準備の相談 · 表示中/);
      assert.equal(await sidePanel.locator("#targetCard").getAttribute("data-target-state"), "selected");
    });
    await worker.evaluate(async (id) => chrome.tabs.update(id, { active: true }), firstTabId);
    await sidePanel.evaluate(() => document.querySelector("#refreshTabs").click());
    await eventually("target and displayed highlight", async () => {
      assert.equal(await sidePanel.locator("#targetCard").getAttribute("data-target-state"), "selected-displayed");
    });
    const originalWindowId = await sidePanel.evaluate(async () => (await chrome.windows.getCurrent()).id);
    await worker.evaluate(async (tabId) => chrome.windows.create({ tabId, focused: false }), secondTabId);
    await sidePanel.evaluate(() => document.querySelector("#refreshTabs").click());
    await eventually("active tab in another window is not displayed in this panel window", async () => {
      assert.doesNotMatch(await sidePanel.locator(`#targetTab option[value="${secondTabId}"]`).innerText(), /表示中/);
      assert.match(await sidePanel.locator(`#targetTab option[value="${firstTabId}"]`).innerText(), /操作対象 · 表示中/);
      assert.equal(await sidePanel.locator("#targetTab").inputValue(), String(firstTabId));
    });
    await worker.evaluate(async ({ tabId, windowId }) => chrome.tabs.move(tabId, { windowId, index: -1 }),
      { tabId: secondTabId, windowId: originalWindowId });
    await firstChat.evaluate(() => { document.title = "更新した会話タイトル"; });
    await sidePanel.evaluate(() => document.querySelector("#refreshTabs").click());
    await eventually("title changes are ephemeral display updates", async () => {
      assert.match(await sidePanel.locator(`#targetTab option[value="${firstTabId}"]`).innerText(), /更新した会話タイトル/);
      assert.equal(await sidePanel.locator("#targetTab").inputValue(), String(firstTabId));
      const stored = await worker.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
      assert.doesNotMatch(stored, /公開準備の相談|更新した会話タイトル/);
    });
    assert.equal(await sidePanel.locator("#targetTechnicalDetails").getAttribute("open"), null);
    assert.match(await sidePanel.locator("#targetTechnicalInfo").textContent(), new RegExp(`タブID: ${firstTabId}`));
    /* Multi-Tab Visibility: presentation metadata stays session-only and exact
       target selection remains the Side Panel's existing operation. */
    await selectTarget(sidePanel, firstTabId);
  await eventually("presentation controls ready", async () => {
    assert.equal(await sidePanel.locator("#targetAlias").isEnabled(), true);
    assert.equal(await sidePanel.locator("#targetColor").isEnabled(), true);
    assert.equal(await sidePanel.locator("#targetGroup").isEnabled(), true);
  });
  await sidePanel.locator("#targetDisplaySettings > summary").click();
  await sidePanel.locator("#targetAlias").fill("Fixture 調査");
  await sidePanel.locator("#targetAlias").press("Tab");
  await sidePanel.locator("#targetColor").selectOption("purple");
  await sidePanel.locator("#targetGroup").fill("調査");
  await sidePanel.locator("#targetGroup").press("Tab");
  await eventually("first target presentation", async () => {
    assert.equal(await sidePanel.locator("#targetPresentationName").innerText(), "Fixture 調査");
    assert.equal(await sidePanel.locator("#targetPresentationGroup").innerText(), "調査");
    assert.equal(await sidePanel.locator("#targetPresentationSummary").getAttribute("data-color"), "purple");
    assert.match(await sidePanel.locator("#targetPresentationMeta").innerText(), /更新した会話タイトル/);
  });

  await selectTarget(sidePanel, secondTabId);
  await sidePanel.locator("#targetAlias").fill("<img src=x onerror=alert(1)>");
  await sidePanel.locator("#targetAlias").press("Tab");
  await eventually("presentation XSS remains text", async () => {
    assert.equal(await sidePanel.locator("#targetPresentationName").innerText(), "<img src=x onerror=alert(1)>");
    assert.equal(await sidePanel.locator("#targetPresentationSummary img").count(), 0);
  });
  await sidePanel.locator("#targetAlias").fill("Fixture QA");
  await sidePanel.locator("#targetAlias").press("Tab");
  await sidePanel.locator("#targetColor").selectOption("green");
  await sidePanel.locator("#targetGroup").fill("テスト");
  await sidePanel.locator("#targetGroup").press("Tab");
  await eventually("two exact presentation labels", async () => {
    const labels = await sidePanel.locator("#targetTab option").allInnerTexts();
    assert.ok(
      labels.some((label) => label.startsWith("Fixture 調査 · 更新した会話タイトル")),
      `first presentation missing from ${JSON.stringify(labels)}`
    );
    assert.ok(
      labels.some((label) => label.startsWith("Fixture QA · 公開準備の相談")),
      `second presentation missing from ${JSON.stringify(labels)}`
    );
  });

  for (const width of [320, 360, 400, 480, 720]) {
    await sidePanel.setViewportSize({ width, height: 700 });
    const layout = await sidePanel.evaluate(() => {
      const actions = document.querySelector(".actions").getBoundingClientRect();
      const buttons = [...document.querySelectorAll(".actions button")].map((button) => button.getBoundingClientRect());
      const presentationControls = [...document.querySelectorAll(
        ".target-presentation-fields input, .target-presentation-fields select"
      )].map((node) => node.getBoundingClientRect());
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        actionLeft: actions.left,
        actionRight: actions.right,
        buttonRows: new Set(buttons.map((box) => Math.round(box.top))).size,
        clippedPresentationControls: presentationControls
          .filter((box) => box.left < -0.5 || box.right > innerWidth + 0.5).length
      };
    });
    assert.ok(layout.documentWidth <= layout.viewportWidth, `${width}px Side Panel must not overflow horizontally`);
    assert.ok(layout.actionLeft >= 0 && layout.actionRight <= layout.viewportWidth);
    assert.equal(await sidePanel.locator("#runDetails").isVisible(), false, "idle hides the inactive controls; active geometry is checked with a real Run below");
    assert.equal(layout.clippedPresentationControls, 0, `${width}px presentation controls must remain reachable`);
  }
  await sidePanel.setViewportSize({ width: 320, height: 700 });
  await sidePanel.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  assert.notEqual(await sidePanel.locator("#runCard").getAttribute("data-active"), "true");
  assert.notEqual(await sidePanel.locator("#runCard").evaluate((card) => getComputedStyle(card).position), "sticky",
    "idle Run guidance must not cover the Flow authoring controls; active Run stickiness is checked below");
    await sidePanel.locator("#targetDisplaySettings > summary").click();
    await sidePanel.evaluate(() => scrollTo(0, 0));
    await verifySidePanelFlowEntry({ context, worker, extensionId, otherChat: secondChat });
  }

  if (runsScenarioGroup("workspace-boundary")) {
    /* Phase 4B Workspace DOM gate. This page remains storage + pure compile only;
       the fixture checks the real extension-page layout at the three supported
       narrow widths and deliberately performs no editor save or Run action. */
    const workspacePage = await context.newPage();
  await workspacePage.goto(`chrome-extension://${extensionId}/src/workspace.html`);
  await eventually("Workspace initialized", async () => {
    assert.equal(await workspacePage.locator(".workspace").getAttribute("aria-busy"), "false");
  });
  // Follow the documented entry points by their actual accessible names.
  const gettingStarted = fs.readFileSync(path.join(repoRoot, "docs/getting-started/README.md"), "utf8");
  for (const [page, role, name] of [
    [sidePanel, "button", "ワークスペース"],
    [sidePanel, "button", "クイック"],
    [sidePanel, "combobox", "操作するChatGPTタブ"],
    [workspacePage, "button", "Flow / ワークフロー編集"]
  ]) {
    assert.equal(await page.getByRole(role, { name, exact: true }).isVisible(), true, name);
    assert.ok(gettingStarted.includes(`「${name}」`), `Getting Started must name the visible control: ${name}`);
  }
  assert.equal(await workspacePage.getByRole("button", { name: "実行一覧", exact: true }).isVisible(), true);
  assert.equal(await workspacePage.getByRole("button", { name: "一時停止・確認待ち・安全停止", exact: true }).isVisible(), true);
  const visibilityTabIds = [700001, 700002, 700003, 700004];
  await workspacePage.evaluate(async (tabIds) => {
    const [runningTab, pausedTab, completedTab, failClosedTab] = tabIds;
    const runKey = (tabId) => `aipm.activeRun.v2.tab.${tabId}`;
    const makeRun = ({
      runId,
      conversationKey,
      status,
      sendsCompleted,
      plannedSends,
      pauseReason = null,
      resumable = true,
      updatedAt
    }) => ({
      schemaVersion: 3,
      runId,
      conversationKey,
      status,
      plannedSends,
      pauseReason,
      resumable,
      cursor: { stepIndex: 0, sendsCompleted },
      workflow: {
        name: "Fixture visibility",
        maxSends: 50,
        steps: [{ id: "fixture-step", type: "prompt", delivery: "send" }]
      },
      startedAt: "2026-08-29T01:00:00.000Z",
      updatedAt
    });
    await chrome.storage.local.set({
      [runKey(runningTab)]: makeRun({
        runId: "visibility-running",
        conversationKey: "chatgpt:c:same-fixture-conversation",
        status: "running",
        sendsCompleted: 12,
        plannedSends: 40,
        updatedAt: "2026-08-29T01:04:00.000Z"
      }),
      [runKey(pausedTab)]: makeRun({
        runId: "visibility-paused",
        conversationKey: "chatgpt:c:same-fixture-conversation",
        status: "paused",
        pauseReason: "user-pause",
        sendsCompleted: 7,
        plannedSends: 20,
        updatedAt: "2026-08-29T01:03:00.000Z"
      }),
      [runKey(completedTab)]: makeRun({
        runId: "visibility-completed",
        conversationKey: "chatgpt:c:completed-fixture",
        status: "completed",
        sendsCompleted: 5,
        plannedSends: 5,
        updatedAt: "2026-08-29T01:02:00.000Z"
      }),
      [runKey(failClosedTab)]: makeRun({
        runId: "visibility-fail-closed",
        conversationKey: "chatgpt:c:attention-fixture",
        status: "paused",
        pauseReason: "document_identity_unconfirmed",
        resumable: false,
        sendsCompleted: 2,
        plannedSends: 40,
        updatedAt: "2026-08-29T01:01:00.000Z"
      })
    });
    const key = "aipm.tabAliases.v1";
    const stored = await chrome.storage.session.get(key);
    await chrome.storage.session.set({
      [key]: {
        ...(stored[key] ?? {}),
        [String(runningTab)]: { alias: "Claude", color: "blue", group: "共有" },
        [String(pausedTab)]: { alias: "Claude", color: "green", group: "共有" },
        [String(completedTab)]: { alias: "完了確認", color: "purple", group: "完了" },
        [String(failClosedTab)]: { alias: "要確認", color: "red", group: "注意" }
      }
    });
  }, visibilityTabIds);

  await eventually("Workspace multi-run visibility", async () => {
    assert.equal(await workspacePage.locator("#runList .run-row").count(), 4);
    const text = await workspacePage.locator("#runList").innerText();
    for (const expected of ["実行中の保存記録", "一時停止中", "完了", "安全のため停止", "12 / 40", "7 / 20"]) {
      assert.ok(text.includes(expected), `Workspace list did not include ${expected}`);
    }
    assert.equal((text.match(/Claude/g) ?? []).length, 2);
  });

  const sidePanelSelectionBefore = await workspacePage.evaluate(async () => {
    const stored = await chrome.storage.local.get("aipm.selectedTab.v1");
    return stored["aipm.selectedTab.v1"];
  });
  await workspacePage.locator("#groupFilter").selectOption({ label: "共有" });
  assert.equal(await workspacePage.locator("#runList .run-row").count(), 2);
  await workspacePage.locator("#runList .run-row").first().click();
  const sidePanelSelectionAfter = await workspacePage.evaluate(async () => {
    const stored = await chrome.storage.local.get("aipm.selectedTab.v1");
    return stored["aipm.selectedTab.v1"];
  });
  assert.equal(sidePanelSelectionAfter, sidePanelSelectionBefore, "Workspace selection must remain memory-only");
  await workspacePage.locator("#groupFilter").selectOption("");

  for (const width of [380, 420, 480]) {
    await workspacePage.setViewportSize({ width, height: 800 });
    const layout = await workspacePage.evaluate(() => {
      const controls = [...document.querySelectorAll(
        "#groupFilter, #runList .run-row, #runList .status-badge"
      )].map((node) => node.getBoundingClientRect()).filter((box) => box.width > 0 && box.height > 0);
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        clipped: controls.filter((box) => box.left < -0.5 || box.right > innerWidth + 0.5).length
      };
    });
    assert.ok(layout.documentWidth <= layout.viewportWidth, `${width}px Run overview must not overflow`);
    assert.equal(layout.clipped, 0, `${width}px Run overview controls must remain reachable`);
  }

  await workspacePage.evaluate(async (tabIds) => {
    await chrome.storage.local.remove(tabIds.map((tabId) => `aipm.activeRun.v2.tab.${tabId}`));
    const key = "aipm.tabAliases.v1";
    const stored = await chrome.storage.session.get(key);
    const next = { ...(stored[key] ?? {}) };
    for (const tabId of tabIds) delete next[String(tabId)];
    await chrome.storage.session.set({ [key]: next });
  }, visibilityTabIds);
  await eventually("fixture visibility Runs cleaned", async () => {
    assert.equal(await workspacePage.locator("#runList .run-row").count(), 0);
  });

  await workspacePage.getByRole("button", { name: "Flow / ワークフロー編集", exact: true }).click();
  await workspacePage.locator("#editorTabId").fill(String(firstTabId));
  await workspacePage.locator("#loadEditorTarget").click();
  await workspacePage.locator("#editorContent").waitFor({ state: "visible" });
  for (const [role, name] of [["tab", "ワークフローエディター"], ["button", "編集状態を保存"]]) {
    assert.equal(await workspacePage.getByRole(role, { name, exact: true }).isVisible(), true, name);
    assert.ok(gettingStarted.includes(`「${name}」`), `Getting Started must name the visible control: ${name}`);
  }
  assert.equal(await workspacePage.getByRole("textbox", { name: "AIPM Flowテキスト", exact: true }).isVisible(), true);
  await workspacePage.locator("#workspaceFlowText").fill('flow fixture { send """Workspace preview""" }');
  await eventually("Workspace pure Flow preview", async () => {
    assert.equal(await workspacePage.locator("#workspacePreviewSends").innerText(), "1");
  });
  for (const width of [380, 420, 480]) {
    await workspacePage.setViewportSize({ width, height: 800 });
    const layout = await workspacePage.evaluate(() => {
      const controls = [...document.querySelectorAll(
        ".editor-target-row button, .editor-target-row input, .editor-target-row select, " +
        ".editor-card button, .editor-card input, .editor-card select, .editor-card textarea"
      )].map((node) => node.getBoundingClientRect()).filter((box) => box.width > 0 && box.height > 0);
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        clipped: controls.filter((box) => box.left < -0.5 || box.right > innerWidth + 0.5).length,
        overflowNodes: [...document.querySelectorAll("body *")]
          .map((node) => ({ node, box: node.getBoundingClientRect() }))
          .filter(({ box }) => box.width > 0 && box.right > innerWidth + 0.5)
          .slice(0, 8)
          .map(({ node, box }) => ({
            tag: node.tagName,
            id: node.id,
            className: String(node.className ?? ""),
            left: Math.round(box.left),
            right: Math.round(box.right),
            width: Math.round(box.width)
          }))
      };
    });
    assert.ok(
      layout.documentWidth <= layout.viewportWidth,
      `${width}px Workspace must not overflow horizontally: ${JSON.stringify(layout)}`
    );
    assert.equal(layout.clipped, 0, `${width}px Workspace controls must remain reachable`);
  }
    await workspacePage.close();
  }

  if (runsScenarioGroup("core-delivery-reload")) {
    await selectTarget(sidePanel, firstTabId);
    const exactComposerPrompt = [
    "次の形式を絶対に変えずに回答してください。",
    "",
    "SECTION A",
    "  item 1",
    "  item 2",
    "",
    "SECTION B",
    "",
    "    indented text",
    "",
    "回答の最後に",
    "MULTILINE-TEST",
    "と書いてください。"
  ].join("\n");
  await startQuickRun(sidePanel, { prompt: exactComposerPrompt, repeat: 3, delaySeconds: 3 });
  await waitForSendCount(firstChat, 1);
  const firstWriteStats = await firstChat.evaluate(() => ({ ...globalThis.__AIPM_FIXTURE_PROSEMIRROR__ }));
  assert.deepEqual(firstWriteStats, {
    pasteEvents: 1,
    acceptedSlices: 1,
    rejectedSlices: 0
  }, "the production-like fixture must consume one exact whitespace-preserving ProseMirror slice");
  const firstWriteDocument = await firstChat.evaluate(() => globalThis.__AIPM_FIXTURE_LAST_PROSEMIRROR_DOC__);
  assert.deepEqual(firstWriteDocument, exactComposerPrompt.split("\n"), "the accepted ProseMirror document must contain exactly one paragraph per source line");
  await waitForDurableConfirmedPosition(worker, firstTabId, 1);
  await firstChat.reload();
  const threeSends = await waitForSendCount(firstChat, 3);
  assert.deepEqual(threeSends, [exactComposerPrompt, exactComposerPrompt, exactComposerPrompt]);
  assert.deepEqual(await fixtureSends(secondChat), [], "the unselected ChatGPT tab must receive no prompt");
  await eventually("reload-recovered run completion", async () => {
    assert.match(await sidePanel.locator("#statusBadge").innerText(), /完了/);
  });

  const storedAfterRun = await worker.evaluate(async () => chrome.storage.local.get(null));
    assert.equal(JSON.stringify(storedAfterRun).includes(FIXTURE_SECRET), false, "assistant fixture output leaked into extension storage");
  }

  let parallelRepeatStats = null;

  /*
    The live 10/20 failure: many good sends, then one whose acceptance evidence was gone
    before the runner could sample it. Every other repeat scenario in this fixture runs on
    a 2000ms generation window, which is long enough to hide exactly this class. Here the
    window is 30ms and every identity probe is slowed, so the first post-click sample
    provably lands after the generation control is already retired — for all twenty sends,
    not just one. Exactly-once is asserted on both halves: twenty sends, no more.

    The runner performs three probe-bearing round trips (durable write, run observation,
    lease renewal) before its first sample, so a 120ms probe delay puts that sample at least
    360ms after the click: an order of magnitude past the 30ms window, and cheap enough to
    keep this in SMOKE. Reverting the product fix turns this scenario red at 1/20 with
    submission_ambiguous, which is exactly the live signature.
  */
  if (runsScenarioGroup("short-reply-delivery")) {
    const shortReplyPrompt = "回答は C11-LIVE-TEST だけにしてください。";
    await firstChat.goto("https://chatgpt.com/c/short-reply-repeat-20");
    await firstChat.evaluate(() => sessionStorage.removeItem("aipm.fixture.sends"));
    await selectReadyTarget(sidePanel, firstChat, firstTabId);
    await installSlowIdentityProbe(worker, firstTabId, { probeDelayMs: 120 });
    try {
      await startQuickRun(sidePanel, { prompt: shortReplyPrompt, repeat: 20, delaySeconds: 0 },
        { page: firstChat, tabId: firstTabId });
      await waitForSendCount(firstChat, 1);
      const shortReplyRunId = (await activeRunFor(worker, firstTabId))?.runId;
      assert.equal(typeof shortReplyRunId, "string");
      const twentySends = await waitForLiveRunSendCount(
        firstChat,
        worker,
        firstTabId,
        shortReplyRunId,
        20,
        LONG_RUN_TIMEOUT_MS
      );
      assert.equal(twentySends.length, 20, "a short reply must never turn a delivered send into UNKNOWN");
      assert.ok(twentySends.every((prompt) => prompt === shortReplyPrompt));
      assert.deepEqual(await fixtureSends(secondChat), [], "the non-target conversation must receive zero sends");
      await eventually("short-reply Repeat=20 completion", async () => {
        const run = await activeRunFor(worker, firstTabId);
        assert.equal(run?.status, "completed");
        assert.equal(run?.cursor?.sendsCompleted, 20);
        assert.equal(run?.outbox, null);
      });
      assert.equal(
        (await fixtureSends(firstChat)).length,
        20,
        "a completed Repeat=20 must never produce a twenty-first send"
      );
    } finally {
      await removeSlowIdentityProbe(worker);
    }
  }

  if (runsScenarioGroup("parallel-repeat-stress")) {
    const firstPrompt = "PARALLEL-TAB-A";
    const secondPrompt = "PARALLEL-TAB-B";
    await Promise.all([
      firstChat.goto("https://chatgpt.com/c/parallel-repeat-20-a"),
      secondChat.goto("https://chatgpt.com/c/parallel-repeat-20-b")
    ]);
    await Promise.all([
      firstChat.evaluate(() => sessionStorage.removeItem("aipm.fixture.sends")),
      secondChat.evaluate(() => sessionStorage.removeItem("aipm.fixture.sends"))
    ]);
    await worker.evaluate(([firstId, secondId]) => {
      const original = chrome.scripting.executeScript;
      globalThis.__AIPM_PARALLEL_PROBE_STATS__ = {
        original,
        tabIds: [firstId, secondId],
        callsByTab: { [firstId]: 0, [secondId]: 0 }
      };
      chrome.scripting.executeScript = async function parallelIdentityProbeCount(details) {
        const state = globalThis.__AIPM_PARALLEL_PROBE_STATS__;
        const tabId = details?.target?.tabId;
        const isIdentityProbe = state.tabIds.includes(tabId) &&
          String(details?.func ?? "").includes("__AIPM_DOCUMENT_INSTANCE_ID__");
        if (isIdentityProbe) state.callsByTab[tabId] += 1;
        return state.original.call(chrome.scripting, details);
      };
    }, [firstTabId, secondTabId]);

    try {
      await selectReadyTarget(sidePanel, firstChat, firstTabId);
      await startQuickRun(
        sidePanel,
        { prompt: firstPrompt, repeat: 20, delaySeconds: 0 },
        { page: firstChat, tabId: firstTabId }
      );
      await waitForSendCount(firstChat, 1);
      const firstRunId = (await activeRunFor(worker, firstTabId))?.runId;
      assert.equal(typeof firstRunId, "string");

      await selectReadyTarget(sidePanel, secondChat, secondTabId);
      await startQuickRun(
        sidePanel,
        { prompt: secondPrompt, repeat: 20, delaySeconds: 0 },
        { page: secondChat, tabId: secondTabId }
      );
      await waitForSendCount(secondChat, 1);
      const secondRunId = (await activeRunFor(worker, secondTabId))?.runId;
      assert.equal(typeof secondRunId, "string");
      assert.notEqual(firstRunId, secondRunId, "parallel tabs must have distinct durable Runs");
      assert.notEqual(
        (await activeRunFor(worker, firstTabId))?.status,
        "completed",
        "the first Repeat=20 must still be active when the second begins"
      );

      const [firstSends, secondSends] = await Promise.all([
        waitForLiveRunSendCount(firstChat, worker, firstTabId, firstRunId, 20, LONG_RUN_TIMEOUT_MS),
        waitForLiveRunSendCount(secondChat, worker, secondTabId, secondRunId, 20, LONG_RUN_TIMEOUT_MS)
      ]);
      assert.deepEqual(firstSends, Array(20).fill(firstPrompt));
      assert.deepEqual(secondSends, Array(20).fill(secondPrompt));
      await new Promise((resolve) => setTimeout(resolve, 750));
      assert.equal((await fixtureSends(firstChat)).length, 20, "tab A must not emit a twenty-first send");
      assert.equal((await fixtureSends(secondChat)).length, 20, "tab B must not emit a twenty-first send");

      const stored = await worker.evaluate(async (conversationKeys) => {
        const all = await chrome.storage.local.get(null);
        return conversationKeys.map((conversationKey) => ({
          conversationKey,
          lease: all[`aipm.lease.v2.${encodeURIComponent(conversationKey)}`] ?? null
        }));
      }, [fixtureConversationKey(firstChat), fixtureConversationKey(secondChat)]);
      assert.ok(stored.every(({ lease }) => lease == null), "parallel Runs must release their separate leases");
    } finally {
      parallelRepeatStats = await worker.evaluate(() => {
        const state = globalThis.__AIPM_PARALLEL_PROBE_STATS__;
        if (!state) return null;
        chrome.scripting.executeScript = state.original;
        delete globalThis.__AIPM_PARALLEL_PROBE_STATS__;
        return { callsByTab: { ...state.callsByTab } };
      });
    }
    assert.ok(parallelRepeatStats, "parallel identity probe accounting must be available");
    for (const tabId of [firstTabId, secondTabId]) {
      assert.ok(
        parallelRepeatStats.callsByTab[tabId] >= 1 && parallelRepeatStats.callsByTab[tabId] <= 4,
        `each parallel document must need only a constant initial proof: ${JSON.stringify(parallelRepeatStats)}`
      );
    }
    // Scenario-local evidence must not become a false send in a later group's
    // non-target assertion when TORTURE runs every group in one browser profile.
    await Promise.all([
      firstChat.evaluate(() => sessionStorage.removeItem("aipm.fixture.sends")),
      secondChat.evaluate(() => sessionStorage.removeItem("aipm.fixture.sends"))
    ]);
  }

  const c9LongPrompt = Array(300).fill("C9 fixture long Prompt conversion").join("\n");
  const productionSizePrompts = [
    { label: "48kb", prompt: "CLAUDE PRODUCTION ADAPTER 48KB\n".padEnd(48 * 1024, "C") },
    { label: "64kb", prompt: "GEMINI PRODUCTION ADAPTER 64KB\n".padEnd(64 * 1024, "G") }
  ];

  if (runsScenarioGroup("attachment-guard")) {
    await firstChat.goto("https://chatgpt.com/c/c7-existing-attachment");
  await firstChat.evaluate(() => {
    sessionStorage.removeItem("aipm.fixture.sends");
    globalThis.__AIPM_FIXTURE_ADD_ATTACHMENT__();
  });
  await selectTarget(sidePanel, firstTabId);
  await startQuickRun(sidePanel, { prompt: "C7 must not mix with an attachment", repeat: 1, delaySeconds: 0 });
  await eventually("C7 pre-existing attachment fail-closed", async () => {
    const run = await activeRunFor(worker, firstTabId);
    assert.equal(run?.status, "paused");
    assert.equal(run?.lastErrorCode, "unexpected_attachment");
    assert.equal(run?.resumable, false);
  });
  assert.deepEqual(await fixtureSends(firstChat), [], "a pre-existing composer attachment must block Prompt delivery");
  assert.equal(await firstChat.evaluate(() => globalThis.__AIPM_FIXTURE_ATTACHMENT_COUNT__()), 1,
    "the extension must leave the attachment untouched");

  await sidePanel.locator("#stop").click();
  await eventually("C7 attachment-blocked Run stopped", async () => {
    assert.equal((await activeRunFor(worker, firstTabId))?.status, "stopped");
  });
  await startQuickRun(sidePanel, { prompt: "C7 residual attachment fresh Run", repeat: 1, delaySeconds: 0 });
  await eventually("C7 residual attachment blocks a fresh Run", async () => {
    const run = await activeRunFor(worker, firstTabId);
    assert.equal(run?.status, "paused");
    assert.equal(run?.lastErrorCode, "unexpected_attachment");
  });
  assert.deepEqual(await fixtureSends(firstChat), [], "a residual attachment must block a fresh Run too");
  await sidePanel.locator("#stop").click();
    await eventually("C7 residual attachment Run stopped", async () => {
      assert.equal((await activeRunFor(worker, firstTabId))?.status, "stopped");
    });
  }

  if (runsScenarioGroup("attachment-baseline")) {
    await firstChat.goto("https://chatgpt.com/c/c9-paste-conversion");
  await firstChat.evaluate(() => {
    sessionStorage.removeItem("aipm.fixture.sends");
    globalThis.__AIPM_FIXTURE_CONVERT_NEXT_PASTE__ = true;
  });
  await selectTarget(sidePanel, firstTabId);
  await startQuickRun(sidePanel, { prompt: c9LongPrompt, repeat: 1, delaySeconds: 0 });
  await eventually("C9 paste attachment delivery completes", async () => {
    const run = await activeRunFor(worker, firstTabId);
    assert.equal(run?.status, "completed");
  });
  assert.deepEqual(await fixtureSends(firstChat), [c9LongPrompt]);
    assert.equal(await firstChat.evaluate(() => globalThis.__AIPM_FIXTURE_ATTACHMENT_COUNT__()), 0,
      "the sent paste attachment must not remain in the next composer");

    await firstChat.goto("https://chatgpt.com/c/c10-pre-live-minimal-residue-repeat-5");
    await firstChat.evaluate(() => {
      sessionStorage.removeItem("aipm.fixture.sends");
      globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT__ = true;
      globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_DELAY_MS__ = 50;
      globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_REPLACE_MS__ = 20;
      globalThis.__AIPM_FIXTURE_POST_SEND_RESIDUE__ = "two-empty-paragraphs";
      globalThis.__AIPM_FIXTURE_CLEAR_READBACKS__ = [];
      globalThis.__AIPM_FIXTURE_LAST_SEND_ATTACHMENT_KIND__ = [];
    });
    await selectReadyTarget(sidePanel, firstChat, firstTabId);
    await startQuickRun(
      sidePanel,
      { prompt: c9LongPrompt, repeat: 5, delaySeconds: 0 },
      { page: firstChat, tabId: firstTabId }
    );
    await eventually("production adapter minimal-residue Repeat=5 completes", async () => {
      const run = await activeRunFor(worker, firstTabId);
      assert.equal(run?.status, "completed");
      assert.equal(run?.cursor?.sendsCompleted, 5);
    }, LONG_RUN_TIMEOUT_MS);
    assert.deepEqual(await fixtureSends(firstChat), Array(5).fill(c9LongPrompt));
    assert.deepEqual(
      await firstChat.evaluate(() => globalThis.__AIPM_FIXTURE_CLEAR_READBACKS__),
      Array(5).fill("\n"),
      "two real empty ProseMirror paragraphs must read back as one newline after every Send"
    );
    assert.deepEqual(
      await firstChat.evaluate(() => globalThis.__AIPM_FIXTURE_LAST_SEND_ATTACHMENT_KIND__),
      Array(5).fill("pasted-text")
    );

    for (const { label, prompt } of productionSizePrompts) {
      await firstChat.goto(`https://chatgpt.com/c/c10-production-adapter-${label}`);
      await firstChat.evaluate(() => {
        sessionStorage.removeItem("aipm.fixture.sends");
        globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT__ = true;
        globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_DELAY_MS__ = 50;
        globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_REPLACE_MS__ = 20;
        globalThis.__AIPM_FIXTURE_LAST_SEND_ATTACHMENT_KIND__ = [];
      });
      await selectReadyTarget(sidePanel, firstChat, firstTabId);
      await startQuickRun(
        sidePanel,
        { prompt, repeat: 1, delaySeconds: 0 },
        { page: firstChat, tabId: firstTabId }
      );
      await eventually(`production adapter ${label} delivery completes`, async () => {
        const run = await activeRunFor(worker, firstTabId);
        assert.equal(run?.status, "completed");
        assert.equal(run?.cursor?.sendsCompleted, 1);
      }, LONG_RUN_TIMEOUT_MS);
      assert.deepEqual(await fixtureSends(firstChat), [prompt]);
      assert.deepEqual(
        await firstChat.evaluate(() => globalThis.__AIPM_FIXTURE_LAST_SEND_ATTACHMENT_KIND__),
        ["pasted-text"]
      );
    }
  }

  if (runsScenarioGroup("attachment-repeat-stress")) {
    for (const repeat of [5, 20, 40]) {
    await firstChat.goto(`https://chatgpt.com/c/c9-paste-repeat-${repeat}`);
    await firstChat.evaluate(() => {
      sessionStorage.removeItem("aipm.fixture.sends");
      globalThis.__AIPM_FIXTURE_CONVERT_ALL_PASTES__ = true;
    });
    await selectTarget(sidePanel, firstTabId);
    await startQuickRun(sidePanel, { prompt: c9LongPrompt, repeat, delaySeconds: 0 });
    const c9RunId = await eventually(`C9 attachment Repeat=${repeat} Run starts`, async () => {
      const runId = (await activeRunFor(worker, firstTabId))?.runId;
      assert.equal(typeof runId, "string");
      return runId;
    });
    await waitForLiveRunSendCount(firstChat, worker, firstTabId, c9RunId, repeat, LONG_RUN_TIMEOUT_MS);
    assert.deepEqual(await fixtureSends(firstChat), Array(repeat).fill(c9LongPrompt));
  }

  for (const repeat of [1, 5, 20, 40]) {
    await firstChat.goto(`https://chatgpt.com/c/c10-live-pasted-text-${repeat}`);
    await firstChat.evaluate(() => {
      sessionStorage.removeItem("aipm.fixture.sends");
      globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT__ = true;
      globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_DELAY_MS__ = 350;
      globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_REPLACE_MS__ = 80;
      globalThis.__AIPM_FIXTURE_LAST_SEND_ATTACHMENT_KIND__ = [];
    });
    await selectTarget(sidePanel, firstTabId);
    await startQuickRun(sidePanel, { prompt: c9LongPrompt, repeat, delaySeconds: 0 });
    await eventually(`C10 live pasted-text Repeat=${repeat} completes`, async () => {
      const run = await activeRunFor(worker, firstTabId);
      assert.equal(run?.status, "completed");
      assert.equal(run?.cursor?.sendsCompleted, repeat);
    }, repeat === 1 ? TEST_TIMEOUT_MS : LONG_RUN_TIMEOUT_MS);
    assert.deepEqual(await fixtureSends(firstChat), Array(repeat).fill(c9LongPrompt));
    assert.deepEqual(
      await firstChat.evaluate(() => globalThis.__AIPM_FIXTURE_LAST_SEND_ATTACHMENT_KIND__),
      Array(repeat).fill("pasted-text"),
      "every live-like delivery must settle as pasted-text instead of premature TEXT mode"
    );
  }

  for (const repeat of [1, 5, 20, 40]) {
    await firstChat.goto(`https://chatgpt.com/c/c10-2-live-file-tile-${repeat}`);
    await firstChat.evaluate(() => {
      sessionStorage.removeItem("aipm.fixture.sends");
      globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT__ = true;
      globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_DELAY_MS__ = 350;
      globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_REPLACE_MS__ = 80;
      globalThis.__AIPM_FIXTURE_LIVE_TEMPORARY_UNRECOGNIZED__ = true;
      globalThis.__AIPM_FIXTURE_LIVE_FILE_TILE_STYLE__ = true;
      globalThis.__AIPM_FIXTURE_LIVE_DERIVED_REMOVE_COUNT__ = 1;
      globalThis.__AIPM_FIXTURE_LAST_SEND_ATTACHMENT_KIND__ = [];
    });
    await selectReadyTarget(sidePanel, firstChat, firstTabId);
    await startQuickRun(sidePanel, { prompt: c9LongPrompt, repeat, delaySeconds: 0 }, { page: firstChat, tabId: firstTabId });
    const c102RunId = await eventually(`C10.2 fallback Repeat=${repeat} Run starts`, async () => {
      const runId = (await activeRunFor(worker, firstTabId))?.runId;
      assert.equal(typeof runId, "string");
      return runId;
    });
    await waitForLiveRunSendCount(
      firstChat,
      worker,
      firstTabId,
      c102RunId,
      repeat,
      repeat === 1 ? TEST_TIMEOUT_MS : LONG_RUN_TIMEOUT_MS
    );
    assert.deepEqual(await fixtureSends(firstChat), Array(repeat).fill(c9LongPrompt));
    assert.deepEqual(
      await firstChat.evaluate(() => globalThis.__AIPM_FIXTURE_LAST_SEND_ATTACHMENT_KIND__),
      Array(repeat).fill("pasted-text")
    );
  }

  for (const repeat of [1, 5, 20, 40]) {
    await firstChat.goto(`https://chatgpt.com/c/c10-3-live-depth-7-${repeat}`);
    await configureC103LiveDepth(firstChat, { tileDepth: 7 });
    await selectReadyTarget(sidePanel, firstChat, firstTabId);
    await startQuickRun(sidePanel, { prompt: c9LongPrompt, repeat, delaySeconds: 0 }, { page: firstChat, tabId: firstTabId });
    const runId = await eventually(`C10.3 depth 7 Repeat=${repeat} Run starts`, async () => {
      const active = await activeRunFor(worker, firstTabId);
      assert.equal(typeof active?.runId, "string");
      return active.runId;
    });
    await waitForLiveRunSendCount(
      firstChat,
      worker,
      firstTabId,
      runId,
      repeat,
      repeat === 1 ? TEST_TIMEOUT_MS : LONG_RUN_TIMEOUT_MS
    );
    assert.deepEqual(await fixtureSends(firstChat), Array(repeat).fill(c9LongPrompt));
    assert.deepEqual(
      await firstChat.evaluate(() => globalThis.__AIPM_FIXTURE_LAST_SEND_ATTACHMENT_KIND__),
      Array(repeat).fill("pasted-text")
    );
  }

    for (const repeat of [1, 3, 20]) {
    await firstChat.goto(`https://chatgpt.com/c/c10-4-live-three-button-${repeat}`);
    await configureC103LiveDepth(firstChat, { tileDepth: 7, buttonCount: 3 });
    await selectTarget(sidePanel, firstTabId);
    await startQuickRun(sidePanel, { prompt: c9LongPrompt, repeat, delaySeconds: 0 });
    const runId = await eventually(`C10.4 three-button Repeat=${repeat} Run starts`, async () => {
      const active = await activeRunFor(worker, firstTabId);
      assert.equal(typeof active?.runId, "string");
      return active.runId;
    });
    await waitForLiveRunSendCount(
      firstChat,
      worker,
      firstTabId,
      runId,
      repeat,
      repeat === 1 ? TEST_TIMEOUT_MS : LONG_RUN_TIMEOUT_MS
    );
    assert.deepEqual(await fixtureSends(firstChat), Array(repeat).fill(c9LongPrompt));
    assert.deepEqual(
      await firstChat.evaluate(() => globalThis.__AIPM_FIXTURE_LAST_SEND_ATTACHMENT_KIND__),
      Array(repeat).fill("pasted-text")
    );
    }
  }

  if (runsScenarioGroup("attachment-compatibility-safety")) {
    if (c102RaceOnly.length > 0) {
      console.log(`C10.2 targeted race cases: ${c102RaceOnly.join(" -> ")}`);
      for (const race of c102RaceOnly) {
        const scenario = { sidePanel, page: firstChat, tabId: firstTabId, worker, prompt: c9LongPrompt };
        if (race === "user") await runC102UserRace(scenario);
        if (race === "stop") await runC102StopRace(scenario);
      }
    } else {
    for (const depth of [6, 8]) {
      await firstChat.goto(`https://chatgpt.com/c/c10-3-depth-boundary-${depth}`);
      await configureC103LiveDepth(firstChat, { tileDepth: depth });
      await selectReadyTarget(sidePanel, firstChat, firstTabId);
      await startQuickRun(sidePanel, { prompt: c9LongPrompt, repeat: 1, delaySeconds: 0 }, { page: firstChat, tabId: firstTabId });
      await eventually(`C10.3 depth ${depth} boundary completes`, async () => {
        const run = await activeRunFor(worker, firstTabId);
        assert.equal(run?.status, "completed");
        assert.equal(run?.cursor?.sendsCompleted, 1);
      }, TEST_TIMEOUT_MS);
      assert.deepEqual(await fixtureSends(firstChat), [c9LongPrompt]);
    }

    await firstChat.goto("https://chatgpt.com/c/c10-3-depth-9-rejected");
  await configureC103LiveDepth(firstChat, { tileDepth: 9 });
  await selectReadyTarget(sidePanel, firstChat, firstTabId);
  await startQuickRun(sidePanel, { prompt: c9LongPrompt, repeat: 1, delaySeconds: 0 }, { page: firstChat, tabId: firstTabId });
  await eventually("C10.3 depth 9 fails closed", async () => {
    const run = await activeRunFor(worker, firstTabId);
    assert.equal(run?.status, "paused");
    assert.equal(run?.resumable, false);
    assert.equal(run?.lastErrorCode, "paste_attachment_provenance_lost");
  });
  assert.deepEqual(await fixtureSends(firstChat), []);
  await stopRunAndWaitForTerminal(
    sidePanel,
    worker,
    firstTabId,
    "C10.3 depth 9 predecessor reaches terminal Stop before the next scenario"
  );

  await firstChat.goto("https://chatgpt.com/c/c10-3-send-later-actionable");
  await configureC103LiveDepth(firstChat, { tileDepth: 7, sendActionableDelayMs: 1_200 });
  await selectReadyTarget(sidePanel, firstChat, firstTabId);
  assert.equal(
    await firstChat.locator("[data-testid='send-button']").isDisabled(),
    true,
    "C10.3 delayed-actionability fixture must begin with Send disabled"
  );
  await startQuickRun(sidePanel, { prompt: c9LongPrompt, repeat: 1, delaySeconds: 0 }, { page: firstChat, tabId: firstTabId });
  await eventually("C10.3 records its intentional delayed-actionability transition", async () => {
    const events = await firstChat.evaluate(() =>
      [...(globalThis.__AIPM_FIXTURE_SEND_ACTIONABILITY_EVENTS__ ?? [])]);
    assert.equal(events[0], "forced-disabled:true");
  });
  await eventually("C10.3 initially disabled Send becomes actionable exactly once", async () => {
    const run = await activeRunFor(worker, firstTabId);
    assert.equal(run?.status, "completed");
    assert.equal(run?.cursor?.sendsCompleted, 1);
  }, TEST_TIMEOUT_MS);
  assert.deepEqual(await fixtureSends(firstChat), [c9LongPrompt]);
  assert.deepEqual(
    await firstChat.evaluate(() => [...globalThis.__AIPM_FIXTURE_SEND_ACTIONABILITY_EVENTS__]),
    ["forced-disabled:true", "forced-disabled:false", "send-click"],
    "C10.3 must force-disable, become actionable, then click exactly once"
  );

  await firstChat.goto("https://chatgpt.com/c/c10-3-send-never-actionable");
  await configureC103LiveDepth(firstChat, { tileDepth: 7, sendActionableDelayMs: 60_000 });
  await selectReadyTarget(sidePanel, firstChat, firstTabId);
  await startQuickRun(sidePanel, { prompt: c9LongPrompt, repeat: 1, delaySeconds: 0 }, { page: firstChat, tabId: firstTabId });
  await eventually("C10.3 never-actionable Send reaches bounded fail-closed timeout", async () => {
    const run = await activeRunFor(worker, firstTabId);
    assert.equal(run?.status, "paused");
    assert.equal(run?.resumable, false);
    assert.equal(run?.lastErrorCode, "paste_attachment_settlement_timeout");
  }, LONG_RUN_TIMEOUT_MS);
  assert.deepEqual(await fixtureSends(firstChat), []);
  await stopRunAndWaitForTerminal(
    sidePanel,
    worker,
    firstTabId,
    "C10.3 never-actionable Run reaches terminal Stop before the next scenario"
  );

  await firstChat.goto("https://chatgpt.com/c/c10-3-pre-existing-depth-7");
  const c103PreExistingPasteCount = await firstChat.evaluate(() =>
    globalThis.__AIPM_FIXTURE_PROSEMIRROR__.pasteEvents);
  await configureC103LiveDepth(firstChat, { tileDepth: 7, addPreExisting: true });
  await selectReadyTarget(sidePanel, firstChat, firstTabId);
  await startQuickRun(sidePanel, { prompt: c9LongPrompt, repeat: 1, delaySeconds: 0 }, { page: firstChat, tabId: firstTabId });
  await eventually("C10.3 pre-existing depth 7 tile blocks Prompt mutation", async () => {
    const run = await activeRunFor(worker, firstTabId);
    assert.equal(run?.status, "paused");
    assert.equal(run?.lastErrorCode, "unexpected_attachment");
  });
  assert.equal(
    await firstChat.evaluate(() => globalThis.__AIPM_FIXTURE_PROSEMIRROR__.pasteEvents),
    c103PreExistingPasteCount
  );
  assert.deepEqual(await fixtureSends(firstChat), []);
  await stopRunAndWaitForTerminal(
    sidePanel,
    worker,
    firstTabId,
    "C10.3 pre-existing tile Run reaches terminal Stop before C10.2"
  );

  for (const removeCount of [0, 2]) {
    await firstChat.goto(`https://chatgpt.com/c/c10-2-remove-semantics-${removeCount}`);
    await firstChat.evaluate((count) => {
      sessionStorage.removeItem("aipm.fixture.sends");
      globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT__ = true;
      globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_DELAY_MS__ = 350;
      globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_REPLACE_MS__ = 80;
      globalThis.__AIPM_FIXTURE_LIVE_TEMPORARY_UNRECOGNIZED__ = true;
      globalThis.__AIPM_FIXTURE_LIVE_FILE_TILE_STYLE__ = true;
      globalThis.__AIPM_FIXTURE_LIVE_DERIVED_REMOVE_COUNT__ = count;
    }, removeCount);
    await selectReadyTarget(sidePanel, firstChat, firstTabId);
    await startQuickRun(sidePanel, { prompt: c9LongPrompt, repeat: 1, delaySeconds: 0 }, { page: firstChat, tabId: firstTabId });
    await eventually(`C10.2 remove semantic count=${removeCount} fails closed`, async () => {
      const run = await activeRunFor(worker, firstTabId);
      assert.equal(run?.status, "paused");
      assert.equal(run?.resumable, false);
    });
    assert.deepEqual(await fixtureSends(firstChat), []);
    await stopRunAndWaitForTerminal(
      sidePanel,
      worker,
      firstTabId,
      `C10.2 removeCount=${removeCount} Run reaches terminal Stop`
    );
  }

  await firstChat.goto("https://chatgpt.com/c/c10-2-two-live-file-tiles");
  await firstChat.evaluate(() => {
    sessionStorage.removeItem("aipm.fixture.sends");
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT__ = true;
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_DELAY_MS__ = 350;
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_REPLACE_MS__ = 80;
    globalThis.__AIPM_FIXTURE_LIVE_TEMPORARY_UNRECOGNIZED__ = true;
    globalThis.__AIPM_FIXTURE_LIVE_FILE_TILE_STYLE__ = true;
    globalThis.__AIPM_FIXTURE_LIVE_ADD_EXTRA__ = true;
  });
  await selectReadyTarget(sidePanel, firstChat, firstTabId);
  await startQuickRun(sidePanel, { prompt: c9LongPrompt, repeat: 1, delaySeconds: 0 }, { page: firstChat, tabId: firstTabId });
  await eventually("C10.2 two live file tiles fail closed", async () => {
    const run = await activeRunFor(worker, firstTabId);
    assert.equal(run?.status, "paused");
    assert.equal(run?.resumable, false);
  });
  assert.deepEqual(await fixtureSends(firstChat), []);
  await stopRunAndWaitForTerminal(
    sidePanel,
    worker,
    firstTabId,
    "C10.2 two-tile Run reaches terminal Stop before the next scenario"
  );

  await firstChat.goto("https://chatgpt.com/c/c10-2-pre-existing-live-file-tile");
  const c102PreExistingPasteCount = await firstChat.evaluate(() => {
    sessionStorage.removeItem("aipm.fixture.sends");
    globalThis.__AIPM_FIXTURE_LIVE_FILE_TILE_STYLE__ = true;
    globalThis.__AIPM_FIXTURE_ADD_LIVE_FILE_TILE__();
    return globalThis.__AIPM_FIXTURE_PROSEMIRROR__.pasteEvents;
  });
  await selectReadyTarget(sidePanel, firstChat, firstTabId);
  await startQuickRun(sidePanel, { prompt: c9LongPrompt, repeat: 1, delaySeconds: 0 }, { page: firstChat, tabId: firstTabId });
  await eventually("C10.2 pre-existing live file tile blocks Start", async () => {
    const run = await activeRunFor(worker, firstTabId);
    assert.equal(run?.status, "paused");
    assert.equal(run?.lastErrorCode, "unexpected_attachment");
  });
  assert.equal(
    await firstChat.evaluate(() => globalThis.__AIPM_FIXTURE_PROSEMIRROR__.pasteEvents),
    c102PreExistingPasteCount,
    "a pre-existing live tile must block Prompt mutation"
  );
  assert.deepEqual(await fixtureSends(firstChat), []);
  await stopRunAndWaitForTerminal(
    sidePanel,
    worker,
    firstTabId,
    "C10.2 pre-existing tile Run reaches terminal Stop before the race scenarios"
  );

  await runC102UserRace({
    sidePanel, page: firstChat, tabId: firstTabId, worker, prompt: c9LongPrompt
  });
  await runC102StopRace({
    sidePanel, page: firstChat, tabId: firstTabId, worker, prompt: c9LongPrompt
  });

  await firstChat.goto("https://chatgpt.com/c/c10-2-identity-recovery");
  await firstChat.evaluate(() => {
    sessionStorage.removeItem("aipm.fixture.sends");
    globalThis.__AIPM_FIXTURE_SET_LIVE_DEPTHS__(6, 7);
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT__ = true;
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_DELAY_MS__ = 350;
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_REPLACE_MS__ = 80;
    globalThis.__AIPM_FIXTURE_LIVE_TEMPORARY_UNRECOGNIZED__ = true;
    globalThis.__AIPM_FIXTURE_LIVE_FILE_TILE_STYLE__ = true;
  });
  await selectReadyTarget(sidePanel, firstChat, firstTabId);
  await worker.evaluate((targetTabId) => {
    const original = chrome.scripting.executeScript;
    globalThis.__AIPM_C102_PROBE__ = { original, targetTabId, failures: 0 };
    chrome.scripting.executeScript = async function c102TransientProbe(details) {
      const state = globalThis.__AIPM_C102_PROBE__;
      const isIdentityProbe = details?.target?.tabId === state.targetTabId &&
        String(details?.func ?? "").includes("__AIPM_DOCUMENT_INSTANCE_ID__");
      if (isIdentityProbe && state.failures === 0) {
        state.failures += 1;
        throw new Error("synthetic transient identity failure");
      }
      return state.original.call(chrome.scripting, details);
    };
  }, firstTabId);
  let c102IdentityFailures = 0;
  try {
    await startQuickRun(sidePanel, { prompt: c9LongPrompt, repeat: 1, delaySeconds: 0 }, { page: firstChat, tabId: firstTabId });
    await eventually("C10.2 fallback survives bounded identity recovery", async () => {
      const run = await activeRunFor(worker, firstTabId);
      assert.equal(run?.status, "completed");
      assert.equal(run?.cursor?.sendsCompleted, 1);
    }, TEST_TIMEOUT_MS);
  } finally {
    c102IdentityFailures = await worker.evaluate(() => {
      const state = globalThis.__AIPM_C102_PROBE__;
      if (!state) return 0;
      chrome.scripting.executeScript = state.original;
      delete globalThis.__AIPM_C102_PROBE__;
      return state.failures;
    });
  }
    assert.equal(c102IdentityFailures, 1);
    assert.deepEqual(await fixtureSends(firstChat), [c9LongPrompt]);
    }
  }

  if (runsScenarioGroup("attachment-settlement-stress")) {
    await firstChat.goto("https://chatgpt.com/c/c10-1-delayed-5-seconds");
  await firstChat.evaluate(() => {
    sessionStorage.removeItem("aipm.fixture.sends");
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT__ = true;
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_DELAY_MS__ = 5_000;
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_REPLACE_MS__ = 80;
  });
  await selectTarget(sidePanel, firstTabId);
  const delayedFiveStartedAt = Date.now();
  await startQuickRun(sidePanel, { prompt: c9LongPrompt, repeat: 1, delaySeconds: 0 });
  await eventually("C10.1 5-second delayed conversion completes early", async () => {
    assert.equal((await activeRunFor(worker, firstTabId))?.status, "completed");
  }, TEST_TIMEOUT_MS);
  assert.deepEqual(await fixtureSends(firstChat), [c9LongPrompt]);
  assert.ok(Date.now() - delayedFiveStartedAt < 15_000, "the 5-second case must not wait for the 30-second maximum");

  await firstChat.goto("https://chatgpt.com/c/c10-1-delayed-20-seconds");
  await firstChat.evaluate(() => {
    sessionStorage.removeItem("aipm.fixture.sends");
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT__ = true;
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_DELAY_MS__ = 10_000;
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_REPLACE_MS__ = 10_000;
    globalThis.__AIPM_FIXTURE_LIVE_TEMPORARY_UNRECOGNIZED__ = true;
  });
  await selectTarget(sidePanel, firstTabId);
  await startQuickRun(sidePanel, { prompt: c9LongPrompt, repeat: 1, delaySeconds: 0 });
  await eventually("C10.1 production-like 20-second temporary-to-final conversion completes", async () => {
    const run = await activeRunFor(worker, firstTabId);
    assert.equal(run?.status, "completed");
    assert.equal(run?.cursor?.sendsCompleted, 1);
  }, LONG_RUN_TIMEOUT_MS);
  assert.deepEqual(await fixtureSends(firstChat), [c9LongPrompt]);

  await firstChat.goto("https://chatgpt.com/c/c10-1-bounded-timeout");
  await firstChat.evaluate(() => {
    sessionStorage.removeItem("aipm.fixture.sends");
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT__ = true;
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_DELAY_MS__ = 60_000;
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_REPLACE_MS__ = 80;
  });
  await selectTarget(sidePanel, firstTabId);
  await startQuickRun(sidePanel, { prompt: c9LongPrompt, repeat: 1, delaySeconds: 0 });
  await eventually("C10.1 conversion beyond the maximum fails closed", async () => {
    const run = await activeRunFor(worker, firstTabId);
    assert.equal(run?.status, "paused");
    assert.equal(run?.lastErrorCode, "paste_attachment_settlement_timeout");
    assert.equal(run?.resumable, false);
  }, 45_000);
  assert.deepEqual(await fixtureSends(firstChat), []);
  await sidePanel.locator("#stop").click();
  await eventually("C10.1 timeout Run stopped", async () => {
    assert.equal((await activeRunFor(worker, firstTabId))?.status, "stopped");
  });

  await firstChat.goto("https://chatgpt.com/c/c10-1-user-race");
  const c101PasteCountBeforeRace = await firstChat.evaluate(() => globalThis.__AIPM_FIXTURE_PROSEMIRROR__.pasteEvents);
  await firstChat.evaluate(() => {
    sessionStorage.removeItem("aipm.fixture.sends");
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT__ = true;
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_DELAY_MS__ = 5_000;
  });
  const c101ComposerBox = await firstChat.locator("#prompt-textarea").boundingBox();
  assert.ok(c101ComposerBox);
  await selectTarget(sidePanel, firstTabId);
  const c101UserRaceStart = startQuickRun(sidePanel, { prompt: c9LongPrompt, repeat: 1, delaySeconds: 0 });
  await firstChat.waitForFunction(
    (before) => globalThis.__AIPM_FIXTURE_PROSEMIRROR__.pasteEvents > before,
    c101PasteCountBeforeRace,
    { polling: "raf", timeout: TEST_TIMEOUT_MS }
  );
  await firstChat.mouse.click(
    c101ComposerBox.x + c101ComposerBox.width / 2,
    c101ComposerBox.y + c101ComposerBox.height / 2
  );
  await c101UserRaceStart;
  await eventually("C10.1 trusted interaction during long settlement sends zero", async () => {
    const run = await activeRunFor(worker, firstTabId);
    assert.equal(run?.status, "paused");
    assert.equal(run?.lastErrorCode, "paste_attachment_provenance_lost");
  });
  assert.deepEqual(await fixtureSends(firstChat), []);
  await sidePanel.locator("#stop").click();
  await eventually("C10.1 user-race Run stopped", async () => {
    assert.equal((await activeRunFor(worker, firstTabId))?.status, "stopped");
  });

  await firstChat.goto("https://chatgpt.com/c/c10-1-stop-race");
  const c101PasteCountBeforeStop = await firstChat.evaluate(() => globalThis.__AIPM_FIXTURE_PROSEMIRROR__.pasteEvents);
  await firstChat.evaluate(() => {
    sessionStorage.removeItem("aipm.fixture.sends");
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT__ = true;
    globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_DELAY_MS__ = 5_000;
  });
  await selectTarget(sidePanel, firstTabId);
  const c101StopStart = startQuickRun(sidePanel, { prompt: c9LongPrompt, repeat: 1, delaySeconds: 0 });
  await firstChat.waitForFunction(
    (before) => globalThis.__AIPM_FIXTURE_PROSEMIRROR__.pasteEvents > before,
    c101PasteCountBeforeStop,
    { polling: "raf", timeout: TEST_TIMEOUT_MS }
  );
  await sidePanel.locator("#stop").click();
  await c101StopStart;
  await eventually("C10.1 Stop during long settlement is terminal", async () => {
    assert.equal((await activeRunFor(worker, firstTabId))?.status, "stopped");
  });
  assert.deepEqual(await fixtureSends(firstChat), []);

  for (const scenario of ["extra", "text-and-attachment", "outside-surface"]) {
    await firstChat.goto(`https://chatgpt.com/c/c10-${scenario}`);
    await firstChat.evaluate((kind) => {
      sessionStorage.removeItem("aipm.fixture.sends");
      globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT__ = true;
      globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_DELAY_MS__ = 350;
      globalThis.__AIPM_FIXTURE_LIVE_PASTED_TEXT_REPLACE_MS__ = 80;
      globalThis.__AIPM_FIXTURE_LIVE_ADD_EXTRA__ = kind === "extra";
      globalThis.__AIPM_FIXTURE_LIVE_KEEP_TEXT__ = kind === "text-and-attachment";
      globalThis.__AIPM_FIXTURE_LIVE_OUTSIDE_SURFACE__ = kind === "outside-surface";
    }, scenario);
    await selectTarget(sidePanel, firstTabId);
    await startQuickRun(sidePanel, { prompt: c9LongPrompt, repeat: 1, delaySeconds: 0 });
    await eventually(`C10 ${scenario} fails closed`, async () => {
      const run = await activeRunFor(worker, firstTabId);
      assert.equal(run?.status, "paused");
      assert.equal(run?.resumable, false);
    }, scenario === "outside-surface" ? 45_000 : TEST_TIMEOUT_MS);
    assert.deepEqual(await fixtureSends(firstChat), []);
    await sidePanel.locator("#stop").click();
    await eventually(`C10 ${scenario} stopped`, async () => {
      assert.equal((await activeRunFor(worker, firstTabId))?.status, "stopped");
    });
  }

  await firstChat.goto("https://chatgpt.com/c/c9-unknown-extra-attachment");
  await firstChat.evaluate(() => {
    sessionStorage.removeItem("aipm.fixture.sends");
    globalThis.__AIPM_FIXTURE_CONVERT_NEXT_PASTE__ = true;
    globalThis.__AIPM_FIXTURE_ADD_EXTRA_AFTER_NEXT_PASTE__ = true;
  });
  await selectTarget(sidePanel, firstTabId);
  await startQuickRun(sidePanel, { prompt: c9LongPrompt, repeat: 1, delaySeconds: 0 });
  await eventually("C9 unknown second attachment fail-closed", async () => {
    const run = await activeRunFor(worker, firstTabId);
    assert.equal(run?.status, "paused");
    assert.equal(run?.lastErrorCode, "paste_attachment_provenance_lost");
  });
  assert.deepEqual(await fixtureSends(firstChat), []);
  await sidePanel.locator("#stop").click();
  await eventually("C9 unknown attachment Run stopped", async () => {
    assert.equal((await activeRunFor(worker, firstTabId))?.status, "stopped");
  });

  await firstChat.goto("https://chatgpt.com/c/c9-user-race");
  const pasteCountBeforeRace = await firstChat.evaluate(() => globalThis.__AIPM_FIXTURE_PROSEMIRROR__.pasteEvents);
  await firstChat.evaluate(() => {
    sessionStorage.removeItem("aipm.fixture.sends");
    globalThis.__AIPM_FIXTURE_CONVERT_NEXT_PASTE__ = true;
    globalThis.__AIPM_FIXTURE_PAUSE_AFTER_CONVERSION_MS__ = 600;
  });
  const composerBox = await firstChat.locator("#prompt-textarea").boundingBox();
  assert.ok(composerBox, "the C9 trusted-interaction fixture composer must be visible");
  await selectTarget(sidePanel, firstTabId);
  const userRaceStart = startQuickRun(sidePanel, { prompt: c9LongPrompt, repeat: 1, delaySeconds: 0 });
  await firstChat.waitForFunction(
    (before) => globalThis.__AIPM_FIXTURE_PROSEMIRROR__.pasteEvents > before,
    pasteCountBeforeRace,
    { polling: "raf", timeout: TEST_TIMEOUT_MS }
  );
  // Use a low-latency CDP mouse input. Locator actionability polling can consume
  // the entire 120ms post-paste verification window and make this race fixture
  // observe completion instead of the intended trusted user event.
  await firstChat.mouse.click(
    composerBox.x + composerBox.width / 2,
    composerBox.y + composerBox.height / 2
  );
  await userRaceStart;
  await eventually("C9 trusted user interaction invalidates delivery", async () => {
    const run = await activeRunFor(worker, firstTabId);
    assert.equal(run?.status, "paused");
    assert.equal(run?.lastErrorCode, "paste_attachment_provenance_lost");
  });
  assert.deepEqual(await fixtureSends(firstChat), []);
  await sidePanel.locator("#stop").click();
  await eventually("C9 user-race Run stopped", async () => {
    assert.equal((await activeRunFor(worker, firstTabId))?.status, "stopped");
  });

  await firstChat.goto("https://chatgpt.com/c/c9-stop-during-conversion");
  const pasteCountBeforeStop = await firstChat.evaluate(() => globalThis.__AIPM_FIXTURE_PROSEMIRROR__.pasteEvents);
  await firstChat.evaluate(() => {
    sessionStorage.removeItem("aipm.fixture.sends");
    globalThis.__AIPM_FIXTURE_CONVERT_NEXT_PASTE__ = true;
    // Keep a deterministic browser-scheduling window after the observed paste so
    // the Stop click lands before the fixture can expose an actionable Send.
    globalThis.__AIPM_FIXTURE_PAUSE_AFTER_CONVERSION_MS__ = 2_000;
  });
  await selectTarget(sidePanel, firstTabId);
  const stopRaceStart = startQuickRun(sidePanel, { prompt: c9LongPrompt, repeat: 1, delaySeconds: 0 });
  await firstChat.waitForFunction(
    (before) => globalThis.__AIPM_FIXTURE_PROSEMIRROR__.pasteEvents > before,
    pasteCountBeforeStop,
    { polling: "raf", timeout: TEST_TIMEOUT_MS }
  );
  await sidePanel.locator("#stop").click();
  await stopRaceStart;
  await eventually("C9 Stop during conversion is terminal", async () => {
    assert.equal((await activeRunFor(worker, firstTabId))?.status, "stopped");
  });
  assert.deepEqual(await fixtureSends(firstChat), []);

  }

  let issue23ProbeStats = null;
  let postConfirmedRendererStallStats = null;
  let c11ShortStats = null;
  let c11LongStats = null;
  let c11LifecycleStats = null;

  if (runsScenarioGroup("renderer-delay-identity")) {
    await firstChat.goto("https://chatgpt.com/c/cycle1-post-confirmed-renderer-stall");
    await firstChat.evaluate(() => sessionStorage.removeItem("aipm.fixture.sends"));
    await selectTarget(sidePanel, firstTabId);
    const stalledDocumentBefore = await currentFixtureDocumentIdentity(worker, firstTabId);
    await installPostConfirmedRendererStall(worker, firstTabId, { rendererStallMs: 3_000 });
    let stalledRunFailure = null;
    try {
      await startQuickRun(sidePanel, { prompt: "CYCLE1 same document renderer stall", repeat: 2, delaySeconds: 0 });
      await waitForSendCount(firstChat, 1);
      const stalledRunId = (await activeRunFor(worker, firstTabId))?.runId;
      assert.equal(typeof stalledRunId, "string");
      await waitForLiveRunSendCount(firstChat, worker, firstTabId, stalledRunId, 2, 40_000);
    } catch (error) {
      stalledRunFailure = error;
    } finally {
      postConfirmedRendererStallStats = await restorePostConfirmedRendererStall(worker);
    }
    const stalledDocumentAfter = await currentFixtureDocumentIdentity(worker, firstTabId);
    assert.deepEqual(
      stalledDocumentAfter,
      stalledDocumentBefore,
      "renderer pressure must not replace the exact top document"
    );
    assert.equal(
      postConfirmedRendererStallStats?.postConfirmedIdentityCalls,
      0,
      `confirmed delivery must not depend on another renderer re-entry: ${JSON.stringify(postConfirmedRendererStallStats)}`
    );
    if (stalledRunFailure) throw stalledRunFailure;
  }

  if (runsScenarioGroup("identity-recovery-stress")) {
    await firstChat.goto("https://chatgpt.com/c/issue23-repeat-40");
  await firstChat.evaluate(() => {
    sessionStorage.removeItem("aipm.fixture.sends");
    globalThis.__AIPM_FIXTURE_CONVERT_ALL_PASTES__ = true;
  });
  await selectTarget(sidePanel, firstTabId);
  await worker.evaluate((targetTabId) => {
    const original = chrome.scripting.executeScript;
    globalThis.__AIPM_ISSUE23_PROBE_STATS__ = { calls: 0, failures: 0, failedAt: [], targetTabId, original };
    chrome.scripting.executeScript = async function issue23TransientIdentityProbe(details) {
      const stats = globalThis.__AIPM_ISSUE23_PROBE_STATS__;
      const isTargetIdentityProbe = details?.target?.tabId === stats.targetTabId &&
        String(details?.func ?? "").includes("__AIPM_DOCUMENT_INSTANCE_ID__");
      if (isTargetIdentityProbe) {
        stats.calls += 1;
        if (stats.calls % 19 === 0) {
          stats.failures += 1;
          stats.failedAt.push(stats.calls);
          throw new Error("fixture transient document identity probe failure");
        }
      }
      return stats.original.call(chrome.scripting, details);
    };
  }, firstTabId);

  try {
    await startQuickRun(sidePanel, { prompt: c9LongPrompt, repeat: 40, delaySeconds: 0 });
    await waitForSendCount(firstChat, 1);
    const issue23RunId = (await activeRunFor(worker, firstTabId))?.runId;
    assert.equal(typeof issue23RunId, "string");
    const fortySends = await waitForLiveRunSendCount(
      firstChat,
      worker,
      firstTabId,
      issue23RunId,
      40,
      LONG_RUN_TIMEOUT_MS
    );
    assert.equal(fortySends.length, 40, "Repeat=40 must produce exactly 40 sends");
    assert.ok(fortySends.every((prompt) => prompt === c9LongPrompt));
    assert.deepEqual(await fixtureSends(secondChat), [], "the non-target conversation must receive zero sends");
    await eventually("Issue 23 Repeat=40 completion", async () => {
      const run = await activeRunFor(worker, firstTabId);
      assert.equal(run?.status, "completed");
      assert.equal(run?.cursor?.sendsCompleted, 40);
      assert.equal(run?.outbox, null);
    }, LONG_RUN_TIMEOUT_MS);
  } finally {
    issue23ProbeStats = await worker.evaluate(() => {
      const stats = globalThis.__AIPM_ISSUE23_PROBE_STATS__;
      if (!stats) return null;
      chrome.scripting.executeScript = stats.original;
      delete globalThis.__AIPM_ISSUE23_PROBE_STATS__;
      return { calls: stats.calls, failures: stats.failures, failedAt: [...stats.failedAt] };
    });
  }
  assert.ok(issue23ProbeStats?.calls >= 1, "Repeat=40 must include its initial fresh document proof");
  assert.ok(issue23ProbeStats.calls <= 3, `Repeat=40 identity contacts must collapse to a constant bound: ${JSON.stringify(issue23ProbeStats)}`);
  assert.equal(issue23ProbeStats.failures, 0, "steady-state Repeat=40 must never reach the armed every-19th renderer failure");
  assert.equal(context.serviceWorkers().includes(worker), true, "the same Service Worker must remain available across Repeat=40");
  const storedAfterIssue23Run = await worker.evaluate(async () => chrome.storage.local.get(null));
  assert.equal(JSON.stringify(storedAfterIssue23Run).includes(FIXTURE_SECRET), false, "Repeat=40 storage must remain Output-Blind");

  await firstChat.goto("https://chatgpt.com/c/c11-short-blackout");
  await firstChat.evaluate(() => sessionStorage.removeItem("aipm.fixture.sends"));
  await selectTarget(sidePanel, firstTabId);
  await configureQuickRun(sidePanel, { prompt: "C11 short blackout", repeat: 2, delaySeconds: 0 });
  await installC11IdentityBlackout(worker, firstTabId, { blackoutMs: 150, contactDelayMs: 180 });
  try {
    await sidePanel.locator("#start").click();
    const shortSends = await waitForSendCount(firstChat, 2);
    assert.deepEqual(shortSends, ["C11 short blackout", "C11 short blackout"]);
    await eventually("C11 short blackout completes", async () => {
      const run = await activeRunFor(worker, firstTabId);
      assert.equal(run?.status, "completed");
      assert.equal(run?.cursor?.sendsCompleted, 2);
      assert.equal(run?.outbox, null);
    });
  } finally {
    c11ShortStats = await restoreC11IdentityProbe(worker);
  }
  assert.ok(c11ShortStats?.failures >= 1, "the short-blackout fixture must exercise a transient identity failure");
  assert.ok(c11ShortStats.maxOutstanding <= 2, "short-blackout identity contacts must remain bounded");

  await firstChat.goto("https://chatgpt.com/c/c11-five-second-blackout");
  await firstChat.evaluate(() => sessionStorage.removeItem("aipm.fixture.sends"));
  await selectTarget(sidePanel, firstTabId);
  // A durable post-send fence makes the first confirmed cursor observable before
  // the next position can start, so the blackout is injected at a known-safe boundary.
  await startQuickRun(sidePanel, { prompt: "C11 five-second blackout", repeat: 3, delaySeconds: 5 });
  await waitForSendCount(firstChat, 1);
  await waitForDurableConfirmedPosition(worker, firstTabId, 1);
  await installC11IdentityBlackout(worker, firstTabId, { blackoutMs: 5_000, contactDelayMs: 700 });
  try {
    const recoveredSends = await waitForSendCount(firstChat, 3);
    assert.deepEqual(recoveredSends, [
      "C11 five-second blackout",
      "C11 five-second blackout",
      "C11 five-second blackout"
    ]);
    await eventually("C11 five-second blackout resumes and completes", async () => {
      const run = await activeRunFor(worker, firstTabId);
      assert.equal(run?.status, "completed");
      assert.equal(run?.cursor?.sendsCompleted, 3);
      assert.equal(run?.outbox, null);
    });
    await eventually("C11 five-second blackout drains outstanding fixture contacts", async () => {
      const stats = await c11IdentityBlackoutStats(worker);
      assert.equal(stats?.outstanding, 0);
    });
  } finally {
    c11LongStats = await restoreC11IdentityProbe(worker);
  }
  assert.equal(c11LongStats?.calls, 0, "an unchanged granted document must not contact the renderer during the five-second window");
  assert.equal(c11LongStats?.failures, 0, "a renderer blackout cannot fail an identity call that no longer exists");
  assert.equal(c11LongStats?.maxOutstanding, 0, "steady-state document authority creates no orphan identity contacts");

  await firstChat.goto("https://chatgpt.com/c/c11-loading-generation");
  await firstChat.evaluate(() => sessionStorage.removeItem("aipm.fixture.sends"));
  await selectTarget(sidePanel, firstTabId);
  await startQuickRun(sidePanel, { prompt: "C11 loading generation", repeat: 2, delaySeconds: 5 });
  await waitForSendCount(firstChat, 1);
  await waitForDurableConfirmedPosition(worker, firstTabId, 1);
  const lifecycleRunId = (await activeRunFor(worker, firstTabId))?.runId;
  assert.equal(typeof lifecycleRunId, "string");
  await installC11IdentityBlackout(worker, firstTabId, { blackoutMs: 5_000, contactDelayMs: 700 });
  try {
    await firstChat.goto("https://chatgpt.com/c/c11-loading-generation-replacement");
    await eventually("C11 lifecycle re-proof reaches the renderer blackout", async () => {
      const stats = await c11IdentityBlackoutStats(worker);
      assert.ok(stats?.calls >= 1);
    });
    await eventually("C11 lifecycle blackout drains", async () => {
      const stats = await c11IdentityBlackoutStats(worker);
      assert.equal(stats?.outstanding, 0);
      assert.equal(stats?.remainingMs, 0);
    });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    assert.deepEqual(await fixtureSends(firstChat), ["C11 loading generation"]);
    const changedDocumentRun = await activeRunFor(worker, firstTabId);
    assert.equal(changedDocumentRun, null, "the replacement conversation must not inherit the old active Run");
    const quarantinedRuns = await worker.evaluate(async () => {
      const stored = await chrome.storage.local.get("aipm.quarantinedRuns.v1");
      return stored["aipm.quarantinedRuns.v1"] ?? [];
    });
    const quarantined = quarantinedRuns.find((run) => run?.runId === lifecycleRunId);
    assert.equal(quarantined?.status, "paused");
    assert.equal(quarantined?.resumable, false);
    assert.equal(quarantined?.pauseReason, "conversation-changed");
    assert.equal(quarantined?.cursor?.sendsCompleted, 1);
  } finally {
    c11LifecycleStats = await restoreC11IdentityProbe(worker);
  }
  assert.ok(c11LifecycleStats?.calls >= 1, "the replacement document must perform a fresh identity proof");
  assert.ok(c11LifecycleStats.maxOutstanding <= 2, "lifecycle identity contacts must remain bounded");
  assert.equal(context.serviceWorkers().includes(worker), true, "the MV3 Service Worker remains available after the tab lifecycle change");
  }

  if (runsScenarioGroup("core-recovery")) {
    await firstChat.goto("https://chatgpt.com/c/ambiguous-reload");
  await firstChat.evaluate(() => sessionStorage.removeItem("aipm.fixture.sends"));
  await selectTarget(sidePanel, firstTabId);
  await startQuickRun(sidePanel, { prompt: "Ambiguous reload must not retry", repeat: 2, delaySeconds: 0 });
  await waitForSendCount(firstChat, 1);
  await firstChat.reload();
  await eventually("ambiguous reload fail-closed pause", async () => {
    const run = await activeRunFor(worker, firstTabId);
    assert.equal(run?.status, "paused");
    assert.equal(run?.resumable, false);
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal((await fixtureSends(firstChat)).length, 1, "an ambiguous reload must not retry the prompt");
  await sidePanel.locator("#stop").click();
  await eventually("ambiguous Run stopped", async () => {
    assert.equal((await activeRunFor(worker, firstTabId))?.status, "stopped");
  });

  await secondChat.goto("https://chatgpt.com/");
  await secondChat.evaluate(() => sessionStorage.removeItem("aipm.fixture.sends"));
  await selectTarget(sidePanel, secondTabId);
  await startQuickRun(sidePanel, { prompt: "New Chat explicit Resume", repeat: 2, delaySeconds: 0 });
  await waitForSendCount(secondChat, 1);
  await eventually("New Chat confirmation-required pause", async () => {
    assert.equal(await sidePanel.locator("#resume").isEnabled(), true);
    assert.match(await sidePanel.locator("#statusBadge").innerText(), /確認|一時停止/);
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal((await fixtureSends(secondChat)).length, 1, "New Chat must not auto-migrate and send again");
  await sidePanel.locator("#resume").click();
  await waitForSendCount(secondChat, 2);
  await eventually("explicitly resumed New Chat completion", async () => {
    assert.match(await sidePanel.locator("#statusBadge").innerText(), /完了/);
  });

  await verifyNewChatProvenanceBoundary({
    chat: secondChat, worker, tabId: secondTabId,
    start: async () => {
      await selectTarget(sidePanel, secondTabId);
      await startQuickRun(sidePanel, { prompt: "Provenance boundary fixture", repeat: 3, delaySeconds: 0 });
    },
    waitForSend: () => waitForSendCount(secondChat, 1),
    readRun: () => activeRunFor(worker, secondTabId),
    stop: async () => {
      await sidePanel.locator("#stop").click();
      await eventually("provenance fixture Run stopped", async () => {
        assert.equal((await activeRunFor(worker, secondTabId)).status, "stopped");
      });
    }
  });

  await firstChat.goto("https://chatgpt.com/c/navigation-start");
  await firstChat.evaluate(() => sessionStorage.removeItem("aipm.fixture.sends"));
  await selectReadyTarget(sidePanel, firstChat, firstTabId);
  await startQuickRun(sidePanel, { prompt: "Navigation must stop", repeat: 3, delaySeconds: 1 },
    { page: firstChat, tabId: firstTabId });
  await waitForSendCount(firstChat, 1);
  await firstChat.evaluate(() => history.pushState({}, "", "/c/navigation-changed"));
  await new Promise((resolve) => setTimeout(resolve, 2_500));
    assert.equal((await fixtureSends(firstChat)).length, 1, "same-document conversation navigation must stop before another send");
  }

  console.log(`Browser fixture E2E PASS (${await context.browser()?.version() ?? "unknown"})`);
  console.log(`Executable: ${browserPath}`);
  if (issue23ProbeStats) {
    console.log(`Issue #23 boundary count: ${issue23ProbeStats.calls} identity reads, ${issue23ProbeStats.failures} armed failures reached; Repeat=40 completed exactly once per send`);
  }
  if (postConfirmedRendererStallStats) {
    console.log(`Post-confirmed renderer stall: ${JSON.stringify(postConfirmedRendererStallStats)}`);
  }
  if (parallelRepeatStats) {
    console.log(`Parallel Repeat=20: ${JSON.stringify(parallelRepeatStats)}; 20/20 sends per tab`);
  }
  if (c11ShortStats || c11LongStats || c11LifecycleStats) {
    console.log(`C11 fixture evidence: short=${JSON.stringify(c11ShortStats)}, five-second=${JSON.stringify(c11LongStats)}, lifecycle=${JSON.stringify(c11LifecycleStats)}`);
  }
  console.log(`Browser profile PASS: ${browserProfile}; groups=${selectedScenarioGroups.length}; durationMs=${Date.now() - browserProfileStartedAt}`);
} finally {
  if (context) await context.close();
  const resolvedProfile = path.resolve(profilePath);
  const resolvedTemp = path.resolve(os.tmpdir());
  if (!resolvedProfile.startsWith(`${resolvedTemp}${path.sep}`) || !path.basename(resolvedProfile).startsWith("aipm-browser-e2e-")) {
    throw new Error(`Refusing to remove unexpected browser profile: ${resolvedProfile}`);
  }
  fs.rmSync(resolvedProfile, { recursive: true, force: true });
}
