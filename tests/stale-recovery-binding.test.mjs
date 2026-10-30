import assert from "node:assert/strict";
import test from "node:test";
import { EXTENSION_VERSION, installBackgroundHarness, makeRun, deferred } from "./helpers/background-harness.mjs";

let nextTab = 38000;
function setup(h) {
  const tabId = ++nextTab;
  const run = makeRun({ runId: `run-${tabId}`, boundTabId: tabId,
    boundDocumentId: `doc-${tabId}`, documentInstanceId: `instance-${tabId}`,
    conversationKey: `chatgpt:c:${tabId}`, executionSessionId: h.sessionId(),
    cursor: { stepIndex: 0, repeatIndex: 8, sendsCompleted: 8 },
    outbox: { state: "confirmed", position: { stepIndex: 0, repeatIndex: 8, sendsCompleted: 8 } } });
  h.putRun(tabId, run);
  h.setDocument(tabId, { documentId: run.boundDocumentId, documentInstanceId: run.documentInstanceId });
  const sender = { tab: { id: tabId }, frameId: 0, documentId: run.boundDocumentId, documentLifecycle: "active" };
  const get = { type: "AIPM_RUN_GET", documentInstanceId: run.documentInstanceId,
    conversationKey: run.conversationKey, authorityBoundary: "recovery" };
  return { tabId, run, sender, get };
}
async function refusal(h, f) {
  const response = await h.invoke(f.get, { ...f.sender, documentLifecycle: "cached" });
  assert.equal(response.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.ok(response.failClosedGuard, "the exact binding owner receives a snapshot-bound stop claim");
  return response;
}
function stopMessage(f, guard) {
  return { type: "AIPM_RUN_FAIL_CLOSED", expectedRunId: f.run.runId,
    documentInstanceId: f.get.documentInstanceId, failClosedGuard: guard,
    reason: "document_identity_unconfirmed", serviceWorkerVersion: EXTENSION_VERSION };
}
async function assertUntouched(h, f, message, sender = f.sender) {
  const before = structuredClone(h.storageData);
  let writes = 0;
  h.setStorageSetFault(() => { writes++; });
  const result = await h.invoke(message, sender);
  h.setStorageSetFault(null);
  assert.equal(result.changed, false);
  assert.equal(result.run, null);
  assert.equal(writes, 0);
  assert.deepEqual(h.storageData, before);
  assert.equal(h.commandsDelivered(f.tabId).length, 0);
  return result;
}

test("exact current binding failure may stop once without resending its confirmed ninth delivery", async () => {
  const h = await installBackgroundHarness(); const f = setup(h);
  const refused = await refusal(h, f);
  const message = stopMessage(f, refused.failClosedGuard);
  const result = await h.invoke(message, f.sender);
  assert.equal(result.changed, true); assert.equal(result.run.status, "paused");
  assert.equal(result.run.outbox.state, "confirmed"); assert.equal(result.run.cursor.sendsCompleted, 8);
  await assertUntouched(h, f, message);
});

for (const change of ["binding", "revision", "session", "conversation", "instance", "stopped", "completed", "pause"]) {
  test(`refusal snapshot cannot stop a same-Run replacement after ${change} changes`, async () => {
    const h = await installBackgroundHarness(); const f = setup(h); const r = await refusal(h, f);
    const replacement = structuredClone(f.run);
    if (change === "binding") replacement.boundDocumentId += "-new";
    if (change === "revision") replacement.stateRevision++;
    if (change === "session") replacement.executionSessionId += "-new";
    if (change === "conversation") replacement.conversationKey += "-new";
    if (change === "instance") replacement.documentInstanceId += "-new";
    if (change === "stopped" || change === "completed") replacement.status = change;
    if (change === "pause") { replacement.pauseRequested = true; replacement.stateRevision++; }
    h.putRun(f.tabId, replacement);
    await assertUntouched(h, f, stopMessage(f, r.failClosedGuard));
  });
}

test("run-id-only and malformed/forged claims cannot read or mutate the current Run", async () => {
  const h = await installBackgroundHarness(); const f = setup(h); const r = await refusal(h, f);
  for (const guard of [undefined, {}, { ...r.failClosedGuard, token: "forged" },
    { ...r.failClosedGuard, stateRevision: 999 }]) {
    let reads = 0; h.setStorageGetFault(() => { reads++; });
    const result = await assertUntouched(h, f, stopMessage(f, guard));
    h.setStorageGetFault(null);
    assert.equal(result.staleFailClosedGuard, true); assert.equal(reads, 0);
  }
});

test("old top first recovery after same-Run rebind receives no stop authority, even with cached lifecycle", async () => {
  const h = await installBackgroundHarness(); const f = setup(h);
  const next = { ...f.run, boundDocumentId: "new-top", documentInstanceId: "new-instance" };
  h.putRun(f.tabId, next); h.setDocument(f.tabId, { documentId: next.boundDocumentId, documentInstanceId: next.documentInstanceId });
  for (const documentLifecycle of ["active", "cached"]) {
    const before = structuredClone(h.storageData);
    const r = await h.invoke({ ...f.get, readOnlyObservation: true }, { ...f.sender, documentLifecycle });
    assert.equal(r.failClosedGuard, undefined); assert.equal(r.runId, undefined);
    assert.equal(r.failClosedAuthorityUnavailable, true);
    assert.deepEqual(h.storageData, before);
  }
});

test("unproven new/current actor during a probe outage is explicitly unresolved and leaves the old Run unchanged", async () => {
  const h = await installBackgroundHarness(); const f = setup(h);
  h.setIdentityPlan(f.tabId, Array.from({ length: 12 }, () => ({ empty: true })));
  const before = structuredClone(h.storageData);
  const r = await h.invoke({ ...f.get, documentInstanceId: "new-instance" }, { ...f.sender, documentId: "new-doc" });
  assert.equal(r.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.equal(r.failClosedGuard, undefined); assert.equal(r.runId, undefined);
  assert.equal(r.failClosedAuthorityUnavailable, true);
  assert.deepEqual(h.storageData, before); assert.equal(h.storedRun(f.tabId).status, "running");
});

test("current new document positively proved before invalidation can stop the exact original binding", async () => {
  const h = await installBackgroundHarness(); const f = setup(h);
  const sender = { ...f.sender, documentId: "current-new-doc" };
  const get = { ...f.get, documentInstanceId: "current-new-instance" };
  h.setDocument(f.tabId, { documentId: sender.documentId, documentInstanceId: get.documentInstanceId });
  let invalidated = false;
  h.setStorageGetFault(async (key) => {
    if (key === `aipm.activeRun.v2.tab.${f.tabId}` && !invalidated) {
      invalidated = true; await h.triggerTabLoading(f.tabId);
    }
  });
  const r = await h.invoke(get, sender); h.setStorageGetFault(null);
  assert.equal(r.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED"); assert.ok(r.failClosedGuard);
  assert.equal(r.failClosedGuard.boundDocumentId, f.run.boundDocumentId);
  const result = await h.invoke({ ...stopMessage(f, r.failClosedGuard), documentInstanceId: get.documentInstanceId }, sender);
  assert.equal(result.changed, true); assert.equal(result.run.status, "paused");
  assert.equal(result.run.boundDocumentId, f.run.boundDocumentId);
  assert.equal(result.run.outbox.state, "confirmed");
});

test("a claim cannot cross lifecycle invalidation or a worker restart retaining the same session", async () => {
  const h = await installBackgroundHarness(); const f = setup(h); const r = await refusal(h, f);
  await h.triggerTabLoading(f.tabId);
  await assertUntouched(h, f, stopMessage(f, r.failClosedGuard));
  const r2 = await refusal(h, f);
  const secondWorker = await installBackgroundHarness(); secondWorker.putRun(f.tabId, structuredClone(f.run));
  await assertUntouched(secondWorker, f, stopMessage(f, r2.failClosedGuard));
});

test("an execution-session rotation invalidates a previous worker-generation claim", async () => {
  const h = await installBackgroundHarness(); const f = setup(h); const r = await refusal(h, f);
  await h.triggerStartup();
  await assertUntouched(h, f, stopMessage(f, r.failClosedGuard));
});

test("old same-document SET cannot turn an identity refusal into a guard for a newer Run revision", async () => {
  const h = await installBackgroundHarness(); const f = setup(h);
  const newer = { ...f.run, stateRevision: f.run.stateRevision + 1 };
  h.putRun(f.tabId, newer);
  const r = await h.invoke({ ...f.get, type: "AIPM_RUN_SET", run: f.run },
    { ...f.sender, documentLifecycle: "cached" });
  assert.equal(r.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.equal(r.failClosedGuard, undefined); assert.equal(r.failClosedAuthorityUnavailable, true);
  assert.deepEqual(h.storedRun(f.tabId), newer);
});

test("new current document failing after its own successful adoption can stop exactly that saved binding", async () => {
  const h = await installBackgroundHarness(); const f = setup(h);
  const sender = { ...f.sender, documentId: "adopted-new-doc" };
  const get = { ...f.get, documentInstanceId: "adopted-new-instance" };
  h.setDocument(f.tabId, { documentId: sender.documentId, documentInstanceId: get.documentInstanceId });
  let invalidated = false;
  h.setStorageSetFault(async values => {
    if (values[`aipm.activeRun.v2.tab.${f.tabId}`] && !invalidated) {
      invalidated = true; await h.triggerTabLoading(f.tabId);
    }
  });
  const r = await h.invoke(get, sender); h.setStorageSetFault(null);
  assert.equal(r.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.equal(r.failClosedGuard.boundDocumentId, sender.documentId);
  const result = await h.invoke({ ...stopMessage(f, r.failClosedGuard), documentInstanceId: get.documentInstanceId }, sender);
  assert.equal(result.changed, true); assert.equal(result.run.boundDocumentId, sender.documentId);
  assert.equal(result.run.outbox.state, "confirmed");
});

test("an own-adoption refusal still cannot stop a later same-Run replacement", async () => {
  const h = await installBackgroundHarness(); const f = setup(h);
  const sender = { ...f.sender, documentId: "adoption-race-doc" };
  const get = { ...f.get, documentInstanceId: "adoption-race-instance" };
  h.setDocument(f.tabId, { documentId: sender.documentId, documentInstanceId: get.documentInstanceId });
  h.setStorageSetFault(async values => {
    if (values[`aipm.activeRun.v2.tab.${f.tabId}`]) await h.triggerTabLoading(f.tabId);
  });
  const r = await h.invoke(get, sender); h.setStorageSetFault(null); assert.ok(r.failClosedGuard);
  h.putRun(f.tabId, { ...h.storedRun(f.tabId), stateRevision: f.run.stateRevision + 1 });
  await assertUntouched(h, f, { ...stopMessage(f, r.failClosedGuard), documentInstanceId: get.documentInstanceId }, sender);
});

test("failed adoption writes do not issue a claim for an uncommitted binding", async () => {
  const h = await installBackgroundHarness(); const f = setup(h);
  const sender = { ...f.sender, documentId: "failed-adoption-doc" };
  const get = { ...f.get, documentInstanceId: "failed-adoption-instance" };
  h.setDocument(f.tabId, { documentId: sender.documentId, documentInstanceId: get.documentInstanceId });
  h.setStorageSetFault(() => { throw new Error("synthetic storage write failure"); });
  const r = await h.invoke(get, sender); h.setStorageSetFault(null);
  assert.equal(r.ok, false); assert.equal(r.failClosedGuard, undefined);
  assert.deepEqual(h.storedRun(f.tabId), f.run);
});

test("claimed stop rechecks epoch after its storage read and has no delayed write effect", async () => {
  const h = await installBackgroundHarness(); const f = setup(h); const r = await refusal(h, f);
  let invalidated = false;
  h.setStorageGetFault(async key => {
    if (key === `aipm.activeRun.v2.tab.${f.tabId}` && !invalidated) {
      invalidated = true; await h.triggerTabLoading(f.tabId);
    }
  });
  await assertUntouched(h, f, stopMessage(f, r.failClosedGuard));
  h.setStorageGetFault(null);
});

test("claims cannot be transferred to another document, instance, tab or missing frame metadata", async () => {
  const h = await installBackgroundHarness(); const f = setup(h); const r = await refusal(h, f);
  for (const sender of [{ ...f.sender, documentId: "other-doc" },
    { ...f.sender, tab: { id: f.tabId + 1 } }, { ...f.sender, frameId: undefined }]) {
    await assertUntouched(h, f, stopMessage(f, r.failClosedGuard), sender);
  }
  await assertUntouched(h, f, { ...stopMessage(f, r.failClosedGuard), documentInstanceId: "other-instance" });
  const legitimate = await h.invoke(stopMessage(f, r.failClosedGuard), f.sender);
  assert.equal(legitimate.changed, true, "rejected foreign callers do not consume the owner's claim");
});

test("claim retention is bounded and expires without refreshing authority from a later Run", async () => {
  const h = await installBackgroundHarness(); const f = setup(h);
  const first = await refusal(h, f);
  let latest;
  for (let i = 0; i < 128; i++) latest = await refusal(h, f);
  await assertUntouched(h, f, stopMessage(f, first.failClosedGuard));
  const realNow = Date.now; const future = realNow() + 60_001;
  Date.now = () => future;
  try { await assertUntouched(h, f, stopMessage(f, latest.failClosedGuard)); }
  finally { Date.now = realNow; }
  assert.equal(h.storedRun(f.tabId).status, "running", "expired evidence cannot durably stop even an unchanged Run");
});

for (const missing of ["boundDocumentId", "documentInstanceId"]) {
  test(`internal lifecycle stop still works with ${missing} absent and the other actor identity present`, async () => {
    const h = await installBackgroundHarness(); const f = setup(h);
    delete f.run[missing]; h.putRun(f.tabId, f.run);
    const r = await h.invoke({ ...f.get, readOnlyObservation: true }, { ...f.sender, documentLifecycle: "cached" });
    assert.equal(r.lifecycleCommitted, true); assert.equal(r.lifecycleContextStale, false);
    assert.equal(h.storedRun(f.tabId).status, "paused");
  });
}

test("refresh invalidation does not promote a replacement revision to the original refusal's stop target", async () => {
  const h = await installBackgroundHarness(); const f = setup(h);
  let changed = false;
  const replacement = { ...f.run, stateRevision: f.run.stateRevision + 1 };
  h.setStorageGetFault(async key => {
    if (key === `aipm.activeRun.v2.tab.${f.tabId}` && !changed) {
      changed = true; h.putRun(f.tabId, replacement); await h.triggerTabLoading(f.tabId);
    }
  });
  const r = await h.invoke(f.get, f.sender); h.setStorageGetFault(null);
  assert.equal(r.failClosedGuard.stateRevision, f.run.stateRevision);
  await assertUntouched(h, f, stopMessage(f, r.failClosedGuard));
});

test("lease failure cannot upgrade a previous revision claim to a same-document newer Run", async () => {
  const h = await installBackgroundHarness(); const f = setup(h);
  const loaded = await h.invoke(f.get, f.sender);
  const newer = { ...f.run, stateRevision: f.run.stateRevision + 1 }; h.putRun(f.tabId, newer);
  const r = await h.invoke({ type: "AIPM_LEASE_RENEW", runId: f.run.runId,
    conversationKey: f.run.conversationKey, executionSessionId: f.run.executionSessionId,
    documentInstanceId: f.run.documentInstanceId, nonce: "old-nonce",
    failClosedGuard: loaded.failClosedGuard, serviceWorkerVersion: EXTENSION_VERSION },
  { ...f.sender, documentLifecycle: "cached" });
  assert.equal(r.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.equal(r.failClosedGuard, undefined); assert.equal(r.failClosedAuthorityUnavailable, true);
  assert.deepEqual(h.storedRun(f.tabId), newer);
});

test("regular successful lease renewal refreshes only the same Run snapshot stop claim across the TTL", async () => {
  const h = await installBackgroundHarness(); const f = setup(h);
  const loaded = await h.invoke(f.get, f.sender);
  const message = { type: "AIPM_LEASE_ACQUIRE", runId: f.run.runId,
    conversationKey: f.run.conversationKey, executionSessionId: f.run.executionSessionId,
    documentInstanceId: f.run.documentInstanceId, nonce: "lease-nonce",
    failClosedGuard: loaded.failClosedGuard, serviceWorkerVersion: EXTENSION_VERSION };
  const acquired = await h.invoke(message, f.sender); assert.ok(acquired.lease); assert.ok(acquired.failClosedGuard);
  const realNow = Date.now; let now = realNow(); Date.now = () => now;
  try {
    let guard = acquired.failClosedGuard;
    for (let i = 0; i < 4; i++) {
      now += 20_000;
      const renewed = await h.invoke({ ...message, type: "AIPM_LEASE_RENEW", nonce: acquired.lease.nonce, failClosedGuard: guard }, f.sender);
      assert.equal(renewed.renewed, true); assert.ok(renewed.failClosedGuard); guard = renewed.failClosedGuard;
    }
    const stopped = await h.invoke(stopMessage(f, guard), f.sender); assert.equal(stopped.changed, true);
  } finally { Date.now = realNow; }
});

test("inactive recovery cannot coalesce into an active sender's in-flight observation", async () => {
  const h = await installBackgroundHarness(); const f = setup(h);
  const replacement = { ...f.run, boundDocumentId: "coalescing-new-doc", documentInstanceId: "coalescing-new-instance" };
  h.putRun(f.tabId, replacement);
  const pending = deferred(); const entered = deferred();
  h.setIdentityPlan(f.tabId, [async () => { entered.resolve(); return pending.promise; }]);
  const message = { ...f.get, readOnlyObservation: true };
  const active = h.invoke(message, f.sender); await entered.promise;
  let timer;
  try {
    const cached = await Promise.race([
      h.invoke(message, { ...f.sender, documentLifecycle: "cached" }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("cached sender joined active proof")), 1000); })
    ]);
    // Distinct sender metadata is not coalesced. The existing bounded gate
    // refuses its competing observation without inheriting the active proof.
    assert.equal(cached.errorCode, "READ_ONLY_CONTACT_BUSY");
    assert.equal(cached.ok, false);
    assert.equal(cached.failClosedGuard, undefined); assert.equal(cached.runId, undefined);
  } finally {
    clearTimeout(timer);
    pending.resolve({ documentId: replacement.boundDocumentId, documentInstanceId: replacement.documentInstanceId });
  }
  await active; assert.deepEqual(h.storedRun(f.tabId), replacement);
});
