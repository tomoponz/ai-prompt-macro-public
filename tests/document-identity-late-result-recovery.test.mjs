import assert from "node:assert/strict";
import test from "node:test";

import {
  activeRunKey,
  deferred,
  installBackgroundHarness,
  makeRun
} from "./helpers/background-harness.mjs";

const harness = await installBackgroundHarness();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nextTabId = 18_000;

const SAFE_RECOVERY = Object.freeze({
  mode: "safe",
  identityAttempts: 3,
  readiness: "normal",
  statusRecovery: "normal"
});

function setupRun() {
  nextTabId += 1;
  const tabId = nextTabId;
  const documentId = `late-document-${tabId}`;
  const documentInstanceId = `late-instance-${tabId}`;
  const conversationKey = `chatgpt:c:late-${tabId}`;
  const run = makeRun({
    runId: `late-run-${tabId}`,
    boundTabId: tabId,
    boundDocumentId: documentId,
    documentInstanceId,
    conversationKey,
    executionSessionId: harness.sessionId()
  });
  harness.setTabs([{ id: tabId, active: true, windowId: 1, url: "https://chatgpt.com/" }]);
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

function mismatchingDocument(fixture) {
  return {
    documentId: `${fixture.documentId}-replacement`,
    documentInstanceId: fixture.documentInstanceId
  };
}

function mismatchingInstance(fixture) {
  return {
    documentId: fixture.documentId,
    documentInstanceId: `${fixture.documentInstanceId}-replacement`
  };
}

function delayed(ms, value) {
  return async () => {
    await sleep(ms);
    return typeof value === "function" ? value() : value;
  };
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

async function readRun(fixture, boundary = "readiness") {
  return harness.invoke(runGetMessage(fixture, boundary), fixture.sender);
}

async function waitFor(check, { timeoutMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached in time");
    await sleep(5);
  }
}

test("late identity 1: normal match below 500ms preserves the public path", async () => {
  const fixture = setupRun();
  harness.setIdentityPlan(fixture.tabId, [delayed(50, matchingIdentity(fixture))]);

  const response = await readRun(fixture);

  assert.equal(response.ok, true);
  assert.equal(response.run?.runId, fixture.run.runId);
  assert.equal(response.identityObservation?.outcome, "match");
  assert.equal(response.identityObservation?.consecutiveUnavailable, 0);
  assert.equal(harness.identityProbeCount(fixture.tabId), 1);
});

test("late identity 2: a 1.2s fulfillment is consumed by its original recovery owner", async () => {
  const fixture = setupRun();
  harness.setIdentityPlan(fixture.tabId, [delayed(1_200, matchingIdentity(fixture))]);
  const startedAt = Date.now();

  const response = await readRun(fixture);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(response.ok, true);
  assert.equal(response.run?.runId, fixture.run.runId);
  assert.equal(response.identityObservation?.outcome, "match");
  assert.equal(response.identityObservation?.attempt, 1);
  assert.ok(response.identityObservation?.consecutiveUnavailable >= 1);
  assert.equal(harness.identityProbeCount(fixture.tabId), 1, "no replacement probe is started while the elected attempt is eligible");
  assert.ok(elapsedMs >= 1_100 && elapsedMs < 1_500, `late match took ${elapsedMs}ms`);
});

test("late identity 3: an eligible late mismatch remains terminal for the exact Run", async () => {
  const fixture = setupRun();
  harness.setIdentityPlan(fixture.tabId, [delayed(1_200, mismatchingDocument(fixture))]);

  const response = await readRun(fixture);

  assert.equal(response.ok, true);
  assert.equal(response.run, null);
  assert.equal(response.staleDocument, true);
  assert.equal(response.mismatchCommitted, true);
  assert.equal(response.identityObservation?.outcome, "mismatch");
  assert.equal(response.identityObservation?.attempt, 1);
  assert.equal(harness.identityProbeCount(fixture.tabId), 1);
  assert.equal(harness.storedRun(fixture.tabId)?.status, "paused");
  assert.equal(harness.storedRun(fixture.tabId)?.resumable, false);
  assert.equal(harness.storedRun(fixture.tabId)?.pauseReason, "document_identity_mismatch");
});

test("late identity 4: a late rejection grants no authority and a bounded replacement may recover", async () => {
  const fixture = setupRun();
  harness.setIdentityPlan(fixture.tabId, [
    delayed(800, () => { throw new Error("late executeScript rejection"); }),
    matchingIdentity(fixture)
  ]);

  const response = await readRun(fixture);

  assert.equal(response.ok, true);
  assert.equal(response.run?.runId, fixture.run.runId);
  assert.equal(response.identityObservation?.outcome, "match");
  assert.equal(response.identityObservation?.attempt, 2);
  assert.equal(harness.identityProbeCount(fixture.tabId), 2);
});

for (const [name, oldIdentity] of [
  ["old MATCH/new MISMATCH", (fixture) => matchingIdentity(fixture)],
  ["old MISMATCH/new MATCH", (fixture) => mismatchingDocument(fixture)]
]) {
  test(`late identity 5/16-20: expired ${name} cannot win after replacement`, async () => {
    const fixture = setupRun();
    const newIdentity = name === "old MATCH/new MISMATCH"
      ? mismatchingDocument(fixture)
      : matchingIdentity(fixture);
    harness.setIdentityPlan(fixture.tabId, [
      delayed(1_650, oldIdentity(fixture)),
      newIdentity
    ]);

    const response = await readRun(fixture);
    await sleep(100);

    assert.equal(harness.identityProbeCount(fixture.tabId), 2);
    assert.equal(response.identityObservation?.attempt, 2);
    if (name === "old MATCH/new MISMATCH") {
      assert.equal(response.identityObservation?.outcome, "mismatch");
      assert.equal(response.mismatchCommitted, true);
      assert.equal(harness.storedRun(fixture.tabId)?.pauseReason, "document_identity_mismatch");
    } else {
      assert.equal(response.identityObservation?.outcome, "match");
      assert.equal(response.run?.runId, fixture.run.runId);
      assert.equal(harness.storedRun(fixture.tabId)?.status, "running");
    }
  });
}

for (const [name, lateIdentity] of [
  ["MATCH", matchingIdentity],
  ["MISMATCH", mismatchingDocument]
]) {
  test(`late identity 6/9-11: exact durable Stop cancels a pending late ${name}`, async () => {
    const fixture = setupRun();
    const gate = deferred();
    harness.setIdentityPlan(fixture.tabId, [() => gate.promise]);
    const readPending = readRun(fixture);
    await waitFor(() => harness.identityProbeCount(fixture.tabId) === 1);
    await sleep(550);

    const stopPending = harness.relay({
      type: "AIPM_STOP",
      expectedRunId: fixture.run.runId,
      expectedStateRevision: fixture.run.stateRevision
    }, fixture.tabId);
    await waitFor(() => harness.storedRun(fixture.tabId)?.status === "stopped", { timeoutMs: 1_000 });
    gate.resolve(lateIdentity(fixture));
    const [readResponse, stopResponse] = await Promise.all([readPending, stopPending]);

    assert.equal(stopResponse.ok, true);
    assert.equal(stopResponse.stopCommitted, true);
    assert.equal(harness.storedRun(fixture.tabId)?.status, "stopped");
    assert.notEqual(readResponse.run?.status, "running");
    assert.equal(
      harness.commandsDelivered(fixture.tabId).filter((entry) => ["AIPM_START", "AIPM_RESUME"].includes(entry.payload?.type)).length,
      0
    );
  });
}

test("late identity 12/15/23: document epoch change after timeout invalidates the elected result", async () => {
  const fixture = setupRun();
  const gate = deferred();
  harness.setIdentityPlan(fixture.tabId, [() => gate.promise]);
  const pending = readRun(fixture);
  await waitFor(() => harness.identityProbeCount(fixture.tabId) === 1);
  await sleep(550);

  await harness.triggerTabLoading(fixture.tabId);
  gate.resolve(matchingIdentity(fixture));
  const response = await pending;

  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.equal(response.identityObservation?.reason, "document-lifecycle-changed");
  assert.equal(response.lifecycleInvalidated, true);
  assert.equal(harness.storedRun(fixture.tabId)?.resumable, false);
});

test("late identity 13/14/23: startup generation/session change invalidates the old worker episode", async () => {
  const fixture = setupRun();
  const gate = deferred();
  harness.setIdentityPlan(fixture.tabId, [() => gate.promise]);
  const pending = readRun(fixture);
  await waitFor(() => harness.identityProbeCount(fixture.tabId) === 1);
  await sleep(550);

  await harness.triggerStartup();
  gate.resolve(matchingIdentity(fixture));
  const response = await pending;

  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.equal(response.identityObservation?.reason, "execution-session-changed");
  assert.equal(response.lifecycleInvalidated, true);
  assert.equal(harness.storedRun(fixture.tabId), null);
});

test("late identity 21: periodic observation keeps public-timeout behavior and never consumes late authority", async () => {
  const fixture = setupRun();
  harness.setIdentityPlan(fixture.tabId, [delayed(800, matchingIdentity(fixture))]);

  const response = await readRun(fixture, "periodic-observation");

  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.equal(response.identityObservation?.outcome, "unavailable");
  assert.equal(harness.identityProbeCount(fixture.tabId), 1);
  await sleep(150);
});

test("late identity 24: malformed late InjectionResult is fail-closed and only the next valid attempt can match", async () => {
  const fixture = setupRun();
  harness.setIdentityPlan(fixture.tabId, [
    delayed(700, {
      rawResults: [{
        frameId: 7,
        documentId: fixture.documentId,
        result: fixture.documentInstanceId
      }]
    }),
    matchingIdentity(fixture)
  ]);

  const response = await readRun(fixture);

  assert.equal(response.ok, true);
  assert.equal(response.identityObservation?.outcome, "match");
  assert.equal(response.identityObservation?.attempt, 2);
  assert.equal(harness.identityProbeCount(fixture.tabId), 2);
});

for (const [name, mismatch] of [
  ["returned documentId", mismatchingDocument],
  ["document instance", mismatchingInstance]
]) {
  test(`late identity 25/26: eligible late ${name} mismatch is compared using its real value`, async () => {
    const fixture = setupRun();
    harness.setIdentityPlan(fixture.tabId, [delayed(700, mismatch(fixture))]);

    const response = await readRun(fixture);

    assert.equal(response.identityObservation?.outcome, "mismatch");
    assert.equal(response.mismatchCommitted, true);
    assert.equal(harness.identityProbeCount(fixture.tabId), 1);
    assert.equal(harness.storedRun(fixture.tabId)?.pauseReason, "document_identity_mismatch");
  });
}

test("late identity 27: a Run revision change rejects an older late mismatch terminal write", async () => {
  const fixture = setupRun();
  harness.setIdentityPlan(fixture.tabId, [delayed(700, mismatchingDocument(fixture))]);
  let revisionChanged = false;
  harness.setStorageGetFault(async (key) => {
    if (!revisionChanged && key === activeRunKey(fixture.tabId)) {
      revisionChanged = true;
      harness.storageData[key] = {
        ...harness.storageData[key],
        stateRevision: fixture.run.stateRevision + 1,
        updatedAt: "2026-08-28T00:00:00.000Z"
      };
    }
  });

  try {
    const response = await readRun(fixture);

    assert.equal(revisionChanged, true);
    assert.equal(response.identityObservation?.outcome, "mismatch");
    assert.equal(response.mismatchCommitted, false);
    assert.equal(response.mismatchContextStale, true);
    assert.equal(harness.storedRun(fixture.tabId)?.status, "running");
    assert.equal(harness.storedRun(fixture.tabId)?.stateRevision, fixture.run.stateRevision + 1);
  } finally {
    harness.setStorageGetFault(null);
  }
});

test("late identity post-decision fence: changed execution-session Run state is never returned as authority", async () => {
  const fixture = setupRun();
  const gate = deferred();
  harness.setIdentityPlan(fixture.tabId, [() => gate.promise]);
  const pending = readRun(fixture);
  await waitFor(() => harness.identityProbeCount(fixture.tabId) === 1);
  await sleep(550);

  harness.storageData[activeRunKey(fixture.tabId)] = {
    ...harness.storageData[activeRunKey(fixture.tabId)],
    executionSessionId: "replacement-session"
  };
  gate.resolve(matchingIdentity(fixture));
  const response = await pending;

  assert.equal(response.identityObservation?.outcome, "match");
  assert.equal(response.run, null);
  assert.equal(response.quarantined, true);
  assert.equal(response.quarantineReason, "stale-browser-session");
});
