import assert from "node:assert/strict";
import test from "node:test";

import { activeRunKey, deferred, installBackgroundHarness, makeRun } from "./helpers/background-harness.mjs";

let nextTabId = 35_000;

function setup(harness) {
  const tabId = ++nextTabId;
  const documentId = `post-confirmed-document-${tabId}`;
  const documentInstanceId = `post-confirmed-instance-${tabId}`;
  const conversationKey = `chatgpt:c:post-confirmed-${tabId}`;
  const base = makeRun();
  const run = makeRun({
    runId: `post-confirmed-run-${tabId}`,
    boundTabId: tabId,
    boundDocumentId: documentId,
    documentInstanceId,
    conversationKey,
    executionSessionId: harness.sessionId(),
    phase: "waiting-generation",
    plannedSends: 20,
    workflow: { ...base.workflow, maxSends: 20, steps: [{ ...base.workflow.steps[0], repeat: 20 }] },
    cursor: { stepIndex: 0, repeatIndex: 8, sendsCompleted: 9 },
    outbox: { state: "confirmed", stepId: "p1", repeatIndex: 8 }
  });
  harness.setTabs([{ id: tabId, active: true, windowId: 1, url: `https://chatgpt.com/c/post-confirmed-${tabId}` }]);
  harness.setDocument(tabId, { documentId, documentInstanceId });
  harness.putRun(tabId, run);
  return {
    tabId, documentId, documentInstanceId, conversationKey, run,
    sender: { tab: { id: tabId }, frameId: 0, documentId, documentLifecycle: "active" },
    message: {
      type: "AIPM_RUN_GET", conversationKey, documentInstanceId,
      readOnlyObservation: true, authorityBoundary: "readiness"
    }
  };
}

function assertNinthStillConfirmed(harness, fixture) {
  const stored = harness.storedRun(fixture.tabId);
  assert.equal(stored.cursor.sendsCompleted, 9);
  assert.equal(stored.outbox.state, "confirmed");
  assert.equal(harness.commandsDelivered(fixture.tabId).length, 0);
}

test("post-confirmed identity: title/URL-fragment observations and repeated same-document reads do not invalidate authority", async () => {
  const harness = await installBackgroundHarness();
  const fixture = setup(harness);
  const initial = await harness.invoke(fixture.message, fixture.sender);
  assert.equal(initial.ok, true);
  assert.equal(initial.identityObservation.source, "probe");
  harness.setIdentityPlan(fixture.tabId, [{ error: new Error("renderer observation unavailable") }]);

  for (const listener of harness.listeners.tabUpdated) {
    await listener(fixture.tabId, { title: "Synthetic changed title" });
    await listener(fixture.tabId, { url: `https://chatgpt.com/c/post-confirmed-${fixture.tabId}#detail` });
  }
  for (let observation = 9; observation <= 20; observation += 1) {
    const response = await harness.invoke(fixture.message, fixture.sender);
    assert.equal(response.ok, true, `observation ${observation}`);
    assert.equal(response.identityObservation.outcome, "match");
    assert.equal(response.identityObservation.source, "document-lifetime-grant");
    assert.equal(response.run.outbox.state, "confirmed");
  }
  assert.equal(harness.identityProbeCount(fixture.tabId), 1);
  assertNinthStillConfirmed(harness, fixture);
});

test("post-confirmed identity: inactive sender produces an immediate unconfirmed observation, not a proven document mismatch", async () => {
  const harness = await installBackgroundHarness();
  const fixture = setup(harness);
  const response = await harness.invoke(fixture.message, { ...fixture.sender, documentLifecycle: "cached" });
  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.equal(response.identityObservation.attempt, 1);
  assert.equal(response.identityObservation.totalAttempts, 1);
  assert.equal(response.identityObservation.reason, "document-lifecycle-changed");
  assert.equal(response.identityObservation.failureCode, "IDENTITY_LIFECYCLE_INVALIDATED");
  assert.equal(response.identityObservation.episodeId, "content-sender-invalid");
  assert.equal(response.identityObservation.source, "document-lifetime-grant");
  assert.equal(harness.identityProbeCount(fixture.tabId), 0);
  assert.equal(harness.storedRun(fixture.tabId).status, "paused");
  assertNinthStillConfirmed(harness, fixture);
});

test("post-confirmed identity: lifecycle change during a granted read is a distinct unconfirmed path with no resend", async () => {
  const harness = await installBackgroundHarness();
  const fixture = setup(harness);
  assert.equal((await harness.invoke(fixture.message, fixture.sender)).ok, true);
  const blocked = deferred();
  const entered = deferred();
  harness.setStorageGetFault(async (key) => {
    if (key !== activeRunKey(fixture.tabId)) return;
    entered.resolve();
    await blocked.promise;
  });
  const reading = harness.invoke(fixture.message, fixture.sender);
  await entered.promise;
  await harness.triggerTabLoading(fixture.tabId);
  blocked.resolve();
  const response = await reading;
  harness.setStorageGetFault(null);
  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.equal(response.identityObservation.attempt, 1);
  assert.equal(response.identityObservation.totalAttempts, 1);
  assert.equal(response.identityObservation.reason, "document-lifecycle-changed");
  assert.equal(response.identityObservation.failureCode, "IDENTITY_LIFECYCLE_INVALIDATED");
  assert.equal(response.identityObservation.episodeId, "document-lifetime-grant");
  assert.equal(response.identityObservation.source, "document-lifetime-grant");
  assertNinthStillConfirmed(harness, fixture);
});

test("post-confirmed identity: a positive replacement-document observation remains terminal with the ninth send confirmed", async () => {
  const harness = await installBackgroundHarness();
  const fixture = setup(harness);
  harness.setDocument(fixture.tabId, {
    documentId: `${fixture.documentId}-replacement`,
    documentInstanceId: `${fixture.documentInstanceId}-replacement`
  });
  const response = await harness.invoke(fixture.message, fixture.sender);
  assert.equal(response.staleDocument, true);
  assert.equal(response.identityObservation.outcome, "mismatch");
  assert.equal(response.identityObservation.source, "probe");
  assert.equal(harness.storedRun(fixture.tabId).status, "paused");
  assert.equal(harness.storedRun(fixture.tabId).pauseReason, "document_identity_mismatch");
  assert.equal(harness.storedRun(fixture.tabId).resumable, false);
  assertNinthStillConfirmed(harness, fixture);
});
