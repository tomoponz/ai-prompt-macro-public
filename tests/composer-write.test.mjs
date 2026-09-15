import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { projectRunState } from "../src/run-ux.js";

const coreSource = fs.readFileSync(new URL("../src/content-core.js", import.meta.url), "utf8");
const runnerSource = fs.readFileSync(new URL("../src/content-runner.js", import.meta.url), "utf8");

function createComposerHarness(initialText = "", { handlePaste = true } = {}) {
  class DummyElement {}
  class DummyTextArea extends DummyElement {}
  class DummyInput extends DummyElement {}
  class DummyEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.defaultPrevented = false;
      Object.assign(this, init);
    }
    preventDefault() {
      if (this.cancelable) this.defaultPrevented = true;
    }
  }
  class DummyInputEvent extends DummyEvent {}
  class DummyClipboardEvent extends DummyEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.clipboardData = init.clipboardData ?? null;
    }
  }
  class DummyDataTransfer {
    #values = new Map();
    setData(type, value) { this.#values.set(type, String(value)); }
    getData(type) { return this.#values.get(type) ?? ""; }
  }
  class DummyParagraph extends DummyElement {
    constructor(text) {
      super();
      this.tagName = "P";
      this.textContent = text;
    }
  }

  let focused = 0;
  let rangeSelections = 0;
  let editorState = String(initialText).replace(/\r\n?/g, "\n");
  const events = [];
  const observers = [];
  const interactions = new Map();
  const attachments = [];
  let clicks = 0;
  const composer = new DummyElement();
  const sendButton = new DummyElement();
  sendButton.click = () => { clicks += 1; };
  sendButton.getAttribute = () => null;
  sendButton.getBoundingClientRect = () => ({ width: 100, height: 40 });
  const composerForm = {
    addEventListener(type, listener) { interactions.set(type, listener); },
    querySelectorAll(selector) { return selector.includes("file-thumbnail") ? attachments : []; },
    querySelector() { return null; },
    contains(node) { return node === composer || node === sendButton || attachments.includes(node); }
  };
  composer.id = "prompt-textarea";
  composer.classList = { contains: (name) => name === "ProseMirror" };
  composer.children = editorState.split("\n").map((line) => new DummyParagraph(line));
  composer.focus = () => { focused += 1; };
  composer.getAttribute = (name) => name === "contenteditable" ? "true" : null;
  composer.closest = (selector) => selector === "form" ? composerForm : null;
  Object.defineProperties(composer, {
    firstElementChild: { get: () => composer.children[0] ?? null },
    // Deliberately lossy. The adapter must serialize direct ProseMirror paragraphs,
    // not trust root textContent/innerText for exact newline reconstruction.
    textContent: { get: () => composer.children.map((paragraph) => paragraph.textContent).join("") },
    innerText: { get: () => "LOSSY_INNER_TEXT_MUST_NOT_BE_USED" }
  });
  const syncState = () => {
    editorState = composer.children.map((paragraph) => paragraph.textContent).join("\n");
  };
  composer.dispatchEvent = (event) => {
    events.push(event);
    if (event.type === "paste" && handlePaste) {
      const inserted = event.clipboardData?.getData("text/plain") ?? "";
      const html = event.clipboardData?.getData("text/html") ?? "";
      assert.match(html, /^<p data-pm-slice="0 0 \[\]">/);
      assert.doesNotMatch(html, /<br|<div data-pm-slice/);
      const decode = (value) => value
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&gt;/g, ">")
        .replace(/&lt;/g, "<")
        .replace(/&amp;/g, "&");
      const lines = [...html.matchAll(/<p(?: data-pm-slice="0 0 \[\]")?>([\s\S]*?)<\/p>/g)]
        .map((match) => decode(match[1]));
      assert.equal(lines.join("\n"), inserted, "the ProseMirror slice and exact plain-text payload must agree");
      event.preventDefault();
      composer.children = lines.map((line) => new DummyParagraph(line));
      syncState();
    }
    return !event.defaultPrevented;
  };

  const selection = {
    removeAllRanges() {},
    addRange() { rangeSelections += 1; }
  };
  const context = vm.createContext({
    console,
    crypto: webcrypto,
    TextEncoder,
    setTimeout,
    clearTimeout,
    Element: DummyElement,
    HTMLTextAreaElement: DummyTextArea,
    HTMLInputElement: DummyInput,
    InputEvent: DummyInputEvent,
    ClipboardEvent: DummyClipboardEvent,
    DataTransfer: DummyDataTransfer,
    Node: { TEXT_NODE: 3 },
    Event: DummyEvent,
    MutationObserver: class {
      constructor() { this.connected = false; observers.push(this); }
      observe() { this.connected = true; }
      disconnect() { this.connected = false; }
    },
    location: { origin: "https://chatgpt.com", pathname: "/c/composer-write" },
    sessionStorage: { getItem() { return null; }, setItem() {} },
    document: {
      querySelector() { return null; },
      querySelectorAll(selector) { return selector === "button[data-testid='send-button']" ? [sendButton] : []; },
      createRange() {
        return {
          selectNodeContents(node) { assert.equal(node.tagName, "P"); },
          collapse(value) { assert.equal(value, true); }
        };
      },
      execCommand() { throw new Error("execCommand must not be used for prompt mutation"); }
    },
    window: { getSelection() { return selection; } },
    getComputedStyle() { return { display: "block", visibility: "visible" }; },
    chrome: {
      runtime: { async sendMessage() { return { ok: true }; } },
      storage: { local: { async get() { return {}; }, async set() {} } }
    }
  });
  vm.runInContext(coreSource, context, { filename: "content-core.js" });
  context.ChatGptAdapter.findComposer = () => composer;
  const deliveryBinding = Object.freeze({
    deliveryAttemptToken: "composer-write-unit",
    runId: "composer-write-run",
    executionSessionId: "composer-write-session",
    stateRevision: 1,
    stepId: "composer-write-step",
    stepIndex: 0,
    repeatIndex: 0,
    sendsCompleted: 0,
    promptHash: "composer-write-hash",
    documentInstanceId: "composer-write-document",
    conversationKey: "chatgpt:c:composer-write",
    runnerToken: 1
  });

  return {
    context,
    adapter: context.ChatGptAdapter,
    writePrompt: (text) => context.ChatGptAdapter.writePrompt(text, deliveryBinding),
    deliveryBinding,
    composer,
    composerForm,
    events,
    observers,
    clicks: () => clicks,
    interact: () => interactions.get("input")?.({ isTrusted: true }),
    addAttachment() {
      const attachment = new DummyElement();
      attachment.getAttribute = (name) => name === "data-testid" ? "file-thumbnail" : null;
      attachment.matches = (selector) => selector.includes("file-thumbnail");
      attachment.getBoundingClientRect = () => ({ width: 100, height: 40 });
      attachment.contains = (node) => node === attachment;
      attachments.push(attachment);
      return attachment;
    },
    state: () => editorState,
    setParagraphs(lines) {
      composer.children = lines.map((line) => new DummyParagraph(line));
      syncState();
    },
    focused: () => focused,
    rangeSelections: () => rangeSelections
  };
}

test("ProseMirror prompt mutation uses handled browser input events without execCommand or direct root replacement", () => {
  assert.doesNotMatch(coreSource, /execCommand\s*\(/);
  assert.doesNotMatch(coreSource, /composer\.textContent\s*=/);
  assert.match(coreSource, /new ClipboardEvent\("paste"/);
  assert.doesNotMatch(coreSource, /new KeyboardEvent\("keydown"/);

  const harness = createComposerHarness();
  harness.writePrompt("safe prompt");
  assert.equal(harness.state(), "safe prompt");
  assert.equal(harness.focused(), 1);
  assert.equal(harness.rangeSelections(), 1);
  assert.deepEqual(harness.events.map((event) => event.type), ["paste"]);
  assert.equal(harness.events[0].defaultPrevented, true);
});

test("ProseMirror internal state is updated atomically through a handled whitespace-preserving slice", () => {
  const harness = createComposerHarness();
  const prompt = "first\n\n  third";
  harness.writePrompt(prompt);

  assert.equal(harness.state(), prompt);
  assert.equal(harness.adapter.getComposerText(harness.composer), prompt);
  assert.deepEqual(harness.events.map((event) => event.type), ["paste"]);
  assert.equal(harness.events[0].clipboardData.getData("text/plain"), prompt);
  assert.equal(
    harness.events[0].clipboardData.getData("text/html"),
    '<p data-pm-slice="0 0 []">first</p><p></p><p>  third</p>'
  );
  assert.ok(harness.events.every((event) => event.defaultPrevented));
});

test("ProseMirror strict readback serializes non-trailing BR nodes but ignores its trailing cursor BR", () => {
  const harness = createComposerHarness();
  harness.composer.children = [{
    tagName: "P",
    textContent: "firstsecond",
    childNodes: [
      { nodeType: 3, nodeValue: "first" },
      { nodeType: 1, tagName: "BR", classList: { contains: () => false }, childNodes: [] },
      { nodeType: 1, tagName: "SPAN", childNodes: [{ nodeType: 3, nodeValue: "second" }] },
      { nodeType: 1, tagName: "BR", classList: { contains: (name) => name === "ProseMirror-trailingBreak" }, childNodes: [] }
    ]
  }];
  assert.equal(harness.adapter.getComposerText(harness.composer), "first\nsecond");
});

test("ProseMirror clipboard HTML escapes prompt markup while retaining exact editor text", () => {
  const harness = createComposerHarness();
  const prompt = "<script>alert('x')</script>\n  <div>A & B</div>";
  harness.writePrompt(prompt);
  const html = harness.events[0].clipboardData.getData("text/html");
  assert.doesNotMatch(html, /<script>|<div>A & B<\/div>/);
  assert.match(html, /&lt;script&gt;alert\(&#39;x&#39;\)&lt;\/script&gt;/);
  assert.match(html, /&lt;div&gt;A &amp; B&lt;\/div&gt;/);
  assert.equal(harness.state(), prompt);
});

for (const [prompt, expectedHtml, expectedParagraphs] of [
  ["A\nB", '<p data-pm-slice="0 0 []">A</p><p>B</p>', ["A", "B"]],
  ["A\n\nB", '<p data-pm-slice="0 0 []">A</p><p></p><p>B</p>', ["A", "", "B"]],
  ["A\n\n\nB", '<p data-pm-slice="0 0 []">A</p><p></p><p></p><p>B</p>', ["A", "", "", "B"]],
  [
    "SECTION A\n  item 1\n  item 2",
    '<p data-pm-slice="0 0 []">SECTION A</p><p>  item 1</p><p>  item 2</p>',
    ["SECTION A", "  item 1", "  item 2"]
  ]
]) {
  test(`ProseMirror clipboard document has exact paragraph boundaries for ${JSON.stringify(prompt)}`, () => {
    const harness = createComposerHarness();
    harness.writePrompt(prompt);
    assert.equal(harness.events[0].clipboardData.getData("text/html"), expectedHtml);
    assert.deepEqual(harness.composer.children.map((paragraph) => paragraph.textContent), expectedParagraphs);
    assert.equal(harness.state(), prompt);
  });
}

for (const [label, prompt] of [
  ["multiline", "first line\nsecond line\nthird line"],
  ["blank lines", "first\n\n\nlast"],
  ["two and four space indentation", "root\n  child\n    grandchild"],
  ["multiple spaces", "A  B   C      D"],
  ["leading and trailing spaces", "  leading\ntrailing    "],
  ["Unicode and Japanese", "日本語の指示です。🚀\n全角・絵文字・é・𝄞"],
  ["code-like text", "```js\n  const value = \"A   B\";\n    return value;\n```"],
  ["HTML-like code remains text", "<script>alert('x')</script>\n  <div>A & B</div>"],
  ["CRLF input", "first\r\n\r\n  third"]
]) {
  test(`ProseMirror preserves exact ${label} prompt text`, () => {
    const harness = createComposerHarness();
    harness.writePrompt(prompt);
    const expected = prompt.replace(/\r\n?/g, "\n");
    assert.equal(harness.state(), expected);
    assert.equal(harness.adapter.getComposerText(harness.composer), expected);
    assert.equal(harness.adapter.getComposerText(harness.composer), harness.state());
  });
}

for (const residue of ["\n", "\n\n", "\u200b", "\u00a0", "\u200c\n\u2060\ufeff"]) {
  test(`PDT1/PDT2/PDT5: ProseMirror overwrites only allowed structural residue ${JSON.stringify(residue)}`, () => {
    const harness = createComposerHarness(residue);
    harness.writePrompt("automation prompt");
    assert.equal(harness.state(), "automation prompt");
    assert.equal(harness.events.length, 1);
  });
}

for (const draft of [
  "user draft",
  " ",
  "   ",
  "\t",
  "  \n    ",
  "a",
  "hello",
  "ユーザーの下書き",
  "\nvisible",
  "\u200bvisible"
]) {
  test(`ProseMirror refuses to overwrite existing draft ${JSON.stringify(draft)}`, () => {
    const harness = createComposerHarness(draft);
    assert.throws(
      () => harness.writePrompt("automation prompt"),
      (error) => error?.code === "draft_present"
    );
    assert.equal(harness.state(), draft.replace(/\r\n?/g, "\n"));
    assert.equal(harness.events.length, 0);
  });
}

test("PDT4: production ACK treats two empty ProseMirror paragraphs as cleared only with delivery evidence", () => {
  const harness = createComposerHarness();
  const transaction = harness.writePrompt("macro-owned long prompt");
  harness.setParagraphs(["", ""]);
  assert.equal(harness.adapter.getComposerText(harness.composer), "\n");

  const withoutOwnership = harness.adapter.getPromptDeliveryAckState(
    transaction,
    harness.deliveryBinding,
    "paste-attachment"
  );
  assert.equal(withoutOwnership.known, true);
  assert.equal(withoutOwnership.cleared, false);

  transaction.macroAttachmentObserved = true;
  const withOwnership = harness.adapter.getPromptDeliveryAckState(
    transaction,
    harness.deliveryBinding,
    "paste-attachment"
  );
  assert.equal(withOwnership.known, true);
  assert.equal(withOwnership.cleared, true);
});

test("unhandled ProseMirror paste fails closed instead of treating a DOM-only mutation as editor state", () => {
  const harness = createComposerHarness("", { handlePaste: false });
  assert.throws(
    () => harness.writePrompt("must not send"),
    (error) => error?.code === "composer_verification_failed"
  );
  assert.equal(harness.state(), "");
  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0].defaultPrevented, false);
});

test("ProseMirror writePrompt avoids a synchronous seconds-scale task for the maximum line count", () => {
  const harness = createComposerHarness();
  const prompt = Array.from({ length: 50 }, (_, index) => `${" ".repeat(index % 5)}行 ${index}  A   B`).join("\n");
  const startedAt = performance.now();
  harness.writePrompt(prompt);
  const durationMs = performance.now() - startedAt;
  assert.equal(harness.state(), prompt);
  assert.equal(harness.events.length, 1);
  assert.ok(durationMs < 100, `writePrompt took ${durationMs.toFixed(3)}ms`);
});

// Production core + runner: only the DOM and durable authority transport are fixtures.
// In particular, writePrompt/inspectPromptDelivery/finishPromptDelivery are not mocked.
function createDraftHarness(initialText = "", { onRead, onSettle, failSave = false } = {}) {
  const harness = createComposerHarness(initialText);
  const { context } = harness;
  vm.runInContext(runnerSource, context, { filename: "content-runner.js" });
  const step = { id: "draft-step", type: "prompt", delivery: "draft", prompt: "確認用の指示\n  two spaces", repeat: 1 };
  const run = {
    runId: "draft-run", executionSessionId: "draft-session", stateRevision: 1,
    conversationKey: "chatgpt:c:composer-write", documentInstanceId: context.instanceId,
    boundTabId: 17, boundDocumentId: "browser-document-17",
    status: "running", phase: "ready", outbox: null,
    workflow: { maxSends: 1, steps: [step] },
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 }
  };
  const saves = [];
  let reads = 0;
  context.getActiveRun = async () => {
    reads += 1;
    onRead?.({ ...harness, run, reads });
    // Simulate explicit Stop after the durable draft-ready pause so this test can
    // finish without automatically resuming the user's confirmation checkpoint.
    return { ...run, status: saves.length ? "stopped" : "running" };
  };
  context.saveActiveRun = async () => {
    assert.ok(harness.observers.every((observer) => !observer.connected), "Draft ownership ends before persistence/pause");
    if (failSave) throw context.makeError("run_state_save_failed");
    saves.push(structuredClone(run));
  };
  context.sleep = async () => { onSettle?.({ ...harness, run }); };
  return { ...harness, run, step, saves, prepare: () => context.prepareDraft(run, step, 0) };
}

test("Draft production path writes exact text, sends zero and releases ownership before confirmation-required", async () => {
  const harness = createDraftHarness();
  await assert.rejects(harness.prepare(), (error) => error.code === "user_stop");
  assert.equal(harness.state(), harness.step.prompt);
  assert.equal(harness.clicks(), 0);
  assert.equal(harness.events.length, 1);
  assert.equal(harness.observers.length, 1);
  assert.ok(harness.observers.every((observer) => !observer.connected));
  const saved = harness.saves[0];
  assert.equal(saved.status, "paused");
  assert.equal(saved.phase, "draft-ready");
  assert.equal(projectRunState(saved).kind, "confirmation-required");
  assert.equal(saved.cursor.sendsCompleted, 0);
  assert.equal(saved.cursor.stepIndex, 1);
  assert.equal(saved.outbox, null);
});

for (const text of ["既存の下書き", " ", "\t"]) {
  test(`Draft production path preserves existing draft ${JSON.stringify(text)}`, async () => {
    const harness = createDraftHarness(text);
    await assert.rejects(harness.prepare(), (error) => error.code === "draft_present");
    assert.equal(harness.state(), text);
    assert.equal(harness.events.length, 0);
    assert.equal(harness.clicks(), 0);
    assert.equal(harness.saves.length, 0);
  });
}

test("Draft production path preserves an existing attachment without writing", async () => {
  const harness = createDraftHarness();
  const attachment = harness.addAttachment();
  await assert.rejects(harness.prepare(), (error) => /attachment/.test(error.code));
  assert.equal(harness.adapter.getComposerAttachmentState().logicalNodes[0], attachment);
  assert.equal(harness.events.length, 0);
  assert.equal(harness.clicks(), 0);
  assert.equal(harness.saves.length, 0);
});

for (const [label, mutate, code] of [
  ["conversation", ({ context }) => { context.location.pathname = "/c/other"; }, "conversation_changed"],
  ["runner token", ({ context }) => { context.localRunnerToken += 1; }, "user_stop"],
  ["document instance", ({ context }) => { context.instanceId = "different-document"; }, "run_state_conflict"],
  ["execution session", ({ run }) => { run.executionSessionId = "different-session"; }, "run_state_conflict"],
  ["selected tab", ({ run }) => { run.boundTabId += 1; }, "run_state_conflict"],
  ["browser document", ({ run }) => { run.boundDocumentId = "different-browser-document"; }, "run_state_conflict"],
  ["run identity", ({ run }) => { run.runId = "different-run"; }, "run_state_conflict"],
  ["cursor", ({ run }) => { run.cursor.repeatIndex += 1; }, "run_state_conflict"]
]) {
  test(`Draft production path rejects ${label} changes during settlement and releases ownership`, async () => {
    const harness = createDraftHarness("", { onSettle: mutate });
    await assert.rejects(harness.prepare(), (error) => error.code === code);
    assert.equal(harness.state(), harness.step.prompt);
    assert.equal(harness.clicks(), 0);
    assert.equal(harness.saves.length, 0);
    assert.equal(harness.run.cursor.stepIndex, 0);
    assert.ok(harness.observers.every((observer) => !observer.connected));
  });
}

for (const [label, mutate, code] of [
  ["conversation mismatch", ({ context }) => { context.location.pathname = "/c/other"; }, "conversation_changed"],
  ["existing draft", ({ setParagraphs }) => setParagraphs(["user typed during authority read"]), "draft_present"],
  ["existing attachment", ({ addAttachment }) => addAttachment(), "unexpected_attachment"]
]) {
  test(`Draft production path rejects ${label} after the final authority await, before writing`, async () => {
    const harness = createDraftHarness("", { onRead: (state) => { if (state.reads === 2) mutate(state); } });
    await assert.rejects(harness.prepare(), (error) => error.code === code);
    assert.equal(harness.events.length, 0);
    assert.equal(harness.clicks(), 0);
    assert.equal(harness.saves.length, 0);
  });
}

for (const [label, onSettle] of [
  ["user interaction", ({ interact }) => interact()],
  ["attachment introduced", ({ addAttachment }) => addAttachment()],
  ["text changed", ({ setParagraphs }) => setParagraphs(["user changed text"])]
]) {
  test(`Draft production path rejects ${label} during settlement without retaining ownership`, async () => {
    const harness = createDraftHarness("", { onSettle });
    await assert.rejects(harness.prepare());
    assert.equal(harness.clicks(), 0);
    assert.equal(harness.saves.length, 0);
    assert.equal(harness.observers.length, 1, "the production write must have been reached");
    assert.ok(harness.observers.every((observer) => !observer.connected));
  });
}

test("Draft production path releases ownership even when draft-ready persistence fails", async () => {
  const harness = createDraftHarness("", { failSave: true });
  await assert.rejects(harness.prepare(), (error) => error.code === "run_state_save_failed");
  assert.equal(harness.clicks(), 0);
  assert.ok(harness.observers.every((observer) => !observer.connected));
});
