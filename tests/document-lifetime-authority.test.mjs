import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SESSION_ID,
  EXTENSION_VERSION,
  activeRunKey,
  deferred,
  installBackgroundHarness,
  makeRun
} from "./helpers/background-harness.mjs";

const harness = await installBackgroundHarness();
let nextTabId = 24_000;

function setupTab(targetHarness = harness, overrides = {}) {
  const tabId = Number.isInteger(overrides.tabId) ? overrides.tabId : ++nextTabId;
  const documentId = overrides.documentId ?? `grant-document-${tabId}`;
  const documentInstanceId = overrides.documentInstanceId ?? `grant-instance-${tabId}`;
  const conversationKey = overrides.conversationKey ?? `chatgpt:c:grant-${tabId}`;
  const base = makeRun();
  const run = makeRun({
    runId: overrides.runId ?? `grant-run-${tabId}`,
    boundTabId: tabId,
    boundDocumentId: documentId,
    documentInstanceId,
    conversationKey,
    executionSessionId: targetHarness.sessionId(),
    workflow: {
      ...base.workflow,
      recovery: {
        mode: "safe",
        identityAttempts: 3,
        readiness: "normal",
        statusRecovery: "normal"
      }
    }
  });
  targetHarness.setTabs([{ id: tabId, active: true, windowId: 1, url: "https://chatgpt.com/" }]);
  targetHarness.setDocument(tabId, { documentId, documentInstanceId });
  targetHarness.putRun(tabId, run);
  return {
    tabId,
    documentId,
    documentInstanceId,
    conversationKey,
    run,
    sender: {
      tab: { id: tabId },
      frameId: 0,
      documentId,
      documentLifecycle: "active"
    }
  };
}

function runGet(fixture, overrides = {}) {
  return {
    type: "AIPM_RUN_GET",
    conversationKey: fixture.conversationKey,
    documentInstanceId: fixture.documentInstanceId,
    ...overrides
  };
}

function runSet(fixture, run, overrides = {}) {
  return {
    type: "AIPM_RUN_SET",
    run,
    conversationKey: fixture.conversationKey,
    documentInstanceId: fixture.documentInstanceId,
    runTransition: "runner",
    authorityBoundary: "run-save",
    ...overrides
  };
}

function leaseMessage(fixture, type, overrides = {}) {
  return {
    type,
    conversationKey: fixture.conversationKey,
    runId: fixture.run.runId,
    documentInstanceId: fixture.documentInstanceId,
    serviceWorkerVersion: EXTENSION_VERSION,
    executionSessionId: fixture.run.executionSessionId,
    ...overrides
  };
}

test("document grant 1: one fresh proof covers steady-state Run and Lease boundaries", async () => {
  const fixture = setupTab();

  const first = await harness.invoke(runGet(fixture), fixture.sender);
  assert.equal(first.ok, true);
  assert.equal(first.identityObservation?.source, "probe");
  assert.equal(harness.identityProbeCount(fixture.tabId), 1);

  const saved = await harness.invoke(runSet(fixture, {
    ...first.run,
    phase: "prepared"
  }), fixture.sender);
  assert.equal(saved.ok, true);
  assert.equal(saved.identityObservation?.source, "document-lifetime-grant");

  const acquired = await harness.invoke(leaseMessage(fixture, "AIPM_LEASE_ACQUIRE"), fixture.sender);
  assert.equal(acquired.ok, true);
  assert.equal(typeof acquired.lease?.nonce, "string");
  assert.equal(acquired.identityObservation?.source, "document-lifetime-grant");

  const renewed = await harness.invoke(leaseMessage(fixture, "AIPM_LEASE_RENEW", {
    nonce: acquired.lease.nonce
  }), fixture.sender);
  assert.equal(renewed.ok, true);
  assert.equal(renewed.renewed, true);
  assert.equal(renewed.identityObservation?.source, "document-lifetime-grant");

  const observed = await harness.invoke(runGet(fixture, {
    readOnlyObservation: true,
    authorityBoundary: "periodic-observation"
  }), fixture.sender);
  assert.equal(observed.ok, true);
  assert.equal(observed.identityObservation?.source, "document-lifetime-grant");

  const released = await harness.invoke(leaseMessage(fixture, "AIPM_LEASE_RELEASE", {
    nonce: acquired.lease.nonce
  }), fixture.sender);
  assert.equal(released.ok, true);
  assert.equal(released.released, true);
  assert.equal(released.identityObservation?.source, "document-lifetime-grant");

  assert.equal(
    harness.identityProbeCount(fixture.tabId),
    1,
    "the content document must not re-enter its renderer for each Run/Lease checkpoint"
  );
  assert.equal(harness.commandsDelivered(fixture.tabId).length, 0);
});

test("document grant 2: periodic discovery cannot establish later mutation authority", async () => {
  const fixture = setupTab();

  const periodic = await harness.invoke(runGet(fixture, {
    readOnlyObservation: true,
    authorityBoundary: "periodic-observation"
  }), fixture.sender);
  assert.equal(periodic.ok, true);
  assert.equal(periodic.identityObservation?.source, "probe");
  assert.equal(harness.identityProbeCount(fixture.tabId), 1);

  const freshMutation = await harness.invoke(runSet(fixture, {
    ...periodic.run,
    phase: "prepared"
  }), fixture.sender);
  assert.equal(freshMutation.ok, true);
  assert.equal(freshMutation.identityObservation?.source, "probe");
  assert.equal(harness.identityProbeCount(fixture.tabId), 2);

  const nextMutation = await harness.invoke(runSet(fixture, {
    ...freshMutation.run,
    phase: "submitting"
  }), fixture.sender);
  assert.equal(nextMutation.ok, true);
  assert.equal(nextMutation.identityObservation?.source, "document-lifetime-grant");
  assert.equal(harness.identityProbeCount(fixture.tabId), 2);
});

test("document grant 3: navigation invalidates authority and a stale document cannot mutate", async () => {
  const fixture = setupTab();
  const first = await harness.invoke(runGet(fixture), fixture.sender);
  assert.equal(first.ok, true);
  assert.equal(harness.identityProbeCount(fixture.tabId), 1);

  await harness.triggerTabLoading(fixture.tabId);
  harness.setDocument(fixture.tabId, {
    documentId: `${fixture.documentId}-replacement`,
    documentInstanceId: `${fixture.documentInstanceId}-replacement`
  });
  const storedBefore = structuredClone(harness.storedRun(fixture.tabId));
  const staleWrite = await harness.invoke(runSet(fixture, {
    ...first.run,
    phase: "submitting"
  }), fixture.sender);

  assert.equal(staleWrite.ok, false);
  assert.equal(staleWrite.errorCode, "DOCUMENT_IDENTITY_MISMATCH");
  assert.equal(staleWrite.identityObservation?.source, "probe");
  assert.equal(harness.identityProbeCount(fixture.tabId), 2);
  assert.deepEqual(harness.storedRun(fixture.tabId), storedBefore);
  assert.equal(harness.commandsDelivered(fixture.tabId).length, 0);
});

test("document grant 4: a new isolated-world instance re-proves and fences the old instance", async () => {
  const fixture = setupTab();
  const first = await harness.invoke(runGet(fixture), fixture.sender);
  assert.equal(first.ok, true);

  const nextInstanceId = `${fixture.documentInstanceId}-replacement`;
  harness.setDocument(fixture.tabId, {
    documentId: fixture.documentId,
    documentInstanceId: nextInstanceId
  });
  const nextFixture = {
    ...fixture,
    documentInstanceId: nextInstanceId
  };
  const rebound = await harness.invoke(runGet(nextFixture), nextFixture.sender);
  assert.equal(rebound.ok, true);
  assert.equal(rebound.run?.documentInstanceId, nextInstanceId);
  assert.equal(rebound.identityObservation?.source, "probe");
  assert.equal(harness.identityProbeCount(fixture.tabId), 2);

  const storedBefore = structuredClone(harness.storedRun(fixture.tabId));
  const staleInstanceWrite = await harness.invoke(runSet(fixture, {
    ...storedBefore,
    phase: "submitting"
  }), fixture.sender);
  assert.equal(staleInstanceWrite.ok, false);
  assert.equal(staleInstanceWrite.errorCode, "DOCUMENT_IDENTITY_MISMATCH");
  assert.equal(harness.identityProbeCount(fixture.tabId), 3);
  assert.deepEqual(harness.storedRun(fixture.tabId), storedBefore);
});

test("document grant 5: inactive or non-top senders receive no authority and start no probe", async () => {
  for (const [name, sender, reason] of [
    ["subframe", { frameId: 3, documentLifecycle: "active" }, "top-frame-missing"],
    ["cached", { frameId: 0, documentLifecycle: "cached" }, "document-lifecycle-changed"]
  ]) {
    const fixture = setupTab();
    const response = await harness.invoke(runSet(fixture, {
      ...fixture.run,
      phase: "prepared"
    }), { ...fixture.sender, ...sender });
    assert.equal(response.ok, false, name);
    assert.equal(response.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED", name);
    assert.equal(response.identityObservation?.reason, reason, name);
    assert.equal(response.identityObservation?.source, "document-lifetime-grant", name);
    assert.equal(harness.identityProbeCount(fixture.tabId), 0, name);
    assert.equal(harness.storedRun(fixture.tabId).phase, "ready", name);
  }
});

test("document grant 6: browser startup/session rotation clears the grant and rejects old Run state", async () => {
  const fixture = setupTab();
  const first = await harness.invoke(runGet(fixture), fixture.sender);
  assert.equal(first.ok, true);
  assert.equal(harness.identityProbeCount(fixture.tabId), 1);

  await harness.triggerStartup();
  assert.notEqual(harness.sessionId(), DEFAULT_SESSION_ID);
  const staleSessionWrite = await harness.invoke(runSet(fixture, {
    ...first.run,
    phase: "prepared"
  }), fixture.sender);
  assert.equal(staleSessionWrite.ok, false);
  assert.equal(harness.identityProbeCount(fixture.tabId), 1);

  const nextRun = makeRun({
    ...fixture.run,
    runId: `${fixture.run.runId}-new-session`,
    executionSessionId: harness.sessionId()
  });
  harness.putRun(fixture.tabId, nextRun);
  const reproved = await harness.invoke(runGet(fixture), fixture.sender);
  assert.equal(reproved.ok, true);
  assert.equal(reproved.run?.runId, nextRun.runId);
  assert.equal(reproved.identityObservation?.source, "probe");
  assert.equal(harness.identityProbeCount(fixture.tabId), 2);
});

test("document grant 7: tab close clears only that tab's authority", async () => {
  const fixture = setupTab();
  const first = await harness.invoke(runGet(fixture), fixture.sender);
  assert.equal(first.ok, true);
  assert.equal(harness.identityProbeCount(fixture.tabId), 1);

  await harness.triggerTabRemoved(fixture.tabId);
  harness.putRun(fixture.tabId, fixture.run);
  const reproved = await harness.invoke(runGet(fixture), fixture.sender);
  assert.equal(reproved.ok, true);
  assert.equal(reproved.identityObservation?.source, "probe");
  assert.equal(harness.identityProbeCount(fixture.tabId), 2);
});

test("document grant 8: grants remain isolated per tab even for identical document tuples", async () => {
  const shared = {
    documentId: "grant-shared-document",
    documentInstanceId: "grant-shared-instance"
  };
  const first = setupTab(harness, shared);
  const second = setupTab(harness, shared);

  assert.equal((await harness.invoke(runGet(first), first.sender)).ok, true);
  assert.equal(harness.identityProbeCount(first.tabId), 1);
  assert.equal(harness.identityProbeCount(second.tabId), 0);

  assert.equal((await harness.invoke(runGet(second), second.sender)).ok, true);
  assert.equal(harness.identityProbeCount(second.tabId), 1);

  await harness.triggerTabLoading(first.tabId);
  const secondAgain = await harness.invoke(runGet(second), second.sender);
  assert.equal(secondAgain.ok, true);
  assert.equal(secondAgain.identityObservation?.source, "document-lifetime-grant");
  assert.equal(harness.identityProbeCount(second.tabId), 1);
});

test("document grant 9: stale cached UI state is never accepted as document authority", async () => {
  const fixture = setupTab();
  harness.storageData["aipm.uiByTab.v2"] = {
    [fixture.tabId]: {
      documentId: "stale-ui-document",
      documentInstanceId: "stale-ui-instance",
      status: "ready"
    }
  };

  const response = await harness.invoke(runGet(fixture), fixture.sender);
  assert.equal(response.ok, true);
  assert.equal(response.identityObservation?.source, "probe");
  assert.equal(harness.identityProbeCount(fixture.tabId), 1);
});

test("document grant 10: navigation during an awaited Run write revokes the cached authority", async () => {
  const fixture = setupTab();
  const first = await harness.invoke(runGet(fixture), fixture.sender);
  assert.equal(first.ok, true);
  assert.equal(harness.identityProbeCount(fixture.tabId), 1);

  const blockedRead = deferred();
  let readBlocked = false;
  harness.setStorageGetFault(async (key) => {
    if (key !== activeRunKey(fixture.tabId) || readBlocked) return;
    readBlocked = true;
    await blockedRead.promise;
  });
  const pendingWrite = harness.invoke(runSet(fixture, {
    ...first.run,
    phase: "prepared"
  }), fixture.sender);
  while (!readBlocked) await new Promise((resolve) => setTimeout(resolve, 0));

  await harness.triggerTabLoading(fixture.tabId);
  blockedRead.resolve();
  const response = await pendingWrite;
  harness.setStorageGetFault(null);

  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.equal(response.identityObservation?.reason, "document-lifecycle-changed");
  assert.equal(response.identityObservation?.failureCode, "IDENTITY_LIFECYCLE_INVALIDATED");
  assert.equal(harness.storedRun(fixture.tabId).phase, "ready");
});

test("document grant 11: a fresh Service Worker process has no inherited grant", async () => {
  const firstHarness = await installBackgroundHarness();
  const firstFixture = setupTab(firstHarness, {
    documentId: "worker-restart-document",
    documentInstanceId: "worker-restart-instance"
  });
  const initial = await firstHarness.invoke(runGet(firstFixture), firstFixture.sender);
  assert.equal(initial.ok, true);
  assert.equal(firstHarness.identityProbeCount(firstFixture.tabId), 1);
  const reused = await firstHarness.invoke(runGet(firstFixture), firstFixture.sender);
  assert.equal(reused.identityObservation?.source, "document-lifetime-grant");
  assert.equal(firstHarness.identityProbeCount(firstFixture.tabId), 1);

  const restartedHarness = await installBackgroundHarness();
  const restartedFixture = setupTab(restartedHarness, {
    tabId: firstFixture.tabId,
    documentId: firstFixture.documentId,
    documentInstanceId: firstFixture.documentInstanceId
  });
  const afterRestart = await restartedHarness.invoke(runGet(restartedFixture), restartedFixture.sender);
  assert.equal(afterRestart.ok, true);
  assert.equal(afterRestart.identityObservation?.source, "probe");
  assert.equal(restartedHarness.identityProbeCount(restartedFixture.tabId), 1);
});
