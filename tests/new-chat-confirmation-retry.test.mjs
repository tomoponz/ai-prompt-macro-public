import { CURRENT_EXTENSION_VERSION } from "./helpers/extension-version.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { activeRunKey, deferred, flushAsync, installBackgroundHarness, makeRun } from "./helpers/background-harness.mjs";

// Production background handler; all browser observations and input data are synthetic.
// Assertions report state/counters, never instruction or response bodies.
const h = await installBackgroundHarness();
const CONFIRMATION = "new-chat-confirmation-required";
const hash = (value) => createHash("sha256").update(value).digest("hex");
let nextTab = 38000;

function fixture({ canonical = false } = {}) {
  h.setStorageSetFault(null);
  h.setStorageGetFault(null);
  const tabId = ++nextTab;
  const documentId = `document-${tabId}`;
  const documentInstanceId = `instance-${tabId}`;
  const target = `chatgpt:c:confirmation-${tabId}`;
  const run = makeRun({
    runId: `confirmation-${tabId}`, executionSessionId: h.sessionId(), boundTabId: tabId,
    boundDocumentId: documentId, documentInstanceId,
    conversationKey: canonical ? target : `chatgpt:new:root:${documentInstanceId}`,
    status: "paused", phase: CONFIRMATION, pauseReason: CONFIRMATION,
    lastErrorCode: CONFIRMATION, resumable: false, stateRevision: 7,
    workflow: { schemaVersion: 1, id: "confirmation", name: "Synthetic confirmation", maxSends: 3,
      steps: [{ id: "first", type: "prompt", delivery: "send", prompt: "SYNTHETIC INPUT", repeat: 3, delayAfterMs: 0 }] },
    plannedSends: 3,
    outbox: { id: `attempt-${tabId}`, state: "submitted", stepId: "first",
      position: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 },
      promptHash: hash("SYNTHETIC INPUT"), submittedAt: "2026-10-22T00:00:00.000Z" }
  });
  const sender = { tab: { id: tabId }, frameId: 0, documentId, documentLifecycle: "active" };
  h.setTabs([{ id: tabId, url: `https://chatgpt.com/c/confirmation-${tabId}`, active: true }]);
  h.setDocument(tabId, { documentId, documentInstanceId });
  h.putRun(tabId, structuredClone(run));
  h.setStatusResponder(tabId, () => ({ ...h.defaultStatus(tabId), conversationKey: target }));
  return { tabId, documentId, documentInstanceId, target, run, sender };
}

function request(f, overrides = {}) {
  return {
    type: "AIPM_RUN_CONFIRM_NEW_CHAT_TARGET", expectedRunId: f.run.runId,
    expectedStateRevision: h.storedRun(f.tabId)?.stateRevision,
    conversationKey: f.target, documentInstanceId: f.documentInstanceId,
    executionSessionId: h.sessionId(), serviceWorkerVersion: CURRENT_EXTENSION_VERSION, ...overrides
  };
}
function noMutationSnapshot() {
  const before = JSON.stringify(h.storageData);
  let writes = 0;
  h.setStorageSetFault(() => { writes += 1; });
  return () => {
    h.setStorageSetFault(null);
    assert.equal(writes, 0, "rejection/idempotent return must perform no storage writes");
    assert.equal(JSON.stringify(h.storageData) === before, true, "all durable data must remain unchanged");
  };
}
async function confirm(f, overrides, sender = f.sender) {
  return h.invoke(request(f, overrides), sender);
}
function successor(run) {
  return { ...structuredClone(run), status: "running", phase: "ready", pauseReason: null,
    resumable: true, outbox: null, lastErrorCode: null, lastErrorMessage: null,
    cursor: { stepIndex: 0, repeatIndex: 1, sendsCompleted: 1 } };
}
async function saveResume(f, run) {
  return h.invoke({ type: "AIPM_RUN_SET", run, runTransition: "resume",
    conversationKey: f.target, documentInstanceId: f.documentInstanceId }, f.sender);
}

test("first explicit confirmation adopts canonical target once without counting the submitted send", async () => {
  const f = fixture();
  const response = await confirm(f);
  assert.equal(response.ok, true);
  assert.equal(response.run.conversationKey, f.target);
  assert.equal(response.run.stateRevision, 8);
  assert.equal(response.run.outbox.state, "submitted");
  assert.deepEqual(response.run.cursor, f.run.cursor);
  assert.equal(h.commandsDelivered(f.tabId).length, 0);
});

test("initial explicit adoption still permits the freshly verified document after reload", async () => {
  const f = fixture();
  h.putRun(f.tabId, { ...f.run, boundDocumentId: "previous-document", documentInstanceId: "previous-instance" });
  const response = await confirm(f);
  assert.equal(response.ok, true);
  assert.equal(response.run.boundDocumentId, f.documentId);
  assert.equal(response.run.documentInstanceId, f.documentInstanceId);
});

test("same-canonical explicit retry returns the exact checkpoint without any write or revision increment", async () => {
  const f = fixture({ canonical: true });
  const untouched = noMutationSnapshot();
  const response = await confirm(f);
  assert.equal(response.ok, true);
  assert.equal(JSON.stringify(response.run) === JSON.stringify(f.run), true);
  untouched();
  assert.equal(h.commandsDelivered(f.tabId).length, 0);
});

const invalidStates = [
  ["wrong phase", run => { run.phase = "ambiguous"; }],
  ["wrong reason", run => { run.pauseReason = "user-pause"; }],
  ["running state", run => { run.status = "running"; }],
  ["stopped state", run => { run.status = "stopped"; }],
  ["missing outbox", run => { run.outbox = null; }],
  ["empty outbox id", run => { run.outbox.id = ""; }],
  ["prepared outbox", run => { run.outbox.state = "prepared"; }],
  ["confirmed outbox", run => { run.outbox.state = "confirmed"; }],
  ["missing outbox position", run => { delete run.outbox.position; }],
  ["different step position", run => { run.outbox.position.stepIndex = 1; }],
  ["different repeat position", run => { run.outbox.position.repeatIndex = 1; }],
  ["different send count", run => { run.outbox.position.sendsCompleted = 1; }],
  ["different step id", run => { run.outbox.stepId = "different"; }],
  ["different input hash", run => { run.outbox.promptHash = hash("DIFFERENT SYNTHETIC INPUT"); }],
  ["missing input hash", run => { delete run.outbox.promptHash; }],
  ["invalid cursor index", run => { run.cursor.repeatIndex = -1; run.outbox.position.repeatIndex = -1; }],
  ["draft step", run => { run.workflow.steps[0].delivery = "draft"; }],
  ["wrong stored session", run => { run.executionSessionId = "previous-session"; }],
  ["wrong bound tab", run => { run.boundTabId += 1; }]
];
for (const [label, mutate] of invalidStates) {
  test(`confirmation rejects ${label} without changing durable state`, async () => {
    const f = fixture();
    const malformed = structuredClone(f.run);
    mutate(malformed);
    h.putRun(f.tabId, malformed);
    const untouched = noMutationSnapshot();
    assert.equal((await confirm(f)).ok, false);
    untouched();
  });
}

for (const [label, overrides] of [
  ["stale revision", { expectedStateRevision: 6 }],
  ["missing revision", { expectedStateRevision: undefined }],
  ["wrong request session", { executionSessionId: "previous-session" }],
  ["malformed canonical target", { conversationKey: "chatgpt:c:invalid/path" }]
]) {
  test(`confirmation rejects ${label}`, async () => {
    const f = fixture();
    const untouched = noMutationSnapshot();
    assert.equal((await confirm(f, overrides)).ok, false);
    untouched();
  });
}

for (const [label, mutate, overrides] of [
  ["different canonical conversation", () => {}, { conversationKey: "chatgpt:c:another" }],
  ["different bound document", run => { run.boundDocumentId = "previous-document"; }, {}],
  ["different bound instance", run => { run.documentInstanceId = "previous-instance"; }, {}]
]) {
  test(`same-canonical retry rejects ${label}`, async () => {
    const f = fixture({ canonical: true });
    const changed = structuredClone(f.run);
    mutate(changed);
    h.putRun(f.tabId, changed);
    const untouched = noMutationSnapshot();
    assert.equal((await confirm(f, overrides)).ok, false);
    untouched();
  });
}

test("concurrent first confirmations reject the stale revision after one adoption", async () => {
  const f = fixture();
  const message = request(f);
  const responses = await Promise.all([h.invoke(message, f.sender), h.invoke(message, f.sender)]);
  assert.equal(responses.filter(response => response.ok).length, 1);
  assert.equal(h.storedRun(f.tabId).stateRevision, 8);
  assert.equal(h.storedRun(f.tabId).cursor.sendsCompleted, 0);
});

test("concurrent canonical retries are read-only and only one progress save commits", async () => {
  const f = fixture({ canonical: true });
  const untouched = noMutationSnapshot();
  const confirmations = await Promise.all([confirm(f), confirm(f)]);
  assert.equal(confirmations.every(response => response.ok), true);
  untouched();
  const results = await Promise.all(confirmations.map(response => saveResume(f, successor(response.run))));
  assert.equal(results.filter(response => response.ok).length, 1);
  assert.equal(h.storedRun(f.tabId).stateRevision, 8);
  assert.equal(h.storedRun(f.tabId).cursor.sendsCompleted, 1);
  assert.equal(h.storedRun(f.tabId).outbox, null);
});

for (const committed of [false, true]) {
  test(`confirmation storage failure ${committed ? "after" : "before"} commit permits a fresh explicit retry`, async () => {
    const f = fixture();
    h.setStorageSetFault(values => {
      h.setStorageSetFault(null);
      if (committed) Object.assign(h.storageData, structuredClone(values));
      throw new Error("Synthetic confirmation storage response failure");
    });
    assert.equal((await confirm(f)).ok, false);
    assert.equal(h.storedRun(f.tabId).stateRevision, committed ? 8 : 7);
    assert.equal(h.storedRun(f.tabId).cursor.sendsCompleted, 0);
    const response = await confirm(f);
    assert.equal(response.ok, true);
    assert.equal(response.run.stateRevision, 8);
    assert.equal(response.run.outbox.state, "submitted");
  });
}

test("Stop committed while document confirmation is pending prevents adoption", async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  h.setIdentityPlan(f.tabId, [async () => {
    entered.resolve(); await release.promise;
    return { documentId: f.documentId, documentInstanceId: f.documentInstanceId };
  }]);
  const pending = confirm(f);
  await entered.promise;
  const stopCommitted = deferred();
  h.setStorageSetFault(values => {
    if (values[activeRunKey(f.tabId)]?.status === "stopped") stopCommitted.resolve();
  });
  const stopping = h.relay({ type: "AIPM_STOP", expectedRunId: f.run.runId }, f.tabId);
  try {
    await stopCommitted.promise;
    release.resolve();
    assert.equal((await pending).ok, false);
    assert.equal((await stopping).ok, true);
    assert.equal(h.storedRun(f.tabId).status, "stopped");
    assert.equal(h.storedRun(f.tabId).cursor.sendsCompleted, 0);
    assert.equal(h.storedRun(f.tabId).conversationKey, f.run.conversationKey);
  } finally { release.resolve(); h.setStorageSetFault(null); }
});

test("a changed current document rejects confirmation without changing the pending Run", async () => {
  const f = fixture();
  h.setDocument(f.tabId, { documentId: "replacement-document", documentInstanceId: "replacement-instance" });
  const untouched = noMutationSnapshot();
  assert.equal((await confirm(f)).ok, false);
  untouched();
});

test("a new execution session invalidates confirmation waiting on a document probe", async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  h.setIdentityPlan(f.tabId, [async () => {
    entered.resolve(); await release.promise;
    return { documentId: f.documentId, documentInstanceId: f.documentInstanceId };
  }]);
  const pending = confirm(f);
  try {
    await entered.promise;
    await h.triggerStartup();
    release.resolve();
    assert.equal((await pending).ok, false);
    assert.equal(h.storedRun(f.tabId), null, "session lifecycle owns removal; stale confirmation must not recreate it");
    assert.notEqual(h.sessionId(), f.run.executionSessionId);
  } finally { release.resolve(); }
});

// Gate the real async hash boundary inside the production serialized handler.
// Other test files have separate Node processes; always restore the method here.
async function digestBoundary(operation) {
  const original = crypto.subtle.digest;
  const entered = deferred();
  const release = deferred();
  crypto.subtle.digest = async function (...args) {
    entered.resolve(); await release.promise;
    return original.apply(this, args);
  };
  try { await operation({ entered: entered.promise, release: release.resolve }); }
  finally { release.resolve(); crypto.subtle.digest = original; }
}

for (const canonical of [false, true]) {
  test(`${canonical ? "canonical retry" : "initial adoption"} rejects document authority invalidated during hash verification`, async () => {
    const f = fixture({ canonical });
    await digestBoundary(async gate => {
      const pending = confirm(f);
      await gate.entered;
      await h.triggerTabLoading(f.tabId);
      const untouched = noMutationSnapshot();
      gate.release();
      assert.equal((await pending).ok, false);
      untouched();
    });
  });
}

test("Stop requested during serialized hash verification prevents adoption before Stop commits", async () => {
  const f = fixture();
  await digestBoundary(async gate => {
    const pending = confirm(f);
    await gate.entered;
    const stopping = h.relay({ type: "AIPM_STOP", expectedRunId: f.run.runId }, f.tabId);
    // Drain the already-resolved relay preflight promises. Stop marks its intent
    // before queuing behind confirmation, whose hash await is still held.
    await flushAsync();
    assert.equal(h.storedRun(f.tabId).status, "paused");
    gate.release();
    assert.equal((await pending).ok, false);
    assert.equal((await stopping).ok, true);
    assert.equal(h.storedRun(f.tabId).status, "stopped");
    assert.equal(h.storedRun(f.tabId).conversationKey, f.run.conversationKey);
    assert.equal(h.storedRun(f.tabId).cursor.sendsCompleted, 0);
  });
});
