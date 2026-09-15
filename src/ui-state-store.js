/*
  Per-tab editor state for the Side Panel, and later for the Workspace editor.

  This module owns every read and write of `aipm.uiByTab.v2`. It exists because
  the map is about to gain a second writer: once the Workspace has an editor,
  two surfaces can hold the same tab's editor state at once, and the previous
  read-modify-write had no way to notice that the other one had saved in the
  meantime. The losing save simply disappeared.

  What this module guarantees:

    - a write is fenced by `editorRevision` (compare-and-set). A writer that
      read revision 5 can only advance the entry to 6. If the stored revision is
      already 6, the write is refused with STALE_EDITOR_REVISION and NOTHING is
      written.
    - the compare and the write happen inside one exclusive Web Lock, which is
      shared by every same-origin extension page, so the check cannot be
      overtaken between reading and writing.
    - if the lock manager is missing the write fails closed. "Probably nobody
      else is editing" is not a safety argument.
    - the fresh read inside the lock is what the entry is built from. A map
      cached before the lock is never written back.
    - only the target tab's key is replaced. Sibling entries are carried over
      verbatim, including ones this module cannot parse, so another tab's state
      is never collateral damage.

  What this module is NOT:

    `editorRevision` fences EDITOR state. It has nothing to do with the Run's
    `stateRevision`, the lease, the outbox, the execution session or document
    identity, all of which live in background.js and stay there. Nothing in an
    editor entry is Run authority, and an editor entry never decides whether a
    Send may happen.

  Surfaces are not authorities. There is deliberately no "which surface wrote
  this" field: a writer is allowed to write because it holds the lock and its
  expected revision matches, never because of what page it runs on.
*/

export const UI_STATE_MAP_KEY = "aipm.uiByTab.v2";
export const LEGACY_UI_STATE_KEY = "aipm.ui.v1";

/*
  One lock for the whole map, not one per tab. The map is a single storage
  value, so two concurrent per-tab writers would still read-modify-write the
  same object and one of them would drop the other's entry. Tab granularity
  would look finer and be wrong.
*/
export const UI_STATE_LOCK_NAME = "aipm-ui-by-tab-v2";

export const UI_STATE_ERROR_CODES = Object.freeze({
  STALE_EDITOR_REVISION: "STALE_EDITOR_REVISION",
  UI_STATE_LOCK_UNAVAILABLE: "UI_STATE_LOCK_UNAVAILABLE",
  UI_STATE_INVALID: "UI_STATE_INVALID",
  UI_STATE_READ_FAILED: "UI_STATE_READ_FAILED",
  UI_STATE_WRITE_FAILED: "UI_STATE_WRITE_FAILED"
});

export class UiStateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "UiStateError";
    this.code = code;
    Object.assign(this, details);
  }
}

/*
  The editor fields the Side Panel actually persists today. The allowlist is the
  reason an entry cannot grow Run authority by accident: a stored object that
  carries executionSessionId, a lease, a document id or an assistant response
  loses those fields the next time the entry is normalized.
*/
export const EDITOR_STATE_FIELDS = Object.freeze([
  "mode",
  "keepAwake",
  "recovery",
  "quick",
  "workflow",
  "flow"
]);

/* A revision must be an actual number. A numeric string here means the value
   was corrupted or hand-edited, and coercing it would let malformed storage
   pass the fence. */
export function normalizeEditorRevision(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeTimestamp(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/* Storage object keys are strings; tab ids are non-negative integers. Anything
   that does not round-trip exactly is not a tab id. */
export function uiStateTabKey(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return null;
  return String(tabId);
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/*
  Returns null for anything that is not an object, so callers can tell "no entry
  for this tab" apart from "an entry whose revision happens to be 0". An entry
  that exists but carries no known field still returns an object: it is a real,
  if empty, editor state and applyUiState falls back per field.
*/
export function normalizeUiStateEntry(value) {
  const source = plainObject(value);
  if (!source) return null;
  const entry = {};
  for (const field of EDITOR_STATE_FIELDS) {
    if (Object.hasOwn(source, field)) entry[field] = source[field];
  }
  entry.editorRevision = normalizeEditorRevision(source.editorRevision);
  entry.updatedAt = normalizeTimestamp(source.updatedAt);
  return entry;
}

/* Read-side view of the map. Unparseable keys and entries are dropped here so a
   reader never sees them; the write path preserves them instead of deleting
   them, which is a different job. */
export function normalizeUiStateMap(value) {
  const source = plainObject(value);
  if (!source) return {};
  const result = {};
  for (const [key, raw] of Object.entries(source)) {
    const tabId = Number.parseInt(key, 10);
    if (uiStateTabKey(tabId) !== key) continue;
    const entry = normalizeUiStateEntry(raw);
    if (entry) result[key] = entry;
  }
  return result;
}

function resolveArea(storageArea) {
  return storageArea ?? globalThis.chrome?.storage?.local ?? null;
}

function resolveLocks(lockManager) {
  return lockManager ?? globalThis.navigator?.locks ?? null;
}

/*
  Reads one tab's editor entry plus the revision a later write has to present.

  An installation that predates this module has entries with no editorRevision.
  They read back as revision 0 and the next successful save stamps them with 1,
  so the migration is lazy and nothing is rewritten in bulk.

  `aipm.ui.v1` is the pre-per-tab layout. It is still honoured as a fallback for
  the shape only: it reports revision 0 and exists:false, so the first save for
  that tab creates a fresh v2 entry rather than pretending to update one.
*/
export async function readUiStateForTab(tabId, { storageArea } = {}) {
  const key = uiStateTabKey(tabId);
  if (key === null) {
    throw new UiStateError(UI_STATE_ERROR_CODES.UI_STATE_INVALID, "tabIdが不正です。");
  }
  const area = resolveArea(storageArea);
  if (!area?.get) {
    throw new UiStateError(UI_STATE_ERROR_CODES.UI_STATE_READ_FAILED, "editor stateを読み取れません。");
  }

  let stored;
  try {
    stored = await area.get([UI_STATE_MAP_KEY, LEGACY_UI_STATE_KEY]);
  } catch {
    throw new UiStateError(UI_STATE_ERROR_CODES.UI_STATE_READ_FAILED, "editor stateを読み取れません。");
  }

  const entry = normalizeUiStateMap(stored?.[UI_STATE_MAP_KEY])[key] ?? null;
  if (entry) {
    return {
      entry,
      editorRevision: entry.editorRevision,
      updatedAt: entry.updatedAt,
      exists: true,
      legacy: false
    };
  }

  const legacy = normalizeUiStateEntry(stored?.[LEGACY_UI_STATE_KEY]);
  if (legacy) {
    return { entry: legacy, editorRevision: 0, updatedAt: 0, exists: false, legacy: true };
  }
  return { entry: null, editorRevision: 0, updatedAt: 0, exists: false, legacy: false };
}

/*
  Compare-and-set write.

  `expectedRevision` is mandatory: a caller that has not read the entry has
  nothing to compare and must not write. `mutation` receives the state observed
  inside the lock and returns the editor payload to store; the Side Panel passes
  a DOM snapshot straight through, and a future read-modify-write caller can use
  the argument instead.

  On mismatch this throws before touching storage. There is no "merge", no
  "newest wins" and no retry: resolving a real divergence is the user's call,
  not this module's.
*/
export async function mutateUiStateForTab(tabId, mutation, {
  expectedRevision,
  storageArea,
  lockManager,
  now = Date.now()
} = {}) {
  const key = uiStateTabKey(tabId);
  if (key === null) {
    throw new UiStateError(UI_STATE_ERROR_CODES.UI_STATE_INVALID, "tabIdが不正です。");
  }
  if (typeof mutation !== "function") {
    throw new UiStateError(UI_STATE_ERROR_CODES.UI_STATE_INVALID, "editor state mutationが必要です。");
  }
  const rawExpected = expectedRevision;
  if (typeof rawExpected !== "number" || !Number.isSafeInteger(rawExpected) || rawExpected < 0) {
    throw new UiStateError(
      UI_STATE_ERROR_CODES.UI_STATE_INVALID,
      "expected editorRevisionが必要です。"
    );
  }

  const area = resolveArea(storageArea);
  if (!area?.get || !area?.set) {
    throw new UiStateError(UI_STATE_ERROR_CODES.UI_STATE_WRITE_FAILED, "editor stateを保存できません。");
  }

  const locks = resolveLocks(lockManager);
  if (!locks || typeof locks.request !== "function") {
    /* Fail closed. Without cross-surface exclusion the compare-and-set below is
       decorative: another surface could write between the read and the set. */
    throw new UiStateError(
      UI_STATE_ERROR_CODES.UI_STATE_LOCK_UNAVAILABLE,
      "複数画面の同時編集を安全に防げないため、editor stateを保存しませんでした。"
    );
  }

  return locks.request(UI_STATE_LOCK_NAME, { mode: "exclusive" }, async () => {
    let stored;
    try {
      stored = await area.get(UI_STATE_MAP_KEY);
    } catch {
      throw new UiStateError(UI_STATE_ERROR_CODES.UI_STATE_READ_FAILED, "editor stateを読み取れません。");
    }

    /* Siblings are carried over exactly as stored, including entries this
       module would not parse. Fencing one tab must not prune another. */
    const siblings = plainObject(stored?.[UI_STATE_MAP_KEY]) ?? {};
    const current = normalizeUiStateEntry(siblings[key]);
    const currentRevision = current?.editorRevision ?? 0;

    if (currentRevision !== rawExpected) {
      throw new UiStateError(
        UI_STATE_ERROR_CODES.STALE_EDITOR_REVISION,
        "別の画面で編集内容が更新されました。",
        { expectedRevision: rawExpected, observedRevision: currentRevision, tabId }
      );
    }

    const payload = normalizeUiStateEntry(await mutation(current));
    if (!payload) {
      throw new UiStateError(UI_STATE_ERROR_CODES.UI_STATE_INVALID, "保存するeditor stateが不正です。");
    }

    const next = {
      ...payload,
      /* Saturating, like the Flow Library revision. Reaching this bound would
         take more saves than a browser profile can produce. */
      editorRevision: currentRevision < Number.MAX_SAFE_INTEGER ? currentRevision + 1 : currentRevision,
      updatedAt: normalizeTimestamp(now)
    };

    try {
      await area.set({ [UI_STATE_MAP_KEY]: { ...siblings, [key]: next } });
    } catch {
      throw new UiStateError(UI_STATE_ERROR_CODES.UI_STATE_WRITE_FAILED, "editor stateを保存できません。");
    }

    return { entry: next, editorRevision: next.editorRevision, updatedAt: next.updatedAt };
  });
}

/*
  Given a storage.onChanged record for this key, report the revision another
  writer left for one tab. Returns null when the change says nothing about that
  tab, so a caller can ignore unrelated tabs without parsing the map itself.

  Deliberately not a listener: this module never subscribes and never touches a
  document. The surface decides what to do with the answer, and Phase 4A's
  answer is "warn, refuse the next save, change nothing on screen".
*/
export function observedEditorRevision(change, tabId) {
  const key = uiStateTabKey(tabId);
  if (key === null) return null;
  const entry = normalizeUiStateMap(change?.newValue)[key] ?? null;
  return entry ? entry.editorRevision : null;
}

/*
  There is intentionally no remove/delete export. Tab-close cleanup of this key
  belongs to background.js, which owns tab lifetime; adding a second deleter
  here would create exactly the kind of split ownership this module exists to
  prevent.
*/
