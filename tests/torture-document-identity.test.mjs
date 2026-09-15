// T4 — document identity torture.
//
// Issue #23 is the completion-reliability half of document identity (a transient probe
// failure ending a 40-send unattended Run), and every wrong-tab / wrong-conversation
// guarantee is the safety half. The fix is a bounded read-only reconfirmation, which
// creates a new risk: retrying an observation must never turn into retrying an action.
//
// This suite sweeps the seven probe sequences named in the audit brief across every
// authority boundary that consults document identity, and proves four properties:
//
//   - a proven mismatch never decays into "unavailable" or "match"
//   - "unavailable" never grants authority
//   - only the read-only probe is retried
//   - an irreversible action is never retried
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SESSION_ID,
  EXTENSION_VERSION,
  installBackgroundHarness,
  makeRun
} from "./helpers/background-harness.mjs";

const harness = await installBackgroundHarness();

const RECOVERY_PROBE_LIMIT = 12;

function docFor(tabId) {
  return { documentId: `document-${tabId}`, documentInstanceId: `instance-${tabId}` };
}

function otherDoc() {
  return { documentId: "document-elsewhere", documentInstanceId: "instance-elsewhere" };
}

function delayedDoc(tabId, delayMs = 525) {
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return docFor(tabId);
  };
}

function delayedReject(delayMs = 525) {
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    throw new Error("late executeScript rejection");
  };
}

// Identity sequences are consumed by the bounded read-only reconfirmation. An eligible late
// fulfillment stays with its exact owner; a late rejection is the case that elects a bounded
// replacement probe.
function probePlans(tabId) {
  return {
    "public timeout -> eligible late match": {
      plan: [delayedDoc(tabId), docFor(tabId), docFor(tabId)],
      expect: "match",
      expectedProbes: 1
    },
    "late rejection -> match": {
      plan: [delayedReject(), docFor(tabId), docFor(tabId)],
      expect: "match",
      expectedProbes: 2
    },
    "late rejection -> late rejection -> match": {
      plan: [delayedReject(), delayedReject(), docFor(tabId)],
      expect: "match",
      expectedProbes: 3
    },
    "all unavailable": {
      plan: Array.from({ length: RECOVERY_PROBE_LIMIT }, () => ({ error: new Error("executeScript blocked") })),
      expect: "unavailable",
      expectedProbes: RECOVERY_PROBE_LIMIT,
      reason: "execute-script-rejected"
    },
    "unavailable -> mismatch": {
      plan: [{ error: new Error("executeScript blocked") }, otherDoc(), docFor(tabId)],
      expect: "mismatch",
      expectedProbes: 2
    },
    "mismatch immediately": {
      // A proven mismatch must return on the first attempt; a later "match" must never be
      // reachable, so the two trailing matches must stay unconsumed.
      plan: [otherDoc(), docFor(tabId), docFor(tabId)],
      expect: "mismatch",
      expectedProbes: 1
    },
    "top-frame missing": {
      plan: Array.from({ length: RECOVERY_PROBE_LIMIT }, () => ({
        rawResults: [{ result: `instance-${tabId}`, frameId: 1, documentId: `document-${tabId}` }]
      })),
      expect: "unavailable",
      expectedProbes: RECOVERY_PROBE_LIMIT,
      reason: "top-frame-missing"
    },
    "identity field missing": {
      plan: Array.from({ length: RECOVERY_PROBE_LIMIT }, () => ({
        documentId: null,
        documentInstanceId: null
      })),
      expect: "unavailable",
      expectedProbes: RECOVERY_PROBE_LIMIT,
      reason: "identity-fields-unavailable"
    }
  };
}

let nextTabId = 4000;
function freshTab() {
  nextTabId += 1;
  const tabId = nextTabId;
  harness.setTabs([{ id: tabId, active: true, windowId: 1, url: "https://chatgpt.com/" }]);
  harness.setDocument(tabId, docFor(tabId));
  harness.setStatusResponder(tabId, () => ({
    ...harness.defaultStatus(tabId),
    run: harness.storedRun(tabId)
  }));
  return tabId;
}

function senderFor(tabId) {
  return { tab: { id: tabId }, documentId: docFor(tabId).documentId };
}

// ---------------------------------------------------------------------------
// Run GET
// ---------------------------------------------------------------------------

test("T4: Run GET applies every probe sequence without ever granting authority to a non-match", async () => {
  for (const [name, spec] of Object.entries(probePlans(0))) {
    const tabId = freshTab();
    const plans = probePlans(tabId)[name];
    const run = makeRun({
      runId: `get-${tabId}`,
      boundTabId: tabId,
      boundDocumentId: docFor(tabId).documentId,
      documentInstanceId: docFor(tabId).documentInstanceId
    });
    harness.putRun(tabId, run);
    harness.setIdentityPlan(tabId, plans.plan);
    const before = harness.identityProbeCount(tabId);

    const response = await harness.invoke({
      type: "AIPM_RUN_GET",
      conversationKey: run.conversationKey,
      documentInstanceId: docFor(tabId).documentInstanceId
    }, senderFor(tabId));

    const probes = harness.identityProbeCount(tabId) - before;
    const context = `Run GET / ${name}`;
    assert.equal(probes, plans.expectedProbes, `${context}: unexpected number of read-only probes`);

    if (plans.expect === "match") {
      assert.equal(response.ok, true, `${context}: a confirmed document must be able to read its Run`);
      assert.equal(response.run?.runId, run.runId);
    } else if (plans.expect === "mismatch") {
      // A stale document gets no Run at all, and the durable Run is left untouched for its
      // real owner.
      assert.equal(response.ok, true, `${context}: a proven mismatch is a definite answer, not an error`);
      assert.equal(response.run, null, `${context}: a stale document must not receive the Run`);
      assert.equal(response.staleDocument, true);
      assert.equal(harness.storedRun(tabId).runId, run.runId, `${context}: the durable Run must survive`);
    } else {
      assert.equal(response.ok, false, `${context}: an unproven document must not read the Run`);
      assert.equal(response.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
      assert.equal(response.identityObservation.outcome, "unavailable");
      assert.equal(response.identityObservation.reason, plans.reason);
      assert.equal(response.identityObservation.totalAttempts, RECOVERY_PROBE_LIMIT);
      assert.equal(harness.storedRun(tabId).runId, run.runId, `${context}: nothing may be mutated`);
    }
    void spec;
  }
});

// ---------------------------------------------------------------------------
// Run SET
// ---------------------------------------------------------------------------

test("T4: Run SET applies every probe sequence and only a match may mutate durable state", async () => {
  for (const name of Object.keys(probePlans(0))) {
    const tabId = freshTab();
    const plans = probePlans(tabId)[name];
    const existing = makeRun({
      runId: `set-${tabId}`,
      boundTabId: tabId,
      boundDocumentId: docFor(tabId).documentId,
      documentInstanceId: docFor(tabId).documentInstanceId,
      stateRevision: 4
    });
    harness.putRun(tabId, existing);
    harness.setIdentityPlan(tabId, plans.plan);
    const before = harness.identityProbeCount(tabId);

    const response = await harness.invoke({
      type: "AIPM_RUN_SET",
      run: { ...existing, phase: "prepared", stateRevision: 4 },
      runTransition: "runner",
      conversationKey: existing.conversationKey,
      documentInstanceId: docFor(tabId).documentInstanceId
    }, senderFor(tabId));

    const probes = harness.identityProbeCount(tabId) - before;
    const context = `Run SET / ${name}`;
    assert.equal(probes, plans.expectedProbes, `${context}: unexpected number of read-only probes`);

    if (plans.expect === "match") {
      assert.equal(response.ok, true, `${context}: a confirmed document may write`);
      assert.equal(harness.storedRun(tabId).phase, "prepared");
    } else {
      assert.equal(response.ok, false, `${context}: a non-match must never mutate the Run`);
      assert.equal(
        response.errorCode,
        plans.expect === "mismatch" ? "DOCUMENT_IDENTITY_MISMATCH" : "DOCUMENT_IDENTITY_UNCONFIRMED",
        `${context}: the failure must name the exact identity outcome`
      );
      assert.equal(response.identityObservation.outcome, plans.expect);
      assert.equal(harness.storedRun(tabId).phase, "ready", `${context}: the durable Run must be untouched`);
      assert.equal(harness.storedRun(tabId).stateRevision, 4, `${context}: a refused write must not bump revisions`);
    }
  }
});

// ---------------------------------------------------------------------------
// Lease acquire / renew
// ---------------------------------------------------------------------------

test("T4: lease acquire applies every probe sequence and a non-match never yields a lease", async () => {
  for (const name of Object.keys(probePlans(0))) {
    const tabId = freshTab();
    const plans = probePlans(tabId)[name];
    harness.setIdentityPlan(tabId, plans.plan);
    const conversationKey = `chatgpt:c:lease-${tabId}`;
    const before = harness.identityProbeCount(tabId);

    const response = await harness.invoke({
      type: "AIPM_LEASE_ACQUIRE",
      conversationKey,
      runId: `lease-run-${tabId}`,
      documentInstanceId: docFor(tabId).documentInstanceId,
      serviceWorkerVersion: EXTENSION_VERSION,
      executionSessionId: DEFAULT_SESSION_ID
    }, senderFor(tabId));

    const context = `lease acquire / ${name}`;
    assert.equal(harness.identityProbeCount(tabId) - before, plans.expectedProbes, `${context}: probe count`);
    if (plans.expect === "match") {
      assert.equal(response.ok, true);
      assert.ok(response.lease?.nonce, `${context}: a confirmed document may hold the lease`);
    } else {
      assert.equal(response.ok, false, `${context}: an unproven or stale document must not hold the lease`);
      assert.equal(
        response.errorCode,
        plans.expect === "mismatch" ? "DOCUMENT_IDENTITY_MISMATCH" : "DOCUMENT_IDENTITY_UNCONFIRMED"
      );
      assert.equal(
        harness.storageData[`aipm.lease.v2.${encodeURIComponent(conversationKey)}`],
        undefined,
        `${context}: no lease may be persisted`
      );
    }
  }
});

test("T4: lease renew applies every probe sequence and a non-match never extends the lease", async () => {
  for (const name of Object.keys(probePlans(0))) {
    const tabId = freshTab();
    const conversationKey = `chatgpt:c:renew-${tabId}`;
    harness.setIdentityPlan(tabId, [docFor(tabId)]);
    const acquired = await harness.invoke({
      type: "AIPM_LEASE_ACQUIRE",
      conversationKey,
      runId: `renew-run-${tabId}`,
      documentInstanceId: docFor(tabId).documentInstanceId,
      serviceWorkerVersion: EXTENSION_VERSION,
      executionSessionId: DEFAULT_SESSION_ID
    }, senderFor(tabId));
    assert.ok(acquired.lease?.nonce, "the setup acquire must succeed");
    const leaseStorageKey = `aipm.lease.v2.${encodeURIComponent(conversationKey)}`;
    const expiresBefore = harness.storageData[leaseStorageKey].expiresAt;

    const plans = probePlans(tabId)[name];
    harness.setIdentityPlan(tabId, plans.plan);
    const response = await harness.invoke({
      type: "AIPM_LEASE_RENEW",
      conversationKey,
      nonce: acquired.lease.nonce,
      runId: `renew-run-${tabId}`,
      documentInstanceId: docFor(tabId).documentInstanceId,
      serviceWorkerVersion: EXTENSION_VERSION,
      executionSessionId: DEFAULT_SESSION_ID
    }, senderFor(tabId));

    const context = `lease renew / ${name}`;
    if (plans.expect === "match") {
      assert.equal(response.ok, true);
      assert.equal(response.renewed, true, `${context}: the exact owner may renew`);
    } else {
      assert.equal(response.ok, false, `${context}: a non-match must not renew`);
      assert.equal(
        harness.storageData[leaseStorageKey].expiresAt,
        expiresBefore,
        `${context}: a refused renew must not extend the lease`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Control delivery
// ---------------------------------------------------------------------------

test("T4: control delivery applies every probe sequence and never delivers on a non-match", async () => {
  for (const name of Object.keys(probePlans(0))) {
    const tabId = freshTab();
    const run = makeRun({
      runId: `deliver-${tabId}`,
      boundTabId: tabId,
      status: "paused",
      stateRevision: 3,
      boundDocumentId: docFor(tabId).documentId,
      documentInstanceId: docFor(tabId).documentInstanceId
    });
    harness.putRun(tabId, run);

    const plans = probePlans(tabId)[name];
    harness.setIdentityPlan(tabId, plans.plan);
    const deliveredBefore = harness.commandsDelivered(tabId).length;

    const response = await harness.relay(
      { type: "AIPM_RESUME", expectedRunId: run.runId, expectedStateRevision: 3 },
      tabId
    );

    const context = `control delivery / ${name}`;
    const delivered = harness.commandsDelivered(tabId).length - deliveredBefore;
    if (plans.expect === "match") {
      assert.equal(response.ok, true, `${context}: a confirmed document receives the command`);
      assert.equal(delivered, 1, `${context}: exactly one delivery`);
    } else {
      assert.equal(response.ok, false, `${context}: a non-match must not receive the command`);
      assert.equal(
        response.relayErrorCode,
        plans.expect === "mismatch" ? "DOCUMENT_CHANGED_BEFORE_DELIVERY" : "DOCUMENT_IDENTITY_UNCONFIRMED",
        `${context}: the relay must name the exact identity outcome`
      );
      assert.equal(delivered, 0, `${context}: nothing may be delivered`);
    }
  }
});

// ---------------------------------------------------------------------------
// The four cross-cutting properties
// ---------------------------------------------------------------------------

test("T4: a proven mismatch is final - later matching probes are never even attempted", async () => {
  const tabId = freshTab();
  const run = makeRun({ runId: `final-${tabId}`, boundTabId: tabId });
  harness.putRun(tabId, run);
  harness.setIdentityPlan(tabId, [otherDoc(), docFor(tabId), docFor(tabId)]);
  const before = harness.identityProbeCount(tabId);

  const response = await harness.invoke({
    type: "AIPM_RUN_SET",
    run: { ...run, phase: "submitting" },
    runTransition: "runner",
    conversationKey: run.conversationKey,
    documentInstanceId: docFor(tabId).documentInstanceId
  }, senderFor(tabId));

  assert.equal(response.errorCode, "DOCUMENT_IDENTITY_MISMATCH");
  assert.equal(response.identityObservation.outcome, "mismatch");
  assert.equal(
    harness.identityProbeCount(tabId) - before,
    1,
    "a proven mismatch must stop the sequence immediately, so it can never decay into match"
  );
  assert.equal(harness.storedRun(tabId).phase, "ready");
});

test("T4: only the read-only probe is retried - the irreversible delivery happens at most once", async () => {
  const tabId = freshTab();
  const run = makeRun({
    runId: `once-${tabId}`,
    boundTabId: tabId,
    status: "paused",
    stateRevision: 3,
    boundDocumentId: docFor(tabId).documentId,
    documentInstanceId: docFor(tabId).documentInstanceId
  });
  harness.putRun(tabId, run);
  // Two elected probes reject after their public timeout. Only the read-only observation is
  // retried; the mutating delivery that follows must still be single.
  harness.setIdentityPlan(tabId, [delayedReject(), delayedReject(), docFor(tabId)]);
  let deliveries = 0;
  harness.setCommandResponder(tabId, () => {
    deliveries += 1;
    throw new Error("Message port closed before a response was received.");
  });
  const before = harness.identityProbeCount(tabId);

  const response = await harness.relay(
    { type: "AIPM_RESUME", expectedRunId: run.runId, expectedStateRevision: 3 },
    tabId
  );

  assert.ok(harness.identityProbeCount(tabId) - before >= 3, "the read-only probe is the part that retries");
  assert.equal(deliveries, 1, "an ambiguous mutating delivery must never be retried");
  assert.equal(response.ok, false);
  assert.equal(response.relayErrorCode, "COMMAND_DELIVERY_FAILED");
});

test("T4: the bounded recovery episode has a hard probe ceiling", async () => {
  for (const [recovery, attempts] of [[null, 12], [{ mode: "completion", identityAttempts: 5 }, 12],
    [{ mode: "completion", identityAttempts: 10 }, 12], [{ mode: "completion", identityAttempts: 999 }, 12]]) {
    const tabId = freshTab();
    const run = makeRun({ runId: `bounded-${tabId}`, boundTabId: tabId });
    harness.putRun(tabId, run);
    harness.setIdentityPlan(tabId, Array.from({ length: 40 }, () => ({ error: new Error("blocked") })));
    const before = harness.identityProbeCount(tabId);

    const response = await harness.invoke({
      type: "AIPM_RUN_GET",
      conversationKey: run.conversationKey,
      documentInstanceId: docFor(tabId).documentInstanceId,
      readOnlyRecovery: recovery
    }, senderFor(tabId));

    const context = `identityAttempts=${JSON.stringify(recovery)}`;
    assert.equal(harness.identityProbeCount(tabId) - before, attempts, `${context}: exact attempt budget`);
    assert.equal(response.ok, false, `${context}: exhausting the budget must fail closed`);
    assert.equal(response.identityObservation.totalAttempts, attempts);
    assert.ok(response.identityObservation.attempt <= 12, `${context}: reported attempts stay bounded`);
    assert.ok(response.identityObservation.durationMs <= 60_000, `${context}: reported duration stays bounded`);
  }
});

test("T4: identity observations never leak anything but bounded, enumerated fields", async () => {
  const tabId = freshTab();
  const run = makeRun({ runId: `observe-${tabId}`, boundTabId: tabId });
  harness.putRun(tabId, run);
  harness.setIdentityPlan(tabId, Array.from({ length: RECOVERY_PROBE_LIMIT }, () => ({
    rawResults: [{ result: "secret-instance", frameId: 3, documentId: "secret-document" }]
  })));

  const response = await harness.invoke({
    type: "AIPM_RUN_GET",
    conversationKey: run.conversationKey,
    documentInstanceId: docFor(tabId).documentInstanceId
  }, senderFor(tabId));

  assert.equal(response.ok, false);
  assert.deepEqual(
    Object.keys(response.identityObservation).sort(),
    ["attempt", "boundary", "consecutiveUnavailable", "durationMs", "episodeId", "failureCode", "outcome", "reason", "recoveryElapsedMs", "source", "totalAttempts"]
  );
  assert.equal(response.identityObservation.failureCode, "IDENTITY_TOP_FRAME_MISSING");
  assert.equal(response.identityObservation.source, "probe");
  assert.equal(JSON.stringify(response).includes("secret-"), false, "no observed identity value may be echoed back");
});
