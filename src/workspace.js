/*
  Fullscreen Workspace — read-only Run overview + storage-only Phase 4B editor.

  Hard constraint for this surface: opening the Workspace must not increase the
  number of contacts with a ChatGPT renderer. It therefore reads persisted Run
  metadata from chrome.storage and reacts to chrome.storage.onChanged. It does
  not message the background worker, does not message content scripts, does not
  inject scripts, and runs no timers.

  What is displayed is a STORAGE SNAPSHOT. It is not proof of current authority:
  it cannot establish that a Send is permitted, that the document or conversation
  still matches, that a lease is held, or that the renderer is ready. All
  Run mutation controls are intentionally absent. The editor writes only the
  six-field per-tab editor payload through ui-state-store's revision fence.
*/

import { loadSettings, SETTINGS_STORAGE_KEY } from "./settings-store.js";
import { applyAppearance } from "./theme.js";
import {
  normalizeTabPresentationMap,
  TAB_PRESENTATION_STORAGE_KEY
} from "./tab-alias.js";
import {
  initializeWorkspaceEditor,
  onWorkspaceEditorStorageChanged
} from "./workspace-editor.js";
import {
  filterRuns,
  isActiveRunKey,
  projectDiagnostics,
  projectRunList,
  runDisplayName,
  STATUS_FILTERS
} from "./workspace-projection.js";
import { recoveryModeLabel } from "./recovery-policy.js";
import { diagnosticDetailsRows, diagnosticsLevelIsDetailed } from "./diagnostics-ux.js";

const DIAGNOSTICS_STORAGE_KEY = "aipm.diagnostics.v1";
const PLACEHOLDER = "—";

const el = {
  root: document.querySelector(".workspace"),
  runList: document.querySelector("#runList"),
  runListEmpty: document.querySelector("#runListEmpty"),
  runCount: document.querySelector("#runCount"),
  groupFilter: document.querySelector("#groupFilter"),
  detail: document.querySelector("#detail"),
  detailEmpty: document.querySelector("#detailEmpty"),
  detailTitle: document.querySelector("#detailTitle"),
  detailWorkflow: document.querySelector("#detailWorkflow"),
  detailStatus: document.querySelector("#detailStatus"),
  detailProgress: document.querySelector("#detailProgress"),
  detailPercent: document.querySelector("#detailPercent"),
  detailProgressFill: document.querySelector("#detailProgressFill"),
  detailTab: document.querySelector("#detailTab"),
  detailColor: document.querySelector("#detailColor"),
  detailGroup: document.querySelector("#detailGroup"),
  detailReason: document.querySelector("#detailReason"),
  detailObservation: document.querySelector("#detailObservation"),
  detailStep: document.querySelector("#detailStep"),
  detailMaxSends: document.querySelector("#detailMaxSends"),
  detailSafety: document.querySelector("#detailSafety"),
  detailUpdated: document.querySelector("#detailUpdated"),
  detailNotice: document.querySelector("#detailNotice"),
  side: document.querySelector("#side"),
  sideEmpty: document.querySelector("#sideEmpty"),
  sideStatus: document.querySelector("#sideStatus"),
  sideSafety: document.querySelector("#sideSafety"),
  sideRecovery: document.querySelector("#sideRecovery"),
  sideKeepAwake: document.querySelector("#sideKeepAwake"),
  sideConversation: document.querySelector("#sideConversation"),
  sideStarted: document.querySelector("#sideStarted"),
  sideRunId: document.querySelector("#sideRunId"),
  sideDiagnosticTitle: document.querySelector("#sideDiagnosticTitle"),
  sideDiagnosticSummary: document.querySelector("#sideDiagnosticSummary"),
  sideDiagnosticSafety: document.querySelector("#sideDiagnosticSafety"),
  sideDiagnosticsAdvanced: document.querySelector("#sideDiagnosticsAdvanced"),
  sideDiagnosticDetails: document.querySelector("#sideDiagnosticDetails"),
  sideDiagnostics: document.querySelector("#sideDiagnostics"),
  sideDiagnosticsEmpty: document.querySelector("#sideDiagnosticsEmpty"),
  openSettings: document.querySelector("#openSettings"),
  viewRuns: document.querySelector("#viewRuns"),
  viewEditor: document.querySelector("#viewEditor"),
  viewHelp: document.querySelector("#viewHelp")
};

/* Selection is memory only. `aipm.selectedTab.v1` belongs to the Side Panel and
   is deliberately not read or written here, so the two surfaces cannot fight
   over one another's selection. Losing the selection on reload is acceptable. */
let selectedTabId = null;
let activeFilter = "all";
let activeGroup = "";
let rows = [];
let diagnosticsRaw = [];
let diagnosticsLevel = "summary";

const COLOR_LABEL = {
  default: "標準",
  blue: "青",
  green: "緑",
  yellow: "黄",
  orange: "橙",
  red: "赤",
  purple: "紫"
};
function setText(node, value) {
  if (node) node.textContent = value == null || value === "" ? PLACEHOLDER : String(value);
}

function formatTimestamp(iso) {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toLocaleString();
}

function readPresentations() {
  const session = globalThis.chrome?.storage?.session;
  if (!session?.get) return Promise.resolve({});
  return session.get(TAB_PRESENTATION_STORAGE_KEY)
    .then((stored) => normalizeTabPresentationMap(stored?.[TAB_PRESENTATION_STORAGE_KEY]))
    .catch(() => ({}));
}

function readRunSnapshot() {
  const local = globalThis.chrome?.storage?.local;
  if (!local?.get) return Promise.resolve({});
  /* One read of the local area. No per-tab query, no renderer contact. */
  return local.get(null).then((all) => all ?? {}).catch(() => ({}));
}

/* ---------------------------------------------------------------- rendering */

function buildRunRow(row) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = row.tabId === selectedTabId ? "run-row is-selected" : "run-row";
  button.dataset.tabId = row.tabId == null ? "" : String(row.tabId);
  button.dataset.color = row.color;

  const top = document.createElement("span");
  top.className = "run-row-top";
  const identity = document.createElement("span");
  identity.className = "run-row-name-wrap";
  const marker = document.createElement("span");
  marker.className = "run-color-marker";
  marker.setAttribute("aria-hidden", "true");
  const name = document.createElement("span");
  name.className = "run-row-name";
  /* textContent only: alias and workflow names are user-controlled strings. */
  name.textContent = runDisplayName(row);
  const badge = document.createElement("span");
  badge.className = "status-badge";
  badge.dataset.safety = row.safetyState;
  badge.textContent = row.visibilityStatusLabel;
  identity.append(marker, name);
  top.append(identity, badge);

  const presentation = document.createElement("span");
  presentation.className = "run-row-presentation";
  const tab = document.createElement("span");
  tab.className = "run-tab-chip";
  tab.textContent = row.tabId == null ? "タブ不明" : `タブ #${row.tabId}`;
  presentation.append(tab);
  if (row.group) {
    const group = document.createElement("span");
    group.className = "run-group-chip";
    group.textContent = row.group;
    presentation.append(group);
  }

  const track = document.createElement("span");
  track.className = "run-row-track";
  const fill = document.createElement("span");
  fill.className = "run-row-fill";
  fill.style.width = `${row.progressPercent ?? 0}%`;
  track.append(fill);

  const meta = document.createElement("span");
  meta.className = "run-row-meta";
  const sends = document.createElement("span");
  sends.textContent = row.progressCompleted == null || row.progressTotal == null
    ? "送信 不明"
    : `送信 ${row.progressCompleted} / ${row.progressTotal}`;
  const fresh = document.createElement("span");
  fresh.textContent = row.snapshotLabel;
  const observation = document.createElement("span");
  observation.className = "run-row-observation";
  observation.textContent = row.observationLabel;
  meta.append(sends, fresh, observation);

  button.append(top, presentation, track, meta);
  button.addEventListener("click", () => {
    selectedTabId = row.tabId;
    render();
  });
  item.append(button);
  return item;
}

function renderList(visible) {
  el.runList?.replaceChildren(...visible.map(buildRunRow));
  setText(el.runCount, String(visible.length));
  if (el.runListEmpty) {
    el.runListEmpty.classList.toggle("hidden", visible.length > 0);
    el.runListEmpty.textContent = rows.length === 0
      ? "保存されている実行記録はありません。"
      : "この条件に一致する実行記録はありません。";
  }
}

function renderGroupFilter() {
  if (!el.groupFilter) return;
  const groups = [...new Set(rows.map((row) => row.group).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "ja"));
  if (activeGroup && !groups.includes(activeGroup)) activeGroup = "";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "すべてのグループ";
  const options = groups.map((group) => {
    const option = document.createElement("option");
    option.value = group;
    option.textContent = group;
    return option;
  });
  el.groupFilter.replaceChildren(all, ...options);
  el.groupFilter.value = activeGroup;
}

function renderDetail(row) {
  const hasRow = Boolean(row);
  el.detail?.classList.toggle("hidden", !hasRow);
  el.detailEmpty?.classList.toggle("hidden", hasRow);
  el.side?.classList.toggle("hidden", !hasRow);
  el.sideEmpty?.classList.toggle("hidden", hasRow);
  if (!hasRow) return;

  setText(el.detailTitle, runDisplayName(row));
  setText(el.detailWorkflow, row.workflowName);
  setText(el.detailStatus, row.visibilityStatusLabel);
  if (el.detailStatus) el.detailStatus.dataset.safety = row.safetyState;

  setText(el.detailProgress, row.progressCompleted == null || row.progressTotal == null
    ? "不明"
    : `${row.progressCompleted} / ${row.progressTotal}`);
  setText(el.detailPercent, row.progressPercent == null ? PLACEHOLDER : `${row.progressPercent}%`);
  if (el.detailProgressFill) el.detailProgressFill.style.width = `${row.progressPercent ?? 0}%`;

  setText(el.detailTab, row.tabId == null ? null : `タブ #${row.tabId}`);
  setText(el.detailColor, COLOR_LABEL[row.color] ?? COLOR_LABEL.default);
  setText(el.detailGroup, row.group);
  setText(el.detailReason, row.reasonLabel);
  setText(el.detailObservation, row.observationLabel);

  setText(el.detailStep, row.currentStepNumber && row.totalSteps
    ? `手順 ${row.currentStepNumber} / ${row.totalSteps}${row.currentStepLabel ? ` · ${row.currentStepLabel}` : ""}`
    : row.currentStepLabel);
  setText(el.detailMaxSends, row.maxSends == null ? null : `${row.maxSends} 回`);
  setText(el.detailSafety, row.safetyLabel);
  setText(el.detailUpdated, row.updatedAt
    ? `${formatTimestamp(row.updatedAt) ?? row.updatedAt}（${row.freshnessLabel ?? "経過不明"}）`
    : null);

  /* Malformed or unknown-status records are called out explicitly so they can
     never be mistaken for a normal Run. */
  if (el.detailNotice) {
    const problem = !row.statusKnown
      ? "この記録は状態を判別できません。保存内容が不完全か、未知の形式です。"
      : (row.malformed ? "この記録には読み取れない項目があります。表示は不完全です。" : "");
    el.detailNotice.textContent = problem;
    el.detailNotice.classList.toggle("hidden", problem === "");
  }

  setText(el.sideStatus, row.statusLabel);
  setText(el.sideSafety, row.safetyLabel);
  setText(el.sideRecovery, row.recoveryMode ? recoveryModeLabel({ mode: row.recoveryMode }) : null);
  setText(el.sideKeepAwake, row.keepAwake ? "有効" : "無効");
  setText(el.sideConversation, row.conversationFingerprint
    ? (row.conversationFingerprint === "new" ? "新しい会話" : `会話 ${row.conversationFingerprint}…`)
    : null);
  setText(el.sideStarted, formatTimestamp(row.startedAt));
  setText(el.sideRunId, row.runIdDisplay);
  renderDiagnostics(row);
}

function renderDiagnostics(row) {
  const projection = row?.diagnostic ?? null;
  setText(el.sideDiagnosticTitle, projection?.title ?? "表示対象の診断情報はありません");
  setText(el.sideDiagnosticSummary, projection?.summary ??
    "これは保存記録の表示であり、現在の接続状態ではありません。");
  setText(el.sideDiagnosticSafety, projection?.safetyMeaning ??
    "診断表示は実行状態や送信可否を変更しません。");
  el.sideDiagnosticDetails?.replaceChildren(...diagnosticDetailsRows(projection).map(([label, value]) => {
    const item = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = label;
    detail.textContent = value;
    item.append(term, detail);
    return item;
  }));
  const entries = projectDiagnostics(diagnosticsRaw, row.runIdDisplay);
  el.sideDiagnostics?.replaceChildren(...entries.map((entry) => {
    const item = document.createElement("li");
    const type = document.createElement("span");
    const technical = diagnosticDetailsRows(entry)
      .filter(([label]) => ["Code", "Elapsed"].includes(label))
      .map(([label, value]) => `${label}: ${value}`)
      .join(" · ");
    type.textContent = technical || entry.title;
    const at = document.createElement("span");
    at.textContent = entry.details?.timestamp ? (formatTimestamp(entry.details.timestamp) ?? "") : "";
    item.append(type, at);
    return item;
  }));
  el.sideDiagnosticsEmpty?.classList.toggle("hidden", entries.length > 0);
}

function render() {
  renderGroupFilter();
  const visible = filterRuns(rows, activeFilter)
    .filter((row) => !activeGroup || row.group === activeGroup);
  if (selectedTabId != null && !rows.some((row) => row.tabId === selectedTabId)) {
    selectedTabId = null;
  }
  renderList(visible);
  renderDetail(rows.find((row) => row.tabId === selectedTabId) ?? null);
}

/* ------------------------------------------------------------------- state */

async function refreshFromStorage() {
  const [snapshot, presentations] = await Promise.all([readRunSnapshot(), readPresentations()]);
  rows = projectRunList(snapshot, { presentations, now: Date.now() });
  const rawDiagnostics = snapshot?.[DIAGNOSTICS_STORAGE_KEY];
  diagnosticsRaw = Array.isArray(rawDiagnostics) ? rawDiagnostics : [];
  render();
}

/* Presentation only. The attribute mapping itself lives in theme.js so all three
   surfaces resolve `mode: "system"` the same way and cannot drift apart. */
const darkQuery = globalThis.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
let storedAppearance = null;

async function applyStoredAppearance() {
  const { settings } = await loadSettings();
  diagnosticsLevel = settings.display.diagnosticsLevel;
  storedAppearance = settings.appearance;
  applyAppearance(document.documentElement, storedAppearance, darkQuery?.matches === true);
  if (el.sideDiagnosticsAdvanced) {
    el.sideDiagnosticsAdvanced.open = diagnosticsLevelIsDetailed(diagnosticsLevel);
  }
  if (selectedTabId != null) render();
}

/*
  Storage changes are the ONLY refresh trigger. There is no timer: a Run cannot
  change without its stored record changing, so polling would add cost without
  adding information — and this surface must never create pressure on a renderer
  that is already being investigated for scheduling stalls.
*/
function onStorageChanged(changes, areaName) {
  if (!changes || typeof changes !== "object") return;
  const keys = Object.keys(changes);

  if (areaName === "local") {
    onWorkspaceEditorStorageChanged(changes, areaName);
    if (keys.some((key) => key === SETTINGS_STORAGE_KEY)) applyStoredAppearance();
    /* Unrelated local keys (diagnostics, flow library, schedules, leases …)
       must not trigger a Run re-render. */
    if (keys.some(isActiveRunKey) || keys.includes(DIAGNOSTICS_STORAGE_KEY)) refreshFromStorage();
    return;
  }
  if (areaName === "session" && keys.includes(TAB_PRESENTATION_STORAGE_KEY)) {
    refreshFromStorage();
  }
}

/*
  View switching is pure DOM class work on markup that is already present. It
  starts no fetch, reads no storage and contacts no renderer, so opening the
  help view costs exactly one class toggle.
*/
function setView(next) {
  const view = ["runs", "editor", "help"].includes(next) ? next : "runs";
  el.viewRuns?.classList.toggle("hidden", view !== "runs");
  el.viewEditor?.classList.toggle("hidden", view !== "editor");
  el.viewHelp?.classList.toggle("hidden", view !== "help");
  /* A separate attribute name: writing data-view here would make the root
     itself match the [data-view] nav selector below. */
  if (el.root) el.root.dataset.activeView = view;
  for (const button of document.querySelectorAll("button[data-view]")) {
    const active = button.dataset.view === view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  }
}

function bind() {
  for (const button of document.querySelectorAll("button[data-view]")) {
    button.addEventListener("click", () => setView(button.dataset.view));
  }

  for (const chip of document.querySelectorAll("[data-filter]")) {
    chip.addEventListener("click", () => {
      const next = chip.dataset.filter;
      if (!STATUS_FILTERS.includes(next)) return;
      activeFilter = next;
      for (const other of document.querySelectorAll("[data-filter]")) {
        other.classList.toggle("is-active", other === chip);
      }
      render();
    });
  }

  el.groupFilter?.addEventListener("change", () => {
    activeGroup = el.groupFilter.value;
    render();
  });

  el.openSettings?.addEventListener("click", () => {
    globalThis.chrome?.runtime?.openOptionsPage?.();
  });

  globalThis.chrome?.storage?.onChanged?.addListener?.(onStorageChanged);

  /* `mode: "system"` must follow the host preference while the page is open.
     Appearance only: it repaints attributes and touches no Run state. */
  darkQuery?.addEventListener?.("change", () => {
    if (storedAppearance) applyAppearance(document.documentElement, storedAppearance, darkQuery.matches === true);
  });
}

async function initialize() {
  setView("runs");
  await applyStoredAppearance();
  await Promise.all([refreshFromStorage(), initializeWorkspaceEditor()]);
  bind();
  el.root?.setAttribute("aria-busy", "false");
}

initialize();
