import assert from "node:assert/strict";
import test from "node:test";
import {
  installBackgroundHarness,
  leaseKey,
  makeRun
} from "./helpers/background-harness.mjs";

// Background-only Start contract. All page responses and workflow data are synthetic;
// assertions deliberately report codes/counters rather than stored instruction bodies.
const harness = await installBackgroundHarness();
let nextTabId = 36_000;

function fixture() {
  const tabId = ++nextTabId;
  const documentId = `start-document-${tabId}`;
  const documentInstanceId = `start-instance-${tabId}`;
  const conversationKey = `chatgpt:c:start-${tabId}`;
  harness.setStorageSetFault(null);
  harness.setStorageGetFault(null);
  harness.setDocument(tabId, { documentId, documentInstanceId });
  harness.setTabs([{ id: tabId, url: `https://chatgpt.com/c/start-${tabId}`, active: true }]);
  harness.setStatusResponder(tabId, () => ({
    ...harness.defaultStatus(tabId), conversationKey
  }));
  return {
    tabId, documentId, documentInstanceId, conversationKey,
    sender: { tab: { id: tabId }, frameId: 0, documentId, documentLifecycle: "active" }
  };
}

function startRun(f, overrides = {}) {
  return makeRun({
    runId: `start-run-${f.tabId}`, boundTabId: f.tabId,
    boundDocumentId: f.documentId, documentInstanceId: f.documentInstanceId,
    conversationKey: f.conversationKey, executionSessionId: harness.sessionId(),
    stateRevision: 0, ...overrides
  });
}

function seedTerminalRun(f) {
  const terminal = startRun(f, {
    runId: `previous-run-${f.tabId}`, status: "completed", phase: "completed",
    stateRevision: 7, cursor: { stepIndex: 1, repeatIndex: 0, sendsCompleted: 1 }
  });
  harness.putRun(f.tabId, terminal);
  harness.storageData[leaseKey(f.conversationKey)] = {
    runId: terminal.runId, tabId: f.tabId, nonce: `previous-lease-${f.tabId}`,
    documentId: f.documentId, documentInstanceId: f.documentInstanceId,
    executionSessionId: harness.sessionId(), expiresAt: Date.now() + 15_000
  };
  return terminal;
}

function mutationSnapshot() {
  const local = JSON.stringify(harness.storageData);
  const session = JSON.stringify(harness.sessionStorageData);
  const alarms = JSON.stringify([...harness.alarms.entries()]);
  const powerCount = harness.powerEvents.length;
  let writes = 0;
  harness.setStorageSetFault(() => { writes += 1; });
  return () => {
    harness.setStorageSetFault(null);
    return {
      writes,
      localUnchanged: JSON.stringify(harness.storageData) === local,
      sessionUnchanged: JSON.stringify(harness.sessionStorageData) === session,
      alarmsUnchanged: JSON.stringify([...harness.alarms.entries()]) === alarms,
      powerUnchanged: harness.powerEvents.length === powerCount
    };
  };
}

function assertNoMutation(observed) {
  assert.equal(observed.writes, 0, "rejected Start must perform zero local writes");
  for (const field of ["localUnchanged", "sessionUnchanged", "alarmsUnchanged", "powerUnchanged"]) {
    assert.equal(observed[field], true, `rejected Start must preserve ${field}`);
  }
}

const saveRejections = [
  ["root New Chat", f => [`chatgpt:new:root:${f.documentInstanceId}`, `chatgpt:new:root:${f.documentInstanceId}`]],
  ["Project New Chat", f => [`chatgpt:new:project:g-p-synthetic:${f.documentInstanceId}`, `chatgpt:new:project:g-p-synthetic:${f.documentInstanceId}`]],
  ["missing current key", f => [f.conversationKey, null]],
  ["missing Run key", f => [null, f.conversationKey]],
  ["empty canonical id", () => ["chatgpt:c:", "chatgpt:c:"]],
  ["malformed canonical id", () => ["chatgpt:c:not/a-conversation", "chatgpt:c:not/a-conversation"]],
  ["New Chat Run with canonical request", f => [`chatgpt:new:root:${f.documentInstanceId}`, f.conversationKey]],
  ["canonical Run with New Chat request", f => [f.conversationKey, `chatgpt:new:root:${f.documentInstanceId}`]],
  ["different canonical target", f => [f.conversationKey, "chatgpt:c:different"], "STALE_START_TARGET"]
];

for (const [label, keys, code = "START_CONVERSATION_REQUIRED"] of saveRejections) {
  test(`Start save rejects ${label} without changing the prior terminal Run`, async () => {
    const f = fixture();
    const terminal = seedTerminalRun(f);
    const [runKey, requestKey] = keys(f);
    const run = startRun(f, { conversationKey: runKey, replacesRunId: terminal.runId });
    const snapshot = mutationSnapshot();
    const response = await harness.invoke({
      type: "AIPM_RUN_SET", runTransition: "start", run,
      conversationKey: requestKey, documentInstanceId: f.documentInstanceId
    }, f.sender);
    const observed = snapshot();
    assert.equal(response.ok, false, "Start must refuse a target that was not confirmed canonical");
    assert.equal(response.errorCode, code);
    assertNoMutation(observed);
    assert.equal(harness.storedRun(f.tabId)?.runId, terminal.runId);
    assert.equal(harness.commandsDelivered(f.tabId).length, 0);
  });
}

test("Start save accepts the exact canonical target and document", async () => {
  const f = fixture();
  const terminal = seedTerminalRun(f);
  const run = startRun(f, { replacesRunId: terminal.runId });
  const response = await harness.invoke({
    type: "AIPM_RUN_SET", runTransition: "start", run,
    conversationKey: f.conversationKey, documentInstanceId: f.documentInstanceId
  }, f.sender);
  assert.equal(response.ok, true);
  assert.equal(harness.storedRun(f.tabId)?.runId, run.runId);
  assert.equal(harness.storedRun(f.tabId)?.conversationKey, f.conversationKey);
  assert.equal(harness.storedRun(f.tabId)?.boundDocumentId, f.documentId);
});

const relayRejections = [
  ["missing conversation snapshot", f => ({ expectedKey: undefined, freshKey: f.conversationKey })],
  ["missing document snapshot", f => ({ expectedKey: f.conversationKey, expectedInstance: undefined }), "STALE_START_TARGET"],
  ["empty document snapshot", f => ({ expectedKey: f.conversationKey, expectedInstance: "" }), "STALE_START_TARGET"],
  ["canonical A to canonical B", f => ({ expectedKey: f.conversationKey, freshKey: "chatgpt:c:different" }), "STALE_START_TARGET"],
  ["canonical to New Chat", f => ({ expectedKey: f.conversationKey, freshKey: `chatgpt:new:root:${f.documentInstanceId}` })],
  ["New Chat to canonical", f => ({ expectedKey: `chatgpt:new:root:${f.documentInstanceId}`, freshKey: f.conversationKey })],
  ["Project New Chat snapshot", f => ({ expectedKey: `chatgpt:new:project:g-p-synthetic:${f.documentInstanceId}` })],
  ["same canonical route after document replacement", f => ({ expectedKey: f.conversationKey, expectedInstance: `previous-instance-${f.tabId}` }), "STALE_START_TARGET"],
  ["malformed expected canonical key", () => ({ expectedKey: "chatgpt:c:" })],
  ["malformed fresh canonical key", f => ({ expectedKey: f.conversationKey, freshKey: "chatgpt:c:invalid/path" })]
];

for (const [label, change, code = "START_CONVERSATION_REQUIRED"] of relayRejections) {
  test(`Start relay rejects ${label} without command delivery`, async () => {
    const f = fixture();
    const changed = change(f);
    const freshKey = changed.freshKey ?? f.conversationKey;
    const expectedInstance = Object.hasOwn(changed, "expectedInstance")
      ? changed.expectedInstance : f.documentInstanceId;
    harness.setStatusResponder(f.tabId, () => ({
      ...harness.defaultStatus(f.tabId), conversationKey: freshKey
    }));
    const snapshot = mutationSnapshot();
    const response = await harness.relay({
      type: "AIPM_START", workflow: startRun(f).workflow,
      ...(changed.expectedKey === undefined ? {} : { expectedConversationKey: changed.expectedKey }),
      ...(expectedInstance === undefined ? {} : { expectedDocumentInstanceId: expectedInstance })
    }, f.tabId);
    const observed = snapshot();
    assert.equal(response.ok, false, "Start must not silently rebind the user's observed target");
    assert.equal(response.relayErrorCode, code);
    assert.equal(harness.commandsDelivered(f.tabId).length, 0);
    assertNoMutation(observed);
  });
}

test("Start relay delivers the exact canonical conversation and document snapshot once", async () => {
  const f = fixture();
  const response = await harness.relay({
    type: "AIPM_START", workflow: startRun(f).workflow,
    expectedConversationKey: f.conversationKey,
    expectedDocumentInstanceId: f.documentInstanceId
  }, f.tabId);
  assert.equal(response.ok, true);
  const delivered = harness.commandsDelivered(f.tabId);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].payload.expectedConversationKey, f.conversationKey);
  assert.equal(delivered[0].payload.expectedDocumentInstanceId, f.documentInstanceId);
  assert.equal(delivered[0].options.documentId, f.documentId);
});
