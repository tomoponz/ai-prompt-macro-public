import test from "node:test";
import assert from "node:assert/strict";

const listeners = { message: [] };
const storageData = {};
const sessionStorageData = { "aipm.executionSession.v1": "session-test" };
const currentDocumentIds = new Map();
const currentDocumentInstanceIds = new Map();
const deliveries = [];
let onStatusRequest = null;

globalThis.chrome = {
  runtime: {
    getManifest() { return { version: "0.4.0" }; },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(fn) { listeners.message.push(fn); } }
  },
  sidePanel: { async setPanelBehavior() {} },
  permissions: { async contains() { return true; } },
  storage: {
    local: {
      async get(key) {
        if (typeof key === "string") return { [key]: storageData[key] };
        if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, storageData[item]]));
        return { ...storageData };
      },
      async set(values) { Object.assign(storageData, values); },
      async remove(key) { for (const item of Array.isArray(key) ? key : [key]) delete storageData[item]; }
    },
    session: {
      async get(key) { return typeof key === "string" ? { [key]: sessionStorageData[key] } : { ...sessionStorageData }; },
      async set(values) { Object.assign(sessionStorageData, values); }
    }
  },
  tabs: {
    async query() { return [{ id: 90, active: true, windowId: 1, url: "https://chatgpt.com/" }]; },
    async sendMessage(tabId, message, options = {}) {
      deliveries.push({ tabId, type: message?.type, options: { ...options }, message });
      if (message?.type === "AIPM_GET_STATUS") {
        // The answering document composes its reply first; only then does the tab navigate.
        const status = {
          ok: true,
          provider: "chatgpt",
          contentVersion: "0.4.0",
          pageReady: true,
          conversationKey: "chatgpt:c:pinned",
          instanceId: currentDocumentInstanceIds.get(tabId) ?? null,
          run: null
        };
        onStatusRequest?.(tabId);
        return status;
      }
      // A document-addressed message only reaches the document that still exists.
      if (typeof options.documentId === "string" && options.documentId !== currentDocumentIds.get(tabId)) {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }
      return {
        ok: true,
        deliveredToDocumentId: currentDocumentIds.get(tabId),
        deliveredToInstanceId: currentDocumentInstanceIds.get(tabId),
        echoedPayload: message
      };
    },
    onRemoved: { addListener() {} }
  },
  alarms: { async create() {}, async clear() { return true; }, async getAll() { return []; }, onAlarm: { addListener() {} } },
  scripting: {
    async executeScript(details) {
      const tabId = details.target.tabId;
      if (details.func) {
        return [{
          result: String(details.func).includes("__AIPM_DOCUMENT_INSTANCE_ID__")
            ? (currentDocumentInstanceIds.get(tabId) ?? null)
            : { origin: "https://chatgpt.com", corePresent: true, controllerReady: true, version: "0.4.0" },
          frameId: 0,
          documentId: currentDocumentIds.get(tabId) ?? `document-${tabId}`
        }];
      }
      return [{ result: null }];
    }
  },
  power: { requestKeepAwake() {}, releaseKeepAwake() {} }
};

await import(`../src/background.js?pinning-test=${Date.now()}`);

function invokeRuntimeMessage(message, sender = {}) {
  return new Promise((resolve, reject) => {
    let handled = false;
    for (const listener of listeners.message) {
      if (listener(message, sender, resolve) === true) handled = true;
    }
    if (!handled) reject(new Error("message was not handled"));
  });
}

function setDocument(tabId, suffix) {
  currentDocumentIds.set(tabId, `document-${suffix}`);
  currentDocumentInstanceIds.set(tabId, `instance-${suffix}`);
}

function relayStart(tabId) {
  return invokeRuntimeMessage({
    type: "AIPM_RELAY_TO_CHATGPT",
    targetTabId: tabId,
    payload: {
      type: "AIPM_START",
      workflow: { schemaVersion: 1, maxSends: 1, steps: [{ id: "s", type: "prompt", delivery: "send", prompt: "go", repeat: 1 }] },
      keepAwake: false
    }
  });
}

const mutations = () => deliveries.filter((entry) => entry.type !== "AIPM_GET_STATUS");

test("STAGE3-B: a mutation for the unchanged document is delivered to that exact document", async () => {
  const tabId = 501;
  deliveries.length = 0;
  onStatusRequest = null;
  setDocument(tabId, "stable");

  const response = await relayStart(tabId);

  assert.equal(response.ok, true, `delivery must succeed (got: ${response.relayError})`);
  const delivered = mutations();
  assert.equal(delivered.length, 1);
  assert.equal(
    delivered[0].options.documentId,
    "document-stable",
    "the mutation must be addressed to the preflight document, not merely to frame 0"
  );
  assert.equal(response.deliveredToInstanceId, "instance-stable");
});

test("STAGE3-A: a mutation is never delivered to a document that replaced the preflight document", async () => {
  const tabId = 502;
  deliveries.length = 0;
  setDocument(tabId, "before");
  // The tab navigates the instant after the preflight status answers.
  onStatusRequest = (statusTabId) => {
    if (statusTabId === tabId) setDocument(tabId, "after");
  };

  const response = await relayStart(tabId);
  onStatusRequest = null;

  assert.equal(response.ok, false, "a navigated-away document must fail closed");
  const delivered = mutations();
  for (const entry of delivered) {
    assert.notEqual(
      entry.options.documentId,
      "document-after",
      "the mutation must never be addressed to the replacement document"
    );
  }
  assert.equal(
    deliveries.some((entry) => entry.type === "AIPM_START" && entry.options.documentId === undefined),
    false,
    "an unpinned frame-0 delivery would reach the replacement document"
  );
});

test("STAGE3-C: an old-document receiver cannot absorb the mutation once the top document changed", async () => {
  const tabId = 503;
  deliveries.length = 0;
  onStatusRequest = null;
  setDocument(tabId, "old");

  // Preflight answers from the old document, then the top document is replaced while the
  // old receiver is still alive and would happily answer a frame-0 broadcast.
  onStatusRequest = (statusTabId) => {
    if (statusTabId === tabId) setDocument(tabId, "new");
  };
  const response = await relayStart(tabId);
  onStatusRequest = null;

  assert.equal(response.ok, false, "the mutation must fail closed rather than reach a different document");
  assert.notEqual(response.relayError, undefined);
});

test("STAGE3-D: the delivered payload still carries every existing identity fence", async () => {
  const tabId = 504;
  deliveries.length = 0;
  onStatusRequest = null;
  setDocument(tabId, "fences");

  const response = await relayStart(tabId);
  assert.equal(response.ok, true);

  const payload = mutations()[0].message;
  assert.equal(payload.expectedConversationKey, "chatgpt:c:pinned", "conversationKey fence must remain");
  assert.equal(payload.expectedDocumentInstanceId, "instance-fences", "documentInstanceId fence must remain");
  assert.equal(payload.expectedRunId, null, "expectedRunId fence must remain");
  assert.equal(payload.executionSessionId, "session-test", "executionSession fence must remain");
  assert.equal(payload.serviceWorkerVersion, "0.4.0", "contentVersion handshake must remain");
  assert.equal(payload.bindingTabId, tabId);
});

test("STAGE3: a read-only status request stays unpinned so discovery can still retry", async () => {
  const tabId = 505;
  deliveries.length = 0;
  onStatusRequest = null;
  setDocument(tabId, "readonly");

  const response = await invokeRuntimeMessage({
    type: "AIPM_RELAY_TO_CHATGPT",
    targetTabId: tabId,
    payload: { type: "AIPM_GET_STATUS" }
  });

  assert.equal(response.ok, true);
  const statusCalls = deliveries.filter((entry) => entry.type === "AIPM_GET_STATUS");
  assert.ok(statusCalls.length >= 1);
  assert.equal(statusCalls[0].options.frameId, 0, "read-only discovery keeps the top-frame restriction");
});

test("STAGE3: when the browser reports no documentId the delivery falls back to the top frame", async () => {
  const tabId = 506;
  deliveries.length = 0;
  onStatusRequest = null;
  setDocument(tabId, "no-document-id");
  const realExecuteScript = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async (details) => {
    const results = await realExecuteScript(details);
    return results.map((item) => ({ ...item, documentId: undefined }));
  };

  try {
    const response = await relayStart(tabId);
    assert.equal(response.ok, true, "an unpinnable browser must keep working, not fail closed");
    assert.equal(mutations()[0].options.frameId, 0, "the previous top-frame fence must remain the fallback");
    assert.equal(mutations()[0].options.documentId, undefined);
    assert.equal(mutations()[0].message.expectedDocumentInstanceId, "instance-no-document-id");
  } finally {
    chrome.scripting.executeScript = realExecuteScript;
  }
});

test("STAGE3: an unavailable document probe fails closed before command delivery", async () => {
  const tabId = 507;
  deliveries.length = 0;
  onStatusRequest = null;
  setDocument(tabId, "probe-down");
  const realExecuteScript = chrome.scripting.executeScript;
  let probeCalls = 0;
  chrome.scripting.executeScript = async (details) => {
    if (String(details.func ?? "").includes("__AIPM_DOCUMENT_INSTANCE_ID__")) {
      probeCalls += 1;
      throw new Error("probe unavailable");
    }
    return realExecuteScript(details);
  };

  try {
    const response = await relayStart(tabId);
    assert.equal(probeCalls, 12, "only the fixed bounded read-only recovery episode may retry");
    assert.equal(response.ok, false);
    assert.equal(response.relayErrorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
    assert.equal(mutations().length, 0, "no mutating command may be delivered without identity proof");
  } finally {
    chrome.scripting.executeScript = realExecuteScript;
  }
});
