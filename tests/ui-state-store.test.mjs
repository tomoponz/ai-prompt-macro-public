/*
  Phase 4A — editor state fence.

  The property under test is blunt: a write whose expected revision does not
  match the stored one must change nothing at all. Not "merge", not "newest
  wins", not "write and warn" — zero storage writes. Everything else here exists
  to make sure that guarantee cannot be sidestepped by a malformed entry, a
  missing lock, a legacy installation or a sibling tab.
*/
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  EDITOR_STATE_FIELDS,
  LEGACY_UI_STATE_KEY,
  UI_STATE_ERROR_CODES,
  UI_STATE_LOCK_NAME,
  UI_STATE_MAP_KEY,
  UiStateError,
  mutateUiStateForTab,
  normalizeEditorRevision,
  normalizeUiStateEntry,
  normalizeUiStateMap,
  observedEditorRevision,
  readUiStateForTab,
  uiStateTabKey
} from "../src/ui-state-store.js";

const source = fs.readFileSync(new URL("../src/ui-state-store.js", import.meta.url), "utf8");
/* The header comment names the Run-authority concepts this module must stay out
   of, so scans for those names have to run against code only. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ENTRY = Object.freeze({
  mode: "flow",
  keepAwake: true,
  recovery: { status: "normal" },
  quick: { preset: "p", prompt: "hello", repeat: "3", delay: "1.5" },
  workflow: { schemaVersion: 1, steps: [] },
  flow: { text: "flow a { }", selectedIndex: 0, openedLibraryId: null, execution: { mode: "full" } }
});

function fakeArea(seed = {}, { failGet = false, failSet = false } = {}) {
  const store = structuredClone(seed);
  const area = {
    sets: 0,
    gets: 0,
    data: store,
    async get(key) {
      area.gets += 1;
      if (failGet) throw new Error("boom");
      const read = (item) => (Object.hasOwn(store, item) ? structuredClone(store[item]) : undefined);
      if (typeof key === "string") return { [key]: read(key) };
      if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, read(item)]));
      return structuredClone(store);
    },
    async set(values) {
      area.sets += 1;
      if (failSet) throw new Error("boom");
      Object.assign(store, structuredClone(values));
    }
  };
  return area;
}

/* A real-enough Web Lock: exclusive, FIFO, and it actually serializes. */
function fakeLocks() {
  const chain = new Map();
  return {
    held: [],
    request(name, options, callback) {
      this.held.push({ name, mode: options?.mode });
      const previous = chain.get(name) ?? Promise.resolve();
      const run = previous.catch(() => {}).then(() => callback());
      chain.set(name, run.catch(() => {}));
      return run;
    }
  };
}

const mapOf = (entries) => ({ [UI_STATE_MAP_KEY]: entries });
const save = (area, locks, tabId, payload, expectedRevision, now = 1_000) =>
  mutateUiStateForTab(tabId, () => payload, { storageArea: area, lockManager: locks, expectedRevision, now });

/* ------------------------------------------------------------------ reading */

test("1. a missing map reads as no entry at revision 0", async () => {
  const read = await readUiStateForTab(7, { storageArea: fakeArea() });
  assert.deepEqual(read, { entry: null, editorRevision: 0, updatedAt: 0, exists: false, legacy: false });
});

test("2. a map without this tab reads as no entry at revision 0", async () => {
  const area = fakeArea(mapOf({ 9: { ...ENTRY, editorRevision: 12 } }));
  const read = await readUiStateForTab(7, { storageArea: area });
  assert.equal(read.entry, null);
  assert.equal(read.editorRevision, 0);
  assert.equal(read.exists, false);
});

test("3. a legacy entry with no revision reads as revision 0 and is not treated as existing", async () => {
  const area = fakeArea({ [LEGACY_UI_STATE_KEY]: { mode: "quick", quick: { prompt: "legacy" } } });
  const read = await readUiStateForTab(7, { storageArea: area });
  assert.equal(read.legacy, true);
  assert.equal(read.exists, false);
  assert.equal(read.editorRevision, 0);
  assert.equal(read.entry.quick.prompt, "legacy");
  /* Lazy migration: the first save stamps revision 1 into the v2 map and the
     legacy key is left alone rather than bulk rewritten. */
  const locks = fakeLocks();
  const result = await save(area, locks, 7, ENTRY, 0);
  assert.equal(result.editorRevision, 1);
  assert.deepEqual(area.data[LEGACY_UI_STATE_KEY], { mode: "quick", quick: { prompt: "legacy" } });
});

test("4. a malformed map is read as empty rather than trusted", async () => {
  for (const malformed of [null, "map", 42, [], [{ mode: "quick" }], true]) {
    assert.deepEqual(normalizeUiStateMap(malformed), {});
    const read = await readUiStateForTab(7, { storageArea: fakeArea(mapOf(malformed)) });
    assert.equal(read.entry, null);
    assert.equal(read.editorRevision, 0);
  }
  /* Keys that are not exact non-negative integers are not tab ids. */
  assert.deepEqual(normalizeUiStateMap({ "-1": ENTRY, "7.5": ENTRY, " 7": ENTRY, "07": ENTRY, x: ENTRY }), {});
});

test("5. a malformed revision degrades to 0 instead of throwing or overflowing", () => {
  for (const bad of [undefined, null, "5", -1, 1.5, Number.NaN, Infinity, -0.1, Number.MAX_SAFE_INTEGER + 2, {}, []]) {
    assert.equal(normalizeEditorRevision(bad), 0, `${String(bad)} must normalize to 0`);
  }
  assert.equal(normalizeEditorRevision(0), 0);
  assert.equal(normalizeEditorRevision(41), 41);
  assert.equal(normalizeUiStateEntry({ ...ENTRY, editorRevision: "nope" }).editorRevision, 0);
});

test("6. a valid entry round-trips with its revision and timestamp", async () => {
  const stored = { ...ENTRY, editorRevision: 5, updatedAt: 1_700 };
  const read = await readUiStateForTab(7, { storageArea: fakeArea(mapOf({ 7: stored })) });
  assert.equal(read.exists, true);
  assert.equal(read.editorRevision, 5);
  assert.equal(read.updatedAt, 1_700);
  assert.equal(read.entry.flow.text, ENTRY.flow.text);
  assert.equal(read.entry.mode, "flow");
});

/* ------------------------------------------------------- compare-and-set */

test("7. a matching expected revision advances the entry by exactly one", async () => {
  const area = fakeArea(mapOf({ 7: { ...ENTRY, editorRevision: 5 } }));
  const result = await save(area, fakeLocks(), 7, { ...ENTRY, mode: "quick" }, 5);
  assert.equal(result.editorRevision, 6);
  assert.equal(area.data[UI_STATE_MAP_KEY]["7"].editorRevision, 6);
  assert.equal(area.data[UI_STATE_MAP_KEY]["7"].mode, "quick");
});

test("8. a stale expected revision is refused with a bounded code", async () => {
  const area = fakeArea(mapOf({ 7: { ...ENTRY, editorRevision: 6 } }));
  const error = await save(area, fakeLocks(), 7, ENTRY, 5).then(() => null, (thrown) => thrown);
  assert.ok(error instanceof UiStateError);
  assert.equal(error.code, UI_STATE_ERROR_CODES.STALE_EDITOR_REVISION);
  assert.equal(error.expectedRevision, 5);
  assert.equal(error.observedRevision, 6);
  /* The message is for a person and carries no storage contents. */
  assert.equal(/flow a \{/.test(error.message), false);
});

test("9. a refused write performs zero storage writes and leaves the entry byte-identical", async () => {
  const stored = { ...ENTRY, editorRevision: 6, updatedAt: 42, flow: { text: "THEIRS" } };
  const area = fakeArea(mapOf({ 7: stored }));
  await save(area, fakeLocks(), 7, { ...ENTRY, flow: { text: "MINE" } }, 5).catch(() => {});
  assert.equal(area.sets, 0, "a stale write must not reach storage at all");
  assert.deepEqual(area.data[UI_STATE_MAP_KEY]["7"], stored);
});

test("10. a successful write stamps updatedAt from the injected clock", async () => {
  const area = fakeArea(mapOf({ 7: { ...ENTRY, editorRevision: 1, updatedAt: 5 } }));
  const result = await save(area, fakeLocks(), 7, ENTRY, 1, 1_787_000_000_000);
  assert.equal(result.updatedAt, 1_787_000_000_000);
  assert.equal(area.data[UI_STATE_MAP_KEY]["7"].updatedAt, 1_787_000_000_000);
});

test("11-12. only the target entry changes and every sibling survives verbatim", async () => {
  const siblings = {
    7: { ...ENTRY, editorRevision: 2 },
    9: { ...ENTRY, editorRevision: 40, flow: { text: "TAB NINE" } },
    /* A sibling this module cannot parse is still not this write's business. */
    11: "corrupted-but-not-mine",
    13: null
  };
  const area = fakeArea(mapOf(siblings));
  await save(area, fakeLocks(), 7, { ...ENTRY, mode: "workflow" }, 2);
  const written = area.data[UI_STATE_MAP_KEY];
  assert.equal(written["7"].mode, "workflow");
  assert.equal(written["7"].editorRevision, 3);
  assert.deepEqual(written["9"], siblings[9]);
  assert.equal(written["11"], "corrupted-but-not-mine");
  assert.equal(written["13"], null);
});

test("13. concurrent writers are serialized by the lock, so the loser goes stale", async () => {
  const area = fakeArea(mapOf({ 7: { ...ENTRY, editorRevision: 5 } }));
  const locks = fakeLocks();
  /* Both read revision 5 before either wrote — the multi-surface case. */
  const [first, second] = await Promise.allSettled([
    save(area, locks, 7, { ...ENTRY, flow: { text: "A" } }, 5),
    save(area, locks, 7, { ...ENTRY, flow: { text: "B" } }, 5)
  ]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  assert.equal(second.reason.code, UI_STATE_ERROR_CODES.STALE_EDITOR_REVISION);
  assert.equal(area.data[UI_STATE_MAP_KEY]["7"].flow.text, "A", "the winner's content must survive intact");
  assert.equal(area.data[UI_STATE_MAP_KEY]["7"].editorRevision, 6);
  assert.equal(area.sets, 1);
  assert.ok(locks.held.every((held) => held.name === UI_STATE_LOCK_NAME && held.mode === "exclusive"));
});

test("14. a missing lock manager fails closed instead of writing hopefully", async () => {
  const area = fakeArea(mapOf({ 7: { ...ENTRY, editorRevision: 5 } }));
  /* A present but unusable manager. A nullish argument deliberately falls back
     to navigator.locks, which is the production path. */
  for (const broken of [{}, { request: "no" }, { request: null }]) {
    const error = await mutateUiStateForTab(7, () => ENTRY, {
      storageArea: area, lockManager: broken, expectedRevision: 5
    }).then(() => null, (thrown) => thrown);
    assert.equal(error.code, UI_STATE_ERROR_CODES.UI_STATE_LOCK_UNAVAILABLE);
  }
  assert.equal(area.sets, 0);
});

test("15. a failing storage read reports a bounded code and writes nothing", async () => {
  const area = fakeArea(mapOf({ 7: ENTRY }), { failGet: true });
  const readError = await readUiStateForTab(7, { storageArea: area }).then(() => null, (thrown) => thrown);
  assert.equal(readError.code, UI_STATE_ERROR_CODES.UI_STATE_READ_FAILED);
  const writeError = await save(area, fakeLocks(), 7, ENTRY, 0).then(() => null, (thrown) => thrown);
  assert.equal(writeError.code, UI_STATE_ERROR_CODES.UI_STATE_READ_FAILED);
  assert.equal(area.sets, 0);
});

test("16. a failing storage write reports a bounded code", async () => {
  const area = fakeArea(mapOf({ 7: { ...ENTRY, editorRevision: 3 } }), { failSet: true });
  const error = await save(area, fakeLocks(), 7, ENTRY, 3).then(() => null, (thrown) => thrown);
  assert.equal(error.code, UI_STATE_ERROR_CODES.UI_STATE_WRITE_FAILED);
});

/* ---------------------------------------------------------- normalization */

test("17. unknown top-level fields are dropped while editor payloads pass through whole", async () => {
  const entry = normalizeUiStateEntry({
    ...ENTRY,
    somethingNew: "dropped",
    surface: "workspace"
  });
  assert.deepEqual(
    Object.keys(entry).sort(),
    [...EDITOR_STATE_FIELDS, "editorRevision", "updatedAt"].sort()
  );
  /* Editor payloads are opaque here: workflow and recovery keep their exact
     shape because their own normalizers own them. */
  assert.deepEqual(entry.workflow, ENTRY.workflow);
  assert.deepEqual(entry.flow, ENTRY.flow);
  assert.deepEqual(entry.recovery, ENTRY.recovery);

  const area = fakeArea();
  await save(area, fakeLocks(), 7, { ...ENTRY, surface: "workspace", extra: 1 }, 0);
  const written = area.data[UI_STATE_MAP_KEY]["7"];
  assert.equal(Object.hasOwn(written, "surface"), false);
  assert.equal(Object.hasOwn(written, "extra"), false);
});

test("18. Run authority fields cannot enter an editor entry", async () => {
  const hostile = {
    ...ENTRY,
    runId: "run-1",
    stateRevision: 99,
    executionSessionId: "session-1",
    documentInstanceId: "doc-1",
    leaseId: "lease-1",
    outbox: { state: "submitted", promptHash: "abc" },
    assistantText: "answer body",
    conversationKey: "chatgpt:c:abcdef"
  };
  const area = fakeArea();
  await save(area, fakeLocks(), 7, hostile, 0);
  const written = JSON.stringify(area.data[UI_STATE_MAP_KEY]["7"]);
  for (const forbidden of [
    "runId", "stateRevision", "executionSessionId", "documentInstanceId",
    "leaseId", "outbox", "promptHash", "assistantText", "answer body", "conversationKey", "chatgpt:c:"
  ]) {
    assert.equal(written.includes(forbidden), false, `${forbidden} must not survive normalization`);
  }
});

/* --------------------------------------------------------- guard rails */

test("an unread caller cannot write: expectedRevision is mandatory and bounded", async () => {
  const area = fakeArea(mapOf({ 7: { ...ENTRY, editorRevision: 5 } }));
  for (const bad of [undefined, null, "5", -1, 1.5, Number.NaN, {}]) {
    const error = await mutateUiStateForTab(7, () => ENTRY, {
      storageArea: area, lockManager: fakeLocks(), expectedRevision: bad
    }).then(() => null, (thrown) => thrown);
    assert.equal(error.code, UI_STATE_ERROR_CODES.UI_STATE_INVALID, `${String(bad)} must be refused`);
  }
  assert.equal(area.sets, 0);
});

test("a non-tab id and a non-object payload are refused", async () => {
  for (const bad of [null, -1, 1.5, "7", Number.NaN]) {
    assert.equal(uiStateTabKey(bad), null);
    await assert.rejects(() => readUiStateForTab(bad, { storageArea: fakeArea() }), /tabId/);
  }
  const area = fakeArea();
  await assert.rejects(
    () => mutateUiStateForTab(7, () => "not an object", {
      storageArea: area, lockManager: fakeLocks(), expectedRevision: 0
    }),
    (error) => error.code === UI_STATE_ERROR_CODES.UI_STATE_INVALID
  );
  assert.equal(area.sets, 0);
});

test("observedEditorRevision answers only about the tab it was asked about", () => {
  const change = { newValue: { 7: { ...ENTRY, editorRevision: 9 }, 9: { ...ENTRY, editorRevision: 4 } } };
  assert.equal(observedEditorRevision(change, 7), 9);
  assert.equal(observedEditorRevision(change, 9), 4);
  assert.equal(observedEditorRevision(change, 11), null, "a tab not in the change reports nothing");
  assert.equal(observedEditorRevision({ newValue: undefined }, 7), null);
  assert.equal(observedEditorRevision(undefined, 7), null);
  assert.equal(observedEditorRevision(change, -1), null);
});

test("the store is pure storage: no DOM, no renderer, no polling, no Run authority", () => {
  for (const forbidden of [
    "document", "window.", "innerHTML",
    "AIPM_", "sendMessage", "executeScript", "chrome.tabs", "chrome.scripting", "chatgpt.com",
    "setInterval", "setTimeout", "requestAnimationFrame",
    "activeRun", "stateRevision", "lease", "outbox", "executionSession"
  ]) {
    assert.equal(code.includes(forbidden), false, `ui-state-store.js must not reference ${forbidden}`);
  }
  /* One lock for the whole map: the map is one storage value, so per-tab locks
     would still race on the read-modify-write. */
  assert.match(code, /UI_STATE_LOCK_NAME = "aipm-ui-by-tab-v2"/);
  assert.equal(code.includes("aipm-ui-by-tab-v2:"), false, "the lock must not be per tab");
});
