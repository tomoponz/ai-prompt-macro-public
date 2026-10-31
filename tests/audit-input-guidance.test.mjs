import test from "node:test";
import assert from "node:assert/strict";
import { createWorkflowHarness } from "./helpers/workflow-harness.mjs";
import { installSidePanelHarness, tick } from "./helpers/sidepanel-harness.mjs";
import { CURRENT_EXTENSION_VERSION } from "./helpers/extension-version.mjs";
import { canResumePausedRun, projectRunState, nextActionForRun } from "../src/run-ux.js";
import { projectRunDiagnostic } from "../src/diagnostics-ux.js";

const workflow = {
  schemaVersion: 1, id: "audit-input", name: "Synthetic input", maxSends: 1,
  steps: [{ id: "one", type: "prompt", delivery: "send", prompt: "SYNTHETIC MACRO", repeat: 1, delayAfterMs: 0 }]
};

test("a trusted text edit stops before sending, preserves the edit, and cannot resume", async () => {
  const h = createWorkflowHarness({ onWrite({ page }) {
    page.text = "SYNTHETIC USER EDIT";
    page.userMutationEpoch += 1;
  } });
  await h.ready();
  assert.equal((await h.start(workflow)).ok, true);
  await h.settle();
  const run = h.stored();
  assert.equal(run.lastErrorCode, "composer_user_interaction");
  assert.equal(run.phase, "prepared");
  assert.equal(run.outbox.state, "prepared");
  assert.equal(h.page.clicks, 0);
  assert.equal(h.page.attachmentCount, 0);
  assert.equal(h.page.text, "SYNTHETIC USER EDIT");
  assert.equal(canResumePausedRun(run), false);
  assert.equal((await h.control("AIPM_RESUME")).ok, false);
  assert.match(projectRunState(run).reason, /利用者操作.*送信前/);
  assert.match(projectRunDiagnostic(run).summary, /利用者操作.*送信前/);
  assert.doesNotMatch(projectRunState(run).reason, /添付ファイル|送信状態を一意/);
  assert.match(nextActionForRun({ run, hasTarget: true, targetReady: true, pageReady: true }), /不要な指示を削除/);
});

test("pre-send guidance never relabels uncertain or confirmed delivery as unsent", () => {
  for (const state of ["prepared", "submitted", "confirmed"]) {
    const run = { status: "paused", resumable: false, phase: state === "prepared" ? "prepared" : "ambiguous",
      lastErrorCode: "composer_user_interaction", pauseReason: "composer_user_interaction", outbox: { state } };
    const copy = [projectRunState(run).reason, projectRunDiagnostic(run).summary].join("\n");
    if (state === "prepared") assert.match(copy, /送信前に停止/);
    else assert.doesNotMatch(copy, /送信前に停止/);
    if (state === "confirmed") assert.match(copy, /送信は確認済み/);
  }
});

test("a trusted interaction that clears the composer does not claim no manual send occurred", async () => {
  const h = createWorkflowHarness({ onWrite({ page }) {
    // Model the observable effects of a manual submission. APM cannot determine
    // the user's delivery outcome and must not describe its own zero clicks as proof.
    page.text = "";
    page.userMutationEpoch += 1;
  } });
  await h.ready();
  await h.start(workflow);
  await h.settle();
  const run = h.stored();
  assert.equal(h.page.clicks, 0);
  assert.equal(h.page.text, "");
  assert.equal(run.lastErrorCode, "composer_user_interaction");
  for (const text of [run.lastErrorMessage, projectRunState(run).reason, projectRunDiagnostic(run).summary]) {
    assert.match(text, /APMの自動送信前/);
    assert.match(text, /手動送信の有無/);
    assert.doesNotMatch(text, /未送信です|そのまま残しています/);
  }
  assert.equal(canResumePausedRun(run), false);
});

test("status returns only existing-input presence, without storing or exposing the input", async () => {
  const h = createWorkflowHarness({ initialComposerText: "SYNTHETIC PRIVATE DRAFT" });
  await h.ready();
  const response = await h.control("AIPM_GET_STATUS");
  assert.equal(response.composerHasContent, true);
  assert.doesNotMatch(JSON.stringify(response), /SYNTHETIC PRIVATE DRAFT/);
  assert.equal(h.stored(), null);
  assert.equal(h.page.text, "SYNTHETIC PRIVATE DRAFT");
  h.page.text = "";
  assert.equal((await h.control("AIPM_GET_STATUS")).composerHasContent, false);
  h.context.ChatGptAdapter.getComposerText = () => { throw new Error("synthetic detached composer"); };
  const unavailable = await h.control("AIPM_GET_STATUS");
  assert.equal(unavailable.ok, true, "advisory input observation must not hide Run status");
  assert.equal(unavailable.composerHasContent, null, "an unavailable observation is not an empty composer");
});

test("the start card warns about existing input and clears a previous target observation", async () => {
  const h = await installSidePanelHarness({ tabIds: [1] });
  try {
    await tick();
    const status = {
      ok: true, provider: "chatgpt", contentVersion: CURRENT_EXTENSION_VERSION,
      pageReady: true, generationState: "idle", blocker: null,
      conversationKey: "chatgpt:c:synthetic", instanceId: "instance-1", run: null, diagnostics: []
    };
    for (const present of [true, false, null]) {
      h.setRelayResponder(() => ({ ...status, composerHasContent: present }));
      await h.click("refreshTabs");
      assert.equal(h.el("existingInputWarning").hidden, present !== true);
      if (present === true) {
        assert.match(h.el("existingInputWarning").textContent, /既存の内容.*追記して送信/);
        assert.match(h.el("existingInputWarning").textContent, /プレビューには既存入力を含みません/);
      } else assert.equal(h.el("existingInputWarning").textContent, "");
    }
  } finally { h.restoreGlobals(); }
});
