import assert from "node:assert/strict";
import test from "node:test";

import {
  UI_STATE_ERROR_CODES,
  UI_STATE_MAP_KEY,
  mutateUiStateForTab,
  readUiStateForTab
} from "../src/ui-state-store.js";
import {
  WorkspaceEditorSession,
  createWorkspaceEditorState,
  workspaceEditorTabIds
} from "../src/workspace-editor-state.js";

function editorEntry(label, revision = 0) {
  return {
    mode: "flow",
    keepAwake: false,
    recovery: { mode: "safe", identityAttempts: 3, readiness: "normal", statusRecovery: "normal" },
    quick: { preset: "improve", prompt: `${label} quick`, repeat: "3", delay: "1.5" },
    workflow: {
      schemaVersion: 1,
      id: `${label}-workflow`,
      name: `${label} workflow`,
      maxSends: 1,
      recovery: { mode: "safe" },
      steps: [{ id: `${label}-step`, type: "prompt", delivery: "send", prompt: `${label} prompt`, repeat: 1, delayAfterMs: 0 }]
    },
    flow: {
      text: `flow ${label} { send "${label}" }`,
      selectedIndex: 0,
      openedLibraryId: null,
      execution: { mode: "full", start: "1", end: "1", repeat: "1", checkpointId: "" }
    },
    editorRevision: revision,
    updatedAt: 1
  };
}

function fakeArea(seed = {}, { failGet = false, failSet = false } = {}) {
  return {
    data: structuredClone(seed),
    gets: 0,
    sets: 0,
    async get(keys) {
      this.gets += 1;
      if (failGet) throw new Error("get failed");
      if (typeof keys === "string") return { [keys]: structuredClone(this.data[keys]) };
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, structuredClone(this.data[key])]));
      }
      return structuredClone(this.data);
    },
    async set(values) {
      this.sets += 1;
      if (failSet) throw new Error("set failed");
      Object.assign(this.data, structuredClone(values));
    }
  };
}

function serialLocks() {
  let tail = Promise.resolve();
  return {
    requests: 0,
    request(_name, _options, callback) {
      this.requests += 1;
      const operation = tail.then(callback);
      tail = operation.catch(() => {});
      return operation;
    }
  };
}

function sessionFor(area, locks) {
  return new WorkspaceEditorSession({
    read: (tabId) => readUiStateForTab(tabId, { storageArea: area }),
    mutate: (tabId, mutation, options) => mutateUiStateForTab(tabId, mutation, {
      ...options,
      storageArea: area,
      lockManager: locks,
      now: 100
    })
  });
}

function replaceFlow(session, source) {
  const state = session.snapshot();
  state.mode = "flow";
  state.flow.text = source;
  return session.replaceState(state);
}

test("Workspace defaults and round-trip keep exactly the six editor fields", () => {
  const hostile = {
    ...editorEntry("safe", 3),
    runId: "run-authority",
    stateRevision: 99,
    lease: { id: "lease" },
    outbox: { state: "submitted" },
    documentInstanceId: "secret-document-id"
  };
  const state = createWorkspaceEditorState(hostile);
  assert.deepEqual(Object.keys(state).sort(), ["flow", "keepAwake", "mode", "quick", "recovery", "workflow"]);
  assert.equal(state.flow.text, hostile.flow.text);
  assert.equal(state.quick.prompt, hostile.quick.prompt);
  assert.equal(JSON.stringify(state).includes("run-authority"), false);
  assert.equal(JSON.stringify(state).includes("secret-document-id"), false);
});

test("Workspace target discovery uses only exact per-tab editor map keys", () => {
  assert.deepEqual(workspaceEditorTabIds({
    "8": editorEntry("eight"),
    "2": editorEntry("two"),
    "02": editorEntry("invalid"),
    nope: editorEntry("invalid"),
    "-1": editorEntry("invalid")
  }), [2, 8]);
});

test("Side Panel and Workspace reading revision 5: Workspace wins and stale Side Panel writes zero", async () => {
  const area = fakeArea({ [UI_STATE_MAP_KEY]: { "7": editorEntry("base", 5) } });
  const locks = serialLocks();
  const workspace = sessionFor(area, locks);
  const sidePanelRead = await readUiStateForTab(7, { storageArea: area });
  const sidePanelUnsavedDom = createWorkspaceEditorState(sidePanelRead.entry);
  sidePanelUnsavedDom.flow.text = "side-panel unsaved DOM";

  assert.equal((await workspace.open(7)).editorRevision, 5);
  replaceFlow(workspace, "flow workspace { send \"workspace\" }");
  assert.deepEqual(await workspace.save(), {
    ok: true,
    editorRevision: 6,
    dirty: false,
    stale: false,
    conflictedAfterSave: false
  });
  const setsAfterWorkspace = area.sets;

  const error = await mutateUiStateForTab(7, () => sidePanelUnsavedDom, {
    storageArea: area,
    lockManager: locks,
    expectedRevision: sidePanelRead.editorRevision
  }).then(() => null, (thrown) => thrown);
  assert.equal(error.code, UI_STATE_ERROR_CODES.STALE_EDITOR_REVISION);
  assert.equal(area.sets, setsAfterWorkspace, "stale writer must perform zero storage writes");
  assert.equal(area.data[UI_STATE_MAP_KEY]["7"].flow.text, "flow workspace { send \"workspace\" }");
  assert.equal(sidePanelUnsavedDom.flow.text, "side-panel unsaved DOM", "losing surface DOM model is untouched");
});

test("reverse order: Side Panel save makes the Workspace stale without replacing its draft", async () => {
  const area = fakeArea({ [UI_STATE_MAP_KEY]: { "7": editorEntry("base", 5) } });
  const locks = serialLocks();
  const workspace = sessionFor(area, locks);
  await workspace.open(7);
  replaceFlow(workspace, "workspace unsaved source");

  const sidePanelState = editorEntry("side-panel", 5);
  await mutateUiStateForTab(7, () => sidePanelState, {
    storageArea: area,
    lockManager: locks,
    expectedRevision: 5
  });
  const setsAfterSidePanel = area.sets;

  const result = await workspace.save();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "stale");
  assert.equal(area.sets, setsAfterSidePanel);
  assert.equal(workspace.snapshot().flow.text, "workspace unsaved source");
  assert.equal(area.data[UI_STATE_MAP_KEY]["7"].flow.text, sidePanelState.flow.text);
});

test("storage.onChanged marks a stale Workspace, preserves its model, and suppresses the write entirely", async () => {
  const area = fakeArea({ [UI_STATE_MAP_KEY]: { "7": editorEntry("base", 5) } });
  let mutationCalls = 0;
  const workspace = new WorkspaceEditorSession({
    read: (tabId) => readUiStateForTab(tabId, { storageArea: area }),
    mutate: async () => { mutationCalls += 1; }
  });
  await workspace.open(7);
  replaceFlow(workspace, "draft remains visible");
  assert.equal(workspace.observeStorageChange({
    newValue: { "7": editorEntry("other", 6) }
  }), true);
  const before = workspace.snapshot();
  assert.deepEqual(await workspace.save(), { ok: false, reason: "stale" });
  assert.equal(mutationCalls, 0);
  assert.deepEqual(workspace.snapshot(), before);
  assert.equal(workspace.needsDiscardConfirmation, true);
});

test("different-tab writers share the map lock and neither entry is dropped", async () => {
  const area = fakeArea({
    [UI_STATE_MAP_KEY]: {
      "7": editorEntry("seven", 1),
      "9": editorEntry("nine", 4)
    }
  });
  const locks = serialLocks();
  const left = sessionFor(area, locks);
  const right = sessionFor(area, locks);
  await Promise.all([left.open(7), right.open(9)]);
  replaceFlow(left, "left saved");
  replaceFlow(right, "right saved");
  const results = await Promise.all([left.save(), right.save()]);
  assert.ok(results.every((result) => result.ok));
  assert.equal(area.data[UI_STATE_MAP_KEY]["7"].flow.text, "left saved");
  assert.equal(area.data[UI_STATE_MAP_KEY]["9"].flow.text, "right saved");
  assert.equal(area.data[UI_STATE_MAP_KEY]["7"].editorRevision, 2);
  assert.equal(area.data[UI_STATE_MAP_KEY]["9"].editorRevision, 5);
});

test("reload and reopen adopt the saved revision and state", async () => {
  const area = fakeArea({ [UI_STATE_MAP_KEY]: { "3": editorEntry("base", 2) } });
  const locks = serialLocks();
  const first = sessionFor(area, locks);
  await first.open(3);
  replaceFlow(first, "persist across reload");
  await first.save();

  const reopened = sessionFor(area, locks);
  const result = await reopened.open(3);
  assert.equal(result.editorRevision, 3);
  assert.equal(reopened.snapshot().flow.text, "persist across reload");
  assert.equal(reopened.dirty, false);
});

test("read, write, and lock failures fail closed and retain the editor draft", async () => {
  const readArea = fakeArea({}, { failGet: true });
  const readFailure = await sessionFor(readArea, serialLocks()).open(1);
  assert.equal(readFailure.ok, false);
  assert.equal(readFailure.reason, "read");

  for (const [area, locks, reason] of [
    [fakeArea({ [UI_STATE_MAP_KEY]: { "1": editorEntry("base", 1) } }, { failSet: true }), serialLocks(), "write"],
    [fakeArea({ [UI_STATE_MAP_KEY]: { "1": editorEntry("base", 1) } }), {}, "lock"]
  ]) {
    const workspace = sessionFor(area, locks);
    await workspace.open(1);
    replaceFlow(workspace, `${reason} draft`);
    const before = workspace.snapshot();
    const result = await workspace.save();
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    assert.deepEqual(workspace.snapshot(), before);
    assert.equal(workspace.dirty, true);
  }
});

test("a second save request shares the one in-flight CAS and never retries", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const base = editorEntry("base", 1);
  const workspace = new WorkspaceEditorSession({
    read: async () => ({ entry: base, editorRevision: 1, exists: true, legacy: false }),
    mutate: async (_tabId, mutation) => {
      calls += 1;
      await gate;
      return { entry: await mutation(base), editorRevision: 2, updatedAt: 2 };
    }
  });
  await workspace.open(1);
  replaceFlow(workspace, "first snapshot");
  const first = workspace.save();
  const second = workspace.save();
  replaceFlow(workspace, "typed while saving");
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.equal(a.ok, true);
  assert.equal(a.dirty, true);
  assert.equal(workspace.snapshot().flow.text, "typed while saving");
  assert.equal(workspace.editorRevision, 2);
});

test("a late external revision observed during save is not cleared by the older save completion", async () => {
  const base = editorEntry("base", 1);
  let workspace;
  workspace = new WorkspaceEditorSession({
    read: async () => ({ entry: base, editorRevision: 1, exists: true, legacy: false }),
    mutate: async (_tabId, mutation) => {
      await mutation(base);
      workspace.observeStorageChange({ newValue: { "1": editorEntry("external", 3) } });
      return { entry: base, editorRevision: 2, updatedAt: 2 };
    }
  });
  await workspace.open(1);
  replaceFlow(workspace, "workspace save");
  const result = await workspace.save();
  assert.equal(result.ok, true, "the revision-2 CAS itself completed");
  assert.equal(result.stale, true, "the bounded save result must disclose the post-save conflict");
  assert.equal(result.conflictedAfterSave, true);
  assert.equal(workspace.editorRevision, 2);
  assert.equal(workspace.stale, true, "the observed revision 3 must remain a conflict");
  assert.deepEqual(await workspace.save(), { ok: false, reason: "stale" });
});

test("out-of-order and old self-echo revisions never clear or create Workspace authority", async () => {
  const base = editorEntry("base", 7);
  const workspace = new WorkspaceEditorSession({
    read: async () => ({ entry: base, editorRevision: 7, exists: true, legacy: false }),
    mutate: async () => { throw new Error("stale session must not mutate"); }
  });
  await workspace.open(1);
  replaceFlow(workspace, "local draft");
  assert.equal(workspace.observeStorageChange({ newValue: { "1": editorEntry("external", 8) } }), true);
  assert.equal(workspace.stale, true);
  assert.equal(workspace.observeStorageChange({ newValue: { "1": editorEntry("late-equal", 7) } }), false);
  assert.equal(workspace.observeStorageChange({ newValue: { "1": editorEntry("late-old", 6) } }), false);
  assert.equal(workspace.stale, true, "late events can never restore a stale session");
  assert.deepEqual(await workspace.save(), { ok: false, reason: "stale" });
  assert.equal(workspace.snapshot().flow.text, "local draft");
});

test("reopening a stale Workspace adopts only the latest stored revision without merging its draft", async () => {
  const area = fakeArea({ [UI_STATE_MAP_KEY]: { "3": editorEntry("base", 5) } });
  const locks = serialLocks();
  const stale = sessionFor(area, locks);
  await stale.open(3);
  replaceFlow(stale, "unsaved stale draft");

  area.data[UI_STATE_MAP_KEY]["3"] = editorEntry("external", 6);
  stale.observeStorageChange({ newValue: structuredClone(area.data[UI_STATE_MAP_KEY]) });
  const reopened = sessionFor(area, locks);
  const result = await reopened.open(3);

  assert.equal(result.editorRevision, 6);
  assert.equal(reopened.snapshot().flow.text, editorEntry("external", 6).flow.text);
  assert.notEqual(reopened.snapshot().flow.text, "unsaved stale draft");
  assert.equal(reopened.stale, false);
  assert.equal(reopened.dirty, false);
});

test("a target read that settles after a local edit cannot replace the current draft", async () => {
  let releaseRead;
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  const workspace = new WorkspaceEditorSession({
    read: async (tabId) => {
      if (tabId === 2) await readGate;
      return {
        entry: editorEntry(tabId === 1 ? "one" : "two", tabId),
        editorRevision: tabId,
        exists: true,
        legacy: false
      };
    },
    mutate: async () => {
      throw new Error("save is not part of this test");
    }
  });

  assert.equal((await workspace.open(1)).ok, true);
  const pendingOpen = workspace.open(2);
  replaceFlow(workspace, "typed while tab 2 was loading");
  releaseRead();

  assert.deepEqual(await pendingOpen, { ok: false, reason: "changed" });
  assert.equal(workspace.tabId, 1);
  assert.equal(workspace.editorRevision, 1);
  assert.equal(workspace.snapshot().flow.text, "typed while tab 2 was loading");
  assert.equal(workspace.dirty, true);
});
