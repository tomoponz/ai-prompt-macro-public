import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const presentation = read("src/tab-alias.js");
const presentationUi = read("src/tab-alias-ui.js");
const sidePanel = read("src/sidepanel.js");
const sidePanelHtml = read("src/sidepanel.html");
const workspace = read("src/workspace.js");
const workspaceHtml = read("src/workspace.html");

test("presentation metadata is a session-only display store, not a second authority store", () => {
  assert.match(presentation, /TAB_PRESENTATION_STORAGE_KEY = "aipm\.tabAliases\.v1"/);
  assert.match(presentationUi, /chrome\.storage\.session\.set/);
  assert.doesNotMatch(presentationUi, /chrome\.storage\.local/);
  assert.doesNotMatch(presentationUi, /AIPM_START|AIPM_PAUSE|AIPM_RESUME|AIPM_STOP/);
  assert.doesNotMatch(sidePanel, /TAB_PRESENTATION_STORAGE_KEY|aipm\.tabAliases\.v1/);
});

test("display edits cannot enter Start, control, conversation, document or lease authority", () => {
  for (const forbidden of [
    "AIPM_RELAY_TO_CHATGPT",
    "expectedRunId",
    "expectedStateRevision",
    "conversationKey",
    "documentInstanceId",
    "executionSessionId",
    "lease"
  ]) {
    assert.equal(
      presentationUi.includes(forbidden),
      false,
      `presentation UI must not reference ${forbidden}`
    );
  }
});

test("Side Panel keeps exact target observation visible alongside human metadata", () => {
  for (const id of [
    "targetPresentationSummary",
    "targetPresentationName",
    "targetPresentationGroup",
    "targetPresentationMeta",
    "targetAlias",
    "targetColor",
    "targetGroup"
  ]) {
    assert.match(sidePanelHtml, new RegExp(`id="${id}"`));
  }
  assert.match(presentationUi, /targetPresentationMeta\.textContent = selectedBaseLabel\(\)/);
  assert.match(presentationUi, /formatTabAliasLabel\(baseLabel, presentation\.alias\)/);
});

test("Workspace visibility stays storage-only, event-driven and selection-independent", () => {
  for (const forbidden of [
    "runtime.sendMessage",
    "tabs.sendMessage",
    "scripting.executeScript",
    "setInterval(",
    "setTimeout("
  ]) {
    assert.equal(workspace.includes(forbidden), false, `Workspace must not use ${forbidden}`);
  }
  assert.match(workspace, /storage\?\.onChanged/);
  assert.doesNotMatch(workspace, /storage\?\.local\?\.set|storage\.local\.set/);
  assert.doesNotMatch(workspace, /SELECTED_TAB_KEY|selectedTab\.v1"\s*:/);
  assert.match(workspaceHtml, /id="groupFilter"/);
});

test("Workspace remains visibility-only with no Run mutation controls", () => {
  for (const forbidden of ["AIPM_START", "AIPM_PAUSE", "AIPM_RESUME", "AIPM_STOP", "Rebind"]) {
    assert.equal(workspace.includes(forbidden), false);
    assert.equal(workspaceHtml.includes(forbidden), false);
  }
  assert.match(workspace, /badge\.textContent = row\.visibilityStatusLabel/);
  assert.match(workspace, /fresh\.textContent = row\.snapshotLabel/);
  assert.match(workspace, /observation\.textContent = row\.observationLabel/);
  assert.match(workspace, /row\.progressCompleted/);
});

test("all user-controlled presentation strings reach DOM through textContent only", () => {
  assert.doesNotMatch(presentationUi, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.doesNotMatch(workspace, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.match(presentationUi, /targetPresentationName\.textContent =/);
  assert.match(presentationUi, /targetPresentationGroup\.textContent =/);
  assert.match(workspace, /name\.textContent = runDisplayName\(row\)/);
  assert.match(workspace, /group\.textContent = row\.group/);
});

test("presentation storage failure is contained without disabling Run controls", () => {
  assert.match(presentationUi, /catch \{/);
  assert.match(presentationUi, /表示情報を保存できませんでした。送信先や実行可否の判定には影響しません。/);
  for (const control of ["#start", "#pause", "#resume", "#stop"]) {
    assert.equal(presentationUi.includes(control), false);
  }
});
