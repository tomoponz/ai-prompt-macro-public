// T5 — lease torture.
//
// Issue #27: a lease release that is never confirmed used to self-wedge the exact same
// running Run on its next prompt, turning one transient cleanup failure into a
// non-resumable Run. The fix is an exact-owner recovery path, which is dangerous in the
// opposite direction: it must not become a way for a competing tab or a replacement Run to
// take a conversation that a live owner still holds.
//
// The central sequence is therefore:
//
//   successful Prompt A -> lease release transport reject -> release ok:false equivalent
//   -> next Prompt B
//
// combined with stale owner, expired lease, reloaded document, same document and
// replacement Run.
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SESSION_ID,
  EXTENSION_VERSION,
  installBackgroundHarness,
  leaseKey,
  makeRun
} from "./helpers/background-harness.mjs";

const harness = await installBackgroundHarness();

let nextTabId = 5000;
function freshTab(documentSuffix = "1") {
  nextTabId += 1;
  const tabId = nextTabId;
  const doc = { documentId: `document-${tabId}-${documentSuffix}`, documentInstanceId: `instance-${tabId}-${documentSuffix}` };
  harness.setTabs([{ id: tabId, active: true, windowId: 1, url: "https://chatgpt.com/" }]);
  harness.setDocument(tabId, doc);
  harness.setIdentityPlan(tabId, []);
  return { tabId, doc };
}

function senderFor(tabId, doc) {
  return { tab: { id: tabId }, documentId: doc.documentId };
}

function leaseMessage(type, { conversationKey, runId, doc, nonce = undefined }) {
  return {
    type,
    conversationKey,
    runId,
    documentInstanceId: doc.documentInstanceId,
    ...(nonce === undefined ? {} : { nonce }),
    serviceWorkerVersion: EXTENSION_VERSION,
    executionSessionId: DEFAULT_SESSION_ID
  };
}

// The identity probe must answer with whatever document is currently on top of the tab.
function pinDocument(tabId, doc) {
  harness.setDocument(tabId, doc);
  harness.setIdentityPlan(tabId, []);
}

async function acquire(tabId, doc, conversationKey, runId) {
  return harness.invoke(
    leaseMessage("AIPM_LEASE_ACQUIRE", { conversationKey, runId, doc }),
    senderFor(tabId, doc)
  );
}

async function release(tabId, doc, conversationKey, runId, nonce) {
  return harness.invoke(
    leaseMessage("AIPM_LEASE_RELEASE", { conversationKey, runId, doc, nonce }),
    senderFor(tabId, doc)
  );
}

test("T5: an unconfirmed release lets the exact same owner recover its own lease for Prompt B", async () => {
  const { tabId, doc } = freshTab();
  const conversationKey = `chatgpt:c:lease-recover-${tabId}`;
  const run = makeRun({
    runId: `owner-${tabId}`,
    boundTabId: tabId,
    boundDocumentId: doc.documentId,
    documentInstanceId: doc.documentInstanceId,
    status: "running"
  });
  harness.putRun(tabId, run);
  pinDocument(tabId, doc);

  // Prompt A: acquire, use, and then fail to confirm the release.
  const first = await acquire(tabId, doc, conversationKey, run.runId);
  assert.ok(first.lease?.nonce, "Prompt A must be able to take the conversation lease");
  const nonce = first.lease.nonce;

  // (a) transport reject: the content script's release never reaches background at all, so
  //     the durable lease is simply still there.
  assert.ok(harness.storageData[leaseKey(conversationKey)], "an unsent release leaves the lease stored");

  // (b) `ok:false` equivalent: background answered but did not release, e.g. because the
  //     request could not be proven to own the lease.
  const notReleased = await release(tabId, doc, conversationKey, run.runId, "a-nonce-that-is-not-ours");
  assert.notEqual(notReleased.released, true, "a non-owning release must not report a release");
  assert.ok(harness.storageData[leaseKey(conversationKey)], "an unconfirmed release must keep the lease stored");

  // Prompt B: the exact same Run, tab, session and document must be able to continue.
  const second = await acquire(tabId, doc, conversationKey, run.runId);
  assert.equal(second.ok, true);
  assert.equal(second.recoveredExistingOwner, true, "the exact owner must recover its own lease, not conflict with it");
  assert.equal(second.lease.nonce, nonce, "recovery must keep the same lease identity");
});

test("T5: while the owner is live, no competing document can take the conversation", async () => {
  const { tabId, doc } = freshTab();
  const conversationKey = `chatgpt:c:lease-fence-${tabId}`;
  const run = makeRun({
    runId: `owner-${tabId}`,
    boundTabId: tabId,
    boundDocumentId: doc.documentId,
    documentInstanceId: doc.documentInstanceId
  });
  harness.putRun(tabId, run);
  pinDocument(tabId, doc);
  const owned = await acquire(tabId, doc, conversationKey, run.runId);
  assert.ok(owned.lease?.nonce);

  // A second tab, on the same conversation, with its own Run.
  const competing = freshTab("competing");
  harness.putRun(competing.tabId, makeRun({
    runId: `competitor-${competing.tabId}`,
    boundTabId: competing.tabId,
    boundDocumentId: competing.doc.documentId,
    documentInstanceId: competing.doc.documentInstanceId
  }));
  pinDocument(competing.tabId, competing.doc);

  const blocked = await acquire(competing.tabId, competing.doc, conversationKey, `competitor-${competing.tabId}`);
  assert.equal(blocked.ok, true);
  assert.equal(blocked.lease, null, "a competing document must not receive the conversation lease");
  assert.equal(
    harness.storageData[leaseKey(conversationKey)].nonce,
    owned.lease.nonce,
    "a refused acquire must not disturb the live owner's lease"
  );

  // Even after the lease TTL lapses, a live running owner keeps the fence.
  harness.storageData[leaseKey(conversationKey)] = {
    ...harness.storageData[leaseKey(conversationKey)],
    expiresAt: Date.now() - 1
  };
  const stillBlocked = await acquire(competing.tabId, competing.doc, conversationKey, `competitor-${competing.tabId}`);
  assert.equal(stillBlocked.lease, null, "an expired lease must stay fenced while its owner Run is running");
  assert.equal(stillBlocked.blockedByRunningOwner, true);
});

test("T5: a stale owner whose Run is no longer running releases the conversation on expiry", async () => {
  const { tabId, doc } = freshTab();
  const conversationKey = `chatgpt:c:lease-stale-${tabId}`;
  const run = makeRun({
    runId: `stale-${tabId}`,
    boundTabId: tabId,
    boundDocumentId: doc.documentId,
    documentInstanceId: doc.documentInstanceId
  });
  harness.putRun(tabId, run);
  pinDocument(tabId, doc);
  const owned = await acquire(tabId, doc, conversationKey, run.runId);
  assert.ok(owned.lease?.nonce);

  // The owner Run reached a terminal state, and its lease then expired.
  harness.putRun(tabId, { ...run, status: "stopped" });
  harness.storageData[leaseKey(conversationKey)] = {
    ...harness.storageData[leaseKey(conversationKey)],
    expiresAt: Date.now() - 1
  };

  const next = freshTab("next");
  harness.putRun(next.tabId, makeRun({
    runId: `next-${next.tabId}`,
    boundTabId: next.tabId,
    boundDocumentId: next.doc.documentId,
    documentInstanceId: next.doc.documentInstanceId
  }));
  pinDocument(next.tabId, next.doc);
  const taken = await acquire(next.tabId, next.doc, conversationKey, `next-${next.tabId}`);

  assert.ok(taken.lease?.nonce, "an expired lease whose owner is no longer running may be taken");
  assert.notEqual(taken.lease.nonce, owned.lease.nonce, "the new owner must get a fresh lease identity");
});

test("T5: an expired lease is still refused while the owner Run is running", async () => {
  const { tabId, doc } = freshTab();
  const conversationKey = `chatgpt:c:lease-expired-${tabId}`;
  const run = makeRun({
    runId: `live-${tabId}`,
    boundTabId: tabId,
    boundDocumentId: doc.documentId,
    documentInstanceId: doc.documentInstanceId
  });
  harness.putRun(tabId, run);
  pinDocument(tabId, doc);
  const owned = await acquire(tabId, doc, conversationKey, run.runId);
  harness.storageData[leaseKey(conversationKey)] = {
    ...harness.storageData[leaseKey(conversationKey)],
    expiresAt: Date.now() - 1
  };

  // The exact owner may still renew its own expired lease, because it still holds the nonce
  // and its Run is still the live owner.
  const renewed = await harness.invoke(
    leaseMessage("AIPM_LEASE_RENEW", { conversationKey, runId: run.runId, doc, nonce: owned.lease.nonce }),
    senderFor(tabId, doc)
  );
  assert.equal(renewed.renewed, true, "the exact owner may recover its own expired lease");
  assert.ok(harness.storageData[leaseKey(conversationKey)].expiresAt > Date.now());
});

test("T5: a reloaded document rebinds the same Run's lease with a fresh identity", async () => {
  const { tabId, doc } = freshTab("before-reload");
  const conversationKey = `chatgpt:c:lease-reload-${tabId}`;
  const run = makeRun({
    runId: `reload-${tabId}`,
    boundTabId: tabId,
    boundDocumentId: doc.documentId,
    documentInstanceId: doc.documentInstanceId
  });
  harness.putRun(tabId, run);
  pinDocument(tabId, doc);
  const before = await acquire(tabId, doc, conversationKey, run.runId);
  assert.ok(before.lease?.nonce);

  // Ctrl+R: a replacement document adopts the same durable Run.
  const reloaded = { documentId: `document-${tabId}-after-reload`, documentInstanceId: `instance-${tabId}-after-reload` };
  harness.putRun(tabId, { ...run, boundDocumentId: reloaded.documentId, documentInstanceId: reloaded.documentInstanceId });
  pinDocument(tabId, reloaded);

  const after = await acquire(tabId, reloaded, conversationKey, run.runId);
  assert.equal(after.ok, true);
  assert.equal(after.reboundAfterReload, true, "a reloaded document must be able to rebind its own Run's lease");
  assert.notEqual(after.lease.nonce, before.lease.nonce, "the pre-reload nonce must not survive the document change");
  assert.equal(harness.storageData[leaseKey(conversationKey)].documentId, reloaded.documentId);

  // The pre-reload document must not be able to keep using its old nonce.
  const staleRenew = await harness.invoke(
    leaseMessage("AIPM_LEASE_RENEW", { conversationKey, runId: run.runId, doc, nonce: before.lease.nonce }),
    senderFor(tabId, doc)
  );
  assert.notEqual(staleRenew.renewed, true, "a superseded document must not renew the rebound lease");
});

test("T5: a replacement Run in the same tab cannot inherit the previous Run's lease", async () => {
  const { tabId, doc } = freshTab();
  const conversationKey = `chatgpt:c:lease-replacement-${tabId}`;
  const runA = makeRun({
    runId: `replaced-A-${tabId}`,
    boundTabId: tabId,
    boundDocumentId: doc.documentId,
    documentInstanceId: doc.documentInstanceId
  });
  harness.putRun(tabId, runA);
  pinDocument(tabId, doc);
  const leaseA = await acquire(tabId, doc, conversationKey, runA.runId);
  assert.ok(leaseA.lease?.nonce);

  // Run A ends and replacement Run B starts in the same tab and document.
  const runB = makeRun({
    runId: `replaced-B-${tabId}`,
    boundTabId: tabId,
    boundDocumentId: doc.documentId,
    documentInstanceId: doc.documentInstanceId,
    replacesRunId: runA.runId
  });
  harness.putRun(tabId, runB);

  const inherited = await acquire(tabId, doc, conversationKey, runB.runId);
  assert.equal(inherited.lease, null, "a different Run must not inherit an unexpired lease");
  assert.notEqual(inherited.recoveredExistingOwner, true);

  // Only once the previous lease has lapsed may the replacement Run take the conversation,
  // and it must get its own identity.
  harness.storageData[leaseKey(conversationKey)] = {
    ...harness.storageData[leaseKey(conversationKey)],
    expiresAt: Date.now() - 1
  };
  const taken = await acquire(tabId, doc, conversationKey, runB.runId);
  assert.ok(taken.lease?.nonce, "after expiry the replacement Run may take the conversation");
  assert.notEqual(taken.lease.nonce, leaseA.lease.nonce, "the replacement must not reuse Run A's lease identity");
});

test("T5: a confirmed release actually frees the conversation for the next owner", async () => {
  const { tabId, doc } = freshTab();
  const conversationKey = `chatgpt:c:lease-release-${tabId}`;
  const run = makeRun({
    runId: `release-${tabId}`,
    boundTabId: tabId,
    boundDocumentId: doc.documentId,
    documentInstanceId: doc.documentInstanceId
  });
  harness.putRun(tabId, run);
  pinDocument(tabId, doc);
  const owned = await acquire(tabId, doc, conversationKey, run.runId);

  const released = await release(tabId, doc, conversationKey, run.runId, owned.lease.nonce);
  assert.equal(released.released, true);
  assert.equal(harness.storageData[leaseKey(conversationKey)], undefined, "a confirmed release removes the lease");

  const other = freshTab("after-release");
  harness.putRun(other.tabId, makeRun({
    runId: `after-${other.tabId}`,
    boundTabId: other.tabId,
    boundDocumentId: other.doc.documentId,
    documentInstanceId: other.doc.documentInstanceId
  }));
  pinDocument(other.tabId, other.doc);
  const next = await acquire(other.tabId, other.doc, conversationKey, `after-${other.tabId}`);
  assert.ok(next.lease?.nonce, "a released conversation is available again");
});

test("T5: lease operations are refused outside the current browser execution session", async () => {
  const { tabId, doc } = freshTab();
  const conversationKey = `chatgpt:c:lease-session-${tabId}`;
  harness.putRun(tabId, makeRun({
    runId: `session-${tabId}`,
    boundTabId: tabId,
    boundDocumentId: doc.documentId,
    documentInstanceId: doc.documentInstanceId
  }));
  pinDocument(tabId, doc);

  const staleSession = await harness.invoke({
    ...leaseMessage("AIPM_LEASE_ACQUIRE", { conversationKey, runId: `session-${tabId}`, doc }),
    executionSessionId: "a-previous-browser-session"
  }, senderFor(tabId, doc));
  assert.equal(staleSession.ok, false, "a lease request from a previous browser session must be refused");
  assert.equal(harness.storageData[leaseKey(conversationKey)], undefined);

  const staleVersion = await harness.invoke({
    ...leaseMessage("AIPM_LEASE_ACQUIRE", { conversationKey, runId: `session-${tabId}`, doc }),
    serviceWorkerVersion: "0.0.0"
  }, senderFor(tabId, doc));
  assert.equal(staleVersion.ok, false, "a lease request from a mismatched content version must be refused");
  assert.equal(harness.storageData[leaseKey(conversationKey)], undefined);
});

test("T5: a lease request without a real ChatGPT conversation key is refused", async () => {
  const { tabId, doc } = freshTab();
  pinDocument(tabId, doc);
  for (const conversationKey of ["", "not-chatgpt", "https://example.com", null]) {
    const response = await harness.invoke(
      leaseMessage("AIPM_LEASE_ACQUIRE", { conversationKey, runId: `bad-${tabId}`, doc }),
      senderFor(tabId, doc)
    );
    assert.equal(response.ok, false, `conversationKey=${JSON.stringify(conversationKey)} must be refused`);
  }
});

test("T5: a release that does not own the lease cannot free it for someone else", async () => {
  const { tabId, doc } = freshTab();
  const conversationKey = `chatgpt:c:lease-hijack-${tabId}`;
  const run = makeRun({
    runId: `hijack-owner-${tabId}`,
    boundTabId: tabId,
    boundDocumentId: doc.documentId,
    documentInstanceId: doc.documentInstanceId
  });
  harness.putRun(tabId, run);
  pinDocument(tabId, doc);
  const owned = await acquire(tabId, doc, conversationKey, run.runId);
  assert.ok(owned.lease?.nonce);

  const attacker = freshTab("attacker");
  harness.putRun(attacker.tabId, makeRun({
    runId: `hijack-attacker-${attacker.tabId}`,
    boundTabId: attacker.tabId,
    boundDocumentId: attacker.doc.documentId,
    documentInstanceId: attacker.doc.documentInstanceId
  }));
  pinDocument(attacker.tabId, attacker.doc);

  // Even holding the correct nonce, a different document/tab must not be able to release it.
  const forced = await release(
    attacker.tabId,
    attacker.doc,
    conversationKey,
    `hijack-attacker-${attacker.tabId}`,
    owned.lease.nonce
  );
  assert.notEqual(forced.released, true);
  assert.equal(
    harness.storageData[leaseKey(conversationKey)]?.nonce,
    owned.lease.nonce,
    "only the exact owner may release the conversation lease"
  );
});
