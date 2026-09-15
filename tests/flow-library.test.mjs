import assert from "node:assert/strict";
import test from "node:test";

import {
  FLOW_LIBRARY_SCHEMA_VERSION,
  FLOW_LIBRARY_STORAGE_KEY,
  canUpdateOpenedFlowLibraryEntry,
  createFlowLibraryEntry,
  deleteFlowLibraryEntry,
  duplicateFlowLibraryEntry,
  exportFlowText,
  isOpenedFlowLibraryDirty,
  loadFlowLibrary,
  markFlowLibraryOpened,
  mutateFlowLibrary,
  normalizeFlowLibrary,
  persistFlowLibrary,
  resolveOpenedFlowLibraryId,
  searchFlowLibrary,
  updateFlowLibraryEntry,
  upsertFlowLibraryEntry,
  validateImportedFlowText
} from "../src/flow-library.js";

const SOURCE = 'flow saved { send """日本語""" }';

test("Library stores only source and bounded display metadata, never runtime authority", () => {
  const entry = createFlowLibraryEntry({
    name: "Release review",
    description: "local only",
    source: SOURCE,
    favorite: true,
    workflow: { dangerous: true },
    run: { runId: "forbidden" },
    outbox: { state: "submitted" },
    lease: { nonce: "forbidden" },
    documentIdentity: "forbidden"
  }, { id: "entry-1", now: 100 });

  assert.deepEqual(Object.keys(entry).sort(), [
    "createdAt", "description", "favorite", "id", "lastOpenedAt", "name", "source", "updatedAt"
  ]);
  assert.equal(entry.source, SOURCE);
  assert.equal("workflow" in entry, false);
});

test("Save, update, rename, favorite, open, duplicate and delete are deterministic", () => {
  const first = createFlowLibraryEntry({ source: SOURCE, name: "First" }, { id: "entry-1", now: 100 });
  let library = upsertFlowLibraryEntry(null, first);
  const updated = updateFlowLibraryEntry(first, { name: "Renamed", description: "Description", favorite: true }, { now: 200 });
  library = upsertFlowLibraryEntry(library, markFlowLibraryOpened(updated, 300));
  const duplicate = duplicateFlowLibraryEntry(updated, { id: "entry-2", now: 400 });
  library = upsertFlowLibraryEntry(library, duplicate);

  assert.deepEqual(searchFlowLibrary(library).map((entry) => entry.id), ["entry-1", "entry-2"]);
  assert.equal(library.entries.find((entry) => entry.id === "entry-1").name, "Renamed");
  assert.equal(duplicate.name, "Renamed のコピー");

  library = deleteFlowLibraryEntry(library, "entry-1");
  assert.deepEqual(library.entries.map((entry) => entry.id), ["entry-2"]);
});

test("Search covers name and description while favorites and recent opens sort first", () => {
  const a = { ...createFlowLibraryEntry({ source: SOURCE, name: "Alpha", description: "release" }, { id: "a", now: 1 }), lastOpenedAt: 10 };
  const b = { ...createFlowLibraryEntry({ source: SOURCE, name: "Beta", description: "review" }, { id: "b", now: 2 }), favorite: true };
  const c = { ...createFlowLibraryEntry({ source: SOURCE, name: "Gamma", description: "release" }, { id: "c", now: 3 }), lastOpenedAt: 20 };
  const library = [a, b, c].reduce(upsertFlowLibraryEntry, null);

  assert.deepEqual(searchFlowLibrary(library).map((entry) => entry.id), ["b", "c", "a"]);
  assert.deepEqual(searchFlowLibrary(library, "release").map((entry) => entry.id), ["c", "a"]);
  assert.deepEqual(searchFlowLibrary(library, "BETA").map((entry) => entry.id), ["b"]);
});

test("selected and opened Library identities stay distinct and gate Update", () => {
  const sourceA = 'flow alpha { send """A""" }';
  const sourceB = 'flow beta { send """B""" }';
  const entryA = createFlowLibraryEntry({ source: sourceA, name: "A" }, { id: "a", now: 1 });
  const entryB = createFlowLibraryEntry({ source: sourceB, name: "B" }, { id: "b", now: 2 });
  const library = [entryA, entryB].reduce(upsertFlowLibraryEntry, null);

  assert.equal(resolveOpenedFlowLibraryId(library, "a"), "a");
  assert.equal(resolveOpenedFlowLibraryId(library, "deleted"), null);
  assert.equal(canUpdateOpenedFlowLibraryEntry(library, "a", "a"), true);
  assert.equal(canUpdateOpenedFlowLibraryEntry(library, "b", "a"), false);
  assert.equal(isOpenedFlowLibraryDirty(library, "a", sourceA), false);
  assert.equal(isOpenedFlowLibraryDirty(library, "a", `${sourceA}\n# edited`), true);
  assert.equal(isOpenedFlowLibraryDirty(library, null, sourceA), false);
});

test("an A editor source cannot be mixed with selected B metadata during Update", () => {
  const sourceA = 'flow alpha { send """A""" }';
  const sourceB = 'flow beta { send """B""" }';
  const entryA = createFlowLibraryEntry({ source: sourceA, name: "A" }, { id: "a", now: 1 });
  const entryB = createFlowLibraryEntry({ source: sourceB, name: "B" }, { id: "b", now: 2 });
  let library = [entryA, entryB].reduce(upsertFlowLibraryEntry, null);
  const openedId = "a";
  const editorSource = `${sourceA}\n# edited`;

  assert.equal(canUpdateOpenedFlowLibraryEntry(library, "b", openedId), false);
  assert.equal(library.entries.find((entry) => entry.id === "b").source, sourceB);

  assert.equal(canUpdateOpenedFlowLibraryEntry(library, "a", openedId), true);
  const freshA = library.entries.find((entry) => entry.id === "a");
  library = upsertFlowLibraryEntry(
    library,
    updateFlowLibraryEntry(freshA, { name: "A edited", source: editorSource }, { now: 3 })
  );
  assert.equal(library.entries.find((entry) => entry.id === "a").source, editorSource);
  assert.equal(library.entries.find((entry) => entry.id === "a").name, "A edited");
  assert.equal(library.entries.find((entry) => entry.id === "b").source, sourceB);
  assert.equal(library.entries.find((entry) => entry.id === "b").name, "B");
});

test("Import validates with the latest compiler and never starts a Run", () => {
  assert.equal(validateImportedFlowText(SOURCE), SOURCE);
  assert.throws(() => validateImportedFlowText("not a flow"), /flow/iu);
  assert.equal(exportFlowText(createFlowLibraryEntry({ source: SOURCE }, { id: "x", now: 1 })), SOURCE);
});

test("stale or malicious stored fields are allowlisted and cannot become execution state", () => {
  const library = normalizeFlowLibrary({
    schemaVersion: FLOW_LIBRARY_SCHEMA_VERSION,
    entries: [{
      id: "stale",
      name: "Stale",
      source: "old unsupported syntax",
      run: { status: "running" },
      workflow: { steps: [{ type: "prompt" }] },
      activeRun: true
    }]
  });
  assert.equal(library.entries.length, 1);
  assert.deepEqual(Object.keys(library.entries[0]).sort(), [
    "createdAt", "description", "favorite", "id", "lastOpenedAt", "name", "source", "updatedAt"
  ]);
  assert.throws(() => validateImportedFlowText(library.entries[0].source));
});

test("storage wrapper is local-only and round-trips the normalized schema", async () => {
  const map = new Map();
  const storage = {
    async get(key) { return map.has(key) ? { [key]: map.get(key) } : {}; },
    async set(entries) { for (const [key, value] of Object.entries(entries)) map.set(key, value); }
  };
  const entry = createFlowLibraryEntry({ source: SOURCE }, { id: "stored", now: 1 });
  const saved = await persistFlowLibrary(upsertFlowLibraryEntry(null, entry), storage);
  const loaded = await loadFlowLibrary(storage);
  assert.deepEqual(loaded, saved);
  assert.equal(map.has(FLOW_LIBRARY_STORAGE_KEY), true);
});

test("two Side Panels serialize fresh-read mutations so stale metadata cannot resurrect a delete", async () => {
  const map = new Map();
  const storage = {
    async get(key) { return map.has(key) ? { [key]: structuredClone(map.get(key)) } : {}; },
    async set(entries) {
      for (const [key, value] of Object.entries(entries)) map.set(key, structuredClone(value));
    }
  };
  let lockTail = Promise.resolve();
  const lockManager = {
    request(_name, _options, callback) {
      const operation = lockTail.then(callback);
      lockTail = operation.catch(() => {});
      return operation;
    }
  };
  const deleted = createFlowLibraryEntry({ source: SOURCE, name: "Delete me" }, { id: "deleted", now: 1 });
  const retained = createFlowLibraryEntry({ source: SOURCE, name: "Retained" }, { id: "retained", now: 2 });
  await persistFlowLibrary([deleted, retained].reduce(upsertFlowLibraryEntry, null), storage);

  let releaseDelete;
  const deleteGate = new Promise((resolve) => { releaseDelete = resolve; });
  let deleteEntered;
  const deleteStarted = new Promise((resolve) => { deleteEntered = resolve; });
  const panelADelete = mutateFlowLibrary(async (latest) => {
    deleteEntered();
    await deleteGate;
    return deleteFlowLibraryEntry(latest, "deleted");
  }, { storageArea: storage, lockManager });
  await deleteStarted;

  const panelBStaleFavorite = mutateFlowLibrary((latest) => {
    const fresh = latest.entries.find((entry) => entry.id === "retained");
    assert.ok(fresh);
    return upsertFlowLibraryEntry(latest, updateFlowLibraryEntry(fresh, { favorite: true }, { now: 3 }));
  }, { storageArea: storage, lockManager });
  releaseDelete();
  await Promise.all([panelADelete, panelBStaleFavorite]);

  const finalLibrary = await loadFlowLibrary(storage);
  assert.deepEqual(finalLibrary.entries.map((entry) => entry.id), ["retained"]);
  assert.equal(finalLibrary.entries[0].favorite, true);
  assert.equal(finalLibrary.revision, 2);
  assert.equal(finalLibrary.entries.some((entry) => entry.id === "deleted"), false);
});

test("Phase 4C RED: same-base Library writers cannot silently overwrite the first winner", async () => {
  const map = new Map();
  let writes = 0;
  const storage = {
    async get(key) { return map.has(key) ? { [key]: structuredClone(map.get(key)) } : {}; },
    async set(entries) {
      writes += 1;
      for (const [key, value] of Object.entries(entries)) map.set(key, structuredClone(value));
    }
  };
  let tail = Promise.resolve();
  const locks = {
    request(_name, _options, callback) {
      const operation = tail.then(callback);
      tail = operation.catch(() => {});
      return operation;
    }
  };
  const original = createFlowLibraryEntry({ source: SOURCE, name: "Original" }, { id: "same", now: 1 });
  await persistFlowLibrary(upsertFlowLibraryEntry(null, original), storage);
  writes = 0;
  const baseRevision = (await loadFlowLibrary(storage)).revision;

  const update = (name) => mutateFlowLibrary((latest) => {
    const fresh = latest.entries.find((entry) => entry.id === "same");
    return upsertFlowLibraryEntry(latest, updateFlowLibraryEntry(fresh, { name }, { now: 2 }));
  }, { storageArea: storage, lockManager: locks, expectedRevision: baseRevision });

  const results = await Promise.allSettled([update("Workspace won"), update("Side Panel lost")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const loser = results.find((result) => result.status === "rejected");
  assert.equal(loser?.reason?.code, "STALE_FLOW_LIBRARY_REVISION");
  assert.equal(writes, 1, "only the winner may touch storage");
  const finalLibrary = await loadFlowLibrary(storage);
  assert.equal(finalLibrary.entries[0].name, "Workspace won");
  assert.equal(finalLibrary.revision, baseRevision + 1);
});

test("Phase 4C L: delete winning against a same-base update cannot resurrect the entry", async () => {
  const map = new Map();
  let writes = 0;
  const storage = {
    async get(key) { return map.has(key) ? { [key]: structuredClone(map.get(key)) } : {}; },
    async set(entries) {
      writes += 1;
      for (const [key, value] of Object.entries(entries)) map.set(key, structuredClone(value));
    }
  };
  let tail = Promise.resolve();
  const locks = {
    request(_name, _options, callback) {
      const operation = tail.then(callback);
      tail = operation.catch(() => {});
      return operation;
    }
  };
  const doomed = createFlowLibraryEntry({ source: SOURCE, name: "Doomed" }, { id: "doomed", now: 1 });
  await persistFlowLibrary(upsertFlowLibraryEntry(null, doomed), storage);
  writes = 0;
  const revision = (await loadFlowLibrary(storage)).revision;

  const deletion = mutateFlowLibrary(
    (latest) => deleteFlowLibraryEntry(latest, doomed.id),
    { storageArea: storage, lockManager: locks, expectedRevision: revision }
  );
  const staleUpdate = mutateFlowLibrary((latest) => {
    const fresh = latest.entries.find((entry) => entry.id === doomed.id);
    return upsertFlowLibraryEntry(latest, updateFlowLibraryEntry(fresh, { name: "Resurrected" }, { now: 2 }));
  }, { storageArea: storage, lockManager: locks, expectedRevision: revision });

  const [deleted, updated] = await Promise.allSettled([deletion, staleUpdate]);
  assert.equal(deleted.status, "fulfilled");
  assert.equal(updated.status, "rejected");
  assert.equal(updated.reason.code, "STALE_FLOW_LIBRARY_REVISION");
  assert.equal(writes, 1);
  const finalLibrary = await loadFlowLibrary(storage);
  assert.equal(finalLibrary.entries.some((entry) => entry.id === doomed.id), false);
});

test("Library mutation fails closed when cross-panel locking is unavailable", async () => {
  let writes = 0;
  const storage = {
    async get() { return {}; },
    async set() { writes += 1; }
  };
  await assert.rejects(
    mutateFlowLibrary((latest) => latest, { storageArea: storage, lockManager: null }),
    /排他保存/
  );
  assert.equal(writes, 0);
});
