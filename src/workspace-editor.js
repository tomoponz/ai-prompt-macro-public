/*
  Phase 4B Fullscreen Workspace editor.

  This surface edits only the six-field per-tab editor payload and the existing
  local Flow Library. It never observes a renderer and owns no Run controls or
  Run authority. All editor writes go through WorkspaceEditorSession, which in
  turn uses ui-state-store's Web Lock + editorRevision compare-and-set fence.
*/

import { compileAipmFlow } from "./flow-compile.js";
import { fromDateTimeLocal, toDateTimeLocal } from "./editor-date-time.js";
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
import { AipmFlowError, MAX_FLOW_TEXT_BYTES } from "./flow-script.js";
import { loadEditorInitialState } from "./editor-defaults.js";
import { buildExecutionPlan, EXECUTION_MODES, summarizeExecutionPlan } from "./execution-plan.js";
import {
  DEFAULT_LATE_GRACE_MS,
  MAX_SENDS_PER_RUN,
  WORKFLOW_PRESETS,
  clonePreset,
  countPlannedSends,
  defaultBlock,
  normalizeWorkflow
} from "./workflow.js";
import { UI_STATE_MAP_KEY } from "./ui-state-store.js";
import {
  WORKSPACE_EDITOR_NOTICES,
  WorkspaceEditorSession,
  workspaceEditorTabIds
} from "./workspace-editor-state.js";

const PLACEHOLDER = "—";

const el = Object.fromEntries([
  "editorRevision", "editorTargetList", "editorTabId", "loadEditorTarget",
  "reloadEditorTarget", "saveEditorState", "editorStateNotice", "editorEmpty",
  "editorContent", "flowEditorTab", "workflowEditorTab", "flowEditorPanel",
  "workflowEditorPanel", "copyWorkspaceFlow", "workspaceFlowText", "workspaceFlowError",
  "workspaceFlowSelector", "workspaceExecutionMode", "workspaceRangeControls",
  "workspaceRangeStart", "workspaceRangeEnd", "workspaceRangeRepeat",
  "workspaceCheckpointControls", "workspaceCheckpoint", "workspacePlanError",
  "workspacePreviewName", "workspacePreviewRange", "workspacePreviewSends",
  "workspacePreviewBlocks", "workspacePreviewWaits", "workspacePreviewCheckpoints",
  "workspaceImportText", "workspaceImportPaste", "workspaceImportFile",
  "workspaceExportFile", "workspaceImportStatus", "workspaceLibraryRevision",
  "workspaceLibrarySearch", "workspaceLibraryList", "workspaceLibraryName",
  "workspaceLibraryFavorite", "workspaceLibraryDescription", "workspaceLibrarySaveNew",
  "workspaceLibraryUpdate", "workspaceLibraryOpen", "workspaceLibraryDuplicate",
  "workspaceLibraryRename", "workspaceLibraryDelete", "workspaceLibraryCopy",
  "workspaceLibraryExport", "workspaceLibraryStatus", "workspaceWorkflowName",
  "workspaceWorkflowMaxSends", "workspaceWorkflowPreset", "workspaceLoadWorkflowPreset",
  "workspaceAddPrompt", "workspaceAddDelay", "workspaceAddWaitUntil",
  "workspaceAddCheckpoint", "workspaceSteps", "workspaceWorkflowPreviewName",
  "workspaceWorkflowPreviewBlocks", "workspaceWorkflowPreviewSends",
  "workspaceWorkflowPreviewMax", "workspaceWorkflowError"
].map((id) => [id, document.querySelector(`#${id}`)]));

const session = new WorkspaceEditorSession({
  createMissingState: async () => (await loadEditorInitialState({ mode: "flow" })).state
});
let suppressDirty = false;
let activeEditorKind = "flow";
let customWorkflow = clonePreset("continuous-improvement");
let flowCompilation = null;
let flowExecutionPlan = null;
let flowSelectedIndex = 0;
let flowExecutionConfig = { mode: "full", start: "1", end: "1", repeat: "1", checkpointId: "" };
let flowLibrary = { schemaVersion: 1, revision: 0, entries: [] };
let selectedFlowLibraryId = null;
let openedFlowLibraryId = null;
let openedFlowLibraryRevision = null;
let knownEditorTabIds = [];
let targetOperationInFlight = false;
let libraryOperationInFlight = false;

function clone(value) {
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function setText(node, value) {
  if (node) node.textContent = value == null || value === "" ? PLACEHOLDER : String(value);
}

function setNotice(kind, text = null) {
  const message = text ?? (kind ? WORKSPACE_EDITOR_NOTICES[kind] ?? WORKSPACE_EDITOR_NOTICES.write : "");
  el.editorStateNotice.textContent = message;
  el.editorStateNotice.hidden = !message;
}

function parseExactTabId(value) {
  const raw = String(value ?? "").trim();
  if (!/^[0-9]+$/.test(raw)) return null;
  const number = Number(raw);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function renderTargetOptions() {
  const ids = [...new Set([
    ...knownEditorTabIds,
    ...(Number.isInteger(session.tabId) ? [session.tabId] : [])
  ])].sort((left, right) => left - right);
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = ids.length ? "保存済み項目を選択" : "保存済み項目はありません";
  const options = ids.map((tabId) => {
    const option = document.createElement("option");
    option.value = String(tabId);
    option.textContent = `タブ ${tabId}`;
    return option;
  });
  el.editorTargetList.replaceChildren(placeholder, ...options);
  el.editorTargetList.value = Number.isInteger(session.tabId) ? String(session.tabId) : "";
}

async function refreshEditorTargets(sourceMap = undefined) {
  try {
    const map = sourceMap === undefined
      ? (await chrome.storage.local.get(UI_STATE_MAP_KEY))[UI_STATE_MAP_KEY]
      : sourceMap;
    knownEditorTabIds = workspaceEditorTabIds(map);
    renderTargetOptions();
  } catch {
    setNotice("read");
  }
}

function syncTargetUi() {
  const hasTarget = session.hasTarget;
  el.editorEmpty.classList.toggle("hidden", hasTarget);
  el.editorContent.classList.toggle("hidden", !hasTarget);
  el.saveEditorState.disabled = !hasTarget || !session.dirty || session.stale || session.saving || targetOperationInFlight;
  el.reloadEditorTarget.disabled = !hasTarget || session.saving || targetOperationInFlight;
  el.editorRevision.textContent = Number.isSafeInteger(session.editorRevision)
    ? `リビジョン ${session.editorRevision}${session.dirty ? " · 未保存" : ""}`
    : "リビジョン —";
  if (Number.isInteger(session.tabId)) {
    el.editorTabId.value = String(session.tabId);
    el.editorTargetList.value = String(session.tabId);
  }
}

function setEditorKind(kind, { mark = false } = {}) {
  activeEditorKind = kind === "workflow" ? "workflow" : "flow";
  const flowActive = activeEditorKind === "flow";
  el.flowEditorPanel.classList.toggle("hidden", !flowActive);
  el.workflowEditorPanel.classList.toggle("hidden", flowActive);
  el.flowEditorTab.setAttribute("aria-selected", String(flowActive));
  el.workflowEditorTab.setAttribute("aria-selected", String(!flowActive));
  if (mark && session.hasTarget) markDirty(activeEditorKind);
}

function currentFlowState(base = {}) {
  return {
    ...(base && typeof base === "object" ? clone(base) : {}),
    text: el.workspaceFlowText.value,
    selectedIndex: flowSelectedIndex,
    openedLibraryId: openedFlowLibraryId,
    execution: { ...flowExecutionConfig }
  };
}

function markDirty(kind = activeEditorKind) {
  if (suppressDirty || !session.hasTarget) return;
  const state = session.snapshot();
  state.mode = kind;
  state.workflow = clone(customWorkflow);
  state.flow = currentFlowState(state.flow);
  session.replaceState(state);
  syncTargetUi();
}

async function openEditorTarget(tabId, { reload = false } = {}) {
  if (targetOperationInFlight || session.saving) {
    setNotice("busy");
    return false;
  }
  if (!reload && session.tabId === tabId) return true;
  if (session.needsDiscardConfirmation &&
      !window.confirm("現在の未保存入力または古くなった入力を破棄して、別の保存済み内容を読み込みますか？")) {
    syncTargetUi();
    return false;
  }

  targetOperationInFlight = true;
  syncTargetUi();
  const previousTabId = session.tabId;
  const result = await session.open(tabId);
  targetOperationInFlight = false;
  if (!result.ok) {
    setNotice(result.reason);
    if (Number.isInteger(previousTabId)) el.editorTabId.value = String(previousTabId);
    syncTargetUi();
    return false;
  }

  setNotice(null);
  applyEditorState(result.state);
  renderTargetOptions();
  syncTargetUi();
  return true;
}

async function saveEditorState() {
  if (!session.hasTarget) {
    setNotice("invalid");
    return;
  }
  syncTargetUi();
  const result = await session.save();
  if (!result.ok) {
    setNotice(result.reason);
    syncTargetUi();
    return;
  }
  if (result.conflictedAfterSave) {
    setNotice("stale", `編集状態を保存しました（リビジョン ${result.editorRevision}）。その後、別の画面で更新されました。現在の入力は保持し、「保存済み内容を読み直す」を押すまで保存しません。`);
  } else {
    setNotice(null, result.dirty
      ? `編集状態を保存しました（リビジョン ${result.editorRevision}）。保存中の追加入力は未保存のまま保持しています。`
      : `編集状態を保存しました（リビジョン ${result.editorRevision}）。サイドパネルで同じタブの「保存済み実行内容」を確認して開始してください。`);
  }
  knownEditorTabIds = [...new Set([...knownEditorTabIds, session.tabId])];
  renderTargetOptions();
  syncTargetUi();
}

/* ------------------------------------------------------------- Flow editor */

function selectedCompiledFlow() {
  return flowCompilation?.flows?.[flowSelectedIndex] ?? null;
}

function syncFlowExecutionConfigFromUi() {
  flowExecutionConfig = {
    mode: EXECUTION_MODES.includes(el.workspaceExecutionMode.value)
      ? el.workspaceExecutionMode.value
      : "full",
    start: el.workspaceRangeStart.value,
    end: el.workspaceRangeEnd.value,
    repeat: el.workspaceRangeRepeat.value,
    checkpointId: el.workspaceCheckpoint.value
  };
}

function renderFlowExecutionControls() {
  const steps = selectedCompiledFlow()?.workflow?.steps ?? [];
  const total = Math.max(1, steps.length);
  el.workspaceExecutionMode.value = flowExecutionConfig.mode;
  el.workspaceRangeStart.max = String(total);
  el.workspaceRangeEnd.max = String(total);
  el.workspaceRangeStart.value = flowExecutionConfig.start;
  el.workspaceRangeEnd.value = flowExecutionConfig.end;
  el.workspaceRangeRepeat.value = flowExecutionConfig.repeat;

  const mode = flowExecutionConfig.mode;
  el.workspaceRangeControls.classList.toggle("hidden", !["step", "from", "range", "range-repeat"].includes(mode));
  el.workspaceRangeEnd.parentElement.classList.toggle("hidden", ["step", "from"].includes(mode));
  el.workspaceRangeRepeat.parentElement.classList.toggle("hidden", mode !== "range-repeat");
  el.workspaceCheckpointControls.classList.toggle("hidden", mode !== "after-checkpoint");

  const checkpoints = steps.filter((step) => step.type === "checkpoint");
  const options = checkpoints.map((step) => {
    const option = document.createElement("option");
    option.value = step.id;
    option.textContent = step.label;
    return option;
  });
  el.workspaceCheckpoint.replaceChildren(...options);
  if (!checkpoints.some((step) => step.id === flowExecutionConfig.checkpointId)) {
    flowExecutionConfig.checkpointId = checkpoints[0]?.id ?? "";
  }
  el.workspaceCheckpoint.value = flowExecutionConfig.checkpointId;
}

function clearFlowPreview() {
  for (const node of [
    el.workspacePreviewName, el.workspacePreviewRange, el.workspacePreviewSends,
    el.workspacePreviewBlocks, el.workspacePreviewWaits, el.workspacePreviewCheckpoints
  ]) setText(node, null);
}

function rebuildFlowPlan() {
  flowExecutionPlan = null;
  el.workspacePlanError.textContent = "";
  el.workspacePlanError.hidden = true;
  const compiled = selectedCompiledFlow();
  if (!compiled) {
    clearFlowPreview();
    return;
  }
  try {
    syncFlowExecutionConfigFromUi();
    flowExecutionPlan = buildExecutionPlan(compiled, flowExecutionConfig);
    const summary = summarizeExecutionPlan(compiled, flowExecutionPlan);
    setText(el.workspacePreviewName, summary.flowName);
    setText(el.workspacePreviewRange, summary.executionRange);
    setText(el.workspacePreviewSends, summary.plannedSends);
    setText(el.workspacePreviewBlocks, summary.blocks);
    setText(el.workspacePreviewWaits, summary.waits);
    setText(el.workspacePreviewCheckpoints, summary.checkpoints);
  } catch (error) {
    clearFlowPreview();
    el.workspacePlanError.textContent = error instanceof Error
      ? error.message
      : "部分実行planを安全に作成できませんでした。";
    el.workspacePlanError.hidden = false;
  }
}

function compileFlowEditor() {
  try {
    flowCompilation = compileAipmFlow(el.workspaceFlowText.value);
    flowSelectedIndex = Math.min(
      Math.max(0, Number.isSafeInteger(flowSelectedIndex) ? flowSelectedIndex : 0),
      flowCompilation.flows.length - 1
    );
    const options = flowCompilation.flows.map((flow, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = String(flow.name ?? "Flow").slice(0, 80);
      return option;
    });
    el.workspaceFlowSelector.replaceChildren(...options);
    el.workspaceFlowSelector.value = String(flowSelectedIndex);
    el.workspaceFlowSelector.disabled = options.length <= 1;
    el.workspaceFlowError.textContent = "";
    el.workspaceFlowError.hidden = true;
    renderFlowExecutionControls();
    rebuildFlowPlan();
  } catch (error) {
    flowCompilation = null;
    flowExecutionPlan = null;
    el.workspaceFlowSelector.replaceChildren();
    el.workspaceFlowSelector.disabled = true;
    el.workspaceFlowError.textContent = error instanceof AipmFlowError
      ? `${error.code} · line ${error.line}, column ${error.column}\n${error.message}`
      : "FLOW_COMPILE_FAILED · Flowを安全に解析できませんでした。";
    el.workspaceFlowError.hidden = false;
    renderFlowExecutionControls();
    clearFlowPreview();
  }
}

function importFlowSource(source, originLabel) {
  const validated = validateImportedFlowText(source);
  el.workspaceFlowText.value = validated;
  selectedFlowLibraryId = null;
  openedFlowLibraryId = null;
  flowSelectedIndex = 0;
  flowExecutionConfig = { mode: "full", start: "1", end: "1", repeat: "1", checkpointId: "" };
  renderFlowLibrary();
  compileFlowEditor();
  setEditorKind("flow");
  markDirty("flow");
  el.workspaceImportStatus.textContent = `${originLabel}を検証しました。読み込みだけでは実行を開始しません。`;
}

function safeFlowFilename(name) {
  const base = String(name ?? "aipm-flow").trim().replace(/[<>:"/\\|?*\x00-\x1F]+/g, "-").slice(0, 80);
  return `${base || "aipm-flow"}.aipm.txt`;
}

function downloadFlowText(source, name) {
  const url = URL.createObjectURL(new Blob([source], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = safeFlowFilename(name);
  anchor.click();
  queueMicrotask(() => URL.revokeObjectURL(url));
}

/* ---------------------------------------------------------- Workflow editor */

function controlGroup(labelText, control) {
  const label = document.createElement("label");
  label.textContent = labelText;
  label.append(control);
  return label;
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

function titleForStep(step) {
  if (step.type === "delay") return "待機";
  if (step.type === "wait-until") return "指定時刻まで待つ";
  if (step.type === "checkpoint") return "確認ポイント";
  return step.delivery === "draft" ? "AIへの指示 · 入力だけして確認" : "AIへの指示 · 入力して送信";
}

function markWorkflowChange({ rerender = false } = {}) {
  customWorkflow.name = el.workspaceWorkflowName.value.trim() || "カスタム自動化フロー";
  customWorkflow.maxSends = Number.parseInt(el.workspaceWorkflowMaxSends.value, 10) || 1;
  if (rerender) renderWorkflowEditor();
  renderWorkflowPreview();
  markDirty("workflow");
}

function stepBody(step) {
  const body = document.createElement("div");
  body.className = "workspace-step-body";

  if (step.type === "delay") {
    const duration = document.createElement("input");
    duration.type = "number";
    duration.min = "0";
    duration.max = "86400";
    duration.value = String(Math.round(Number(step.durationMs ?? 5000) / 1000));
    duration.addEventListener("change", () => {
      step.durationMs = Math.max(0, Math.round((Number(duration.value) || 0) * 1000));
      markWorkflowChange();
    });
    body.append(controlGroup("待機時間（秒）", duration));
    return body;
  }

  if (step.type === "wait-until") {
    const when = document.createElement("input");
    when.type = "datetime-local";
    when.value = toDateTimeLocal(step.at);
    when.addEventListener("change", () => {
      step.at = fromDateTimeLocal(when.value);
      markWorkflowChange();
    });
    const policy = selectControl([
      ["pause", "確認して停止"], ["run", "遅れても実行"], ["skip", "遅れたらスキップ"]
    ], step.latePolicy ?? "pause");
    policy.addEventListener("change", () => {
      step.latePolicy = policy.value;
      markWorkflowChange();
    });
    const grace = document.createElement("input");
    grace.type = "number";
    grace.min = "0";
    grace.max = "1440";
    grace.value = String(Math.round(Number(step.graceMs ?? DEFAULT_LATE_GRACE_MS) / 60000));
    grace.addEventListener("change", () => {
      step.graceMs = Math.max(0, Math.round((Number(grace.value) || 0) * 60000));
      markWorkflowChange();
    });
    const grid = document.createElement("div");
    grid.className = "form-grid";
    grid.append(controlGroup("実行時刻", when), controlGroup("遅れたとき", policy), controlGroup("許容する遅れ（分）", grace));
    body.append(grid);
    return body;
  }

  if (step.type === "checkpoint") {
    const label = document.createElement("input");
    label.value = step.label ?? "確認してから続行";
    label.addEventListener("input", () => {
      step.label = label.value;
      markWorkflowChange();
    });
    body.append(controlGroup("確認時のメッセージ", label));
    return body;
  }

  const prompt = document.createElement("textarea");
  prompt.rows = 4;
  prompt.spellcheck = false;
  prompt.value = step.prompt ?? "";
  prompt.addEventListener("input", () => {
    step.prompt = prompt.value;
    markWorkflowChange();
  });
  const delivery = selectControl([["send", "入力して送信"], ["draft", "入力だけして確認"]], step.delivery ?? "send");
  delivery.addEventListener("change", () => {
    step.delivery = delivery.value;
    if (delivery.value === "draft") {
      step.repeat = 1;
      step.delayAfterMs = 0;
    }
    markWorkflowChange({ rerender: true });
  });
  const repeat = document.createElement("input");
  repeat.type = "number";
  repeat.min = "1";
  repeat.max = String(MAX_SENDS_PER_RUN);
  repeat.value = String(step.repeat ?? 1);
  repeat.disabled = step.delivery === "draft";
  repeat.addEventListener("change", () => {
    step.repeat = Number.parseInt(repeat.value, 10) || 1;
    const sends = countPlannedSends(customWorkflow);
    customWorkflow.maxSends = Math.min(MAX_SENDS_PER_RUN, Math.max(customWorkflow.maxSends ?? 1, sends || 1));
    markWorkflowChange({ rerender: true });
  });
  const delay = document.createElement("input");
  delay.type = "number";
  delay.min = "0";
  delay.max = "300";
  delay.step = "0.5";
  delay.value = String(Number(step.delayAfterMs ?? 0) / 1000);
  delay.disabled = step.delivery === "draft";
  delay.addEventListener("change", () => {
    step.delayAfterMs = Math.max(0, Math.round((Number(delay.value) || 0) * 1000));
    markWorkflowChange();
  });
  const grid = document.createElement("div");
  grid.className = "form-grid";
  grid.append(controlGroup("動作", delivery), controlGroup("繰り返し回数", repeat), controlGroup("完了後の待機（秒）", delay));
  body.append(controlGroup("AIへの指示", prompt), grid);
  return body;
}

function renderWorkflowEditor() {
  el.workspaceWorkflowName.value = customWorkflow.name ?? "カスタム自動化フロー";
  el.workspaceWorkflowMaxSends.value = String(customWorkflow.maxSends ?? 1);
  const steps = Array.isArray(customWorkflow.steps) ? customWorkflow.steps : [];
  const nodes = steps.map((step, index) => {
    const wrapper = document.createElement("section");
    wrapper.className = "workspace-step";
    const head = document.createElement("div");
    head.className = "workspace-step-head";
    const title = document.createElement("span");
    title.className = "workspace-step-title";
    title.textContent = `${index + 1}. ${titleForStep(step)}`;
    const actions = document.createElement("div");
    actions.className = "workspace-step-actions";
    for (const [label, delta, aria] of [["↑", -1, "上へ移動"], ["↓", 1, "下へ移動"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.setAttribute("aria-label", aria);
      button.disabled = delta < 0 ? index === 0 : index === steps.length - 1;
      button.addEventListener("click", () => {
        const next = index + delta;
        if (next < 0 || next >= steps.length) return;
        const [moved] = steps.splice(index, 1);
        steps.splice(next, 0, moved);
        markWorkflowChange({ rerender: true });
      });
      actions.append(button);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "手順を削除");
    remove.addEventListener("click", () => {
      steps.splice(index, 1);
      markWorkflowChange({ rerender: true });
    });
    actions.append(remove);
    head.append(title, actions);
    wrapper.append(head, stepBody(step));
    return wrapper;
  });
  el.workspaceSteps.replaceChildren(...nodes);
  renderWorkflowPreview();
}

function renderWorkflowPreview() {
  try {
    const validated = normalizeWorkflow(clone(customWorkflow));
    setText(el.workspaceWorkflowPreviewName, validated.name);
    setText(el.workspaceWorkflowPreviewBlocks, validated.steps.length);
    setText(el.workspaceWorkflowPreviewSends, countPlannedSends(validated));
    setText(el.workspaceWorkflowPreviewMax, validated.maxSends);
    el.workspaceWorkflowError.textContent = "";
    el.workspaceWorkflowError.hidden = true;
  } catch (error) {
    setText(el.workspaceWorkflowPreviewName, customWorkflow.name);
    setText(el.workspaceWorkflowPreviewBlocks, Array.isArray(customWorkflow.steps) ? customWorkflow.steps.length : 0);
    setText(el.workspaceWorkflowPreviewSends, null);
    setText(el.workspaceWorkflowPreviewMax, customWorkflow.maxSends);
    el.workspaceWorkflowError.textContent = error instanceof Error
      ? error.message
      : "Workflowを安全にvalidationできませんでした。";
    el.workspaceWorkflowError.hidden = false;
  }
}

/* ------------------------------------------------------------- Flow Library */

function selectedLibraryEntry() {
  return flowLibrary.entries.find((entry) => entry.id === selectedFlowLibraryId) ?? null;
}

function renderFlowLibrary() {
  const entries = searchFlowLibrary(flowLibrary, el.workspaceLibrarySearch.value);
  openedFlowLibraryId = resolveOpenedFlowLibraryId(flowLibrary, openedFlowLibraryId);
  if (!openedFlowLibraryId) openedFlowLibraryRevision = null;
  if (!entries.some((entry) => entry.id === selectedFlowLibraryId)) {
    selectedFlowLibraryId = entries[0]?.id ?? null;
  }
  const options = entries.map((entry) => {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = `${entry.favorite ? "★ " : ""}${entry.name}`;
    return option;
  });
  el.workspaceLibraryList.replaceChildren(...options);
  if (selectedFlowLibraryId) el.workspaceLibraryList.value = selectedFlowLibraryId;
  const selected = selectedLibraryEntry();
  el.workspaceLibraryName.value = selected?.name ?? "";
  el.workspaceLibraryDescription.value = selected?.description ?? "";
  el.workspaceLibraryFavorite.checked = selected?.favorite === true;
  el.workspaceLibraryRevision.textContent = `リビジョン ${flowLibrary.revision ?? 0}`;
  el.workspaceLibraryUpdate.disabled = !canUpdateOpenedFlowLibraryEntry(flowLibrary, selectedFlowLibraryId, openedFlowLibraryId);
  for (const button of [
    el.workspaceLibraryOpen, el.workspaceLibraryDuplicate, el.workspaceLibraryRename,
    el.workspaceLibraryDelete, el.workspaceLibraryCopy, el.workspaceLibraryExport
  ]) button.disabled = !selected;
}

async function refreshFlowLibrary() {
  try {
    flowLibrary = await loadFlowLibrary();
    renderFlowLibrary();
  } catch {
    el.workspaceLibraryStatus.textContent = "Flowライブラリを読み取れませんでした。エディター入力は変更していません。";
  }
}

function libraryMetadata() {
  return {
    name: el.workspaceLibraryName.value,
    description: el.workspaceLibraryDescription.value,
    favorite: el.workspaceLibraryFavorite.checked === true
  };
}

function hasUnsavedLibraryMetadata() {
  const selected = selectedLibraryEntry();
  if (!selected) return false;
  const current = libraryMetadata();
  return current.name !== selected.name || current.description !== selected.description ||
    current.favorite !== selected.favorite;
}

function captureLibraryIntent() {
  return {
    tabId: session.tabId,
    editVersion: session.editVersion,
    selectedId: selectedFlowLibraryId,
    openedId: openedFlowLibraryId,
    libraryRevision: flowLibrary.revision,
    openedRevision: openedFlowLibraryRevision,
    editorSource: el.workspaceFlowText.value,
    metadata: libraryMetadata()
  };
}

function assertLibraryIntent(intent, requirements = {}) {
  if (session.tabId !== intent.tabId || session.editVersion !== intent.editVersion) {
    throw new Error("ライブラリ操作中に編集対象または内容が変わったため、編集画面へ反映しませんでした。");
  }
  if (requirements.selected && selectedFlowLibraryId !== intent.selectedId) {
    throw new Error("ライブラリ操作中に一覧の選択が変わりました。");
  }
  if (requirements.opened && openedFlowLibraryId !== intent.openedId) {
    throw new Error("ライブラリ操作中に編集画面で開いている項目が変わりました。");
  }
  if (requirements.source && el.workspaceFlowText.value !== intent.editorSource) {
    throw new Error("ライブラリ操作中にFlowテキストが変わりました。");
  }
  if (requirements.metadata) {
    const current = libraryMetadata();
    if (current.name !== intent.metadata.name || current.description !== intent.metadata.description ||
        current.favorite !== intent.metadata.favorite) {
      throw new Error("ライブラリ操作中に名前・説明・お気に入りが変わりました。");
    }
  }
}

function requireFreshEntry(library, id, action) {
  const entry = library.entries.find((item) => item.id === id) ?? null;
  if (!entry) throw new Error(`${action}するライブラリ項目は既に削除または変更されています。`);
  return entry;
}

async function saveLibrary(message, mutation, expectedRevision) {
  flowLibrary = await mutateFlowLibrary(mutation, { expectedRevision });
  if (resolveOpenedFlowLibraryId(flowLibrary, openedFlowLibraryId)) {
    openedFlowLibraryRevision = flowLibrary.revision;
  }
  renderFlowLibrary();
  el.workspaceLibraryStatus.textContent = message;
}

async function runLibraryAction(action) {
  if (libraryOperationInFlight) {
    el.workspaceLibraryStatus.textContent = "別のライブラリ操作が完了するまで待ってください。";
    return;
  }
  libraryOperationInFlight = true;
  const intent = captureLibraryIntent();
  try {
    await action(intent);
  } catch (error) {
    el.workspaceLibraryStatus.textContent = error instanceof Error
      ? error.message
      : "Flow Library操作に失敗しました。";
  } finally {
    libraryOperationInFlight = false;
  }
}

/* ---------------------------------------------------------------- lifecycle */

function applyEditorState(state) {
  suppressDirty = true;
  try {
    customWorkflow = state?.workflow && typeof state.workflow === "object"
      ? clone(state.workflow)
      : clonePreset("continuous-improvement");
    if (!Array.isArray(customWorkflow.steps)) customWorkflow.steps = [];
    el.workspaceFlowText.value = typeof state?.flow?.text === "string" ? state.flow.text : "";
    openedFlowLibraryId = resolveOpenedFlowLibraryId(flowLibrary, state?.flow?.openedLibraryId);
    openedFlowLibraryRevision = openedFlowLibraryId ? flowLibrary.revision : null;
    selectedFlowLibraryId = openedFlowLibraryId;
    const index = Number(state?.flow?.selectedIndex ?? 0);
    flowSelectedIndex = Number.isSafeInteger(index) && index >= 0 ? index : 0;
    const execution = state?.flow?.execution;
    flowExecutionConfig = {
      mode: EXECUTION_MODES.includes(execution?.mode) ? execution.mode : "full",
      start: String(execution?.start ?? "1"),
      end: String(execution?.end ?? "1"),
      repeat: String(execution?.repeat ?? "1"),
      checkpointId: String(execution?.checkpointId ?? "")
    };
    activeEditorKind = state?.mode === "workflow" ? "workflow" : "flow";
    renderFlowLibrary();
    compileFlowEditor();
    renderWorkflowEditor();
    setEditorKind(activeEditorKind);
  } finally {
    suppressDirty = false;
  }
}

function bindEditorEvents() {
  el.loadEditorTarget.addEventListener("click", () => {
    const tabId = parseExactTabId(el.editorTabId.value);
    if (tabId === null) setNotice("invalid");
    else return openEditorTarget(tabId);
  });
  el.editorTargetList.addEventListener("change", () => {
    const tabId = parseExactTabId(el.editorTargetList.value);
    if (tabId === null) return;
    el.editorTabId.value = String(tabId);
    return openEditorTarget(tabId);
  });
  el.reloadEditorTarget.addEventListener("click", () => {
    if (Number.isInteger(session.tabId)) return openEditorTarget(session.tabId, { reload: true });
  });
  el.saveEditorState.addEventListener("click", saveEditorState);
  el.flowEditorTab.addEventListener("click", () => setEditorKind("flow", { mark: true }));
  el.workflowEditorTab.addEventListener("click", () => setEditorKind("workflow", { mark: true }));

  el.workspaceFlowText.addEventListener("input", () => {
    compileFlowEditor();
    markDirty("flow");
  });
  el.workspaceFlowSelector.addEventListener("change", () => {
    const index = Number.parseInt(el.workspaceFlowSelector.value, 10);
    flowSelectedIndex = Number.isSafeInteger(index) && index >= 0 ? index : 0;
    renderFlowExecutionControls();
    rebuildFlowPlan();
    markDirty("flow");
  });
  el.workspaceExecutionMode.addEventListener("change", () => {
    syncFlowExecutionConfigFromUi();
    renderFlowExecutionControls();
    rebuildFlowPlan();
    markDirty("flow");
  });
  for (const node of [el.workspaceRangeStart, el.workspaceRangeEnd, el.workspaceRangeRepeat, el.workspaceCheckpoint]) {
    node.addEventListener("change", () => {
      syncFlowExecutionConfigFromUi();
      rebuildFlowPlan();
      markDirty("flow");
    });
  }
  el.copyWorkspaceFlow.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(el.workspaceFlowText.value);
      el.workspaceImportStatus.textContent = "Flowテキストをコピーしました。";
    } catch {
      el.workspaceImportStatus.textContent = "コピーできませんでした。手動で選択してください。";
    }
  });
  el.workspaceImportPaste.addEventListener("click", () => {
    try {
      importFlowSource(el.workspaceImportText.value, "貼り付け内容");
    } catch (error) {
      el.workspaceImportStatus.textContent = error instanceof Error ? error.message : "読み込みに失敗しました。";
    }
  });
  el.workspaceImportFile.addEventListener("change", async () => {
    const file = el.workspaceImportFile.files?.[0];
    if (!file) return;
    try {
      if (file.size > MAX_FLOW_TEXT_BYTES) throw new Error(`AIPM Flowは${MAX_FLOW_TEXT_BYTES} bytes以下にしてください。`);
      importFlowSource(await file.text(), `file「${file.name}」`);
    } catch (error) {
      el.workspaceImportStatus.textContent = error instanceof Error ? error.message : "読み込みに失敗しました。";
    } finally {
      el.workspaceImportFile.value = "";
    }
  });
  el.workspaceExportFile.addEventListener("click", () => {
    try {
      const source = validateImportedFlowText(el.workspaceFlowText.value);
      downloadFlowText(source, selectedCompiledFlow()?.name ?? "aipm-flow");
      el.workspaceImportStatus.textContent = "検証済みFlowをプレーンテキストファイルへ書き出しました。";
    } catch (error) {
      el.workspaceImportStatus.textContent = error instanceof Error ? error.message : "書き出しに失敗しました。";
    }
  });

  el.workspaceWorkflowName.addEventListener("input", () => markWorkflowChange());
  el.workspaceWorkflowMaxSends.addEventListener("change", () => markWorkflowChange());
  el.workspaceLoadWorkflowPreset.addEventListener("click", () => {
    customWorkflow = clonePreset(el.workspaceWorkflowPreset.value);
    renderWorkflowEditor();
    markDirty("workflow");
  });
  for (const [node, type] of [
    [el.workspaceAddPrompt, "prompt"], [el.workspaceAddDelay, "delay"],
    [el.workspaceAddWaitUntil, "wait-until"], [el.workspaceAddCheckpoint, "checkpoint"]
  ]) {
    node.addEventListener("click", () => {
      if (!Array.isArray(customWorkflow.steps)) customWorkflow.steps = [];
      customWorkflow.steps.push(defaultBlock(type));
      const sends = countPlannedSends(customWorkflow);
      customWorkflow.maxSends = Math.min(MAX_SENDS_PER_RUN, Math.max(customWorkflow.maxSends ?? 1, sends || 1));
      renderWorkflowEditor();
      markDirty("workflow");
    });
  }

  el.workspaceLibrarySearch.addEventListener("input", renderFlowLibrary);
  el.workspaceLibraryList.addEventListener("change", () => {
    selectedFlowLibraryId = el.workspaceLibraryList.value || null;
    renderFlowLibrary();
  });
  el.workspaceLibrarySaveNew.addEventListener("click", () => runLibraryAction(async (intent) => {
    const entry = createFlowLibraryEntry({ ...intent.metadata, source: intent.editorSource });
    await saveLibrary(
      "Flowテキストと名前・説明・お気に入りをライブラリへ新規保存しました。",
      (latest) => upsertFlowLibraryEntry(latest, entry),
      intent.libraryRevision
    );
    assertLibraryIntent(intent, { source: true });
    selectedFlowLibraryId = entry.id;
    openedFlowLibraryId = entry.id;
    openedFlowLibraryRevision = flowLibrary.revision;
    renderFlowLibrary();
    markDirty("flow");
  }));
  el.workspaceLibraryUpdate.addEventListener("click", () => runLibraryAction(async (intent) => {
    if (!canUpdateOpenedFlowLibraryEntry(flowLibrary, intent.selectedId, intent.openedId)) {
      throw new Error("一覧で選んだ項目と編集中の項目が一致しないため、上書きしませんでした。");
    }
    await saveLibrary("Flowテキストと名前・説明・お気に入りをライブラリへ上書き保存しました。", (latest) => {
      assertLibraryIntent(intent, { selected: true, opened: true, source: true, metadata: true });
      const fresh = requireFreshEntry(latest, intent.selectedId, "上書き");
      return upsertFlowLibraryEntry(latest, updateFlowLibraryEntry(fresh, { ...intent.metadata, source: intent.editorSource }));
    }, intent.openedRevision);
  }));
  el.workspaceLibraryOpen.addEventListener("click", () => runLibraryAction(async (intent) => {
    const selected = selectedLibraryEntry();
    if (!selected) throw new Error("開くライブラリ項目を選択してください。");
    if (isOpenedFlowLibraryDirty(flowLibrary, intent.openedId, intent.editorSource) &&
        !window.confirm("現在開いているFlowの未保存変更を破棄して、選択中の項目を開きますか？")) return;
    let opened = null;
    await saveLibrary("ライブラリ項目を開きました。実行は開始していません。", (latest) => {
      assertLibraryIntent(intent, { selected: true, opened: true, source: true });
      opened = markFlowLibraryOpened(requireFreshEntry(latest, intent.selectedId, "Open"));
      return upsertFlowLibraryEntry(latest, opened);
    }, intent.libraryRevision);
    assertLibraryIntent(intent, { selected: true, opened: true, source: true });
    el.workspaceFlowText.value = opened.source;
    openedFlowLibraryId = opened.id;
    openedFlowLibraryRevision = flowLibrary.revision;
    flowSelectedIndex = 0;
    flowExecutionConfig = { mode: "full", start: "1", end: "1", repeat: "1", checkpointId: "" };
    compileFlowEditor();
    renderFlowLibrary();
    setEditorKind("flow");
    markDirty("flow");
  }));
  el.workspaceLibraryDuplicate.addEventListener("click", () => runLibraryAction(async (intent) => {
    const selected = selectedLibraryEntry();
    if (!selected) throw new Error("複製するライブラリ項目を選択してください。");
    let duplicate = null;
    await saveLibrary("ライブラリ項目を複製しました。", (latest) => {
      assertLibraryIntent(intent, { selected: true });
      duplicate = duplicateFlowLibraryEntry(requireFreshEntry(latest, intent.selectedId, "Duplicate"));
      return upsertFlowLibraryEntry(latest, duplicate);
    }, intent.libraryRevision);
    selectedFlowLibraryId = duplicate.id;
    renderFlowLibrary();
  }));
  el.workspaceLibraryRename.addEventListener("click", () => runLibraryAction(async (intent) => {
    await saveLibrary("ライブラリ項目の名前を変更しました。", (latest) => {
      assertLibraryIntent(intent, { selected: true });
      const fresh = requireFreshEntry(latest, intent.selectedId, "Rename");
      return upsertFlowLibraryEntry(latest, updateFlowLibraryEntry(fresh, { name: intent.metadata.name }));
    }, intent.libraryRevision);
  }));
  el.workspaceLibraryDelete.addEventListener("click", () => runLibraryAction(async (intent) => {
    const selected = selectedLibraryEntry();
    if (!selected) throw new Error("削除するライブラリ項目を選択してください。");
    if (!window.confirm(`「${selected.name}」をこのPCのライブラリから削除しますか？`)) return;
    const deletedWasOpened = intent.openedId === intent.selectedId;
    await saveLibrary("ライブラリ項目を削除しました。エディター入力は保持しています。", (latest) => {
      assertLibraryIntent(intent, { selected: true });
      requireFreshEntry(latest, intent.selectedId, "Delete");
      return deleteFlowLibraryEntry(latest, intent.selectedId);
    }, intent.libraryRevision);
    if (selectedFlowLibraryId === intent.selectedId) selectedFlowLibraryId = null;
    if (deletedWasOpened) {
      openedFlowLibraryId = null;
      markDirty("flow");
    }
    renderFlowLibrary();
  }));
  el.workspaceLibraryCopy.addEventListener("click", () => runLibraryAction(async () => {
    const selected = selectedLibraryEntry();
    if (!selected) throw new Error("コピーするライブラリ項目を選択してください。");
    await navigator.clipboard.writeText(exportFlowText(selected));
    el.workspaceLibraryStatus.textContent = "プレーンテキストのAIPM Flowをコピーしました。";
  }));
  el.workspaceLibraryExport.addEventListener("click", () => runLibraryAction(async () => {
    const selected = selectedLibraryEntry();
    if (!selected) throw new Error("書き出すライブラリ項目を選択してください。");
    downloadFlowText(exportFlowText(selected), selected.name);
    el.workspaceLibraryStatus.textContent = "プレーンテキストのAIPM Flowファイルを作成しました。";
  }));
}

export async function initializeWorkspaceEditor() {
  for (const preset of WORKFLOW_PRESETS) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.name;
    el.workspaceWorkflowPreset.append(option);
  }
  bindEditorEvents();
  await Promise.all([refreshEditorTargets(), refreshFlowLibrary()]);
  setEditorKind("flow");
  syncTargetUi();
}

export function onWorkspaceEditorStorageChanged(changes, areaName) {
  if (areaName !== "local" || !changes || typeof changes !== "object") return;
  if (Object.hasOwn(changes, UI_STATE_MAP_KEY)) {
    const change = changes[UI_STATE_MAP_KEY];
    if (session.observeStorageChange(change)) {
      setNotice("stale");
      syncTargetUi();
    }
    refreshEditorTargets(change?.newValue);
  }
  if (Object.hasOwn(changes, FLOW_LIBRARY_STORAGE_KEY)) {
    const observed = normalizeFlowLibrary(changes[FLOW_LIBRARY_STORAGE_KEY]?.newValue).revision;
    if (observed <= flowLibrary.revision) return;
    if (session.dirty || libraryOperationInFlight || hasUnsavedLibraryMetadata()) {
      el.workspaceLibraryStatus.textContent = "別の画面でFlowライブラリが更新されました。現在のエディター入力とメタデータは保持しています。再読み込みしてから操作してください。";
      return;
    }
    /* loadFlowLibrary owns the last-known-good read path. An external change
       may refresh a clean view, but never a local draft or in-flight intent. */
    refreshFlowLibrary();
  }
}

export const workspaceEditorDebug = Object.freeze({
  session,
  compileFlowEditor,
  renderWorkflowPreview,
  refreshEditorTargets
});
