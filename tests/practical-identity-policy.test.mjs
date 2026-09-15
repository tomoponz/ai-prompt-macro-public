import assert from "node:assert/strict";
import test from "node:test";

import {
  deferred,
  installBackgroundHarness,
  makeRun
} from "./helpers/background-harness.mjs";

let nextTabId = 30_000;

function setup(harness) {
  const tabId = ++nextTabId;
  const documentId = `practical-document-${tabId}`;
  const documentInstanceId = `practical-instance-${tabId}`;
  const conversationKey = `chatgpt:c:practical-${tabId}`;
  const run = makeRun({
    runId: `practical-run-${tabId}`,
    boundTabId: tabId,
    boundDocumentId: documentId,
    documentInstanceId,
    conversationKey,
    executionSessionId: harness.sessionId()
  });
  const sender = {
    tab: { id: tabId },
    frameId: 0,
    documentId,
    documentLifecycle: "active"
  };
  harness.setTabs([{ id: tabId, active: true, windowId: 1, url: "https://chatgpt.com/" }]);
  harness.setDocument(tabId, { documentId, documentInstanceId });
  harness.putRun(tabId, run);
  return { tabId, documentId, documentInstanceId, conversationKey, run, sender };
}

function getRunMessage(fixture) {
  return {
    type: "AIPM_RUN_GET",
    conversationKey: fixture.conversationKey,
    documentInstanceId: fixture.documentInstanceId,
    readOnlyObservation: true,
    readOnlyRecovery: {
      mode: "safe",
      identityAttempts: 3,
      readiness: "normal",
      statusRecovery: "normal"
    },
    authorityBoundary: "readiness"
  };
}

function exhaustIdentityPlan() {
  return Array.from({ length: 12 }, () => ({
    error: new Error("temporary renderer admission failure")
  }));
}

test("ID1: renderer probe exhaustion recovers only from an exact active bound sender", async () => {
  const harness = await installBackgroundHarness();
  const fixture = setup(harness);
  harness.setIdentityPlan(fixture.tabId, exhaustIdentityPlan());

  const response = await harness.invoke(getRunMessage(fixture), fixture.sender);

  assert.equal(response.ok, true);
  assert.equal(response.run?.runId, fixture.run.runId);
  assert.equal(response.identityObservation?.outcome, "match");
  assert.equal(response.identityObservation?.source, "bound-content-sender");
  assert.equal(response.identityObservation?.reason, "execute-script-rejected");
  assert.equal(harness.storedRun(fixture.tabId)?.status, "running");
  assert.equal(harness.commandsDelivered(fixture.tabId).length, 0);
});

test("ID2: a temporary unavailable observation that later matches uses probe recovery", async () => {
  const harness = await installBackgroundHarness();
  const fixture = setup(harness);
  harness.setIdentityPlan(fixture.tabId, [
    { error: new Error("temporary identity observation unavailable") },
    { documentId: fixture.documentId, documentInstanceId: fixture.documentInstanceId }
  ]);

  const response = await harness.invoke(getRunMessage(fixture), fixture.sender);

  assert.equal(response.ok, true);
  assert.equal(response.run?.runId, fixture.run.runId);
  assert.equal(response.identityObservation?.outcome, "match");
  assert.equal(response.identityObservation?.source, "probe");
  assert.ok(response.identityObservation?.consecutiveUnavailable >= 1);
});

test("ID3: a positive document mismatch remains terminal and cannot use sender recovery", async () => {
  const harness = await installBackgroundHarness();
  const fixture = setup(harness);
  harness.setIdentityPlan(fixture.tabId, [{
    documentId: `${fixture.documentId}-replaced`,
    documentInstanceId: `${fixture.documentInstanceId}-replaced`
  }]);

  const response = await harness.invoke(getRunMessage(fixture), fixture.sender);

  assert.equal(response.identityObservation?.outcome, "mismatch");
  assert.notEqual(response.identityObservation?.source, "bound-content-sender");
  assert.equal(harness.storedRun(fixture.tabId)?.status, "paused");
  assert.equal(harness.storedRun(fixture.tabId)?.resumable, false);
  assert.equal(harness.storedRun(fixture.tabId)?.pauseReason, "document_identity_mismatch");
});

test("ID5: a temporary Service Worker storage delay preserves the same healthy Run", async () => {
  const harness = await installBackgroundHarness();
  const fixture = setup(harness);
  let delayed = false;
  harness.setStorageGetFault(async () => {
    if (delayed) return;
    delayed = true;
    await new Promise((resolve) => setTimeout(resolve, 120));
  });

  const response = await harness.invoke(getRunMessage(fixture), fixture.sender);
  harness.setStorageGetFault(null);

  assert.equal(delayed, true);
  assert.equal(response.ok, true);
  assert.equal(response.run?.runId, fixture.run.runId);
  assert.equal(harness.storedRun(fixture.tabId)?.status, "running");
});

test("ID6: bound-content-sender recovery rejects a wrong durable tab binding", async () => {
  const harness = await installBackgroundHarness();
  const fixture = setup(harness);
  fixture.run.boundTabId = fixture.tabId + 1;
  harness.putRun(fixture.tabId, fixture.run);
  harness.setIdentityPlan(fixture.tabId, exhaustIdentityPlan());

  const response = await harness.invoke(getRunMessage(fixture), fixture.sender);

  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.notEqual(response.identityObservation?.source, "bound-content-sender");
  assert.equal(harness.storedRun(fixture.tabId)?.status, "running");
});

test("ID7: bound-content-sender recovery rejects a wrong browser document ID", async () => {
  const harness = await installBackgroundHarness();
  const fixture = setup(harness);
  harness.setIdentityPlan(fixture.tabId, exhaustIdentityPlan());

  const response = await harness.invoke(getRunMessage(fixture), {
    ...fixture.sender,
    documentId: `${fixture.documentId}-wrong`
  });

  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.notEqual(response.identityObservation?.source, "bound-content-sender");
  assert.equal(harness.storedRun(fixture.tabId)?.status, "running");
});

for (const [caseId, senderChange, expectedReason] of [
  ["ID8", { frameId: 1 }, "top-frame-missing"],
  ["ID9", { documentLifecycle: "prerender" }, "document-lifecycle-changed"]
]) {
  test(`${caseId}: bound-content-sender recovery rejects invalid browser sender authority`, async () => {
    const harness = await installBackgroundHarness();
    const fixture = setup(harness);

    const response = await harness.invoke(getRunMessage(fixture), {
      ...fixture.sender,
      ...senderChange
    });

    assert.equal(response.ok, false);
    assert.equal(response.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
    assert.equal(response.identityObservation?.reason, expectedReason);
    assert.notEqual(response.identityObservation?.source, "bound-content-sender");
  });
}

test("ID10: a changed execution-session binding cannot use sender recovery", async () => {
  const harness = await installBackgroundHarness();
  const fixture = setup(harness);
  fixture.run.executionSessionId = `${harness.sessionId()}-stale`;
  harness.putRun(fixture.tabId, fixture.run);

  const response = await harness.invoke(getRunMessage(fixture), fixture.sender);

  assert.equal(response.ok, true);
  assert.equal(response.run, null);
  assert.equal(response.quarantined, true);
  assert.equal(response.quarantineReason, "stale-browser-session");
  assert.notEqual(response.identityObservation?.source, "bound-content-sender");
});

test("ID11: a document-authority generation change during a probe cancels sender recovery", async () => {
  const harness = await installBackgroundHarness();
  const fixture = setup(harness);
  const started = deferred();
  const release = deferred();
  harness.setIdentityPlan(fixture.tabId, [async () => {
    started.resolve();
    return release.promise;
  }]);

  const pending = harness.invoke(getRunMessage(fixture), fixture.sender);
  await started.promise;
  await harness.triggerTabLoading(fixture.tabId);
  release.resolve({ error: new Error("late old-document probe") });
  const response = await pending;

  assert.equal(response.ok, false);
  assert.equal(response.identityObservation?.reason, "document-lifecycle-changed");
  assert.notEqual(response.identityObservation?.source, "bound-content-sender");
  assert.equal(harness.storedRun(fixture.tabId)?.resumable, false);
});

test("ID12: an execution-session generation change during a probe cancels sender recovery", async () => {
  const harness = await installBackgroundHarness();
  const fixture = setup(harness);
  const started = deferred();
  const release = deferred();
  harness.setIdentityPlan(fixture.tabId, [async () => {
    started.resolve();
    return release.promise;
  }]);

  const pending = harness.invoke(getRunMessage(fixture), fixture.sender);
  await started.promise;
  await harness.triggerStartup();
  release.resolve({ error: new Error("late old-session probe") });
  const response = await pending;

  assert.equal(response.ok, false);
  assert.equal(response.identityObservation?.reason, "execution-session-changed");
  assert.notEqual(response.identityObservation?.source, "bound-content-sender");
});
