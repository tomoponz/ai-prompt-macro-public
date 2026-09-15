/*
  Workspace projection layer (Phase 2, storage-only / read-only).

  Turns a persisted Run object into a bounded, allowlisted view model. Nothing
  outside the allowlist below can reach the Workspace DOM, which is what keeps
  the surface Output-Blind: prompt text, assistant output, document identity
  values and the execution session id are never projected.

  A projection is a SNAPSHOT OF STORAGE, not a statement of current authority.
  It cannot be used to conclude that a Send is permitted, that a document or
  conversation still matches, or that a lease is held.

  This module is pure: it performs no I/O and touches no chrome API.
*/

import { normalizeTabPresentation, tabPresentationFor } from "./tab-alias.js";
import { projectRunState } from "./run-ux.js";
import { projectDiagnosticEvent, projectRunDiagnostic } from "./diagnostics-ux.js";

export const ACTIVE_RUN_KEY_PREFIX = "aipm.activeRun.v2.tab.";

const KNOWN_STATUS = ["running", "paused", "completed", "stopped"];
const MAX_TEXT = 120;

function boundedText(value, max = MAX_TEXT) {
  if (typeof value !== "string") return null;
  const compact = value.replace(/\s+/gu, " ").trim();
  if (!compact) return null;
  return Array.from(compact).slice(0, max).join("");
}

/* Codes are machine identifiers, so they are restricted to a conservative
   character set rather than merely truncated. */
function boundedCode(value, max = 64) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || !/^[A-Za-z0-9._:-]{1,128}$/.test(trimmed)) return null;
  return trimmed.slice(0, max);
}

function safeInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.trunc(parsed);
  if (rounded < min || rounded > max) return null;
  return rounded;
}

function isoOrNull(value) {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? value : null;
}

export function isActiveRunKey(key) {
  return typeof key === "string" && key.startsWith(ACTIVE_RUN_KEY_PREFIX) &&
    key.length > ACTIVE_RUN_KEY_PREFIX.length;
}

export function tabIdFromRunKey(key) {
  if (!isActiveRunKey(key)) return null;
  return safeInteger(key.slice(ACTIVE_RUN_KEY_PREFIX.length), { min: 0 });
}

/* Run ids are random UUIDs. Only a short prefix is shown, so the UI has a stable
   handle without turning the surface into an identifier dump. */
export function runIdDisplay(runId) {
  if (typeof runId !== "string") return null;
  const compact = runId.replace(/[^A-Za-z0-9-]/gu, "");
  return compact ? compact.slice(0, 8) : null;
}

/*
  The conversation key is never rendered in full. Only a short fingerprint of the
  identifier segment is produced, and only so two rows can be told apart.
*/
export function conversationFingerprint(conversationKey) {
  if (typeof conversationKey !== "string" || !conversationKey.startsWith("chatgpt:")) return null;
  const rest = conversationKey.slice("chatgpt:".length);
  if (rest.startsWith("new:")) return "new";
  const durable = rest.startsWith("c:") ? rest.slice(2) : rest;
  const compact = durable.replace(/[^A-Za-z0-9]/gu, "");
  return compact ? compact.slice(0, 6) : null;
}

/* Relative freshness for a stored timestamp. Elapsed time alone never implies a
   Run is stopped, failed or healthy — the caller renders this as information. */
export function freshnessLabel(updatedAt, now = Date.now()) {
  const iso = isoOrNull(updatedAt);
  if (!iso) return null;
  const delta = now - Date.parse(iso);
  if (!Number.isFinite(delta)) return null;
  if (delta < 0) return "更新 たった今";
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "更新 1分以内";
  if (minutes < 60) return `更新 ${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `更新 ${hours}時間前`;
  return `更新 ${Math.floor(hours / 24)}日前`;
}

/* Step descriptions must not leak prompt text. Only the step type, and a
   checkpoint's own author-supplied label, are surfaced. */
function currentStepLabel(workflow, stepIndex) {
  const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  if (!steps.length || stepIndex == null) return null;
  const step = steps[Math.min(stepIndex, steps.length - 1)];
  if (!step || typeof step !== "object") return null;
  if (step.type === "checkpoint") return boundedText(step.label) ?? "確認して続行";
  if (step.type === "delay") return "待機";
  if (step.type === "schedule" || step.type === "wait-until") return "指定時刻まで待つ";
  if (step.type === "prompt") return step.delivery === "draft" ? "入力だけして確認" : "入力して送信";
  return boundedCode(step.type) ? `手順: ${boundedCode(step.type)}` : null;
}

/*
  Projects one persisted Run.

  Returns `null` when the stored value cannot be a Run at all. Returns a
  projection with `malformed: true` and `statusKnown: false` when the value is
  object-shaped but unusable, so the Workspace can show it as 状態不明 rather
  than dropping it silently or — worse — rendering it as normal.
*/
export function projectRun(rawRun, {
  tabId = null,
  presentation = null,
  alias = null,
  now = Date.now()
} = {}) {
  if (!rawRun || typeof rawRun !== "object" || Array.isArray(rawRun)) return null;

  const display = normalizeTabPresentation(presentation ?? { alias });

  const status = typeof rawRun.status === "string" && KNOWN_STATUS.includes(rawRun.status)
    ? rawRun.status
    : null;
  const statusKnown = status !== null;

  const workflow = rawRun.workflow && typeof rawRun.workflow === "object" && !Array.isArray(rawRun.workflow)
    ? rawRun.workflow
    : null;
  const cursor = rawRun.cursor && typeof rawRun.cursor === "object" ? rawRun.cursor : {};

  const sendsCompleted = safeInteger(cursor.sendsCompleted, { min: 0, max: 100000 });
  const plannedSends = safeInteger(rawRun.plannedSends, { min: 0, max: 100000 });
  const maxSends = safeInteger(workflow?.maxSends, { min: 0, max: 100000 });
  const stepIndex = safeInteger(cursor.stepIndex, { min: 0, max: 10000 });
  const totalSteps = Array.isArray(workflow?.steps) ? workflow.steps.length : null;

  const outboxState = rawRun.outbox && typeof rawRun.outbox === "object"
    ? boundedCode(rawRun.outbox.state)
    : null;
  /* Only the outbox STATE is projected. id / promptHash / position are omitted:
     they are execution internals and promptHash derives from prompt text. */

  const percent = status === "completed"
    ? 100
    : plannedSends && plannedSends > 0 && sendsCompleted != null
      ? Math.max(0, Math.min(100, Math.round((sendsCompleted / plannedSends) * 100)))
      : null;

  const ux = statusKnown ? projectRunState(rawRun) : projectRunState({ status: "unknown" });
  const safetyState = ux.kind;
  const snapshotStatusLabel = ux.kind === "running" ? "実行中の保存記録" : ux.label;
  const fresh = freshnessLabel(rawRun.updatedAt, now);

  const malformed = !statusKnown || sendsCompleted == null || plannedSends == null;

  return {
    tabId: safeInteger(tabId, { min: 0 }),
    runIdDisplay: runIdDisplay(rawRun.runId),
    alias: boundedText(display.alias, 40),
    color: display.color,
    group: boundedText(display.group, 40),
    status,
    statusKnown,
    statusLabel: snapshotStatusLabel,
    visibilityStatusLabel: snapshotStatusLabel,
    progressCompleted: sendsCompleted,
    progressTotal: plannedSends,
    progressPercent: percent,
    currentStepNumber: stepIndex == null || !totalSteps ? null : Math.min(stepIndex + 1, totalSteps),
    totalSteps: totalSteps && totalSteps > 0 ? totalSteps : null,
    currentStepLabel: currentStepLabel(workflow, stepIndex),
    workflowName: boundedText(workflow?.name, 60),
    maxSends,
    pauseReason: boundedCode(rawRun.pauseReason),
    lastErrorCode: boundedCode(rawRun.lastErrorCode),
    resumable: typeof rawRun.resumable === "boolean" ? rawRun.resumable : null,
    recoveryMode: boundedCode(workflow?.recovery?.mode),
    keepAwake: rawRun.keepAwake === true,
    outboxState,
    safetyState,
    safetyLabel: ux.safetyLabel,
    reasonLabel: ux.reason,
    diagnostic: projectRunDiagnostic(rawRun),
    conversationFingerprint: conversationFingerprint(rawRun.conversationKey),
    startedAt: isoOrNull(rawRun.startedAt),
    updatedAt: isoOrNull(rawRun.updatedAt),
    freshnessLabel: fresh,
    snapshotLabel: `保存記録 · ${fresh ?? "更新時刻 不明"}`,
    observationLabel: "現在の接続状態は未確認",
    malformed
  };
}

/* Display name. Alias wins; tab titles and URLs are never used. */
export function runDisplayName(projection) {
  if (projection?.alias) return projection.alias;
  return Number.isInteger(projection?.tabId) ? `タブ #${projection.tabId}` : "ChatGPTの実行記録";
}

/*
  Projects every active-Run entry found in a `chrome.storage.local.get(null)`
  style object. Non-Run keys are ignored; unusable values are dropped.
  Sorted by updatedAt descending so the most recently touched Run leads.
*/
export function projectRunList(storageSnapshot, {
  presentations = null,
  aliases = {},
  now = Date.now()
} = {}) {
  const source = storageSnapshot && typeof storageSnapshot === "object" ? storageSnapshot : {};
  const displayMap = presentations ?? aliases;
  const rows = [];
  for (const [key, value] of Object.entries(source)) {
    if (!isActiveRunKey(key)) continue;
    const tabId = tabIdFromRunKey(key);
    const presentation = tabId == null ? null : tabPresentationFor(displayMap, tabId);
    const projection = projectRun(value, { tabId, presentation, now });
    if (projection) rows.push(projection);
  }
  rows.sort((a, b) => {
    const at = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const bt = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    if (bt !== at) return bt - at;
    return (a.tabId ?? 0) - (b.tabId ?? 0);
  });
  return rows;
}

/*
  Bounded diagnostics for one Run. The stored ring is already allowlisted by
  appendDiagnostic(), but this narrows it further to the few fields the
  Workspace shows and matches by the short run id so no full id is projected.
*/
export function projectDiagnostics(rawList, runIdPrefix, { limit = 6 } = {}) {
  if (!Array.isArray(rawList) || !runIdPrefix) return [];
  const rows = [];
  for (const entry of rawList) {
    if (!entry || typeof entry !== "object") continue;
    if (runIdDisplay(entry.runId) !== runIdPrefix) continue;
    const type = boundedCode(entry.type);
    if (!type) continue;
    const projected = projectDiagnosticEvent({
      ...entry,
      type,
      at: isoOrNull(entry.at),
      durationMs: safeInteger(entry.durationMs, { min: 0, max: 600000 })
    });
    if (projected) rows.push(projected);
  }
  return rows.slice(-limit).reverse();
}

export const STATUS_FILTERS = ["all", "running", "paused", "completed", "stopped"];

export function filterRuns(rows, filter) {
  if (!Array.isArray(rows)) return [];
  if (!STATUS_FILTERS.includes(filter) || filter === "all") return rows;
  return rows.filter((row) => row.status === filter);
}
