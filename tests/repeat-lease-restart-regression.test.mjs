import assert from "node:assert/strict";
import test from "node:test";

import {
  EXTENSION_VERSION,
  installBackgroundHarness,
  leaseKey,
  makeRun
} from "./helpers/background-harness.mjs";

async function coldWorkerFixture(tabId) {
  const harness = await installBackgroundHarness();
  const documentId = `restart-document-${tabId}`;
  const documentInstanceId = `restart-instance-${tabId}`;
  const conversationKey = `chatgpt:c:restart-${tabId}`;
  const run = makeRun({
    runId: `restart-run-${tabId}`,
    boundTabId: tabId,
    boundDocumentId: documentId,
    documentInstanceId,
    conversationKey,
    executionSessionId: harness.sessionId()
  });
  harness.setDocument(tabId, { documentId, documentInstanceId });
  harness.putRun(tabId, run);
  // A worker eviction retains the browser session and durable Run/Lease, but the
  // newly imported worker has no in-memory document authority grant.
  const nonce = `restart-nonce-${tabId}`;
  harness.storageData[leaseKey(conversationKey)] = {
    runId: run.runId,
    tabId,
    documentId,
    documentInstanceId,
    nonce,
    executionSessionId: run.executionSessionId,
    expiresAt: Date.now() - 60_000
  };
  const sender = { tab: { id: tabId }, frameId: 0, documentId, documentLifecycle: "active" };
  const message = {
    type: "AIPM_LEASE_RENEW",
    runId: run.runId,
    conversationKey,
    documentInstanceId,
    nonce,
    serviceWorkerVersion: EXTENSION_VERSION,
    executionSessionId: run.executionSessionId
  };
  return { harness, run, sender, message, tabId };
}

function rejectRendererProbes(fixture) {
  fixture.harness.setIdentityPlan(fixture.tabId, Array.from({ length: 32 }, () => ({
    error: new Error("synthetic identity probe unavailable")
  })));
}

test("lease-first cold worker renews only its exact durable owner when renderer probing is unavailable", async () => {
  const fixture = await coldWorkerFixture(29_001);
  rejectRendererProbes(fixture);
  const beforeLease = structuredClone(fixture.harness.storageData[leaseKey(fixture.run.conversationKey)]);
  const renewed = await fixture.harness.invoke(fixture.message, fixture.sender);

  // Stage 1 recorded this exact fixture failing closed. Stage 2 reuses the same
  // bound-sender proof for renewal without granting acquisition authority.
  assert.equal(renewed.ok, true);
  assert.equal(renewed.renewed, true);
  assert.equal(renewed.identityObservation?.source, "bound-content-sender");
  const afterLease = fixture.harness.storageData[leaseKey(fixture.run.conversationKey)];
  assert.ok(afterLease.expiresAt > Date.now());
  assert.deepEqual({ ...afterLease, expiresAt: beforeLease.expiresAt }, beforeLease);
  assert.equal(fixture.harness.storedRun(fixture.tabId).status, "running");
  assert.equal(fixture.harness.commandsDelivered(fixture.tabId).length, 0);
});

test("control: a preceding Run read recovers the same bound sender and enables renewal", async () => {
  const fixture = await coldWorkerFixture(29_002);
  rejectRendererProbes(fixture);
  const read = await fixture.harness.invoke({
    type: "AIPM_RUN_GET",
    conversationKey: fixture.run.conversationKey,
    documentInstanceId: fixture.run.documentInstanceId,
    readOnlyObservation: true,
    authorityBoundary: "readiness"
  }, fixture.sender);

  assert.equal(read.ok, true);
  assert.equal(read.identityObservation?.source, "bound-content-sender");
  const renewed = await fixture.harness.invoke(fixture.message, fixture.sender);
  assert.equal(renewed.ok, true);
  assert.equal(renewed.renewed, true);
  assert.equal(renewed.identityObservation?.source, "document-lifetime-grant");
  assert.equal(fixture.harness.commandsDelivered(fixture.tabId).length, 0);
});
