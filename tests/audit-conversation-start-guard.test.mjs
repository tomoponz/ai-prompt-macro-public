import assert from "node:assert/strict";
import test from "node:test";
import {
  activeRunKey,
  deferred,
  flushAsync,
  installBackgroundHarness,
  leaseKey,
  makeRun
} from "./helpers/background-harness.mjs";

const harness = await installBackgroundHarness();
let nextTabId = 57_000;

function fixture(conversationKey = `chatgpt:c:start-guard-${nextTabId + 1}`) {
  const tabId = ++nextTabId;
  const documentId = `guard-document-${tabId}`;
  const documentInstanceId = `guard-instance-${tabId}`;
  harness.setDocument(tabId, { documentId, documentInstanceId });
  return {
    tabId, conversationKey, documentId, documentInstanceId,
    sender: { tab: { id: tabId }, frameId: 0, documentId, documentLifecycle: "active" },
    run: makeRun({
      runId: `guard-run-${tabId}`, conversationKey, boundTabId: tabId,
      boundDocumentId: documentId, documentInstanceId,
      executionSessionId: harness.sessionId(), stateRevision: 0
    })
  };
}

function save(f, overrides = {}, runTransition = "start") {
  return harness.invoke({
    type: "AIPM_RUN_SET", runTransition, run: { ...f.run, ...overrides },
    conversationKey: f.conversationKey, documentInstanceId: f.documentInstanceId
  }, f.sender);
}

function pair() {
  const first = fixture();
  const second = fixture(first.conversationKey);
  harness.setTabs([first, second].map(f => ({
    id: f.tabId, url: `https://chatgpt.com/c/${f.conversationKey.slice("chatgpt:c:".length)}`
  })));
  return [first, second];
}

for (const [status, phase] of [["running", "waiting"], ["paused", "checkpoint"]]) {
  test(`a ${status} Run with no lease blocks another tab's Start without mutations`, async () => {
    const [first, second] = pair();
    const owner = { ...first.run, status, phase, stateRevision: 4 };
    harness.putRun(first.tabId, owner);
    const previous = { ...second.run, runId: `previous-${second.tabId}`, status: "completed", phase: "completed" };
    harness.putRun(second.tabId, previous);
    assert.equal(harness.storageData[leaseKey(first.conversationKey)], undefined);
    const before = structuredClone(harness.storageData);
    const powerCount = harness.powerEvents.length;
    const response = await save(second, { replacesRunId: previous.runId });
    assert.equal(response.ok, false);
    assert.equal(response.errorCode, "CONVERSATION_RUN_ACTIVE");
    assert.match(response.error, /別のタブ/);
    assert.deepEqual(harness.storageData, before);
    assert.equal(harness.powerEvents.length, powerCount);
    assert.equal(harness.commandsDelivered(second.tabId).length, 0);
  });
}

for (const overrides of [
  { status: "stopped" },
  { status: "completed" },
  { status: "running", executionSessionId: "previous-browser-session" },
  { status: "running", conversationKey: "chatgpt:c:unrelated-conversation" }
]) {
  test(`Start ignores an unrelated or inactive stored Run: ${JSON.stringify(overrides)}`, async () => {
    const [first, second] = pair();
    harness.putRun(first.tabId, { ...first.run, ...overrides });
    const ownerBefore = structuredClone(harness.storedRun(first.tabId));
    const response = await save(second);
    assert.equal(response.ok, true);
    assert.equal(harness.storedRun(second.tabId)?.runId, second.run.runId);
    assert.deepEqual(harness.storedRun(first.tabId), ownerBefore);
  });
}

test("simultaneous Starts on the same conversation commit exactly one Run", { timeout: 5000 }, async () => {
  const [first, second] = pair();
  const entered = deferred();
  const release = deferred();
  let writes = 0;
  harness.setStorageSetFault(async values => {
    if (values[activeRunKey(first.tabId)]) {
      writes += 1;
      entered.resolve();
      await release.promise;
    }
    if (values[activeRunKey(second.tabId)]) writes += 1;
  });
  try {
    const firstSave = save(first);
    await entered.promise;
    const secondSave = save(second);
    await flushAsync();
    assert.equal(writes, 1, "the competing Start must wait for the first durable write");
    release.resolve();
    const results = await Promise.all([firstSave, secondSave]);
    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, false);
    assert.equal(results[1].errorCode, "CONVERSATION_RUN_ACTIVE");
    assert.equal(writes, 1);
    assert.equal(harness.storedRun(first.tabId)?.runId, first.run.runId);
    assert.equal(harness.storedRun(second.tabId), null);
  } finally {
    release.resolve();
    harness.setStorageSetFault(null);
  }
});

test("a failed Start write releases the conversation queue for a later Start", async () => {
  const [first, second] = pair();
  harness.setStorageSetFault(values => {
    if (values[activeRunKey(first.tabId)]) throw new Error("synthetic durable write failure");
  });
  try {
    const response = await save(first);
    assert.equal(response.ok, false);
    assert.equal(harness.storedRun(first.tabId), null);
  } finally {
    harness.setStorageSetFault(null);
  }
  assert.equal((await save(second)).ok, true);
});

test("a schedule that expires during the other-Run scan cannot commit Start", async () => {
  const f = fixture();
  const scheduledAt = Date.parse("2030-01-02T03:04:05.000Z");
  const originalNow = Date.now;
  let now = scheduledAt;
  let scanned = false;
  Date.now = () => now;
  harness.setStorageGetFault(key => {
    if (key === null) {
      scanned = true;
      now = scheduledAt + 1_001;
    }
  });
  try {
    const response = await save(f, { workflow: {
      schemaVersion: 1, id: "scheduled-start", name: "Scheduled start", maxSends: 1,
      steps: [{ id: "wait", type: "wait-until", at: new Date(scheduledAt).toISOString(), latePolicy: "pause", graceMs: 1_000 },
        { id: "one", type: "prompt", delivery: "send", prompt: "SYNTHETIC", repeat: 1, delayAfterMs: 0 }]
    } });
    assert.equal(scanned, true);
    assert.equal(response.ok, false);
    assert.equal(response.errorCode, "SCHEDULE_START_STALE");
    assert.equal(harness.storedRun(f.tabId), null);
  } finally {
    Date.now = originalNow;
    harness.setStorageGetFault(null);
  }
});

test("an in-flight Start does not serialize Starts in a different conversation", { timeout: 5000 }, async () => {
  const first = fixture();
  const second = fixture();
  const entered = deferred();
  const release = deferred();
  harness.setStorageSetFault(async values => {
    if (values[activeRunKey(first.tabId)]) {
      entered.resolve();
      await release.promise;
    }
  });
  try {
    const firstSave = save(first);
    await entered.promise;
    assert.equal((await save(second)).ok, true);
    release.resolve();
    assert.equal((await firstSave).ok, true);
  } finally {
    release.resolve();
    harness.setStorageSetFault(null);
  }
});

test("the original Run still saves progress and can be explicitly paused and resumed", async () => {
  const [first, second] = pair();
  assert.equal((await save(first)).ok, true);
  assert.equal((await save(second)).errorCode, "CONVERSATION_RUN_ACTIVE");
  const progressed = await save(first, {
    ...harness.storedRun(first.tabId), phase: "waiting",
    cursor: { stepIndex: 1, repeatIndex: 0, sendsCompleted: 1 }
  }, "runner");
  assert.equal(progressed.ok, true);
  const paused = await save(first, { ...progressed.run, status: "paused" }, "pause");
  assert.equal(paused.ok, true);
  const resumed = await save(first, { ...paused.run, status: "running" }, "resume");
  assert.equal(resumed.ok, true);
  const stopped = await harness.relay({
    type: "AIPM_STOP", expectedRunId: resumed.run.runId
  }, first.tabId);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.stopCommitted, true);
  assert.equal((await save(second)).ok, true, "Stop permits a new Run in the other tab");
});
