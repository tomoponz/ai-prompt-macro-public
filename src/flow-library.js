import { compileAipmFlow } from "./flow-compile.js";

export const FLOW_LIBRARY_STORAGE_KEY = "aipm.flowLibrary.v1";
export const FLOW_LIBRARY_SCHEMA_VERSION = 1;
export const FLOW_LIBRARY_LOCK_NAME = "aipm-flow-library-v1";
export const MAX_FLOW_LIBRARY_ENTRIES = 200;
export const MAX_FLOW_LIBRARY_NAME_CHARS = 80;
export const MAX_FLOW_LIBRARY_DESCRIPTION_CHARS = 500;
export const FLOW_LIBRARY_ERROR_CODES = Object.freeze({
  STALE_FLOW_LIBRARY_REVISION: "STALE_FLOW_LIBRARY_REVISION",
  FLOW_LIBRARY_REVISION_INVALID: "FLOW_LIBRARY_REVISION_INVALID"
});

export class FlowLibraryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "FlowLibraryError";
    this.code = code;
    Object.assign(this, details);
  }
}

function boundedText(value, maxChars) {
  return Array.from(String(value ?? "").trim()).slice(0, maxChars).join("");
}

function safeTimestamp(value, fallback) {
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : fallback;
}

function safeRevision(value) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

function defaultEntryId(now = Date.now()) {
  const random = globalThis.crypto?.randomUUID?.();
  return random ? `flow-${random}` : `flow-${now}-${Math.random().toString(36).slice(2, 10)}`;
}

function storedEntry(value, fallbackNow = Date.now()) {
  if (!value || typeof value !== "object") return null;
  const id = boundedText(value.id, 120);
  const source = typeof value.source === "string" ? value.source : "";
  if (!id || !source) return null;
  const createdAt = safeTimestamp(value.createdAt, fallbackNow);
  return {
    id,
    name: boundedText(value.name, MAX_FLOW_LIBRARY_NAME_CHARS) || "名称未設定",
    description: boundedText(value.description, MAX_FLOW_LIBRARY_DESCRIPTION_CHARS),
    source,
    favorite: value.favorite === true,
    createdAt,
    updatedAt: safeTimestamp(value.updatedAt, createdAt),
    lastOpenedAt: safeTimestamp(value.lastOpenedAt, 0)
  };
}

export function normalizeFlowLibrary(value) {
  const sourceEntries = value?.schemaVersion === FLOW_LIBRARY_SCHEMA_VERSION && Array.isArray(value.entries)
    ? value.entries
    : [];
  const seen = new Set();
  const entries = [];
  for (const raw of sourceEntries) {
    const entry = storedEntry(raw);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
    if (entries.length >= MAX_FLOW_LIBRARY_ENTRIES) break;
  }
  return {
    schemaVersion: FLOW_LIBRARY_SCHEMA_VERSION,
    revision: safeRevision(value?.revision),
    entries
  };
}

export function createFlowLibraryEntry(input = {}, options = {}) {
  const now = safeTimestamp(options.now, Date.now());
  const source = String(input.source ?? "");
  const compilation = compileAipmFlow(source);
  const fallbackName = compilation.flows[0]?.name || "名称未設定";
  return {
    id: boundedText(options.id, 120) || defaultEntryId(now),
    name: boundedText(input.name, MAX_FLOW_LIBRARY_NAME_CHARS) || fallbackName,
    description: boundedText(input.description, MAX_FLOW_LIBRARY_DESCRIPTION_CHARS),
    source,
    favorite: input.favorite === true,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: 0
  };
}

export function updateFlowLibraryEntry(entry, patch = {}, options = {}) {
  const existing = storedEntry(entry);
  if (!existing) throw new Error("更新するLibrary entryが不正です。");
  const now = safeTimestamp(options.now, Date.now());
  const source = patch.source == null ? existing.source : String(patch.source);
  compileAipmFlow(source);
  return {
    ...existing,
    name: patch.name == null
      ? existing.name
      : boundedText(patch.name, MAX_FLOW_LIBRARY_NAME_CHARS) || existing.name,
    description: patch.description == null
      ? existing.description
      : boundedText(patch.description, MAX_FLOW_LIBRARY_DESCRIPTION_CHARS),
    source,
    favorite: patch.favorite == null ? existing.favorite : patch.favorite === true,
    updatedAt: now
  };
}

export function markFlowLibraryOpened(entry, now = Date.now()) {
  const existing = storedEntry(entry);
  if (!existing) throw new Error("開くLibrary entryが不正です。");
  return { ...existing, lastOpenedAt: safeTimestamp(now, Date.now()) };
}

export function duplicateFlowLibraryEntry(entry, options = {}) {
  const existing = storedEntry(entry);
  if (!existing) throw new Error("複製するLibrary entryが不正です。");
  return createFlowLibraryEntry({
    ...existing,
    name: `${existing.name} のコピー`
  }, options);
}

export function upsertFlowLibraryEntry(library, entry) {
  const normalized = normalizeFlowLibrary(library);
  const safeEntry = storedEntry(entry);
  if (!safeEntry) throw new Error("保存するLibrary entryが不正です。");
  const without = normalized.entries.filter((item) => item.id !== safeEntry.id);
  const entries = [safeEntry, ...without];
  if (entries.length > MAX_FLOW_LIBRARY_ENTRIES) throw new Error(`Libraryは最大${MAX_FLOW_LIBRARY_ENTRIES}件です。`);
  return { schemaVersion: FLOW_LIBRARY_SCHEMA_VERSION, entries };
}

export function deleteFlowLibraryEntry(library, id) {
  const normalized = normalizeFlowLibrary(library);
  return {
    schemaVersion: FLOW_LIBRARY_SCHEMA_VERSION,
    revision: normalized.revision,
    entries: normalized.entries.filter((item) => item.id !== id)
  };
}

export function searchFlowLibrary(library, query = "") {
  const needle = String(query ?? "").trim().toLocaleLowerCase();
  return normalizeFlowLibrary(library).entries
    .filter((entry) => !needle || `${entry.name}\n${entry.description}`.toLocaleLowerCase().includes(needle))
    .sort((left, right) =>
      Number(right.favorite) - Number(left.favorite) ||
      right.lastOpenedAt - left.lastOpenedAt ||
      right.updatedAt - left.updatedAt ||
      left.name.localeCompare(right.name)
    );
}

export function resolveOpenedFlowLibraryId(library, openedId) {
  if (typeof openedId !== "string" || !openedId) return null;
  return normalizeFlowLibrary(library).entries.some((entry) => entry.id === openedId) ? openedId : null;
}

export function canUpdateOpenedFlowLibraryEntry(library, selectedId, openedId) {
  return typeof selectedId === "string" && selectedId === resolveOpenedFlowLibraryId(library, openedId);
}

export function isOpenedFlowLibraryDirty(library, openedId, editorSource) {
  const resolvedId = resolveOpenedFlowLibraryId(library, openedId);
  if (!resolvedId) return false;
  const opened = normalizeFlowLibrary(library).entries.find((entry) => entry.id === resolvedId);
  return opened?.source !== String(editorSource ?? "");
}

export function validateImportedFlowText(value) {
  const source = String(value ?? "");
  compileAipmFlow(source);
  return source;
}

export function exportFlowText(entry) {
  const existing = storedEntry(entry);
  if (!existing) throw new Error("ExportするLibrary entryが不正です。");
  return existing.source;
}

export async function loadFlowLibrary(storageArea = chrome.storage.local) {
  const stored = await storageArea.get(FLOW_LIBRARY_STORAGE_KEY);
  return normalizeFlowLibrary(stored[FLOW_LIBRARY_STORAGE_KEY]);
}

export async function persistFlowLibrary(library, storageArea = chrome.storage.local) {
  const normalized = normalizeFlowLibrary(library);
  await storageArea.set({ [FLOW_LIBRARY_STORAGE_KEY]: normalized });
  return normalized;
}

export async function mutateFlowLibrary(
  mutation,
  {
    storageArea = chrome.storage.local,
    lockManager = globalThis.navigator?.locks,
    expectedRevision
  } = {}
) {
  if (typeof mutation !== "function") throw new TypeError("Library mutationが必要です。");
  if (expectedRevision !== undefined &&
      (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
    throw new FlowLibraryError(
      FLOW_LIBRARY_ERROR_CODES.FLOW_LIBRARY_REVISION_INVALID,
      "Flow Library revisionが不正なため、変更を保存しませんでした。"
    );
  }
  if (!lockManager || typeof lockManager.request !== "function") {
    throw new Error("Libraryの排他保存を利用できないため、変更を保存しませんでした。");
  }
  return lockManager.request(FLOW_LIBRARY_LOCK_NAME, { mode: "exclusive" }, async () => {
    const current = await loadFlowLibrary(storageArea);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      throw new FlowLibraryError(
        FLOW_LIBRARY_ERROR_CODES.STALE_FLOW_LIBRARY_REVISION,
        "別の画面でFlow Libraryが更新されました。再読み込みしてから操作してください。",
        { expectedRevision, observedRevision: current.revision }
      );
    }
    const mutated = normalizeFlowLibrary(await mutation(current));
    const next = {
      ...mutated,
      revision: current.revision < Number.MAX_SAFE_INTEGER
        ? current.revision + 1
        : current.revision
    };
    await storageArea.set({ [FLOW_LIBRARY_STORAGE_KEY]: next });
    return next;
  });
}
