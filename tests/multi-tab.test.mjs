import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const controller = read("src/content-controller.js");
const background = read("src/background.js");
const sidepanel = read("src/sidepanel.js");
const sidepanelStartSource = read("src/sidepanel-start-source.js");
/* Phase 4A moved the per-tab map read/write into its own store module. The
   contract asserted below is unchanged; only its home is. */
const uiStateStore = read("src/ui-state-store.js");
const html = read("src/sidepanel.html");

test("content controller persists active runs through the tab-scoped background store", () => {
  assert.match(controller, /type:\s*"AIPM_RUN_GET"/);
  assert.match(controller, /type:\s*"AIPM_RUN_SET"/);
  assert.match(controller, /conversationKey:\s*ChatGptAdapter\.getConversationKey\(\)/);
  assert.doesNotMatch(controller, /chrome\.storage\.local\.set\(\{\s*\[ACTIVE_RUN_KEY\]/);
});

test("run identity records explicit tab binding and keep-awake preference", () => {
  assert.match(controller, /boundTabId:\s*Number\.isInteger\(options\.bindingTabId\)/);
  assert.match(controller, /keepAwake:\s*options\.keepAwake === true/);
  assert.match(controller, /bindingTabId:\s*message\.bindingTabId/);
  assert.match(controller, /executionSessionId:\s*options\.executionSessionId/);
  assert.match(controller, /documentInstanceId:\s*instanceId/);
});

test("background separates active run persistence by tab id", () => {
  assert.match(background, /aipm\.activeRun\.v2\.tab\./);
  assert.match(background, /function activeRunKey\(tabId\)/);
  assert.match(background, /sender\?\.tab\?\.id/);
  assert.match(background, /boundTabId:\s*tabId/);
});

test("Side Panel exposes explicit tab targeting and per-tab editor state", () => {
  assert.match(html, /id="targetTab"/);
  assert.match(html, /id="refreshTabs"/);
  assert.match(uiStateStore, /UI_STATE_MAP_KEY = "aipm\.uiByTab\.v2"/);
  assert.match(sidepanel, /readUiStateForTab\(tabId\)/);
  assert.match(sidepanel, /mutateUiStateForTab\(targetTabId,/);
  assert.match(sidepanel, /targetTabId,\s*payload:\s*message/);
  assert.match(sidepanel, /const intentTabId = selectedTabId/);
  /* One entry per tab id, and a write replaces exactly that entry while
     carrying every sibling over untouched. */
  assert.match(uiStateStore, /export function uiStateTabKey/);
  assert.match(uiStateStore, /\{ \.\.\.siblings, \[key\]: next \}/);
  assert.match(sidepanel, /retainTargetOnRefresh\(selectedTabId\)/);
  assert.match(sidepanel, /接続待ち（選択維持）/);
  assert.match(sidepanel, /let targetUiReady = false/);
  assert.match(sidepanel, /targetReady = connection\.ready && pendingTargetSwitches === 0 && targetUiReady/);
  assert.match(sidepanel, /pendingTargetSwitches > 0 \|\| !targetUiReady/);
  assert.match(html, /id="start" class="primary" disabled/);
});

test("Side Panel controls retain the click-time Run generation through delivery", () => {
  assert.match(sidepanel, /renderedRunControlSnapshot = runControlSnapshot\(run\)/);
  assert.match(sidepanel, /type === "AIPM_STOP"[\s\S]*currentDurableStopSnapshot\(\)[\s\S]*renderedRunControlSnapshot/);
  assert.match(sidepanel, /durableStopSnapshot\.tabId !== selectedTabId/);
  assert.match(sidepanel, /durableStopSnapshot\.targetEpoch !== targetEpoch/);
  assert.match(sidepanel, /expectedRunId:\s*snapshot\.runId/);
  assert.match(sidepanel, /expectedStateRevision:\s*snapshot\.stateRevision/);
  assert.match(sidepanel, /if \(runControlIntentInFlight\) return/);
  assert.match(background, /expectedRunId:\s*runControl \? payload\.expectedRunId/);
  assert.match(controller, /expectedRevision !== actualRevision/);
});

test("keep awake is opt-in per run and only requests system wake", () => {
  assert.match(html, /id="keepAwake"/);
  assert.match(sidepanelStartSource, /keepAwake: source\.keepAwake === true/);
  assert.match(sidepanel, /keepAwake: startSource\.keepAwake/);
  assert.match(sidepanel, /keepAwake\.addEventListener\("change", \(\) => saveUiState\(\)\)/);
  assert.doesNotMatch(sidepanel, /addEventListener\("change", saveUiState\)/);
  assert.match(background, /run\?\.status === "running" && run\?\.keepAwake === true/);
  assert.match(background, /requestKeepAwake\("system"\)/);
  assert.match(background, /releaseKeepAwake\(\)/);
});

test("multi-tab implementation does not require tabs permission or response access", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.permissions.includes("tabs"), false);
  assert.equal(manifest.permissions.includes("power"), true);
  assert.doesNotMatch(sidepanel, /data-message-author-role|assistant-message|\.markdown|\.prose/);
  assert.doesNotMatch(background, /data-message-author-role|assistant-message|\.markdown|\.prose/);
});
