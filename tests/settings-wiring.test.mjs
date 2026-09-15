import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  createEditorInitialState,
  loadEditorInitialState
} from "../src/editor-defaults.js";
import { resolveStartSourceFromEditorEntry } from "../src/sidepanel-start-source.js";
import { DELAY_SECONDS_MAX, SETTINGS_STORAGE_KEY } from "../src/settings-store.js";
import {
  UI_STATE_MAP_KEY,
  mutateUiStateForTab,
  readUiStateForTab
} from "../src/ui-state-store.js";
import { MAX_DELAY_MS, MAX_SENDS_PER_RUN, normalizeQuickConfig } from "../src/workflow.js";
import { WorkspaceEditorSession } from "../src/workspace-editor-state.js";
import { installSidePanelHarness, tick } from "./helpers/sidepanel-harness.mjs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const settings = (overrides = {}) => ({
  defaults: {
    keepAwake: true,
    delaySeconds: 2,
    maxSends: 20,
    recoveryMode: "completion",
    ...overrides
  }
});

function fakeArea(seed = {}) {
  return {
    data: structuredClone(seed),
    sets: 0,
    async get(keys) {
      if (typeof keys === "string") return { [keys]: structuredClone(this.data[keys]) };
      return Object.fromEntries((keys ?? []).map((key) => [key, structuredClone(this.data[key])]));
    },
    async set(values) {
      this.sets += 1;
      Object.assign(this.data, structuredClone(values));
    }
  };
}

function serialLocks() {
  let tail = Promise.resolve();
  return {
    request(_name, _options, callback) {
      const operation = tail.then(callback);
      tail = operation.catch(() => {});
      return operation;
    }
  };
}

function editorSession(area, locks, initialState) {
  return new WorkspaceEditorSession({
    read: (tabId) => readUiStateForTab(tabId, { storageArea: area }),
    mutate: (tabId, mutation, options) => mutateUiStateForTab(tabId, mutation, {
      ...options,
      storageArea: area,
      lockManager: locks,
      now: 100
    }),
    createMissingState: async () => structuredClone(initialState)
  });
}

test("Settings X creates one complete bounded editor initial state", () => {
  const state = createEditorInitialState(settings(), { mode: "workflow" });
  assert.deepEqual(Object.keys(state).sort(), ["flow", "keepAwake", "mode", "quick", "recovery", "workflow"]);
  assert.equal(state.keepAwake, true);
  assert.equal(state.quick.delay, "2");
  assert.equal(state.workflow.maxSends, 20);
  assert.equal(state.recovery.mode, "completion");
  assert.equal(state.mode, "workflow");
  assert.equal(state.flow.text.includes("maxSends"), false, "Flow source must not be rewritten with Settings");
});

test("malformed Settings use existing normalization and preserve execution bounds", () => {
  const state = createEditorInitialState({
    defaults: {
      keepAwake: "yes",
      delaySeconds: 99999,
      maxSends: 99999,
      recoveryMode: "unsafe"
    }
  });
  assert.equal(state.keepAwake, false);
  assert.equal(state.quick.delay, "300");
  assert.equal(state.workflow.maxSends, MAX_SENDS_PER_RUN);
  assert.equal(state.recovery.mode, "safe");
});

test("Settings delay ceiling reaches Quick Runtime as the same exact bound", () => {
  for (const value of [300, 301, 3600]) {
    const state = createEditorInitialState(settings({ delaySeconds: value }));
    assert.equal(state.quick.delay, String(DELAY_SECONDS_MAX));
    const quick = normalizeQuickConfig({ prompt: "x", repeat: "1", delaySeconds: state.quick.delay });
    assert.equal(quick.delayAfterMs, MAX_DELAY_MS);
  }
  assert.equal(DELAY_SECONDS_MAX, 300);
  assert.equal(MAX_DELAY_MS, 300_000);
});

test("a maxSends default below the preset plan is exact and keeps a valid Workflow", () => {
  const state = createEditorInitialState(settings({ maxSends: 1 }));
  const planned = state.workflow.steps.reduce((total, step) => total + (step.repeat ?? 0), 0);
  assert.equal(state.workflow.maxSends, 1);
  assert.equal(planned, 1);
  assert.ok(state.workflow.maxSends <= MAX_SENDS_PER_RUN);
});

test("Settings maxSends 5 creates a new Workflow with exact ceiling 5", () => {
  const state = createEditorInitialState(settings({ maxSends: 5 }));
  assert.equal(state.workflow.maxSends, 5);
  assert.equal(state.workflow.steps.reduce((total, step) => total + (step.repeat ?? 0), 0), 5);
});

test("Settings read failure falls back to a safe normalized authoring state", async () => {
  const loaded = await loadEditorInitialState({
    storageArea: { async get() { throw new Error("read failed"); } },
    mode: "quick"
  });
  assert.equal(loaded.settingsConfirmed, false);
  assert.equal(loaded.error, "storage-read-failed");
  assert.equal(loaded.state.keepAwake, false);
  assert.equal(loaded.state.quick.delay, "0");
  assert.equal(loaded.state.recovery.mode, "safe");
});

test("an existing editor bypasses Settings initialization completely", async () => {
  const existing = createEditorInitialState(settings({ delaySeconds: 7, maxSends: 25 }), { mode: "workflow" });
  existing.quick.prompt = "saved editor";
  existing.editorRevision = 4;
  let settingsReads = 0;
  const session = new WorkspaceEditorSession({
    read: async () => ({ entry: existing, editorRevision: 4, exists: true, legacy: false }),
    mutate: async () => { throw new Error("not used"); },
    createMissingState: async () => {
      settingsReads += 1;
      return createEditorInitialState(settings({ delaySeconds: 1 }));
    }
  });
  const opened = await session.open(8);
  assert.equal(opened.ok, true);
  assert.equal(settingsReads, 0);
  assert.equal(session.snapshot().quick.prompt, "saved editor");
  assert.equal(session.snapshot().quick.delay, "7");
  assert.equal(session.snapshot().workflow.maxSends, 25);
});

test("Settings X stays with editor A while Settings Y initializes only editor B", () => {
  const editorA = createEditorInitialState(settings({ delaySeconds: 2, maxSends: 20 }));
  const editorB = createEditorInitialState(settings({ delaySeconds: 9, maxSends: 12 }));
  assert.equal(editorA.quick.delay, "2");
  assert.equal(editorA.workflow.maxSends, 20);
  assert.equal(editorB.quick.delay, "9");
  assert.equal(editorB.workflow.maxSends, 12);
});

test("a detached Workflow Run source remains Settings-X after Settings changes to Y", () => {
  const editorX = createEditorInitialState(settings({ maxSends: 20 }), { mode: "workflow" });
  const runSource = resolveStartSourceFromEditorEntry(editorX);
  const editorY = createEditorInitialState(settings({ maxSends: 12, keepAwake: false, recoveryMode: "safe" }), {
    mode: "workflow"
  });
  assert.equal(runSource.workflow.maxSends, 20);
  assert.equal(runSource.keepAwake, true);
  assert.equal(runSource.workflow.recovery.mode, "completion");
  assert.equal(editorY.workflow.maxSends, 12);
  assert.equal(editorY.keepAwake, false);
  assert.equal(runSource.workflow.maxSends, 20, "later Settings must not mutate the detached Run source");
});

test("concurrent first creation has one CAS winner and zero silent overwrite", async () => {
  const area = fakeArea();
  const locks = serialLocks();
  const initial = createEditorInitialState(settings());
  const left = editorSession(area, locks, initial);
  const right = editorSession(area, locks, initial);
  await Promise.all([left.open(7), right.open(7)]);
  const leftState = left.snapshot();
  leftState.quick.prompt = "left";
  left.replaceState(leftState);
  const rightState = right.snapshot();
  rightState.quick.prompt = "right";
  right.replaceState(rightState);

  const results = await Promise.all([left.save(), right.save()]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.reason === "stale").length, 1);
  assert.equal(area.sets, 1);
  assert.ok(["left", "right"].includes(area.data[UI_STATE_MAP_KEY]["7"].quick.prompt));
});

test("different exact tabs initialize and save without sibling loss", async () => {
  const area = fakeArea();
  const locks = serialLocks();
  const left = editorSession(area, locks, createEditorInitialState(settings({ delaySeconds: 2 })));
  const right = editorSession(area, locks, createEditorInitialState(settings({ delaySeconds: 9 })));
  await Promise.all([left.open(7), right.open(9)]);
  const results = await Promise.all([left.save(), right.save()]);
  assert.ok(results.every((result) => result.ok));
  assert.equal(area.data[UI_STATE_MAP_KEY]["7"].quick.delay, "2");
  assert.equal(area.data[UI_STATE_MAP_KEY]["9"].quick.delay, "9");
});

test("Side Panel applies Settings only to a missing exact-tab editor", async () => {
  const harness = await installSidePanelHarness({
    tabIds: [1],
    storageSeed: {
      "aipm.selectedTab.v1": 1,
      [SETTINGS_STORAGE_KEY]: settings()
    }
  });
  try {
    await tick();
    assert.equal(harness.el("keepAwake").checked, true);
    assert.equal(harness.el("quickDelay").value, "2");
    assert.equal(harness.el("recoveryMode").value, "completion");
    assert.equal(harness.el("workflowMaxSends").value, "20");
    assert.equal(harness.storage.has(UI_STATE_MAP_KEY), false, "opening a missing editor must not auto-write it");
  } finally {
    harness.restoreGlobals();
  }
});

test("Side Panel preserves an existing editor instead of re-applying current Settings", async () => {
  const existing = createEditorInitialState(settings({ delaySeconds: 7, maxSends: 25 }), { mode: "quick" });
  existing.quick.prompt = "saved Quick";
  existing.editorRevision = 4;
  existing.updatedAt = 1;
  const harness = await installSidePanelHarness({
    tabIds: [1],
    storageSeed: {
      "aipm.selectedTab.v1": 1,
      [UI_STATE_MAP_KEY]: { "1": existing },
      [SETTINGS_STORAGE_KEY]: settings({ keepAwake: false, delaySeconds: 1, maxSends: 12, recoveryMode: "safe" })
    }
  });
  try {
    await tick();
    assert.equal(harness.el("quickPrompt").value, "saved Quick");
    assert.equal(harness.el("quickDelay").value, "7");
    assert.equal(harness.el("workflowMaxSends").value, "25");
    assert.equal(harness.el("keepAwake").checked, true);
    assert.equal(harness.el("recoveryMode").value, "completion");
  } finally {
    harness.restoreGlobals();
  }
});

test("Settings change does not replace current Side Panel Quick DOM", async () => {
  const harness = await installSidePanelHarness({
    tabIds: [1],
    storageSeed: {
      "aipm.selectedTab.v1": 1,
      [SETTINGS_STORAGE_KEY]: settings()
    }
  });
  try {
    await tick();
    harness.el("quickPrompt").value = "user draft";
    harness.el("quickDelay").value = "17";
    harness.fireStorageChanged({
      [SETTINGS_STORAGE_KEY]: { newValue: settings({ delaySeconds: 9, maxSends: 12 }) }
    }, "local");
    await tick();
    assert.equal(harness.el("quickPrompt").value, "user draft");
    assert.equal(harness.el("quickDelay").value, "17");
  } finally {
    harness.restoreGlobals();
  }
});

test("Side Panel Start snapshots saved editor X and never injects later Settings Y", async () => {
  const harness = await installSidePanelHarness({
    tabIds: [1],
    storageSeed: {
      "aipm.selectedTab.v1": 1,
      [SETTINGS_STORAGE_KEY]: settings()
    }
  });
  try {
    await tick();
    harness.fireStorageChanged({
      [SETTINGS_STORAGE_KEY]: {
        newValue: settings({ keepAwake: false, delaySeconds: 9, maxSends: 12, recoveryMode: "safe" })
      }
    }, "local");
    await harness.click("start");
    await tick();
    const start = harness.messages.find((message) =>
      message?.type === "AIPM_RELAY_TO_CHATGPT" && message?.payload?.type === "AIPM_START"
    );
    assert.ok(start, "Quick Start must relay one saved exact-tab source");
    assert.equal(start.payload.keepAwake, true);
    assert.equal(start.payload.workflow.recovery.mode, "completion");
    assert.equal(start.payload.workflow.steps[0].delayAfterMs, 2_000);
    assert.equal(start.payload.workflow.maxSends, 3, "Quick repeat remains the saved editor value, not Settings maxSends");
  } finally {
    harness.restoreGlobals();
  }
});

test("Start source and protected runtime layers do not read Settings", () => {
  for (const path of [
    "src/sidepanel-start-source.js",
    "src/background.js",
    "src/content-controller.js",
    "src/content-core.js",
    "src/content-runner.js"
  ]) {
    const source = read(path);
    assert.equal(source.includes(SETTINGS_STORAGE_KEY), false, `${path} must not bind Settings to Run authority`);
    assert.equal(source.includes("settings-store.js"), false, `${path} must not import Settings`);
  }
});

test("Workspace Settings wiring adds no renderer contact, polling or selectedTab write", () => {
  const source = `${read("src/workspace-editor.js")}\n${read("src/workspace-editor-state.js")}`;
  for (const forbidden of [
    "runtime.sendMessage",
    "tabs.sendMessage",
    "scripting.executeScript",
    "setInterval(",
    "aipm.selectedTab.v1"
  ]) assert.equal(source.includes(forbidden), false, `Workspace must not use ${forbidden}`);
});
