import test from "node:test";
import assert from "node:assert/strict";

const listeners = [];
const sent = [];
const session = { "aipm.executionSession.v1": "session-test" };

globalThis.chrome = {
  runtime: {
    getManifest() { return { version: "0.4.0" }; },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(listener) { listeners.push(listener); } }
  },
  sidePanel: { async setPanelBehavior() {} },
  tabs: {
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} },
    async sendMessage(tabId, payload, options = {}) {
      sent.push({ tabId, payload, options });
      const targetsCurrentTop = options?.frameId === 0 || options?.documentId === "project-new-document";
      if (payload.type === "AIPM_GET_STATUS") {
        return targetsCurrentTop
          ? {
              ok: true,
              provider: "chatgpt",
              contentVersion: "0.4.0",
              pageReady: true,
              conversationKey: "chatgpt:c:project-conversation",
              instanceId: "project-new-instance",
              run: null
            }
          : {
              ok: true,
              provider: "chatgpt",
              contentVersion: "0.4.0",
              pageReady: true,
              conversationKey: "chatgpt:c:project-conversation",
              instanceId: "project-old-instance",
              run: null
            };
      }
      if (payload.type === "AIPM_START") {
        return targetsCurrentTop
          ? { ok: true }
          : { ok: false, error: "現在のdocumentを確認できないためRun更新を拒否しました。" };
      }
      return { ok: true };
    }
  },
  storage: {
    local: {
      async get() { return {}; },
      async set() {},
      async remove() {}
    },
    session: {
      async get(key) { return { [key]: session[key] }; },
      async set(values) { Object.assign(session, values); },
      async remove() {}
    }
  },
  alarms: {
    onAlarm: { addListener() {} },
    async clear() { return false; },
    create() {}
  },
  scripting: {
    async executeScript(details) {
      assert.equal(details.target.tabId, 215);
      assert.deepEqual(details.target.frameIds, [0]);
      return [{ result: "project-new-instance", frameId: 0, documentId: "project-new-document" }];
    }
  },
  permissions: {
    async contains() { return true; }
  },
  power: {
    requestKeepAwake() {},
    releaseKeepAwake() {}
  }
};

await import(`../src/background.js?reload-top-document=${Date.now()}`);

function invoke(message, sender = {}) {
  return new Promise((resolve, reject) => {
    let handled = false;
    for (const listener of listeners) {
      if (listener(message, sender, resolve) === true) handled = true;
    }
    if (!handled) reject(new Error("message was not handled"));
  });
}

test("reload relay pins preflight and Start to the active top document", async () => {
  const response = await invoke({
    type: "AIPM_RELAY_TO_CHATGPT",
    targetTabId: 215,
    payload: { type: "AIPM_START", workflow: { id: "repeat-5", maxSends: 5 } }
  });

  const statusMessage = sent.find((item) => item.payload.type === "AIPM_GET_STATUS");
  const startMessage = sent.find((item) => item.payload.type === "AIPM_START");

  assert.equal(response.ok, true);
  assert.equal(statusMessage?.options?.frameId, 0);
  assert.equal(startMessage?.options?.documentId, "project-new-document");
  assert.equal(startMessage?.payload.expectedDocumentInstanceId, "project-new-instance");
  assert.equal(startMessage?.payload.expectedConversationKey, "chatgpt:c:project-conversation");
  assert.equal(sent.filter((item) => item.payload.type === "AIPM_START").length, 1);
});
