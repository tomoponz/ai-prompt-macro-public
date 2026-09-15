import {
  DEFAULT_LATE_GRACE_MS,
  QUICK_PRESETS,
  WORKFLOW_PRESETS,
  clonePreset,
  countPlannedSends,
  defaultBlock,
  normalizeWorkflow,
  preflightWorkflowStartSchedule,
  quickConfigToWorkflow
} from "./workflow.js";
import { compileAipmFlow } from "./flow-compile.js";
import { fromDateTimeLocal, toDateTimeLocal } from "./editor-date-time.js";
import { AipmFlowError, MAX_FLOW_TEXT_BYTES } from "./flow-script.js";
import { buildExecutionPlan, EXECUTION_MODES, summarizeExecutionPlan } from "./execution-plan.js";
import {
  canUpdateOpenedFlowLibraryEntry,
  createFlowLibraryEntry,
  deleteFlowLibraryEntry,
  duplicateFlowLibraryEntry,
  exportFlowText,
  FLOW_LIBRARY_STORAGE_KEY,
  isOpenedFlowLibraryDirty,
  loadFlowLibrary,
  markFlowLibraryOpened,
  mutateFlowLibrary,
  normalizeFlowLibrary,
  resolveOpenedFlowLibraryId,
  searchFlowLibrary,
  updateFlowLibraryEntry,
  upsertFlowLibraryEntry,
  validateImportedFlowText
} from "./flow-library.js";
import {
  canResumePausedRun,
  canStartRun,
  completionOutcomeForRun,
  displayDeliveredSendCount,
  projectRunUx
} from "./run-ux.js";
import {
  normalizeRecoveryPolicy,
  recoveryModeDescription,
  recoveryModeLabel,
  recoveryRuntimeBounds
} from "./recovery-policy.js";
import {
  canDispatchTargetIntent,
  chooseInitialTargetId,
  isCurrentTargetRequest,
  retainTargetOnRefresh,
  targetHealth
} from "./target-selection.js";
import { createReadOnlyBackpressure } from "./read-only-backpressure.js";
import {
  UI_STATE_ERROR_CODES,
  UI_STATE_MAP_KEY,
  mutateUiStateForTab,
  observedEditorRevision,
  readUiStateForTab
} from "./ui-state-store.js";
import {
  editorStartSourceKey,
  readStartSourceForTab,
  resolveStartSourceFromEditorEntry
} from "./sidepanel-start-source.js";
import {
  DEFAULT_EDITOR_FLOW_TEXT,
  loadEditorInitialState
} from "./editor-defaults.js";
import {
  diagnosticDetailsRows,
  diagnosticsLevelIsDetailed,
  projectDiagnosticEvent,
  projectRunDiagnostic
} from "./diagnostics-ux.js";
import {
  loadSettings,
  normalizeSettings,
  SETTINGS_STORAGE_KEY
} from "./settings-store.js";
import { startAppearanceSync } from "./theme.js";
import { initializeFlowGuide, renderFlowPlanSteps } from "./sidepanel-flow-view.js";
import { targetDisplayName, targetDisplayState } from "./target-display.js";

const SELECTED_TAB_KEY = "aipm.selectedTab.v1";
const FLOW_PARSE_DEBOUNCE_MS = 250;
const STATUS_REFRESH_TIMEOUT_MS = 4_000;
const START_RECONCILIATION_WINDOW_MS = 15_000;
// The panel has no mutation-authority read in this gate, so one true orphan is the ceiling.
const statusRefreshByTab = createReadOnlyBackpressure({ maxOutstandingPerKey: 1 });
let panelWindowId = null;
const DEFAULT_FLOW_TEXT = DEFAULT_EDITOR_FLOW_TEXT;

const el = {
  targetCard: document.querySelector("#targetCard"),
  savedAutomation: document.querySelector("#savedAutomation"),
  runDetails: document.querySelector("#runDetails"),
  activeRunWarning: document.querySelector("#activeRunWarning"),
  startSection: document.querySelector("#startSection"),
  recoveryPolicyLabel: document.querySelector("#recoveryPolicyLabel"),
  flowSelectorField: document.querySelector("#flowSelectorField"),
  targetTab: document.querySelector("#targetTab"),
  refreshTabs: document.querySelector("#refreshTabs"),
  targetTabHint: document.querySelector("#targetTabHint"),
  targetTechnicalInfo: document.querySelector("#targetTechnicalInfo"),
  keepAwake: document.querySelector("#keepAwake"),
  recoveryMode: document.querySelector("#recoveryMode"),
  recoveryModeDescription: document.querySelector("#recoveryModeDescription"),
  advancedRecovery: document.querySelector("#advancedRecovery"),
  identityRetries: document.querySelector("#identityRetries"),
  readinessRecovery: document.querySelector("#readinessRecovery"),
  statusRecovery: document.querySelector("#statusRecovery"),
  quickTab: document.querySelector("#quickTab"),
  workflowTab: document.querySelector("#workflowTab"),
  flowTab: document.querySelector("#flowTab"),
  quickPanel: document.querySelector("#quickPanel"),
  workflowPanel: document.querySelector("#workflowPanel"),
  flowPanel: document.querySelector("#flowPanel"),
  flowEntryPanel: document.querySelector("#flowEntryPanel"),
  flowInputStatus: document.querySelector("#flowInputStatus"),
  flowPreviewTarget: document.querySelector("#flowPreviewTarget"),
  flowSavedRange: document.querySelector("#flowSavedRange"),
  flowPlanSteps: document.querySelector("#flowPlanSteps"),
  quickPreset: document.querySelector("#quickPreset"),
  quickPrompt: document.querySelector("#quickPrompt"),
  quickRepeat: document.querySelector("#quickRepeat"),
  quickDelay: document.querySelector("#quickDelay"),
  workflowPreset: document.querySelector("#workflowPreset"),
  loadPreset: document.querySelector("#loadPreset"),
  workflowName: document.querySelector("#workflowName"),
  workflowMaxSends: document.querySelector("#workflowMaxSends"),
  steps: document.querySelector("#steps"),
  addPrompt: document.querySelector("#addPrompt"),
  addDelay: document.querySelector("#addDelay"),
  addWaitUntil: document.querySelector("#addWaitUntil"),
  addCheckpoint: document.querySelector("#addCheckpoint"),
  flowText: document.querySelector("#flowText"),
  flowSelector: document.querySelector("#flowSelector"),
  flowExecutionMode: document.querySelector("#flowExecutionMode"),
  flowRangeControls: document.querySelector("#flowRangeControls"),
  flowRangeStart: document.querySelector("#flowRangeStart"),
  flowRangeEnd: document.querySelector("#flowRangeEnd"),
  flowRangeRepeat: document.querySelector("#flowRangeRepeat"),
  flowCheckpointControls: document.querySelector("#flowCheckpointControls"),
  flowCheckpoint: document.querySelector("#flowCheckpoint"),
  flowPartialWarning: document.querySelector("#flowPartialWarning"),
  flowPlanError: document.querySelector("#flowPlanError"),
  flowPlannedSends: document.querySelector("#flowPlannedSends"),
  flowBlockCount: document.querySelector("#flowBlockCount"),
  flowPreviewName: document.querySelector("#flowPreviewName"),
  flowPreviewSelected: document.querySelector("#flowPreviewSelected"),
  flowPreviewRange: document.querySelector("#flowPreviewRange"),
  flowPreviewRepeat: document.querySelector("#flowPreviewRepeat"),
  flowPreviewWaits: document.querySelector("#flowPreviewWaits"),
  flowPreviewCheckpoints: document.querySelector("#flowPreviewCheckpoints"),
  flowPreviewRecovery: document.querySelector("#flowPreviewRecovery"),
  flowError: document.querySelector("#flowError"),
  copyFlow: document.querySelector("#copyFlow"),
  copyFlowStatus: document.querySelector("#copyFlowStatus"),
  flowLibrarySearch: document.querySelector("#flowLibrarySearch"),
  flowLibraryList: document.querySelector("#flowLibraryList"),
  flowLibraryName: document.querySelector("#flowLibraryName"),
  flowLibraryDescription: document.querySelector("#flowLibraryDescription"),
  flowLibraryFavorite: document.querySelector("#flowLibraryFavorite"),
  flowLibrarySaveNew: document.querySelector("#flowLibrarySaveNew"),
  flowLibraryUpdate: document.querySelector("#flowLibraryUpdate"),
  flowLibraryOpen: document.querySelector("#flowLibraryOpen"),
  flowLibraryDuplicate: document.querySelector("#flowLibraryDuplicate"),
  flowLibraryRename: document.querySelector("#flowLibraryRename"),
  flowLibraryDelete: document.querySelector("#flowLibraryDelete"),
  flowLibraryCopy: document.querySelector("#flowLibraryCopy"),
  flowLibraryShare: document.querySelector("#flowLibraryShare"),
  flowLibraryStatus: document.querySelector("#flowLibraryStatus"),
  flowImportText: document.querySelector("#flowImportText"),
  flowImportPaste: document.querySelector("#flowImportPaste"),
  flowImportFile: document.querySelector("#flowImportFile"),
  flowExportFile: document.querySelector("#flowExportFile"),
  flowImportStatus: document.querySelector("#flowImportStatus"),
  flowStart: document.querySelector("#flowStart"),
  flowStartReason: document.querySelector("#flowStartReason"),
  savedAutomationMode: document.querySelector("#savedAutomationMode"),
  savedAutomationSummary: document.querySelector("#savedAutomationSummary"),
  start: document.querySelector("#start"),
  pause: document.querySelector("#pause"),
  resume: document.querySelector("#resume"),
  stop: document.querySelector("#stop"),
  runCard: document.querySelector("#runCard"),
  statusBadge: document.querySelector("#statusBadge"),
  connectionStatus: document.querySelector("#connectionStatus"),
  progress: document.querySelector("#progress"),
  progressBar: document.querySelector("#progressBar"),
  message: document.querySelector("#message"),
  completionOutcome: document.querySelector("#completionOutcome"),
  nextAction: document.querySelector("#nextAction"),
  diagnosticsSeverity: document.querySelector("#diagnosticsSeverity"),
  diagnosticsTitle: document.querySelector("#diagnosticsTitle"),
  diagnosticsSummary: document.querySelector("#diagnosticsSummary"),
  diagnosticsSafety: document.querySelector("#diagnosticsSafety"),
  diagnosticsAdvanced: document.querySelector("#diagnosticsAdvanced"),
  diagnosticsDetails: document.querySelector("#diagnosticsDetails"),
  diagnostics: document.querySelector("#diagnostics"),
  editorStateNotice: document.querySelector("#editorStateNotice")
};

let mode = "quick";
let customWorkflow = clonePreset("continuous-improvement");
let draggedIndex = null;
let selectedTabId = null;
let knownTabs = [];
let suppressUiSave = false;
let tabRefreshInFlight = false;
let tabDiscoveryInfo = { serviceWorkerVersion: null, siteAccessGranted: null, failedChatGptTabs: 0 };
let diagnosticsLevel = "summary";
let targetEpoch = 0;
let pendingTargetSwitches = 0;
let targetSwitchQueue = Promise.resolve();
let uiSaveQueue = Promise.resolve();
// Editor-state fence. `targetEditorRevision` is the revision restoreUiState read
// for `targetEditorRevisionTabId`; every save presents it as its expected value
// and adopts the revision the write returns. This is editor state only and is
// unrelated to the Run's stateRevision, which lives in background.js.
let targetEditorRevision = 0;
let targetEditorRevisionTabId = null;
let targetEditorStale = false;
let targetEditorExternalChangeVersion = 0;
let pendingEditorOwnRevision = null;
let editorStateNotice = null;
let editorSavedKey = null;
let editorEditVersion = 0;
let editorReloadInFlight = false;
let flowCompiledText = null;
let reviewedFlowKey = null;
let flowRestoreError = false;
let invalidRestoredFlow;
let startIntentInFlight = false;
// Panel-local uncertainty, never Run authority. Switching targets must not make
// a still-delivered Start retryable when the user comes back to that tab.
const pendingStartsByTab = new Map();
let targetUiReady = false;
let runControlIntentInFlight = false;
let renderedRunControlSnapshot = null;
// A single exact active-Run observation is retained only for the monotonic Stop path.
// It is fenced by tabId + targetEpoch + runId and is never used by Start/Pause/Resume.
let durableStopSnapshot = null;
let lastStatusPayload = null;
// Only a payload that a completed observation actually produced. Never an erased placeholder,
// so a retained presentation can only ever show something the target tab really reported.
let lastConfirmedStatusPayload = null;
let statusPresentationStale = false;

// A refresh that was refused because a previous observation is still in flight, or that ran
// out of its own budget, says nothing about the tab. It only says we did not get to look.
// Erasing a confirmed presentation for it makes a healthy Run flicker through "確認できません".
// Every other failure — identity, lifecycle, a tab that is gone — is a real state change and
// must still erase.
const TRANSIENT_STATUS_OBSERVATION_CODES = Object.freeze([
  "READ_ONLY_CONTACT_BUSY",
  "READ_ONLY_BACKOFF",
  "READ_ONLY_CONTACT_EXPIRED",
  "RUN_OBSERVATION_TIMEOUT",
  "TAB_STATUS_TIMEOUT",
  "STATUS_REFRESH_TIMEOUT"
]);

function isTransientStatusObservationFailure(error) {
  return TRANSIENT_STATUS_OBSERVATION_CODES.includes(String(error?.code ?? "").toUpperCase());
}
let flowCompilation = null;
let flowSelectedIndex = 0;
let flowExecutionPlan = null;
let flowExecutionConfig = { mode: "full", start: "1", end: "1", repeat: "1", checkpointId: "" };
let flowParseTimer = null;
let flowParseEpoch = 0;
let flowLibrary = { schemaVersion: 1, entries: [] };
let selectedFlowLibraryId = null;
let openedFlowLibraryId = null;
let openedFlowLibraryRevision = null;
let flowLibraryOperationInFlight = false;
let recoveryPolicy = normalizeRecoveryPolicy();

for (const preset of QUICK_PRESETS) {
  const option = document.createElement("option");
  option.value = preset.id;
  option.textContent = preset.label;
  el.quickPreset.append(option);
}
for (const preset of WORKFLOW_PRESETS) {
  const option = document.createElement("option");
  option.value = preset.id;
  option.textContent = preset.name;
  el.workflowPreset.append(option);
}

function currentRecoveryPolicy() {
  recoveryPolicy = normalizeRecoveryPolicy({
    mode: el.recoveryMode.value,
    identityAttempts: el.identityRetries.value,
    readiness: el.readinessRecovery.value,
    statusRecovery: el.statusRecovery.value
  });
  return recoveryPolicy;
}

function renderRecoveryControls() {
  el.recoveryMode.value = recoveryPolicy.mode;
  el.identityRetries.value = String(recoveryPolicy.identityAttempts);
  el.readinessRecovery.value = recoveryPolicy.readiness;
  el.statusRecovery.value = recoveryPolicy.statusRecovery;
  el.advancedRecovery.classList.toggle("hidden", recoveryPolicy.mode !== "completion");
  el.recoveryModeDescription.textContent = recoveryModeDescription(recoveryPolicy);
  el.recoveryPolicyLabel.textContent = recoveryModeLabel(recoveryPolicy);
  renderFlowPreview();
}

const SAVED_MODE_LABELS = Object.freeze({
  quick: "クイック",
  workflow: "ワークフロー",
  flow: "Flow"
});

function renderSavedStartSource(source, summaryOverride = null) {
  if (!el.savedAutomationMode || !el.savedAutomationSummary) return;
  el.savedAutomationMode.textContent = SAVED_MODE_LABELS[source?.mode] ?? "確認が必要";
  el.savedAutomationSummary.textContent = summaryOverride ?? (source?.summary
    ? `· ${source.summary.plannedSends}送信`
    : "保存済みの実行内容を検証できません。");
  el.savedAutomation.dataset.attention = String(!source?.summary);
}

function renderSavedAutomationEntry(entry, { exists = Boolean(entry) } = {}) {
  if (!exists || !entry) {
    renderSavedStartSource(
      { mode: "quick", summary: null },
      "まだありません"
    );
    el.savedAutomationMode.textContent = "";
    el.savedAutomation.dataset.attention = "false";
    return;
  }
  try {
    const source = resolveStartSourceFromEditorEntry(entry);
    renderSavedStartSource(source);
  } catch {
    renderSavedStartSource(
      { mode: entry?.mode, summary: null },
      "保存済みの実行内容を読み取れません。開始せず、ワークスペースで修正してください。"
    );
  }
}

function setMode(nextMode) {
  if (!suppressUiSave) editorEditVersion += 1;
  mode = ["quick", "workflow", "flow"].includes(nextMode) ? nextMode : "quick";
  el.quickPanel.classList.toggle("hidden", mode !== "quick");
  /* Full Workflow/library/range editing remains in Workspace. Only the small
     Flow input and production plan preview are exposed here. */
  el.workflowPanel.classList.add("hidden");
  el.flowPanel.classList.add("hidden");
  el.flowEntryPanel.classList.toggle("hidden", mode !== "flow");
  el.quickTab.classList.toggle("active", mode === "quick");
  el.workflowTab.classList.remove("active");
  el.flowTab.classList.remove("active");
  el.quickTab.setAttribute("aria-pressed", String(mode === "quick"));
  el.flowTab.setAttribute("aria-pressed", String(mode === "flow"));
  renderFlowPreview();
  if (lastStatusPayload) renderStatus(lastStatusPayload);
  if (!suppressUiSave && mode !== "flow") saveUiState();
}

function titleForStep(step) {
  if (step.type === "wait-until") return "指定時刻まで待つ";
  if (step.type === "delay") return "待機";
  if (step.type === "checkpoint") return "確認ポイント";
  return step.delivery === "draft" ? "AIへの指示 · 入力だけして確認" : "AIへの指示 · 送信";
}

function controlGroup(labelText, control) {
  const group = document.createElement("div");
  const label = document.createElement("label");
  label.textContent = labelText;
  group.append(label, control);
  return group;
}

function selectControl(options, value) {
  const select = document.createElement("select");
  for (const [optionValue, label] of options) {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = label;
    select.append(option);
  }
  select.value = value;
  return select;
}

function createPromptBody(step) {
  const body = document.createElement("div");
  body.className = "step-body";

  const textarea = document.createElement("textarea");
  textarea.className = "step-prompt";
  textarea.rows = 3;
  textarea.spellcheck = false;
  textarea.value = step.prompt ?? "";
  textarea.addEventListener("input", () => {
    step.prompt = textarea.value;
    saveUiState();
  });
  body.append(controlGroup("AIへの指示", textarea));

  const controls = document.createElement("div");
  controls.className = "step-controls";

  const delivery = selectControl([
    ["send", "入力して送信"],
    ["draft", "入力だけして確認"]
  ], step.delivery === "draft" ? "draft" : "send");
  delivery.addEventListener("change", () => {
    step.delivery = delivery.value;
    if (step.delivery === "draft") {
      step.repeat = 1;
      step.delayAfterMs = 0;
    }
    renderWorkflowEditor();
    saveUiState();
  });

  const repeat = document.createElement("input");
  repeat.type = "number";
  repeat.min = "1";
  repeat.max = "50";
  repeat.value = String(step.repeat ?? 1);
  repeat.disabled = step.delivery === "draft";
  repeat.addEventListener("change", () => {
    step.repeat = Number.parseInt(repeat.value, 10) || 1;
    syncMaxSends();
    saveUiState();
  });

  const delay = document.createElement("input");
  delay.type = "number";
  delay.min = "0";
  delay.max = "300";
  delay.step = "0.5";
  delay.value = String(Number(step.delayAfterMs ?? 0) / 1000);
  delay.disabled = step.delivery === "draft";
  delay.addEventListener("change", () => {
    step.delayAfterMs = Math.round((Number(delay.value) || 0) * 1000);
    saveUiState();
  });

  controls.append(
    controlGroup("動作", delivery),
    controlGroup("繰り返し回数", repeat),
    controlGroup("完了後の待機（秒）", delay)
  );
  body.append(controls);

  if (step.delivery === "draft") {
    const note = document.createElement("p");
    note.className = "step-note";
    note.textContent = "「入力だけして確認」は入力欄へ指示を入れるだけで送信せず、確認待ちで一時停止します。";
    body.append(note);
  }
  return body;
}

function createDelayBody(step) {
  const body = document.createElement("div");
  body.className = "step-body";
  const controls = document.createElement("div");
  controls.className = "step-controls";

  const amount = document.createElement("input");
  amount.type = "number";
  amount.min = "0";
  amount.max = "86400";
  amount.step = "1";
  amount.value = String(Math.round(Number(step.durationMs ?? 5000) / 1000));
  amount.addEventListener("change", () => {
    step.durationMs = Math.max(0, Math.round((Number(amount.value) || 0) * 1000));
    saveUiState();
  });

  controls.append(controlGroup("待機時間（秒）", amount));
  body.append(controls);
  return body;
}

function createWaitUntilBody(step) {
  const body = document.createElement("div");
  body.className = "step-body";

  const when = document.createElement("input");
  when.type = "datetime-local";
  when.value = toDateTimeLocal(step.at ?? new Date(Date.now() + 3600000).toISOString());
  when.addEventListener("change", () => {
    step.at = fromDateTimeLocal(when.value);
    saveUiState();
  });
  body.append(controlGroup("実行時刻", when));

  const controls = document.createElement("div");
  controls.className = "step-controls";

  const latePolicy = selectControl([
    ["pause", "確認して停止"],
    ["run", "遅れても実行"],
    ["skip", "遅れたらスキップ"]
  ], step.latePolicy ?? "pause");
  latePolicy.addEventListener("change", () => {
    step.latePolicy = latePolicy.value;
    saveUiState();
  });

  const grace = document.createElement("input");
  grace.type = "number";
  grace.min = "0";
  grace.max = "1440";
  grace.value = String(Math.round(Number(step.graceMs ?? DEFAULT_LATE_GRACE_MS) / 60000));
  grace.addEventListener("change", () => {
    step.graceMs = Math.max(0, Math.round((Number(grace.value) || 0) * 60000));
    saveUiState();
  });

  controls.append(controlGroup("遅れたとき", latePolicy), controlGroup("許容する遅れ（分）", grace));
  body.append(controls);

  const note = document.createElement("p");
  note.className = "step-note";
  note.textContent = "PCスリープなどで許容時間を超えて遅れた場合の動きを指定します。";
  body.append(note);
  return body;
}

function createCheckpointBody(step) {
  const body = document.createElement("div");
  body.className = "step-body";
  const input = document.createElement("input");
  input.value = step.label ?? "確認してから続行";
  input.addEventListener("input", () => {
    step.label = input.value;
    saveUiState();
  });
  body.append(controlGroup("確認時のメッセージ", input));
  return body;
}

function moveStep(index, delta) {
  const next = index + delta;
  if (next < 0 || next >= customWorkflow.steps.length) return;
  const [item] = customWorkflow.steps.splice(index, 1);
  customWorkflow.steps.splice(next, 0, item);
  renderWorkflowEditor();
  saveUiState();
}

function createStepElement(step, index) {
  const wrapper = document.createElement("div");
  wrapper.className = `step type-${step.type}`;
  wrapper.dataset.index = String(index);
  wrapper.draggable = true;

  const head = document.createElement("div");
  head.className = "step-head";

  const titleWrap = document.createElement("div");
  titleWrap.className = "step-title-wrap";
  const number = document.createElement("span");
  number.className = "step-number";
  number.textContent = String(index + 1);
  const title = document.createElement("span");
  title.className = "step-title";
  title.textContent = titleForStep(step);
  titleWrap.append(number, title);

  const actions = document.createElement("div");
  actions.className = "step-actions";
  for (const [label, delta, aria] of [["↑", -1, "上へ移動"], ["↓", 1, "下へ移動"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button";
    button.textContent = label;
    button.setAttribute("aria-label", aria);
    button.disabled = delta < 0 ? index === 0 : index === customWorkflow.steps.length - 1;
    button.addEventListener("click", () => moveStep(index, delta));
    actions.append(button);
  }
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "icon-button";
  remove.textContent = "×";
  remove.setAttribute("aria-label", "手順を削除");
  remove.addEventListener("click", () => {
    customWorkflow.steps.splice(index, 1);
    syncMaxSends();
    renderWorkflowEditor();
    saveUiState();
  });
  actions.append(remove);

  head.append(titleWrap, actions);
  wrapper.append(head);

  if (step.type === "delay") wrapper.append(createDelayBody(step));
  else if (step.type === "wait-until") wrapper.append(createWaitUntilBody(step));
  else if (step.type === "checkpoint") wrapper.append(createCheckpointBody(step));
  else wrapper.append(createPromptBody(step));

  wrapper.addEventListener("dragstart", (event) => {
    draggedIndex = index;
    wrapper.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
  });
  wrapper.addEventListener("dragend", () => {
    draggedIndex = null;
    wrapper.classList.remove("dragging");
    for (const node of el.steps.querySelectorAll(".drop-target")) node.classList.remove("drop-target");
  });
  wrapper.addEventListener("dragover", (event) => {
    event.preventDefault();
    wrapper.classList.add("drop-target");
  });
  wrapper.addEventListener("dragleave", () => wrapper.classList.remove("drop-target"));
  wrapper.addEventListener("drop", (event) => {
    event.preventDefault();
    wrapper.classList.remove("drop-target");
    if (draggedIndex == null || draggedIndex === index) return;
    const [item] = customWorkflow.steps.splice(draggedIndex, 1);
    const target = draggedIndex < index ? index - 1 : index;
    customWorkflow.steps.splice(target, 0, item);
    renderWorkflowEditor();
    saveUiState();
  });

  return wrapper;
}

function syncMaxSends() {
  const sends = countPlannedSends(customWorkflow);
  customWorkflow.maxSends = Math.min(50, Math.max(Number(customWorkflow.maxSends ?? 1), sends || 1));
  el.workflowMaxSends.value = String(customWorkflow.maxSends);
}

function renderWorkflowEditor() {
  el.workflowName.value = customWorkflow.name ?? "カスタム自動化フロー";
  syncMaxSends();
  el.steps.replaceChildren(...customWorkflow.steps.map(createStepElement));
}

function syncWorkflowMeta() {
  customWorkflow.name = el.workflowName.value.trim() || "カスタム自動化フロー";
  customWorkflow.maxSends = Number.parseInt(el.workflowMaxSends.value, 10) || 1;
}

function selectedCompiledFlow() {
  return flowCompilation?.flows?.[flowSelectedIndex] ?? null;
}

function boundedFlowName(value) {
  const name = String(value ?? "");
  return name.length <= 80 ? name : `${name.slice(0, 80)}…`;
}

function syncFlowExecutionConfigFromUi() {
  flowExecutionConfig = {
    mode: el.flowExecutionMode.value,
    start: el.flowRangeStart.value,
    end: el.flowRangeEnd.value,
    repeat: el.flowRangeRepeat.value,
    checkpointId: el.flowCheckpoint.value
  };
  return flowExecutionConfig;
}

function renderFlowExecutionControls() {
  const compiled = selectedCompiledFlow();
  const steps = compiled?.workflow?.steps ?? [];
  const total = Math.max(1, steps.length);
  el.flowExecutionMode.value = flowExecutionConfig.mode;
  el.flowRangeStart.max = String(total);
  el.flowRangeEnd.max = String(total);
  el.flowRangeStart.value = flowExecutionConfig.start;
  el.flowRangeEnd.value = flowExecutionConfig.end;
  el.flowRangeRepeat.value = flowExecutionConfig.repeat;

  const mode = flowExecutionConfig.mode;
  el.flowRangeControls.classList.toggle("hidden", !["step", "from", "range", "range-repeat"].includes(mode));
  el.flowRangeEnd.parentElement.classList.toggle("hidden", ["step", "from"].includes(mode));
  el.flowRangeRepeat.parentElement.classList.toggle("hidden", mode !== "range-repeat");
  el.flowCheckpointControls.classList.toggle("hidden", mode !== "after-checkpoint");
  el.flowPartialWarning.hidden = mode === "full";

  const checkpoints = steps.filter((step) => step.type === "checkpoint");
  const options = checkpoints.map((step, index) => {
    const option = document.createElement("option");
    option.value = step.id;
    option.textContent = `${index + 1}. ${step.label}`;
    return option;
  });
  el.flowCheckpoint.replaceChildren(...options);
  if (checkpoints.some((step) => step.id === flowExecutionConfig.checkpointId)) {
    el.flowCheckpoint.value = flowExecutionConfig.checkpointId;
  } else if (flowExecutionConfig.mode !== "after-checkpoint") {
    flowExecutionConfig.checkpointId = checkpoints[0]?.id ?? "";
    el.flowCheckpoint.value = flowExecutionConfig.checkpointId;
  } else {
    // A saved partial selection must never silently move to another checkpoint.
    el.flowCheckpoint.value = "";
  }
}

function rebuildFlowExecutionPlan({ persist = false } = {}) {
  const compiled = selectedCompiledFlow();
  flowExecutionPlan = null;
  el.flowPlanError.textContent = "";
  el.flowPlanError.hidden = true;
  if (compiled) {
    try {
      flowExecutionPlan = buildExecutionPlan(compiled, syncFlowExecutionConfigFromUi());
    } catch (error) {
      el.flowPlanError.textContent = error instanceof Error ? error.message : "部分実行planを安全に作成できませんでした。";
      el.flowPlanError.hidden = false;
    }
  }
  renderFlowPreview();
  if (lastStatusPayload) renderStatus(lastStatusPayload);
  else {
    el.start.disabled = true;
    el.flowStart.disabled = true;
  }
  if (persist && !suppressUiSave) saveUiState();
}

function renderFlowPreview() {
  const summary = summarizeExecutionPlan(selectedCompiledFlow(), flowExecutionPlan);
  el.flowPreviewName.textContent = summary?.flowName || "-";
  el.flowPreviewSelected.textContent = summary?.selectedFlow || "-";
  el.flowPreviewRange.textContent = summary?.executionRange || "Flow全体";
  el.flowPlannedSends.textContent = summary ? String(summary.plannedSends) : "-";
  el.flowBlockCount.textContent = summary ? String(summary.blocks) : "-";
  el.flowPreviewRepeat.textContent = summary
    ? summary.repeatCycles > 1
      ? `選択範囲 × ${summary.repeatCycles}`
      : `${summary.repeatCommands} command`
    : "-";
  el.flowPreviewWaits.textContent = summary
    ? `${summary.waits}（相対 ${summary.delaySteps} / 指定時刻 ${summary.waitUntilSteps}）`
    : "-";
  el.flowPreviewCheckpoints.textContent = summary ? String(summary.checkpoints) : "-";
  el.flowPreviewRecovery.textContent = recoveryModeLabel(recoveryPolicy);
  renderFlowPlanSteps(el.flowPlanSteps, flowExecutionPlan);
  reviewedFlowKey = summary && flowCompiledText === el.flowText.value ? currentFlowReviewKey() : null;
  el.flowPreviewTarget.textContent = Number.isInteger(selectedTabId)
    ? `実行対象: ${targetDisplayName(knownTabs.find((tab) => tab.tabId === selectedTabId) ?? { tabId: selectedTabId })}`
    : "実行対象は未選択です。入力はまだどのタブにも保存されません。";
  el.flowSavedRange.hidden = flowExecutionConfig.mode === "full";
  el.flowSavedRange.textContent = flowExecutionPlan?.partial
    ? `保存済みの部分実行: ${flowExecutionPlan.rangeLabel}。上の範囲だけを実行します。範囲の変更はワークスペースで行ってください。本文を書き換えると新しいFlow全体の確認に戻ります。`
    : flowExecutionConfig.mode !== "full"
      ? "保存済みの部分実行を確認できません。ワークスペースで範囲を修正してください。"
      : "";
  renderFlowInputStatus();
}

function currentFlowReviewKey() {
  return JSON.stringify([selectedTabId, targetEpoch, el.flowText.value, flowSelectedIndex, flowExecutionConfig]);
}

function renderFlowInputStatus() {
  el.flowInputStatus.textContent = startIntentInFlight ? "開始準備中です。確認した内容を保存・照合しています。"
    : targetEditorStale ? "編集内容が競合しています。入力は保持しています。内容を確認し直してください。"
    : reviewedFlowKey ? "✓ 形式と上限を確認済み · 指示の内容を確認してください"
    : flowParseTimer ? "編集中です。形式と上限を確認しています。"
    : "形式と上限の確認が必要です。下のエラー箇所を直してください。";
}

function renderFlowCompilation({ persist = false } = {}) {
  flowParseEpoch += 1;
  clearTimeout(flowParseTimer);
  flowParseTimer = null;

  try {
    if (flowRestoreError) throw new Error("invalid-saved-flow");
    flowCompilation = compileAipmFlow(el.flowText.value);
    flowCompiledText = el.flowText.value;
    flowSelectedIndex = Math.min(
      Math.max(0, Number.isInteger(flowSelectedIndex) ? flowSelectedIndex : 0),
      flowCompilation.flows.length - 1
    );
    const options = flowCompilation.flows.map((flow, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = boundedFlowName(flow.name);
      return option;
    });
    el.flowSelector.replaceChildren(...options);
    el.flowSelector.value = String(flowSelectedIndex);
    el.flowSelector.disabled = options.length <= 1;
    el.flowSelectorField.hidden = options.length <= 1;
    renderFlowExecutionControls();
    rebuildFlowExecutionPlan();
    el.flowError.textContent = "";
    el.flowError.hidden = true;
  } catch (error) {
    flowCompiledText = null;
    flowCompilation = null;
    flowExecutionPlan = null;
    el.flowSelector.replaceChildren();
    el.flowSelector.disabled = true;
    el.flowSelectorField.hidden = true;
    renderFlowExecutionControls();
    renderFlowPreview();
    el.flowError.textContent = flowRestoreError
      ? "保存済みのFlow・選択・実行範囲を確認できません。ワークスペースで修正するか、実行するFlow本文を貼り付け直して全体を確認してください。既定の内容では開始しません。"
      : error instanceof AipmFlowError
      ? `${error.code} · ${error.line}行 ${error.column}列\n${error.message}\nこの位置の構文や上限を確認し、Flowだけを入力してください。`
      : "FLOW_COMPILE_FAILED · Flowを安全に解析できませんでした。";
    el.flowError.hidden = false;
  }

  if (lastStatusPayload) renderStatus(lastStatusPayload);
  else {
    el.start.disabled = true;
    el.flowStart.disabled = true;
  }
  if (persist && !suppressUiSave) saveUiState();
}

function scheduleFlowCompilation() {
  editorEditVersion += 1;
  flowRestoreError = false;
  flowSelectedIndex = 0;
  flowExecutionConfig = { mode: "full", start: "1", end: "1", repeat: "1", checkpointId: "" };
  const epoch = ++flowParseEpoch;
  clearTimeout(flowParseTimer);
  flowCompilation = null;
  flowExecutionPlan = null;
  flowCompiledText = null;
  renderFlowPreview();
  el.flowError.textContent = "Flowを解析しています。";
  el.flowError.hidden = false;
  if (lastStatusPayload) renderStatus(lastStatusPayload);
  else {
    el.start.disabled = true;
    el.flowStart.disabled = true;
  }
  flowParseTimer = setTimeout(() => {
    if (epoch !== flowParseEpoch) return;
    renderFlowCompilation();
  }, FLOW_PARSE_DEBOUNCE_MS);
  renderFlowInputStatus();
}

function selectedFlowLibraryEntry() {
  return flowLibrary.entries.find((entry) => entry.id === selectedFlowLibraryId) ?? null;
}

function renderFlowLibrary() {
  const entries = searchFlowLibrary(flowLibrary, el.flowLibrarySearch.value);
  openedFlowLibraryId = resolveOpenedFlowLibraryId(flowLibrary, openedFlowLibraryId);
  if (!openedFlowLibraryId) openedFlowLibraryRevision = null;
  if (!entries.some((entry) => entry.id === selectedFlowLibraryId)) {
    selectedFlowLibraryId = entries[0]?.id ?? null;
  }
  const options = entries.map((entry) => {
    const option = document.createElement("option");
    option.value = entry.id;
    const recent = entry.lastOpenedAt > 0 ? ` · Recent ${new Date(entry.lastOpenedAt).toLocaleDateString()}` : "";
    option.textContent = `${entry.favorite ? "★ " : ""}${entry.name}${recent}`;
    return option;
  });
  el.flowLibraryList.replaceChildren(...options);
  if (selectedFlowLibraryId) el.flowLibraryList.value = selectedFlowLibraryId;
  const selected = selectedFlowLibraryEntry();
  el.flowLibraryName.value = selected?.name ?? "";
  el.flowLibraryDescription.value = selected?.description ?? "";
  el.flowLibraryFavorite.checked = selected?.favorite === true;
  el.flowLibraryUpdate.disabled = !canUpdateOpenedFlowLibraryEntry(
    flowLibrary,
    selectedFlowLibraryId,
    openedFlowLibraryId
  );
  for (const node of [
    el.flowLibraryOpen,
    el.flowLibraryDuplicate,
    el.flowLibraryRename,
    el.flowLibraryDelete,
    el.flowLibraryCopy,
    el.flowLibraryShare
  ]) node.disabled = !selected;
}

async function saveFlowLibraryState(message, mutation, expectedRevision) {
  flowLibrary = await mutateFlowLibrary(mutation, { expectedRevision });
  if (resolveOpenedFlowLibraryId(flowLibrary, openedFlowLibraryId)) {
    openedFlowLibraryRevision = flowLibrary.revision;
  }
  renderFlowLibrary();
  el.flowLibraryStatus.textContent = message;
}

function requireFreshFlowLibraryEntry(library, id, action) {
  const entry = library.entries.find((item) => item.id === id) ?? null;
  if (!entry) throw new Error(`${action}するLibrary entryは既に削除または変更されています。`);
  return entry;
}

function libraryMetadataFromUi() {
  return {
    name: el.flowLibraryName.value,
    description: el.flowLibraryDescription.value,
    favorite: el.flowLibraryFavorite.checked === true
  };
}

function safeFlowFilename(name) {
  const base = String(name ?? "aipm-flow").trim().replace(/[<>:"/\\|?*\x00-\x1F]+/g, "-").slice(0, 80);
  return `${base || "aipm-flow"}.aipm.txt`;
}

function downloadFlowText(source, name) {
  const url = URL.createObjectURL(new Blob([source], { type: "text/plain;charset=utf-8" }));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = safeFlowFilename(name);
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function importFlowSource(source, originLabel) {
  const validated = validateImportedFlowText(source);
  el.flowText.value = validated;
  selectedFlowLibraryId = null;
  openedFlowLibraryId = null;
  renderFlowLibrary();
  flowSelectedIndex = 0;
  flowExecutionConfig = { mode: "full", start: "1", end: "1", repeat: "1", checkpointId: "" };
  renderFlowCompilation({ persist: true });
  setMode("flow");
  el.flowImportStatus.textContent = `${originLabel}を検証しました。読み込みだけではRunを開始しません。`;
}

async function initializeFlowLibrary() {
  flowLibrary = await loadFlowLibrary();
  renderFlowLibrary();
}

async function sendToContent(message, targetTabId = selectedTabId, expectedEpoch = targetEpoch, onDispatch = null) {
  if (!Number.isInteger(targetTabId)) {
    throw new Error("操作対象のChatGPTタブを選択してください。");
  }
  if (message?.type !== "AIPM_GET_STATUS") {
    if (!targetUiReady) {
      throw new Error("選択したタブの編集状態を復元できていないため、安全のため操作を停止しました。");
    }
    if (!canDispatchTargetIntent(
      targetTabId,
      expectedEpoch,
      selectedTabId,
      targetEpoch,
      pendingTargetSwitches,
      targetUiReady
    )) {
      throw new Error("操作対象が変更されたため、安全のため送信を中止しました。");
    }
    const health = targetHealth(targetTabId, knownTabs, tabDiscoveryInfo.serviceWorkerVersion);
    if (message?.type !== "AIPM_STOP" && !health.ready) {
      throw new Error("固定した対象タブの接続を安全に確認できません。別のタブへ自動切替せず停止しました。");
    }
  }
  try {
    onDispatch?.();
    const response = await chrome.runtime.sendMessage({
      type: "AIPM_RELAY_TO_CHATGPT",
      targetTabId,
      payload: message
    });
    if (!response?.ok && response?.relayError) {
      const relayErrorCode = typeof response?.relayErrorCode === "string" && /^[A-Z0-9_]{1,64}$/.test(response.relayErrorCode)
        ? response.relayErrorCode
        : null;
      window.dispatchEvent(new CustomEvent("aipm:connection-diagnostic", {
        detail: { relayErrorCode, tabId: targetTabId, requestType: message?.type }
      }));
      const relayError = new Error(response.relayError);
      if (relayErrorCode) relayError.code = relayErrorCode;
      if (["read-only-observation", "run-observation"].includes(response?.relayErrorPhase)) {
        relayError.phase = response.relayErrorPhase;
      }
      if (Number.isFinite(response?.retryAfterMs) && response.retryAfterMs >= 0) {
        relayError.retryAfterMs = Math.min(60_000, Math.ceil(response.retryAfterMs));
      }
      throw relayError;
    }
    if (message?.type === "AIPM_GET_STATUS" && response?.ok === true) {
      window.dispatchEvent(new CustomEvent("aipm:connection-diagnostic-success", {
        detail: { tabId: targetTabId, requestType: message.type }
      }));
    }
    return response;
  } catch (error) {
    if (error instanceof Error && error.message && !error.message.includes("Could not establish connection")) {
      throw error;
    }
    throw new Error("選択したChatGPTタブへ接続できません。ページを再読み込みしてください。");
  }
}

function currentUiState() {
  syncWorkflowMeta();
  return {
    mode,
    keepAwake: el.keepAwake?.checked === true,
    recovery: { ...currentRecoveryPolicy() },
    quick: {
      preset: el.quickPreset.value,
      prompt: el.quickPrompt.value,
      repeat: el.quickRepeat.value,
      delay: el.quickDelay.value
    },
    workflow: customWorkflow,
    flow: flowRestoreError ? invalidRestoredFlow : {
      text: el.flowText.value,
      selectedIndex: flowSelectedIndex,
      openedLibraryId: openedFlowLibraryId,
      execution: { ...flowExecutionConfig }
    }
  };
}

/*
  Editor-state notice. Bounded, display only, and never a Run message: it uses
  its own element so refreshStatus() cannot overwrite it and it cannot be
  mistaken for a Run state. It carries no storage contents and no stack.
*/
const EDITOR_STATE_NOTICES = Object.freeze({
  stale: "別の画面で編集内容が更新されました。自分の入力は保持しています。コピーしてから保存済み内容を読み直してください。これは編集の競合であり、実行の停止や送信結果不明の通知ではありません。",
  lock: "この環境では複数画面の同時編集を安全に防げないため、編集内容を保存しませんでした。",
  failed: "編集内容を保存できませんでした。",
  changed: "切替中に入力が変更されたため、元の対象と入力を保持しました。内容を確認してから操作し直してください。"
});

function setEditorStateNotice(kind) {
  editorStateNotice = kind;
  if (!el.editorStateNotice) return;
  el.editorStateNotice.textContent = kind ? EDITOR_STATE_NOTICES[kind] ?? EDITOR_STATE_NOTICES.failed : "";
  el.editorStateNotice.hidden = !kind;
  document.querySelector("#editorConflictActions").hidden = !kind;
  renderFlowInputStatus();
  if (lastStatusPayload) renderStatus(lastStatusPayload);
}

function editorStateKey() {
  return JSON.stringify(currentUiState());
}

function editorIsDirty() {
  return editorSavedKey !== null && editorStateKey() !== editorSavedKey;
}

function noticeForUiStateError(error) {
  if (error?.code === UI_STATE_ERROR_CODES.STALE_EDITOR_REVISION) return "stale";
  if (error?.code === UI_STATE_ERROR_CODES.UI_STATE_LOCK_UNAVAILABLE) return "lock";
  return "failed";
}

/*
  Compare-and-set save.

  Two different jobs sit on top of each other here. `uiSaveQueue` serializes
  saves inside THIS panel so a debounced keystroke cannot overtake an explicit
  save; the Web Lock inside mutateUiStateForTab serializes against OTHER
  surfaces, which the queue cannot see. Neither replaces the other.

  This never rejects. A stale or failed save turns into a bounded notice, so a
  storage problem cannot abort a target switch or a Start, and an autosave that
  nobody awaited cannot become an unhandled rejection. What it must never do is
  write anyway, and that decision lives in the store.
*/
function saveUiState(tabId = selectedTabId, state = null, allowDuringSwitch = false) {
  if (suppressUiSave ||
      (!allowDuringSwitch && (pendingTargetSwitches > 0 || !targetUiReady)) ||
      !Number.isInteger(tabId)) {
    /* Nothing was attempted, so nothing was persisted. A caller that needs the
       editor state on disk has to treat this as a failure, not as a no-op. */
    return Promise.resolve({ ok: false, reason: "skipped" });
  }
  const targetTabId = tabId;
  const snapshot = JSON.parse(JSON.stringify(state ?? currentUiState()));
  const requestedExternalVersion = targetEditorExternalChangeVersion;
  const operation = uiSaveQueue.catch(() => {}).then(async () => {
    if (targetEditorRevisionTabId !== targetTabId) {
      /* No revision was read for this tab, so there is nothing to compare
         against. Refuse rather than write without a fence. */
      setEditorStateNotice("failed");
      return { ok: false, reason: "failed" };
    }
    if (targetEditorStale || requestedExternalVersion !== targetEditorExternalChangeVersion || editorReloadInFlight) {
      setEditorStateNotice("stale");
      return { ok: false, reason: "stale" };
    }
    const expectedRevision = targetEditorRevision;
    const externalChangeVersion = targetEditorExternalChangeVersion;
    const ownRevision = expectedRevision < Number.MAX_SAFE_INTEGER
      ? expectedRevision + 1
      : expectedRevision;
    pendingEditorOwnRevision = ownRevision;
    try {
      const result = await mutateUiStateForTab(targetTabId, () => {
        if (targetEditorStale || requestedExternalVersion !== targetEditorExternalChangeVersion ||
            targetEditorRevisionTabId !== targetTabId) {
          const error = new Error("編集内容が変更されました。");
          error.code = UI_STATE_ERROR_CODES.STALE_EDITOR_REVISION;
          throw error;
        }
        return snapshot;
      }, { expectedRevision });
      if (targetEditorRevisionTabId === targetTabId && targetEditorRevision === expectedRevision) {
        targetEditorRevision = result.editorRevision;
      }
      const conflictedAfterSave = targetEditorRevisionTabId === targetTabId &&
        targetEditorExternalChangeVersion !== externalChangeVersion;
      if (conflictedAfterSave) targetEditorStale = true;
      setEditorStateNotice(conflictedAfterSave ? "stale" : null);
      if (targetEditorRevisionTabId === targetTabId) {
        if (!conflictedAfterSave) {
          editorSavedKey = JSON.stringify(snapshot);
          renderSavedAutomationEntry(snapshot, { exists: true });
        }
      }
      return {
        ok: true,
        editorRevision: result.editorRevision,
        stale: conflictedAfterSave,
        conflictedAfterSave
      };
    } catch (error) {
      const reason = noticeForUiStateError(error);
      if (reason === "stale") targetEditorStale = true;
      setEditorStateNotice(reason);
      return { ok: false, reason };
    } finally {
      if (pendingEditorOwnRevision === ownRevision) pendingEditorOwnRevision = null;
    }
  });
  uiSaveQueue = operation;
  return operation;
}

function applyUiState(state, { exists = Boolean(state) } = {}) {
  const quickFallback = QUICK_PRESETS[0];
  // Restore defaults are for editing, never a repair of a saved Start source.
  // A malformed saved Flow must remain closed until explicit new input.
  flowRestoreError = false;
  invalidRestoredFlow = undefined;
  if (state?.flow !== undefined || state?.mode === "flow") {
    try {
      if (!EXECUTION_MODES.includes(state.flow?.execution?.mode)) throw new Error("invalid-saved-range");
      resolveStartSourceFromEditorEntry({ ...state, mode: "flow" });
    } catch {
      flowRestoreError = true;
      // Keep the original stored value through unrelated autosaves and target
      // switches. UI defaults must not persist a repair that later grants Start.
      invalidRestoredFlow = state.flow === undefined ? undefined : JSON.parse(JSON.stringify(state.flow));
    }
  }
  suppressUiSave = true;
  try {
    el.quickPreset.value = state?.quick?.preset ?? quickFallback.id;
    el.quickPrompt.value = state?.quick?.prompt ?? quickFallback.prompt;
    el.quickRepeat.value = state?.quick?.repeat ?? "3";
    el.quickDelay.value = state?.quick?.delay ?? "1.5";
    el.keepAwake.checked = state?.keepAwake === true;
    recoveryPolicy = normalizeRecoveryPolicy(state?.recovery);
    renderRecoveryControls();
    customWorkflow = state?.workflow
      ? JSON.parse(JSON.stringify(state.workflow))
      : clonePreset("continuous-improvement");
    el.flowText.value = typeof state?.flow?.text === "string" ? state.flow.text : DEFAULT_FLOW_TEXT;
    openedFlowLibraryId = resolveOpenedFlowLibraryId(flowLibrary, state?.flow?.openedLibraryId);
    openedFlowLibraryRevision = openedFlowLibraryId ? flowLibrary.revision : null;
    const storedFlowIndex = Number(state?.flow?.selectedIndex ?? 0);
    flowSelectedIndex = Number.isSafeInteger(storedFlowIndex) && storedFlowIndex >= 0 ? storedFlowIndex : 0;
    const storedExecution = state?.flow?.execution;
    flowExecutionConfig = {
      mode: ["full", "step", "from", "range", "range-repeat", "after-checkpoint"].includes(storedExecution?.mode)
        ? storedExecution.mode
        : "full",
      start: String(storedExecution?.start ?? "1"),
      end: String(storedExecution?.end ?? "1"),
      repeat: String(storedExecution?.repeat ?? "1"),
      checkpointId: String(storedExecution?.checkpointId ?? "")
    };
    renderFlowLibrary();
    renderWorkflowEditor();
    renderFlowCompilation();
    setMode(state?.mode ?? "quick");
    renderSavedAutomationEntry(state, { exists });
  } finally {
    suppressUiSave = false;
  }
  editorEditVersion += 1;
  editorSavedKey = editorStateKey();
}

async function readUiStateBundle(tabId) {
  const [uiState, latestFlowLibrary] = await Promise.all([
    readUiStateForTab(tabId),
    loadFlowLibrary()
  ]);
  /* Existing v2 and legacy entries are preserved exactly as before. Settings
     are read only for a truly missing editor and produce authoring defaults,
     never a Start payload or Run mutation. */
  if (uiState.entry == null) {
    return {
      uiState: {
        ...uiState,
        entry: (await loadEditorInitialState({ mode: "quick" })).state
      },
      latestFlowLibrary
    };
  }
  return { uiState, latestFlowLibrary };
}

function applyUiStateBundle(tabId, expectedEpoch, { uiState, latestFlowLibrary }) {
  if (selectedTabId !== tabId || targetEpoch !== expectedEpoch) return false;
  flowLibrary = latestFlowLibrary;
  /* The revision this panel now owns for this tab. A tab with no entry, and a
     tab restored from the pre-per-tab `aipm.ui.v1` layout, both start at 0, so
     the first save stamps the entry instead of pretending to update one. */
  targetEditorRevisionTabId = tabId;
  targetEditorRevision = uiState.editorRevision;
  targetEditorStale = false;
  pendingEditorOwnRevision = null;
  setEditorStateNotice(null);
  applyUiState(uiState.entry, {
    exists: uiState.exists
  });
  return true;
}

async function restoreUiState(tabId, expectedEpoch = targetEpoch) {
  return applyUiStateBundle(tabId, expectedEpoch, await readUiStateBundle(tabId));
}

/*
  External-change detection. Another surface writing this tab's entry advances
  its revision past the one this panel holds, so its next save would be refused
  anyway; this listener only makes that visible before the user types more.

  A clean view may follow a fresh saved entry. Dirty input is never replaced;
  the read is also fenced against edits made while it is pending.
*/
function onEditorStateChanged(changes, areaName) {
  if (areaName !== "local" || !changes || typeof changes !== "object") return;
  if (Object.hasOwn(changes, UI_STATE_MAP_KEY) && Number.isInteger(targetEditorRevisionTabId)) {
    const observed = observedEditorRevision(changes[UI_STATE_MAP_KEY], targetEditorRevisionTabId);
    /* This panel's own successful save already advanced targetEditorRevision,
       so an equal or older revision is an echo, never fresh authority. */
    if (observed !== null && observed > targetEditorRevision && observed !== pendingEditorOwnRevision) {
      const canFollow = !editorIsDirty() && !startIntentInFlight && pendingEditorOwnRevision === null;
      targetEditorExternalChangeVersion += 1;
      targetEditorStale = true;
      setEditorStateNotice("stale");
      if (canFollow) void reloadEditorFromStorage();
    }
  }
  if (Object.hasOwn(changes, FLOW_LIBRARY_STORAGE_KEY)) {
    const observed = normalizeFlowLibrary(changes[FLOW_LIBRARY_STORAGE_KEY]?.newValue).revision;
    if (observed > flowLibrary.revision) {
      /* Do not render external Library data over locally typed metadata. The
         revision CAS will refuse the next mutation; this is only an early,
         bounded warning. */
      el.flowLibraryStatus.textContent = "別の画面でFlowライブラリが更新されました。現在のエディター入力とメタデータは保持しています。再読み込みしてから操作してください。";
    }
  }
}

chrome.storage?.onChanged?.addListener?.(onEditorStateChanged);

async function reloadEditorFromStorage({ discard = false } = {}) {
  if (editorReloadInFlight || startIntentInFlight || pendingTargetSwitches > 0 ||
      !Number.isInteger(selectedTabId) || (!discard && editorIsDirty())) return;
  const tabId = selectedTabId;
  const epoch = targetEpoch;
  const editVersion = editorEditVersion;
  const inputKey = editorStateKey();
  const externalVersion = targetEditorExternalChangeVersion;
  editorReloadInFlight = true;
  if (lastStatusPayload) renderStatus(lastStatusPayload);
  try {
    const bundle = await readUiStateBundle(tabId);
    if (tabId !== selectedTabId || epoch !== targetEpoch || pendingTargetSwitches > 0 ||
        editVersion !== editorEditVersion || inputKey !== editorStateKey() ||
        externalVersion !== targetEditorExternalChangeVersion || startIntentInFlight ||
        pendingEditorOwnRevision !== null) return;
    applyUiStateBundle(tabId, epoch, bundle);
  } catch {
    setEditorStateNotice("failed");
  } finally {
    editorReloadInFlight = false;
    if (lastStatusPayload) renderStatus(lastStatusPayload);
  }
}

document.querySelector("#copyEditorInput").addEventListener("click", async () => {
  const input = mode === "flow" ? el.flowText : mode === "quick" ? el.quickPrompt : null;
  const status = document.querySelector("#editorCopyStatus");
  try {
    await navigator.clipboard.writeText(input ? input.value : JSON.stringify(currentUiState(), null, 2));
    status.textContent = "自分の入力をコピーしました。";
  } catch {
    if (input) { input.focus(); input.select(); }
    status.textContent = "自動コピーできませんでした。入力欄を選択して、手動でコピーしてください。";
  }
});
document.querySelector("#reloadEditorState").addEventListener("click", async () => {
  if (editorIsDirty() && !window.confirm("未保存の入力を保存済み内容で置き換えます。必要な入力をコピーしましたか？")) return;
  await reloadEditorFromStorage({ discard: true });
});

function applyDiagnosticsPreference(settings) {
  diagnosticsLevel = normalizeSettings(settings).display.diagnosticsLevel;
  if (el.diagnosticsAdvanced) {
    el.diagnosticsAdvanced.open = diagnosticsLevelIsDetailed(diagnosticsLevel);
  }
}

function onDiagnosticsSettingsChanged(changes, areaName) {
  if (areaName !== "local" || !Object.hasOwn(changes ?? {}, SETTINGS_STORAGE_KEY)) return;
  applyDiagnosticsPreference(changes[SETTINGS_STORAGE_KEY]?.newValue);
  if (lastStatusPayload) renderDiagnosticsUx(lastStatusPayload);
}

chrome.storage?.onChanged?.addListener?.(onDiagnosticsSettingsChanged);

function workflowFromUi() {
  const recovery = currentRecoveryPolicy();
  if (mode === "quick") {
    return normalizeWorkflow({ ...quickConfigToWorkflow({
      prompt: el.quickPrompt.value,
      repeat: el.quickRepeat.value,
      delaySeconds: el.quickDelay.value
    }), recovery });
  }
  if (mode === "flow") {
    if (!selectedCompiledFlow() || !flowExecutionPlan) throw new Error("有効なFlowと実行範囲を選択してください。");
    return normalizeWorkflow({ ...JSON.parse(JSON.stringify(flowExecutionPlan.workflow)), recovery });
  }
  syncWorkflowMeta();
  return normalizeWorkflow({ ...customWorkflow, recovery });
}

function shortConversationLabel(key) {
  if (!key) return "未接続";
  const durable = String(key).match(/^chatgpt:c:(.+)$/);
  if (durable) return `会話 ${durable[1].slice(0, 8)}…`;
  if (String(key).startsWith("chatgpt:new:")) return "新しい会話";
  return "ChatGPT";
}

function runSummary(run) {
  if (!run) return "待機";
  if (run.status === "running") return `実行 ${Number(run.cursor?.sendsCompleted ?? 0)}/${Number(run.plannedSends ?? 0)}`;
  if (run.status === "paused") return `一時停止 ${Number(run.cursor?.sendsCompleted ?? 0)}/${Number(run.plannedSends ?? 0)}`;
  if (run.status === "completed") return "完了";
  if (run.status === "stopped") return "停止";
  return String(run.status ?? "待機");
}

function renderTargetTabs() {
  const options = knownTabs.map((item) => {
    const option = document.createElement("option");
    option.value = String(item.tabId);
    const status = item.status;
    const health = status?.discoveryError ? "接続要確認" : runSummary(status?.run);
    const display = targetDisplayState(item, selectedTabId, panelWindowId);
    option.dataset.aipmDisplayName = targetDisplayName(item);
    option.dataset.targetState = display.accent;
    option.textContent = [option.dataset.aipmDisplayName, display.label, health].filter(Boolean).join(" · ");
    return option;
  });
  if (Number.isInteger(selectedTabId) && !knownTabs.some((item) => item.tabId === selectedTabId)) {
    const locked = document.createElement("option");
    locked.value = String(selectedTabId);
    locked.textContent = `ChatGPTタブ #${selectedTabId} · 操作対象 · 接続待ち（選択維持）`;
    options.unshift(locked);
  }
  el.targetTab.replaceChildren(...options);
  if (Number.isInteger(selectedTabId)) el.targetTab.value = String(selectedTabId);
  el.targetTab.disabled = knownTabs.length === 0 || pendingTargetSwitches > 0;

  const selected = knownTabs.find((item) => item.tabId === selectedTabId);
  el.targetCard.dataset.targetState = targetDisplayState(selected, selectedTabId, panelWindowId).accent;
  el.targetTechnicalInfo.textContent = Number.isInteger(selectedTabId)
    ? `タブID: ${selectedTabId}\n${shortConversationLabel(selected?.status?.conversationKey)}\n接続: ${targetHealth(selectedTabId, knownTabs, tabDiscoveryInfo.serviceWorkerVersion).ready ? "正常" : "未確認"}`
    : "操作対象は未選択です。";
  if (!selected) {
    el.targetTabHint.textContent = Number.isInteger(selectedTabId)
      ? `タブ #${selectedTabId} の選択を維持しています。一時的に見つからなくても別のタブへ自動切替しません。`
      : "ChatGPTタブが見つかりません。chatgpt.comを開いてください。";
    return;
  }
  const status = selected.status;
  const health = status?.discoveryError
    ? "接続の修復が必要です。"
    : runSummary(status?.run);
  el.targetTabHint.textContent = `${targetDisplayState(selected, selectedTabId, panelWindowId).label} · ${health}`;
}

async function readPanelWindowId() {
  if (!chrome.windows?.getCurrent) return null;
  let timer;
  try {
    const current = await Promise.race([
      chrome.windows.getCurrent({ populate: false }),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), 1_000); })
    ]);
    return Number.isInteger(current?.id) && current.id >= 0 ? current.id : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function queryChatGptTabs() {
  const [response, currentWindowId] = await Promise.all([
    chrome.runtime.sendMessage({ type: "AIPM_LIST_CHATGPT_TABS" }),
    readPanelWindowId()
  ]);
  panelWindowId = currentWindowId;
  tabDiscoveryInfo = {
    serviceWorkerVersion: response?.serviceWorkerVersion ?? null,
    siteAccessGranted: response?.siteAccessGranted ?? null,
    failedChatGptTabs: Number(response?.failedChatGptTabs ?? 0),
    unknownTabFailures: Number(response?.unknownTabFailures ?? 0),
    partial: response?.partial === true
  };
  if (!response?.ok) {
    throw new Error(response?.error ?? "ChatGPTタブ一覧を取得できませんでした。");
  }
  return Array.isArray(response.tabs) ? response.tabs : [];
}

async function initializeTargetTabs() {
  targetUiReady = false;
  knownTabs = await queryChatGptTabs();
  const stored = await chrome.storage.local.get(SELECTED_TAB_KEY);
  const remembered = Number(stored[SELECTED_TAB_KEY]);
  selectedTabId = chooseInitialTargetId(remembered, knownTabs);
  targetEpoch += 1;
  const initializationEpoch = targetEpoch;
  if (!Number.isInteger(remembered) && Number.isInteger(selectedTabId)) {
    await chrome.storage.local.set({ [SELECTED_TAB_KEY]: selectedTabId });
  }
  renderTargetTabs();
  if (Number.isInteger(selectedTabId)) {
    targetUiReady = await restoreUiState(selectedTabId, initializationEpoch);
  } else {
    applyUiState(null);
  }
}

async function refreshTargetTabs() {
  if (tabRefreshInFlight) return;
  tabRefreshInFlight = true;
  try {
    const nextTabs = await queryChatGptTabs();
    knownTabs = nextTabs;
    selectedTabId = retainTargetOnRefresh(selectedTabId);
    renderTargetTabs();
  } finally {
    tabRefreshInFlight = false;
  }
}

function switchTargetTab(nextTabId) {
  if (!Number.isInteger(nextTabId)) return Promise.resolve();
  if (nextTabId === selectedTabId && targetUiReady && pendingTargetSwitches === 0) return Promise.resolve();
  const sourceUiReady = targetUiReady;
  if (!Number.isInteger(selectedTabId) && editorIsDirty() &&
      !window.confirm("対象未選択の入力は別のタブへ自動転記しません。必要な入力を手動コピーした上で、この入力を破棄して選んだタブを開きますか？")) {
    renderTargetTabs();
    return Promise.resolve();
  }
  pendingTargetSwitches += 1;
  targetUiReady = false;
  renderTargetTabs();
  const queued = targetSwitchQueue.then(async () => {
    targetUiReady = false;
    if (nextTabId === selectedTabId) {
      targetUiReady = await restoreUiState(nextTabId, targetEpoch);
      return;
    }
    const previousTabId = selectedTabId;
    const previousState = sourceUiReady && Number.isInteger(previousTabId)
      ? JSON.parse(JSON.stringify(currentUiState())) : null;
    const previousEditVersion = editorEditVersion;
    const previousKey = editorStateKey();
    const inputChanged = () => previousEditVersion !== editorEditVersion || previousKey !== editorStateKey();
    const retainChangedInput = () => {
      setEditorStateNotice("changed");
      targetUiReady = sourceUiReady;
    };
    if (previousState) {
      /*
        The source tab's editor state has to reach storage before this panel is
        allowed to forget it. Moving on after a refused save would discard the
        unsaved input in the DOM while the other surface's version stays on
        disk, which is precisely the data loss the fence exists to prevent.

        This aborts an editor UI transition only. It stops no Run, revokes
        nothing and touches no Run authority: selectedTabId, targetEpoch and
        aipm.selectedTab.v1 simply stay where they were, so the panel is still
        pointed at the source tab with the user's input intact.
      */
      const saved = await saveUiState(previousTabId, previousState, true);
      if (!saved?.ok || saved?.stale) {
        if (saved?.reason === "skipped") setEditorStateNotice("failed");
        targetUiReady = sourceUiReady;
        return;
      }
    }

    if (inputChanged()) { retainChangedInput(); return; }
    let destination;
    try {
      /* Read the whole destination editor bundle before committing the target
         selection. A failed read must leave the exact source target and DOM in
         place; applying the selection first would create a half-switched UI. */
      destination = await readUiStateBundle(nextTabId);
    } catch {
      setEditorStateNotice("failed");
      targetUiReady = sourceUiReady;
      renderTargetTabs();
      return;
    }

    if (inputChanged()) { retainChangedInput(); return; }
    const switchEpoch = targetEpoch + 1;
    try {
      await chrome.storage.local.set({ [SELECTED_TAB_KEY]: nextTabId });
      if (inputChanged()) {
        await chrome.storage.local.set({ [SELECTED_TAB_KEY]: previousTabId });
        retainChangedInput();
        return;
      }
    } catch {
      setEditorStateNotice("failed");
      targetUiReady = sourceUiReady;
      renderTargetTabs();
      return;
    }
    selectedTabId = nextTabId;
    targetEpoch = switchEpoch;
    // A confirmed presentation describes exactly one tab. Drop it here so the next tab can
    // never be shown with the previous tab's retained Run state.
    lastConfirmedStatusPayload = null;
    statusPresentationStale = false;
    const restored = applyUiStateBundle(nextTabId, switchEpoch, destination);
    if (!restored) return;
    targetUiReady = true;
    renderTargetTabs();
  });
  targetSwitchQueue = queued.catch(() => {});
  return queued.finally(async () => {
    pendingTargetSwitches = Math.max(0, pendingTargetSwitches - 1);
    renderTargetTabs();
    if (pendingTargetSwitches === 0) await refreshStatus();
  });
}

function runControlSnapshot(run) {
  if (!run || typeof run.runId !== "string" || !run.runId) return null;
  return Object.freeze({
    tabId: selectedTabId,
    targetEpoch,
    runId: run.runId,
    stateRevision: run.stateRevision != null && Number.isFinite(Number(run.stateRevision))
      ? Number(run.stateRevision)
      : null,
    status: run.status ?? null,
    phase: run.phase ?? null,
    pauseReason: run.pauseReason ?? null
  });
}

function currentDurableStopSnapshot() {
  if (!durableStopSnapshot ||
      durableStopSnapshot.tabId !== selectedTabId ||
      durableStopSnapshot.targetEpoch !== targetEpoch ||
      !["running", "paused"].includes(durableStopSnapshot.status)) {
    return null;
  }
  return durableStopSnapshot;
}

function clearPendingStart(tabId, intent) {
  if (pendingStartsByTab.get(tabId) !== intent) return;
  clearTimeout(intent.timer);
  pendingStartsByTab.delete(tabId);
}

function startUncertaintyText(intent) {
  return intent?.state === "unknown"
    ? "開始結果不明です。確認時間を過ぎてもRunを確認できませんでした。重複実行を避けるため再開始せず、対象タブの状態を確認してください。自動再送はしません。"
    : "開始結果を確認中です。開始操作が遅れて完了する可能性があるため、再開始せずRunの表示を待っています。自動再送はしません。";
}

function retainUnresolvedStart(tabId, epoch, intent) {
  if (pendingStartsByTab.get(tabId) !== intent) return;
  intent.state = "reconciling";
  intent.timer = setTimeout(() => {
    if (pendingStartsByTab.get(tabId) !== intent) return;
    intent.state = "unknown";
    if (isCurrentTargetRequest(tabId, epoch, selectedTabId, targetEpoch) && lastStatusPayload) {
      renderStatus(lastStatusPayload, { preserveDurableStop: true });
    }
  }, START_RECONCILIATION_WINDOW_MS);
}

function renderDiagnosticRows(container, projection) {
  if (!container) return;
  container.replaceChildren(...diagnosticDetailsRows(projection).map(([label, value]) => {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = label;
    detail.textContent = value;
    row.append(term, detail);
    return row;
  }));
}

function renderDiagnosticsUx(payload) {
  let projection = null;
  let events = [];
  try {
    projection = projectRunDiagnostic(payload?.run, { blocker: payload?.blocker ?? null });
    events = (Array.isArray(payload?.diagnostics) ? payload.diagnostics.slice(-12) : [])
      .map((item) => projectDiagnosticEvent(item))
      .filter(Boolean)
      .reverse();
  } catch {
    projection = null;
    events = [];
  }

  const severityLabels = { info: "情報", attention: "確認", "safety-stop": "安全停止" };
  el.diagnosticsSeverity.dataset.severity = projection?.severity ?? "info";
  el.diagnosticsSeverity.textContent = severityLabels[projection?.severity] ?? "情報";
  el.diagnosticsTitle.textContent = projection?.["title"] ?? "表示対象の診断情報はありません";
  el.diagnosticsSummary.textContent = projection?.summary ??
    "現在の実行状態は、上の「現在の状態」と「理由」で確認してください。";
  el.diagnosticsSafety.textContent = projection?.safetyMeaning ??
    "診断表示は実行状態や送信可否を変更しません。";
  renderDiagnosticRows(el.diagnosticsDetails, projection);

  if (!events.length) {
    const empty = document.createElement("li");
    empty.textContent = "なし";
    el.diagnostics.replaceChildren(empty);
    return;
  }
  el.diagnostics.replaceChildren(...events.map((event) => {
    const item = document.createElement("li");
    const technical = diagnosticDetailsRows(event)
      .filter(([label]) => ["Code", "Elapsed", "Timestamp", "Attempts"].includes(label))
      .map(([label, value]) => `${label}: ${value}`)
      .join(" · ");
    item.textContent = technical || event["title"];
    return item;
  }));
}

// Presentation only: change reading/tab order together, without replacing controls
// or using disclosure state as Start/Resume/Stop authority.
function renderRunDisclosure({ compact, promoted }) {
  el.runDetails.hidden = compact;
  el.runCard.dataset.compact = String(compact);
  if (el.runCard.dataset.promoted !== String(promoted)) {
    const focused = document.activeElement;
    const restoreFocus = focused && el.runCard.contains(focused);
    el.runCard.parentElement.insertBefore(el.runCard, promoted ? el.targetCard : el.savedAutomation);
    el.runCard.dataset.promoted = String(promoted);
    if (restoreFocus) focused.focus({ preventScroll: true });
  }
}

function showRunFeedback(text) {
  renderRunDisclosure({ compact: false, promoted: true });
  el.message.textContent = text;
}

function renderStatus(payload, { preserveDurableStop = false, stale = null } = {}) {
  lastStatusPayload = payload;
  // `null` keeps whatever the last refresh established, so an unrelated re-render (theme,
  // mode switch) neither invents nor clears staleness.
  if (stale !== null) statusPresentationStale = stale === true;
  const presentationIsStale = statusPresentationStale;
  const pendingStart = pendingStartsByTab.get(selectedTabId);
  const unresolvedStart = pendingStart && pendingStart.state !== "starting";
  const run = payload?.run ?? null;
  renderedRunControlSnapshot = runControlSnapshot(run);
  if (!preserveDurableStop) {
    durableStopSnapshot = ["running", "paused"].includes(run?.status)
      ? renderedRunControlSnapshot
      : null;
  }
  const total = Number(run?.plannedSends ?? 0);
  const completed = displayDeliveredSendCount(run);
  const blockIndex = Math.min(Number(run?.cursor?.stepIndex ?? 0) + 1, Number(run?.workflow?.steps?.length ?? 0));
  const blockTotal = Number(run?.workflow?.steps?.length ?? 0);
  const percent = run?.status === "completed"
    ? 100
    : total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;

  el.progress.textContent = blockTotal ? `手順 ${blockIndex}/${blockTotal} · 送信 ${completed}/${total}` : `${completed} / ${total}`;
  el.progressBar.style.width = `${percent}%`;

  const running = run?.status === "running";
  const paused = run?.status === "paused";
  const hasDurableStop = Boolean(currentDurableStopSnapshot());
  el.runCard.dataset.active = String(running || paused || hasDurableStop);
  const connection = targetHealth(selectedTabId, knownTabs, tabDiscoveryInfo.serviceWorkerVersion);
  const targetReady = connection.ready && pendingTargetSwitches === 0 && targetUiReady;
  const statusContext = {
    run,
    hasTarget: Number.isInteger(selectedTabId),
    targetReady,
    pageReady: payload?.pageReady === true,
    blocker: payload?.blocker ?? null
  };
  const statusUx = projectRunUx(statusContext);
  el.runCard.dataset.state = statusUx.kind;
  el.statusBadge.dataset.state = statusUx.kind;
  el.statusBadge.textContent = statusUx.label;
  el.connectionStatus.dataset.connection = statusUx.connection.kind;
  el.connectionStatus.textContent = statusUx.connection.label;
  const completionOutcome = completionOutcomeForRun(statusContext);
  el.completionOutcome.dataset.outcome = completionOutcome.kind;
  el.completionOutcome.textContent = completionOutcome.text;
  const flowInvalid = mode === "flow" && (!reviewedFlowKey || reviewedFlowKey !== currentFlowReviewKey());
  // A retained presentation is never mutation authority: every path that could cause a send
  // stays closed until a fresh confirmation arrives. Only Stop, which is a durable revoke,
  // survives — losing Stop is the one failure a stale observation must never cause.
  const startDisabled = running || paused || !canStartRun(statusContext) || startIntentInFlight || Boolean(pendingStart) ||
    presentationIsStale || flowInvalid || targetEditorStale || editorReloadInFlight;
  el.start.disabled = startDisabled;
  el.flowStart.disabled = startDisabled;
  let planned = null;
  try { planned = countPlannedSends(workflowFromUi()); } catch { /* Invalid input cannot advertise a count. */ }
  el.start.textContent = unresolvedStart ? (pendingStart.state === "unknown" ? "開始結果不明" : "開始結果を確認中…")
    : startIntentInFlight ? "開始準備中…"
    : planned === null ? "内容を確認して開始"
    : planned > 0 ? `この内容で自動送信を開始（${planned}回）`
    : "この内容で開始（自動送信0回）";
  renderFlowInputStatus();
  if (unresolvedStart) {
    el.flowStartReason.textContent = startUncertaintyText(pendingStart);
  } else if (presentationIsStale) {
    el.flowStartReason.textContent = "開始不可: 対象タブの状態を再確認中です。表示は直前の確認結果です。";
  } else if (targetEditorStale || editorReloadInFlight) {
    el.flowStartReason.textContent = "開始不可: 編集内容を確認し直してください。入力は保持しています。";
  } else if (flowInvalid) {
    el.flowStartReason.textContent = "開始不可: Flowの形式と上限を確認し、エラー箇所を修正してください。";
  } else if (running || paused) {
    el.flowStartReason.textContent = "開始不可: 選択中のタブには進行中または確認待ちのRunがあります。";
  } else if (startIntentInFlight) {
    el.flowStartReason.textContent = "開始処理中です。重複開始を防ぐため待機しています。";
  } else if (!connection.ready || !payload?.pageReady || Boolean(payload?.blocker)) {
    el.flowStartReason.textContent = "開始不可: 対象ChatGPTタブの接続・入力欄・blockerを確認してください。";
  } else if (!canStartRun(statusContext)) {
    el.flowStartReason.textContent = "開始不可: 対象タブの安全な開始条件を確認できません。";
  } else {
    el.flowStartReason.textContent = "";
  }
  el.flowStartReason.hidden = !el.flowStartReason.textContent;
  el.pause.disabled = !running || !targetReady || runControlIntentInFlight || presentationIsStale;
  el.resume.disabled = !canResumePausedRun(run) || !targetReady || payload?.pageReady !== true ||
    Boolean(payload?.blocker) || runControlIntentInFlight || presentationIsStale;
  el.stop.disabled = !currentDurableStopSnapshot() || runControlIntentInFlight;
  el.keepAwake.disabled = running || paused || pendingTargetSwitches > 0 || !targetUiReady;
  if ((running || paused) && typeof run?.keepAwake === "boolean") el.keepAwake.checked = run.keepAwake;

  el.runCard.dataset.observation = presentationIsStale ? "refreshing" : "fresh";
  el.message.textContent = presentationIsStale
    ? "対象タブの状態を再確認しています。表示は直前の確認結果です。"
    : statusUx.kind === "confirmation-required" && run?.pauseReason === "manual-checkpoint" && typeof run.checkpointLabel === "string"
      ? `${statusUx.reason}\n確認: ${run.checkpointLabel}`
    : statusUx.reason;
  el.nextAction.textContent = presentationIsStale
    ? "自動的に再確認します。操作は再確認の完了後に有効になります。"
    : statusUx.nextAction;
  if (unresolvedStart) {
    el.runCard.dataset.state = "confirmation-required";
    el.statusBadge.dataset.state = "confirmation-required";
    el.statusBadge.textContent = pendingStart.state === "unknown" ? "開始結果不明" : "開始結果を確認中";
    el.message.textContent = startUncertaintyText(pendingStart);
    el.nextAction.textContent = "対象タブの状態を更新してください。Runを確認できた場合は、そのRunの停止操作を使えます。";
  }
  const compact = !run && !payload?.blocker && !presentationIsStale && !hasDurableStop && !unresolvedStart;
  renderRunDisclosure({ compact, promoted: unresolvedStart || (!compact && statusUx.kind !== "completed" && statusUx.kind !== "stopped") });
  el.progress.hidden = compact || unresolvedStart;
  el.activeRunWarning.hidden = !(running || paused || hasDurableStop);
  el.startSection.hidden = running || paused || hasDurableStop;
  el.connectionStatus.hidden = statusUx.connection.kind === "available";
  el.completionOutcome.hidden = compact || unresolvedStart || statusUx.kind === "running" || statusUx.kind === "user-paused";
  renderDiagnosticsUx(payload);
}

async function refreshStatus({ periodic = false } = {}) {
  const requestedTabId = selectedTabId;
  const requestedEpoch = targetEpoch;
  if (!Number.isInteger(requestedTabId)) {
    lastConfirmedStatusPayload = null;
    renderStatus({ pageReady: false, run: null, diagnostics: [] }, { stale: false });
    return;
  }
  if (periodic && statusRefreshByTab.state(requestedTabId).state !== "idle") return;
  try {
    const response = await statusRefreshByTab.run(
      requestedTabId,
      () => sendToContent({
        type: "AIPM_GET_STATUS",
        readOnlyRecovery: currentRecoveryPolicy()
      }, requestedTabId, requestedEpoch),
      {
        timeoutMs: recoveryRuntimeBounds(recoveryPolicy).sidePanelStatusTimeoutMs ?? STATUS_REFRESH_TIMEOUT_MS,
        timeoutErrorFactory: () => {
          const error = new Error("選択したChatGPTタブの状態確認が時間切れになりました。");
          error.code = "STATUS_REFRESH_TIMEOUT";
          return error;
        },
        fingerprint: `target-${requestedEpoch}`
      }
    );
    if (!isCurrentTargetRequest(requestedTabId, requestedEpoch, selectedTabId, targetEpoch)) return;
    const pendingStart = pendingStartsByTab.get(requestedTabId);
    // Only an exact, fresh Run observation resolves uncertainty. A null result
    // (including repeated nulls after the deadline) is not cancellation proof.
    if (pendingStart && response?.ok === true && runControlSnapshot(response.run) &&
        ["running", "paused", "completed", "stopped"].includes(response.run.status) &&
        response.run.runId !== pendingStart.previousRunId) {
      clearPendingStart(requestedTabId, pendingStart);
    }
    lastConfirmedStatusPayload = response;
    renderStatus(response, { stale: false });
  } catch (error) {
    if (!isCurrentTargetRequest(requestedTabId, requestedEpoch, selectedTabId, targetEpoch)) return;
    // We failed to look, not to find. Keep the last confirmed presentation and say it is
    // being re-checked, instead of flickering the Run through an idle-looking empty state.
    if (isTransientStatusObservationFailure(error) && lastConfirmedStatusPayload) {
      renderStatus(lastConfirmedStatusPayload, { preserveDurableStop: true, stale: true });
      return;
    }
    lastConfirmedStatusPayload = null;
    renderStatus({ pageReady: false, run: null, diagnostics: [] }, {
      preserveDurableStop: true,
      stale: false
    });
    if (!pendingStartsByTab.has(requestedTabId)) {
      showRunFeedback(error instanceof Error ? error.message : String(error));
    }
  }
}

function addBlock(type) {
  customWorkflow.steps.push(defaultBlock(type));
  syncMaxSends();
  renderWorkflowEditor();
  saveUiState();
}

el.targetTab.addEventListener("change", async () => {
  try {
    await switchTargetTab(Number.parseInt(el.targetTab.value, 10));
  } catch (error) {
    el.targetTabHint.textContent = error instanceof Error ? error.message : String(error);
  }
});
// Opens the extension options page. Display-only navigation: it reads and writes
// no Run state and sends no runtime message. openOptionsPage() needs no permission.
document.querySelector("#openSettings")?.addEventListener("click", () => {
  chrome.runtime.openOptionsPage?.();
});

// Opens the fullscreen Workspace in an ordinary tab. Display-only navigation:
// it reads and writes no Run state, sends no runtime message, contacts no
// renderer, and needs no permission - tabs.create() on an own extension page
// and runtime.getURL() are both permission free.
//
// Repeated clicks open repeated tabs. Focusing an already open Workspace would
// need tabs.query({url}), which requires the "tabs" permission, or background
// state to remember the tab id. Both are out of scope here, so Phase 3 keeps
// the permission-free create and accepts duplicate tabs.
document.querySelector("#openWorkspace")?.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/workspace.html") });
});

el.refreshTabs.addEventListener("click", async () => {
  try {
    await refreshTargetTabs();
    await refreshStatus();
  } catch (error) {
    el.targetTabHint.textContent = error instanceof Error ? error.message : String(error);
  }
});
el.keepAwake.addEventListener("change", () => saveUiState());
el.recoveryMode.addEventListener("change", () => {
  recoveryPolicy = normalizeRecoveryPolicy({ mode: el.recoveryMode.value });
  renderRecoveryControls();
  if (lastStatusPayload) renderStatus(lastStatusPayload);
  saveUiState();
});
for (const node of [el.identityRetries, el.readinessRecovery, el.statusRecovery]) {
  node.addEventListener("change", () => {
    currentRecoveryPolicy();
    renderRecoveryControls();
    if (lastStatusPayload) renderStatus(lastStatusPayload);
    saveUiState();
  });
}

el.quickTab.addEventListener("click", () => setMode("quick"));
el.workflowTab.addEventListener("click", () => setMode("workflow"));
el.flowTab.addEventListener("click", () => setMode("flow"));
for (const node of [el.quickPrompt, el.quickRepeat, el.quickDelay]) {
  node.addEventListener("input", () => {
    editorEditVersion += 1;
    if (lastStatusPayload) renderStatus(lastStatusPayload);
  });
}
for (const node of [el.quickPreset, el.quickRepeat, el.quickDelay, el.keepAwake, el.recoveryMode,
  el.identityRetries, el.readinessRecovery, el.statusRecovery, el.flowExecutionMode,
  el.flowRangeStart, el.flowRangeEnd, el.flowRangeRepeat, el.flowCheckpoint]) {
  node.addEventListener("change", () => { editorEditVersion += 1; });
}
initializeFlowGuide({
  goal: document.querySelector("#flowGoal"),
  guideText: document.querySelector("#flowGuideText"),
  guideDetails: document.querySelector("#flowGuideDetails"),
  copyButton: document.querySelector("#copyFlowGuide"),
  copyStatus: document.querySelector("#flowGuideCopyStatus")
});
document.querySelector("#flowOpenWorkspace").addEventListener("click", () => {
  document.querySelector("#openWorkspace").click();
});
el.quickPreset.addEventListener("change", () => {
  const preset = QUICK_PRESETS.find((item) => item.id === el.quickPreset.value);
  if (preset) el.quickPrompt.value = preset.prompt;
  saveUiState();
});
for (const node of [el.quickPrompt, el.quickRepeat, el.quickDelay, el.workflowName, el.workflowMaxSends]) {
  node.addEventListener("change", () => saveUiState());
}

el.loadPreset.addEventListener("click", () => {
  customWorkflow = clonePreset(el.workflowPreset.value);
  renderWorkflowEditor();
  saveUiState();
});

el.addPrompt.addEventListener("click", () => addBlock("prompt"));
el.addDelay.addEventListener("click", () => addBlock("delay"));
el.addWaitUntil.addEventListener("click", () => addBlock("wait-until"));
el.addCheckpoint.addEventListener("click", () => addBlock("checkpoint"));

el.flowText.addEventListener("input", scheduleFlowCompilation);
el.flowSelector.addEventListener("change", () => {
  editorEditVersion += 1;
  const index = Number.parseInt(el.flowSelector.value, 10);
  flowSelectedIndex = Number.isSafeInteger(index) && index >= 0 ? index : 0;
  renderFlowExecutionControls();
  rebuildFlowExecutionPlan();
});
el.flowExecutionMode.addEventListener("change", () => {
  syncFlowExecutionConfigFromUi();
  renderFlowExecutionControls();
  rebuildFlowExecutionPlan({ persist: true });
});
for (const node of [el.flowRangeStart, el.flowRangeEnd, el.flowRangeRepeat, el.flowCheckpoint]) {
  node.addEventListener("change", () => rebuildFlowExecutionPlan({ persist: true }));
}
el.copyFlow.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(el.flowText.value);
    el.copyFlowStatus.textContent = "Flowテキストをコピーしました。";
  } catch {
    el.copyFlowStatus.textContent = "コピーできませんでした。Flowテキストを選択して手動でコピーしてください。";
  }
});

function captureFlowLibraryUiIntent() {
  if (pendingTargetSwitches > 0) throw new Error("操作対象の切替完了を待ってください。");
  return {
    tabId: selectedTabId,
    targetEpoch,
    selectedId: selectedFlowLibraryId,
    openedId: openedFlowLibraryId,
    libraryRevision: flowLibrary.revision,
    openedRevision: openedFlowLibraryRevision,
    editorSource: el.flowText.value,
    metadata: libraryMetadataFromUi()
  };
}

function assertFlowLibraryUiIntent(intent, { selected = false, opened = false, source = false, metadata = false } = {}) {
  if (selectedTabId !== intent.tabId || targetEpoch !== intent.targetEpoch || pendingTargetSwitches > 0) {
    throw new Error("Library操作中に対象タブが変わったため、editor状態へ反映しませんでした。");
  }
  if (selected && selectedFlowLibraryId !== intent.selectedId) {
    throw new Error("Library操作中に一覧の選択が変わりました。");
  }
  if (opened && openedFlowLibraryId !== intent.openedId) {
    throw new Error("Library操作中にeditorの編集対象が変わりました。");
  }
  if (source && el.flowText.value !== intent.editorSource) {
    throw new Error("Library操作中にFlow editorの内容が変わりました。");
  }
  if (metadata) {
    const current = libraryMetadataFromUi();
    if (current.name !== intent.metadata.name || current.description !== intent.metadata.description ||
        current.favorite !== intent.metadata.favorite) {
      throw new Error("Library操作中にmetadataが変わりました。");
    }
  }
}

async function runLibraryAction(action) {
  if (flowLibraryOperationInFlight) {
    el.flowLibraryStatus.textContent = "別のライブラリ操作が完了するまで待ってください。";
    return;
  }
  flowLibraryOperationInFlight = true;
  try {
    const intent = captureFlowLibraryUiIntent();
    await action(intent);
  } catch (error) {
    el.flowLibraryStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    flowLibraryOperationInFlight = false;
  }
}

el.flowLibrarySearch.addEventListener("input", renderFlowLibrary);
el.flowLibraryList.addEventListener("change", () => {
  selectedFlowLibraryId = el.flowLibraryList.value || null;
  renderFlowLibrary();
});
el.flowLibrarySaveNew.addEventListener("click", () => runLibraryAction(async (intent) => {
  const entry = createFlowLibraryEntry({
    ...intent.metadata,
    source: intent.editorSource
  });
  await saveFlowLibraryState(
    "Flow sourceとmetadataを新規保存しました。",
    (latest) => upsertFlowLibraryEntry(latest, entry),
    intent.libraryRevision
  );
  assertFlowLibraryUiIntent(intent, { opened: true, source: true });
  el.flowLibrarySearch.value = "";
  selectedFlowLibraryId = entry.id;
  openedFlowLibraryId = entry.id;
  openedFlowLibraryRevision = flowLibrary.revision;
  renderFlowLibrary();
  await saveUiState();
}));
el.flowLibraryUpdate.addEventListener("click", () => runLibraryAction(async (intent) => {
  const selectedId = selectedFlowLibraryId;
  if (!canUpdateOpenedFlowLibraryEntry(flowLibrary, selectedId, openedFlowLibraryId)) {
    throw new Error("一覧で選択中のentryとeditorで開いているentryが一致しないため、上書きしませんでした。");
  }
  await saveFlowLibraryState("Flow sourceとmetadataを上書き保存しました。", (latest) => {
    assertFlowLibraryUiIntent(intent, { selected: true, opened: true, source: true, metadata: true });
    const fresh = requireFreshFlowLibraryEntry(latest, selectedId, "上書き");
    const patch = { ...intent.metadata, source: intent.editorSource };
    return upsertFlowLibraryEntry(latest, updateFlowLibraryEntry(fresh, patch));
  }, intent.openedRevision);
}));
el.flowLibraryOpen.addEventListener("click", () => runLibraryAction(async (intent) => {
  const selected = selectedFlowLibraryEntry();
  if (!selected) throw new Error("OpenするLibrary entryを選択してください。");
  const selectedId = selected.id;
  const openedIdAtIntent = openedFlowLibraryId;
  const editorSourceAtIntent = el.flowText.value;
  if (isOpenedFlowLibraryDirty(flowLibrary, openedIdAtIntent, editorSourceAtIntent) &&
      !window.confirm("現在開いているFlowには未保存の変更があります。破棄して選択中の項目を開きますか？")) {
    return;
  }
  let opened = null;
  await saveFlowLibraryState("LibraryからFlow sourceを開きました。Runは開始していません。", (latest) => {
    assertFlowLibraryUiIntent(intent, { selected: true, opened: true, source: true });
    if (selectedFlowLibraryId !== selectedId || openedFlowLibraryId !== openedIdAtIntent ||
        el.flowText.value !== editorSourceAtIntent) {
      throw new Error("Open確認中にLibraryの選択またはeditor内容が変わりました。");
    }
    const fresh = requireFreshFlowLibraryEntry(latest, selectedId, "Open");
    opened = markFlowLibraryOpened(fresh);
    return upsertFlowLibraryEntry(latest, opened);
  }, intent.libraryRevision);
  assertFlowLibraryUiIntent(intent, { selected: true, opened: true, source: true });
  if (selectedFlowLibraryId !== selectedId || openedFlowLibraryId !== openedIdAtIntent ||
      el.flowText.value !== editorSourceAtIntent) {
    throw new Error("Open処理中にLibraryの選択またはeditor内容が変わったため、内容を置き換えませんでした。");
  }
  el.flowText.value = opened.source;
  openedFlowLibraryId = selectedId;
  openedFlowLibraryRevision = flowLibrary.revision;
  flowSelectedIndex = 0;
  flowExecutionConfig = { mode: "full", start: "1", end: "1", repeat: "1", checkpointId: "" };
  renderFlowLibrary();
  renderFlowCompilation({ persist: true });
  setMode("flow");
}));
el.flowLibraryDuplicate.addEventListener("click", () => runLibraryAction(async (intent) => {
  const selected = selectedFlowLibraryEntry();
  if (!selected) throw new Error("DuplicateするLibrary entryを選択してください。");
  const selectedId = selected.id;
  let duplicate = null;
  await saveFlowLibraryState("Library entryを複製しました。", (latest) => {
    assertFlowLibraryUiIntent(intent, { selected: true, opened: true });
    const fresh = requireFreshFlowLibraryEntry(latest, selectedId, "Duplicate");
    duplicate = duplicateFlowLibraryEntry(fresh);
    return upsertFlowLibraryEntry(latest, duplicate);
  }, intent.libraryRevision);
  assertFlowLibraryUiIntent(intent, { selected: true, opened: true });
  selectedFlowLibraryId = duplicate.id;
  renderFlowLibrary();
}));
el.flowLibraryRename.addEventListener("click", () => runLibraryAction(async (intent) => {
  const selected = selectedFlowLibraryEntry();
  if (!selected) throw new Error("RenameするLibrary entryを選択してください。");
  const selectedId = selected.id;
  const name = el.flowLibraryName.value;
  await saveFlowLibraryState("Library entryの名前を変更しました。", (latest) => {
    assertFlowLibraryUiIntent(intent, { selected: true });
    const fresh = requireFreshFlowLibraryEntry(latest, selectedId, "Rename");
    return upsertFlowLibraryEntry(latest, updateFlowLibraryEntry(fresh, { name }));
  }, intent.libraryRevision);
}));
el.flowLibraryDelete.addEventListener("click", () => runLibraryAction(async (intent) => {
  const selected = selectedFlowLibraryEntry();
  if (!selected) throw new Error("DeleteするLibrary entryを選択してください。");
  if (!window.confirm(`「${selected.name}」をこのPCのライブラリから削除しますか？`)) return;
  const selectedId = selected.id;
  await saveFlowLibraryState(
    "Library entryを削除しました。現在のeditor内容は保持しています。",
    (latest) => {
      assertFlowLibraryUiIntent(intent, { selected: true });
      requireFreshFlowLibraryEntry(latest, selectedId, "Delete");
      return deleteFlowLibraryEntry(latest, selectedId);
    },
    intent.libraryRevision
  );
  assertFlowLibraryUiIntent(intent);
  if (selectedFlowLibraryId === selectedId) selectedFlowLibraryId = null;
  if (openedFlowLibraryId === selectedId) openedFlowLibraryId = null;
  renderFlowLibrary();
  await saveUiState();
}));
el.flowLibraryCopy.addEventListener("click", () => runLibraryAction(async () => {
  const selected = selectedFlowLibraryEntry();
  if (!selected) throw new Error("CopyするLibrary entryを選択してください。");
  await navigator.clipboard.writeText(exportFlowText(selected));
  el.flowLibraryStatus.textContent = "プレーンテキストのAIPM Flowをコピーしました。";
}));
el.flowLibraryShare.addEventListener("click", () => runLibraryAction(async () => {
  const selected = selectedFlowLibraryEntry();
  if (!selected) throw new Error("ShareするLibrary entryを選択してください。");
  downloadFlowText(exportFlowText(selected), selected.name);
  el.flowLibraryStatus.textContent = "プレーンテキストのAIPM Flowファイルを作成しました。";
}));

el.flowImportPaste.addEventListener("click", () => {
  try {
    importFlowSource(el.flowImportText.value, "貼り付け内容");
  } catch (error) {
    el.flowImportStatus.textContent = error instanceof Error ? error.message : String(error);
  }
});
el.flowImportFile.addEventListener("change", async () => {
  const file = el.flowImportFile.files?.[0];
  if (!file) return;
  try {
    if (file.size > MAX_FLOW_TEXT_BYTES) {
      throw new Error(`AIPM Flowが大きすぎます。${MAX_FLOW_TEXT_BYTES} bytes以下にしてください。`);
    }
    importFlowSource(await file.text(), `file「${file.name}」`);
  } catch (error) {
    el.flowImportStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    el.flowImportFile.value = "";
  }
});
el.flowExportFile.addEventListener("click", () => {
  try {
    const source = validateImportedFlowText(el.flowText.value);
    downloadFlowText(source, selectedCompiledFlow()?.name ?? "aipm-flow");
    el.flowImportStatus.textContent = "現在の検証済みFlowをプレーンテキストファイルへ書き出しました。";
  } catch (error) {
    el.flowImportStatus.textContent = error instanceof Error ? error.message : String(error);
  }
});

async function startSelectedAutomation() {
  const intentTabId = selectedTabId;
  const intentEpoch = targetEpoch;
  if (pendingStartsByTab.has(intentTabId)) {
    if (lastStatusPayload) renderStatus(lastStatusPayload, { preserveDurableStop: true });
    return;
  }
  if (startIntentInFlight) {
    showRunFeedback("開始処理はすでに進行中です。");
    return;
  }
  startIntentInFlight = true;
  el.start.disabled = true;
  el.flowStart.disabled = true;
  el.start.textContent = "開始準備中…";
  renderFlowInputStatus();
  const observedRunIdBeforeStart = renderedRunControlSnapshot?.runId ?? null;
  const startIntent = { state: "starting", previousRunId: observedRunIdBeforeStart, timer: null };
  let failureMessage = null;
  try {
    const intentMode = mode;
    if (pendingTargetSwitches > 0) throw new Error("操作対象の切替完了を待ってください。");
    if (targetEditorStale || editorReloadInFlight) throw new Error("編集内容を確認し直してから開始してください。");
    if (statusPresentationStale || ["running", "paused"].includes(lastStatusPayload?.run?.status)) {
      throw new Error("対象タブの実行状態を確認してから開始してください。");
    }
    if (intentMode === "flow" && (!reviewedFlowKey || reviewedFlowKey !== currentFlowReviewKey())) {
      throw new Error("Flowの形式と上限を確認し、プレビューを確認してから開始してください。");
    }
    const intentEditVersion = editorEditVersion;
    const intentExternalVersion = targetEditorExternalChangeVersion;
    const intentState = JSON.parse(JSON.stringify(currentUiState()));
    const expectedEntry = ["quick", "flow"].includes(intentMode) ? intentState : null;
    const expectedSource = expectedEntry ? resolveStartSourceFromEditorEntry(expectedEntry) : null;
    const assertStartInput = () => {
      if (!canDispatchTargetIntent(intentTabId, intentEpoch, selectedTabId, targetEpoch,
          pendingTargetSwitches, targetUiReady) || mode !== intentMode ||
          editorEditVersion !== intentEditVersion || targetEditorExternalChangeVersion !== intentExternalVersion ||
          targetEditorStale || editorReloadInFlight ||
          (expectedEntry && editorStartSourceKey(currentUiState()) !== editorStartSourceKey(expectedEntry))) {
        throw new Error("開始準備中に対象または入力内容が変更されたため、開始を中止しました。内容を確認し直してください。");
      }
    };
    assertStartInput();
    if (expectedEntry) {
      const saved = await saveUiState(intentTabId, intentState);
      if (!saved?.ok || saved?.stale) {
        throw new Error("確認した内容を安全に保存できなかったため、開始しませんでした。入力は保持しています。");
      }
      assertStartInput();
    }

    // One exact-tab fresh read, then compare the persisted source to the reviewed
    // draft. Only the existing detached Workflow is relayed; editor fences stay here.
    const startSource = await readStartSourceForTab(intentTabId, { expectedEntry });
    assertStartInput();
    if (startSource.mode !== intentMode ||
        (expectedSource && JSON.stringify(startSource) !== JSON.stringify(expectedSource))) {
      throw new Error("保存済みの内容が確認した内容と変わったため、開始しませんでした。");
    }
    renderSavedStartSource(startSource);
    const workflow = startSource.workflow;
    const schedulePreflight = preflightWorkflowStartSchedule(workflow, Date.now());
    if (!schedulePreflight.ok) {
      throw new Error("猶予時間を超えて過去になった指定時刻があります。時刻または遅延時の動作を確認してから開始してください。");
    }
    const response = await sendToContent({
      type: "AIPM_START",
      workflow,
      readOnlyRecovery: workflow.recovery,
      keepAwake: startSource.keepAwake
    }, intentTabId, intentEpoch, () => pendingStartsByTab.set(intentTabId, startIntent));
    if (response?.ok === true || response?.ok === false) clearPendingStart(intentTabId, startIntent);
    if (response?.ok !== true) throw new Error(response?.error ?? "開始できませんでした。");
    if (!isCurrentTargetRequest(intentTabId, intentEpoch, selectedTabId, targetEpoch)) return;
    await refreshTargetTabs();
  } catch (error) {
    failureMessage = error instanceof Error ? error.message : String(error);
    retainUnresolvedStart(intentTabId, intentEpoch, startIntent);
  } finally {
    startIntentInFlight = false;
  }
  if (!isCurrentTargetRequest(intentTabId, intentEpoch, selectedTabId, targetEpoch)) return;
  await refreshStatus();
  if (!isCurrentTargetRequest(intentTabId, intentEpoch, selectedTabId, targetEpoch)) return;
  const observedNewRun = typeof renderedRunControlSnapshot?.runId === "string" &&
    renderedRunControlSnapshot.runId !== observedRunIdBeforeStart;
  if (failureMessage && !observedNewRun && !pendingStartsByTab.has(intentTabId)) showRunFeedback(failureMessage);
}

el.start.addEventListener("click", startSelectedAutomation);
el.flowStart.addEventListener("click", startSelectedAutomation);

async function sendRunControl(type, fallbackMessage) {
  if (runControlIntentInFlight) return;
  const intentTabId = selectedTabId;
  const intentEpoch = targetEpoch;
  const sourceSnapshot = type === "AIPM_STOP"
    ? currentDurableStopSnapshot()
    : renderedRunControlSnapshot;
  const snapshot = sourceSnapshot ? { ...sourceSnapshot } : null;
  let failureMessage = null;
  runControlIntentInFlight = true;
  try {
    if (!snapshot || snapshot.tabId !== intentTabId || snapshot.targetEpoch !== intentEpoch) {
      throw new Error("操作対象の実行状態を確認できないため、更新してから再操作してください。");
    }
    const response = await sendToContent({
      type,
      expectedRunId: snapshot.runId,
      expectedStateRevision: snapshot.stateRevision,
      readOnlyRecovery: lastStatusPayload?.run?.workflow?.recovery ?? recoveryPolicy
    }, intentTabId, intentEpoch);
    if (!isCurrentTargetRequest(intentTabId, intentEpoch, selectedTabId, targetEpoch)) return;
    if (!response?.ok) failureMessage = response?.error ?? fallbackMessage;
    if (type === "AIPM_STOP" && response?.ok) {
      durableStopSnapshot = null;
      renderedRunControlSnapshot = null;
    }
  } catch (error) {
    failureMessage = error instanceof Error ? error.message : String(error);
  } finally {
    runControlIntentInFlight = false;
  }
  // The command remains bound to its captured Run. Its completion must also
  // belong to this selection before it consumes snapshots or updates feedback.
  if (!isCurrentTargetRequest(intentTabId, intentEpoch, selectedTabId, targetEpoch)) return;
  await refreshStatus();
  if (!isCurrentTargetRequest(intentTabId, intentEpoch, selectedTabId, targetEpoch)) return;
  try {
    await refreshTargetTabs();
  } catch (error) {
    failureMessage ??= error instanceof Error ? error.message : String(error);
  }
  if (failureMessage && isCurrentTargetRequest(intentTabId, intentEpoch, selectedTabId, targetEpoch)) {
    showRunFeedback(failureMessage);
    el.nextAction.textContent = "選択中のChatGPTタブとこのパネルの実行状態を確認し、上の「更新」を押してください。";
  }
}

el.pause.addEventListener("click", () => sendRunControl("AIPM_PAUSE", "一時停止できませんでした。"));
el.resume.addEventListener("click", () => sendRunControl("AIPM_RESUME", "再開できませんでした。"));
el.stop.addEventListener("click", () => sendRunControl("AIPM_STOP", "停止できませんでした。"));

/* Appearance only: paints the stored theme and keeps it in sync. It sends no
   message and reads no Run state, so a theme failure can never delay or alter
   Run control wiring below. */
try {
  await startAppearanceSync();
} catch {
  /* Rendering with the default appearance is always preferable to not
     rendering. Nothing downstream depends on this having succeeded. */
}

try {
  applyDiagnosticsPreference((await loadSettings()).settings);
} catch {
  applyDiagnosticsPreference(null);
}

try {
  await initializeFlowLibrary();
} catch (error) {
  renderFlowLibrary();
  el.flowLibraryStatus.textContent = error instanceof Error ? error.message : String(error);
}
try {
  await initializeTargetTabs();
} catch (error) {
  applyUiState(null);
  el.targetTabHint.textContent = error instanceof Error ? error.message : String(error);
}
await refreshStatus();
setInterval(() => refreshStatus({ periodic: true }), 1200);
setInterval(() => refreshTargetTabs().catch((error) => {
  el.targetTabHint.textContent = error instanceof Error ? error.message : String(error);
}), 4000);
