import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {
  EXTENSION_VERSION, activeRunKey, deferred, installBackgroundHarness, leaseKey, makeRun
} from "./helpers/background-harness.mjs";

const runnerSource = fs.readFileSync(new URL("../src/content-runner.js", import.meta.url), "utf8");
let nextTabId = 31_000;

async function fixture() {
  const harness = await installBackgroundHarness();
  const tabId = ++nextTabId;
  const documentId = `worker-document-${tabId}`;
  const documentInstanceId = `worker-instance-${tabId}`;
  const conversationKey = `chatgpt:c:worker-${tabId}`;
  const run = makeRun({
    runId: `worker-run-${tabId}`, boundTabId: tabId, boundDocumentId: documentId,
    documentInstanceId, conversationKey, executionSessionId: harness.sessionId()
  });
  harness.setDocument(tabId, { documentId, documentInstanceId });
  harness.putRun(tabId, run);
  const lease = {
    runId: run.runId, tabId, documentId, documentInstanceId,
    nonce: `worker-nonce-${tabId}`, executionSessionId: run.executionSessionId,
    expiresAt: Date.now() + 15_000
  };
  harness.storageData[leaseKey(conversationKey)] = lease;
  return {
    harness, tabId, run, lease,
    sender: { tab: { id: tabId }, frameId: 0, documentId, documentLifecycle: "active" },
    read: { type: "AIPM_RUN_GET", conversationKey, documentInstanceId,
      readOnlyObservation: true, authorityBoundary: "readiness" },
    renew: { type: "AIPM_LEASE_RENEW", conversationKey, documentInstanceId,
      runId: run.runId, nonce: lease.nonce, executionSessionId: run.executionSessionId,
      serviceWorkerVersion: EXTENSION_VERSION }
  };
}

async function restartWorker(f) {
  const local = structuredClone(f.harness.storageData);
  const session = structuredClone(f.harness.sessionStorageData);
  const fresh = await installBackgroundHarness();
  Object.assign(fresh.storageData, local);
  Object.assign(fresh.sessionStorageData, session);
  fresh.setDocument(f.tabId, {
    documentId: f.sender.documentId, documentInstanceId: f.run.documentInstanceId
  });
  f.harness = fresh;
}

function clockFor(t) {
  const clock = { now: Date.now() };
  t.mock.method(Date, "now", () => clock.now);
  return clock;
}

function unavailableProbes(f, clock, beforeFailure = null) {
  f.harness.setIdentityPlan(f.tabId, Array.from({ length: 32 }, () => async () => {
    if (beforeFailure) await beforeFailure();
    // Exhaust the unchanged production recovery deadline without a real ten-second wait.
    clock.now += 11_000;
    return { error: new Error("synthetic renderer identity unavailable") };
  }));
}

function runnerContext(f, clock, hooks = {}) {
  const events = [];
  const context = vm.createContext({
    Date: class extends Date { static now() { return clock.now; } },
    POLL_MS: 100, LEASE_HEARTBEAT_MS: 5_000, RUN_OBSERVATION_INTERVAL_MS: 1_200,
    GENERATION_TIMEOUT_MS: 30 * 60_000,
    makeError: (code) => Object.assign(new Error(code), { code }),
    getActiveRun: async () => {
      events.push("AIPM_RUN_GET");
      const response = await f.harness.invoke(f.read, f.sender);
      assert.equal(response.ok, true);
      if (hooks.afterRead) await hooks.afterRead();
      return response.run;
    },
    renewLease: async () => {
      events.push("AIPM_LEASE_RENEW");
      const response = await f.harness.invoke(f.renew, f.sender);
      if (!response.ok) throw Object.assign(new Error(response.errorCode), { code: response.errorCode });
      return response.renewed;
    },
    sleep: async () => { if (hooks.sleep) await hooks.sleep(); }
  });
  vm.runInContext(runnerSource, context);
  context.assertLocalRunnerToken = () => {};
  context.assertConversationStillMatches = () => {};
  context.readCurrentPageObservation = () => ({
    blocker: null, generationState: hooks.generationState?.() ?? "idle"
  });
  return { context, events };
}

test("queued readiness response makes renewal first after worker restart without losing its exact owner", async (t) => {
  const clock = clockFor(t);
  const f = await fixture();
  const responseQueued = deferred();
  const thaw = deferred();
  const runner = runnerContext(f, clock, { afterRead: async () => {
    responseQueued.resolve();
    await thaw.promise;
  } });
  const result = runner.context.waitUntilReady(f.run, 1, 30 * 60_000, f.lease)
    .then(() => null, (error) => error);
  await responseQueued.promise;
  clock.now += 60_000;
  await restartWorker(f);
  unavailableProbes(f, clock);
  runner.events.length = 0;
  thaw.resolve();
  const error = await result;
  assert.deepEqual(runner.events, ["AIPM_LEASE_RENEW"]);
  assert.equal(error, null, "the same durable owner must survive a queued response and cold worker");
  assert.equal(f.harness.storageData[leaseKey(f.run.conversationKey)].nonce, f.lease.nonce);
  assert.equal(f.harness.commandsDelivered(f.tabId).length, 0);
});

test("sleep-first control reads the Run again before renewing after worker restart", async (t) => {
  const clock = clockFor(t);
  const f = await fixture();
  let generating = true;
  let runner;
  runner = runnerContext(f, clock, {
    generationState: () => generating ? "generating" : "idle",
    sleep: async () => {
      clock.now += 60_000;
      await restartWorker(f);
      unavailableProbes(f, clock);
      generating = false;
      runner.events.length = 0;
    }
  });
  await runner.context.waitUntilReady(f.run, 1, 30 * 60_000, f.lease);
  assert.deepEqual(runner.events, ["AIPM_RUN_GET", "AIPM_LEASE_RENEW"]);
  assert.equal(f.harness.commandsDelivered(f.tabId).length, 0);
});

test("exact renewal changes only expiry, including confirmed delivery with Pause pending", async (t) => {
  const clock = clockFor(t);
  const f = await fixture();
  f.run = { ...f.run, phase: "generating", pauseRequested: true,
    outbox: { id: "synthetic-confirmed", state: "confirmed" } };
  f.harness.putRun(f.tabId, f.run);
  const beforeRun = structuredClone(f.run);
  const beforeLease = structuredClone(f.lease);
  clock.now += 60_000;
  unavailableProbes(f, clock);
  const response = await f.harness.invoke(f.renew, f.sender);
  assert.equal(response.renewed, true);
  assert.equal(response.identityObservation.source, "bound-content-sender");
  assert.deepEqual(f.harness.storedRun(f.tabId), beforeRun);
  assert.deepEqual(f.harness.storageData[leaseKey(f.run.conversationKey)], {
    ...beforeLease, expiresAt: clock.now + 15_000
  });
  assert.equal(f.harness.commandsDelivered(f.tabId).length, 0);
});

test("renewal fallback creates no grant and does not expand acquisition or release", async (t) => {
  const clock = clockFor(t);
  const f = await fixture();
  unavailableProbes(f, clock);
  assert.equal((await f.harness.invoke(f.renew, f.sender)).renewed, true);
  const before = structuredClone(f.harness.storageData[leaseKey(f.run.conversationKey)]);
  const probesBefore = f.harness.identityProbeCount(f.tabId);
  for (const type of ["AIPM_LEASE_ACQUIRE", "AIPM_LEASE_RELEASE"]) {
    const response = await f.harness.invoke({ ...f.renew, type }, f.sender);
    assert.equal(response.ok, false);
    assert.equal(response.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
    assert.equal(response.identityObservation.source, "probe");
    assert.deepEqual(f.harness.storageData[leaseKey(f.run.conversationKey)], before);
  }
  assert.equal(f.harness.identityProbeCount(f.tabId), probesBefore + 2);
});

test("renewal fallback refuses every mismatched durable owner or sender field", async (t) => {
  const clock = clockFor(t);
  const mutations = [
    ["Run id", (f) => { f.run.runId = "other-run"; }],
    ["Run session", (f) => { f.run.executionSessionId = "other-session"; }],
    ["Run conversation", (f) => { f.run.conversationKey = "chatgpt:c:other"; }],
    ["Run tab", (f) => { f.run.boundTabId += 1; }],
    ["Run browser document", (f) => { f.run.boundDocumentId = "other-document"; }],
    ["Run content instance", (f) => { f.run.documentInstanceId = "other-instance"; }],
    ["paused Run", (f) => { f.run.status = "paused"; }],
    ["stopped Run", (f) => { f.run.status = "stopped"; }],
    ["completed Run", (f) => { f.run.status = "completed"; }],
    ["missing Run", (f) => { delete f.harness.storageData[activeRunKey(f.tabId)]; }],
    ["Lease id", (f) => { f.lease.runId = "other-run"; }],
    ["Lease session", (f) => { f.lease.executionSessionId = "other-session"; }],
    ["Lease tab", (f) => { f.lease.tabId += 1; }],
    ["Lease browser document", (f) => { f.lease.documentId = "other-document"; }],
    ["Lease content instance", (f) => { f.lease.documentInstanceId = "other-instance"; }],
    ["Lease nonce", (f) => { f.lease.nonce = "replacement-nonce"; }],
    ["missing Lease", (f) => { delete f.harness.storageData[leaseKey(f.renew.conversationKey)]; }],
    ["missing nonce", (f) => { delete f.renew.nonce; }],
    ["empty nonce", (f) => { f.renew.nonce = ""; }],
    ["request session", (f) => { f.renew.executionSessionId = "other-session"; }],
    ["request version", (f) => { f.renew.serviceWorkerVersion = "other-version"; }],
    ["subframe", (f) => { f.sender.frameId = 3; }],
    ["inactive document", (f) => { f.sender.documentLifecycle = "cached"; }],
    ["missing browser document", (f) => { delete f.sender.documentId; }],
    ["missing instance", (f) => { delete f.renew.documentInstanceId; }]
  ];
  for (const [name, mutate] of mutations) {
    const f = await fixture();
    mutate(f);
    unavailableProbes(f, clock);
    const before = structuredClone(f.harness.storageData);
    const response = await f.harness.invoke(f.renew, f.sender);
    assert.notEqual(response.renewed, true, name);
    assert.deepEqual(f.harness.storageData, before, name);
    assert.equal(f.harness.commandsDelivered(f.tabId).length, 0, name);
  }
});

test("positive document mismatch cannot use the unavailable-identity fallback", async (t) => {
  clockFor(t);
  const f = await fixture();
  f.harness.setDocument(f.tabId, { documentId: "replacement-document", documentInstanceId: "replacement-instance" });
  const before = structuredClone(f.harness.storageData);
  const response = await f.harness.invoke(f.renew, f.sender);
  assert.equal(response.errorCode, "DOCUMENT_IDENTITY_MISMATCH");
  assert.notEqual(response.renewed, true);
  assert.deepEqual(f.harness.storageData, before);
});

test("owner, nonce, and lifecycle changes during unavailable probes remain fenced", async (t) => {
  const clock = clockFor(t);
  const changes = [
    ["Stop", async (f) => { f.harness.putRun(f.tabId, { ...f.run, status: "stopped" }); }],
    ["replacement Run", async (f) => { f.harness.putRun(f.tabId, { ...f.run, runId: "replacement-run" }); }],
    ["replacement binding", async (f) => { f.harness.putRun(f.tabId, { ...f.run, documentInstanceId: "replacement-instance" }); }],
    ["replacement nonce", async (f) => { f.harness.storageData[leaseKey(f.run.conversationKey)].nonce = "replacement-nonce"; }],
    ["navigation", (f) => f.harness.triggerTabLoading(f.tabId)],
    ["new browser session", (f) => f.harness.triggerStartup()]
  ];
  for (const [name, change] of changes) {
    const f = await fixture();
    const entered = deferred();
    const release = deferred();
    unavailableProbes(f, clock, async () => { entered.resolve(); await release.promise; });
    const pending = f.harness.invoke(f.renew, f.sender);
    await entered.promise;
    await change(f);
    const before = structuredClone(f.harness.storageData);
    release.resolve();
    const response = await pending;
    assert.notEqual(response.renewed, true, name);
    assert.deepEqual(f.harness.storageData, before, name);
  }
});

test("fallback waits for an already-pending durable Pause before validating ownership", async (t) => {
  const clock = clockFor(t);
  const f = await fixture();
  const probeEntered = deferred();
  const releaseProbe = deferred();
  f.harness.setIdentityPlan(f.tabId, [async () => {
    probeEntered.resolve();
    await releaseProbe.promise;
    clock.now += 11_000;
    return { error: new Error("synthetic renderer identity unavailable") };
  }]);
  const renewal = f.harness.invoke(f.renew, f.sender);
  await probeEntered.promise;
  const writeEntered = deferred();
  const releaseWrite = deferred();
  f.harness.setStorageSetFault(async (values) => {
    if (values[activeRunKey(f.tabId)]?.status === "paused") {
      writeEntered.resolve();
      await releaseWrite.promise;
    }
  });
  const pause = f.harness.invoke({
    type: "AIPM_RUN_SET", run: { ...f.run, status: "paused", pauseReason: "user-pause" },
    conversationKey: f.run.conversationKey, documentInstanceId: f.run.documentInstanceId,
    runTransition: "pause", authorityBoundary: "control"
  }, f.sender);
  await writeEntered.promise;
  releaseProbe.resolve();
  let renewalSettled = false;
  void renewal.then(() => { renewalSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(renewalSettled, false, "fallback must wait behind the durable Run mutation");
  releaseWrite.resolve();
  assert.equal((await pause).ok, true);
  assert.notEqual((await renewal).renewed, true);
  assert.equal(f.harness.storedRun(f.tabId).status, "paused");
  assert.deepEqual(f.harness.storageData[leaseKey(f.run.conversationKey)], f.lease);
});

test("lifecycle invalidation during final durable read prevents renewal", async (t) => {
  const clock = clockFor(t);
  const f = await fixture();
  unavailableProbes(f, clock);
  f.harness.setStorageGetFault(async (keys) => {
    if (Array.isArray(keys) && keys.includes(leaseKey(f.run.conversationKey))) {
      f.harness.setStorageGetFault(null);
      await f.harness.triggerTabLoading(f.tabId);
    }
  });
  const before = structuredClone(f.harness.storageData);
  assert.notEqual((await f.harness.invoke(f.renew, f.sender)).renewed, true);
  assert.deepEqual(f.harness.storageData, before);
});

test("exact Stop intent wins while fallback holds the Run queue for its final read", async (t) => {
  const clock = clockFor(t);
  const f = await fixture();
  f.harness.setTabs([{ id: f.tabId, active: true, windowId: 1, url: "https://chatgpt.com/" }]);
  unavailableProbes(f, clock);
  let stop;
  f.harness.setStorageGetFault(async (keys) => {
    if (Array.isArray(keys) && keys.includes(leaseKey(f.run.conversationKey))) {
      f.harness.setStorageGetFault(null);
      stop = f.harness.relay({ type: "AIPM_STOP", expectedRunId: f.run.runId }, f.tabId);
      // Allow Stop to record its immediate intent, then queue behind this Run read.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
  const beforeLease = structuredClone(f.lease);
  const response = await f.harness.invoke(f.renew, f.sender);
  assert.notEqual(response.renewed, true);
  assert.ok(stop, "the Stop race must actually be exercised");
  assert.equal((await stop).stopCommitted, true);
  assert.equal(f.harness.storedRun(f.tabId).status, "stopped");
  assert.deepEqual(f.harness.storageData[leaseKey(f.run.conversationKey)], beforeLease);
});
