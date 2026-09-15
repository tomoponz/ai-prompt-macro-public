import { normalizeRecoveryPolicy } from "./recovery-policy.js";
import { DEFAULT_EDITOR_FLOW_TEXT } from "./editor-defaults.js";
import {
  QUICK_PRESETS,
  clonePreset
} from "./workflow.js";
import {
  EDITOR_STATE_FIELDS,
  UI_STATE_ERROR_CODES,
  mutateUiStateForTab,
  normalizeUiStateMap,
  observedEditorRevision,
  readUiStateForTab
} from "./ui-state-store.js";

export const DEFAULT_FLOW_TEXT = DEFAULT_EDITOR_FLOW_TEXT;

export const WORKSPACE_EDITOR_NOTICES = Object.freeze({
  stale: "別の画面で編集内容が更新されました。この入力は保持されています。再読み込みするまで保存しません。",
  lock: "複数画面の同時編集を安全に防げないため、編集内容を保存しませんでした。",
  read: "編集内容を読み取れませんでした。現在の入力は変更していません。",
  write: "編集内容を保存できませんでした。現在の入力は保持されています。",
  busy: "別の編集操作が完了するまで待ってください。",
  changed: "読み込み中に編集内容が変わったため、画面を置き換えませんでした。入力は保持されています。",
  invalid: "編集対象または保存内容が不正なため、変更を保存しませんでした。"
});

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function clone(value) {
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function defaultQuickState() {
  const preset = QUICK_PRESETS[0];
  return {
    preset: preset.id,
    prompt: preset.prompt,
    repeat: "3",
    delay: "1.5"
  };
}

function defaultFlowState() {
  return {
    text: DEFAULT_FLOW_TEXT,
    selectedIndex: 0,
    openedLibraryId: null,
    execution: {
      mode: "full",
      start: "1",
      end: "1",
      repeat: "1",
      checkpointId: ""
    }
  };
}

/*
  Produces the six-field editor payload shared with the Side Panel. Unknown
  top-level fields are deliberately not copied (ui-state-store owns that
  allowlist), while nested editor data is preserved verbatim wherever it
  exists. Missing fields receive the same functional defaults as the panel.
*/
export function createWorkspaceEditorState(entry = null) {
  const source = plainObject(entry) ?? {};
  const quick = plainObject(source.quick);
  const workflow = plainObject(source.workflow);
  const flow = plainObject(source.flow);
  const execution = plainObject(flow?.execution);
  const fallbackFlow = defaultFlowState();

  const result = {
    mode: ["quick", "workflow", "flow"].includes(source.mode) ? source.mode : "flow",
    keepAwake: source.keepAwake === true,
    recovery: plainObject(source.recovery)
      ? clone(source.recovery)
      : normalizeRecoveryPolicy(),
    quick: quick ? clone(quick) : defaultQuickState(),
    workflow: workflow ? clone(workflow) : clonePreset("continuous-improvement"),
    flow: flow
      ? {
          ...clone(flow),
          text: typeof flow.text === "string" ? flow.text : fallbackFlow.text,
          selectedIndex: Number.isSafeInteger(flow.selectedIndex) && flow.selectedIndex >= 0
            ? flow.selectedIndex
            : 0,
          openedLibraryId: typeof flow.openedLibraryId === "string" && flow.openedLibraryId
            ? flow.openedLibraryId
            : null,
          execution: execution ? clone(execution) : fallbackFlow.execution
        }
      : fallbackFlow
  };

  /* Keep this assertion local and deterministic. A future editor field must be
     added intentionally to both surfaces instead of being silently lost. */
  if (Object.keys(result).some((field) => !EDITOR_STATE_FIELDS.includes(field)) ||
      EDITOR_STATE_FIELDS.some((field) => !Object.hasOwn(result, field))) {
    throw new Error("Workspace editor state field mismatch");
  }
  return result;
}

export function workspaceEditorTabIds(value) {
  return Object.keys(normalizeUiStateMap(value))
    .map((key) => Number.parseInt(key, 10))
    .filter(Number.isInteger)
    .sort((left, right) => left - right);
}

export function workspaceEditorReason(error) {
  if (error?.code === UI_STATE_ERROR_CODES.STALE_EDITOR_REVISION) return "stale";
  if (error?.code === UI_STATE_ERROR_CODES.UI_STATE_LOCK_UNAVAILABLE) return "lock";
  if (error?.code === UI_STATE_ERROR_CODES.UI_STATE_READ_FAILED) return "read";
  if (error?.code === UI_STATE_ERROR_CODES.UI_STATE_INVALID) return "invalid";
  return "write";
}

/*
  A storage-only editor session. It has no DOM and no Run concepts. The session
  owns one exact tab id and the editorRevision read for that id. Saving presents
  that revision once; stale failures are never merged, retried or overwritten.
*/
export class WorkspaceEditorSession {
  constructor({
    read = readUiStateForTab,
    mutate = mutateUiStateForTab,
    createMissingState = async () => createWorkspaceEditorState()
  } = {}) {
    this.read = read;
    this.mutate = mutate;
    this.createMissingState = createMissingState;
    this.tabId = null;
    this.editorRevision = null;
    this.state = null;
    this.dirty = false;
    this.stale = false;
    this.saving = false;
    this.editVersion = 0;
    this.openEpoch = 0;
    this.savePromise = null;
    this.pendingOwnRevision = null;
    this.externalChangeVersion = 0;
  }

  get hasTarget() {
    return Number.isInteger(this.tabId) && this.state != null;
  }

  get needsDiscardConfirmation() {
    return this.dirty || this.stale;
  }

  snapshot() {
    return this.state == null ? null : clone(this.state);
  }

  async open(tabId) {
    if (!Number.isInteger(tabId) || tabId < 0) return { ok: false, reason: "invalid" };
    if (this.saving) return { ok: false, reason: "busy" };
    const epoch = ++this.openEpoch;
    const previousTabId = this.tabId;
    const previousEditVersion = this.editVersion;
    let result;
    try {
      result = await this.read(tabId);
    } catch (error) {
      return { ok: false, reason: workspaceEditorReason(error), error };
    }
    if (epoch !== this.openEpoch) return { ok: false, reason: "superseded" };
    if (this.tabId !== previousTabId || this.editVersion !== previousEditVersion) {
      return { ok: false, reason: "changed" };
    }

    let state;
    try {
      state = result.entry == null
        ? createWorkspaceEditorState(await this.createMissingState({ tabId, readResult: result }))
        : createWorkspaceEditorState(result.entry);
    } catch (error) {
      return { ok: false, reason: workspaceEditorReason(error), error };
    }
    if (epoch !== this.openEpoch) return { ok: false, reason: "superseded" };
    if (this.tabId !== previousTabId || this.editVersion !== previousEditVersion) {
      return { ok: false, reason: "changed" };
    }

    this.tabId = tabId;
    this.editorRevision = result.editorRevision;
    this.state = state;
    this.dirty = false;
    this.stale = false;
    this.editVersion = 0;
    this.pendingOwnRevision = null;
    this.externalChangeVersion = 0;
    return {
      ok: true,
      tabId,
      editorRevision: this.editorRevision,
      state: this.snapshot(),
      exists: result.exists === true,
      legacy: result.legacy === true
    };
  }

  replaceState(nextState) {
    if (!this.hasTarget) return { ok: false, reason: "invalid" };
    this.state = createWorkspaceEditorState(nextState);
    this.editVersion += 1;
    this.dirty = true;
    return { ok: true, state: this.snapshot() };
  }

  observeStorageChange(change) {
    if (!this.hasTarget) return false;
    const observed = observedEditorRevision(change, this.tabId);
    if (observed === null || observed <= this.editorRevision) return false;
    if (this.pendingOwnRevision !== null && observed === this.pendingOwnRevision) return false;
    this.externalChangeVersion += 1;
    this.stale = true;
    return true;
  }

  save() {
    if (!this.hasTarget || !Number.isSafeInteger(this.editorRevision)) {
      return Promise.resolve({ ok: false, reason: "invalid" });
    }
    if (this.stale) return Promise.resolve({ ok: false, reason: "stale" });
    if (this.savePromise) return this.savePromise;

    const tabId = this.tabId;
    const expectedRevision = this.editorRevision;
    const savedEditVersion = this.editVersion;
    const externalChangeVersion = this.externalChangeVersion;
    const payload = this.snapshot();
    this.saving = true;
    this.pendingOwnRevision = expectedRevision < Number.MAX_SAFE_INTEGER
      ? expectedRevision + 1
      : expectedRevision;

    const operation = (async () => {
      try {
        const result = await this.mutate(tabId, () => payload, { expectedRevision });
        if (this.tabId === tabId && this.editorRevision === expectedRevision) {
          this.editorRevision = result.editorRevision;
          /* An external revision observed while this CAS was settling must not
             be erased by the older save completion. Its next save stays
             fail-closed even if this write itself succeeded first. */
          this.stale = this.externalChangeVersion !== externalChangeVersion;
          this.dirty = this.editVersion !== savedEditVersion;
        }
        const conflictedAfterSave = this.tabId === tabId && this.stale;
        return {
          ok: true,
          editorRevision: result.editorRevision,
          dirty: this.dirty,
          stale: conflictedAfterSave,
          conflictedAfterSave
        };
      } catch (error) {
        const reason = workspaceEditorReason(error);
        if (reason === "stale" && this.tabId === tabId) this.stale = true;
        return { ok: false, reason, error };
      } finally {
        this.saving = false;
        this.pendingOwnRevision = null;
        this.savePromise = null;
      }
    })();
    this.savePromise = operation;
    return operation;
  }
}
