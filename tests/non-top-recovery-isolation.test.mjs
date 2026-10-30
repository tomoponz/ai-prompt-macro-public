import assert from "node:assert/strict";
import test from "node:test";

import { EXTENSION_VERSION, installBackgroundHarness, makeRun } from "./helpers/background-harness.mjs";

let nextTabId = 36_000;
function setup(harness) {
  const tabId = ++nextTabId;
  const documentId = `top-recovery-document-${tabId}`;
  const documentInstanceId = `top-recovery-instance-${tabId}`;
  const conversationKey = `chatgpt:c:top-recovery-${tabId}`;
  const run = makeRun({
    runId: `top-recovery-run-${tabId}`,
    boundTabId: tabId, boundDocumentId: documentId, documentInstanceId, conversationKey,
    executionSessionId: harness.sessionId(), phase: "waiting-generation", plannedSends: 20,
    cursor: { stepIndex: 0, repeatIndex: 8, sendsCompleted: 8 },
    outbox: { state: "confirmed", position: { stepIndex: 0, repeatIndex: 8, sendsCompleted: 8 } }
  });
  harness.setTabs([{ id: tabId, active: true, windowId: 1, url: `https://chatgpt.com/c/top-recovery-${tabId}` }]);
  harness.setDocument(tabId, { documentId, documentInstanceId });
  harness.putRun(tabId, run);
  return {
    tabId, documentId, documentInstanceId, conversationKey, run,
    sender: { tab: { id: tabId }, frameId: 0, documentId, documentLifecycle: "active" },
    get: { type: "AIPM_RUN_GET", conversationKey, documentInstanceId, authorityBoundary: "recovery" },
    failClosed: {
      type: "AIPM_RUN_FAIL_CLOSED", expectedRunId: run.runId,
      reason: "document_identity_unconfirmed", serviceWorkerVersion: EXTENSION_VERSION
    }
  };
}

function subframe(fixture) {
  return { ...fixture.sender, frameId: 7, documentId: `${fixture.documentId}-child` };
}

test("non-top recovery cannot obtain the top Run id and convert its refusal into a top Run safety stop", async () => {
  const harness = await installBackgroundHarness();
  const fixture = setup(harness);
  const before = structuredClone(harness.storageData);
  let writes = 0;
  let reads = 0;
  harness.setStorageSetFault(() => { writes += 1; });
  harness.setStorageGetFault(() => { reads += 1; });
  const refused = await harness.invoke(fixture.get, subframe(fixture));
  // This is the existing content recovery algorithm: only a returned Run id
  // authorizes it to request a durable safety stop after an identity failure.
  if (typeof refused.runId === "string") {
    await harness.invoke({ ...fixture.failClosed, expectedRunId: refused.runId }, subframe(fixture));
  }
  assert.equal(refused.ok, false);
  assert.equal(refused.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.equal(refused.identityObservation.reason, "top-frame-missing");
  assert.equal(refused.identityObservation.boundary, "recovery");
  assert.equal(refused.identityObservation.episodeId, "content-sender-invalid");
  assert.equal(refused.runId, undefined, "an unrelated subframe must not be given the current top Run id");
  assert.equal(refused.run, undefined);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.deepEqual(harness.storageData, before);
  assert.equal(harness.identityProbeCount(fixture.tabId), 0);
  assert.equal(harness.commandsDelivered(fixture.tabId).length, 0);
});

test("non-top direct fail-closed request cannot mutate a known top Run, with or without its id", async () => {
  const harness = await installBackgroundHarness();
  const fixture = setup(harness);
  const before = structuredClone(harness.storageData);
  let writes = 0;
  harness.setStorageSetFault(() => { writes += 1; });
  for (const expectedRunId of [fixture.run.runId, null]) {
    const response = await harness.invoke({ ...fixture.failClosed, expectedRunId }, subframe(fixture));
    assert.equal(response.ok, false);
    assert.equal(response.run, undefined);
    assert.equal(response.runId, undefined);
  }
  assert.equal(writes, 0);
  assert.deepEqual(harness.storageData, before);
});

test("top recovery still returns its Run and a genuine top-origin fail-closed request retains confirmed delivery", async () => {
  const harness = await installBackgroundHarness();
  const fixture = setup(harness);
  const loaded = await harness.invoke(fixture.get, fixture.sender);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.run.runId, fixture.run.runId);
  const stopped = await harness.invoke({ ...fixture.failClosed, failClosedGuard: loaded.failClosedGuard,
    documentInstanceId: fixture.documentInstanceId }, fixture.sender);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.run.status, "paused");
  assert.equal(stopped.run.resumable, false);
  assert.equal(stopped.run.cursor.sendsCompleted, 8);
  assert.equal(stopped.run.outbox.state, "confirmed");
  assert.equal(harness.commandsDelivered(fixture.tabId).length, 0);
});

test("missing frame metadata retains fresh-probe verification and cannot create a document grant", async () => {
  const harness = await installBackgroundHarness();
  const fixture = setup(harness);
  const { frameId, ...unknownFrame } = fixture.sender;
  const first = await harness.invoke(fixture.get, unknownFrame);
  assert.equal(first.ok, true);
  assert.equal(first.identityObservation.source, "probe");
  const second = await harness.invoke(fixture.get, unknownFrame);
  assert.equal(second.ok, true);
  assert.equal(second.identityObservation.source, "probe");
  assert.equal(harness.identityProbeCount(fixture.tabId), 2);
});

test("a panel caller without a tab cannot invoke a content-origin Run safety stop", async () => {
  const harness = await installBackgroundHarness();
  const fixture = setup(harness);
  const before = structuredClone(harness.storageData);
  const result = await harness.invoke(fixture.failClosed, {});
  assert.equal(result.ok, false);
  assert.deepEqual(harness.storageData, before);
});

test("an old top actor's safety stop cannot affect a different Run generation in the same tab", async () => {
  const harness = await installBackgroundHarness();
  const fixture = setup(harness);
  const loaded = await harness.invoke(fixture.get, fixture.sender);
  const replacement = { ...fixture.run, runId: `${fixture.run.runId}-replacement` };
  harness.putRun(fixture.tabId, replacement);
  const result = await harness.invoke({ ...fixture.failClosed, failClosedGuard: loaded.failClosedGuard,
    documentInstanceId: fixture.documentInstanceId }, fixture.sender);
  assert.equal(result.staleRun, true);
  assert.equal(result.changed, false);
  assert.deepEqual(harness.storedRun(fixture.tabId), replacement);
});

test("non-top Run write and confirmation messages are rejected before any Run read or write", async () => {
  const harness = await installBackgroundHarness();
  const fixture = setup(harness);
  const before = structuredClone(harness.storageData);
  let reads = 0;
  let writes = 0;
  harness.setStorageGetFault(() => { reads += 1; });
  harness.setStorageSetFault(() => { writes += 1; });
  for (const type of ["AIPM_RUN_SET", "AIPM_RUN_NEW_CHAT_CONFIRM_REQUIRED", "AIPM_RUN_CONFIRM_NEW_CHAT_TARGET"]) {
    const response = await harness.invoke({
      ...fixture.get, ...fixture.failClosed, type, run: fixture.run,
      executionSessionId: fixture.run.executionSessionId
    }, subframe(fixture));
    assert.equal(response.ok, false, type);
    assert.equal(response.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED", type);
    assert.equal(response.identityObservation.reason, "top-frame-missing", type);
    assert.equal(response.runId, undefined, type);
    assert.equal(response.run, undefined, type);
  }
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.deepEqual(harness.storageData, before);
});

test("top sender with empty probe results remains a bounded probe failure and may stop its own Run", async () => {
  const harness = await installBackgroundHarness();
  const fixture = setup(harness);
  harness.setIdentityPlan(fixture.tabId, Array.from({ length: 12 }, () => ({ empty: true })));
  const response = await harness.invoke(fixture.get, fixture.sender);
  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.equal(response.identityObservation.reason, "top-frame-missing");
  assert.equal(response.identityObservation.source, "probe");
  assert.notEqual(response.identityObservation.episodeId, "content-sender-invalid");
  assert.ok(response.identityObservation.attempt > 1);
  assert.ok(response.identityObservation.totalAttempts > 1);
  assert.equal(response.runId, fixture.run.runId);
  const stopped = await harness.invoke({ ...fixture.failClosed, failClosedGuard: response.failClosedGuard,
    documentInstanceId: fixture.documentInstanceId }, fixture.sender);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.run.status, "paused");
  assert.equal(stopped.run.outbox.state, "confirmed");
  assert.equal(stopped.run.cursor.sendsCompleted, 8);
  assert.equal(harness.commandsDelivered(fixture.tabId).length, 0);
});

