import assert from "node:assert/strict";
import test from "node:test";

import {
  createFlowLibraryEntry,
  deleteFlowLibraryEntry,
  FLOW_LIBRARY_STORAGE_KEY,
  loadFlowLibrary,
  mutateFlowLibrary,
  updateFlowLibraryEntry,
  upsertFlowLibraryEntry
} from "../src/flow-library.js";
import { WorkspaceEditorSession } from "../src/workspace-editor-state.js";
import {
  UI_STATE_LOCK_NAME,
  UI_STATE_MAP_KEY,
  mutateUiStateForTab,
  readUiStateForTab
} from "../src/ui-state-store.js";
import { installSidePanelHarness, tick } from "./helpers/sidepanel-harness.mjs";

const TAB_A = 1;
const TAB_B = 2;

function editorEntry(label, revision = 4, openedLibraryId = null) {
  return {
    mode: "flow",
    keepAwake: false,
    recovery: { mode: "safe", identityAttempts: 3, readiness: "normal", statusRecovery: "normal" },
    quick: { preset: "review", prompt: `${label} prompt`, repeat: "3", delay: "1.5" },
    workflow: { schemaVersion: 1, id: `${label}-wf`, name: label, maxSends: 1, recovery: { mode: "safe" }, steps: [] },
    flow: {
      text: `flow ${label} { send \"\"\"${label}\"\"\" }`,
      selectedIndex: 0,
      openedLibraryId,
      execution: { mode: "full", start: "1", end: "1", repeat: "1", checkpointId: "" }
    },
    editorRevision: revision,
    updatedAt: 1
  };
}

async function panelWithEditors(map) {
  const harness = await installSidePanelHarness({
    tabIds: [TAB_A, TAB_B],
    storageSeed: {
      "aipm.selectedTab.v1": TAB_A,
      [UI_STATE_MAP_KEY]: map
    }
  });
  await tick();
  return harness;
}

function editWorkspace(session, text) {
  const state = session.snapshot();
  state.flow.text = text;
  session.replaceState(state);
}

async function startPanelSave(harness, prompt) {
  harness.el("quickPrompt").value = prompt;
  harness.el("keepAwake").checked = !harness.el("keepAwake").checked;
  return harness.change("keepAwake");
}

test("Phase 4C C: truly concurrent same-tab Panel winner leaves Workspace stale and its draft intact", async () => {
  const harness = await panelWithEditors({ [TAB_A]: editorEntry("base") });
  try {
    const workspace = new WorkspaceEditorSession();
    await workspace.open(TAB_A);
    editWorkspace(workspace, "flow workspace_draft { send \"\"\"W\"\"\" }");

    let editorWrites = 0;
    harness.setStorageMutationHook(async (values) => {
      if (Object.hasOwn(values, UI_STATE_MAP_KEY)) editorWrites += 1;
    });
    const gate = harness.lockManager.holdNext(UI_STATE_LOCK_NAME);
    const panelSave = startPanelSave(harness, "PANEL WON");
    await gate.started;
    const workspaceSave = workspace.save();
    gate.release();

    await panelSave;
    const result = await workspaceSave;
    assert.deepEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: "stale" });
    assert.equal(editorWrites, 1);
    assert.equal(harness.storage.get(UI_STATE_MAP_KEY)[TAB_A].quick.prompt, "PANEL WON");
    assert.equal(harness.storage.get(UI_STATE_MAP_KEY)[TAB_A].editorRevision, 5);
    assert.equal(workspace.snapshot().flow.text, "flow workspace_draft { send \"\"\"W\"\"\" }");
    assert.equal(workspace.stale, true);
  } finally {
    harness.restoreGlobals();
  }
});

test("Phase 4C C: truly concurrent same-tab Workspace winner leaves Panel DOM stale without overwrite", async () => {
  const harness = await panelWithEditors({ [TAB_A]: editorEntry("base") });
  try {
    const workspace = new WorkspaceEditorSession();
    await workspace.open(TAB_A);
    editWorkspace(workspace, "flow workspace_won { send \"\"\"W\"\"\" }");
    harness.el("quickPrompt").value = "PANEL DRAFT";

    let editorWrites = 0;
    harness.setStorageMutationHook(async (values) => {
      if (Object.hasOwn(values, UI_STATE_MAP_KEY)) editorWrites += 1;
    });
    const gate = harness.lockManager.holdNext(UI_STATE_LOCK_NAME);
    const workspaceSave = workspace.save();
    await gate.started;
    const panelSave = startPanelSave(harness, "PANEL DRAFT");
    gate.release();

    const result = await workspaceSave;
    await panelSave;
    assert.equal(result.ok, true);
    assert.equal(editorWrites, 1);
    assert.equal(harness.storage.get(UI_STATE_MAP_KEY)[TAB_A].flow.text, "flow workspace_won { send \"\"\"W\"\"\" }");
    assert.equal(harness.el("quickPrompt").value, "PANEL DRAFT");
    assert.equal(harness.el("editorStateNotice").hidden, false);
    assert.match(harness.el("editorStateNotice").textContent, /別の画面/u);
  } finally {
    harness.restoreGlobals();
  }
});

test("Phase 4C D: concurrent different-tab writers preserve both map siblings", async () => {
  const harness = await panelWithEditors({
    [TAB_A]: editorEntry("a", 4),
    [TAB_B]: editorEntry("b", 8)
  });
  try {
    const workspace = new WorkspaceEditorSession();
    await workspace.open(TAB_B);
    editWorkspace(workspace, "flow workspace_b { send \"\"\"B\"\"\" }");
    const [panelResult, workspaceResult] = await Promise.all([
      startPanelSave(harness, "PANEL A"),
      workspace.save()
    ]);
    assert.ok(panelResult);
    assert.equal(workspaceResult.ok, true);
    const map = harness.storage.get(UI_STATE_MAP_KEY);
    assert.equal(map[TAB_A].quick.prompt, "PANEL A");
    assert.equal(map[TAB_A].editorRevision, 5);
    assert.equal(map[TAB_B].flow.text, "flow workspace_b { send \"\"\"B\"\"\" }");
    assert.equal(map[TAB_B].editorRevision, 9);
  } finally {
    harness.restoreGlobals();
  }
});

test("Phase 4C E: Side Panel save snapshots A and leaves later DOM edit B unsaved", async () => {
  const harness = await panelWithEditors({ [TAB_A]: editorEntry("base") });
  try {
    const gate = harness.lockManager.holdNext(UI_STATE_LOCK_NAME);
    const saving = startPanelSave(harness, "SNAPSHOT A");
    await gate.started;
    harness.el("quickPrompt").value = "LATER DOM B";
    gate.release();
    await saving;

    assert.equal(harness.storage.get(UI_STATE_MAP_KEY)[TAB_A].quick.prompt, "SNAPSHOT A");
    assert.equal(harness.el("quickPrompt").value, "LATER DOM B");
  } finally {
    harness.restoreGlobals();
  }
});

test("Phase 4C self echo: an in-flight own revision never creates a stale warning", async () => {
  const harness = await panelWithEditors({ [TAB_A]: editorEntry("base") });
  try {
    let echoed = false;
    harness.setStorageMutationHook(async (values) => {
      if (echoed || !Object.hasOwn(values, UI_STATE_MAP_KEY)) return;
      echoed = true;
      harness.fireStorageChanged({ [UI_STATE_MAP_KEY]: { newValue: values[UI_STATE_MAP_KEY] } }, "local");
      assert.equal(harness.el("editorStateNotice").hidden, true, "the pending own revision is already known");
    });
    await startPanelSave(harness, "OWN ECHO");
    assert.equal(echoed, true);
    assert.equal(harness.el("editorStateNotice").hidden, true);
  } finally {
    harness.restoreGlobals();
  }
});

test("Phase 4C J RED: destination read failure leaves Side Panel target and DOM on the source tab", async () => {
  const harness = await panelWithEditors({
    [TAB_A]: editorEntry("a", 4),
    [TAB_B]: editorEntry("b", 8)
  });
  try {
    harness.el("quickPrompt").value = "SOURCE DOM";
    harness.setStorageReadHook(async (keys) => {
      if (Array.isArray(keys) && keys.includes(UI_STATE_MAP_KEY)) throw new Error("destination read failed");
    });
    harness.el("targetTab").value = String(TAB_B);
    await harness.change("targetTab");
    for (let turn = 0; turn < 5; turn += 1) await tick();

    assert.equal(harness.storage.get("aipm.selectedTab.v1"), TAB_A);
    assert.equal(harness.el("targetTab").value, String(TAB_A));
    assert.equal(harness.el("quickPrompt").value, "SOURCE DOM");
    assert.equal(harness.storage.get(UI_STATE_MAP_KEY)[TAB_A].quick.prompt, "SOURCE DOM");
  } finally {
    harness.restoreGlobals();
  }
});

test("Phase 4C J: selected-target write failure leaves Side Panel target and DOM on the source tab", async () => {
  const harness = await panelWithEditors({
    [TAB_A]: editorEntry("a", 4),
    [TAB_B]: editorEntry("b", 8)
  });
  try {
    harness.el("quickPrompt").value = "SOURCE DOM";
    harness.setStorageMutationHook(async (values) => {
      if (Object.hasOwn(values, "aipm.selectedTab.v1")) throw new Error("selection write failed");
    });
    harness.el("targetTab").value = String(TAB_B);
    await harness.change("targetTab");
    for (let turn = 0; turn < 5; turn += 1) await tick();

    assert.equal(harness.storage.get("aipm.selectedTab.v1"), TAB_A);
    assert.equal(harness.el("targetTab").value, String(TAB_A));
    assert.equal(harness.el("quickPrompt").value, "SOURCE DOM");
    assert.equal(harness.storage.get(UI_STATE_MAP_KEY)[TAB_A].quick.prompt, "SOURCE DOM");
    assert.equal(harness.storage.get(UI_STATE_MAP_KEY)[TAB_A].editorRevision, 5);
    assert.equal(harness.el("editorStateNotice").hidden, false);
  } finally {
    harness.restoreGlobals();
  }
});

test("Phase 4C K: a stale Side Panel Library update cannot overwrite a Workspace winner", async () => {
  const entry = createFlowLibraryEntry({
    source: 'flow shared { send """BASE""" }',
    name: "Shared"
  }, { id: "shared", now: 1 });
  const harness = await installSidePanelHarness({
    tabIds: [TAB_A],
    storageSeed: {
      "aipm.selectedTab.v1": TAB_A,
      [UI_STATE_MAP_KEY]: { [TAB_A]: editorEntry("base", 4, entry.id) },
      [FLOW_LIBRARY_STORAGE_KEY]: { schemaVersion: 1, revision: 5, entries: [entry] }
    }
  });
  await tick();
  try {
    harness.el("flowText").value = 'flow shared { send """PANEL DRAFT""" }';
    await mutateFlowLibrary((latest) => {
      const fresh = latest.entries.find((item) => item.id === entry.id);
      return upsertFlowLibraryEntry(latest, updateFlowLibraryEntry(fresh, {
        source: 'flow shared { send """WORKSPACE WON""" }'
      }, { now: 2 }));
    }, { expectedRevision: 5 });

    await harness.click("flowLibraryUpdate");
    const stored = harness.libraryEntry(entry.id);
    assert.equal(stored.source, 'flow shared { send """WORKSPACE WON""" }');
    assert.equal(harness.el("flowText").value, 'flow shared { send """PANEL DRAFT""" }');
    assert.match(harness.el("flowLibraryStatus").textContent, /別の画面|再読み込み/u);
    assert.equal(harness.library().revision, 6);
  } finally {
    harness.restoreGlobals();
  }
});

test("Phase 4C N: external Library events preserve Side Panel metadata and the stale rename is refused", async () => {
  const entry = createFlowLibraryEntry({
    source: 'flow shared { send """BASE""" }',
    name: "Shared",
    description: "base"
  }, { id: "shared", now: 1 });
  const harness = await installSidePanelHarness({
    tabIds: [TAB_A],
    storageSeed: {
      "aipm.selectedTab.v1": TAB_A,
      [UI_STATE_MAP_KEY]: { [TAB_A]: editorEntry("base", 4, entry.id) },
      [FLOW_LIBRARY_STORAGE_KEY]: { schemaVersion: 1, revision: 5, entries: [entry] }
    }
  });
  await tick();
  try {
    harness.el("flowLibraryName").value = "LOCAL NAME";
    harness.el("flowLibraryDescription").value = "LOCAL DESCRIPTION";
    const external = await mutateFlowLibrary((latest) => {
      const fresh = latest.entries.find((item) => item.id === entry.id);
      return upsertFlowLibraryEntry(latest, updateFlowLibraryEntry(fresh, {
        name: "EXTERNAL NAME",
        description: "EXTERNAL DESCRIPTION"
      }, { now: 2 }));
    }, { expectedRevision: 5 });
    harness.fireStorageChanged({ [FLOW_LIBRARY_STORAGE_KEY]: { newValue: external } }, "local");

    assert.equal(harness.el("flowLibraryName").value, "LOCAL NAME");
    assert.equal(harness.el("flowLibraryDescription").value, "LOCAL DESCRIPTION");
    assert.match(harness.el("flowLibraryStatus").textContent, /保持/u);
    await harness.click("flowLibraryRename");
    assert.equal(harness.library().revision, 6);
    assert.equal(harness.libraryEntry(entry.id).name, "EXTERNAL NAME");
  } finally {
    harness.restoreGlobals();
  }
});

function deterministicRandom(seed = 0x4c2026) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function serialLocks() {
  const tails = new Map();
  return {
    request(name, _options, callback) {
      const operation = (tails.get(name) ?? Promise.resolve()).then(callback);
      tails.set(name, operation.catch(() => {}));
      return operation;
    }
  };
}

function storageArea(seed = {}) {
  return {
    data: structuredClone(seed),
    sets: 0,
    async get(keys) {
      const read = (key) => structuredClone(this.data[key]);
      if (typeof keys === "string") return { [keys]: read(keys) };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, read(key)]));
      return structuredClone(this.data);
    },
    async set(values) {
      this.sets += 1;
      Object.assign(this.data, structuredClone(values));
    }
  };
}

function isolatedSession(area, locks, now) {
  return new WorkspaceEditorSession({
    read: (tabId) => readUiStateForTab(tabId, { storageArea: area }),
    mutate: (tabId, mutation, options) => mutateUiStateForTab(tabId, mutation, {
      ...options,
      storageArea: area,
      lockManager: locks,
      now
    })
  });
}

test("Phase 4C deterministic editor torture: 100 cross-surface schedules preserve revisions and siblings", async () => {
  const random = deterministicRandom();
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const initial = {
      "1": editorEntry(`one-${iteration}`, 2),
      "2": editorEntry(`two-${iteration}`, 4),
      "3": editorEntry(`three-${iteration}`, 6)
    };
    const area = storageArea({ [UI_STATE_MAP_KEY]: initial });
    const locks = serialLocks();
    const leftTab = 1 + Math.floor(random() * 3);
    const sameTab = random() < 0.5;
    const rightTab = sameTab ? leftTab : 1 + (leftTab % 3);
    const left = isolatedSession(area, locks, iteration + 10);
    const right = isolatedSession(area, locks, iteration + 20);
    await Promise.all([left.open(leftTab), right.open(rightTab)]);
    editWorkspace(left, `flow left_${iteration} { send \"\"\"L\"\"\" }`);
    editWorkspace(right, `flow right_${iteration} { send \"\"\"R\"\"\" }`);

    const results = random() < 0.5
      ? await Promise.all([left.save(), right.save()])
      : (await Promise.all([right.save(), left.save()])).reverse();
    const winners = results.filter((result) => result.ok);
    const losers = results.filter((result) => !result.ok);
    assert.equal(winners.length, sameTab ? 1 : 2, `iteration ${iteration}: winner count`);
    assert.equal(losers.length, sameTab ? 1 : 0, `iteration ${iteration}: loser count`);
    if (sameTab) assert.equal(losers[0].reason, "stale");
    assert.equal(area.sets, sameTab ? 1 : 2, `iteration ${iteration}: only winners write`);

    const storedMap = area.data[UI_STATE_MAP_KEY];
    assert.deepEqual(Object.keys(storedMap).sort(), ["1", "2", "3"]);
    for (const [tabId, before] of Object.entries(initial)) {
      const expectedWins = [leftTab, rightTab].filter((candidate, index) =>
        String(candidate) === tabId && results[index].ok
      ).length;
      assert.equal(storedMap[tabId].editorRevision, before.editorRevision + expectedWins);
      const serialized = JSON.stringify(storedMap[tabId]);
      for (const forbidden of ["runId", "stateRevision", "lease", "outbox", "documentInstanceId"]) {
        assert.equal(serialized.includes(forbidden), false);
      }
    }

    const winnerSession = results[0].ok ? left : right;
    const winnerTab = results[0].ok ? leftTab : rightTab;
    const winnerRevision = area.data[UI_STATE_MAP_KEY][winnerTab].editorRevision;
    winnerSession.observeStorageChange({ newValue: {
      ...structuredClone(storedMap),
      [winnerTab]: { ...structuredClone(storedMap[winnerTab]), editorRevision: winnerRevision + 1 }
    } });
    winnerSession.observeStorageChange({ newValue: structuredClone(storedMap) });
    assert.equal(winnerSession.stale, true, `iteration ${iteration}: late event cannot clear stale`);
  }
});

test("Phase 4C deterministic Library torture: 64 same-base races write once and never resurrect deletes", async () => {
  const random = deterministicRandom(0x1a2b3c4d);
  for (let iteration = 0; iteration < 64; iteration += 1) {
    const entries = ["a", "b", "c"].map((id, index) => createFlowLibraryEntry({
      source: `flow ${id}_${iteration} { send \"\"\"${id}\"\"\" }`,
      name: `${id}-${iteration}`
    }, { id, now: index + 1 }));
    const area = storageArea({
      [FLOW_LIBRARY_STORAGE_KEY]: { schemaVersion: 1, revision: 0, entries }
    });
    const locks = serialLocks();
    const deleteFirst = random() < 0.5;
    const first = deleteFirst
      ? (latest) => deleteFlowLibraryEntry(latest, "a")
      : (latest) => {
          const fresh = latest.entries.find((entry) => entry.id === "a");
          return upsertFlowLibraryEntry(latest, updateFlowLibraryEntry(fresh, { name: `winner-${iteration}` }, { now: 10 }));
        };
    const second = (latest) => {
      const fresh = latest.entries.find((entry) => entry.id === "a");
      return upsertFlowLibraryEntry(latest, updateFlowLibraryEntry(fresh, { name: `loser-${iteration}` }, { now: 11 }));
    };

    const results = await Promise.allSettled([
      mutateFlowLibrary(first, { storageArea: area, lockManager: locks, expectedRevision: 0 }),
      mutateFlowLibrary(second, { storageArea: area, lockManager: locks, expectedRevision: 0 })
    ]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    assert.equal(results[1].reason.code, "STALE_FLOW_LIBRARY_REVISION");
    assert.equal(area.sets, 1);
    const library = await loadFlowLibrary(area);
    assert.equal(library.revision, 1);
    assert.equal(new Set(library.entries.map((entry) => entry.id)).size, library.entries.length);
    if (deleteFirst) assert.equal(library.entries.some((entry) => entry.id === "a"), false);
    else assert.equal(library.entries.find((entry) => entry.id === "a").name, `winner-${iteration}`);
    assert.equal(JSON.stringify(library).includes("stateRevision"), false);
  }
});
