import {
  formatTabAliasLabel,
  normalizeTabPresentationMap,
  TAB_PRESENTATION_STORAGE_KEY,
  tabPresentationFor,
  withTabPresentation
} from "./tab-alias.js";

const DEFAULT_HINT = "表示情報はタブを見分けるためだけに使い、送信先や実行可否の判定には使いません。ブラウザを終了すると消えます。";

const targetTab = document.querySelector("#targetTab");
const targetAlias = document.querySelector("#targetAlias");
const targetColor = document.querySelector("#targetColor");
const targetGroup = document.querySelector("#targetGroup");
const targetAliasHint = document.querySelector("#targetAliasHint");
const targetPresentationSummary = document.querySelector("#targetPresentationSummary");
const targetPresentationName = document.querySelector("#targetPresentationName");
const targetPresentationGroup = document.querySelector("#targetPresentationGroup");
const targetPresentationMeta = document.querySelector("#targetPresentationMeta");

let presentations = {};
let ready = false;
let editingControl = null;
let editingTabId = null;
let saveQueue = Promise.resolve();

function selectedTabId() {
  const value = Number.parseInt(targetTab?.value ?? "", 10);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function selectedBaseLabel() {
  const option = targetTab?.selectedOptions?.[0];
  return option?.dataset?.aipmBaseLabel ?? option?.textContent ?? "";
}

function decorateOptions() {
  if (!targetTab) return;
  for (const option of targetTab.options) {
    const tabId = Number.parseInt(option.value, 10);
    if (!Number.isInteger(tabId) || tabId < 0) continue;
    if (!option.dataset.aipmBaseLabel) {
      option.dataset.aipmBaseLabel = option.textContent ?? "";
    }
    const baseLabel = option.dataset.aipmBaseLabel;
    const presentation = tabPresentationFor(presentations, tabId);
    const label = formatTabAliasLabel(baseLabel, presentation.alias);
    if (option.textContent !== label) option.textContent = label;
  }
}

function syncControl(control, value, tabId) {
  if (!control) return;
  control.disabled = !ready || !Number.isInteger(tabId);
  if (document.activeElement === control && editingControl === control && Number.isInteger(editingTabId)) return;
  control.value = Number.isInteger(tabId) ? value : "";
}

function renderSelectedSummary(tabId, presentation) {
  if (!targetPresentationSummary || !targetPresentationName ||
      !targetPresentationGroup || !targetPresentationMeta) return;
  const selected = Number.isInteger(tabId);
  targetPresentationSummary.hidden = !selected;
  if (!selected) return;
  targetPresentationSummary.dataset.color = presentation.color;
  targetPresentationName.textContent = presentation.alias ||
    targetTab?.selectedOptions?.[0]?.dataset.aipmDisplayName || `ChatGPTタブ #${tabId}`;
  targetPresentationGroup.textContent = presentation.group;
  targetPresentationGroup.hidden = !presentation.group;
  targetPresentationMeta.textContent = selectedBaseLabel() || `Tab #${tabId} · 接続状態は未確認です`;
}

function renderPresentationUi() {
  decorateOptions();
  const tabId = selectedTabId();
  const presentation = tabPresentationFor(presentations, tabId);
  syncControl(targetAlias, presentation.alias, tabId);
  syncControl(targetColor, presentation.color, tabId);
  syncControl(targetGroup, presentation.group, tabId);
  renderSelectedSummary(tabId, presentation);
}

function persistPresentation(tabId, patch) {
  presentations = withTabPresentation(presentations, tabId, patch);
  renderPresentationUi();
  const snapshot = normalizeTabPresentationMap(presentations);
  const operation = saveQueue.catch(() => {}).then(() => chrome.storage.session.set({
    [TAB_PRESENTATION_STORAGE_KEY]: snapshot
  }));
  saveQueue = operation;
  return operation;
}

function bindPresentationControl(control, field) {
  control.addEventListener("focus", () => {
    editingControl = control;
    editingTabId = selectedTabId();
  });

  control.addEventListener("change", async () => {
    const tabId = Number.isInteger(editingTabId) ? editingTabId : selectedTabId();
    const value = control.value;
    editingControl = null;
    editingTabId = null;
    if (!Number.isInteger(tabId)) return;
    try {
      await persistPresentation(tabId, { [field]: value });
      targetAliasHint.textContent = DEFAULT_HINT;
    } catch {
      targetAliasHint.textContent = "表示情報を保存できませんでした。送信先や実行可否の判定には影響しません。";
    }
    renderPresentationUi();
  });

  control.addEventListener("blur", () => {
    if (editingControl === control) {
      editingControl = null;
      editingTabId = null;
    }
    renderPresentationUi();
  });
}

function installUiBindings() {
  const required = [
    targetTab,
    targetAlias,
    targetColor,
    targetGroup,
    targetAliasHint,
    targetPresentationSummary,
    targetPresentationName,
    targetPresentationGroup,
    targetPresentationMeta
  ];
  if (required.some((node) => !node)) return false;

  for (const control of [targetAlias, targetColor, targetGroup]) control.disabled = true;
  targetAliasHint.textContent = DEFAULT_HINT;

  const observer = new MutationObserver(() => renderPresentationUi());
  observer.observe(targetTab, { childList: true, subtree: true });
  targetTab.addEventListener("change", renderPresentationUi);

  bindPresentationControl(targetAlias, "alias");
  bindPresentationControl(targetColor, "color");
  bindPresentationControl(targetGroup, "group");

  return true;
}

async function initializePresentations() {
  if (!installUiBindings()) return;
  if (!chrome.storage?.session) {
    targetAliasHint.textContent = "このブラウザでは一時的な表示情報を保存できません。送信先や実行可否の判定には影響しません。";
    return;
  }
  try {
    const stored = await chrome.storage.session.get(TAB_PRESENTATION_STORAGE_KEY);
    presentations = normalizeTabPresentationMap(stored[TAB_PRESENTATION_STORAGE_KEY]);
    ready = true;
    renderPresentationUi();
  } catch {
    targetAliasHint.textContent = "表示情報を読み込めませんでした。送信先や実行可否の判定には影響しません。";
  }
}

initializePresentations();
