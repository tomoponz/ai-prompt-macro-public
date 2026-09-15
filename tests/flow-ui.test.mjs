import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { installSidePanelHarness, tick } from "./helpers/sidepanel-harness.mjs";
import { makeRun } from "./helpers/background-harness.mjs";

const html = await readFile(new URL("../src/sidepanel.html", import.meta.url), "utf8");
const source = await readFile(new URL("../src/sidepanel.js", import.meta.url), "utf8");
const startSource = await readFile(new URL("../src/sidepanel-start-source.js", import.meta.url), "utf8");
const workspaceHtml = await readFile(new URL("../src/workspace.html", import.meta.url), "utf8");
const workspaceSource = await readFile(new URL("../src/workspace-editor.js", import.meta.url), "utf8");

test("Side Panel exposes Quick and lightweight Flow entry while advanced authoring stays in Workspace", () => {
  assert.match(html, /id="quickTab"/);
  assert.match(html, /id="quickPanel"/);
  assert.match(html, /id="authoringCompatibilityState"[^>]*\bhidden\b[^>]*\binert\b/);
  const compatibilityIndex = html.indexOf('id="authoringCompatibilityState"');
  for (const id of ["flowTab", "flowEntryPanel", "flowText", "flowSelector", "flowPlanSteps"]) {
    const index = html.indexOf(`id="${id}"`);
    assert.ok(index >= 0 && index < compatibilityIndex, `${id} must be available outside the inert compatibility editor`);
  }
  assert.doesNotMatch(html, /<nav class="tabs" aria-label="自動化モード">/);
  for (const id of ["flowEditorTab", "workflowEditorTab", "flowEditorPanel", "workflowEditorPanel"]) {
    assert.match(workspaceHtml, new RegExp(`id="${id}"`));
  }
});

test("Workspace retains full Flow editing, preview and import/export without Run controls", () => {
  for (const id of [
    "workspaceFlowText", "workspaceFlowSelector", "workspaceFlowError", "workspacePreviewSends",
    "workspacePreviewBlocks", "copyWorkspaceFlow", "workspacePreviewName", "workspacePreviewRange",
    "workspacePreviewWaits", "workspacePreviewCheckpoints", "workspaceImportText", "workspaceExportFile"
  ]) {
    assert.match(workspaceHtml, new RegExp(`id="${id}"`));
  }
  assert.match(workspaceSource, /compileAipmFlow\(el\.workspaceFlowText\.value\)/);
  assert.doesNotMatch(workspaceHtml, /id="start"|id="pause"|id="resume"|id="stop"/);
});

test("Flow source and selection persist per target tab without persisting compiled authority", () => {
  assert.match(source, /text:\s*el\.flowText\.value/);
  assert.match(source, /selectedIndex:\s*flowSelectedIndex/);
  assert.doesNotMatch(source, /compiled:\s*compiledFlow/);
  assert.match(source, /state\?\.flow\?\.text/);
  assert.match(source, /state\?\.flow\?\.selectedIndex/);
});

test("Flow Start fresh-reads and compiles only the exact saved selected Flow", () => {
  assert.match(startSource, /readUiStateForTab\(tabId, options\)/);
  assert.match(startSource, /compileAipmFlow\(flow\.text\)/);
  assert.match(startSource, /compiled\.flows\?\.\[selectedIndex\]/);
  assert.match(startSource, /buildExecutionPlan\(selected, flow\.execution\)/);
  assert.match(source, /readStartSourceForTab\(intentTabId, \{ expectedEntry \}\)/);
  assert.match(source, /type:\s*"AIPM_START"/);
  assert.doesNotMatch(startSource, /document|querySelector|runtime\.sendMessage/);
});

test("Side Panel applies fixed-clock schedule preflight immediately before dispatching Start", () => {
  const handler = source.slice(source.indexOf("async function startSelectedAutomation()"), source.indexOf("el.start.addEventListener"));
  const preflightIndex = handler.indexOf("preflightWorkflowStartSchedule(workflow, Date.now())");
  const dispatchIndex = handler.indexOf("type: \"AIPM_START\"");
  assert.ok(preflightIndex >= 0);
  assert.ok(dispatchIndex > preflightIndex);
});

test("Overnight C2: an in-flight Start intent is visible and cannot silently accept another click", () => {
  const handler = source.slice(source.indexOf("async function startSelectedAutomation()"), source.indexOf("el.start.addEventListener"));
  assert.doesNotMatch(handler, /if \(startIntentInFlight\) return;/);
  assert.match(handler, /showRunFeedback\("開始処理はすでに進行中です。"\)/);

  const claimIndex = handler.indexOf("startIntentInFlight = true");
  const quickDisabledIndex = handler.indexOf("el.start.disabled = true");
  const flowDisabledIndex = handler.indexOf("el.flowStart.disabled = true");
  const firstAwaitIndex = handler.indexOf("await ");
  assert.ok(claimIndex >= 0);
  assert.ok(quickDisabledIndex > claimIndex && quickDisabledIndex < firstAwaitIndex);
  assert.ok(flowDisabledIndex > claimIndex && flowDisabledIndex < firstAwaitIndex);
});

test("Overnight C4: fresh durable Start observation wins over an ambiguous relay failure message", async () => {
  const panel = await installSidePanelHarness({ tabIds: [1], storageSeed: { "aipm.selectedTab.v1": 1 } });
  let run = null;
  try {
    await tick();
    panel.el("quickPrompt").value = "FIXTURE ONLY";
    panel.setRelayResponder(async (message) => {
      if (message.payload.type === "AIPM_START") {
        run = makeRun({ runId: "committed-before-reconciliation", stateRevision: 4 });
        return { ok: false, relayErrorCode: "COMMAND_DELIVERY_TIMEOUT", relayError: "Fixture relay timeout" };
      }
      return { ok: true, pageReady: true, generationState: "idle", blocker: null, run, diagnostics: [] };
    });
    await panel.click("start");
    assert.equal(panel.el("statusBadge").textContent, "実行中");
    assert.doesNotMatch(panel.el("message").textContent, /Fixture relay timeout|開始結果不明|開始結果を確認中/);
    assert.equal(panel.el("stop").disabled, false);
    assert.equal(panel.el("start").disabled, true);
    assert.equal(panel.messages.filter((message) => message.payload?.type === "AIPM_START").length, 1);
  } finally { panel.restoreGlobals(); }
});

test("Flow Start recompiles the saved source and never trusts a stored compiled Workflow", () => {
  assert.match(startSource, /compileAipmFlow\(flow\.text\)/);
  assert.match(startSource, /buildExecutionPlan\(selected, flow\.execution\)/);
  assert.match(startSource, /normalizeWorkflow\(\{ \.\.\.clone\(plan\.workflow\), recovery \}\)/);
});

test("Library, Import/Export and partial execution controls are Workspace-primary and non-authoritative", () => {
  assert.match(html, /id="authoringCompatibilityState"[^>]*\bhidden\b[^>]*\binert\b/);
  for (const id of [
    "workspaceLibrarySearch", "workspaceLibraryList", "workspaceLibraryName", "workspaceLibraryDescription",
    "workspaceLibraryFavorite", "workspaceLibrarySaveNew", "workspaceLibraryUpdate", "workspaceLibraryOpen",
    "workspaceLibraryDuplicate", "workspaceLibraryRename", "workspaceLibraryDelete", "workspaceImportText",
    "workspaceImportPaste", "workspaceImportFile", "workspaceExportFile", "workspaceExecutionMode",
    "workspaceRangeStart", "workspaceRangeEnd", "workspaceRangeRepeat", "workspaceCheckpoint"
  ]) assert.match(workspaceHtml, new RegExp(`id="${id}"`));
  /* Hidden compatibility nodes keep Phase 4A-C storage/library race tests
     executable, but are not an interactive Side Panel surface. */
  for (const id of [
    "flowLibrarySearch", "flowLibraryList", "flowLibraryName", "flowLibraryDescription", "flowLibraryFavorite",
    "flowLibrarySaveNew", "flowLibraryUpdate", "flowLibraryOpen", "flowLibraryDuplicate", "flowLibraryRename",
    "flowLibraryDelete", "flowLibraryCopy", "flowLibraryShare", "flowImportText", "flowImportPaste",
    "flowImportFile", "flowExportFile", "flowExecutionMode", "flowRangeStart", "flowRangeEnd",
    "flowRangeRepeat", "flowCheckpoint", "flowPartialWarning", "flowPlanError"
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(workspaceSource, /読み込みだけでは実行を開始しません/);
  assert.match(html, /以前の手順で形成された会話文脈が必要な場合があります/);
  assert.doesNotMatch(workspaceSource, /AIPM_START|runtime\.sendMessage|tabs\.sendMessage/);
  assert.match(source, /validateImportedFlowText/);
  assert.doesNotMatch(source, /cursor\s*=/);
});

test("Flow Library keeps selected and opened identities separate across every editor transition", () => {
  assert.match(source, /let selectedFlowLibraryId = null;\s*let openedFlowLibraryId = null;/);
  assert.match(source, /openedLibraryId:\s*openedFlowLibraryId/);
  assert.match(source, /resolveOpenedFlowLibraryId\(flowLibrary, state\?\.flow\?\.openedLibraryId\)/);

  const selectionHandler = source.slice(
    source.indexOf('el.flowLibraryList.addEventListener("change"'),
    source.indexOf('el.flowLibrarySaveNew.addEventListener("click"')
  );
  assert.match(selectionHandler, /selectedFlowLibraryId = el\.flowLibraryList\.value/);
  assert.doesNotMatch(selectionHandler, /openedFlowLibraryId|flowText\.value\s*=/);

  const saveNewHandler = source.slice(
    source.indexOf('el.flowLibrarySaveNew.addEventListener("click"'),
    source.indexOf('el.flowLibraryUpdate.addEventListener("click"')
  );
  assert.match(saveNewHandler, /selectedFlowLibraryId = entry\.id;\s*openedFlowLibraryId = entry\.id;/);

  const updateHandler = source.slice(
    source.indexOf('el.flowLibraryUpdate.addEventListener("click"'),
    source.indexOf('el.flowLibraryOpen.addEventListener("click"')
  );
  assert.match(updateHandler, /canUpdateOpenedFlowLibraryEntry\(flowLibrary, selectedId, openedFlowLibraryId\)/);
  assert.match(updateHandler, /assertFlowLibraryUiIntent\(intent, \{ selected: true, opened: true, source: true, metadata: true \}\)/);
  assert.match(updateHandler, /requireFreshFlowLibraryEntry\(latest, selectedId, "上書き"\)/);
  assert.ok(updateHandler.indexOf("assertFlowLibraryUiIntent") < updateHandler.indexOf("updateFlowLibraryEntry"));

  const openHandler = source.slice(
    source.indexOf('el.flowLibraryOpen.addEventListener("click"'),
    source.indexOf('el.flowLibraryDuplicate.addEventListener("click"')
  );
  assert.match(openHandler, /isOpenedFlowLibraryDirty/);
  assert.match(openHandler, /window\.confirm/);
  assert.ok(openHandler.indexOf("window.confirm") < openHandler.indexOf("el.flowText.value = opened.source"));
  assert.match(openHandler, /openedFlowLibraryId = selectedId/);

  const duplicateHandler = source.slice(
    source.indexOf('el.flowLibraryDuplicate.addEventListener("click"'),
    source.indexOf('el.flowLibraryRename.addEventListener("click"')
  );
  assert.doesNotMatch(duplicateHandler, /openedFlowLibraryId\s*=/);

  const deleteHandler = source.slice(
    source.indexOf('el.flowLibraryDelete.addEventListener("click"'),
    source.indexOf('el.flowLibraryCopy.addEventListener("click"')
  );
  assert.match(deleteHandler, /if \(openedFlowLibraryId === selectedId\) openedFlowLibraryId = null/);

  const importHandler = source.slice(source.indexOf("function importFlowSource"), source.indexOf("async function initializeFlowLibrary"));
  assert.match(importHandler, /openedFlowLibraryId = null/);
});

test("async Flow Library actions stay bound to their click-time tab and editor snapshot", () => {
  assert.match(source, /function captureFlowLibraryUiIntent\(\)/);
  assert.match(source, /tabId:\s*selectedTabId/);
  assert.match(source, /targetEpoch/);
  assert.match(source, /editorSource:\s*el\.flowText\.value/);
  assert.match(source, /selectedTabId !== intent\.tabId \|\| targetEpoch !== intent\.targetEpoch \|\| pendingTargetSwitches > 0/);

  const saveNewHandler = source.slice(
    source.indexOf('el.flowLibrarySaveNew.addEventListener("click"'),
    source.indexOf('el.flowLibraryUpdate.addEventListener("click"')
  );
  assert.match(saveNewHandler, /source:\s*intent\.editorSource/);
  assert.ok(saveNewHandler.indexOf("await saveFlowLibraryState") < saveNewHandler.indexOf("assertFlowLibraryUiIntent"));
  assert.ok(saveNewHandler.indexOf("assertFlowLibraryUiIntent") < saveNewHandler.indexOf("openedFlowLibraryId = entry.id"));

  const openHandler = source.slice(
    source.indexOf('el.flowLibraryOpen.addEventListener("click"'),
    source.indexOf('el.flowLibraryDuplicate.addEventListener("click"')
  );
  assert.match(openHandler, /assertFlowLibraryUiIntent\(intent, \{ selected: true, opened: true, source: true \}\)/);

  const readBundle = source.slice(source.indexOf("async function readUiStateBundle"), source.indexOf("function applyUiStateBundle"));
  assert.match(readBundle, /loadFlowLibrary\(\)/, "a successful target read must capture one coherent Library view");
  const applyBundle = source.slice(source.indexOf("function applyUiStateBundle"), source.indexOf("async function restoreUiState"));
  assert.ok(applyBundle.indexOf("flowLibrary = latestFlowLibrary") < applyBundle.indexOf("applyUiState(uiState.entry,"));

  const actionBoundary = source.slice(source.indexOf("async function runLibraryAction"), source.indexOf('el.flowLibrarySearch.addEventListener'));
  assert.doesNotMatch(actionBoundary, /loadFlowLibrary\(\)/, "a failed async action must not reload over local editor input");
});

test("Recovery Mode and completion outcomes are explicit, bounded and per-target", () => {
  for (const id of [
    "recoveryMode", "advancedRecovery", "identityRetries", "readinessRecovery", "statusRecovery",
    "completionOutcome", "flowPreviewRecovery"
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /標準/);
  assert.match(html, /完了を優先/);
  assert.match(html, /送信結果が不明な指示は自動再送しません/);
  assert.match(html, /対象タブ・会話・ページの確認、同じ会話の同時操作防止、最大50回の自動送信、回答本文を読まない安全条件/);
  assert.match(source, /recovery:\s*\{ \.\.\.currentRecoveryPolicy\(\) \}/);
  assert.match(source, /recoveryPolicy = normalizeRecoveryPolicy\(state\?\.recovery\)/);
  assert.match(source, /readOnlyRecovery:\s*workflow\.recovery/);
  assert.match(source, /completionOutcomeForRun\(statusContext\)/);
});
