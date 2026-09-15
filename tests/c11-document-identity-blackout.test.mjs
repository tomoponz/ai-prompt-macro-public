import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SESSION_ID,
  EXTENSION_VERSION,
  activeRunKey,
  installBackgroundHarness,
  leaseKey,
  makeRun
} from "./helpers/background-harness.mjs";

const harness = await installBackgroundHarness();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nextTabId = 11_000;

const SAFE_RECOVERY = Object.freeze({
  mode: "safe",
  identityAttempts: 3,
  readiness: "normal",
  statusRecovery: "normal"
});

function setupTab({ recovery = SAFE_RECOVERY, sendsCompleted = 0, repeat = 3 } = {}) {
  nextTabId += 1;
  const tabId = nextTabId;
  const documentId = `document-${tabId}`;
  const documentInstanceId = `instance-${tabId}`;
  const conversationKey = `chatgpt:c:c11-${tabId}`;
  const base = makeRun();
  const run = makeRun({
    runId: `run-c11-${tabId}`,
    boundTabId: tabId,
    boundDocumentId: documentId,
    documentInstanceId,
    conversationKey,
    cursor: { stepIndex: 0, repeatIndex: sendsCompleted, sendsCompleted },
    plannedSends: repeat,
    workflow: {
      ...base.workflow,
      maxSends: repeat,
      recovery,
      steps: [{
        id: "c11-repeat",
        type: "prompt",
        delivery: "send",
        prompt: "C11 BLACKOUT",
        repeat,
        delayAfterMs: 0
      }]
    }
  });
  harness.setDocument(tabId, { documentId, documentInstanceId });
  harness.putRun(tabId, run);
  return {
    tabId,
    documentId,
    documentInstanceId,
    conversationKey,
    run,
    sender: { tab: { id: tabId }, documentId }
  };
}

function matchingIdentity(fixture) {
  return {
    documentId: fixture.documentId,
    documentInstanceId: fixture.documentInstanceId
  };
}

function mismatchingIdentity(fixture) {
  return {
    documentId: `${fixture.documentId}-changed`,
    documentInstanceId: `${fixture.documentInstanceId}-changed`
  };
}

function blackoutPlan(fixture, durationMs, { final = "match", contactMs = 700 } = {}) {
  const blackoutUntil = Date.now() + durationMs;
  const outcomeAfterBlackout = final === "mismatch"
    ? mismatchingIdentity(fixture)
    : matchingIdentity(fixture);
  const outcome = async () => {
    const remaining = blackoutUntil - Date.now();
    if (remaining > 0) {
      await sleep(Math.min(contactMs, remaining));
      if (Date.now() < blackoutUntil) throw new Error("fixture document identity blackout");
    }
    return outcomeAfterBlackout;
  };
  return Array.from({ length: 12 }, () => outcome);
}

function runGetMessage(fixture, boundary = "readiness") {
  return {
    type: "AIPM_RUN_GET",
    conversationKey: fixture.conversationKey,
    documentInstanceId: fixture.documentInstanceId,
    readOnlyObservation: true,
    readOnlyRecovery: SAFE_RECOVERY,
    authorityBoundary: boundary
  };
}

async function observeRunGet(fixture, durationMs, boundary = "readiness", options = {}) {
  harness.setIdentityPlan(fixture.tabId, blackoutPlan(fixture, durationMs, options));
  const beforeProbes = harness.identityProbeCount(fixture.tabId);
  const startedAt = Date.now();
  const response = await harness.invoke(runGetMessage(fixture, boundary), fixture.sender);
  return {
    durationMs,
    boundary,
    elapsedMs: Date.now() - startedAt,
    probes: harness.identityProbeCount(fixture.tabId) - beforeProbes,
    response,
    observation: response.identityObservation ?? null,
    sendsCompleted: harness.storedRun(fixture.tabId)?.cursor?.sendsCompleted ?? null,
    status: harness.storedRun(fixture.tabId)?.status ?? null
  };
}

test("C11-R1: a 100-200ms transient blackout recovers with one unchanged Run and zero duplicate authority", async () => {
  const fixture = setupTab();
  const result = await observeRunGet(fixture, 150);

  assert.equal(result.response.ok, true);
  assert.equal(result.response.run?.runId, fixture.run.runId);
  assert.equal(result.observation?.outcome, "match");
  assert.equal(result.status, "running");
  assert.equal(result.sendsCompleted, 0);
  assert.equal(harness.commandsDelivered(fixture.tabId).length, 0);
});

test("C11-R2/R4 duration matrix: fresh-authority suspension recovers through 8 seconds and stays bounded", async () => {
  const durations = [0, 100, 250, 500, 1_000, 2_000, 3_000, 4_000, 5_000, 8_000, 12_000];
  const rows = [];

  for (const durationMs of durations) {
    const fixture = setupTab();
    const result = await observeRunGet(fixture, durationMs);
    rows.push({
      blackoutMs: durationMs,
      attempts: result.observation?.attempt ?? result.probes,
      totalAttempts: result.observation?.totalAttempts ?? result.probes,
      elapsedMs: result.elapsedMs,
      outcome: result.observation?.outcome ?? "unknown",
      reason: result.observation?.reason ?? null,
      status: result.status,
      sends: result.sendsCompleted
    });
    assert.equal(result.status, "running", "a read-only probe must not mutate durable Run state by itself");
    assert.equal(result.sendsCompleted, 0);
    assert.ok(result.probes >= 1 && result.probes <= 12, `bounded probes for ${durationMs}ms`);
  }

  for (const row of rows.filter((entry) => entry.blackoutMs <= 8_000)) {
    assert.equal(row.outcome, "match", `${row.blackoutMs}ms must recover inside the bounded suspension`);
  }
  for (const row of rows.filter((entry) => entry.blackoutMs >= 12_000)) {
    assert.equal(row.outcome, "unavailable", `${row.blackoutMs}ms must exceed the bounded suspension`);
    assert.ok(row.elapsedMs < row.blackoutMs, "the bounded suspension must terminate before an unbounded wait");
  }
  console.log(`C11_DURATION_MATRIX=${JSON.stringify(rows)}`);
});

test("C11-R4/R7: MATCH after the legacy cutoff resumes the same fresh-authority episode", async () => {
  const fixture = setupTab();
  const blackoutMs = 5_000;
  const startedAt = Date.now();
  harness.setIdentityPlan(fixture.tabId, blackoutPlan(fixture, blackoutMs));
  const recovered = await harness.invoke(runGetMessage(fixture), fixture.sender);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.identityObservation?.outcome, "match");
  assert.ok(Date.now() - startedAt >= blackoutMs);
  assert.ok(recovered.identityObservation?.consecutiveUnavailable > 0);
  assert.equal(harness.storedRun(fixture.tabId).status, "running");
  assert.equal(harness.commandsDelivered(fixture.tabId).length, 0);
});

test("C11-R5/R6/R7: MATCH, UNAVAILABLE, and MISMATCH stay distinct and mismatch returns immediately", async () => {
  const mismatch = setupTab();
  harness.setIdentityPlan(mismatch.tabId, [mismatchingIdentity(mismatch)]);
  const mismatchResult = await harness.invoke(runGetMessage(mismatch), mismatch.sender);
  assert.equal(mismatchResult.ok, true);
  assert.equal(mismatchResult.run, null);
  assert.equal(mismatchResult.staleDocument, true);
  assert.equal(mismatchResult.mismatchCommitted, true);
  assert.equal(mismatchResult.identityObservation?.outcome, "mismatch");
  assert.equal(mismatchResult.identityObservation?.attempt, 1);
  assert.equal(harness.storedRun(mismatch.tabId).status, "paused");
  assert.equal(harness.storedRun(mismatch.tabId).resumable, false);
  assert.equal(harness.storedRun(mismatch.tabId).pauseReason, "document_identity_mismatch");

  const unavailableThenMismatch = setupTab();
  harness.setIdentityPlan(unavailableThenMismatch.tabId, [
    async () => {
      await sleep(700);
      throw new Error("temporary blackout");
    },
    mismatchingIdentity(unavailableThenMismatch)
  ]);
  const rejected = await harness.invoke(runGetMessage(unavailableThenMismatch), unavailableThenMismatch.sender);
  assert.equal(rejected.identityObservation?.outcome, "mismatch");
  assert.equal(rejected.identityObservation?.attempt, 2);
  assert.equal(rejected.run, null);
  assert.equal(harness.storedRun(unavailableThenMismatch.tabId).pauseReason, "document_identity_mismatch");

  const unavailableThenMatch = setupTab();
  harness.setIdentityPlan(unavailableThenMatch.tabId, [
    async () => {
      await sleep(700);
      throw new Error("temporary blackout");
    },
    matchingIdentity(unavailableThenMatch)
  ]);
  const recovered = await harness.invoke(runGetMessage(unavailableThenMatch), unavailableThenMatch.sender);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.identityObservation?.outcome, "match");
  assert.equal(recovered.identityObservation?.attempt, 2);
  assert.equal(recovered.run?.runId, unavailableThenMatch.run.runId);
  assert.equal(harness.commandsDelivered(unavailableThenMatch.tabId).length, 0);
});

test("C11 boundary matrix: periodic stays observational while fresh-authority boundaries suspend then recover", async () => {
  const rows = [];
  for (const boundary of ["periodic-observation", "readiness", "send-preflight"]) {
    const fixture = setupTab();
    const result = await observeRunGet(fixture, 5_000, boundary);
    rows.push({
      boundary,
      attempts: result.observation?.attempt,
      elapsedMs: result.elapsedMs,
      outcome: result.observation?.outcome,
      status: result.status,
      sends: result.sendsCompleted
    });
    if (boundary === "periodic-observation") {
      assert.equal(result.response.ok, false);
      assert.equal(result.response.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
    } else {
      assert.equal(result.response.ok, true);
      assert.equal(result.observation?.outcome, "match");
    }
    assert.equal(result.sendsCompleted, 0);
  }

  const saveFixture = setupTab();
  harness.setIdentityPlan(saveFixture.tabId, blackoutPlan(saveFixture, 5_000));
  const saveStartedAt = Date.now();
  const saveResult = await harness.invoke({
    type: "AIPM_RUN_SET",
    run: saveFixture.run,
    runTransition: "runner",
    conversationKey: saveFixture.conversationKey,
    documentInstanceId: saveFixture.documentInstanceId,
    readOnlyRecovery: SAFE_RECOVERY,
    authorityBoundary: "send-preflight"
  }, saveFixture.sender);
  rows.push({
    boundary: "send-preflight-run-save",
    attempts: saveResult.identityObservation?.attempt,
    elapsedMs: Date.now() - saveStartedAt,
    outcome: saveResult.identityObservation?.outcome,
    status: harness.storedRun(saveFixture.tabId).status,
    sends: harness.storedRun(saveFixture.tabId).cursor.sendsCompleted
  });
  assert.equal(saveResult.ok, true);
  assert.equal(saveResult.identityObservation?.outcome, "match");

  const leaseFixture = setupTab({ sendsCompleted: 2, repeat: 3 });
  const nonce = `nonce-${leaseFixture.tabId}`;
  harness.storageData[leaseKey(leaseFixture.conversationKey)] = {
    runId: leaseFixture.run.runId,
    nonce,
    tabId: leaseFixture.tabId,
    documentId: leaseFixture.documentId,
    documentInstanceId: leaseFixture.documentInstanceId,
    executionSessionId: DEFAULT_SESSION_ID,
    expiresAt: Date.now() + 15_000
  };
  harness.setIdentityPlan(leaseFixture.tabId, blackoutPlan(leaseFixture, 5_000));
  const leaseStartedAt = Date.now();
  const leaseResult = await harness.invoke({
    type: "AIPM_LEASE_RENEW",
    conversationKey: leaseFixture.conversationKey,
    nonce,
    runId: leaseFixture.run.runId,
    documentInstanceId: leaseFixture.documentInstanceId,
    serviceWorkerVersion: EXTENSION_VERSION,
    executionSessionId: DEFAULT_SESSION_ID,
    readOnlyRecovery: SAFE_RECOVERY
  }, leaseFixture.sender);
  rows.push({
    boundary: "lease-renew",
    attempts: leaseResult.identityObservation?.attempt,
    elapsedMs: Date.now() - leaseStartedAt,
    outcome: leaseResult.identityObservation?.outcome,
    status: harness.storedRun(leaseFixture.tabId).status,
    sends: harness.storedRun(leaseFixture.tabId).cursor.sendsCompleted
  });
  assert.equal(leaseResult.ok, true);
  assert.equal(leaseResult.renewed, true);
  assert.equal(leaseResult.identityObservation?.outcome, "match");
  assert.equal(harness.storedRun(leaseFixture.tabId).cursor.sendsCompleted, 2);
  console.log(`C11_BOUNDARY_MATRIX=${JSON.stringify(rows)}`);
});

test("C11-R10 lifecycle: a tab loading generation change invalidates an in-flight identity episode", async () => {
  const fixture = setupTab();
  let releaseProbe;
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  harness.setIdentityPlan(fixture.tabId, [async () => {
    await probeGate;
    return matchingIdentity(fixture);
  }]);

  const pending = harness.invoke(runGetMessage(fixture), fixture.sender);
  while (harness.identityProbeCount(fixture.tabId) < 1) await sleep(5);
  await harness.triggerTabLoading(fixture.tabId);
  releaseProbe();
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.equal(result.identityObservation?.reason, "document-lifecycle-changed");
  assert.equal(result.lifecycleInvalidated, true);
  assert.equal(result.lifecycleCommitted, true);
  assert.equal(harness.storedRun(fixture.tabId).status, "paused");
  assert.equal(harness.storedRun(fixture.tabId).resumable, false);
  assert.equal(harness.commandsDelivered(fixture.tabId).length, 0);
});

test("C11-R11 stale lifecycle fail-closed cannot downgrade a newer document rebind", async () => {
  const fixture = setupTab();
  const originalRevision = fixture.run.stateRevision;
  let releaseOldProbe;
  const oldProbeGate = new Promise((resolve) => { releaseOldProbe = resolve; });
  harness.setIdentityPlan(fixture.tabId, [async () => {
    await oldProbeGate;
    return matchingIdentity(fixture);
  }]);

  const staleObservation = harness.invoke(runGetMessage(fixture), fixture.sender);
  while (harness.identityProbeCount(fixture.tabId) < 1) await sleep(5);

  const nextDocumentId = `${fixture.documentId}-reloaded`;
  const nextDocumentInstanceId = `${fixture.documentInstanceId}-reloaded`;
  const nextIdentity = {
    documentId: nextDocumentId,
    documentInstanceId: nextDocumentInstanceId
  };
  const nextSender = { tab: { id: fixture.tabId }, documentId: nextDocumentId };
  harness.setDocument(fixture.tabId, nextIdentity);
  harness.setIdentityPlan(fixture.tabId, [nextIdentity]);

  // Queue a production D2 state save, then synchronously advance the lifecycle before the
  // serialized task starts. The old D1 probe is still unresolved, while the fresh-authority
  // save is first in line to rebind and advance the same Run under D2.
  const advancedPromise = harness.invoke({
    type: "AIPM_RUN_SET",
    conversationKey: fixture.conversationKey,
    documentInstanceId: nextDocumentInstanceId,
    runTransition: "runner",
    readOnlyRecovery: SAFE_RECOVERY,
    authorityBoundary: "run-save",
    run: {
      ...fixture.run,
      cursor: { stepIndex: 0, repeatIndex: 1, sendsCompleted: 1 }
    }
  }, nextSender);
  await harness.triggerTabLoading(fixture.tabId);
  const advanced = await advancedPromise;
  assert.equal(advanced.ok, true);
  assert.equal(advanced.run?.runId, fixture.run.runId);
  assert.equal(advanced.run?.boundDocumentId, nextDocumentId);
  assert.equal(advanced.run?.documentInstanceId, nextDocumentInstanceId);
  assert.equal(advanced.run?.stateRevision > originalRevision, true);

  releaseOldProbe();
  const staleResult = await staleObservation;
  const durable = harness.storedRun(fixture.tabId);

  assert.equal(staleResult.ok, false);
  assert.equal(staleResult.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.equal(staleResult.identityObservation?.reason, "document-lifecycle-changed");
  assert.equal(staleResult.lifecycleInvalidated, true);
  assert.equal(staleResult.lifecycleCommitted, false);
  assert.equal(durable.status, "running");
  assert.equal(durable.resumable, true);
  assert.equal(durable.boundDocumentId, nextDocumentId);
  assert.equal(durable.documentInstanceId, nextDocumentInstanceId);
  assert.equal(durable.cursor.sendsCompleted, 1);
  assert.equal(durable.stateRevision, advanced.run.stateRevision);
  assert.equal(harness.commandsDelivered(fixture.tabId).length, 0);
});

test("C11-R12 stale lifecycle fail-closed rejects a newer binding at the same revision", async () => {
  const fixture = setupTab();
  let releaseOldProbe;
  const oldProbeGate = new Promise((resolve) => { releaseOldProbe = resolve; });
  harness.setIdentityPlan(fixture.tabId, [async () => {
    await oldProbeGate;
    return matchingIdentity(fixture);
  }]);

  const staleObservation = harness.invoke(runGetMessage(fixture), fixture.sender);
  while (harness.identityProbeCount(fixture.tabId) < 1) await sleep(5);

  const nextDocumentId = `${fixture.documentId}-binding-only`;
  const nextDocumentInstanceId = `${fixture.documentInstanceId}-binding-only`;
  const nextIdentity = {
    documentId: nextDocumentId,
    documentInstanceId: nextDocumentInstanceId
  };
  const nextSender = { tab: { id: fixture.tabId }, documentId: nextDocumentId };
  harness.setDocument(fixture.tabId, nextIdentity);
  harness.setIdentityPlan(fixture.tabId, [nextIdentity]);

  const reboundPromise = harness.invoke({
    ...runGetMessage(fixture, "recovery"),
    documentInstanceId: nextDocumentInstanceId,
    readOnlyObservation: false
  }, nextSender);
  await harness.triggerTabLoading(fixture.tabId);
  const rebound = await reboundPromise;
  assert.equal(rebound.ok, true);
  assert.equal(rebound.run?.stateRevision, fixture.run.stateRevision);
  assert.equal(rebound.run?.boundDocumentId, nextDocumentId);
  assert.equal(rebound.run?.documentInstanceId, nextDocumentInstanceId);

  releaseOldProbe();
  const staleResult = await staleObservation;
  const durable = harness.storedRun(fixture.tabId);

  assert.equal(staleResult.lifecycleInvalidated, true);
  assert.equal(staleResult.lifecycleCommitted, false);
  assert.equal(staleResult.lifecycleContextStale, true);
  assert.equal(durable.status, "running");
  assert.equal(durable.boundDocumentId, nextDocumentId);
  assert.equal(durable.documentInstanceId, nextDocumentInstanceId);
  assert.equal(durable.stateRevision, fixture.run.stateRevision);
  assert.equal(harness.commandsDelivered(fixture.tabId).length, 0);
});

test("C11-R13 stale lifecycle fail-closed rejects a newer revision without a binding change", async () => {
  const fixture = setupTab();
  let releaseOldProbe;
  const oldProbeGate = new Promise((resolve) => { releaseOldProbe = resolve; });
  harness.setIdentityPlan(fixture.tabId, [async () => {
    await oldProbeGate;
    return matchingIdentity(fixture);
  }]);

  const staleObservation = harness.invoke(runGetMessage(fixture), fixture.sender);
  while (harness.identityProbeCount(fixture.tabId) < 1) await sleep(5);
  harness.setIdentityPlan(fixture.tabId, [matchingIdentity(fixture)]);

  const advancedPromise = harness.invoke({
    type: "AIPM_RUN_SET",
    conversationKey: fixture.conversationKey,
    documentInstanceId: fixture.documentInstanceId,
    runTransition: "runner",
    readOnlyRecovery: SAFE_RECOVERY,
    authorityBoundary: "run-save",
    run: {
      ...fixture.run,
      cursor: { stepIndex: 0, repeatIndex: 1, sendsCompleted: 1 }
    }
  }, fixture.sender);
  await harness.triggerTabLoading(fixture.tabId);
  const advanced = await advancedPromise;
  assert.equal(advanced.ok, true);
  assert.equal(advanced.run?.stateRevision > fixture.run.stateRevision, true);
  assert.equal(advanced.run?.boundDocumentId, fixture.documentId);

  releaseOldProbe();
  const staleResult = await staleObservation;
  const durable = harness.storedRun(fixture.tabId);

  assert.equal(staleResult.lifecycleInvalidated, true);
  assert.equal(staleResult.lifecycleCommitted, false);
  assert.equal(staleResult.lifecycleContextStale, true);
  assert.equal(durable.status, "running");
  assert.equal(durable.cursor.sendsCompleted, 1);
  assert.equal(durable.stateRevision, advanced.run.stateRevision);
  assert.equal(harness.commandsDelivered(fixture.tabId).length, 0);
});

test("C11 concurrent recovery: ten callers share one bounded fresh-authority episode", async () => {
  const fixture = setupTab();
  harness.setIdentityPlan(fixture.tabId, [
    async () => {
      await sleep(700);
      throw new Error("temporary blackout");
    },
    matchingIdentity(fixture)
  ]);
  const beforeProbes = harness.identityProbeCount(fixture.tabId);
  const responses = await Promise.all(Array.from({ length: 10 }, () =>
    harness.invoke(runGetMessage(fixture), fixture.sender)));

  assert.equal(responses.every((response) => response.ok === true), true);
  assert.equal(responses.every((response) => response.run?.runId === fixture.run.runId), true);
  assert.equal(responses.every((response) => response.identityObservation?.outcome === "match"), true);
  assert.equal(harness.identityProbeCount(fixture.tabId) - beforeProbes, 2);
  assert.equal(harness.storedRun(fixture.tabId).status, "running");
  assert.equal(harness.commandsDelivered(fixture.tabId).length, 0);
});

test("C11 static boundary: recovery remains read-only and no probe result directly grants Send", () => {
  assert.equal(harness.commandsDelivered(-1).length, 0);
  const sourceRun = harness.storageData[activeRunKey(-1)];
  assert.equal(sourceRun, undefined);
});
