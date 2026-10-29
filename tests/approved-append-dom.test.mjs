import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const coreSource = fs.readFileSync(new URL("../src/content-core.js", import.meta.url), "utf8");

// This fixture models editor event handling only. All detection, append authority,
// readback and attachment settlement decisions use the actual production core.
function fixture({ prefix = "", atomic = false, textarea = false, handlePaste = true,
  convertSuffix = false, losePrefix = false, navigationAvailable = true } = {}) {
  class Text {
    constructor(value) { this.nodeType = 3; this.nodeValue = value; this.parentElement = null; }
    get textContent() { return this.nodeValue; }
  }
  class Element {
    constructor(tag, attrs = {}, children = []) {
      this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = { ...attrs };
      this.childNodes = []; this.parentElement = null; this.visible = true;
      this.listeners = new Map();
      this.classList = { contains: name => String(this.attrs.class ?? "").split(/\s+/).includes(name) };
      for (const child of children) this.append(child);
    }
    get attributes() { return Object.entries(this.attrs).map(([name, value]) => ({ name, value })); }
    get children() { return this.childNodes.filter(node => node.nodeType === 1); }
    get firstElementChild() { return this.children[0] ?? null; }
    get id() { return this.attrs.id ?? ""; }
    get textContent() { return this.childNodes.map(node => node.textContent).join(""); }
    get innerText() { return this.textContent; }
    append(node) { this.childNodes.push(node); node.parentElement = this; }
    getAttribute(name) { return this.attrs[name] ?? null; }
    getBoundingClientRect() { return { width: this.visible ? 100 : 0, height: this.visible ? 20 : 0 }; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)) || this.childNodes.includes(node); }
    matches(selector) {
      return String(selector).split(",").some(part => {
        part = part.trim();
        if (part.startsWith("#")) return this.id === part.slice(1);
        const parsed = part.match(/^(\w+)?(?:\[([^\]=^*]+)(\^=|\*=|=)?(?:['"]([^'"]*)['"])?\])?$/);
        if (!parsed) return false;
        const [, tag, attr, op, value] = parsed;
        if (tag && this.tagName !== tag.toUpperCase()) return false;
        if (!attr) return Boolean(tag);
        const actual = this.attrs[attr];
        if (actual === undefined) return false;
        if (!op) return true;
        return op === "=" ? actual === value : op === "^=" ? actual.startsWith(value) : actual.includes(value);
      });
    }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
    querySelectorAll(selector) {
      const found = [];
      for (const child of this.children) {
        if (child.matches(selector)) found.push(child);
        found.push(...child.querySelectorAll(selector));
      }
      return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    removeEventListener(type) { this.listeners.delete(type); }
    focus() { this.attrs.class = `${this.attrs.class ?? ""} ProseMirror-focused`.trim(); }
    dispatchEvent(event) {
      for (let node = this; node; node = node.parentElement) node.listeners.get(event.type)?.(event);
      this.onEvent?.(event);
      return !event.defaultPrevented;
    }
  }
  class Textarea extends Element {
    constructor(value) { super("textarea", { id: "prompt-textarea" }); this._value = value; }
    get value() { return this._value; }
    set value(value) { this._value = value; }
  }
  class Input extends Element {}
  class Event {
    constructor(type, init = {}) { this.type = type; this.defaultPrevented = false; this.isTrusted = false; Object.assign(this, init); }
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  }
  class DataTransfer {
    constructor() { this.values = new Map(); }
    setData(type, value) { this.values.set(type, value); }
    getData(type) { return this.values.get(type) ?? ""; }
  }
  const paragraphs = prefix.split("\n").map(line => new Element("p", {}, [new Text(line)]));
  const atomicNode = atomic ? new Element("span", { contenteditable: "false", "data-custom-token": "unchanged" }, [new Text(prefix)]) : null;
  if (atomicNode) paragraphs[0].childNodes = [atomicNode], atomicNode.parentElement = paragraphs[0];
  const composer = textarea ? new Textarea(prefix) : new Element("div", {
    id: "prompt-textarea", class: "ProseMirror", contenteditable: "true"
  }, paragraphs);
  const send = new Element("button", { "data-testid": "send-button" }); send.disabled = false;
  const form = new Element("form", {}, [composer, send]);
  const body = new Element("body", {}, [form]);
  const navListeners = new Map(), windowListeners = new Map();
  const navigation = {
    currentEntry: { key: "entry-1", id: "entry-id-1" },
    addEventListener(type, listener) { navListeners.set(type, listener); },
    removeEventListener(type) { navListeners.delete(type); }
  };
  let caretAtEnd = false, pastes = 0;
  const events = [];
  function addAttachment({ unknown = false, hidden = false } = {}) {
    const tile = new Element("div", { "data-testid": "file-preview" });
    tile.visible = !hidden;
    if (!unknown) tile.append(new Element("button", { "aria-label": "Remove attachment" }));
    form.append(tile);
    return tile;
  }
  composer.onEvent = event => {
    events.push(event);
    if (event.type !== "paste" || !handlePaste) return;
    pastes += 1;
    const text = event.clipboardData.getData("text/plain");
    const html = event.clipboardData.getData("text/html");
    assert.ok(html.startsWith('<p data-pm-slice="0 0 []">'));
    event.preventDefault();
    if (convertSuffix) {
      addAttachment();
      if (losePrefix) composer.childNodes = [new Element("p")], composer.childNodes[0].parentElement = composer;
      return;
    }
    if (!caretAtEnd && composer.textContent) throw Error("fixture does not allow replacing an existing input");
    const lines = text.split("\n");
    const last = composer.children.at(-1);
    last.append(new Text(lines[0]));
    for (const line of lines.slice(1)) composer.append(new Element("p", {}, [new Text(line)]));
  };
  const context = vm.createContext({
    console, crypto: webcrypto, TextEncoder, TextDecoder, Node: { TEXT_NODE: 3 },
    Element, HTMLTextAreaElement: Textarea, HTMLInputElement: Input,
    Event, InputEvent: Event, ClipboardEvent: Event, DataTransfer,
    setTimeout, clearTimeout,
    MutationObserver: class { observe() {} disconnect() {} },
    navigation: navigationAvailable ? navigation : undefined,
    addEventListener(type, listener) { windowListeners.set(type, listener); },
    removeEventListener(type) { windowListeners.delete(type); },
    location: { origin: "https://chatgpt.com", pathname: "/c/append" },
    getComputedStyle: element => ({ display: element.visible ? "block" : "none", visibility: "visible" }),
    window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
    document: {
      body,
      querySelector: selector => body.querySelector(selector),
      querySelectorAll: selector => body.querySelectorAll(selector),
      createRange: () => ({ selectNodeContents() {}, collapse(start) { caretAtEnd = !start; } })
    },
    chrome: { runtime: { async sendMessage() { return { ok: true }; } } }
  });
  vm.runInContext(coreSource, context, { filename: "content-core.js" });
  const adapter = context.ChatGptAdapter;
  const binding = Object.freeze({
    deliveryAttemptToken: "attempt-1", runId: "run-1", executionSessionId: "session-1",
    stateRevision: 1, stepId: "step-1", stepIndex: 0, repeatIndex: 0, sendsCompleted: 0,
    promptHash: "macro-hash", inputHash: "combined-input-hash", documentInstanceId: context.instanceId,
    conversationKey: "chatgpt:c:append", runnerToken: 1
  });
  return {
    context, adapter, composer, atomicNode, form, send, binding, events, addAttachment,
    text: () => adapter.getComposerText(composer), pastes: () => pastes,
    write(macro, plan) { return adapter.writePrompt(macro, binding, plan); },
    observe(transaction, expected) { return adapter.inspectPromptDelivery(transaction, expected, binding); },
    trustedEdit() { form.listeners.get("input")?.({ isTrusted: true }); },
    replaceAtomic() {
      const parent = atomicNode.parentElement;
      const replacement = new Element("span", { ...atomicNode.attrs }, [new Text(atomicNode.textContent)]);
      parent.childNodes[parent.childNodes.indexOf(atomicNode)] = replacement;
      replacement.parentElement = parent;
      atomicNode.parentElement = null;
    },
    navigate() { navigation.currentEntry = { key: "entry-2", id: "entry-id-2" }; navListeners.get("currententrychange")?.(); },
    replaceText(value) { if (textarea) composer.value = value; else composer.childNodes = [new Element("p", {}, [new Text(value)])]; }
  };
}

for (const textarea of [false, true]) {
  for (const prefix of ["existing instruction", "existing instruction\n", "日本語🚀e\u0301 <&>"]) {
    test(`append keeps initial ${textarea ? "textarea" : "ProseMirror"} input exactly with a natural separator: ${JSON.stringify(prefix)}`, () => {
      const h = fixture({ prefix, textarea });
      const prompt = "next instruction\n追加";
      const plan = h.adapter.preparePromptAppend(prompt);
      const expected = `${prefix}${prefix.endsWith("\n") ? "" : "\n"}${prompt}`;
      assert.equal(plan.expectedText, expected);
      assert.equal(h.adapter.inspectPromptAppend(plan), true);
      const transaction = h.write(prompt, plan);
      assert.equal(transaction.expectedText, expected);
      assert.equal(h.text(), expected);
      assert.equal(h.observe(transaction, expected).mode, "text");
      assert.equal(h.adapter.inspectPromptAppend(plan), false);
      assert.throws(() => h.write(prompt, plan), error => error.code === "draft_present");
      assert.equal(h.text(), expected, "a second use cannot duplicate the suffix");
      h.adapter.finishPromptDelivery(transaction);
    });
  }
}

test("append retains a generic structured editor node without a plugin whitelist", () => {
  const h = fixture({ prefix: "arbitrary selected tool", atomic: true });
  const original = h.atomicNode;
  const plan = h.adapter.preparePromptAppend("instruction");
  const transaction = h.write("instruction", plan);
  assert.equal(h.composer.contains(original), true);
  assert.equal(original.getAttribute("data-custom-token"), "unchanged");
  assert.equal(h.text(), "arbitrary selected tool\ninstruction");
  assert.equal(h.observe(transaction, plan.expectedText).mode, "text");
  original.attrs["data-custom-token"] = "changed-with-the-same-visible-text";
  assert.equal(h.observe(transaction, plan.expectedText).ok, false);
});

test("an atomic editor node with no plain text is preserved and not treated as an empty composer", () => {
  const h = fixture({ prefix: "", atomic: true });
  const plan = h.adapter.preparePromptAppend("instruction");
  assert.ok(plan);
  const transaction = h.write("instruction", plan);
  assert.equal(h.composer.contains(h.atomicNode), true);
  assert.equal(h.text(), "\ninstruction");
  assert.equal(h.observe(transaction, plan.expectedText).ok, true);
});

for (const change of ["text", "same-text-trusted-edit", "structure", "navigation", "attachment", "dispose"]) {
  test(`initial input authority refuses ${change} without changing existing input`, () => {
    const h = fixture({ prefix: "initial", atomic: change === "structure" });
    const plan = h.adapter.preparePromptAppend("macro");
    if (change === "text") h.replaceText("changed");
    if (change === "same-text-trusted-edit") h.trustedEdit();
    if (change === "structure") h.atomicNode.attrs["data-custom-token"] = "changed";
    if (change === "navigation") h.navigate();
    if (change === "attachment") h.addAttachment();
    if (change === "dispose") h.adapter.disposePromptAppend(plan);
    const before = h.text();
    assert.equal(h.adapter.inspectPromptAppend(plan), false);
    assert.throws(() => h.write("macro", plan), error => error.code === "draft_present");
    assert.equal(h.text(), before);
    assert.equal(h.pastes(), 0);
  });
}

test("missing navigation ownership blocks nonempty append but leaves ordinary empty input available", () => {
  const existing = fixture({ prefix: "keep", navigationAvailable: false });
  assert.throws(() => existing.adapter.preparePromptAppend("macro"), error => error.code === "draft_present");
  assert.equal(existing.text(), "keep");
  const empty = fixture({ navigationAvailable: false });
  assert.equal(empty.adapter.preparePromptAppend("macro"), null);
  assert.equal(empty.write("macro").expectedText, "macro");
});

test("unhandled append paste is not retried and does not replace the original structure", () => {
  const h = fixture({ prefix: "keep", atomic: true, handlePaste: false });
  const plan = h.adapter.preparePromptAppend("macro");
  assert.throws(() => h.write("macro", plan), error => error.code === "composer_verification_failed");
  assert.equal(h.text(), "keep");
  assert.equal(h.composer.contains(h.atomicNode), true);
  assert.equal(h.events.filter(event => event.type === "paste").length, 1);
  assert.equal(h.adapter.inspectPromptAppend(plan), false);
});

test("converted appended suffix can settle only while its authorized initial prefix remains intact", () => {
  const h = fixture({ prefix: "selected tool", atomic: true, convertSuffix: true });
  const macro = "test".repeat(20_160);
  const plan = h.adapter.preparePromptAppend(macro);
  const transaction = h.write(macro, plan);
  assert.equal(h.text(), "selected tool");
  assert.equal(h.observe(transaction, plan.expectedText).mode, "paste-attachment");
  assert.equal(h.composer.contains(h.atomicNode), true);
  h.trustedEdit();
  assert.equal(h.observe(transaction, plan.expectedText).ok, false);
});

test("losing the initial prefix is not silently treated as full-input attachment conversion", () => {
  const h = fixture({ prefix: "keep this instruction", convertSuffix: true, losePrefix: true });
  const plan = h.adapter.preparePromptAppend("long macro");
  const transaction = h.write("long macro", plan);
  assert.equal(h.observe(transaction, plan.expectedText).ok, false);
});

test("unclassified file candidate remains unknown before append and during exact-text delivery", () => {
  const h = fixture({ prefix: "keep" });
  h.addAttachment({ unknown: true });
  assert.equal(h.adapter.getComposerAttachmentState(h.composer).known, false);
  assert.throws(() => h.adapter.preparePromptAppend("macro"), error => error.code === "composer_attachment_unconfirmed");
  assert.equal(h.text(), "keep");

  const next = fixture();
  const transaction = next.write("short macro");
  next.addAttachment({ unknown: true });
  const observed = next.observe(transaction, "short macro");
  assert.equal(observed.ok, false);
  assert.equal(observed.reason, "attachment-unconfirmed");
});

test("paused combined input is adopted without a second append and stays bound to the full input hash", () => {
  const h = fixture({ prefix: "initial", atomic: true });
  const plan = h.adapter.preparePromptAppend("macro");
  const transaction = h.write("macro", plan);
  const receipt = h.adapter.capturePausedPromptText(transaction, plan.expectedText, h.binding);
  assert.ok(receipt);
  h.adapter.finishPromptDelivery(transaction);
  const nextBinding = { ...h.binding, deliveryAttemptToken: "attempt-2", stateRevision: 4, runnerToken: 2 };
  const adopted = h.adapter.adoptPausedPromptText(receipt, plan.expectedText, nextBinding);
  assert.equal(adopted.expectedText, plan.expectedText);
  assert.equal(h.pastes(), 1);
  assert.equal(h.adapter.inspectPromptDelivery(adopted, plan.expectedText, nextBinding).mode, "text");
  assert.equal(h.adapter.inspectPromptDelivery(adopted, plan.expectedText, { ...nextBinding, inputHash: "different" }).ok, false);
  h.adapter.finishPromptDelivery(adopted);
});

test("paused same-text structured node replacement revokes the receipt without rewriting anything", () => {
  const h = fixture({ prefix: "selected tool", atomic: true });
  const plan = h.adapter.preparePromptAppend("macro");
  const transaction = h.write("macro", plan);
  const receipt = h.adapter.capturePausedPromptText(transaction, plan.expectedText, h.binding);
  assert.ok(receipt);
  h.adapter.finishPromptDelivery(transaction);
  h.replaceAtomic();
  assert.equal(h.text(), plan.expectedText);
  assert.equal(h.adapter.inspectPausedPromptText(receipt, plan.expectedText, h.binding), false);
  const nextBinding = { ...h.binding, deliveryAttemptToken: "attempt-2", stateRevision: 4, runnerToken: 2 };
  assert.throws(() => h.adapter.adoptPausedPromptText(receipt, plan.expectedText, nextBinding), error => error.code === "draft_present");
  assert.equal(h.text(), plan.expectedText);
  assert.equal(h.pastes(), 1);
});
