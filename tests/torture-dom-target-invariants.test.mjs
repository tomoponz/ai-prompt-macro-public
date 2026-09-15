// DOM target invariants that can be proven with synthetic page boundaries.
//
// Production evidence confirms long prompts can become composer attachments. These tests
// lock down only the bounded structural detector added for that evidence. Composer/Send
// target multiplicity remains outside C7 and still needs separate live evidence.
//
// Synthetic fixture success does not replace live-browser acceptance.
// See docs/release/PC_RELEASE_CHECKLIST.md for the separate manual gates.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const coreSource = fs.readFileSync(new URL("../src/content-core.js", import.meta.url), "utf8");

class SyntheticElement {
  constructor(selectors, { visible = true, form = null, attributes = {}, tagName = null } = {}) {
    this.selectors = selectors;
    this.visible = visible;
    this.form = form;
    this.attributes = attributes;
    this._children = [];
    this.parentElement = null;
    this.id = attributes.id ?? "";
    this.classList = {
      contains: (name) => String(attributes.class ?? "").split(/\s+/).includes(name)
    };
    this.tagName = tagName ?? (
      selectors.includes("form") ? "FORM" :
      selectors.some((selector) => selector.startsWith("button")) ? "BUTTON" :
      "DIV"
    );
  }

  get children() {
    return this._children;
  }

  set children(value) {
    this._children = Array.isArray(value) ? value : [];
    for (const child of this._children) child.parentElement = this;
  }

  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
  }

  getBoundingClientRect() {
    return this.visible ? { width: 100, height: 20 } : { width: 0, height: 0 };
  }

  closest(selector) {
    if (selector === "form" && this.form) return this.form;
    let current = this;
    while (current) {
      if (current.matches?.(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  matches(selector) {
    const wanted = String(selector).split(",").map((part) => part.trim());
    return this.selectors.some((candidate) => wanted.includes(candidate));
  }

  contains(node) {
    return node === this || this.children.some((child) => child === node || child.contains?.(node));
  }

  addEventListener() {}

  querySelectorAll(selector) {
    return matchAll(this.children, selector);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function matchAll(nodes, selector) {
  const wanted = String(selector).split(",").map((part) => part.trim()).filter(Boolean);
  const matches = [];
  const visited = new Set();
  const visit = (node) => {
    if (!node || visited.has(node)) return;
    visited.add(node);
    if (node.selectors.some((candidate) => wanted.includes(candidate))) matches.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of nodes) visit(node);
  return matches;
}

function createAdapterContext(nodes) {
  const context = vm.createContext({
    console,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    Node: { TEXT_NODE: 3 },
    Element: SyntheticElement,
    HTMLTextAreaElement: class HTMLTextAreaElement extends SyntheticElement {},
    HTMLInputElement: class HTMLInputElement extends SyntheticElement {},
    getComputedStyle: (element) => ({
      display: element.visible ? "block" : "none",
      visibility: element.visible ? "visible" : "hidden"
    }),
    location: { origin: "https://chatgpt.com", pathname: "/c/target-invariants" },
    document: {
      querySelectorAll: (selector) => matchAll(nodes, selector),
      querySelector: (selector) => matchAll(nodes, selector)[0] ?? null
    }
  });
  vm.runInContext(coreSource, context, { filename: "content-core.js" });
  return context;
}

function makeLiveFileTile({
  roleGroup = true,
  fileTileClass = true,
  visible = true,
  removeCount = 1,
  buttonCount = Math.max(2, removeCount),
  ordinarySvgCount = 0
} = {}) {
  assert.ok(Number.isSafeInteger(removeCount) && removeCount >= 0);
  assert.ok(Number.isSafeInteger(buttonCount) && buttonCount >= removeCount);
  assert.ok(Number.isSafeInteger(ordinarySvgCount) && ordinarySvgCount >= 0);
  const tile = new SyntheticElement(roleGroup ? ["[role='group']"] : ["div.synthetic-file-tile"], {
    visible,
    attributes: {
      ...(roleGroup ? { role: "group" } : {}),
      ...(fileTileClass ? { class: "group/file-tile" } : {}),
      "aria-label": "synthetic tile"
    }
  });
  const buttons = [];
  for (let index = 0; index < removeCount; index += 1) {
    const button = new SyntheticElement(["button"], {
      attributes: {
        "aria-label": `synthetic prefix ${index % 2 === 0 ? "REMOVE" : "削除"} synthetic suffix`,
        class: "behavior-btn"
      }
    });
    button.children = [new SyntheticElement(["svg"], { tagName: "SVG" })];
    buttons.push(button);
  }
  let ordinaryIndex = 0;
  while (buttons.length < buttonCount) {
    const ordinaryButton = new SyntheticElement(["button"], {
      attributes: { "aria-label": "synthetic ordinary action" }
    });
    if (ordinaryIndex < ordinarySvgCount) {
      ordinaryButton.children = [new SyntheticElement(["svg"], { tagName: "SVG" })];
    }
    buttons.unshift(ordinaryButton);
    ordinaryIndex += 1;
  }
  tile.children = buttons;
  return tile;
}

function makeLiveComposerFixture(tiles = [], outsideNodes = []) {
  const surface = new SyntheticElement(["[data-testid='composer-surface']"]);
  const inner = new SyntheticElement(["div.composer-inner"]);
  const composerForm = new SyntheticElement(["form"]);
  const composer = new SyntheticElement(["#prompt-textarea"], {
    form: composerForm,
    attributes: { id: "prompt-textarea", class: "ProseMirror", contenteditable: "true" }
  });
  const placeholderParagraph = new SyntheticElement(["p.placeholder"], { tagName: "P" });
  const sendButton = new SyntheticElement(["button[data-testid='send-button']", "button"]);
  const header = new SyntheticElement(["header"], { tagName: "HEADER" });
  composer.children = [placeholderParagraph];
  composerForm.children = [composer, sendButton];
  inner.children = [composerForm];
  header.children = tiles;
  surface.children = [header, inner];
  const context = createAdapterContext([...outsideNodes, surface]);
  return { context, surface, composer, sendButton };
}

function nestNodeAtAncestorDepth(node, ancestor, depth, label) {
  assert.ok(Number.isSafeInteger(depth) && depth >= 1);
  let branch = node;
  for (let currentDepth = 1; currentDepth < depth; currentDepth += 1) {
    const wrapper = new SyntheticElement([`div.${label}-${currentDepth}`]);
    wrapper.children = [branch];
    branch = wrapper;
  }
  ancestor.children = [...ancestor.children, branch];
}

function makeDepthBoundLiveComposerFixture(
  tileDepth,
  { preExisting = false, tileCount = 1, tileOptions = {} } = {}
) {
  const composerForm = new SyntheticElement(["form"]);
  const composer = new SyntheticElement(["#prompt-textarea"], {
    form: composerForm,
    attributes: { id: "prompt-textarea", class: "ProseMirror", contenteditable: "true" }
  });
  composer.children = [new SyntheticElement(["p.placeholder"], { tagName: "P" })];
  const sendButton = new SyntheticElement(["button[data-testid='send-button']", "button"]);
  const tiles = Array.from({ length: tileCount }, () => makeLiveFileTile(tileOptions));
  nestNodeAtAncestorDepth(composer, composerForm, 6, "composer-depth");
  for (const [index, tile] of tiles.entries()) {
    nestNodeAtAncestorDepth(tile, composerForm, tileDepth, `tile-${index}-depth`);
  }
  composerForm.children = [...composerForm.children, sendButton];
  const context = createAdapterContext([composerForm]);
  const { binding, transaction } = makeLiveDeliveryTransaction(
    context,
    composerForm,
    composer,
    preExisting ? tiles : []
  );
  transaction.scopeKind = "form";
  transaction.composerDepth = 6;
  return {
    context,
    surface: composerForm,
    composer,
    sendButton,
    tile: tiles[0] ?? null,
    tiles,
    binding,
    transaction
  };
}

function makeLiveDeliveryTransaction(context, surface, composer, beforeAttachmentNodes = []) {
  const binding = {
    deliveryAttemptToken: "attempt-c10-2",
    runId: "run-c10-2",
    executionSessionId: "session-c10-2",
    stepId: "step-c10-2",
    stateRevision: 1,
    stepIndex: 0,
    repeatIndex: 0,
    sendsCompleted: 0,
    promptHash: "hash-c10-2",
    documentInstanceId: context.instanceId,
    conversationKey: "chatgpt:c:target-invariants",
    runnerToken: 1
  };
  return {
    binding,
    transaction: {
      active: true,
      pasteHandled: true,
      binding,
      composer,
      composerSurface: surface,
      scopeKind: "marked-ancestor",
      composerDepth: 3,
      tracker: { epoch: 0 },
      userMutationEpoch: 0,
      beforeAttachmentNodes: new Set(beforeAttachmentNodes),
      seenAttachmentNodes: new Set(),
      candidatesSeen: 0,
      maxLogicalCandidates: 0,
      replacements: 0,
      mutations: 0,
      startedAt: Date.now(),
      stableSince: Date.now(),
      lastObservedMode: null,
      lastObservedCandidate: null,
      lastObservedTextState: "unknown",
      lastObservedCount: 0,
      attachmentCandidate: null,
      attachmentSignature: null,
      invalidReason: null
    }
  };
}

const COMPOSER_SELECTORS = [
  "#prompt-textarea",
  "textarea[data-testid='prompt-textarea']",
  "div[data-testid='prompt-textarea'][contenteditable='true']",
  "textarea[name='prompt-textarea']"
];

test("HIGH-2 A: marked composer surface stays stable when a pasted-text child appears and siblings reorder", () => {
  const fixture = makeLiveComposerFixture([]);
  const before = fixture.context.safeComposerSurface(fixture.composer);
  assert.equal(before?.kind, "marked-ancestor");
  assert.equal(before?.node, fixture.surface);
  const { binding, transaction } = makeLiveDeliveryTransaction(
    fixture.context,
    fixture.surface,
    fixture.composer
  );

  const header = fixture.surface.children[0];
  const inner = fixture.surface.children[1];
  const tile = makeLiveFileTile();
  header.children = [tile];
  const appeared = fixture.context.ChatGptAdapter.inspectPromptDelivery(
    transaction,
    "surface-stability prompt",
    binding,
    null,
    { settling: true, lock: true }
  );
  assert.equal(appeared.ok, true);
  assert.equal(appeared.mode, "paste-attachment");

  fixture.surface.children = [inner, header];
  const after = fixture.context.safeComposerSurface(fixture.composer);
  assert.equal(after?.node, before.node);
  assert.equal(after?.kind, before.kind);
  assert.equal(fixture.context.ChatGptAdapter.inspectPromptDelivery(
    transaction,
    "surface-stability prompt",
    binding,
    "paste-attachment",
    { settling: false }
  ).ok, true);
});

test("HIGH-2 B: form surface stays stable when a depth-7 tile appears and child branches reorder", () => {
  const fixture = makeDepthBoundLiveComposerFixture(7, { tileCount: 0 });
  const before = fixture.context.safeComposerSurface(fixture.composer);
  assert.equal(before?.kind, "form");
  assert.equal(before?.node, fixture.surface);

  const tile = makeLiveFileTile();
  nestNodeAtAncestorDepth(tile, fixture.surface, 7, "high2-form-tile");
  const appeared = fixture.context.ChatGptAdapter.inspectPromptDelivery(
    fixture.transaction,
    "surface-stability prompt",
    fixture.binding,
    null,
    { settling: true, lock: true }
  );
  assert.equal(appeared.ok, true);
  assert.equal(appeared.mode, "paste-attachment");

  fixture.surface.children = [...fixture.surface.children].reverse();
  const after = fixture.context.safeComposerSurface(fixture.composer);
  assert.equal(after?.node, before.node);
  assert.equal(after?.kind, before.kind);
  assert.equal(fixture.context.ChatGptAdapter.inspectPromptDelivery(
    fixture.transaction,
    "surface-stability prompt",
    fixture.binding,
    "paste-attachment",
    { settling: false }
  ).ok, true);
});

test("HIGH-2 C: bounded common-ancestor surface stays stable under scoped child rearrangement", () => {
  const surface = new SyntheticElement(["div.high2-common-surface"]);
  const composer = new SyntheticElement(["#prompt-textarea"], {
    attributes: { id: "prompt-textarea", class: "ProseMirror", contenteditable: "true" }
  });
  composer.children = [new SyntheticElement(["p.placeholder"], { tagName: "P" })];
  const sendButton = new SyntheticElement(["button[data-testid='send-button']", "button"]);
  surface.children = [composer, sendButton];
  const context = createAdapterContext([surface]);
  const before = context.safeComposerSurface(composer);
  assert.equal(before?.kind, "bounded-common-ancestor");
  assert.equal(before?.node, surface);
  const { binding, transaction } = makeLiveDeliveryTransaction(context, surface, composer);
  transaction.scopeKind = "bounded-common-ancestor";
  transaction.composerDepth = 1;

  const tile = makeLiveFileTile();
  surface.children = [composer, tile, sendButton];
  const appeared = context.ChatGptAdapter.inspectPromptDelivery(
    transaction,
    "surface-stability prompt",
    binding,
    null,
    { settling: true, lock: true }
  );
  assert.equal(appeared.ok, true);
  assert.equal(appeared.mode, "paste-attachment");

  surface.children = [tile, sendButton, composer];
  const after = context.safeComposerSurface(composer);
  assert.equal(after?.node, before.node);
  assert.equal(after?.kind, before.kind);
  assert.equal(context.ChatGptAdapter.inspectPromptDelivery(
    transaction,
    "surface-stability prompt",
    binding,
    "paste-attachment",
    { settling: false }
  ).ok, true);
});

test("Overnight C1 RED: multiple visible composer candidates fail closed", () => {
  const preferred = new SyntheticElement(["#prompt-textarea"], { attributes: { id: "prompt-textarea" } });
  const alternate = new SyntheticElement(["textarea[data-testid='prompt-textarea']"]);
  const context = createAdapterContext([alternate, preferred]);

  assert.equal(context.ChatGptAdapter.findComposer(), null, "DOM order must not authorize one of two composers");
  assert.equal(context.ChatGptAdapter.findSendButton(), null, "composer ambiguity must expose no Send target");
  void COMPOSER_SELECTORS;
});

test("DOM: an invisible higher-priority composer is skipped, never returned", () => {
  const hidden = new SyntheticElement(["#prompt-textarea"], { visible: false });
  const visible = new SyntheticElement(["textarea[data-testid='prompt-textarea']"]);
  const context = createAdapterContext([hidden, visible]);

  assert.equal(context.ChatGptAdapter.findComposer(), visible, "a zero-size or hidden node is not a target");
});

test("DOM: with no visible composer at all the adapter returns null instead of guessing", () => {
  const hidden = new SyntheticElement(["#prompt-textarea"], { visible: false });
  const context = createAdapterContext([hidden]);
  assert.equal(context.ChatGptAdapter.findComposer(), null);
  assert.equal(context.ChatGptAdapter.findSendButton(), null, "no composer means no send target");
});

test("Overnight C1 RED: a provider Send outside the current composer form has no authority", () => {
  const form = new SyntheticElement(["form"]);
  const composer = new SyntheticElement(["#prompt-textarea"], { form });
  const providerButton = new SyntheticElement(["button[data-testid='send-button']"]);
  const ariaButton = new SyntheticElement(["button[aria-label='Send prompt']"]);
  form.children = [composer, ariaButton];
  const context = createAdapterContext([composer, ariaButton, providerButton]);

  assert.equal(
    context.ChatGptAdapter.findSendButton(),
    ariaButton,
    "provider identity cannot replace structural binding to the current composer form"
  );
});

test("Overnight C1 RED: two visible Send candidates in one composer form are ambiguous", () => {
  const form = new SyntheticElement(["form"]);
  const composer = new SyntheticElement(["#prompt-textarea"], { form });
  const providerButton = new SyntheticElement(["button[data-testid='send-button']", "button"]);
  const ariaButton = new SyntheticElement(["button[aria-label='Send prompt']", "button"]);
  form.children = [composer, providerButton, ariaButton];
  const context = createAdapterContext([form]);

  assert.equal(context.ChatGptAdapter.findSendButton(), null, "first visible must not resolve ambiguity");
});

test("Overnight C1 RED: selector overlap is deduplicated by element identity", () => {
  const form = new SyntheticElement(["form"]);
  const composer = new SyntheticElement(["#prompt-textarea"], { form });
  const sendButton = new SyntheticElement([
    "button[data-testid='send-button']",
    "button[aria-label='Send prompt']",
    "button"
  ]);
  form.children = [composer, sendButton];
  const context = createAdapterContext([form]);

  assert.equal(context.ChatGptAdapter.findSendButton(), sendButton, "one node matching two selectors is still unique");
});

test("DOM: the aria-label fallback is scoped to the composer's own form", () => {
  const composerForm = new SyntheticElement(["form"]);
  const otherForm = new SyntheticElement(["form"]);
  const composer = new SyntheticElement(["#prompt-textarea"], { form: composerForm });
  const ownButton = new SyntheticElement(["button[aria-label='Send prompt']"]);
  const foreignButton = new SyntheticElement(["button[aria-label='Send prompt']"]);
  composerForm.children = [composer, ownButton];
  otherForm.children = [foreignButton];
  // The foreign button is declared first, so an unscoped page-wide query would pick it.
  const context = createAdapterContext([foreignButton, composer, ownButton]);

  assert.equal(
    context.ChatGptAdapter.findSendButton(),
    ownButton,
    "a send button belonging to another form must never be clickable for this composer"
  );
});

test("DOM: a composer with no enclosing form yields no send target at all", () => {
  const composer = new SyntheticElement(["#prompt-textarea"], { form: null });
  const strayButton = new SyntheticElement(["button[aria-label='Send prompt']"]);
  const context = createAdapterContext([composer, strayButton]);

  assert.equal(
    context.ChatGptAdapter.findSendButton(),
    null,
    "without a form the adapter must fail closed rather than click a page-wide guess"
  );
});

test("C7 DOM: only visible attachment surfaces inside the active composer form are counted", () => {
  const composerForm = new SyntheticElement(["form"]);
  const composer = new SyntheticElement(["#prompt-textarea"], { form: composerForm });
  const ownAttachment = new SyntheticElement(["[data-testid='file-thumbnail']"]);
  const assistantAttachment = new SyntheticElement(["[data-testid='file-thumbnail']"]);
  composerForm.children = [composer, ownAttachment];
  const context = createAdapterContext([assistantAttachment, composer, ownAttachment]);

  const state = context.ChatGptAdapter.getComposerAttachmentState(composer);
  assert.equal(state.known, true);
  assert.equal(state.count, 1, "an attachment shown in assistant history must not affect composer Send authority");
  assert.equal(state.hiddenCount, 0);
  assert.deepEqual([...state.logicalNodes], [ownAttachment]);
  assert.equal(state.composerForm, composerForm);
});

test("Overnight C3 RED: a foreign provider Send cannot invalidate the current composer attachment scope", () => {
  const composerForm = new SyntheticElement(["form"]);
  const otherForm = new SyntheticElement(["form"]);
  const composer = new SyntheticElement(["#prompt-textarea"], { form: composerForm });
  const ownAttachment = new SyntheticElement(["[data-testid='file-thumbnail']"]);
  const foreignSend = new SyntheticElement(["button[data-testid='send-button']", "button"]);
  composerForm.children = [composer, ownAttachment];
  otherForm.children = [foreignSend];
  const context = createAdapterContext([otherForm, composerForm]);

  const state = context.ChatGptAdapter.getComposerAttachmentState(composer);
  assert.equal(state.known, true, "a Send in another form must not make the current form unobservable");
  assert.equal(state.count, 1);
  assert.equal(state.composerForm, composerForm);
});

test("Overnight C3 RED: multiple Send controls cannot make attachment settlement actionable", () => {
  const surface = new SyntheticElement(["[data-testid='composer-surface']"]);
  const firstSend = new SyntheticElement(["button[data-testid='send-button']", "button"]);
  const secondSend = new SyntheticElement(["button[aria-label='Send prompt']", "button"]);
  surface.children = [firstSend, secondSend];
  const context = createAdapterContext([surface]);

  assert.equal(
    context.composerSurfaceSendIsActionable({ composerSurface: surface }),
    false,
    "actionability must require exactly one visible Send identity"
  );
});

test("C7 DOM: hidden and unrelated composer-form controls are not attachment evidence", () => {
  const composerForm = new SyntheticElement(["form"]);
  const composer = new SyntheticElement(["#prompt-textarea"], { form: composerForm });
  const hiddenAttachment = new SyntheticElement(["[data-testid='paste-attachment']"], { visible: false });
  const uploadButton = new SyntheticElement(["button[aria-label='Upload file']"]);
  const genericFileText = new SyntheticElement(["div.file-text"]);
  composerForm.children = [composer, hiddenAttachment, uploadButton, genericFileText];
  const context = createAdapterContext([composer, hiddenAttachment, uploadButton, genericFileText]);

  const state = context.ChatGptAdapter.getComposerAttachmentState(composer);
  assert.equal(state.known, true);
  assert.equal(state.count, 0);
  assert.equal(state.hiddenCount, 1, "hidden attachment evidence must remain fail-closed metadata");
  assert.deepEqual([...state.logicalNodes], []);
  assert.equal(state.composerForm, composerForm);
});

test("C7 DOM: multiple explicit active attachment surfaces fail as a bounded nonzero count", () => {
  const composerForm = new SyntheticElement(["form"]);
  const composer = new SyntheticElement(["#prompt-textarea"], { form: composerForm });
  const firstAttachment = new SyntheticElement(["[data-testid='composer-attachment']"]);
  const secondAttachment = new SyntheticElement(["button[aria-label^='Remove file']"]);
  composerForm.children = [composer, firstAttachment, secondAttachment];
  const context = createAdapterContext([composer, firstAttachment, secondAttachment]);

  const state = context.ChatGptAdapter.getComposerAttachmentState(composer);
  assert.equal(state.known, true);
  assert.equal(state.count, 2);
  assert.equal(state.hiddenCount, 0);
  assert.deepEqual([...state.logicalNodes], [firstAttachment, secondAttachment]);
  assert.equal(state.composerForm, composerForm);
});

test("C7 DOM: attachment absence is unknown without a composer-owned form", () => {
  const composer = new SyntheticElement(["#prompt-textarea"], { form: null });
  const context = createAdapterContext([composer]);
  const state = context.ChatGptAdapter.getComposerAttachmentState(composer);
  assert.equal(state.known, false);
  assert.equal(state.count, 0);
  assert.equal(state.hiddenCount, 0);
  assert.deepEqual([...state.logicalNodes], []);
});

test("C7 DOM: excessive matching candidates become unknown instead of creating an unbounded scan", () => {
  const composerForm = new SyntheticElement(["form"]);
  const composer = new SyntheticElement(["#prompt-textarea"], { form: composerForm });
  composerForm.children = [
    composer,
    ...Array.from({ length: 65 }, () => new SyntheticElement(["[data-testid='file-thumbnail']"], { visible: false }))
  ];
  const context = createAdapterContext([composer]);

  const state = context.ChatGptAdapter.getComposerAttachmentState(composer);
  assert.equal(state.known, false);
  assert.equal(state.count, 0);
  assert.equal(state.hiddenCount, 0);
  assert.deepEqual([...state.logicalNodes], []);
});

test("C10.1 R13 DOM: the measured production header/file-tile structure is attachment-ready", () => {
  const surface = new SyntheticElement(["[data-testid='composer-surface']"]);
  const inner = new SyntheticElement(["div.composer-inner"]);
  const composerForm = new SyntheticElement(["form"]);
  const composer = new SyntheticElement(["#prompt-textarea"], {
    form: composerForm,
    attributes: { id: "prompt-textarea", class: "ProseMirror", contenteditable: "true" }
  });
  const placeholderParagraph = new SyntheticElement(["p.placeholder"], { tagName: "P" });
  const sendButton = new SyntheticElement(["button[data-testid='send-button']", "button"]);
  const header = new SyntheticElement(["header"], { tagName: "HEADER" });
  const fileTile = new SyntheticElement(["[data-testid='file-tile']"], {
    attributes: { "data-testid": "file-tile", role: "group" }
  });
  const removeButton = new SyntheticElement(["button", "button[data-testid='remove-attachment-button']"], {
    attributes: { "data-testid": "remove-attachment-button" }
  });
  composer.children = [placeholderParagraph];
  fileTile.children = [removeButton];
  header.children = [fileTile];
  composerForm.children = [composer, sendButton];
  inner.children = [composerForm];
  surface.children = [header, inner];
  const context = createAdapterContext([surface]);

  const attachmentState = context.ChatGptAdapter.getComposerAttachmentState(composer);
  assert.equal(attachmentState.known, true);
  assert.equal(attachmentState.count, 1);
  assert.equal(attachmentState.hiddenCount, 0);
  assert.equal(attachmentState.composerDepth, 3);
  assert.equal(attachmentState.headerCandidateCount, 1);

  const binding = {
    deliveryAttemptToken: "attempt-r13",
    runId: "run-r13",
    executionSessionId: "session-r13",
    stepId: "step-r13",
    stateRevision: 1,
    stepIndex: 0,
    repeatIndex: 0,
    sendsCompleted: 0,
    promptHash: "hash-r13",
    documentInstanceId: context.instanceId,
    conversationKey: "chatgpt:c:target-invariants",
    runnerToken: 1
  };
  const transaction = {
    active: true,
    pasteHandled: true,
    binding,
    composer,
    composerSurface: surface,
    scopeKind: "marked-ancestor",
    composerDepth: 3,
    tracker: { epoch: 0 },
    userMutationEpoch: 0,
    beforeAttachmentNodes: new Set(),
    seenAttachmentNodes: new Set(),
    candidatesSeen: 0,
    maxLogicalCandidates: 0,
    replacements: 0,
    mutations: 0,
    startedAt: Date.now(),
    stableSince: Date.now(),
    lastObservedMode: null,
    lastObservedCandidate: null,
    lastObservedTextState: "unknown",
    lastObservedCount: 0,
    attachmentCandidate: null,
    attachmentSignature: null,
    invalidReason: null
  };
  const observed = context.ChatGptAdapter.inspectPromptDelivery(
    transaction,
    "production long prompt",
    binding,
    null,
    { settling: true }
  );

  assert.equal(observed.ok, true);
  assert.equal(observed.mode, "paste-attachment");
  assert.equal(observed.diagnostic.lastState, "attachment-ready");
  assert.equal(observed.diagnostic.logicalAttachmentCount, 1);
  assert.equal(observed.diagnostic.headerCandidateCount, 1);
  assert.equal(observed.diagnostic.surfaceDepth, 3);
  assert.equal(observed.diagnostic.sendActionable, true);
});

test("C10.2 R1 RED: current live file-tile without testids is one logical composer attachment", () => {
  const surface = new SyntheticElement(["[data-testid='composer-surface']"]);
  const inner = new SyntheticElement(["div.composer-inner"]);
  const composerForm = new SyntheticElement(["form"]);
  const composer = new SyntheticElement(["#prompt-textarea"], {
    form: composerForm,
    attributes: { id: "prompt-textarea", class: "ProseMirror", contenteditable: "true" }
  });
  const placeholderParagraph = new SyntheticElement(["p.placeholder"], { tagName: "P" });
  const sendButton = new SyntheticElement(["button[data-testid='send-button']", "button"]);
  const header = new SyntheticElement(["header"], { tagName: "HEADER" });
  const fileTile = new SyntheticElement(["[role='group']"], {
    attributes: { role: "group", class: "group/file-tile", "aria-label": "synthetic tile" }
  });
  const ordinaryButton = new SyntheticElement(["button"], {
    attributes: { "aria-label": "synthetic ordinary action" }
  });
  const removeButton = new SyntheticElement(["button"], {
    attributes: {
      "aria-label": "synthetic prefix REMOVE synthetic suffix",
      class: "behavior-btn"
    }
  });
  const removeIcon = new SyntheticElement(["svg"], { tagName: "SVG" });
  removeButton.children = [removeIcon];
  fileTile.children = [ordinaryButton, removeButton];
  header.children = [fileTile];
  composer.children = [placeholderParagraph];
  composerForm.children = [composer, sendButton];
  inner.children = [composerForm];
  surface.children = [header, inner];
  const context = createAdapterContext([surface]);

  const attachmentState = context.ChatGptAdapter.getComposerAttachmentState(composer);
  const oldContainerMatches = context.COMPOSER_ATTACHMENT_CONTAINER_SELECTORS
    .reduce((count, selector) => count + surface.querySelectorAll(selector).length, 0);
  const oldRemoveMatches = context.COMPOSER_ATTACHMENT_REMOVE_SELECTORS
    .reduce((count, selector) => count + surface.querySelectorAll(selector).length, 0);
  assert.equal(oldContainerMatches, 0);
  assert.equal(oldRemoveMatches, 0);
  assert.equal(attachmentState.known, true);
  assert.equal(attachmentState.count, 1);
  assert.deepEqual([...attachmentState.logicalNodes], [fileTile]);
  const { binding, transaction } = makeLiveDeliveryTransaction(context, surface, composer);
  const observed = context.ChatGptAdapter.inspectPromptDelivery(
    transaction,
    "synthetic long prompt",
    binding,
    null,
    { settling: true }
  );
  assert.equal(observed.ok, true);
  assert.equal(observed.mode, "paste-attachment");
  assert.equal(observed.diagnostic.fileTileFallbackSeen, true);
  assert.equal(observed.diagnostic.fileTileFallbackCount, 1);
  assert.equal(observed.diagnostic.derivedRemoveSemanticCount, 1);
  assert.equal(observed.diagnostic.fallbackAccepted, true);
  assert.equal(observed.diagnostic.fallbackRejectReason, "none");
  assert.equal(JSON.stringify(observed.diagnostic).includes("REMOVE"), false,
    "raw aria-label content must not enter diagnostics");
});

test("C10.2 R2: role group without the exact file-tile class is ignored", () => {
  const tile = makeLiveFileTile({ fileTileClass: false });
  const { context, composer } = makeLiveComposerFixture([tile]);
  const state = context.ChatGptAdapter.getComposerAttachmentState(composer);
  assert.equal(state.known, true);
  assert.equal(state.count, 0);
});

test("C10.2 R3: file-tile without a unique remove semantic fails closed", () => {
  const tile = makeLiveFileTile({ removeCount: 0 });
  const { context, composer } = makeLiveComposerFixture([tile]);
  const state = context.ChatGptAdapter.getComposerAttachmentState(composer);
  assert.equal(state.known, false);
  assert.equal(state.count, 0);
  assert.equal(state.fallbackRejectReason, "no-remove-semantic");
});

test("C10.2 R4: two derived remove controls are ambiguous", () => {
  const tile = makeLiveFileTile({ removeCount: 2 });
  const { context, composer } = makeLiveComposerFixture([tile]);
  const state = context.ChatGptAdapter.getComposerAttachmentState(composer);
  assert.equal(state.known, false);
  assert.equal(state.count, 0);
  assert.equal(state.derivedRemoveSemanticCount, 2);
  assert.equal(state.fallbackRejectReason, "multiple-remove-semantics");
});

test("C10.2 R5: two valid live file tiles remain two logical attachments", () => {
  const tiles = [makeLiveFileTile(), makeLiveFileTile()];
  const { context, composer } = makeLiveComposerFixture(tiles);
  const state = context.ChatGptAdapter.getComposerAttachmentState(composer);
  assert.equal(state.known, true);
  assert.equal(state.count, 2);
  assert.equal(state.fallbackAccepted, false);
  assert.equal(state.fallbackRejectReason, "multiple-file-tiles");
});

test("C10.2 R6/R7: live file tiles outside the exact composer surface are ignored", () => {
  const outsideTile = makeLiveFileTile();
  const { context, composer } = makeLiveComposerFixture([], [outsideTile]);
  const state = context.ChatGptAdapter.getComposerAttachmentState(composer);
  assert.equal(state.known, true);
  assert.equal(state.count, 0, "assistant/history decoys must never enter composer authority");
  assert.equal(state.fileTileFallbackSeen, false);
});

test("C10.2 R8: a hidden live file tile cannot authorize attachment delivery", () => {
  const tile = makeLiveFileTile({ visible: false });
  const { context, composer } = makeLiveComposerFixture([tile]);
  const state = context.ChatGptAdapter.getComposerAttachmentState(composer);
  assert.equal(state.known, false);
  assert.equal(state.count, 0);
  assert.equal(state.hiddenCount, 1);
  assert.equal(state.fallbackRejectReason, "hidden");
});

test("C10.2 R9: remove-like aria outside a file-tile is not attachment evidence", () => {
  const removeLikeButton = new SyntheticElement(["button"], {
    attributes: { "aria-label": "synthetic REMOVE action", class: "behavior-btn" }
  });
  removeLikeButton.children = [new SyntheticElement(["svg"], { tagName: "SVG" })];
  const { context, composer } = makeLiveComposerFixture([removeLikeButton]);
  const state = context.ChatGptAdapter.getComposerAttachmentState(composer);
  assert.equal(state.known, true);
  assert.equal(state.count, 0);
});

test("C10.2 R10: the file-tile class without role group is not attachment evidence", () => {
  const tile = makeLiveFileTile({ roleGroup: false });
  const { context, composer } = makeLiveComposerFixture([tile]);
  const state = context.ChatGptAdapter.getComposerAttachmentState(composer);
  assert.equal(state.known, true);
  assert.equal(state.count, 0);
});

test("C10.2 R11: a pre-existing identical live file tile cannot acquire Macro provenance", () => {
  const tile = makeLiveFileTile();
  const { context, surface, composer } = makeLiveComposerFixture([tile]);
  const { binding, transaction } = makeLiveDeliveryTransaction(context, surface, composer, [tile]);
  const observed = context.ChatGptAdapter.inspectPromptDelivery(
    transaction,
    "synthetic long prompt",
    binding,
    null,
    { settling: true }
  );
  assert.equal(observed.ok, false);
  assert.equal(observed.reason, "attachment-provenance-lost");
});

test("C10.2 R12: trusted user interaction invalidates a ready live file tile", () => {
  const tile = makeLiveFileTile();
  const { context, surface, composer } = makeLiveComposerFixture([tile]);
  const { binding, transaction } = makeLiveDeliveryTransaction(context, surface, composer);
  transaction.tracker.epoch = 1;
  const observed = context.ChatGptAdapter.inspectPromptDelivery(
    transaction,
    "synthetic long prompt",
    binding,
    null,
    { settling: true }
  );
  assert.equal(observed.ok, false);
  assert.equal(observed.reason, "user-interaction");
});

test("C10.4 LIVE-3BTN-1 RED: the measured three-button depth-7 tile is one Macro attachment", () => {
  const fixture = makeDepthBoundLiveComposerFixture(7, {
    tileOptions: { buttonCount: 3, removeCount: 1, ordinarySvgCount: 1 }
  });
  const attachmentState = fixture.context.ChatGptAdapter.getComposerAttachmentState(fixture.composer);

  assert.equal(attachmentState.scopeKind, "form");
  assert.equal(attachmentState.composerDepth, 6);
  assert.equal(attachmentState.fallbackRejectReason, "none");
  assert.equal(attachmentState.known, true);
  assert.equal(attachmentState.count, 1);
  assert.equal(attachmentState.fallbackAccepted, true);
  assert.equal(attachmentState.derivedRemoveSemanticCount, 1);

  const observed = fixture.context.ChatGptAdapter.inspectPromptDelivery(
    fixture.transaction,
    "synthetic long prompt",
    fixture.binding,
    null,
    { settling: true }
  );
  assert.equal(observed.ok, true);
  assert.equal(observed.mode, "paste-attachment");
});

test("C10.4 button semantics: legacy two-button and live three-button tiles require one remove control", () => {
  for (const buttonCount of [2, 3]) {
    const fixture = makeDepthBoundLiveComposerFixture(7, {
      tileOptions: { buttonCount, removeCount: 1, ordinarySvgCount: 1 }
    });
    const state = fixture.context.ChatGptAdapter.getComposerAttachmentState(fixture.composer);
    assert.equal(state.known, true, `${buttonCount} buttons must remain structurally known`);
    assert.equal(state.count, 1);
    assert.equal(state.derivedRemoveSemanticCount, 1);
    assert.equal(state.fallbackAccepted, true);
  }

  for (const [removeCount, reason] of [[0, "no-remove-semantic"], [2, "multiple-remove-semantics"]]) {
    const fixture = makeDepthBoundLiveComposerFixture(7, {
      tileOptions: { buttonCount: 3, removeCount, ordinarySvgCount: 1 }
    });
    const state = fixture.context.ChatGptAdapter.getComposerAttachmentState(fixture.composer);
    assert.equal(state.known, false);
    assert.equal(state.count, 0);
    assert.equal(state.fallbackRejectReason, reason);
  }
});

test("C10.4 button traversal stays bounded without making the total count semantic authority", () => {
  const bounded = makeDepthBoundLiveComposerFixture(7, {
    tileOptions: { buttonCount: 8, removeCount: 1, ordinarySvgCount: 3 }
  });
  const boundedState = bounded.context.ChatGptAdapter.getComposerAttachmentState(bounded.composer);
  assert.equal(boundedState.known, true);
  assert.equal(boundedState.count, 1);

  const excessive = makeDepthBoundLiveComposerFixture(7, {
    tileOptions: { buttonCount: 9, removeCount: 1, ordinarySvgCount: 3 }
  });
  const excessiveState = excessive.context.ChatGptAdapter.getComposerAttachmentState(excessive.composer);
  assert.equal(excessiveState.known, false);
  assert.equal(excessiveState.count, 0);
  assert.equal(excessiveState.fallbackRejectReason, "button-count-invalid");
});

test("C10.4 surface and depth boundaries remain exact for a three-button tile", () => {
  for (const depth of [8, 9]) {
    const fixture = makeDepthBoundLiveComposerFixture(depth, {
      tileOptions: { buttonCount: 3, removeCount: 1, ordinarySvgCount: 1 }
    });
    const state = fixture.context.ChatGptAdapter.getComposerAttachmentState(fixture.composer);
    const signature = fixture.context.candidateStructuralSignature(fixture.tile, state);
    assert.equal(signature !== null, depth === 8);
    const observed = fixture.context.ChatGptAdapter.inspectPromptDelivery(
      fixture.transaction,
      "synthetic long prompt",
      fixture.binding,
      null,
      { settling: true }
    );
    assert.equal(observed.ok, depth === 8);
    if (depth === 9) assert.equal(observed.reason, "attachment-provenance-lost");
  }

  const outsideTile = makeLiveFileTile({ buttonCount: 3, removeCount: 1, ordinarySvgCount: 1 });
  const outside = makeLiveComposerFixture([], [outsideTile]);
  const outsideState = outside.context.ChatGptAdapter.getComposerAttachmentState(outside.composer);
  assert.equal(outsideState.known, true);
  assert.equal(outsideState.count, 0);
  assert.equal(outsideState.fileTileFallbackSeen, false);

  const hidden = makeDepthBoundLiveComposerFixture(7, {
    tileOptions: { buttonCount: 3, removeCount: 1, visible: false }
  });
  const hiddenState = hidden.context.ChatGptAdapter.getComposerAttachmentState(hidden.composer);
  assert.equal(hiddenState.known, false);
  assert.equal(hiddenState.fallbackRejectReason, "hidden");
});

test("C10.4 ownership rejects pre-existing, user-raced, and multiple candidates while replacement stays advisory", () => {
  const preExisting = makeDepthBoundLiveComposerFixture(7, {
    preExisting: true,
    tileOptions: { buttonCount: 3, removeCount: 1, ordinarySvgCount: 1 }
  });
  const preExistingObserved = preExisting.context.ChatGptAdapter.inspectPromptDelivery(
    preExisting.transaction,
    "synthetic long prompt",
    preExisting.binding,
    null,
    { settling: true }
  );
  assert.equal(preExistingObserved.ok, false);
  assert.equal(preExistingObserved.reason, "attachment-provenance-lost");

  const userRace = makeDepthBoundLiveComposerFixture(7, {
    tileOptions: { buttonCount: 3, removeCount: 1, ordinarySvgCount: 1 }
  });
  userRace.transaction.tracker.epoch += 1;
  const raced = userRace.context.ChatGptAdapter.inspectPromptDelivery(
    userRace.transaction,
    "synthetic long prompt",
    userRace.binding,
    null,
    { settling: true }
  );
  assert.equal(raced.ok, false);
  assert.equal(raced.reason, "user-interaction");

  const replacement = makeDepthBoundLiveComposerFixture(7, {
    tileOptions: { buttonCount: 3, removeCount: 1, ordinarySvgCount: 1 }
  });
  const locked = replacement.context.ChatGptAdapter.inspectPromptDelivery(
    replacement.transaction,
    "synthetic long prompt",
    replacement.binding,
    null,
    { settling: true, lock: true }
  );
  assert.equal(locked.ok, true);
  const replacementTile = makeLiveFileTile({ buttonCount: 3, removeCount: 1, ordinarySvgCount: 1 });
  replacement.tile.parentElement.children = [replacementTile];
  const replaced = replacement.context.ChatGptAdapter.inspectPromptDelivery(
    replacement.transaction,
    "synthetic long prompt",
    replacement.binding,
    "paste-attachment",
    { settling: false }
  );
  assert.equal(replaced.ok, true);
  assert.equal(replaced.mode, "paste-attachment");
  assert.equal(replacement.transaction.replacements, 1);

  const multiple = makeDepthBoundLiveComposerFixture(7, {
    tileCount: 2,
    tileOptions: { buttonCount: 3, removeCount: 1, ordinarySvgCount: 1 }
  });
  const multipleObserved = multiple.context.ChatGptAdapter.inspectPromptDelivery(
    multiple.transaction,
    "synthetic long prompt",
    multiple.binding,
    null,
    { settling: true }
  );
  assert.equal(multipleObserved.ok, false);
  assert.equal(multipleObserved.reason, "extra-attachment");
});

test("C10.3 R1 RED: the measured form depth 7 live tile has a structural signature", () => {
  const { context, composer, tile, binding, transaction } = makeDepthBoundLiveComposerFixture(7);
  const attachmentState = context.ChatGptAdapter.getComposerAttachmentState(composer);

  assert.equal(attachmentState.scopeKind, "form");
  assert.equal(attachmentState.composerDepth, 6);
  assert.equal(attachmentState.count, 1);
  assert.equal(attachmentState.fallbackAccepted, true);
  assert.equal(attachmentState.derivedRemoveSemanticCount, 1);
  assert.notEqual(
    context.candidateStructuralSignature(tile, attachmentState),
    null,
    "a live tile seven ancestors below an already-authorized form must be signable"
  );

  const observed = context.ChatGptAdapter.inspectPromptDelivery(
    transaction,
    "synthetic long prompt",
    binding,
    null,
    { settling: true }
  );
  assert.equal(observed.ok, true);
  assert.equal(observed.mode, "paste-attachment");
  assert.ok(observed.diagnostic.candidatesSeen >= 1);
});

test("C10.3 R2-R5: attachment signature depth is bounded at 8 without widening surface discovery", () => {
  for (const depth of [6, 7, 8, 9]) {
    const { context, composer, tile, binding, transaction } = makeDepthBoundLiveComposerFixture(depth);
    const attachmentState = context.ChatGptAdapter.getComposerAttachmentState(composer);
    const signature = context.candidateStructuralSignature(tile, attachmentState);
    const observed = context.ChatGptAdapter.inspectPromptDelivery(
      transaction,
      "synthetic long prompt",
      binding,
      null,
      { settling: true }
    );

    assert.equal(context.MAX_COMPOSER_SURFACE_ANCESTOR_DEPTH, 6);
    assert.equal(context.MAX_ATTACHMENT_SIGNATURE_ANCESTOR_DEPTH, 8);
    assert.equal(attachmentState.composerDepth, 6);
    assert.equal(signature !== null, depth <= 8, `signature boundary at depth ${depth}`);
    assert.equal(observed.ok, depth <= 8, `delivery boundary at depth ${depth}`);
    if (depth === 9) assert.equal(observed.reason, "attachment-provenance-lost");
  }
});

test("C10.3 R6: a recognized depth 7 candidate waits for Send to become actionable", () => {
  const { context, sendButton, binding, transaction } = makeDepthBoundLiveComposerFixture(7);
  sendButton.disabled = true;
  const pending = context.ChatGptAdapter.inspectPromptDelivery(
    transaction,
    "synthetic long prompt",
    binding,
    null,
    { settling: true }
  );
  assert.equal(pending.ok, false);
  assert.equal(pending.reason, "settling");
  assert.equal(pending.diagnostic.lastState, "attachment-pending");
  assert.equal(pending.diagnostic.sendActionable, false);
  assert.equal(pending.diagnostic.candidatesSeen, 1);

  sendButton.disabled = false;
  const ready = context.ChatGptAdapter.inspectPromptDelivery(
    transaction,
    "synthetic long prompt",
    binding,
    null,
    { settling: true }
  );
  assert.equal(ready.ok, true);
  assert.equal(ready.mode, "paste-attachment");
  assert.equal(ready.diagnostic.sendActionable, true);
  assert.equal(ready.diagnostic.candidatesSeen, 1, "readiness polling must not duplicate provenance");
});

test("C10.3 R7: a depth 7 candidate that never becomes actionable remains pending with Send 0 authority", () => {
  const { context, sendButton, binding, transaction } = makeDepthBoundLiveComposerFixture(7);
  sendButton.disabled = true;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = context.ChatGptAdapter.inspectPromptDelivery(
      transaction,
      "synthetic long prompt",
      binding,
      null,
      { settling: true }
    );
    assert.equal(observed.ok, false);
    assert.equal(observed.reason, "settling");
    assert.equal(observed.diagnostic.sendActionable, false);
  }
  assert.equal(transaction.mode, undefined, "no actionable Send means no locked delivery authority");
});

test("C10.3 R8-R10: depth 7 does not admit pre-existing, outside-surface, or user-raced candidates", () => {
  const preExisting = makeDepthBoundLiveComposerFixture(7, { preExisting: true });
  const preExistingObserved = preExisting.context.ChatGptAdapter.inspectPromptDelivery(
    preExisting.transaction,
    "synthetic long prompt",
    preExisting.binding,
    null,
    { settling: true }
  );
  assert.equal(preExistingObserved.ok, false);
  assert.equal(preExistingObserved.reason, "attachment-provenance-lost");

  const outside = makeDepthBoundLiveComposerFixture(7);
  const detachedTile = makeLiveFileTile();
  const outsideState = outside.context.ChatGptAdapter.getComposerAttachmentState(outside.composer);
  assert.equal(outside.surface.contains(detachedTile), false);
  assert.equal(outside.context.candidateStructuralSignature(detachedTile, outsideState), null);

  const userRace = makeDepthBoundLiveComposerFixture(7);
  userRace.transaction.tracker.epoch += 1;
  const raced = userRace.context.ChatGptAdapter.inspectPromptDelivery(
    userRace.transaction,
    "synthetic long prompt",
    userRace.binding,
    null,
    { settling: true }
  );
  assert.equal(raced.ok, false);
  assert.equal(raced.reason, "user-interaction");
});

test("C10.3 R11-R13: depth 7 keeps revision, document, and conversation binding fail-closed", () => {
  for (const changed of [
    { stateRevision: 2 },
    { documentInstanceId: "different-document" },
    { conversationKey: "chatgpt:c:different-conversation" }
  ]) {
    const fixture = makeDepthBoundLiveComposerFixture(7);
    const observed = fixture.context.ChatGptAdapter.inspectPromptDelivery(
      fixture.transaction,
      "synthetic long prompt",
      { ...fixture.binding, ...changed },
      null,
      { settling: true }
    );
    assert.equal(observed.ok, false);
    assert.equal(observed.reason, "transaction-invalid");
  }
});

test("C10.3 R14: two depth 7 live tiles remain ambiguous and cannot authorize Send", () => {
  const fixture = makeDepthBoundLiveComposerFixture(7, { tileCount: 2 });
  const state = fixture.context.ChatGptAdapter.getComposerAttachmentState(fixture.composer);
  assert.equal(state.count, 2);
  assert.equal(state.fallbackAccepted, false);
  const observed = fixture.context.ChatGptAdapter.inspectPromptDelivery(
    fixture.transaction,
    "synthetic long prompt",
    fixture.binding,
    null,
    { settling: true }
  );
  assert.equal(observed.ok, false);
  assert.equal(observed.reason, "extra-attachment");
});

test("C10.3 R15 Practical: a recognized replacement after delivery lock remains the same logical artifact", () => {
  const fixture = makeDepthBoundLiveComposerFixture(7);
  const locked = fixture.context.ChatGptAdapter.inspectPromptDelivery(
    fixture.transaction,
    "synthetic long prompt",
    fixture.binding,
    null,
    { settling: true, lock: true }
  );
  assert.equal(locked.ok, true);
  const replacement = makeLiveFileTile();
  fixture.tile.parentElement.children = [replacement];
  const observed = fixture.context.ChatGptAdapter.inspectPromptDelivery(
    fixture.transaction,
    "synthetic long prompt",
    fixture.binding,
    "paste-attachment",
    { settling: false }
  );
  assert.equal(observed.ok, true);
  assert.equal(observed.mode, "paste-attachment");
  assert.equal(fixture.transaction.replacements, 1);
});

test("DOM: blockers are structural only - no page text is ever interpreted", () => {
  const modal = new SyntheticElement(["[role='dialog'][aria-modal='true']"]);
  assert.equal(createAdapterContext([modal]).ChatGptAdapter.detectBlocker(), "ui-blocked");

  const captcha = new SyntheticElement(["iframe[src*='captcha']"]);
  assert.equal(createAdapterContext([captcha]).ChatGptAdapter.detectBlocker(), "captcha");

  const login = new SyntheticElement(["header a[href^='/auth/login']"]);
  assert.equal(createAdapterContext([login]).ChatGptAdapter.detectBlocker(), "login-required");

  // A page that merely *says* something alarming is not a structural blocker. Reading it
  // would break Output-Blind, so it must be ignored entirely.
  const toast = new SyntheticElement(["div[role='status']", "div.toast", "div[role='alert']"]);
  assert.equal(
    createAdapterContext([toast]).ChatGptAdapter.detectBlocker(),
    null,
    "generic alert/status/toast nodes must not be inspected"
  );
});

test("DOM: an invisible modal is not treated as blocking, and a visible one always is", () => {
  const hiddenModal = new SyntheticElement(["[role='dialog'][aria-modal='true']"], { visible: false });
  assert.equal(createAdapterContext([hiddenModal]).ChatGptAdapter.detectBlocker(), null);

  const openDialog = new SyntheticElement(["dialog[open]"]);
  assert.equal(createAdapterContext([openDialog]).ChatGptAdapter.detectBlocker(), "ui-blocked");
});

test("DOM: generation state is a three-way classification with no ambiguous-as-idle fallback", () => {
  const context = createAdapterContext([]);
  assert.equal(context.classifyGenerationState({ generating: true, composerWritable: true }), "generating");
  assert.equal(context.classifyGenerationState({ generating: true, composerWritable: false }), "generating");
  assert.equal(context.classifyGenerationState({ generating: false, composerWritable: true }), "idle");
  assert.equal(
    context.classifyGenerationState({ generating: false, composerWritable: false }),
    "ambiguous",
    "an unwritable, non-generating composer must never be reported as idle"
  );
});

test("DOM: a stop button anywhere on the page means generating, which blocks a send", () => {
  const stop = new SyntheticElement(["button[data-testid='stop-button']"]);
  const composer = new SyntheticElement(["#prompt-textarea"]);
  const context = createAdapterContext([composer, stop]);

  assert.equal(context.ChatGptAdapter.isGenerating(), true);
  assert.equal(context.ChatGptAdapter.getGenerationState(), "generating");
  const observation = context.ChatGptAdapter.readPageObservation();
  assert.equal(observation.generationState, "generating");
  assert.equal(observation.stopButton, stop);
});

test("DOM: conversation identity is derived only from the route, and unknown routes fail closed", () => {
  for (const [pathname, expected] of [
    ["/c/abc-123", "chatgpt:c:abc-123"],
    ["/g/g-p-project/c/abc-123", "chatgpt:c:abc-123"]
  ]) {
    const context = createAdapterContext([]);
    context.location.pathname = pathname;
    assert.equal(context.ChatGptAdapter.getConversationKey(), expected);
  }

  for (const pathname of ["/", "/g/g-p-project/project"]) {
    const context = createAdapterContext([]);
    context.location.pathname = pathname;
    assert.match(
      context.ChatGptAdapter.getConversationKey(),
      /^chatgpt:new:/,
      "a New Chat route must be a distinct, per-document identity"
    );
  }

  for (const pathname of ["/unknown", "/c/", "/c/abc/extra", "/settings"]) {
    const context = createAdapterContext([]);
    context.location.pathname = pathname;
    assert.throws(
      () => context.ChatGptAdapter.getConversationKey(),
      (error) => error?.code === "conversation_identity_unknown",
      `${pathname}: an unrecognized route must fail closed rather than be guessed`
    );
  }
});
