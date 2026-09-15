import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { UI_STATE_MAP_KEY } from "../src/ui-state-store.js";
import { SETTINGS_STORAGE_KEY } from "../src/settings-store.js";
import {
  createFlowLibraryEntry,
  FLOW_LIBRARY_STORAGE_KEY,
  mutateFlowLibrary,
  updateFlowLibraryEntry,
  upsertFlowLibraryEntry
} from "../src/flow-library.js";

const workspaceHtml = fs.readFileSync(new URL("../src/workspace.html", import.meta.url), "utf8");
const elementIds = [...workspaceHtml.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);

function classList() {
  const values = new Set();
  return {
    values,
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    contains: (name) => values.has(name),
    toggle(name, force) {
      const active = force === undefined ? !values.has(name) : Boolean(force);
      if (active) values.add(name);
      else values.delete(name);
      return active;
    }
  };
}

function createElement(tag = "div", id = "", onAnchorClick = () => {}) {
  const listeners = new Map();
  const attributes = new Map();
  const children = [];
  const node = {
    tagName: String(tag).toUpperCase(),
    id,
    value: "",
    textContent: "",
    checked: false,
    disabled: false,
    hidden: false,
    type: "",
    min: "",
    max: "",
    step: "",
    rows: 0,
    spellcheck: false,
    files: null,
    href: "",
    download: "",
    dataset: {},
    style: {},
    children,
    classList: classList(),
    parentElement: { classList: classList() },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    append(...items) { children.push(...items); },
    appendChild(item) { children.push(item); return item; },
    replaceChildren(...items) { children.length = 0; children.push(...items); },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    async dispatch(type, event = {}) {
      const handlers = [...(listeners.get(type) ?? [])];
      await Promise.all(handlers.map((handler) => handler({
        type,
        target: node,
        preventDefault() {},
        ...event
      })));
    },
    async click() {
      if (node.tagName === "A") onAnchorClick(node);
      await node.dispatch("click");
    }
  };
  return node;
}

function serialLocks() {
  const tails = new Map();
  const gates = new Map();
  return {
    requests: [],
    holdNext(name) {
      let release;
      const waiting = new Promise((resolve) => { release = resolve; });
      let enter;
      const started = new Promise((resolve) => { enter = resolve; });
      gates.set(name, { waiting, enter });
      return { release, started };
    },
    request(name, _options, callback) {
      this.requests.push(name);
      const previous = tails.get(name) ?? Promise.resolve();
      const operation = previous.then(async () => {
        const gate = gates.get(name);
        if (gate) {
          gates.delete(name);
          gate.enter();
          await gate.waiting;
        }
        return callback();
      });
      tails.set(name, operation.catch(() => {}));
      return operation;
    }
  };
}

function baseEditor(label, revision) {
  return {
    mode: "flow",
    keepAwake: true,
    recovery: { mode: "completion", identityAttempts: 5, readiness: "long", statusRecovery: "persistent" },
    quick: { preset: "improve", prompt: `${label} quick`, repeat: "4", delay: "2" },
    workflow: {
      schemaVersion: 1,
      id: `${label}-workflow`,
      name: `${label} workflow`,
      maxSends: 2,
      recovery: { mode: "safe" },
      steps: [{ id: `${label}-step`, type: "prompt", delivery: "send", prompt: `${label} prompt`, repeat: 2, delayAfterMs: 0 }]
    },
    flow: {
      text: `flow ${label} {\n  send """${label}"""\n}`,
      selectedIndex: 0,
      openedLibraryId: null,
      execution: { mode: "full", start: "1", end: "1", repeat: "1", checkpointId: "" }
    },
    editorRevision: revision,
    updatedAt: 1
  };
}

async function installHarness({ seed = {}, confirm = () => true, failGet = false } = {}) {
  const storage = new Map(Object.entries(structuredClone(seed)));
  const storageSets = [];
  const clipboard = [];
  const downloads = [];
  const locks = serialLocks();
  const elements = new Map();
  const anchorClicks = [];
  let storageMutationHook = null;
  let storageReadHook = null;
  for (const id of elementIds) elements.set(id, createElement("div", id, (node) => anchorClicks.push(node)));

  const document = {
    querySelector(selector) {
      const id = String(selector).startsWith("#") ? String(selector).slice(1) : null;
      return id ? elements.get(id) ?? null : null;
    },
    createElement: (tag) => createElement(tag, "", (node) => anchorClicks.push(node))
  };
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          if (failGet) throw new Error("read failed");
          if (storageReadHook) await storageReadHook(structuredClone(keys));
          const read = (key) => storage.has(key) ? structuredClone(storage.get(key)) : undefined;
          if (typeof keys === "string") return { [keys]: read(keys) };
          if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, read(key)]));
          return Object.fromEntries([...storage].map(([key, value]) => [key, structuredClone(value)]));
        },
        async set(values) {
          storageSets.push(structuredClone(values));
          if (storageMutationHook) await storageMutationHook(structuredClone(values));
          for (const [key, value] of Object.entries(values)) storage.set(key, structuredClone(value));
        }
      }
    }
  };

  const descriptors = new Map();
  const install = (name, value) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  install("document", document);
  install("window", { confirm });
  install("chrome", chrome);
  install("navigator", { locks, clipboard: { async writeText(value) { clipboard.push(value); } } });
  install("Blob", class Blob { constructor(parts) { this.parts = parts; } });
  install("URL", {
    createObjectURL(blob) { downloads.push(blob); return `blob:aipm/${downloads.length}`; },
    revokeObjectURL() {}
  });

  const module = await import(`../src/workspace-editor.js?dom=${Date.now()}-${Math.random()}`);
  await module.initializeWorkspaceEditor();

  return {
    module,
    storage,
    storageSets,
    clipboard,
    downloads,
    anchorClicks,
    locks,
    setStorageMutationHook(hook) { storageMutationHook = hook; },
    setStorageReadHook(hook) { storageReadHook = hook; },
    el: (id) => elements.get(id),
    async click(id) { await elements.get(id).dispatch("click"); },
    async input(id) { await elements.get(id).dispatch("input"); },
    async change(id) { await elements.get(id).dispatch("change"); },
    restore() {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  };
}

test("Workspace Flow editor compiles, previews, and saves through the revision fence", async () => {
  const original = baseEditor("alpha", 5);
  const harness = await installHarness({ seed: { [UI_STATE_MAP_KEY]: { "7": original } } });
  try {
    harness.el("editorTabId").value = "7";
    await harness.click("loadEditorTarget");
    assert.equal(harness.el("workspaceFlowText").value, original.flow.text);
    assert.equal(harness.el("editorRevision").textContent, "リビジョン 5");
    assert.equal(harness.el("editorContent").classList.contains("hidden"), false);

    harness.el("workspaceFlowText").value = `flow edited {\n  send """日本語"""\n  repeat 2 { send """next""" }\n}`;
    await harness.input("workspaceFlowText");
    assert.equal(harness.el("workspaceFlowError").hidden, true);
    assert.equal(harness.el("workspacePreviewSends").textContent, "3");
    assert.equal(harness.el("saveEditorState").disabled, false);
    await harness.click("saveEditorState");

    const stored = harness.storage.get(UI_STATE_MAP_KEY)["7"];
    assert.equal(stored.editorRevision, 6);
    assert.equal(stored.flow.text, harness.el("workspaceFlowText").value);
    assert.deepEqual(stored.quick, original.quick, "non-rendered quick state must survive verbatim");
    assert.deepEqual(stored.recovery, original.recovery, "non-rendered recovery state must survive verbatim");
    assert.equal(stored.keepAwake, true);
    for (const forbidden of ["runId", "stateRevision", "executionSessionId", "lease", "outbox", "documentInstanceId"]) {
      assert.equal(JSON.stringify(stored).includes(forbidden), false);
    }
  } finally {
    harness.restore();
  }
});

test("Workspace missing exact-tab editor uses current Settings without auto-writing", async () => {
  const harness = await installHarness({
    seed: {
      [SETTINGS_STORAGE_KEY]: {
        defaults: {
          keepAwake: true,
          delaySeconds: 8,
          maxSends: 20,
          recoveryMode: "completion"
        }
      }
    }
  });
  try {
    harness.el("editorTabId").value = "71";
    await harness.click("loadEditorTarget");
    const state = harness.module.workspaceEditorDebug.session.snapshot();
    assert.equal(state.keepAwake, true);
    assert.equal(state.quick.delay, "8");
    assert.equal(state.workflow.maxSends, 20);
    assert.equal(state.recovery.mode, "completion");
    assert.equal(harness.el("workspaceWorkflowMaxSends").value, "20");
    assert.equal(harness.storage.has(UI_STATE_MAP_KEY), false, "initial display must not create a storage writer");
    assert.equal(harness.storageSets.length, 0);
  } finally {
    harness.restore();
  }
});

test("Workspace existing editor is preserved when Settings differ", async () => {
  const existing = baseEditor("saved", 7);
  const harness = await installHarness({
    seed: {
      [UI_STATE_MAP_KEY]: { "72": existing },
      [SETTINGS_STORAGE_KEY]: {
        defaults: { keepAwake: false, delaySeconds: 99, maxSends: 40, recoveryMode: "safe" }
      }
    }
  });
  try {
    harness.el("editorTabId").value = "72";
    await harness.click("loadEditorTarget");
    const state = harness.module.workspaceEditorDebug.session.snapshot();
    assert.equal(state.keepAwake, existing.keepAwake);
    assert.equal(state.quick.delay, existing.quick.delay);
    assert.equal(state.workflow.maxSends, existing.workflow.maxSends);
    assert.deepEqual(state.recovery, existing.recovery);
    assert.equal(harness.el("workspaceFlowText").value, existing.flow.text);
  } finally {
    harness.restore();
  }
});

test("Workspace Settings read failure uses safe defaults and preserves the CAS boundary", async () => {
  const harness = await installHarness();
  try {
    harness.setStorageReadHook(async (keys) => {
      if (keys === SETTINGS_STORAGE_KEY) throw new Error("settings read failed");
    });
    harness.el("editorTabId").value = "73";
    await harness.click("loadEditorTarget");
    const state = harness.module.workspaceEditorDebug.session.snapshot();
    assert.equal(state.keepAwake, false);
    assert.equal(state.quick.delay, "0");
    assert.equal(state.recovery.mode, "safe");
    assert.equal(harness.module.workspaceEditorDebug.session.editorRevision, 0);
    assert.equal(harness.storageSets.length, 0);
  } finally {
    harness.restore();
  }
});

test("dirty Workspace editor ignores later Settings storage changes", async () => {
  const harness = await installHarness({
    seed: {
      [SETTINGS_STORAGE_KEY]: {
        defaults: { keepAwake: true, delaySeconds: 2, maxSends: 20, recoveryMode: "completion" }
      }
    }
  });
  try {
    harness.el("editorTabId").value = "74";
    await harness.click("loadEditorTarget");
    harness.el("workspaceFlowText").value = `flow dirty {\n  send """mine"""\n}`;
    await harness.input("workspaceFlowText");
    const before = harness.module.workspaceEditorDebug.session.snapshot();
    harness.storage.set(SETTINGS_STORAGE_KEY, {
      defaults: { keepAwake: false, delaySeconds: 30, maxSends: 7, recoveryMode: "safe" }
    });
    const after = harness.module.workspaceEditorDebug.session.snapshot();
    assert.deepEqual(after, before);
    assert.equal(harness.el("workspaceFlowText").value, `flow dirty {\n  send """mine"""\n}`);
    assert.equal(harness.module.workspaceEditorDebug.session.dirty, true);
    assert.equal(harness.module.workspaceEditorDebug.session.editorRevision, 0);
  } finally {
    harness.restore();
  }
});

test("Workspace target switch cancellation retains unsaved DOM and exact tab selection", async () => {
  let confirmations = 0;
  const harness = await installHarness({
    seed: { [UI_STATE_MAP_KEY]: { "7": baseEditor("seven", 1), "8": baseEditor("eight", 2) } },
    confirm: () => { confirmations += 1; return false; }
  });
  try {
    harness.el("editorTabId").value = "7";
    await harness.click("loadEditorTarget");
    harness.el("workspaceFlowText").value = "flow draft { send \"\"\"keep me\"\"\" }";
    await harness.input("workspaceFlowText");

    harness.el("editorTargetList").value = "8";
    await harness.change("editorTargetList");
    assert.equal(confirmations, 1);
    assert.equal(harness.module.workspaceEditorDebug.session.tabId, 7);
    assert.equal(harness.el("editorTabId").value, "7");
    assert.equal(harness.el("workspaceFlowText").value, "flow draft { send \"\"\"keep me\"\"\" }");
    assert.equal(harness.storageSets.length, 0, "switch cancellation must not autosave or write selection");
  } finally {
    harness.restore();
  }
});

test("Workspace target switch confirmation explicitly discards the stale draft and opens the exact target", async () => {
  const seven = baseEditor("seven", 1);
  const eight = baseEditor("eight", 2);
  const harness = await installHarness({
    seed: { [UI_STATE_MAP_KEY]: { "7": seven, "8": eight } },
    confirm: () => true
  });
  try {
    harness.el("editorTabId").value = "7";
    await harness.click("loadEditorTarget");
    harness.el("workspaceFlowText").value = "flow discarded { send \"\"\"explicit\"\"\" }";
    await harness.input("workspaceFlowText");
    harness.module.onWorkspaceEditorStorageChanged({
      [UI_STATE_MAP_KEY]: { newValue: { "7": baseEditor("external", 3), "8": eight } }
    }, "local");

    harness.el("editorTargetList").value = "8";
    await harness.change("editorTargetList");
    assert.equal(harness.module.workspaceEditorDebug.session.tabId, 8);
    assert.equal(harness.module.workspaceEditorDebug.session.editorRevision, 2);
    assert.equal(harness.el("workspaceFlowText").value, eight.flow.text);
    assert.equal(harness.storageSets.length, 0, "explicit discard does not merge or autosave the stale draft");
  } finally {
    harness.restore();
  }
});

test("Workspace Workflow editor supports structured changes and validation without touching a Run", async () => {
  const harness = await installHarness({ seed: { [UI_STATE_MAP_KEY]: { "4": baseEditor("four", 3) } } });
  try {
    harness.el("editorTabId").value = "4";
    await harness.click("loadEditorTarget");
    await harness.click("workflowEditorTab");
    harness.el("workspaceWorkflowName").value = "Workspace workflow";
    await harness.input("workspaceWorkflowName");
    await harness.click("workspaceAddCheckpoint");
    await harness.click("workspaceAddDelay");
    assert.equal(harness.el("workspaceWorkflowError").hidden, true);
    assert.equal(harness.el("workspaceWorkflowPreviewBlocks").textContent, "3");
    const descendants = (node) => [node, ...node.children.flatMap(descendants)];
    const rendered = descendants(harness.el("workspaceSteps"));
    assert.ok(rendered.some((node) => node.textContent === "1. AIへの指示 · 入力して送信"));
    assert.ok(rendered.some((node) => node.tagName === "LABEL" && node.textContent === "繰り返し回数"));
    assert.ok(rendered.some((node) => node.textContent === "2. 確認ポイント"));
    assert.ok(rendered.some((node) => node.textContent === "3. 待機"));
    await harness.click("saveEditorState");
    assert.match(harness.el("editorStateNotice").textContent, /編集状態を保存しました.*サイドパネルで同じタブの「保存済み実行内容」を確認して開始/);

    const stored = harness.storage.get(UI_STATE_MAP_KEY)["4"];
    assert.equal(stored.mode, "workflow");
    assert.equal(stored.workflow.name, "Workspace workflow");
    assert.deepEqual(stored.workflow.steps.map((step) => step.type), ["prompt", "checkpoint", "delay"]);
    assert.equal(harness.storage.has("aipm.selectedTab.v1"), false);
    assert.deepEqual([...harness.storage.keys()].sort(), [UI_STATE_MAP_KEY]);
  } finally {
    harness.restore();
  }
});

test("Workspace scheduled-time control renders local minutes and saves the edited ISO value", async () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = "Asia/Tokyo";
  let harness;
  try {
    const original = baseEditor("scheduled", 3);
    original.workflow.steps.push({
      id: "scheduled", type: "wait-until", at: "2026-09-05T00:15:43.987Z",
      latePolicy: "pause", graceMs: 300000
    });
    harness = await installHarness({ seed: { [UI_STATE_MAP_KEY]: { "4": original } } });
    harness.el("editorTabId").value = "4";
    await harness.click("loadEditorTarget");
    await harness.click("workflowEditorTab");
    const descendants = (node) => [node, ...node.children.flatMap(descendants)];
    const when = descendants(harness.el("workspaceSteps")).find((node) => node.type === "datetime-local");
    assert.equal(when.value, "2026-09-05T09:15");
    assert.equal(harness.storage.get(UI_STATE_MAP_KEY)["4"].workflow.steps[1].at, original.workflow.steps[1].at);
    when.value = "2026-09-06T10:45";
    await when.dispatch("change");
    await harness.click("saveEditorState");
    assert.deepEqual(harness.storage.get(UI_STATE_MAP_KEY)["4"].workflow.steps[1], {
      ...original.workflow.steps[1], at: "2026-09-06T01:45:00.000Z"
    });
  } finally {
    harness?.restore();
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test("Workspace Flow Library, Import, Export, search, favorite, duplicate, rename and delete use the existing store", async () => {
  const harness = await installHarness({ seed: { [UI_STATE_MAP_KEY]: { "2": baseEditor("two", 0) } } });
  try {
    harness.el("editorTabId").value = "2";
    await harness.click("loadEditorTarget");

    const imported = `flow imported {\n  send """A"""\n  send """B"""\n}`;
    harness.el("workspaceImportText").value = imported;
    await harness.click("workspaceImportPaste");
    assert.equal(harness.el("workspaceFlowText").value, imported);
    assert.equal(harness.el("workspacePreviewSends").textContent, "2");

    const importedFile = `flow imported_file {\n  send """file"""\n}`;
    harness.el("workspaceImportFile").files = [{
      name: "imported.aipm-flow",
      size: new TextEncoder().encode(importedFile).byteLength,
      async text() { return importedFile; }
    }];
    await harness.change("workspaceImportFile");
    assert.equal(harness.el("workspaceFlowText").value, importedFile);
    assert.equal(harness.el("workspaceImportFile").value, "");

    const beforeMalformedImport = harness.el("workspaceFlowText").value;
    harness.el("workspaceImportText").value = "not an AIPM Flow";
    await harness.click("workspaceImportPaste");
    assert.equal(harness.el("workspaceFlowText").value, beforeMalformedImport);
    assert.notEqual(harness.el("workspaceImportStatus").textContent, "");

    harness.el("workspaceImportText").value = imported;
    await harness.click("workspaceImportPaste");

    harness.el("workspaceLibraryName").value = "Imported flow";
    harness.el("workspaceLibraryDescription").value = "workspace parity";
    harness.el("workspaceLibraryFavorite").checked = true;
    await harness.click("workspaceLibrarySaveNew");
    let library = harness.storage.get(FLOW_LIBRARY_STORAGE_KEY);
    assert.equal(library.entries.length, 1);
    assert.equal(library.entries[0].favorite, true);
    const originalId = library.entries[0].id;

    const updated = `flow updated {\n  send """Updated"""\n}`;
    harness.el("workspaceFlowText").value = updated;
    await harness.input("workspaceFlowText");
    harness.el("workspaceLibraryDescription").value = "updated metadata";
    await harness.click("workspaceLibraryUpdate");
    library = harness.storage.get(FLOW_LIBRARY_STORAGE_KEY);
    assert.equal(library.entries.find((entry) => entry.id === originalId).source, updated);
    assert.equal(library.entries.find((entry) => entry.id === originalId).description, "updated metadata");

    harness.el("workspaceLibraryName").value = "Renamed flow";
    await harness.click("workspaceLibraryRename");
    library = harness.storage.get(FLOW_LIBRARY_STORAGE_KEY);
    assert.equal(library.entries.find((entry) => entry.id === originalId).name, "Renamed flow");

    await harness.click("workspaceLibraryDuplicate");
    library = harness.storage.get(FLOW_LIBRARY_STORAGE_KEY);
    assert.equal(library.entries.length, 2);
    const duplicateId = harness.el("workspaceLibraryList").value;
    assert.notEqual(duplicateId, originalId);

    harness.el("workspaceLibrarySearch").value = "Renamed";
    await harness.input("workspaceLibrarySearch");
    assert.ok(harness.el("workspaceLibraryList").children.length >= 1);
    harness.el("workspaceLibrarySearch").value = "";
    await harness.input("workspaceLibrarySearch");

    harness.el("workspaceFlowText").value = `flow localdraft { send """local""" }`;
    await harness.input("workspaceFlowText");
    harness.el("workspaceLibraryList").value = originalId;
    await harness.change("workspaceLibraryList");
    await harness.click("workspaceLibraryOpen");
    assert.equal(harness.el("workspaceFlowText").value, updated);

    harness.el("workspaceLibraryList").value = duplicateId;
    await harness.change("workspaceLibraryList");

    await harness.click("workspaceLibraryCopy");
    assert.equal(harness.clipboard.at(-1), updated);
    await harness.click("workspaceLibraryExport");
    assert.equal(harness.downloads.length, 1);
    assert.equal(harness.anchorClicks.length, 1);

    await harness.click("workspaceLibraryDelete");
    library = harness.storage.get(FLOW_LIBRARY_STORAGE_KEY);
    assert.equal(library.entries.length, 1);
    assert.equal(library.entries.some((entry) => entry.id === duplicateId), false);

    await harness.click("workspaceExportFile");
    assert.equal(harness.downloads.length, 2);
    assert.ok(harness.storageSets.every((payload) => !Object.hasOwn(payload, "aipm.selectedTab.v1")));
  } finally {
    harness.restore();
  }
});

test("Phase 4C K: Workspace Library update retains its draft when another surface wins first", async () => {
  const libraryEntry = createFlowLibraryEntry({
    source: 'flow shared { send """BASE""" }',
    name: "Shared"
  }, { id: "shared", now: 1 });
  const editor = baseEditor("workspace", 5);
  editor.flow.text = libraryEntry.source;
  editor.flow.openedLibraryId = libraryEntry.id;
  const harness = await installHarness({
    seed: {
      [UI_STATE_MAP_KEY]: { "7": editor },
      [FLOW_LIBRARY_STORAGE_KEY]: { schemaVersion: 1, revision: 5, entries: [libraryEntry] }
    }
  });
  try {
    harness.el("editorTabId").value = "7";
    await harness.click("loadEditorTarget");
    harness.el("workspaceFlowText").value = 'flow shared { send """WORKSPACE DRAFT""" }';
    await harness.input("workspaceFlowText");

    await mutateFlowLibrary((latest) => {
      const fresh = latest.entries.find((entry) => entry.id === libraryEntry.id);
      return upsertFlowLibraryEntry(latest, updateFlowLibraryEntry(fresh, {
        source: 'flow shared { send """SIDE PANEL WON""" }'
      }, { now: 2 }));
    }, { expectedRevision: 5 });

    await harness.click("workspaceLibraryUpdate");
    const stored = harness.storage.get(FLOW_LIBRARY_STORAGE_KEY);
    assert.equal(stored.entries[0].source, 'flow shared { send """SIDE PANEL WON""" }');
    assert.equal(stored.revision, 6);
    assert.equal(harness.el("workspaceFlowText").value, 'flow shared { send """WORKSPACE DRAFT""" }');
    assert.match(harness.el("workspaceLibraryStatus").textContent, /別の画面|再読み込み/u);
  } finally {
    harness.restore();
  }
});

test("Phase 4C N: Workspace Library action rejects editVersion, source, and metadata changes while awaiting its lock", async () => {
  const libraryEntry = createFlowLibraryEntry({
    source: 'flow shared { send """BASE""" }',
    name: "Shared",
    description: "base"
  }, { id: "shared", now: 1 });
  const editor = baseEditor("workspace", 5);
  editor.flow.text = libraryEntry.source;
  editor.flow.openedLibraryId = libraryEntry.id;
  const harness = await installHarness({
    seed: {
      [UI_STATE_MAP_KEY]: { "7": editor },
      [FLOW_LIBRARY_STORAGE_KEY]: { schemaVersion: 1, revision: 5, entries: [libraryEntry] }
    }
  });
  try {
    harness.el("editorTabId").value = "7";
    await harness.click("loadEditorTarget");
    harness.el("workspaceFlowText").value = 'flow shared { send """CLICK SNAPSHOT""" }';
    await harness.input("workspaceFlowText");
    harness.el("workspaceLibraryName").value = "Click name";

    const gate = harness.locks.holdNext("aipm-flow-library-v1");
    const update = harness.click("workspaceLibraryUpdate");
    await gate.started;
    harness.el("workspaceFlowText").value = 'flow shared { send """TYPED LATER""" }';
    await harness.input("workspaceFlowText");
    harness.el("workspaceLibraryName").value = "Typed later";
    harness.el("workspaceLibraryDescription").value = "metadata later";
    gate.release();
    await update;

    const stored = harness.storage.get(FLOW_LIBRARY_STORAGE_KEY);
    assert.equal(stored.revision, 5);
    assert.equal(stored.entries[0].source, libraryEntry.source);
    assert.equal(stored.entries[0].name, libraryEntry.name);
    assert.equal(harness.el("workspaceFlowText").value, 'flow shared { send """TYPED LATER""" }');
    assert.equal(harness.el("workspaceLibraryName").value, "Typed later");
    assert.equal(harness.el("workspaceLibraryDescription").value, "metadata later");
    assert.match(harness.el("workspaceLibraryStatus").textContent, /変わ/u);
  } finally {
    harness.restore();
  }
});

test("Phase 4C N: external Library events never render over Workspace metadata typed locally", async () => {
  const libraryEntry = createFlowLibraryEntry({
    source: 'flow shared { send """BASE""" }',
    name: "Shared",
    description: "base"
  }, { id: "shared", now: 1 });
  const editor = baseEditor("workspace", 5);
  editor.flow.text = libraryEntry.source;
  editor.flow.openedLibraryId = libraryEntry.id;
  const harness = await installHarness({
    seed: {
      [UI_STATE_MAP_KEY]: { "7": editor },
      [FLOW_LIBRARY_STORAGE_KEY]: { schemaVersion: 1, revision: 5, entries: [libraryEntry] }
    }
  });
  try {
    harness.el("editorTabId").value = "7";
    await harness.click("loadEditorTarget");
    harness.el("workspaceLibraryName").value = "LOCAL NAME";
    harness.el("workspaceLibraryDescription").value = "LOCAL DESCRIPTION";

    const external = await mutateFlowLibrary((latest) => {
      const fresh = latest.entries.find((entry) => entry.id === libraryEntry.id);
      return upsertFlowLibraryEntry(latest, updateFlowLibraryEntry(fresh, {
        name: "EXTERNAL NAME",
        description: "EXTERNAL DESCRIPTION"
      }, { now: 2 }));
    }, { expectedRevision: 5 });
    harness.module.onWorkspaceEditorStorageChanged({
      [FLOW_LIBRARY_STORAGE_KEY]: { newValue: external }
    }, "local");
    await Promise.resolve();

    assert.equal(harness.el("workspaceLibraryName").value, "LOCAL NAME");
    assert.equal(harness.el("workspaceLibraryDescription").value, "LOCAL DESCRIPTION");
    assert.match(harness.el("workspaceLibraryStatus").textContent, /保持/u);
    await harness.click("workspaceLibraryRename");
    const stored = harness.storage.get(FLOW_LIBRARY_STORAGE_KEY);
    assert.equal(stored.revision, 6);
    assert.equal(stored.entries[0].name, "EXTERNAL NAME");
  } finally {
    harness.restore();
  }
});

test("Workspace stale notification changes no DOM editor value and causes zero extra storage writes", async () => {
  const original = baseEditor("stale", 5);
  const harness = await installHarness({ seed: { [UI_STATE_MAP_KEY]: { "9": original } } });
  try {
    harness.el("editorTabId").value = "9";
    await harness.click("loadEditorTarget");
    harness.el("workspaceFlowText").value = "flow local { send \"\"\"local draft\"\"\" }";
    await harness.input("workspaceFlowText");
    const before = harness.el("workspaceFlowText").value;
    const setsBefore = harness.storageSets.length;
    harness.module.onWorkspaceEditorStorageChanged({
      [UI_STATE_MAP_KEY]: {
        oldValue: { "9": original },
        newValue: { "9": baseEditor("other", 6) }
      }
    }, "local");
    await Promise.resolve();
    assert.equal(harness.el("workspaceFlowText").value, before);
    assert.equal(harness.el("editorStateNotice").hidden, false);
    assert.match(harness.el("editorStateNotice").textContent, /保持/);
    assert.equal(harness.el("saveEditorState").disabled, true);
    assert.equal(harness.storageSets.length, setsBefore);
  } finally {
    harness.restore();
  }
});

test("Phase 4C RED: a revision observed during a successful save remains visible as stale", async () => {
  const original = baseEditor("during-save", 5);
  const harness = await installHarness({ seed: { [UI_STATE_MAP_KEY]: { "9": original } } });
  try {
    harness.el("editorTabId").value = "9";
    await harness.click("loadEditorTarget");
    harness.el("workspaceFlowText").value = "flow local { send \"\"\"local draft\"\"\" }";
    await harness.input("workspaceFlowText");

    let observed = false;
    harness.setStorageMutationHook(async (values) => {
      if (observed || !Object.hasOwn(values, UI_STATE_MAP_KEY)) return;
      observed = true;
      harness.module.onWorkspaceEditorStorageChanged({
        [UI_STATE_MAP_KEY]: {
          oldValue: values[UI_STATE_MAP_KEY],
          newValue: { "9": baseEditor("other-surface", 7) }
        }
      }, "local");
    });

    await harness.click("saveEditorState");
    assert.equal(observed, true);
    assert.equal(harness.storage.get(UI_STATE_MAP_KEY)["9"].editorRevision, 6, "the revision-6 CAS itself succeeded");
    assert.equal(harness.module.workspaceEditorDebug.session.stale, true);
    assert.equal(harness.el("saveEditorState").disabled, true);
    assert.equal(harness.el("editorStateNotice").hidden, false);
    assert.match(harness.el("editorStateNotice").textContent, /編集状態を保存しました（リビジョン 6）/u);
    assert.match(harness.el("editorStateNotice").textContent, /その後、別の画面で更新されました。現在の入力は保持/u);
    assert.equal(harness.el("workspaceFlowText").value, "flow local { send \"\"\"local draft\"\"\" }");
  } finally {
    harness.restore();
  }
});

test("Workspace storage read failure is bounded and leaves the editor unopened", async () => {
  const harness = await installHarness({ failGet: true });
  try {
    harness.el("editorTabId").value = "1";
    await harness.click("loadEditorTarget");
    assert.equal(harness.el("editorContent").classList.contains("hidden"), true);
    assert.equal(harness.el("editorStateNotice").hidden, false);
    assert.equal(harness.storageSets.length, 0);
  } finally {
    harness.restore();
  }
});

test("Phase 4C J: Workspace target read failure retains the already-open source session and DOM", async () => {
  const source = baseEditor("source", 4);
  const destination = baseEditor("destination", 8);
  const harness = await installHarness({
    seed: { [UI_STATE_MAP_KEY]: { "1": source, "2": destination } },
    confirm: () => true
  });
  try {
    harness.el("editorTabId").value = "1";
    await harness.click("loadEditorTarget");
    harness.el("workspaceFlowText").value = 'flow local_draft { send """LOCAL""" }';
    await harness.input("workspaceFlowText");
    harness.setStorageReadHook(async () => { throw new Error("destination read failed"); });

    harness.el("editorTargetList").value = "2";
    await harness.change("editorTargetList");

    assert.equal(harness.module.workspaceEditorDebug.session.tabId, 1);
    assert.equal(harness.module.workspaceEditorDebug.session.editorRevision, 4);
    assert.equal(harness.module.workspaceEditorDebug.session.dirty, true);
    assert.equal(harness.el("editorTabId").value, "1");
    assert.equal(harness.el("workspaceFlowText").value, 'flow local_draft { send """LOCAL""" }');
    assert.equal(harness.storageSets.length, 0);
    assert.equal(harness.el("editorStateNotice").hidden, false);
  } finally {
    harness.restore();
  }
});
