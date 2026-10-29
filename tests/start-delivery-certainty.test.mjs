import { CURRENT_EXTENSION_VERSION } from "./helpers/extension-version.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { installBackgroundHarness } from "./helpers/background-harness.mjs";
import { installSidePanelHarness, tick } from "./helpers/sidepanel-harness.mjs";

// The production background and panel run with extension API shims. No browser,
// provider page, composer input or external message is involved.
const entry = {
  mode: "workflow", editorRevision: 1,
  workflow: { schemaVersion: 1, maxSends: 1, steps: [{ id: "hold", type: "checkpoint" }] }
};

function start(tabId) {
  return {
    type: "AIPM_START", expectedConversationKey: "chatgpt:c:torture",
    expectedDocumentInstanceId: `instance-${tabId}`,
    workflow: entry.workflow
  };
}

for (const [name, changed, code] of [
  ["content version", { contentVersion: "older-fixture" }, "CONTENT_VERSION_MISMATCH"],
  ["previous 0.4.2 content with the current worker", { contentVersion: "0.4.2" }, "CONTENT_VERSION_MISMATCH"],
  ["provider", { provider: "other-fixture" }, "CONTENT_PROVIDER_MISMATCH"],
  ["conversation", { conversationKey: "chatgpt:c:another" }, "STALE_START_TARGET"],
  ["new chat", { conversationKey: "chatgpt:new:root:fixture" }, "START_CONVERSATION_REQUIRED"]
]) {
  test(`Start rejection before dispatch exposes certainty: ${name}`, async () => {
    const background = await installBackgroundHarness();
    const tabId = 71;
    background.setStatusResponder(tabId, () => ({ ...background.defaultStatus(tabId), ...changed }));
    const response = await background.relay(start(tabId), tabId);
    assert.equal(response.ok, false);
    assert.equal(response.relayErrorCode, code);
    assert.equal(response.startDeliveryState, "not-dispatched");
    assert.equal(background.commandsDelivered(tabId).length, 0);
    assert.equal(background.storedRun(tabId), null);
  });
}

test("Start without an explicit target is a definite non-delivery", async () => {
  const background = await installBackgroundHarness();
  const response = await background.relay(start(72), null);
  assert.equal(response.startDeliveryState, "not-dispatched");
  assert.equal(response.relayErrorCode, "TARGET_TAB_REQUIRED");
  assert.equal(background.tabMessages.length, 0);
});

test("a command transport rejection is attempted, never declared undelivered", async () => {
  const background = await installBackgroundHarness();
  const tabId = 73;
  background.setCommandResponder(tabId, () => { throw new Error("fixture transport reply lost"); });
  const response = await background.relay(start(tabId), tabId);
  assert.equal(response.ok, false);
  assert.equal(response.startDeliveryState, "attempted");
  assert.equal(response.relayErrorCode, "COMMAND_DELIVERY_FAILED");
  assert.equal(background.commandsDelivered(tabId).length, 1);
});

test("a delivered response cannot forge the background's non-delivery evidence", async () => {
  const background = await installBackgroundHarness();
  const tabId = 74;
  background.setCommandResponder(tabId, () => ({
    ok: false, relayError: "fixture uncertain result", startDeliveryState: "not-dispatched"
  }));
  const response = await background.relay(start(tabId), tabId);
  assert.equal(response.startDeliveryState, "attempted");
  assert.equal(background.commandsDelivered(tabId).length, 1);
});

test("the actual panel unlocks a definitely undelivered Start and can start once after repair", async () => {
  const tabId = 75;
  const panel = await installSidePanelHarness({
    tabIds: [tabId], storageSeed: {
      "aipm.selectedTab.v1": tabId, "aipm.uiByTab.v2": { [tabId]: entry }
    }
  });
  try {
    await tick();
    const panelChrome = globalThis.chrome;
    const background = await installBackgroundHarness();
    const backgroundChrome = globalThis.chrome;
    background.setTabs([{ id: tabId, windowId: 1, active: true, url: "https://chatgpt.com/c/torture" }]);
    globalThis.chrome = {
      ...backgroundChrome,
      runtime: { ...backgroundChrome.runtime, sendMessage: panelChrome.runtime.sendMessage },
      storage: { ...backgroundChrome.storage, local: panelChrome.storage.local }
    };
    let rejectNextStart = false;
    panel.setRelayResponder(async (message) => {
      if (message.payload.type === "AIPM_START" && rejectNextStart) {
        background.setStatusResponder(tabId, () => ({
          ...background.defaultStatus(tabId), contentVersion: "older-fixture"
        }));
        const response = await background.invoke(message);
        background.setStatusResponder(tabId, () => background.defaultStatus(tabId));
        rejectNextStart = false;
        return response;
      }
      return background.invoke(message);
    });
    await panel.click("refreshTabs");
    rejectNextStart = true;
    await panel.click("start");
    assert.equal(background.commandsDelivered(tabId).length, 0);
    assert.equal(panel.el("start").disabled, false, "a proven non-delivery must not retain Start uncertainty");
    assert.notEqual(panel.el("statusBadge").textContent, "開始結果不明");
    assert.match(panel.el("message").textContent, /一致しません/);
    await panel.click("start");
    assert.equal(background.commandsDelivered(tabId).length, 1, "the next explicit user click dispatches once");
  } finally {
    panel.restoreGlobals();
  }
});

for (const certainty of [undefined, "attempted", "not-dispatched-invalid"]) {
  test(`the panel retains uncertain relay failure without exact non-delivery evidence: ${certainty}`, async () => {
    const tabId = 76;
    const panel = await installSidePanelHarness({
      tabIds: [tabId], storageSeed: {
        "aipm.selectedTab.v1": tabId, "aipm.uiByTab.v2": { [tabId]: entry }
      }
    });
    try {
      await tick();
      panel.setRelayResponder(async (message) => message.payload.type === "AIPM_START" ? {
        ok: false, relayError: "fixture command result unknown", relayErrorCode: "CONTENT_VERSION_MISMATCH",
        startDeliveryState: certainty
      } : {
        ok: true, provider: "chatgpt", contentVersion: CURRENT_EXTENSION_VERSION, pageReady: true,
        conversationKey: `chatgpt:c:tab-${tabId}`, instanceId: `instance-${tabId}`,
        generationState: "idle", blocker: null, run: null, diagnostics: []
      });
      await panel.click("start");
      await panel.click("start");
      assert.equal(panel.messages.filter(message => message.payload?.type === "AIPM_START").length, 1);
      assert.equal(panel.el("start").disabled, true);
    } finally {
      panel.restoreGlobals();
    }
  });
}
