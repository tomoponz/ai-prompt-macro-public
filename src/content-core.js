"use strict";

globalThis.__AIPM_CONTENT_CORE__ = { version: "0.4.4", ready: false };

var SCHEMA_VERSION = 1;
var DIAGNOSTICS_KEY = "aipm.diagnostics.v1";
var MAX_DIAGNOSTICS = 100;
var MAX_SENDS_PER_RUN = 50;
var LEASE_HEARTBEAT_MS = 5_000;
var POLL_MS = 300;
var RUN_OBSERVATION_INTERVAL_MS = 1_200;
var ACK_TIMEOUT_MS = 15_000;
var GENERATION_TIMEOUT_MS = 30 * 60 * 1000;
var READY_STABLE_MS = 1_500;
var STATUS_PILL_ID = "aipm-status-pill";

var instanceId = typeof globalThis.__AIPM_DOCUMENT_INSTANCE_ID__ === "string"
  ? globalThis.__AIPM_DOCUMENT_INSTANCE_ID__
  : crypto.randomUUID();
globalThis.__AIPM_DOCUMENT_INSTANCE_ID__ = instanceId;

var localRunnerToken = typeof localRunnerToken === "number" ? localRunnerToken : 0;
var recoveryStarted = typeof recoveryStarted === "boolean" ? recoveryStarted : false;
var activeRunnerRunId = typeof activeRunnerRunId === "string" ? activeRunnerRunId : null;
var activeRunnerToken = typeof activeRunnerToken === "number" ? activeRunnerToken : null;
var activeRunnerExecutionSessionId = typeof activeRunnerExecutionSessionId === "string"
  ? activeRunnerExecutionSessionId
  : null;
var startInFlight = typeof startInFlight === "boolean" ? startInFlight : false;
var alarmWakeResolvers = alarmWakeResolvers instanceof Map ? alarmWakeResolvers : new Map();
var postCommitDiagnosticInFlight = postCommitDiagnosticInFlight &&
  typeof postCommitDiagnosticInFlight.then === "function"
  ? postCommitDiagnosticInFlight
  : null;
var deferredPostCommitDiagnostic = deferredPostCommitDiagnostic && typeof deferredPostCommitDiagnostic === "object"
  ? deferredPostCommitDiagnostic
  : null;
var composerInteractionTrackers = composerInteractionTrackers instanceof WeakMap
  ? composerInteractionTrackers
  : new WeakMap();
// A reinjected core must not inherit paused DOM authority from an earlier load.
if (typeof promptTextOwnershipLifetimes !== "undefined") {
  for (const lifetime of promptTextOwnershipLifetimes) lifetime.dispose();
}
var promptTextOwnershipLifetimes = new Set();
var pausedPromptTextReceipts = new WeakMap();
// Initial composer contents are authorized by one Start, never reconstructed from
// storage. Reinjection drops these capabilities together with paused input authority.
var promptAppendPlans = new WeakMap();
// Stop-only capabilities belong to the exact observed Run object, never its durable
// JSON or a Run-ID-wide cache. The background remains responsible for expiry/use.
var runFailClosedGuards = runFailClosedGuards instanceof WeakMap ? runFailClosedGuards : new WeakMap();
var leaseRunContexts = leaseRunContexts instanceof WeakMap ? leaseRunContexts : new WeakMap();

var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var nowIso = () => new Date().toISOString();

function normalizeComposerComparableText(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n");
}

function composerTextMatchesExpected(expected, actual) {
  const expectedText = normalizeComposerComparableText(expected);
  const actualText = normalizeComposerComparableText(actual);
  if (expectedText.length !== actualText.length) return false;
  for (let index = 0; index < expectedText.length; index += 1) {
    if (expectedText[index] === actualText[index]) continue;
    // Chromium may expose an ordinary contenteditable space as NBSP. This is
    // deliberately one-way: an NBSP explicitly present in the user's Prompt
    // still requires NBSP in the readback, and every whitespace code unit/count
    // otherwise remains exact.
    if (expectedText[index] === " " && actualText[index] === "\u00a0") continue;
    return false;
  }
  return true;
}

function composerIsEffectivelyEmpty(text) {
  const normalized = normalizeComposerComparableText(text);
  if (normalized.length === 0) return true;
  // ChatGPT/ProseMirror can leave a short structural residue after clearing a
  // macro-owned pasted-text card. Keep this allowlist intentionally narrower
  // than JavaScript whitespace: an ordinary space, tab, or visible character
  // is still a user draft and must never be overwritten.
  return normalized.length <= 16 && /^[\n\u00A0\u200B-\u200D\u2060\uFEFF]+$/u.test(normalized);
}

function isProseMirrorComposer(composer) {
  const hasComposerIdentity = composer?.id === "prompt-textarea" ||
    composer?.matches?.("form[data-chatgpt-composer] div[data-composer-markdown][role='textbox']") === true;
  return hasComposerIdentity &&
    composer?.classList?.contains?.("ProseMirror") === true &&
    composer?.getAttribute?.("contenteditable") === "true";
}

function readProseMirrorComposerText(composer) {
  if (!isProseMirrorComposer(composer)) return null;
  const paragraphs = Array.from(composer.children ?? []);
  if (paragraphs.length === 0 || paragraphs.some((node) => node?.tagName !== "P")) return null;
  const readInlineText = (node) => {
    const childNodes = Array.from(node?.childNodes ?? []);
    if (childNodes.length === 0) return node?.textContent ?? "";
    let text = "";
    for (const child of childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.nodeValue ?? "";
      } else if (child?.tagName === "BR") {
        if (!child.classList?.contains?.("ProseMirror-trailingBreak")) text += "\n";
      } else {
        text += readInlineText(child);
      }
    }
    return text;
  };
  return paragraphs.map(readInlineText).join("\n");
}

function placeCaretAtProseMirrorStart(composer) {
  const firstParagraph = composer?.firstElementChild;
  const selection = window.getSelection?.();
  if (firstParagraph?.tagName !== "P" || !selection) throw makeError("composer_verification_failed");
  const range = document.createRange();
  range.selectNodeContents(firstParagraph);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function escapeProseMirrorClipboardText(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildProseMirrorClipboardHtml(text) {
  const paragraphs = normalizeComposerComparableText(text).split("\n");
  // ProseMirror's clipboard parser recognizes data-pm-slice and parses this HTML
  // with whitespace preservation. Keep metadata on the first real block so there is no
  // wrapper block to reinterpret, and leave empty paragraphs empty so ProseMirror alone
  // owns its view-only trailingBreak node.
  return paragraphs.map((line, index) => {
    const sliceMetadata = index === 0 ? ' data-pm-slice="0 0 []"' : "";
    return `<p${sliceMetadata}>${escapeProseMirrorClipboardText(line)}</p>`;
  }).join("");
}

function dispatchProseMirrorPaste(composer, text) {
  const transfer = new DataTransfer();
  transfer.setData("text/plain", text);
  transfer.setData("text/html", buildProseMirrorClipboardHtml(text));
  const event = new ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    composed: true,
    clipboardData: transfer
  });
  composer.dispatchEvent(event);
  if (!event.defaultPrevented) throw makeError("composer_verification_failed");
}

function writeProseMirrorPrompt(composer, text) {
  placeCaretAtProseMirrorStart(composer);
  dispatchProseMirrorPaste(composer, normalizeComposerComparableText(text));
}

function appendProseMirrorPrompt(composer, text) {
  const selection = window.getSelection?.();
  if (!selection) throw makeError("composer_verification_failed");
  const range = document.createRange();
  range.selectNodeContents(composer);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  dispatchProseMirrorPaste(composer, normalizeComposerComparableText(text));
}

// These snapshots describe only the user-authorized composer, stay in memory, and
// are never diagnostics. Preserve arbitrary editor nodes rather than recognizing a
// list of plugin names. The bounds avoid recursively traversing an unbounded tree.
function snapshotComposerTree(composer) {
  let remaining = 20_000;
  const visit = (node, depth) => {
    if (!node || --remaining < 0 || depth > 64) throw makeError("composer_verification_failed");
    if (node.nodeType === Node.TEXT_NODE) return { text: String(node.nodeValue ?? "") };
    const attributes = Array.from(depth === 0 ? [] : (node.attributes ?? [])).map((attr) => [String(attr.name), String(attr.value)])
      .sort(([left], [right]) => left.localeCompare(right));
    return {
      tag: String(node.tagName ?? ""),
      attributes,
      children: Array.from(node.childNodes ?? node.children ?? []).map((child) => visit(child, depth + 1))
    };
  };
  return visit(composer, 0);
}

function sameComposerTree(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function composerNodeIdentity(composer) {
  const nodes = [];
  const visit = (node, depth) => {
    if (!node || nodes.length >= 20_000 || depth > 64) throw makeError("composer_verification_failed");
    nodes.push(node);
    for (const child of node.childNodes ?? node.children ?? []) visit(child, depth + 1);
  };
  visit(composer, 0);
  return nodes;
}

function sameComposerNodeIdentity(before, composer) {
  const after = composerNodeIdentity(composer);
  return before.length === after.length && before.every((node, index) => node === after[index]);
}

function composerTreeRetainsPrefix(before, after) {
  if (!before || !after) return false;
  if (Object.prototype.hasOwnProperty.call(before, "text")) {
    return typeof after.text === "string" && after.text.startsWith(before.text);
  }
  if (before.tag !== after.tag || !sameComposerTree(before.attributes, after.attributes)) return false;
  // Atomic/noneditable nodes retain their whole structure, even when they expose
  // no plain text. Their identity is not reduced to a guessed plugin label.
  if (before.attributes.some(([name, value]) => name === "contenteditable" && value === "false")) {
    return sameComposerTree(before, after);
  }
  const children = before.children.filter((child) => !(child.tag === "BR" &&
    child.attributes.some(([name, value]) => name === "class" && value.split(/\s+/).includes("ProseMirror-trailingBreak"))));
  const actual = after.children.filter((child) => !(child.tag === "BR" &&
    child.attributes.some(([name, value]) => name === "class" && value.split(/\s+/).includes("ProseMirror-trailingBreak"))));
  if (actual.length < children.length) return false;
  return children.every((child, index) => index === children.length - 1
    ? composerTreeRetainsPrefix(child, actual[index])
    : sameComposerTree(child, actual[index]));
}

function hasStructuredComposerInput(snapshot) {
  return (snapshot?.children ?? []).some((child) => typeof child.text !== "string" &&
    (!["P", "BR"].includes(child.tag) || hasStructuredComposerInput(child)));
}

function isVisible(element) {
  if (!(element instanceof Element)) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

function firstVisible(selectors, root = document) {
  for (const selector of selectors) {
    for (const node of root.querySelectorAll(selector)) {
      if (isVisible(node)) return node;
    }
  }
  return null;
}

function uniqueVisible(selectors, root = document) {
  let candidate = null;
  const seen = new Set();
  for (const selector of selectors) {
    for (const node of root.querySelectorAll(selector)) {
      if (seen.has(node)) continue;
      seen.add(node);
      if (!isVisible(node)) continue;
      if (candidate) return null;
      candidate = node;
    }
  }
  return candidate;
}

var COMPOSER_ATTACHMENT_CONTAINER_SELECTORS = Object.freeze([
  "[data-testid='composer-attachment']",
  "[data-testid='composer-file']",
  "[data-testid='attachment-preview']",
  "[data-testid='file-thumbnail']",
  "[data-testid='file-tile']",
  "[data-testid='composer-file-tile']",
  "[data-testid='paste-attachment']",
  "[data-testid='composer-pasted-text-card']",
  "[data-testid='pasted-text-attachment']",
  "[data-testid='pasted-text-card']"
]);
var COMPOSER_ATTACHMENT_REMOVE_SELECTORS = Object.freeze([
  "button[aria-label^='Remove attachment']",
  "button[aria-label^='Remove file']",
  "button[aria-label^='添付ファイルを削除']",
  "button[aria-label^='ファイルを削除']",
  "button[data-testid='remove-pasted-text-button']",
  "button[data-testid='remove-attachment-button']",
  "button[data-testid='attachment-remove-button']",
  "button[data-testid='file-remove-button']"
]);
var COMPOSER_ATTACHMENT_SELECTORS = Object.freeze([
  ...COMPOSER_ATTACHMENT_CONTAINER_SELECTORS,
  ...COMPOSER_ATTACHMENT_REMOVE_SELECTORS
]);
var MAX_COMPOSER_ATTACHMENT_CANDIDATES = 64;
// Button count is volatile presentation, not attachment authority. Keep traversal bounded
// to a small tile-local ceiling while requiring exactly one derived remove semantic below.
var MAX_DERIVED_FILE_TILE_BUTTON_CANDIDATES = 8;
var MAX_DERIVED_REMOVE_ARIA_LENGTH = 80;
var MAX_COMPOSER_SURFACE_ANCESTOR_DEPTH = 6;
var MAX_ATTACHMENT_SIGNATURE_ANCESTOR_DEPTH = 8;
var MAX_ATTACHMENT_CONTAINER_ANCESTOR_DEPTH = 4;
// The current composer has a deep form layout, but the attachment relationship is
// local: card -> attachment region -> composer body. Do not relax the old file-tile
// depth limit or use arbitrary resource cards elsewhere on the page as authority.
var MAX_RESOURCE_CARD_REGION_DEPTH = 4;
var MAX_RESOURCE_REGION_BODY_DEPTH = 4;
var MAX_RESOURCE_REGION_ELEMENTS = 1_024;
var RESOURCE_CARD_REMOVE_LABEL = "貼り付けたテキストの添付を削除";
var MAX_PROMPT_DELIVERY_MUTATIONS = 1_024;
var MAX_PROMPT_DELIVERY_REPLACEMENTS = 4;
var PROMPT_DELIVERY_SETTLEMENT_MAX_MS = 30_000;
var PROMPT_DELIVERY_TEXT_STABLE_MS = 650;
var PROMPT_DELIVERY_ATTACHMENT_STABLE_MS = 160;
var PROMPT_DELIVERY_SETTLEMENT_POLL_MS = 50;
var PROMPT_DELIVERY_PENDING_POLL_MS = 250;
var MAX_DELIVERY_ACCEPTANCE_WATCH_CHECKS = 2_048;
var COMPOSER_SURFACE_SELECTORS = Object.freeze([
  "[data-testid='composer-surface']",
  "[data-testid='composer-container']",
  "[data-testid='composer']"
]);
var SEND_CONTROL_SELECTORS = Object.freeze([
  "button[data-testid='send-button']",
  "button[aria-label='Send prompt']",
  "button[aria-label='Send message']",
  "button[aria-label*='送信']"
]);
var COMPOSER_USER_MUTATION_EVENTS = Object.freeze([
  "pointerdown",
  "click",
  "keydown",
  "paste",
  "drop",
  "input",
  "change"
]);

function boundedAncestorDepth(node, ancestor, maxDepth = MAX_COMPOSER_SURFACE_ANCESTOR_DEPTH) {
  let current = node;
  for (let depth = 0; current && depth <= maxDepth; depth += 1) {
    if (current === ancestor) return depth;
    current = current.parentElement;
  }
  return -1;
}

function safeComposerSurface(composer) {
  if (!composer) return null;
  const composerForm = composer.closest?.("form");
  const sendButton = uniqueVisible(SEND_CONTROL_SELECTORS, composerForm ?? document);
  for (const selector of sendButton ? COMPOSER_SURFACE_SELECTORS : []) {
    const surface = composer.closest?.(selector);
    if (!surface || !surface.contains(sendButton)) continue;
    const depth = boundedAncestorDepth(composer, surface);
    if (depth < 0) continue;
    return { node: surface, kind: "marked-ancestor", composerDepth: depth };
  }
  if (composerForm) {
    return {
      node: composerForm,
      kind: "form",
      composerDepth: boundedAncestorDepth(composer, composerForm)
    };
  }
  const sendAncestors = new Set();
  let sendAncestor = sendButton;
  for (let depth = 0; sendAncestor && depth <= MAX_COMPOSER_SURFACE_ANCESTOR_DEPTH; depth += 1) {
    sendAncestors.add(sendAncestor);
    sendAncestor = sendAncestor.parentElement;
  }
  let candidate = composer;
  for (let depth = 0; candidate && depth <= MAX_COMPOSER_SURFACE_ANCESTOR_DEPTH; depth += 1) {
    const tagName = String(candidate.tagName ?? "").toUpperCase();
    if (sendAncestors.has(candidate) && !["HTML", "BODY", "MAIN"].includes(tagName)) {
      return { node: candidate, kind: "bounded-common-ancestor", composerDepth: depth };
    }
    candidate = candidate.parentElement;
  }
  return null;
}

function getComposerInteractionTracker(composer, surfaceState = safeComposerSurface(composer)) {
  const composerSurface = surfaceState?.node;
  if (!composerSurface) return null;
  let tracker = composerInteractionTrackers.get(composerSurface);
  if (tracker) return tracker;
  tracker = { epoch: 0, surface: composerSurface };
  const recordTrustedInteraction = (event) => {
    if (event?.isTrusted === true) tracker.epoch += 1;
  };
  for (const type of COMPOSER_USER_MUTATION_EVENTS) {
    composerSurface.addEventListener(type, recordTrustedInteraction, true);
  }
  composerInteractionTrackers.set(composerSurface, tracker);
  return tracker;
}

function attachmentDataTestIdKind(node) {
  const value = node?.getAttribute?.("data-testid");
  if (typeof value !== "string" || value.length > 80) return null;
  if (/^(?:composer[-_])?(?:paste|pasted)[-_]text(?:[-_](?:attachment|card|preview))?$/i.test(value)) {
    return "pasted-text";
  }
  if (/^(?:composer[-_])?(?:attachment|file)(?:[-_](?:preview|thumbnail|card|tile))?$/i.test(value)) {
    return "attachment";
  }
  return null;
}

function removeDataTestIdSemantics(node) {
  const value = node?.getAttribute?.("data-testid");
  if (typeof value !== "string" || value.length > 80) return false;
  return /^(?:(?:remove|delete)[-_](?:pasted[-_]text|attachment|file)|(?:pasted[-_]text|attachment|file)[-_](?:remove|delete))(?:[-_]button)?$/i.test(value);
}

function hasRemoveSemantics(node) {
  if (!node?.matches?.("button")) return false;
  if (node.matches(COMPOSER_ATTACHMENT_REMOVE_SELECTORS.join(","))) return true;
  return removeDataTestIdSemantics(node);
}

function findRemoveControl(root) {
  if (!root?.querySelectorAll) return null;
  let inspected = 0;
  for (const node of root.querySelectorAll("button")) {
    inspected += 1;
    if (inspected > MAX_COMPOSER_ATTACHMENT_CANDIDATES) return null;
    if (hasRemoveSemantics(node)) return node;
  }
  return null;
}

function hasDerivedFileTileRemoveSemantics(node) {
  if (!node?.matches?.("button") || !isVisible(node)) return false;
  const ariaLabel = node.getAttribute?.("aria-label");
  if (typeof ariaLabel !== "string" || ariaLabel.length === 0 ||
      ariaLabel.length > MAX_DERIVED_REMOVE_ARIA_LENGTH) return false;
  if (!/(?:\bremove\b|\bdelete\b|削除)/i.test(ariaLabel)) return false;
  if (!node.classList?.contains?.("behavior-btn")) return false;
  return Boolean(node.querySelector?.("svg"));
}

function classifyLiveFileTileFallback(node, composerSurface) {
  if (!node || !composerSurface?.contains?.(node)) {
    return { accepted: false, reason: "outside-surface", derivedRemoveSemanticCount: 0 };
  }
  if (node.getAttribute?.("role") !== "group") {
    return { accepted: false, reason: "not-group", derivedRemoveSemanticCount: 0 };
  }
  if (!node.classList?.contains?.("group/file-tile")) {
    return { accepted: false, reason: "no-file-tile", derivedRemoveSemanticCount: 0 };
  }
  if (!isVisible(node)) {
    return { accepted: false, reason: "hidden", derivedRemoveSemanticCount: 0 };
  }
  const buttons = node.querySelectorAll("button");
  if (buttons.length > MAX_DERIVED_FILE_TILE_BUTTON_CANDIDATES) {
    return { accepted: false, reason: "button-count-invalid", derivedRemoveSemanticCount: 0 };
  }
  const derivedRemoveControls = [...buttons].filter(hasDerivedFileTileRemoveSemantics);
  if (derivedRemoveControls.length === 0) {
    return { accepted: false, reason: "no-remove-semantic", derivedRemoveSemanticCount: 0 };
  }
  if (derivedRemoveControls.length !== 1) {
    return {
      accepted: false,
      reason: "multiple-remove-semantics",
      derivedRemoveSemanticCount: Math.min(
        MAX_DERIVED_FILE_TILE_BUTTON_CANDIDATES,
        derivedRemoveControls.length
      )
    };
  }
  return {
    accepted: true,
    reason: null,
    removeControl: derivedRemoveControls[0],
    derivedRemoveSemanticCount: 1
  };
}

function findDerivedFileTileRemoveControl(root, composerSurface) {
  const result = classifyLiveFileTileFallback(root, composerSurface);
  return result.accepted ? result.removeControl : null;
}

function currentResourceCardContext(card, composer, composerSurface) {
  if (!card?.matches?.("span") ||
      !card.classList?.contains?.("composer-attachment-surface") ||
      !card.classList?.contains?.("group/resource-card")) return null;
  const form = composer?.closest?.("form");
  const body = composer?.closest?.("[data-composer-body]");
  const region = card.closest?.("[data-composer-attachments]");
  if (!form || form.getAttribute?.("data-chatgpt-composer") === null ||
      !body || !region || !composerSurface?.contains?.(card) ||
      card.closest?.("form") !== form || region.closest?.("form") !== form ||
      body.closest?.("form") !== form || region.closest?.("[data-composer-body]") !== body ||
      !composerSurface.contains(region)) return null;
  const cardDepth = boundedAncestorDepth(card, region, MAX_RESOURCE_CARD_REGION_DEPTH);
  const regionDepth = boundedAncestorDepth(region, body, MAX_RESOURCE_REGION_BODY_DEPTH);
  if (cardDepth < 1 || regionDepth < 1) return null;
  const buttons = card.querySelectorAll("button");
  if (buttons.length > MAX_DERIVED_FILE_TILE_BUTTON_CANDIDATES) return null;
  // The observed overlay's accessible label is user text, not an action name.
  // Identify that control structurally before evaluating any remove selectors.
  const previews = [...buttons].filter((button) => button.parentElement === card &&
    button.classList?.contains?.("peer/resource-card"));
  if (previews.length > 1) return null;
  const previewControl = previews[0] ?? null;
  // Read only the exact remove action's attribute. Preview labels and card text
  // can contain the user's prompt and are never inspected for classification.
  const removeControls = [...card.querySelectorAll(`button[aria-label='${RESOURCE_CARD_REMOVE_LABEL}']`)]
    .filter((button) => button !== previewControl);
  if (removeControls.length !== 1) return null;
  const removeControl = removeControls[0];
  // Mixed old/new controls must not collapse into one authorized attachment just
  // because DOM containment deduplicates their card. Require one recognized action.
  if ([...buttons].some((button) => button !== removeControl && button !== previewControl &&
      hasRemoveSemantics(button))) return null;
  if (removeControl.closest?.(".composer-attachment-surface") !== card) return null;
  return { card, region, body, form, removeControl, cardDepth, regionDepth };
}

function inspectCurrentResourceCards(composer, composerSurface) {
  const result = { known: true, cards: [], regions: [], hidden: new Set(), inspected: new Set() };
  const form = composer?.closest?.("form");
  if (!form) return result;
  // A legacy marked surface can be narrower than this form. Observe its sibling
  // attachment mounts only to reject unknown residue; card context still requires
  // the chosen surface to contain the card, so this never broadens send authority.
  const regions = [...form.querySelectorAll("[data-composer-attachments]")]
    .filter((region) => region.closest?.("form") === form);
  const allCards = [...form.querySelectorAll(".composer-attachment-surface")]
    .filter((card) => card.closest?.("form") === form);
  if (regions.length + allCards.length > MAX_COMPOSER_ATTACHMENT_CANDIDATES) {
    result.known = false;
    return result;
  }
  const handledCards = new Set();
  for (const region of regions) {
    const cards = allCards.filter((card) => card.closest?.("[data-composer-attachments]") === region);
    // An empty, hidden attachment mount is normal. A populated unknown region is
    // not evidence of absence. Defer coverage until legacy recognizers have also
    // accounted for their tiles; moving one into this mount must not invalidate it.
    if ((region.childNodes?.length ?? region.children?.length ?? 0) > 0) {
      const body = composer.closest?.("[data-composer-body]");
      const regionDepth = body ? boundedAncestorDepth(region, body, MAX_RESOURCE_REGION_BODY_DEPTH) : -1;
      if (!body || regionDepth < 1 || region.closest?.("[data-composer-body]") !== body ||
          body.closest?.("form") !== form) {
        result.known = false;
      }
      if (!isVisible(region)) {
        result.known = false;
        result.hidden.add(region);
      }
      result.regions.push(region);
    }
    for (const card of cards) {
      handledCards.add(card);
      result.inspected.add(card);
      const context = currentResourceCardContext(card, composer, composerSurface);
      if (!context) {
        result.known = false;
        if (!isVisible(card) || !isVisible(region)) result.hidden.add(card);
        continue;
      }
      if (!isVisible(card) || !isVisible(region) || !isVisible(context.removeControl)) {
        result.known = false;
        result.hidden.add(card);
        continue;
      }
      result.cards.push(card);
    }
  }
  for (const card of allCards) {
    if (handledCards.has(card)) continue;
    result.inspected.add(card);
    result.known = false;
    if (!isVisible(card)) result.hidden.add(card);
  }
  return result;
}

function resourceRegionsAreAccountedFor(regions, logicalNodes) {
  for (const region of regions) {
    const attachments = logicalNodes.filter((node) => region.contains(node));
    if (attachments.length === 0) return false;
    const elements = region.querySelectorAll("*");
    if (elements.length > MAX_RESOURCE_REGION_ELEMENTS) return false;
    for (const node of elements) {
      // Account for both the current resource card and already recognized legacy
      // tiles, never arbitrary sibling upload/error branches or their contents.
      if (!attachments.some((attachment) => attachment === node ||
          attachment.contains(node) || node.contains(attachment))) return false;
    }
  }
  return true;
}

function attachmentContainerForSurface(target, composerSurface) {
  const selector = COMPOSER_ATTACHMENT_CONTAINER_SELECTORS.join(",");
  const explicit = target?.matches?.(selector) ? target : target?.closest?.(selector);
  if (explicit && composerSurface.contains(explicit)) return explicit;
  let current = target;
  for (let depth = 0; current && depth <= MAX_ATTACHMENT_CONTAINER_ANCESTOR_DEPTH; depth += 1) {
    if (!composerSurface.contains(current)) return null;
    const role = current.getAttribute?.("role");
    if (attachmentDataTestIdKind(current) ||
        (role === "group" && (findRemoveControl(current) ||
          findDerivedFileTileRemoveControl(current, composerSurface)))) return current;
    current = current.parentElement;
  }
  return null;
}

function getScopedComposerAttachmentState(composer) {
  const surfaceState = safeComposerSurface(composer);
  const composerSurface = surfaceState?.node;
  if (!composerSurface) return { known: false, count: 0, logicalNodes: [], hiddenCount: 0 };

  const resourceCards = inspectCurrentResourceCards(composer, composerSurface);
  const visibleContainers = new Set(resourceCards.cards);
  const visibleUnownedRemoveButtons = new Set();
  const hiddenCandidates = new Set(resourceCards.hidden);
  const inspectedNodes = new Set(resourceCards.inspected);
  const accountedNodes = new Set(resourceCards.cards);
  const unclassifiedGenericCandidates = new Set();
  let inspectedCandidates = inspectedNodes.size;
  let fileTileFallbackSeen = false;
  let fileTileFallbackCount = 0;
  let derivedRemoveSemanticCount = 0;
  let fallbackAccepted = false;
  let fallbackRejectReason = "no-file-tile";
  const inspectCandidate = (node, requireRemoveControl = false) => {
      if (accountedNodes.has(node)) return true;
      if (!inspectedNodes.has(node)) {
        inspectedNodes.add(node);
        inspectedCandidates += 1;
        if (inspectedCandidates > MAX_COMPOSER_ATTACHMENT_CANDIDATES) return false;
      }
      const container = attachmentContainerForSurface(node, composerSurface);
      if (requireRemoveControl && (!container || !findRemoveControl(container))) {
        unclassifiedGenericCandidates.add(node);
        return true;
      }
      // A generic-testid check can lack an explicit remove control while the
      // historical live-tile fallback recognizes its derived remove semantic.
      // Keep the unique-node budget, but only deduplicate accounted candidates.
      accountedNodes.add(node);
      if (isVisible(node)) {
        if (container && isVisible(container)) visibleContainers.add(container);
        else visibleUnownedRemoveButtons.add(node);
      } else if (!container || !isVisible(container)) {
        hiddenCandidates.add(container ?? node);
      }
      return true;
  };
  for (const selector of COMPOSER_ATTACHMENT_SELECTORS) {
    for (const node of composerSurface.querySelectorAll(selector)) {
      if (!inspectCandidate(node)) return { known: false, count: 0, logicalNodes: [], hiddenCount: 0 };
    }
  }
  for (const node of composerSurface.querySelectorAll("[data-testid]")) {
    if (!attachmentDataTestIdKind(node)) continue;
    if (!inspectCandidate(node, true)) {
      return { known: false, count: 0, logicalNodes: [], hiddenCount: 0 };
    }
  }
  const fallbackTiles = [];
  for (const node of composerSurface.querySelectorAll("[role='group']")) {
    if (!node.classList?.contains?.("group/file-tile")) continue;
    fileTileFallbackSeen = true;
    fileTileFallbackCount += 1;
    if (fileTileFallbackCount > MAX_COMPOSER_ATTACHMENT_CANDIDATES) {
      return {
        known: false,
        count: 0,
        logicalNodes: [],
        hiddenCount: 0,
        fileTileFallbackSeen,
        fileTileFallbackCount: MAX_COMPOSER_ATTACHMENT_CANDIDATES,
        derivedRemoveSemanticCount,
        fallbackAccepted: false,
        fallbackRejectReason: "multiple-file-tiles"
      };
    }
    const classification = classifyLiveFileTileFallback(node, composerSurface);
    derivedRemoveSemanticCount = Math.min(
      MAX_COMPOSER_ATTACHMENT_CANDIDATES,
      derivedRemoveSemanticCount + classification.derivedRemoveSemanticCount
    );
    if (!classification.accepted) {
      return {
        known: false,
        count: 0,
        logicalNodes: [],
        hiddenCount: classification.reason === "hidden" ? 1 : 0,
        composerForm: composerSurface,
        composerSurface,
        scopeKind: surfaceState.kind,
        composerDepth: surfaceState.composerDepth,
        inspectedCandidates,
        headerCandidateCount: 0,
        fileTileFallbackSeen,
        fileTileFallbackCount,
        derivedRemoveSemanticCount,
        fallbackAccepted: false,
        fallbackRejectReason: classification.reason
      };
    }
    fallbackTiles.push(node);
  }
  if (fallbackTiles.length > 1) fallbackRejectReason = "multiple-file-tiles";
  else if (fallbackTiles.length === 1) {
    fallbackAccepted = true;
    fallbackRejectReason = "none";
  }
  for (const node of fallbackTiles) {
    if (!inspectCandidate(node)) {
      return { known: false, count: 0, logicalNodes: [], hiddenCount: 0 };
    }
  }

  // A single logical attachment can expose both a thumbnail and a remove button. Collapse
  // only by explicit DOM containment; filenames, labels, and generic text are never used.
  const logicalContainers = [...visibleContainers].filter((candidate) =>
    ![...visibleContainers].some((other) => other !== candidate && other.contains(candidate))
  );
  const logicalNodes = [...logicalContainers, ...visibleUnownedRemoveButtons].filter((candidate, index, all) =>
    !all.some((other, otherIndex) => otherIndex !== index && other.contains?.(candidate))
  );
  // A file-shaped candidate rejected by one recognizer is not evidence that the
  // composer has no attachments. A later recognizer may account for the same tile
  // (including a wrapper/child), but otherwise keep the surface unknown. This also
  // guards the next ordinary-text send against a residual, partially recognized tile.
  const unresolvedGenericCandidate = [...unclassifiedGenericCandidates].some((node) =>
    !accountedNodes.has(node) && !logicalNodes.some((logical) =>
      logical === node || logical.contains?.(node) || node.contains?.(logical))
  );
  const attachmentHeaders = new Set();
  for (const logicalNode of logicalNodes) {
    let current = logicalNode;
    for (let depth = 0; current && depth <= MAX_ATTACHMENT_CONTAINER_ANCESTOR_DEPTH; depth += 1) {
      if (!composerSurface.contains(current)) break;
      const tagName = String(current.tagName ?? "").toUpperCase();
      const testId = current.getAttribute?.("data-testid");
      const fixedHeaderId = typeof testId === "string" && testId.length <= 80 &&
        /^(?:composer[-_])?(?:attachment|file)s?[-_]header$/i.test(testId);
      if (tagName === "HEADER" || fixedHeaderId) {
        attachmentHeaders.add(current);
        break;
      }
      current = current.parentElement;
    }
  }
  return {
    known: resourceCards.known && !unresolvedGenericCandidate &&
      resourceRegionsAreAccountedFor(resourceCards.regions, logicalNodes),
    count: logicalNodes.length,
    logicalNodes,
    hiddenCount: hiddenCandidates.size,
    composerForm: composerSurface,
    composerSurface,
    scopeKind: surfaceState.kind,
    composerDepth: surfaceState.composerDepth,
    inspectedCandidates,
    headerCandidateCount: Math.min(MAX_COMPOSER_ATTACHMENT_CANDIDATES, attachmentHeaders.size),
    fileTileFallbackSeen,
    fileTileFallbackCount: Math.min(MAX_COMPOSER_ATTACHMENT_CANDIDATES, fileTileFallbackCount),
    derivedRemoveSemanticCount,
    fallbackAccepted: fallbackAccepted && logicalNodes.length === 1,
    fallbackRejectReason
  };
}

function candidateStructuralSignature(candidate, attachmentState) {
  if (candidate?.classList?.contains?.("composer-attachment-surface")) {
    const context = currentResourceCardContext(candidate, ChatGptAdapter.findComposer(), attachmentState.composerSurface);
    if (!context || !isVisible(candidate) || !isVisible(context.region) || !isVisible(context.removeControl)) return null;
    return `composer-text-resource|SPAN|${context.cardDepth}|${context.regionDepth}|remove`;
  }
  const derivedRemoveControl = findDerivedFileTileRemoveControl(candidate, attachmentState.composerSurface);
  const removeControl = findRemoveControl(candidate) ?? derivedRemoveControl ??
    (hasRemoveSemantics(candidate) ? candidate : null);
  if (!removeControl) return null;
  const role = candidate.getAttribute?.("role");
  const kind = attachmentDataTestIdKind(candidate) ??
    (derivedRemoveControl ? "live-file-tile" : (role === "group" ? "remove-group" : "remove-owned"));
  const depth = boundedAncestorDepth(
    candidate,
    attachmentState.composerSurface,
    MAX_ATTACHMENT_SIGNATURE_ANCESTOR_DEPTH
  );
  if (depth < 0) return null;
  return `${kind}|${String(candidate.tagName ?? "").toUpperCase()}|${role === "group" ? "group" : "none"}|${depth}|remove`;
}

function startPromptDeliveryObserver(transaction) {
  if (typeof MutationObserver !== "function" || !transaction?.composerSurface) return;
  const observer = new MutationObserver((records) => {
    if (!transaction.active) return;
    // Count bounded observer batches instead of every React mutation record. One render may
    // produce many records; treating that as one state-change batch keeps a 30-second
    // conversion observable without permitting an unbounded mutation storm.
    if (records.length === 0) return;
    transaction.mutations = Math.min(MAX_PROMPT_DELIVERY_MUTATIONS + 1, transaction.mutations + 1);
    transaction.lastMutationAt = Date.now();
  });
  observer.observe(transaction.composerSurface, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-testid", "role", "aria-hidden", "hidden", "class", "style"]
  });
  transaction.observer = observer;
}

// The two post-click acceptance signals have opposite lifetimes. A cleared composer is
// durable, but the generation control is a transient edge: a short reply removes it again
// within a few hundred milliseconds, often before the runner's first post-click sample,
// which sits behind a durable write and two cross-context round trips. Sampling both
// signals at one instant therefore loses evidence that provably existed.
//
// This watch records the generation edge the moment the page produces it, independent of
// the runner's poll cadence, so a delivered send cannot become UNKNOWN merely because the
// observation arrived late. It adds no new trust: confirmation still requires BOTH signals,
// the watch starts only immediately before the irreversible click (so a generation that was
// already running cannot be latched), and it reads metadata only — the presence of a control,
// never assistant output.
function startDeliveryAcceptanceWatch(transaction, findGenerationControl) {
  if (!transaction || typeof findGenerationControl !== "function") return;
  transaction.generationSeen = transaction.generationSeen === true;
  transaction.acceptanceChecks = 0;
  const check = () => {
    if (!transaction.active || transaction.generationSeen === true) return true;
    if (transaction.acceptanceChecks >= MAX_DELIVERY_ACCEPTANCE_WATCH_CHECKS) return true;
    transaction.acceptanceChecks += 1;
    if (!findGenerationControl()) return false;
    transaction.generationSeen = true;
    return true;
  };
  transaction.acceptanceCheck = check;
  if (check()) return;
  if (typeof MutationObserver !== "function" || typeof document === "undefined" || !document.body) return;
  const observer = new MutationObserver(() => {
    if (check()) stopDeliveryAcceptanceWatch(transaction);
  });
  // A reused control can become Stop (or become visible) through attributes alone.
  // Observe only the attributes used by control identity/visibility; a mutation is
  // never acceptance evidence by itself, and no text or old attribute values are read.
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-testid", "aria-label", "hidden", "style", "class"]
  });
  transaction.acceptanceObserver = observer;
}

function stopDeliveryAcceptanceWatch(transaction) {
  if (!transaction) return;
  transaction.acceptanceObserver?.disconnect?.();
  transaction.acceptanceObserver = null;
}

function composerSurfaceSendIsActionable(attachmentState) {
  const sendButton = attachmentState?.composerSurface
    ? uniqueVisible(SEND_CONTROL_SELECTORS, attachmentState.composerSurface)
    : null;
  return Boolean(sendButton && isVisible(sendButton) && !sendButton.disabled &&
    sendButton.getAttribute?.("aria-disabled") !== "true");
}

function promptDeliveryDiagnostic(
  transaction,
  attachmentState = null,
  composerTextState = "unknown",
  outcome = "pending",
  lastState = "unknown"
) {
  const now = Date.now();
  const elapsedMs = Math.min(
    PROMPT_DELIVERY_SETTLEMENT_MAX_MS,
    Math.max(0, now - Number(transaction?.startedAt ?? now))
  );
  const stableDurationMs = Math.min(
    PROMPT_DELIVERY_SETTLEMENT_MAX_MS,
    Math.max(0, now - Number(transaction?.stableSince ?? now))
  );
  const sendActionable = composerSurfaceSendIsActionable(attachmentState);
  return {
    outcome,
    deadlineMs: PROMPT_DELIVERY_SETTLEMENT_MAX_MS,
    lastState: ["text-ready", "attachment-pending", "attachment-ready", "ambiguous", "invalid", "unknown"]
      .includes(lastState) ? lastState : "unknown",
    candidatesSeen: Math.min(MAX_COMPOSER_ATTACHMENT_CANDIDATES, transaction?.candidatesSeen ?? 0),
    replacements: Math.min(MAX_PROMPT_DELIVERY_REPLACEMENTS + 1, transaction?.replacements ?? 0),
    replacementCount: Math.min(MAX_PROMPT_DELIVERY_REPLACEMENTS + 1, transaction?.replacements ?? 0),
    composerTextState: ["empty", "minimal", "exact", "other", "unknown"].includes(composerTextState)
      ? composerTextState
      : "unknown",
    scopeKind: attachmentState?.scopeKind ?? transaction?.scopeKind ?? "unknown",
    elapsedMs,
    mutations: Math.min(MAX_PROMPT_DELIVERY_MUTATIONS + 1, transaction?.mutations ?? 0),
    mutationCount: Math.min(MAX_PROMPT_DELIVERY_MUTATIONS + 1, transaction?.mutations ?? 0),
    candidateCount: Math.min(MAX_COMPOSER_ATTACHMENT_CANDIDATES, attachmentState?.inspectedCandidates ?? 0),
    logicalAttachmentCount: Math.min(MAX_COMPOSER_ATTACHMENT_CANDIDATES, attachmentState?.count ?? 0),
    maxLogicalCandidates: Math.min(MAX_COMPOSER_ATTACHMENT_CANDIDATES, transaction?.maxLogicalCandidates ?? 0),
    maxLogicalAttachmentCount: Math.min(MAX_COMPOSER_ATTACHMENT_CANDIDATES, transaction?.maxLogicalCandidates ?? 0),
    headerCandidateCount: Math.min(
      MAX_COMPOSER_ATTACHMENT_CANDIDATES,
      attachmentState?.headerCandidateCount ?? 0
    ),
    composerDepth: Math.min(MAX_COMPOSER_SURFACE_ANCESTOR_DEPTH, Math.max(0, attachmentState?.composerDepth ?? transaction?.composerDepth ?? 0)),
    surfaceDepth: Math.min(MAX_COMPOSER_SURFACE_ANCESTOR_DEPTH, Math.max(0, attachmentState?.composerDepth ?? transaction?.composerDepth ?? 0)),
    userEpochChanged: transaction?.tracker?.epoch !== transaction?.userMutationEpoch,
    sendActionable,
    stableDurationMs,
    fileTileFallbackSeen: attachmentState?.fileTileFallbackSeen === true,
    fileTileFallbackCount: Math.min(
      MAX_COMPOSER_ATTACHMENT_CANDIDATES,
      Math.max(0, attachmentState?.fileTileFallbackCount ?? 0)
    ),
    derivedRemoveSemanticCount: Math.min(
      MAX_COMPOSER_ATTACHMENT_CANDIDATES,
      Math.max(0, attachmentState?.derivedRemoveSemanticCount ?? 0)
    ),
    fallbackAccepted: attachmentState?.fallbackAccepted === true,
    fallbackRejectReason: [
      "none",
      "no-file-tile",
      "multiple-file-tiles",
      "no-remove-semantic",
      "multiple-remove-semantics",
      "button-count-invalid",
      "not-group",
      "outside-surface",
      "hidden"
    ].includes(attachmentState?.fallbackRejectReason)
      ? attachmentState.fallbackRejectReason
      : "no-file-tile"
  };
}

function promptDeliveryBindingMatches(transaction, binding) {
  const left = transaction?.binding;
  const right = binding && typeof binding === "object" ? binding : null;
  if (!left || !right) return false;
  return left.deliveryAttemptToken === right.deliveryAttemptToken &&
    left.runId === right.runId &&
    left.executionSessionId === right.executionSessionId &&
    left.stepId === right.stepId &&
    left.stateRevision === right.stateRevision &&
    left.stepIndex === right.stepIndex &&
    left.repeatIndex === right.repeatIndex &&
    left.sendsCompleted === right.sendsCompleted &&
    left.promptHash === right.promptHash &&
    (left.inputHash ?? null) === (right.inputHash ?? null) &&
    left.documentInstanceId === right.documentInstanceId &&
    left.conversationKey === right.conversationKey &&
    left.runnerToken === right.runnerToken;
}

function createPromptTextOwnershipLifetime() {
  const navigation = globalThis.navigation;
  const entry = navigation?.currentEntry;
  if (!entry || typeof entry.key !== "string" || !entry.key || typeof entry.id !== "string" || !entry.id ||
      typeof navigation.addEventListener !== "function" || typeof navigation.removeEventListener !== "function" ||
      typeof globalThis.addEventListener !== "function" || typeof globalThis.removeEventListener !== "function") return null;
  const lifetime = {
    revoked: false,
    matches() {
      return !this.revoked && globalThis.navigation === navigation &&
        navigation.currentEntry?.key === entry.key && navigation.currentEntry?.id === entry.id;
    },
    dispose() {
      this.revoked = true;
      navigation.removeEventListener("currententrychange", revoke);
      navigation.removeEventListener("navigate", revoke);
      globalThis.removeEventListener("pagehide", revoke);
      promptTextOwnershipLifetimes.delete(this);
    }
  };
  const revoke = () => lifetime.dispose();
  try {
    navigation.addEventListener("currententrychange", revoke);
    navigation.addEventListener("navigate", revoke);
    globalThis.addEventListener("pagehide", revoke);
    promptTextOwnershipLifetimes.add(lifetime);
    return lifetime;
  } catch {
    try { lifetime.dispose(); } catch {}
    return null;
  }
}

function createPromptDeliveryTransaction(composer, attachmentState, tracker, binding, lifetime = null) {
  return {
    active: true, pasteHandled: false, mode: null,
    attachmentCandidate: null, attachmentSignature: null,
    composer, composerForm: attachmentState.composerForm, composerSurface: attachmentState.composerSurface,
    scopeKind: attachmentState.scopeKind, composerDepth: attachmentState.composerDepth,
    tracker, userMutationEpoch: tracker.epoch,
    beforeAttachmentNodes: new Set(attachmentState.logicalNodes), beforeAttachmentCount: attachmentState.count,
    seenAttachmentNodes: new Set(), macroAttachmentObserved: false,
    candidatesSeen: 0, maxLogicalCandidates: 0, replacements: 0, mutations: 0,
    lastMutationAt: Date.now(), startedAt: Date.now(), stableSince: Date.now(),
    lastObservedMode: null, lastObservedCandidate: null, lastObservedTextState: "unknown", lastObservedCount: 0,
    firstCandidateAt: null, invalidReason: null, observer: null,
    generationSeen: false, acceptanceObserver: null, acceptanceCheck: null, acceptanceChecks: 0,
    deliveryClickArmed: false, textOwnershipLifetime: lifetime, pausedTextReceipt: null,
    binding: Object.freeze({ ...binding })
  };
}

function pausedPromptTextProofIsValid(proof, expectedText, binding) {
  if (!proof || proof.expectedText !== expectedText || !proof.lifetime?.matches() ||
      proof.binding.documentInstanceId !== instanceId ||
      !promptDeliveryBindingMatches({ binding: proof.binding }, binding)) return false;
  const composer = ChatGptAdapter.findComposer();
  if (composer !== proof.composer || safeComposerSurface(composer)?.node !== proof.surface ||
      proof.tracker.epoch !== proof.userMutationEpoch ||
      ChatGptAdapter.getConversationKey() !== proof.binding.conversationKey) return false;
  const attachments = getScopedComposerAttachmentState(composer);
  return attachments.known === true && attachments.count === 0 && attachments.hiddenCount === 0 &&
    (!proof.composerSnapshot || sameComposerTree(proof.composerSnapshot, snapshotComposerTree(composer))) &&
    (!proof.composerNodes || sameComposerNodeIdentity(proof.composerNodes, composer)) &&
    composerTextMatchesExpected(expectedText, ChatGptAdapter.getComposerText(composer));
}

function pausedPromptTextBindingCanAdvance(previous, next) {
  const fields = ["runId", "executionSessionId", "stepId", "stepIndex", "repeatIndex", "sendsCompleted",
    "promptHash", "inputHash", "documentInstanceId", "conversationKey"];
  return Boolean(next && fields.every((key) => previous[key] === next[key]) &&
    typeof next.deliveryAttemptToken === "string" && next.deliveryAttemptToken &&
    next.deliveryAttemptToken !== previous.deliveryAttemptToken &&
    Number.isSafeInteger(next.stateRevision) && next.stateRevision > previous.stateRevision &&
    Number.isSafeInteger(next.runnerToken) && next.runnerToken > previous.runnerToken);
}

function inspectPromptDeliveryTransaction(transaction, expectedText, binding, expectedMode = null, options = {}) {
  if (!transaction?.active || transaction.pasteHandled !== true ||
      (transaction.requiresTextOwnershipLifetime === true && !transaction.textOwnershipLifetime?.matches()) ||
      !promptDeliveryBindingMatches(transaction, binding)) {
    return {
      ok: false,
      reason: "transaction-invalid",
      diagnostic: promptDeliveryDiagnostic(transaction, null, "unknown", "transaction-invalid", "invalid")
    };
  }
  const composer = ChatGptAdapter.findComposer();
  const surfaceState = safeComposerSurface(composer);
  if (!composer || composer !== transaction.composer || surfaceState?.node !== transaction.composerSurface) {
    return {
      ok: false,
      reason: "composer-replaced",
      diagnostic: promptDeliveryDiagnostic(transaction, null, "unknown", "composer-replaced", "invalid")
    };
  }
  if (transaction.tracker?.epoch !== transaction.userMutationEpoch) {
    return {
      ok: false,
      reason: "user-interaction",
      diagnostic: promptDeliveryDiagnostic(transaction, null, "unknown", "user-interaction", "invalid")
    };
  }
  if (transaction.invalidReason) return {
    ok: false,
    reason: transaction.invalidReason,
    diagnostic: promptDeliveryDiagnostic(transaction, null, "unknown", transaction.invalidReason, "invalid")
  };
  const attachmentState = getScopedComposerAttachmentState(composer);
  if (attachmentState.known !== true || attachmentState.hiddenCount !== 0) {
    return {
      ok: false,
      reason: "attachment-unconfirmed",
      diagnostic: promptDeliveryDiagnostic(transaction, attachmentState, "unknown", "attachment-unconfirmed", "invalid")
    };
  }
  const composerText = ChatGptAdapter.getComposerText(composer);
  let prefixPreserved = true;
  if (transaction.appendPrefixSnapshot) {
    try { prefixPreserved = composerTreeRetainsPrefix(transaction.appendPrefixSnapshot, snapshotComposerTree(composer)); }
    catch { prefixPreserved = false; }
  }
  if (!prefixPreserved) return {
    ok: false,
    reason: "text-mismatch",
    diagnostic: promptDeliveryDiagnostic(transaction, attachmentState, "other", "text-mismatch", "invalid")
  };
  const normalizedComposerText = normalizeComposerComparableText(composerText);
  const composerTextState = normalizedComposerText.length === 0
    ? "empty"
    : (composerTextMatchesExpected(expectedText, composerText)
        ? "exact"
        : (composerIsEffectivelyEmpty(composerText) ? "minimal" : "other"));
  transaction.maxLogicalCandidates = Math.max(transaction.maxLogicalCandidates, attachmentState.count);
  if (attachmentState.count > 1) transaction.invalidReason = "extra-attachment";
  if (transaction.invalidReason) return {
    ok: false,
    reason: transaction.invalidReason,
    diagnostic: promptDeliveryDiagnostic(transaction, attachmentState, composerTextState, transaction.invalidReason, "ambiguous")
  };
  let mode = null;
  let candidate = null;
  let attachmentCandidateRecognized = false;
  const retainedAppendPrefix = typeof transaction.appendPrefixText === "string" &&
    (composerTextMatchesExpected(transaction.appendPrefixText, composerText) ||
      composerTextMatchesExpected(transaction.appendPrefixText + transaction.appendSeparator, composerText));
  // A paste appends only the suffix. If the provider converts that suffix into a
  // tile, the original authorized input must still be present. Losing it is not
  // interpreted as conversion of the complete combined instruction.
  const attachmentComposerCompatible = typeof transaction.appendPrefixText === "string"
    ? retainedAppendPrefix
    : ["empty", "minimal"].includes(composerTextState);
  if (attachmentState.count === 0 && composerTextState === "exact") {
    mode = "text";
  } else if (attachmentState.count === 1 && attachmentComposerCompatible) {
    candidate = attachmentState.logicalNodes[0] ?? null;
    const candidateIsNew = candidate && !transaction.beforeAttachmentNodes.has(candidate);
    const candidateOwnedBySurface = candidate && transaction.composerSurface.contains(candidate);
    const signature = candidate && candidateStructuralSignature(candidate, attachmentState);
    const beforeAttachmentCount = Number.isInteger(transaction.beforeAttachmentCount)
      ? transaction.beforeAttachmentCount
      : transaction.beforeAttachmentNodes.size;
    const cleanAttachmentBaseline = beforeAttachmentCount === 0 &&
      transaction.beforeAttachmentNodes.size === 0;
    const belongsToIteration = cleanAttachmentBaseline &&
      (transaction.macroAttachmentObserved === true || candidateIsNew);
    if (belongsToIteration && candidateOwnedBySurface && signature) {
      attachmentCandidateRecognized = true;
      if (composerSurfaceSendIsActionable(attachmentState)) mode = "paste-attachment";
      if (!transaction.seenAttachmentNodes.has(candidate)) {
        transaction.seenAttachmentNodes.add(candidate);
        transaction.candidatesSeen += 1;
      }
      if (transaction.macroAttachmentObserved !== true) {
        transaction.macroAttachmentObserved = true;
        transaction.attachmentCandidate = candidate;
        transaction.attachmentSignature = signature;
        transaction.firstCandidateAt = Date.now();
      } else if (transaction.attachmentCandidate !== candidate) {
        transaction.attachmentCandidate = candidate;
        transaction.replacements += 1;
      }
    }
  }
  if (transaction.invalidReason) return {
    ok: false,
    reason: transaction.invalidReason,
    diagnostic: promptDeliveryDiagnostic(transaction, attachmentState, composerTextState, transaction.invalidReason, "invalid")
  };
  const now = Date.now();
  if (transaction.lastObservedMode !== mode || transaction.lastObservedTextState !== composerTextState ||
      transaction.lastObservedCount !== attachmentState.count) {
    transaction.lastObservedMode = mode;
    transaction.lastObservedCandidate = candidate;
    transaction.lastObservedTextState = composerTextState;
    transaction.lastObservedCount = attachmentState.count;
    transaction.stableSince = now;
  }
  if (!mode || (expectedMode && mode !== expectedMode)) {
    const reason = attachmentCandidateRecognized && attachmentComposerCompatible
      ? "settling"
      : (attachmentState.count > 0
      ? "attachment-provenance-lost"
      : (attachmentComposerCompatible ? "settling" : "text-mismatch"));
    const lastState = (attachmentState.count === 0 || attachmentCandidateRecognized) &&
      attachmentComposerCompatible
      ? "attachment-pending"
      : (attachmentState.count > 0 && composerTextState !== "empty" ? "ambiguous" : "invalid");
    return {
      ok: false,
      reason,
      diagnostic: promptDeliveryDiagnostic(transaction, attachmentState, composerTextState, reason, lastState)
    };
  }
  if (transaction.mode && transaction.mode !== mode) {
    return {
      ok: false,
      reason: "delivery-mode-changed",
      diagnostic: promptDeliveryDiagnostic(transaction, attachmentState, composerTextState, "delivery-mode-changed", "invalid")
    };
  }
  if (options.lock === true) transaction.mode = mode;
  return {
    ok: true,
    mode,
    composer,
    attachmentState,
    stableMs: Math.max(0, now - transaction.stableSince),
    diagnostic: promptDeliveryDiagnostic(
      transaction,
      attachmentState,
      composerTextState,
      "settled",
      mode === "text" ? "text-ready" : "attachment-ready"
    )
  };
}

function promptAppendProofIsValid(proof) {
  if (!proof || !proof.lifetime?.matches() || proof.documentInstanceId !== instanceId ||
      ChatGptAdapter.getConversationKey() !== proof.conversationKey) return false;
  const composer = ChatGptAdapter.findComposer();
  if (composer !== proof.composer || safeComposerSurface(composer)?.node !== proof.surface ||
      proof.tracker.epoch !== proof.userMutationEpoch ||
      ChatGptAdapter.getComposerText(composer) !== proof.originalText) return false;
  if (proof.snapshot && !sameComposerTree(proof.snapshot, snapshotComposerTree(composer))) return false;
  if (proof.nodes && !sameComposerNodeIdentity(proof.nodes, composer)) return false;
  const attachments = getScopedComposerAttachmentState(composer);
  return attachments.known === true && attachments.count === 0 && attachments.hiddenCount === 0;
}

var ChatGptAdapter = {
  id: "chatgpt",

  matches() {
    return location.origin === "https://chatgpt.com";
  },

  getConversationIdentity() {
    const pathname = location.pathname;
    const match = pathname.match(/^\/c\/([a-zA-Z0-9-]+)$/) ??
      pathname.match(/^\/g\/[a-zA-Z0-9-]+\/c\/([a-zA-Z0-9-]+)$/);
    if (match) return { kind: "conversation", key: `chatgpt:c:${match[1]}` };
    if (pathname === "/") return { kind: "new-chat", key: `chatgpt:new:root:${instanceId}` };

    const projectMatch = pathname.match(/^\/g\/(g-p-[a-zA-Z0-9-]+)\/project$/);
    if (projectMatch) {
      return {
        kind: "project-new-chat",
        key: `chatgpt:new:project:${projectMatch[1]}:${instanceId}`
      };
    }
    return { kind: "unknown", key: null };
  },

  getConversationKey() {
    const identity = this.getConversationIdentity();
    if (!identity.key) throw makeError("conversation_identity_unknown");
    return identity.key;
  },

  findComposer() {
    return uniqueVisible([
      "#prompt-textarea",
      "textarea[data-testid='prompt-textarea']",
      "div[data-testid='prompt-textarea'][contenteditable='true']",
      "textarea[name='prompt-textarea']",
      // Current ChatGPT omits the legacy id; require both its form and editor identity.
      "form[data-chatgpt-composer] div.ProseMirror[data-composer-markdown][role='textbox'][contenteditable='true']"
    ]);
  },

  findSendButton() {
    const composer = this.findComposer();
    const composerForm = composer?.closest?.("form");
    if (!composerForm) return null;
    // Keep this allowlist explicit at the irreversible target boundary. Privacy tests
    // intentionally audit this method body instead of following an arbitrary indirection.
    return uniqueVisible([
      "button[data-testid='send-button']",
      "button[aria-label='Send prompt']",
      "button[aria-label='Send message']",
      "button[aria-label*='送信']"
    ], composerForm);
  },

  findStopButton() {
    return firstVisible([
      "button[data-testid='stop-button']",
      "button[aria-label='Stop generating']",
      "button[aria-label='Stop streaming']",
      "button[aria-label*='Stop']",
      "button[aria-label*='停止']"
    ]);
  },

  getComposerText(composer = this.findComposer()) {
    if (!composer) return "";
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      return composer.value ?? "";
    }
    const proseMirrorText = readProseMirrorComposerText(composer);
    if (proseMirrorText !== null) return proseMirrorText;
    return composer.innerText ?? composer.textContent ?? "";
  },

  getComposerAttachmentState(composer = this.findComposer()) {
    return getScopedComposerAttachmentState(composer);
  },

  isComposerWritable(composer = this.findComposer()) {
    if (!composer) return false;
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      return !composer.disabled && !composer.readOnly;
    }
    return composer.getAttribute("contenteditable") !== "false";
  },

  preparePromptAppend(prompt) {
    const composer = this.findComposer();
    if (!composer) return null;
    const originalText = this.getComposerText(composer);
    const plainInput = composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement;
    const snapshot = plainInput ? null : snapshotComposerTree(composer);
    if (composerIsEffectivelyEmpty(originalText) && !hasStructuredComposerInput(snapshot)) return null;
    if (!plainInput && !isProseMirrorComposer(composer)) throw makeError("composer_verification_failed");
    const attachments = getScopedComposerAttachmentState(composer);
    if (attachments.known !== true || attachments.hiddenCount !== 0 || attachments.count !== 0) {
      throw makeError("composer_attachment_unconfirmed");
    }
    const tracker = getComposerInteractionTracker(composer, {
      node: attachments.composerSurface, kind: attachments.scopeKind, composerDepth: attachments.composerDepth
    });
    const conversationKey = this.getConversationKey();
    const lifetime = createPromptTextOwnershipLifetime();
    if (!tracker || !lifetime) { lifetime?.dispose(); throw makeError("draft_present"); }
    const prefix = normalizeComposerComparableText(originalText);
    const separator = prefix.endsWith("\n") ? "" : "\n";
    const appendText = separator + normalizeComposerComparableText(prompt);
    const plan = Object.freeze({ expectedText: prefix + appendText, appendText, hasExisting: true });
    promptAppendPlans.set(plan, {
      composer, surface: attachments.composerSurface, originalText, snapshot,
      nodes: snapshot ? composerNodeIdentity(composer) : null, prefix, separator,
      macro: normalizeComposerComparableText(prompt), tracker, userMutationEpoch: tracker.epoch,
      lifetime, documentInstanceId: instanceId, conversationKey
    });
    return plan;
  },

  inspectPromptAppend(plan) {
    const proof = plan && typeof plan === "object" ? promptAppendPlans.get(plan) : null;
    try { return promptAppendProofIsValid(proof); } catch { return false; }
  },

  disposePromptAppend(plan) {
    const proof = plan && typeof plan === "object" ? promptAppendPlans.get(plan) : null;
    if (!proof) return;
    promptAppendPlans.delete(plan);
    proof.lifetime.dispose();
  },

  writePrompt(text, binding = null, appendPlan = null) {
    const composer = this.findComposer();
    if (!composer) throw makeError("composer_missing");
    const appendProof = appendPlan && typeof appendPlan === "object" ? promptAppendPlans.get(appendPlan) : null;
    if (appendPlan) {
      if (!appendProof || appendProof.macro !== normalizeComposerComparableText(text) ||
          !this.inspectPromptAppend(appendPlan)) throw makeError("draft_present");
    } else if (!composerIsEffectivelyEmpty(this.getComposerText(composer))) throw makeError("draft_present");
    const attachmentState = getScopedComposerAttachmentState(composer);
    const tracker = getComposerInteractionTracker(composer, {
      node: attachmentState.composerSurface,
      kind: attachmentState.scopeKind,
      composerDepth: attachmentState.composerDepth
    });
    if (!tracker || attachmentState.known !== true || attachmentState.count !== 0 ||
        attachmentState.hiddenCount !== 0 || !binding || typeof binding !== "object") {
      throw makeError("composer_attachment_unconfirmed");
    }
    // Consume before any event dispatch; reentrancy or retry cannot append twice.
    if (appendPlan) promptAppendPlans.delete(appendPlan);
    // Capture navigation lifetime before any focus, paste, or input event can run.
    const transaction = createPromptDeliveryTransaction(
      composer, attachmentState, tracker, binding, createPromptTextOwnershipLifetime()
    );
    transaction.expectedText = appendPlan ? appendPlan.expectedText : text;
    if (appendProof) {
      transaction.appendPrefixText = appendProof.prefix;
      transaction.appendSeparator = appendProof.separator;
      transaction.appendPrefixSnapshot = appendProof.snapshot;
    }
    startPromptDeliveryObserver(transaction);
    try {
      composer.focus();
      if (appendProof && !promptAppendProofIsValid(appendProof)) throw makeError("draft_present");

      if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
        const prototype = composer instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (setter) setter.call(composer, transaction.expectedText);
        else composer.value = transaction.expectedText;
        composer.dispatchEvent(new InputEvent("input", {
          bubbles: true, inputType: "insertText", data: appendPlan ? appendPlan.appendText : text
        }));
        composer.dispatchEvent(new Event("change", { bubbles: true }));
        transaction.pasteHandled = true;
        return transaction;
      }

      // Route every edit through ProseMirror's own event handlers so its transaction state and
      // DOM advance together. A whitespace-preserving data-pm-slice represents each logical
      // line as a paragraph, including empty paragraphs, without direct DOM replacement or
      // Enter-key submission risk. Unhandled events fail closed; sendPromptSafely performs two exact
      // readbacks plus fresh Run/document/lease checks before a Send click is reachable.
      if (!isProseMirrorComposer(composer)) throw makeError("composer_verification_failed");
      if (appendPlan) appendProseMirrorPrompt(composer, appendPlan.appendText);
      else writeProseMirrorPrompt(composer, text);
      transaction.pasteHandled = true;
      return transaction;
    } catch (error) {
      this.finishPromptDelivery(transaction);
      throw error;
    } finally {
      appendProof?.lifetime?.dispose();
    }
  },

  inspectPromptDelivery(transaction, expectedText, binding, expectedMode = null, options = {}) {
    return inspectPromptDeliveryTransaction(transaction, expectedText, binding, expectedMode, options);
  },

  capturePausedPromptText(transaction, expectedText, binding) {
    if (transaction?.pausedTextReceipt || transaction?.deliveryClickArmed !== false ||
        !transaction?.textOwnershipLifetime?.matches()) return null;
    const state = inspectPromptDeliveryTransaction(transaction, expectedText, binding, "text");
    if (state.ok !== true || state.mode !== "text" || state.attachmentState.count !== 0 ||
        transaction.macroAttachmentObserved === true) return null;
    const receipt = Object.freeze({});
    pausedPromptTextReceipts.set(receipt, {
      source: transaction, expectedText, binding: transaction.binding,
      composer: transaction.composer, surface: transaction.composerSurface,
      tracker: transaction.tracker, userMutationEpoch: transaction.userMutationEpoch,
      lifetime: transaction.textOwnershipLifetime,
      composerSnapshot: snapshotComposerTree(transaction.composer),
      composerNodes: composerNodeIdentity(transaction.composer)
    });
    transaction.pausedTextReceipt = receipt;
    return receipt;
  },

  inspectPausedPromptText(receipt, expectedText, binding) {
    const proof = receipt && typeof receipt === "object" ? pausedPromptTextReceipts.get(receipt) : null;
    try { return pausedPromptTextProofIsValid(proof, expectedText, binding); } catch { return false; }
  },

  adoptPausedPromptText(receipt, expectedText, binding) {
    const proof = receipt && typeof receipt === "object" ? pausedPromptTextReceipts.get(receipt) : null;
    if (proof) pausedPromptTextReceipts.delete(receipt);
    try {
      if (!proof || proof.source.active === true ||
          !pausedPromptTextBindingCanAdvance(proof.binding, binding) ||
          !pausedPromptTextProofIsValid(proof, expectedText, proof.binding)) throw makeError("draft_present");
      const attachments = getScopedComposerAttachmentState(proof.composer);
      const transaction = createPromptDeliveryTransaction(proof.composer, attachments, proof.tracker, binding, proof.lifetime);
      transaction.userMutationEpoch = proof.userMutationEpoch;
      transaction.pasteHandled = true;
      transaction.expectedText = expectedText;
      transaction.appendPrefixText = proof.source.appendPrefixText;
      transaction.appendSeparator = proof.source.appendSeparator;
      transaction.appendPrefixSnapshot = proof.source.appendPrefixSnapshot;
      transaction.requiresTextOwnershipLifetime = true;
      proof.source.textOwnershipLifetime = null;
      startPromptDeliveryObserver(transaction);
      return transaction;
    } catch {
      proof?.lifetime?.dispose();
      throw makeError("draft_present");
    }
  },

  disposePausedPromptText(receipt) {
    const proof = receipt && typeof receipt === "object" ? pausedPromptTextReceipts.get(receipt) : null;
    if (!proof) return;
    pausedPromptTextReceipts.delete(receipt);
    proof.lifetime.dispose();
  },

  getPromptDeliveryAckState(transaction, binding, mode) {
    if (!transaction?.active || !promptDeliveryBindingMatches(transaction, binding) ||
        !["text", "paste-attachment"].includes(mode)) {
      return { known: false, cleared: false };
    }
    const composer = this.findComposer();
    if (!composer || composer !== transaction.composer || safeComposerSurface(composer)?.node !== transaction.composerSurface ||
        transaction.tracker?.epoch !== transaction.userMutationEpoch) {
      return { known: false, cleared: false };
    }
    const attachmentState = getScopedComposerAttachmentState(composer);
    if (attachmentState.known !== true || attachmentState.hiddenCount !== 0) {
      return { known: false, cleared: false };
    }
    const composerCleared = composerIsEffectivelyEmpty(this.getComposerText(composer));
    if (mode === "text") return { known: true, cleared: composerCleared && attachmentState.count === 0 };
    return {
      known: true,
      cleared: transaction.macroAttachmentObserved === true && composerCleared && attachmentState.count === 0
    };
  },

  // Started immediately before the irreversible click so the generation edge cannot be
  // missed while the runner is blocked on its durable write or its cross-context guards.
  startDeliveryAcceptanceWatch(transaction) {
    transaction.deliveryClickArmed = true;
    startDeliveryAcceptanceWatch(transaction, () => this.findStopButton());
  },

  // Reports whether a generation control has been observed since the click, including one
  // that appeared and was retired again between two of the runner's samples. Bound to the
  // exact delivery transaction so evidence from an earlier send can never be read here.
  hasObservedDeliveryGeneration(transaction, binding) {
    if (!transaction?.active || !promptDeliveryBindingMatches(transaction, binding)) return false;
    if (transaction.generationSeen !== true && typeof transaction.acceptanceCheck === "function") {
      transaction.acceptanceCheck();
    }
    return transaction.generationSeen === true;
  },

  finishPromptDelivery(transaction) {
    if (!transaction || typeof transaction !== "object") return;
    transaction.active = false;
    transaction.observer?.disconnect?.();
    transaction.observer = null;
    stopDeliveryAcceptanceWatch(transaction);
    transaction.attachmentCandidate = null;
    if (!transaction.pausedTextReceipt || !pausedPromptTextReceipts.has(transaction.pausedTextReceipt)) {
      transaction.textOwnershipLifetime?.dispose();
    }
  },

  isGenerating() {
    return Boolean(this.findStopButton());
  },

  getGenerationState() {
    return classifyGenerationState({
      generating: this.isGenerating(),
      composerWritable: this.isComposerWritable()
    });
  },

  readPageObservation() {
    const composer = this.findComposer();
    const stopButton = this.findStopButton();
    return {
      composer,
      stopButton,
      blocker: this.detectBlocker(),
      generationState: classifyGenerationState({
        generating: Boolean(stopButton),
        composerWritable: this.isComposerWritable(composer)
      })
    };
  },

  detectBlocker() {
    if (document.querySelector("iframe[src*='captcha'], iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='turnstile'], [data-sitekey], input[name='cf-turnstile-response']")) {
      return "captcha";
    }

    if (firstVisible([
      "[role='dialog'][aria-modal='true']",
      "dialog[open]"
    ])) {
      return "ui-blocked";
    }

    if (firstVisible([
      "header a[href^='/auth/login']",
      "header a[href^='/auth/signup']",
      "nav a[href^='/auth/login']",
      "nav a[href^='/auth/signup']"
    ])) {
      return "login-required";
    }

    // Never read generic alert/dialog/status/toast/modal text. A visible modal is treated
    // only as structural blocking state. Usage-limit and service failures without a
    // dedicated structural signal fall through to composer/send/generation fail-closed
    // checks rather than page-wide text inference.
    return null;
  }
};

function classifyGenerationState({ generating, composerWritable }) {
  if (generating) return "generating";
  if (composerWritable) return "idle";
  return "ambiguous";
}

function makeError(code, details = null) {
  const messages = {
    composer_missing: "ChatGPTの入力欄を検出できませんでした。",
    composer_not_ready: "ChatGPTの入力欄が利用可能になりませんでした。",
    draft_present: "入力欄を安全に追記・再利用できることを確認できません。入力は上書きしていません。内容と残りの回数を確認してください。",
    unexpected_attachment: "ChatGPTの入力欄に添付ファイルが残っているため、安全のため送信しませんでした。添付内容を確認し、不要であれば手動で削除してから新しく実行してください。",
    composer_attachment_unconfirmed: "ChatGPTの入力欄に添付ファイルがないことを確認できないため、安全のため送信しませんでした。入力欄の状態を確認してから新しく実行してください。",
    paste_attachment_unverified: "入力後に現れた添付の内容が今回のプロンプトと一致することを確認できないため、送信前に停止しました。添付は削除していません。「停止」を押し、ChatGPT側で内容と送信先を確認してください。",
    paste_attachment_provenance_lost: "既存または出所を確認できない添付ファイルがあるため、安全のため送信しませんでした。添付内容を確認して新しく実行してください。",
    paste_attachment_unrecognized: "長文がChatGPTの添付形式へ変換されましたが、安全に送信対象として確認できませんでした。添付状態を確認して新しく実行してください。",
    paste_attachment_settlement_timeout: "長文の添付変換を安全に確認できなかったため停止しました。添付状態を確認して新しく実行してください。",
    composer_verification_failed: "送信前のプロンプト一致確認に失敗しました。",
    composer_user_interaction: "入力欄への利用者操作を検知したため、APMの自動送信前に停止しました。手動送信の有無と入力欄を確認してください。",
    send_unavailable: "送信ボタンを安全に利用できませんでした。",
    submission_ambiguous: "送信成功を確実に確認できないため、自動再送せず停止しました。",
    generation_timeout: "生成完了を確認できないままタイムアウトしました。",
    lease_conflict: "同じconversationを別タブのMacroが操作中です。",
    conversation_changed: "Macro実行中にconversationが切り替わったため、誤送信防止のため停止しました。",
    conversation_identity_unknown: "このChatGPT URLのconversation識別方法を確認できないため、安全のため自動送信を停止しました。",
    workflow_invalid: "Workflowの実行範囲を安全に確認できないため停止しました。Workflowを確認して新しく開始してください。",
    send_budget_invalid: "Workflowの送信上限を安全に確認できないため停止しました。Workflowを確認して新しく開始してください。",
    max_sends: "このRunの送信上限に達しました。",
    usage_limit: "ChatGPTの利用上限を検出したため停止しました。",
    captcha: "CAPTCHA/本人確認を検出したため停止しました。自動突破は行いません。",
    service_error: "ChatGPTのサービスエラーを検出したため停止しました。",
    login_required: "ChatGPTへのログインが必要です。",
    ui_blocked: "ChatGPT上に操作を妨げるダイアログが表示されているため、安全のため停止しました。",
    recovery_ambiguous: "前回送信の成否を復元できないため、安全のため停止しました。",
    user_pause: "ユーザーがMacroを一時停止しました。",
    user_stop: "ユーザーがMacroを停止しました。",
    schedule_invalid: "予約時刻が不正です。",
    schedule_late: "予約時刻を許容範囲以上過ぎたため確認待ちにしました。",
    alarm_failed: "予約タイマーを設定できませんでした。"
  };
  const error = new Error(messages[code] ?? code);
  error.code = code;
  error.details = details;
  return error;
}

function blockerToError(blocker) {
  const map = {
    "usage-limit": "usage_limit",
    captcha: "captcha",
    "service-error": "service_error",
    "login-required": "login_required",
    "ui-blocked": "ui_blocked"
  };
  return makeError(map[blocker] ?? "service_error");
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function appendDiagnostic(type, meta = {}) {
  const allowedMeta = {};
  for (const key of ["runId", "phase", "reason", "stepId", "status", "boundary", "episodeId"]) {
    if (meta[key] != null) allowedMeta[key] = String(meta[key]).slice(0, 120);
  }
  if (["settled", "timeout", "unrecognized", "provenance-lost"].includes(meta.settlementOutcome)) {
    allowedMeta.settlementOutcome = meta.settlementOutcome;
  }
  if (["text-ready", "attachment-pending", "attachment-ready", "ambiguous", "invalid", "unknown"]
    .includes(meta.lastState)) {
    allowedMeta.lastState = meta.lastState;
  }
  if (["none", "no-file-tile", "multiple-file-tiles", "no-remove-semantic", "multiple-remove-semantics",
    "button-count-invalid", "not-group", "outside-surface", "hidden", "provenance-mismatch"]
    .includes(meta.fallbackRejectReason)) {
    allowedMeta.fallbackRejectReason = meta.fallbackRejectReason;
  }
  if (["empty", "minimal", "exact", "other", "unknown"].includes(meta.composerTextState)) {
    allowedMeta.composerTextState = meta.composerTextState;
  }
  if (["form", "marked-ancestor", "bounded-common-ancestor", "unknown"].includes(meta.scopeKind)) {
    allowedMeta.scopeKind = meta.scopeKind;
  }
  if (["match", "mismatch", "unavailable"].includes(meta.outcome)) {
    allowedMeta.outcome = meta.outcome;
  }
  if (DOCUMENT_IDENTITY_FAILURE_CODES.has(meta.failureCode)) {
    allowedMeta.failureCode = meta.failureCode;
  }
  if (["probe", "document-lifetime-grant", "bound-content-sender"].includes(meta.identitySource)) {
    allowedMeta.identitySource = meta.identitySource;
  }
  for (const key of ["attempt", "totalAttempts", "durationMs", "consecutiveUnavailable", "recoveryElapsedMs",
    "elapsedMs", "deadlineMs", "stableDurationMs"]) {
    if (Number.isSafeInteger(meta[key]) && meta[key] >= 0) {
      const durationField = ["durationMs", "recoveryElapsedMs", "elapsedMs", "deadlineMs", "stableDurationMs"]
        .includes(key);
      allowedMeta[key] = Math.min(durationField ? 60_000 : 12, meta[key]);
    }
  }
  for (const key of ["candidatesSeen", "replacements", "mutations", "maxLogicalCandidates", "composerDepth",
    "candidateCount", "logicalAttachmentCount", "headerCandidateCount", "replacementCount", "mutationCount",
    "surfaceDepth", "maxLogicalAttachmentCount", "fileTileFallbackCount", "derivedRemoveSemanticCount"]) {
    if (Number.isSafeInteger(meta[key]) && meta[key] >= 0) {
      const max = ["mutations", "mutationCount"].includes(key)
        ? MAX_PROMPT_DELIVERY_MUTATIONS + 1
        : MAX_COMPOSER_ATTACHMENT_CANDIDATES;
      allowedMeta[key] = Math.min(max, meta[key]);
    }
  }
  for (const key of ["userEpochChanged", "sendActionable", "fileTileFallbackSeen", "fallbackAccepted", "identityObservationMissing"]) {
    if (typeof meta[key] === "boolean") allowedMeta[key] = meta[key];
  }
  const stored = await chrome.storage.local.get(DIAGNOSTICS_KEY);
  const list = Array.isArray(stored[DIAGNOSTICS_KEY]) ? stored[DIAGNOSTICS_KEY] : [];
  list.push({ at: nowIso(), type, ...allowedMeta });
  await chrome.storage.local.set({ [DIAGNOSTICS_KEY]: list.slice(-MAX_DIAGNOSTICS) });
}

// This admission path is only for diagnostics whose authoritative transition has already
// been durably committed. It deliberately returns synchronously: an uncancellable storage
// Promise may remain pending, but it can neither block execution/control nor accumulate a
// backlog. While one write is unresolved, later observability events are simply dropped.
function appendPostCommitDiagnostic(type, meta = {}) {
  if (postCommitDiagnosticInFlight) return false;
  const pending = Promise.resolve().then(() => appendDiagnostic(type, meta));
  postCommitDiagnosticInFlight = pending;
  const release = () => {
    if (postCommitDiagnosticInFlight === pending) postCommitDiagnosticInFlight = null;
  };
  void pending.then(release, release);
  return true;
}

// A final failure classification is more useful than the earlier prepared event, but it must
// not start a second storage contact or wait on diagnostics. Keep at most one coalesced successor;
// if the current contact never settles, execution/control still complete and no backlog forms.
function appendDeferredPostCommitDiagnostic(type, meta = {}) {
  if (!postCommitDiagnosticInFlight) return appendPostCommitDiagnostic(type, meta);
  if (deferredPostCommitDiagnostic) return false;
  const observed = postCommitDiagnosticInFlight;
  deferredPostCommitDiagnostic = { type, meta };
  const flush = () => {
    if (postCommitDiagnosticInFlight === observed) postCommitDiagnosticInFlight = null;
    const deferred = deferredPostCommitDiagnostic;
    deferredPostCommitDiagnostic = null;
    if (deferred) appendPostCommitDiagnostic(deferred.type, deferred.meta);
  };
  void observed.then(flush, flush);
  return true;
}

var DOCUMENT_IDENTITY_UNAVAILABLE_REASONS = DOCUMENT_IDENTITY_UNAVAILABLE_REASONS instanceof Set
  ? DOCUMENT_IDENTITY_UNAVAILABLE_REASONS
  : new Set([
      "timeout",
      "execute-script-rejected",
      "backpressure",
      "top-frame-missing",
      "identity-fields-unavailable",
      "probe-result-invalid",
      "stale-result",
      "document-lifecycle-changed",
      "execution-session-changed",
      "unknown"
    ]);

var DOCUMENT_IDENTITY_FAILURE_CODES = DOCUMENT_IDENTITY_FAILURE_CODES instanceof Set
  ? DOCUMENT_IDENTITY_FAILURE_CODES
  : new Set([
      "IDENTITY_PROBE_TIMEOUT",
      "IDENTITY_PROBE_REJECTED",
      "IDENTITY_BACKPRESSURE",
      "IDENTITY_TOP_FRAME_MISSING",
      "IDENTITY_FIELDS_UNAVAILABLE",
      "IDENTITY_PROBE_INVALID",
      "IDENTITY_STALE_RESULT",
      "IDENTITY_LIFECYCLE_INVALIDATED",
      "IDENTITY_EXECUTION_SESSION_CHANGED",
      "IDENTITY_UNKNOWN"
    ]);

var DOCUMENT_IDENTITY_FAILURE_CODE_BY_REASON = DOCUMENT_IDENTITY_FAILURE_CODE_BY_REASON &&
    typeof DOCUMENT_IDENTITY_FAILURE_CODE_BY_REASON === "object"
  ? DOCUMENT_IDENTITY_FAILURE_CODE_BY_REASON
  : Object.freeze({
      timeout: "IDENTITY_PROBE_TIMEOUT",
      "execute-script-rejected": "IDENTITY_PROBE_REJECTED",
      backpressure: "IDENTITY_BACKPRESSURE",
      "top-frame-missing": "IDENTITY_TOP_FRAME_MISSING",
      "identity-fields-unavailable": "IDENTITY_FIELDS_UNAVAILABLE",
      "probe-result-invalid": "IDENTITY_PROBE_INVALID",
      "stale-result": "IDENTITY_STALE_RESULT",
      "document-lifecycle-changed": "IDENTITY_LIFECYCLE_INVALIDATED",
      "execution-session-changed": "IDENTITY_EXECUTION_SESSION_CHANGED",
      unknown: "IDENTITY_UNKNOWN"
    });

function normalizeDocumentIdentityObservation(value, fallbackOutcome = "unavailable", fallbackBoundary = "run-read") {
  const outcome = ["match", "mismatch", "unavailable"].includes(value?.outcome)
    ? value.outcome
    : fallbackOutcome;
  const attempt = Number.isSafeInteger(value?.attempt) && value.attempt > 0
    ? Math.min(12, value.attempt)
    : 1;
  const totalAttempts = Number.isSafeInteger(value?.totalAttempts) && value.totalAttempts > 0
    ? Math.min(12, value.totalAttempts)
    : attempt;
  const observation = {
    outcome,
    attempt,
    totalAttempts: Math.max(attempt, totalAttempts),
    durationMs: Number.isFinite(value?.durationMs) && value.durationMs >= 0
      ? Math.min(60_000, Math.ceil(value.durationMs))
      : 0,
    boundary: typeof value?.boundary === "string" && value.boundary
      ? value.boundary.slice(0, 120)
      : fallbackBoundary,
    episodeId: typeof value?.episodeId === "string" && value.episodeId
      ? value.episodeId.slice(0, 80)
      : "identity-unknown",
    consecutiveUnavailable: Number.isSafeInteger(value?.consecutiveUnavailable) && value.consecutiveUnavailable >= 0
      ? Math.min(12, value.consecutiveUnavailable)
      : (outcome === "unavailable" ? attempt : 0),
    recoveryElapsedMs: Number.isFinite(value?.recoveryElapsedMs) && value.recoveryElapsedMs >= 0
      ? Math.min(60_000, Math.ceil(value.recoveryElapsedMs))
      : (Number.isFinite(value?.durationMs) && value.durationMs >= 0
          ? Math.min(60_000, Math.ceil(value.durationMs))
          : 0),
    source: ["document-lifetime-grant", "bound-content-sender"].includes(value?.source)
      ? value.source
      : "probe"
  };
  // Defaults preserve compatibility with earlier senders, but they are not measured
  // evidence. Keep this distinction across normalization at each error boundary.
  if (!value || typeof value !== "object" || value.observationMissing === true) {
    observation.observationMissing = true;
  }
  if (outcome === "unavailable" || observation.consecutiveUnavailable > 0) {
    observation.reason = DOCUMENT_IDENTITY_UNAVAILABLE_REASONS.has(value?.reason)
      ? value.reason
      : "unknown";
    observation.failureCode = DOCUMENT_IDENTITY_FAILURE_CODES.has(value?.failureCode)
      ? value.failureCode
      : (DOCUMENT_IDENTITY_FAILURE_CODE_BY_REASON[observation.reason] ?? "IDENTITY_UNKNOWN");
  }
  return observation;
}

function recordDocumentIdentityFailureDiagnostic(error, run = null) {
  const observation = normalizeDocumentIdentityObservation(error?.identityObservation, "unavailable");
  if (observation.outcome !== "unavailable") return false;
  return appendPostCommitDiagnostic("document_identity_unconfirmed", {
    runId: run?.runId ?? error?.runId ?? null,
    phase: run?.phase ?? "identity-fail-closed",
    status: run?.status ?? "paused",
    reason: observation.reason,
    outcome: observation.outcome,
    attempt: observation.attempt,
    totalAttempts: observation.totalAttempts,
    durationMs: observation.durationMs,
    boundary: observation.boundary,
    episodeId: observation.episodeId,
    consecutiveUnavailable: observation.consecutiveUnavailable,
    recoveryElapsedMs: observation.recoveryElapsedMs,
    failureCode: observation.failureCode,
    identitySource: observation.source,
    ...(observation.observationMissing === true ? { identityObservationMissing: true } : {})
  });
}

function recordDocumentIdentityRecoveryDiagnostic(response, run = null) {
  const observation = normalizeDocumentIdentityObservation(response?.identityObservation, "match");
  if (observation.outcome !== "match" || observation.consecutiveUnavailable < 1) return false;
  return appendPostCommitDiagnostic("document_identity_recovered", {
    runId: run?.runId ?? response?.run?.runId ?? null,
    phase: run?.phase ?? response?.run?.phase ?? "identity-recovery",
    status: run?.status ?? response?.run?.status ?? "running",
    reason: observation.reason,
    outcome: observation.outcome,
    attempt: observation.attempt,
    totalAttempts: observation.totalAttempts,
    durationMs: observation.durationMs,
    boundary: observation.boundary,
    episodeId: observation.episodeId,
    consecutiveUnavailable: observation.consecutiveUnavailable,
    recoveryElapsedMs: observation.recoveryElapsedMs,
    failureCode: observation.failureCode,
    identitySource: observation.source
  });
}

function copyIdentityFailClosedContext(error, response) {
  if (response && Object.prototype.hasOwnProperty.call(response, "failClosedGuard")) {
    error.identityFailClosedGuard = response.failClosedGuard;
  }
  error.identityFailClosedHandled = response?.lifecycleCommitted === true ||
    response?.mismatchCommitted === true || response?.lifecycleContextStale === true ||
    response?.mismatchContextStale === true || response?.failClosedAuthorityUnavailable === true;
}

function runFailClosedSnapshot(run) {
  return Object.fromEntries(
    ["runId", "stateRevision", "executionSessionId", "conversationKey", "boundDocumentId", "documentInstanceId"]
      .map((key) => [key, run?.[key]])
  );
}

function rememberRunFailClosedGuard(run, response) {
  if (!run || typeof run !== "object") return;
  const guard = response?.failClosedGuard;
  if (guard && typeof guard.token === "string" && guard.token.length > 0 && guard.runId === run.runId) {
    // A read-only recovery may return a rebound view without changing the stored
    // binding. Keep the issued guard opaque; retain the returned view separately.
    runFailClosedGuards.set(run, { guard, observed: runFailClosedSnapshot(run) });
  } else {
    runFailClosedGuards.delete(run);
  }
}

function inheritRunFailClosedGuard(run, observedRun) {
  const authority = observedRun && runFailClosedGuards.get(observedRun);
  // Refresh a capability only for the same snapshot. A newer observation must not
  // promote an old runner's stop authority to a different revision/binding.
  if (authority && Object.entries(authority.observed).every(([key, value]) => value === run?.[key])) {
    runFailClosedGuards.set(run, authority);
  }
}

function throwDocumentIdentityFailure(response, authorityBoundary = "run-read") {
  const code = response?.errorCode;
  if (code !== "DOCUMENT_IDENTITY_UNCONFIRMED" && code !== "DOCUMENT_IDENTITY_MISMATCH") return;
  const error = new Error(response?.error ?? "Document identity could not be confirmed.");
  error.code = code === "DOCUMENT_IDENTITY_MISMATCH"
    ? "document_identity_mismatch"
    : "document_identity_unconfirmed";
  copyIdentityFailClosedContext(error, response);
  error.identityObservation = normalizeDocumentIdentityObservation(
    response?.identityObservation,
    code === "DOCUMENT_IDENTITY_MISMATCH" ? "mismatch" : "unavailable",
    authorityBoundary
  );
  throw error;
}

async function acquireLease(conversationKey, runId, executionSessionId, readOnlyRecovery = null, run = null) {
  const observed = runFailClosedSnapshot(run);
  const response = await chrome.runtime.sendMessage({
    type: "AIPM_LEASE_ACQUIRE",
    conversationKey,
    runId,
    documentInstanceId: instanceId,
    serviceWorkerVersion: globalThis.__AIPM_CONTENT_CORE__?.version ?? null,
    executionSessionId,
    readOnlyRecovery,
    failClosedGuard: run && runFailClosedGuards.get(run)?.guard
  });
  throwDocumentIdentityFailure(response, "lease-acquire");
  recordDocumentIdentityRecoveryDiagnostic(response);
  if (run && Object.entries(observed).every(([key, value]) => value === run[key])) {
    rememberRunFailClosedGuard(run, response);
  }
  const lease = response?.ok && response.lease ? { ...response.lease, readOnlyRecovery } : null;
  if (lease && run) leaseRunContexts.set(lease, run);
  return lease;
}

async function renewLease(lease, runId) {
  if (!lease) return false;
  const run = leaseRunContexts.get(lease);
  const observed = runFailClosedSnapshot(run);
  const response = await chrome.runtime.sendMessage({
    type: "AIPM_LEASE_RENEW",
    conversationKey: lease.conversationKey,
    nonce: lease.nonce,
    runId,
    documentInstanceId: instanceId,
    serviceWorkerVersion: globalThis.__AIPM_CONTENT_CORE__?.version ?? null,
    executionSessionId: lease.executionSessionId,
    readOnlyRecovery: lease.readOnlyRecovery ?? null,
    failClosedGuard: runFailClosedGuards.get(run)?.guard
  });
  throwDocumentIdentityFailure(response, "lease-renew");
  recordDocumentIdentityRecoveryDiagnostic(response);
  if (run && Object.entries(observed).every(([key, value]) => value === run[key])) {
    rememberRunFailClosedGuard(run, response);
  }
  return response?.ok === true && response.renewed === true;
}

async function releaseLease(lease, runId) {
  if (!lease) return;
  await chrome.runtime.sendMessage({
    type: "AIPM_LEASE_RELEASE",
    conversationKey: lease.conversationKey,
    nonce: lease.nonce,
    runId,
    documentInstanceId: instanceId,
    serviceWorkerVersion: globalThis.__AIPM_CONTENT_CORE__?.version ?? null,
    executionSessionId: lease.executionSessionId,
    readOnlyRecovery: lease.readOnlyRecovery ?? null,
    failClosedGuard: runFailClosedGuards.get(leaseRunContexts.get(lease))?.guard
  }).catch(() => {});
}

function isConversationTransitionAllowed(run, actualKey) {
  return run?.conversationKey === actualKey;
}

async function migrateLeaseIfNeeded(lease, run) {
  const actualKey = ChatGptAdapter.getConversationKey();
  if (actualKey !== lease.conversationKey || run?.conversationKey !== actualKey) {
    throw makeError("conversation_changed");
  }
  return lease;
}

globalThis.__AIPM_CONTENT_CORE__ = { version: "0.4.4", ready: true };
