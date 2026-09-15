import assert from "node:assert/strict";
import test from "node:test";
import { installSidePanelHarness, deferred, tick } from "./helpers/sidepanel-harness.mjs";
import { installBackgroundHarness, makeRun } from "./helpers/background-harness.mjs";
import { createWorkflowHarness, TAB_ID, SESSION_ID } from "./helpers/workflow-harness.mjs";

const UI_KEY = "aipm.uiByTab.v2";
const checkpointEntry = {
  mode: "workflow", editorRevision: 1,
  workflow: { schemaVersion: 1, maxSends: 1, steps: [{ id: "hold", type: "checkpoint", label: "Fixture hold" }] }
};

for (const lateOutcome of ["commit", "reject"]) {
test(`F5 C/D: production timeout, null observation, then original Start ${lateOutcome}`, async () => {
  const recoveryEntered = deferred();
  const recovery = deferred();
  const delivered = deferred();
  const checkpointReached = deferred();
  const checkpointHold = deferred();
  const events = [];
  const content = createWorkflowHarness({
    onRunGet: async ({ message }) => {
      if (message.authorityBoundary === "recovery") {
        recoveryEntered.resolve();
        await recovery.promise;
        if (lateOutcome === "reject") throw new Error("Fixture recovery failed before Start");
      }
    },
    onSave: async ({ run }) => {
      if (run.pauseReason === "manual-checkpoint") {
        checkpointReached.resolve();
        await checkpointHold.promise;
      }
    }
  });
  await recoveryEntered.promise;
  const panel = await installSidePanelHarness({
    tabIds: [TAB_ID],
    storageSeed: { "aipm.selectedTab.v1": TAB_ID, [UI_KEY]: { [TAB_ID]: checkpointEntry } }
  });
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  try {
    await tick();
    const panelChrome = globalThis.chrome;
    const background = await installBackgroundHarness();
    const backgroundChrome = globalThis.chrome;
    background.sessionStorageData["aipm.executionSession.v1"] = SESSION_ID;
    background.setTabs([{ id: TAB_ID, windowId: 1, active: true, url: "https://chatgpt.com/c/project-three-prompt" }]);
    background.setDocument(TAB_ID, { documentId: "document-fixture", documentInstanceId: content.context.instanceId });
    // Keep the production background and Side Panel in one simulated extension.
    // Content core/runner/controller execute unmodified in their isolated VM.
    globalThis.chrome = {
      ...backgroundChrome,
      runtime: { ...backgroundChrome.runtime, sendMessage: panelChrome.runtime.sendMessage },
      storage: { ...backgroundChrome.storage, local: panelChrome.storage.local }
    };
    background.setStatusResponder(TAB_ID, async (message) => {
      const status = await content.control(message.type, message);
      events.push(status.run ? "status-run" : "status-null");
      return status;
    });
    let originalStart;
    background.setCommandResponder(TAB_ID, (message) => {
      assert.equal(message.type, "AIPM_START");
      events.push("start-delivered");
      originalStart = content.control(message.type, message);
      delivered.resolve();
      return originalStart;
    });
    panel.setRelayResponder(async (message) => {
      const response = await background.invoke(message);
      if (message.payload.type === "AIPM_START") {
        assert.equal(response.relayErrorCode, "COMMAND_DELIVERY_TIMEOUT");
        events.push("relay-timeout");
      }
      return response;
    });
    // Explicitly fire the production relay's timer only after delivery. No real
    // timeout, random scheduling, network or ChatGPT page is involved.
    const timers = new Map();
    globalThis.setTimeout = (callback, ms, ...args) => {
      if (ms === 0) return realSetTimeout(callback, ms, ...args);
      const token = {};
      timers.set(token, { callback, ms });
      return token;
    };
    globalThis.clearTimeout = (token) => {
      if (!timers.delete(token)) realClearTimeout(token);
    };
    const starting = panel.click("start");
    await delivered.promise;
    assert.equal(content.stored(), null);
    const commandTimers = [...timers.values()].filter(({ ms }) => ms === 1500);
    assert.equal(commandTimers.length, 1, "only the outstanding command delivery timer remains");
    commandTimers[0].callback();
    await starting;
    assert.equal(content.stored(), null);
    assert.equal(events.at(-1), "status-null", "reconciliation sees null after relay timeout");
    const startDisabledWhileUnresolved = panel.el("start").disabled;
    assert.equal(panel.el("flowStart").disabled, true);
    await panel.click("start");
    await panel.click("flowStart");
    assert.equal(background.commandsDelivered(TAB_ID).length, 1, "even direct duplicate handler calls cannot retry");

    recovery.resolve();
    const lateResponse = await originalStart;
    if (lateOutcome === "commit") {
      assert.equal(lateResponse.ok, true, "the original delivered Start can still commit");
      await checkpointReached.promise;
      assert.ok(content.stored()?.runId);
      assert.equal(content.stored().pauseReason, "manual-checkpoint");
      await panel.click("refreshTabs");
      assert.equal(panel.el("stop").disabled, false, "an exact observed Run enables Stop");
      assert.equal([...timers.values()].some(({ ms }) => ms === 15000), false, "observation cancels the deadline");
    } else {
      assert.equal(lateResponse.ok, false, "the test knows the original operation failed, but its relay already timed out");
      for (let i = 0; i < 3; i += 1) await panel.click("refreshTabs");
      assert.equal(content.stored(), null);
      assert.equal(panel.el("start").disabled, true);
      const deadline = [...timers.entries()].find(([, timer]) => timer.ms === 15000);
      assert.ok(deadline, "one bounded reconciliation deadline is armed");
      timers.delete(deadline[0]);
      deadline[1].callback();
      assert.equal(panel.el("statusBadge").textContent, "開始結果不明");
      assert.match(panel.el("message").textContent, /自動再送はしません/);
      await panel.click("refreshTabs");
      await panel.click("start");
      assert.equal(panel.el("start").disabled, true, "repeated nulls after the bound are still not cancellation proof");
      assert.equal(panel.el("stop").disabled, true, "no guessed Run/Stop authority");
    }
    assert.equal(background.commandsDelivered(TAB_ID).length, 1);
    assert.equal(content.clicks().length, 0);
    assert.ok(events.indexOf("start-delivered") < events.indexOf("relay-timeout"));
    assert.equal(startDisabledWhileUnresolved, true, "run:null must not unlock a Start that can still commit");
  } finally {
    recovery.resolve();
    content.context.localRunnerToken += 1;
    checkpointHold.resolve();
    await content.settle();
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    panel.restoreGlobals();
  }
});
}

function status(tabId, run = null) {
  return {
    ok: true, pageReady: true, generationState: "idle", blocker: null,
    provider: "chatgpt", contentVersion: "0.4.0", instanceId: `instance-${tabId}`,
    conversationKey: `chatgpt:c:tab-${tabId}`, run, diagnostics: []
  };
}

const timeoutResponse = { ok: false, relayErrorCode: "COMMAND_DELIVERY_TIMEOUT", relayError: "Fixture Start relay timed out" };
const starts = (panel) => panel.messages.filter((message) => message.payload?.type === "AIPM_START");

async function installPanel(t) {
  const panel = await installSidePanelHarness({
    tabIds: [1, 2], storageSeed: { "aipm.selectedTab.v1": 1, [UI_KEY]: { 1: checkpointEntry, 2: checkpointEntry } }
  });
  await tick();
  const timers = new Map();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
    if (ms !== 15000) return realSetTimeout(callback, ms, ...args);
    const token = {};
    timers.set(token, callback);
    return token;
  });
  t.mock.method(globalThis, "clearTimeout", (token) => {
    if (!timers.delete(token)) realClearTimeout(token);
  });
  return { panel, timers };
}

test("F5 A/B: normal success and immediate rejection retain their existing behavior", async (t) => {
  const { panel, timers } = await installPanel(t);
  let run = null;
  let reject = true;
  panel.setRelayResponder(async (message) => {
    if (message.payload.type === "AIPM_START") {
      if (reject) return { ok: false, error: "Fixture immediate rejection" };
      run = makeRun({ runId: "normal-start", stateRevision: 3 });
      return { ok: true, run };
    }
    return status(message.targetTabId, run);
  });
  try {
    await panel.click("start");
    assert.equal(panel.el("start").disabled, false);
    assert.match(panel.el("message").textContent, /Fixture immediate rejection/);
    assert.equal(timers.size, 0);
    reject = false;
    await panel.click("start");
    assert.equal(starts(panel).length, 2, "a definite rejection permits a new manual Start");
    assert.equal(panel.el("stop").disabled, false);
    assert.equal(panel.el("start").disabled, true);
    assert.equal(timers.size, 0);
  } finally { panel.restoreGlobals(); }
});

test("F5 E: only a fresh new exact Run resolves ambiguity and supplies control identity", async (t) => {
  const { panel, timers } = await installPanel(t);
  let run = makeRun({ runId: "previous-completed", status: "completed", stateRevision: 2 });
  panel.setRelayResponder(async (message) => {
    if (message.payload.type === "AIPM_START") return timeoutResponse;
    if (message.payload.type === "AIPM_STOP") return { ok: true };
    return status(message.targetTabId, run);
  });
  try {
    await panel.click("refreshTabs");
    await panel.click("start");
    assert.equal(panel.el("start").disabled, true, "the previous terminal Run cannot resolve the new intent");
    assert.equal(timers.size, 1);
    assert.equal(panel.el("completionOutcome").hidden, true, "old completion must not describe the pending Start");
    run = { runId: "malformed-observation" };
    await panel.click("refreshTabs");
    assert.equal(panel.el("start").disabled, true, "an unknown Run state cannot resolve Start uncertainty");
    run = makeRun({ runId: "observed-after-timeout", stateRevision: 17 });
    await panel.click("refreshTabs");
    assert.equal(timers.size, 0);
    assert.equal(panel.el("stop").disabled, false);
    await panel.click("stop");
    const stop = panel.messages.find((message) => message.payload?.type === "AIPM_STOP");
    assert.equal(stop.targetTabId, 1);
    assert.equal(stop.payload.expectedRunId, "observed-after-timeout");
    assert.equal(stop.payload.expectedStateRevision, 17);
    assert.equal(starts(panel).length, 1);
  } finally { panel.restoreGlobals(); }
});

for (const completion of ["timeout", "success", "rejection"]) {
test(`F5 F: stale Start A ${completion} cannot replace B's current guidance or authority`, async (t) => {
  const { panel, timers } = await installPanel(t);
  const delivered = deferred();
  const result = deferred();
  const b = makeRun({ runId: "run-b", stateRevision: 9 });
  panel.setRelayResponder(async (message) => {
    if (message.payload.type === "AIPM_START") { delivered.resolve(); return result.promise; }
    return status(message.targetTabId, message.targetTabId === 2 ? b : null);
  });
  try {
    const starting = panel.click("start");
    await delivered.promise;
    panel.el("targetTab").value = "2";
    await panel.change("targetTab");
    const guidance = panel.el("message").textContent;
    const statusCount = panel.messages.filter((message) => message.payload?.type === "AIPM_GET_STATUS").length;
    result.resolve(completion === "timeout" ? timeoutResponse
      : completion === "success" ? { ok: true } : { ok: false, error: "OLD A REJECTION" });
    await starting;
    assert.equal(panel.el("message").textContent, guidance);
    assert.equal(panel.el("stop").disabled, false);
    assert.equal(panel.messages.filter((message) => message.payload?.type === "AIPM_GET_STATUS").length, statusCount,
      "old completion must not refresh the new target");
    if (completion === "timeout") {
      assert.equal(timers.size, 1);
      [...timers.values()][0]();
      assert.equal(panel.el("message").textContent, guidance, "A's deadline cannot repaint B");
      panel.el("targetTab").value = "1";
      await panel.change("targetTab");
      assert.equal(panel.el("statusBadge").textContent, "開始結果不明");
      await panel.click("start");
      assert.equal(panel.el("start").disabled, true, "switching away and back does not unlock the unresolved tab");
    }
    assert.equal(starts(panel).length, 1);
  } finally { panel.restoreGlobals(); }
});
}

for (const response of [undefined, {}, { ok: "true" }]) {
test(`F5: malformed Start result ${JSON.stringify(response)} remains unresolved`, async (t) => {
  const { panel } = await installPanel(t);
  panel.setRelayResponder(async (message) => message.payload.type === "AIPM_START" ? response : status(1));
  try {
    await panel.click("start");
    await panel.click("start");
    assert.equal(starts(panel).length, 1);
    assert.equal(panel.el("start").disabled, true);
    assert.match(panel.el("message").textContent, /開始結果を確認中/);
  } finally { panel.restoreGlobals(); }
});
}
