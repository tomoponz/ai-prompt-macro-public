import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const contentControllerSource = fs.readFileSync(new URL("../src/content-controller.js", import.meta.url), "utf8");

const listeners = {
  installed: [],
  startup: [],
  message: [],
  alarm: [],
  tabRemoved: []
};
const storageData = {};
const sessionStorageData = { "aipm.executionSession.v1": "session-test" };
const alarms = new Map();
const tabMessages = [];
const tabQueries = [];
const scriptExecutions = [];
const powerRequests = [];
const powerEvents = [];
let powerReleaseCount = 0;
let storageGetGate = null;
let storageGetMatchKey = null;
let storageGetEntered = null;
let storageGetNeverOnceKey = null;
let storageSetGate = null;
let storageSetMatchKey = null;
let storageSetEntered = null;
let queryTabs = [{ id: 77, active: true, windowId: 1, url: "https://chatgpt.com/" }];
let queryError = null;
let queryNeverResolves = false;
let siteAccessGranted = true;
let siteAccessNeverResolves = false;
let sessionSetFailuresRemaining = 0;
let relayResponse = { ok: true, provider: "chatgpt", contentVersion: "0.4.0", pageReady: true };
const relayResponsesByTab = new Map();
let statusMessageResponder = null;
let sendFailuresRemaining = 0;
let commandFailuresRemaining = 0;
const receiverUnavailableUntilInjectedTabs = new Set();
const injectedTabs = new Set();
const currentDocumentIds = new Map();
const currentDocumentInstanceIds = new Map();
const documentIdentityProbePlans = new Map();
const documentIdentityProbeCounts = new Map();
const statusNeverTabs = new Set();
const probeNeverTabs = new Set();
const probeErrorTabs = new Set();
const probeResultsByTab = new Map();
let injectionGate = null;
let probeResult = { origin: "https://chatgpt.com", corePresent: false, controllerReady: false, version: null };

globalThis.chrome = {
  runtime: {
    getManifest() { return { version: "0.4.0" }; },
    onInstalled: { addListener(fn) { listeners.installed.push(fn); } },
    onStartup: { addListener(fn) { listeners.startup.push(fn); } },
    onMessage: { addListener(fn) { listeners.message.push(fn); } }
  },
  sidePanel: {
    async setPanelBehavior() {}
  },
  permissions: {
    async contains(details) {
      assert.deepEqual(details, { origins: ["https://chatgpt.com/*"] });
      if (siteAccessNeverResolves) return new Promise(() => {});
      return siteAccessGranted;
    }
  },
  storage: {
    local: {
      async get(key) {
        let result;
        if (typeof key === "string") result = { [key]: storageData[key] };
        else if (Array.isArray(key)) result = Object.fromEntries(key.map((item) => [item, storageData[item]]));
        else result = { ...storageData };
        const neverOnceMatches = storageGetNeverOnceKey &&
          ((typeof key === "string" && key === storageGetNeverOnceKey) ||
            (Array.isArray(key) && key.includes(storageGetNeverOnceKey)));
        if (neverOnceMatches) {
          storageGetNeverOnceKey = null;
          return new Promise(() => {});
        }
        const matchesGate = storageGetGate && storageGetMatchKey &&
          ((typeof key === "string" && key === storageGetMatchKey) ||
            (Array.isArray(key) && key.includes(storageGetMatchKey)));
        if (matchesGate) {
          storageGetEntered?.();
          await storageGetGate.promise;
        }
        return result;
      },
      async set(values) {
        if (storageSetGate && storageSetMatchKey && Object.hasOwn(values, storageSetMatchKey)) {
          storageSetEntered?.();
          await storageSetGate.promise;
        }
        Object.assign(storageData, values);
      },
      async remove(key) {
        for (const item of Array.isArray(key) ? key : [key]) delete storageData[item];
      }
    },
    session: {
      async get(key) {
        if (typeof key === "string") return { [key]: sessionStorageData[key] };
        if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, sessionStorageData[item]]));
        return { ...sessionStorageData };
      },
      async set(values) {
        if (sessionSetFailuresRemaining > 0) {
          sessionSetFailuresRemaining -= 1;
          throw new Error("transient session storage failure");
        }
        Object.assign(sessionStorageData, values);
      },
      async remove(key) {
        for (const item of Array.isArray(key) ? key : [key]) delete sessionStorageData[item];
      }
    }
  },
  alarms: {
    onAlarm: { addListener(fn) { listeners.alarm.push(fn); } },
    create(name, info) { alarms.set(name, { name, ...info }); },
    async clear(name) { return alarms.delete(name); },
    async get(name) { return alarms.get(name) ?? null; }
  },
  tabs: {
    onRemoved: { addListener(fn) { listeners.tabRemoved.push(fn); } },
    async query(query) {
      tabQueries.push(query);
      if (queryNeverResolves) return new Promise(() => {});
      if (queryError) {
        const error = queryError;
        queryError = null;
        throw error;
      }
      return queryTabs;
    },
    async sendMessage(tabId, payload) {
      tabMessages.push({ tabId, payload });
      if (payload?.type === "AIPM_GET_STATUS" && statusNeverTabs.has(tabId)) return new Promise(() => {});
      if (payload?.type === "AIPM_GET_STATUS" && receiverUnavailableUntilInjectedTabs.has(tabId) && !injectedTabs.has(tabId)) {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }
      if (sendFailuresRemaining > 0) {
        sendFailuresRemaining -= 1;
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }
      if (payload?.type === "AIPM_GET_STATUS") {
        if (statusMessageResponder) return statusMessageResponder(payload);
        return {
          provider: "chatgpt",
          contentVersion: "0.4.0",
          conversationKey: `chatgpt:c:tab-${tabId}`,
          instanceId: `instance-${tabId}`,
          ...(relayResponsesByTab.get(tabId) ?? relayResponse)
        };
      }
      if (commandFailuresRemaining > 0) {
        commandFailuresRemaining -= 1;
        throw new Error("Message port closed before a response was received.");
      }
      return { ok: true };
    }
  },
  scripting: {
    async executeScript(details) {
      scriptExecutions.push(details);
      if (details.func) {
        const isDocumentIdentityProbe = String(details.func).includes("__AIPM_DOCUMENT_INSTANCE_ID__");
        if (isDocumentIdentityProbe) {
          const tabId = details.target.tabId;
          documentIdentityProbeCounts.set(tabId, (documentIdentityProbeCounts.get(tabId) ?? 0) + 1);
          const plan = documentIdentityProbePlans.get(tabId);
          if (Array.isArray(plan) && plan.length > 0) {
            let outcome = plan.shift();
            if (typeof outcome === "function") outcome = await outcome();
            if (outcome?.error) throw outcome.error;
            if (Object.hasOwn(outcome ?? {}, "rawResults")) return outcome.rawResults;
            if (outcome?.empty === true) return [];
            return [{
              result: outcome?.documentInstanceId ?? null,
              frameId: Object.hasOwn(outcome ?? {}, "frameId") ? outcome.frameId : 0,
              documentId: outcome?.documentId ?? null
            }];
          }
        }
        if (probeNeverTabs.has(details.target.tabId)) return new Promise(() => {});
        if (probeErrorTabs.has(details.target.tabId)) throw new Error("executeScript blocked on device");
        return [{
          result: isDocumentIdentityProbe
            ? (currentDocumentInstanceIds.get(details.target.tabId) ?? null)
            : (probeResultsByTab.get(details.target.tabId) ?? probeResult),
          frameId: 0,
          documentId: currentDocumentIds.has(details.target.tabId)
            ? currentDocumentIds.get(details.target.tabId)
            : `document-${details.target.tabId}`
        }];
      }
      if (details.files) {
        if (injectionGate) await injectionGate.promise;
        injectedTabs.add(details.target.tabId);
        return [{ result: null }];
      }
      return [];
    }
  },
  power: {
    requestKeepAwake(level) {
      powerRequests.push(level);
      powerEvents.push(`request:${level}`);
    },
    releaseKeepAwake() {
      powerReleaseCount += 1;
      powerEvents.push("release");
    }
  }
};

await import(`../src/background.js?test=${Date.now()}`);

function invokeRuntimeMessage(message, sender = {}) {
  return new Promise((resolve, reject) => {
    let handled = false;
    for (const listener of listeners.message) {
      const result = listener(message, sender, resolve);
      if (result === true) handled = true;
    }
    if (!handled) reject(new Error("message was not handled"));
  });
}

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function createContentStatusResponder(runGetResponse) {
  const contentListeners = [];
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: () => "status-boundary-run" },
    recoveryStarted: false,
    instanceId: "status-boundary-instance",
    SCHEMA_VERSION: 1,
    DIAGNOSTICS_KEY: "aipm.diagnostics.v1",
    ChatGptAdapter: {
      id: "chatgpt",
      getConversationKey: () => "chatgpt:c:status-boundary",
      matches: () => true,
      readPageObservation: () => ({ composer: {}, generationState: "idle", blocker: null })
    },
    chrome: {
      runtime: {
        async sendMessage(message) {
          if (message.type === "AIPM_RUN_GET") return structuredClone(runGetResponse);
          return { ok: true };
        },
        onMessage: {
          addListener(listener) {
            contentListeners.push(listener);
          }
        }
      },
      storage: {
        local: {
          async get() { return {}; }
        }
      }
    }
  });
  context.__AIPM_CONTENT_CORE__ = { version: "0.4.0", ready: true };
  vm.runInContext(contentControllerSource, context);
  return (message) => new Promise((resolve, reject) => {
    const handled = contentListeners[0](message, {}, resolve);
    if (handled !== true) reject(new Error("content status message was not handled"));
  });
}

test("scheduler arms an alarm and persists metadata", async () => {
  const whenMs = Date.now() + 60_000;
  const response = await invokeRuntimeMessage(
    {
      type: "AIPM_ARM_ALARM",
      runId: "run-1",
      stepId: "wait-1",
      whenMs,
      serviceWorkerVersion: "0.4.0",
      executionSessionId: "session-test"
    },
    { tab: { id: 42 } }
  );
  assert.equal(response.ok, true);
  assert.equal(alarms.size, 1);
  const schedules = storageData["aipm.schedules.v1"];
  const schedule = Object.values(schedules)[0];
  assert.equal(schedule.runId, "run-1");
  assert.equal(schedule.stepId, "wait-1");
  assert.equal(schedule.tabId, 42);
  assert.equal(schedule.whenMs, whenMs);
});

test("alarm firing persists a wake signal and notifies the bound tab", async () => {
  const [alarm] = alarms.values();
  assert.ok(alarm);
  await listeners.alarm[0](alarm);

  const signals = storageData["aipm.alarmSignals.v1"];
  const signal = Object.values(signals)[0];
  assert.equal(signal.runId, "run-1");
  assert.equal(signal.stepId, "wait-1");
  assert.ok(signal.firedAt >= signal.scheduledAt - 60_000);
  assert.equal(tabMessages.at(-1).tabId, 42);
  assert.equal(tabMessages.at(-1).payload.type, "AIPM_ALARM_FIRED");
});

test("clearing a schedule removes alarm metadata and signal", async () => {
  const response = await invokeRuntimeMessage({
    type: "AIPM_CLEAR_ALARM",
    runId: "run-1",
    stepId: "wait-1",
    serviceWorkerVersion: "0.4.0",
    executionSessionId: "session-test"
  });
  assert.equal(response.ok, true);
  assert.equal(Object.keys(storageData["aipm.schedules.v1"]).length, 0);
  assert.equal(Object.keys(storageData["aipm.alarmSignals.v1"]).length, 0);
});

test("arming a new schedule clears a stale wake signal with the reused key", async () => {
  const runId = "signal-rearm-run";
  const stepId = "signal-rearm-step";
  const name = `aipm.wait.${encodeURIComponent(runId)}.${encodeURIComponent(stepId)}`;
  storageData["aipm.alarmSignals.v1"] = {
    ...(storageData["aipm.alarmSignals.v1"] ?? {}),
    [name]: {
      runId,
      stepId,
      scheduledAt: Date.now() - 60_000,
      firedAt: Date.now() - 59_000,
      executionSessionId: "session-test"
    }
  };

  const response = await invokeRuntimeMessage({
    type: "AIPM_ARM_ALARM",
    runId,
    stepId,
    whenMs: Date.now() + 60_000,
    serviceWorkerVersion: "0.4.0",
    executionSessionId: "session-test"
  }, { tab: { id: 43 } });

  assert.equal(response.ok, true);
  assert.equal(storageData["aipm.alarmSignals.v1"][name], undefined);
  delete storageData["aipm.schedules.v1"][name];
  alarms.delete(name);
});

test("stale content cannot arm an alarm in the current browser session", async () => {
  const before = alarms.size;
  const response = await invokeRuntimeMessage({
    type: "AIPM_ARM_ALARM",
    runId: "stale-alarm",
    stepId: "wait",
    whenMs: Date.now() + 60_000,
    serviceWorkerVersion: "0.2.5",
    executionSessionId: "old-session"
  }, { tab: { id: 42 } });
  assert.equal(response.ok, false);
  assert.equal(alarms.size, before);
});

test("two tabs can arm schedules concurrently without losing either map entry", async () => {
  const scheduleMessage = (runId, stepId) => ({
    type: "AIPM_ARM_ALARM",
    runId,
    stepId,
    whenMs: Date.now() + 60_000,
    serviceWorkerVersion: "0.4.0",
    executionSessionId: "session-test"
  });
  const [first, second] = await Promise.all([
    invokeRuntimeMessage(scheduleMessage("run-a", "wait-a"), { tab: { id: 41 } }),
    invokeRuntimeMessage(scheduleMessage("run-b", "wait-b"), { tab: { id: 42 } })
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(Object.keys(storageData["aipm.schedules.v1"]).length, 2);
});

test("two tabs acquire independent background-serialized leases for different conversations", async () => {
  currentDocumentIds.set(141, "lease-document-a");
  currentDocumentIds.set(142, "lease-document-b");
  const request = (conversationKey, runId, documentInstanceId) => ({
    type: "AIPM_LEASE_ACQUIRE",
    conversationKey,
    runId,
    documentInstanceId,
    serviceWorkerVersion: "0.4.0",
    executionSessionId: "session-test"
  });
  const [first, second] = await Promise.all([
    invokeRuntimeMessage(request("chatgpt:c:lease-a", "lease-run-a", "lease-instance-a"), { tab: { id: 141 }, documentId: "lease-document-a" }),
    invokeRuntimeMessage(request("chatgpt:c:lease-b", "lease-run-b", "lease-instance-b"), { tab: { id: 142 }, documentId: "lease-document-b" })
  ]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.ok(first.lease);
  assert.ok(second.lease);
  assert.ok(storageData[`aipm.lease.v2.${encodeURIComponent("chatgpt:c:lease-a")}`]);
  assert.ok(storageData[`aipm.lease.v2.${encodeURIComponent("chatgpt:c:lease-b")}`]);
});

test("concurrent same-conversation acquisition grants exactly one lease", async () => {
  const conversationKey = "chatgpt:c:lease-shared";
  const storageKey = `aipm.lease.v2.${encodeURIComponent(conversationKey)}`;
  delete storageData[storageKey];
  currentDocumentIds.set(143, "lease-shared-a");
  currentDocumentIds.set(144, "lease-shared-b");
  const request = (runId, documentInstanceId) => ({
    type: "AIPM_LEASE_ACQUIRE",
    conversationKey,
    runId,
    documentInstanceId,
    serviceWorkerVersion: "0.4.0",
    executionSessionId: "session-test"
  });
  const results = await Promise.all([
    invokeRuntimeMessage(request("lease-shared-run-a", "lease-shared-instance-a"), { tab: { id: 143 }, documentId: "lease-shared-a" }),
    invokeRuntimeMessage(request("lease-shared-run-b", "lease-shared-instance-b"), { tab: { id: 144 }, documentId: "lease-shared-b" })
  ]);

  assert.equal(results.filter((result) => result.lease).length, 1);
  assert.ok(storageData[storageKey]);
});

test("an expired owner cannot renew while a queued contender takes the lease", async () => {
  const conversationKey = "chatgpt:c:lease-expiry";
  const storageKey = `aipm.lease.v2.${encodeURIComponent(conversationKey)}`;
  delete storageData[storageKey];
  currentDocumentIds.set(145, "lease-expiry-old");
  currentDocumentIds.set(146, "lease-expiry-new");
  const acquired = await invokeRuntimeMessage({
    type: "AIPM_LEASE_ACQUIRE",
    conversationKey,
    runId: "lease-expiry-old-run",
    documentInstanceId: "lease-expiry-old-instance",
    serviceWorkerVersion: "0.4.0",
    executionSessionId: "session-test"
  }, { tab: { id: 145 }, documentId: "lease-expiry-old" });
  storageData[storageKey].expiresAt = Date.now() - 1;

  const [renewed, takeover] = await Promise.all([
    invokeRuntimeMessage({
      type: "AIPM_LEASE_RENEW",
      conversationKey,
      runId: "lease-expiry-old-run",
      nonce: acquired.lease.nonce,
      documentInstanceId: "lease-expiry-old-instance",
      serviceWorkerVersion: "0.4.0",
      executionSessionId: "session-test"
    }, { tab: { id: 145 }, documentId: "lease-expiry-old" }),
    invokeRuntimeMessage({
      type: "AIPM_LEASE_ACQUIRE",
      conversationKey,
      runId: "lease-expiry-new-run",
      documentInstanceId: "lease-expiry-new-instance",
      serviceWorkerVersion: "0.4.0",
      executionSessionId: "session-test"
    }, { tab: { id: 146 }, documentId: "lease-expiry-new" })
  ]);

  assert.equal(renewed.renewed, false);
  assert.ok(takeover.lease);
  assert.equal(storageData[storageKey].runId, "lease-expiry-new-run");
});

test("timer throttling cannot transfer an expired lease while its owner Run is still running", async () => {
  const conversationKey = "chatgpt:c:lease-throttled";
  const storageKey = `aipm.lease.v2.${encodeURIComponent(conversationKey)}`;
  const runKey = "aipm.activeRun.v2.tab.147";
  delete storageData[storageKey];
  currentDocumentIds.set(147, "lease-throttled-old");
  currentDocumentIds.set(148, "lease-throttled-new");
  storageData[runKey] = {
    runId: "lease-throttled-old-run",
    executionSessionId: "session-test",
    status: "running"
  };
  const acquired = await invokeRuntimeMessage({
    type: "AIPM_LEASE_ACQUIRE",
    conversationKey,
    runId: "lease-throttled-old-run",
    documentInstanceId: "lease-throttled-old-instance",
    serviceWorkerVersion: "0.4.0",
    executionSessionId: "session-test"
  }, { tab: { id: 147 }, documentId: "lease-throttled-old" });
  assert.ok(acquired.lease);
  storageData[storageKey].expiresAt = Date.now() - 60_000;

  const blocked = await invokeRuntimeMessage({
    type: "AIPM_LEASE_ACQUIRE",
    conversationKey,
    runId: "lease-throttled-new-run",
    documentInstanceId: "lease-throttled-new-instance",
    serviceWorkerVersion: "0.4.0",
    executionSessionId: "session-test"
  }, { tab: { id: 148 }, documentId: "lease-throttled-new" });
  assert.equal(blocked.lease, null);
  assert.equal(blocked.blockedByRunningOwner, true);
  assert.equal(storageData[storageKey].runId, "lease-throttled-old-run");

  storageData[runKey].status = "paused";
  const takeover = await invokeRuntimeMessage({
    type: "AIPM_LEASE_ACQUIRE",
    conversationKey,
    runId: "lease-throttled-new-run",
    documentInstanceId: "lease-throttled-new-instance",
    serviceWorkerVersion: "0.4.0",
    executionSessionId: "session-test"
  }, { tab: { id: 148 }, documentId: "lease-throttled-new" });
  assert.ok(takeover.lease);
  assert.equal(storageData[storageKey].runId, "lease-throttled-new-run");
});

test("a throttled exact owner can renew an expired lease while contenders remain fenced", async () => {
  const conversationKey = "chatgpt:c:lease-owner-heartbeat";
  const storageKey = `aipm.lease.v2.${encodeURIComponent(conversationKey)}`;
  const runKey = "aipm.activeRun.v2.tab.151";
  delete storageData[storageKey];
  currentDocumentIds.set(151, "lease-owner-heartbeat-document");
  currentDocumentIds.set(152, "lease-owner-contender-document");
  storageData[runKey] = {
    runId: "lease-owner-heartbeat-run",
    executionSessionId: "session-test",
    status: "running"
  };
  const acquired = await invokeRuntimeMessage({
    type: "AIPM_LEASE_ACQUIRE",
    conversationKey,
    runId: "lease-owner-heartbeat-run",
    documentInstanceId: "lease-owner-heartbeat-instance",
    serviceWorkerVersion: "0.4.0",
    executionSessionId: "session-test"
  }, { tab: { id: 151 }, documentId: "lease-owner-heartbeat-document" });
  storageData[storageKey].expiresAt = Date.now() - 60_000;

  const renewed = await invokeRuntimeMessage({
    type: "AIPM_LEASE_RENEW",
    conversationKey,
    runId: "lease-owner-heartbeat-run",
    nonce: acquired.lease.nonce,
    documentInstanceId: "lease-owner-heartbeat-instance",
    serviceWorkerVersion: "0.4.0",
    executionSessionId: "session-test"
  }, { tab: { id: 151 }, documentId: "lease-owner-heartbeat-document" });
  assert.equal(renewed.renewed, true);
  assert.ok(storageData[storageKey].expiresAt > Date.now());

  const contender = await invokeRuntimeMessage({
    type: "AIPM_LEASE_ACQUIRE",
    conversationKey,
    runId: "lease-owner-contender-run",
    documentInstanceId: "lease-owner-contender-instance",
    serviceWorkerVersion: "0.4.0",
    executionSessionId: "session-test"
  }, { tab: { id: 152 }, documentId: "lease-owner-contender-document" });
  assert.equal(contender.lease, null);
  assert.equal(storageData[storageKey].runId, "lease-owner-heartbeat-run");
});

test("a current reloaded document can rebind its own running Run lease without opening takeover", async () => {
  const conversationKey = "chatgpt:c:lease-reload";
  const storageKey = `aipm.lease.v2.${encodeURIComponent(conversationKey)}`;
  const runKey = "aipm.activeRun.v2.tab.149";
  delete storageData[storageKey];
  currentDocumentIds.set(149, "lease-reload-old-document");
  currentDocumentIds.set(150, "lease-reload-contender-document");
  storageData[runKey] = {
    runId: "lease-reload-run",
    executionSessionId: "session-test",
    status: "running",
    boundDocumentId: "lease-reload-old-document",
    documentInstanceId: "lease-reload-old-instance",
    outbox: { state: "confirmed" }
  };
  const oldLease = await invokeRuntimeMessage({
    type: "AIPM_LEASE_ACQUIRE",
    conversationKey,
    runId: "lease-reload-run",
    documentInstanceId: "lease-reload-old-instance",
    serviceWorkerVersion: "0.4.0",
    executionSessionId: "session-test"
  }, { tab: { id: 149 }, documentId: "lease-reload-old-document" });
  assert.ok(oldLease.lease);

  currentDocumentIds.set(149, "lease-reload-new-document");
  storageData[runKey] = {
    ...storageData[runKey],
    boundDocumentId: "lease-reload-new-document",
    documentInstanceId: "lease-reload-new-instance"
  };
  const rebound = await invokeRuntimeMessage({
    type: "AIPM_LEASE_ACQUIRE",
    conversationKey,
    runId: "lease-reload-run",
    documentInstanceId: "lease-reload-new-instance",
    serviceWorkerVersion: "0.4.0",
    executionSessionId: "session-test"
  }, { tab: { id: 149 }, documentId: "lease-reload-new-document" });
  assert.ok(rebound.lease);
  assert.equal(rebound.reboundAfterReload, true);
  assert.notEqual(rebound.lease.nonce, oldLease.lease.nonce);
  assert.equal(storageData[storageKey].documentId, "lease-reload-new-document");

  storageData[storageKey].expiresAt = Date.now() - 60_000;
  const contender = await invokeRuntimeMessage({
    type: "AIPM_LEASE_ACQUIRE",
    conversationKey,
    runId: "lease-reload-contender-run",
    documentInstanceId: "lease-reload-contender-instance",
    serviceWorkerVersion: "0.4.0",
    executionSessionId: "session-test"
  }, { tab: { id: 150 }, documentId: "lease-reload-contender-document" });
  assert.equal(contender.lease, null);
  assert.equal(contender.blockedByRunningOwner, true);
  assert.equal(storageData[storageKey].runId, "lease-reload-run");
});

test("the exact running owner can recover its same-document lease after an ambiguous release", async () => {
  const tabId = 153;
  const documentId = "lease-recover-document";
  const documentInstanceId = "lease-recover-instance";
  const conversationKey = "chatgpt:c:lease-recover";
  const runId = "lease-recover-run";
  const storageKey = `aipm.lease.v2.${encodeURIComponent(conversationKey)}`;
  currentDocumentIds.set(tabId, documentId);
  currentDocumentInstanceIds.set(tabId, documentInstanceId);
  storageData[`aipm.activeRun.v2.tab.${tabId}`] = {
    runId,
    status: "running",
    executionSessionId: "session-test",
    boundTabId: tabId,
    boundDocumentId: documentId,
    documentInstanceId
  };
  storageData[storageKey] = {
    runId,
    nonce: "lease-recover-existing-nonce",
    tabId,
    documentId,
    documentInstanceId,
    executionSessionId: "session-test",
    expiresAt: Date.now() + 15_000
  };

  const recovered = await invokeRuntimeMessage({
    type: "AIPM_LEASE_ACQUIRE",
    conversationKey,
    runId,
    documentInstanceId,
    serviceWorkerVersion: "0.4.0",
    executionSessionId: "session-test"
  }, { tab: { id: tabId }, documentId });

  assert.equal(recovered.ok, true);
  assert.equal(recovered.lease?.nonce, "lease-recover-existing-nonce");
  assert.equal(recovered.recoveredExistingOwner, true);
  assert.equal(storageData[storageKey].runId, runId);
});

test("ISSUE23: Lease acquire and renew retry only transient identity reads", async () => {
  const tabId = 239;
  const conversationKey = "chatgpt:c:issue23-lease";
  const storageKey = `aipm.lease.v2.${encodeURIComponent(conversationKey)}`;
  delete storageData[storageKey];
  const documentId = "issue23-lease-document";
  const documentInstanceId = "issue23-lease-instance";
  documentIdentityProbeCounts.set(tabId, 0);
  documentIdentityProbePlans.set(tabId, [
    { error: new Error("transient lease identity read") },
    { documentId, documentInstanceId }
  ]);

  const acquired = await invokeRuntimeMessage({
    type: "AIPM_LEASE_ACQUIRE",
    conversationKey,
    runId: "issue23-lease-run",
    documentInstanceId,
    serviceWorkerVersion: "0.4.0",
    executionSessionId: "session-test"
  }, { tab: { id: tabId }, documentId });
  assert.equal(acquired.ok, true);
  assert.ok(acquired.lease);
  assert.equal(documentIdentityProbeCounts.get(tabId), 2);
  assert.equal(storageData[storageKey].nonce, acquired.lease.nonce);

  documentIdentityProbeCounts.set(tabId, 0);
  documentIdentityProbePlans.set(tabId, [
    { error: new Error("transient lease renewal identity read") },
    { documentId, documentInstanceId }
  ]);
  const renewed = await invokeRuntimeMessage({
    type: "AIPM_LEASE_RENEW",
    conversationKey,
    runId: "issue23-lease-run",
    nonce: acquired.lease.nonce,
    documentInstanceId,
    serviceWorkerVersion: "0.4.0",
    executionSessionId: "session-test"
  }, { tab: { id: tabId }, documentId });
  assert.equal(renewed.ok, true);
  assert.equal(renewed.renewed, true);
  assert.equal(documentIdentityProbeCounts.get(tabId), 2);
  assert.equal(storageData[storageKey].nonce, acquired.lease.nonce, "renewal does not create a second lease");

  const beforeUnavailable = structuredClone(storageData[storageKey]);
  documentIdentityProbeCounts.set(tabId, 0);
  documentIdentityProbePlans.set(tabId, Array.from({ length: 12 }, () => ({
    error: new Error("lease identity unavailable")
  })));
  const rejected = await invokeRuntimeMessage({
    type: "AIPM_LEASE_RENEW",
    conversationKey,
    runId: "issue23-lease-run",
    nonce: acquired.lease.nonce,
    documentInstanceId,
    serviceWorkerVersion: "0.4.0",
    executionSessionId: "session-test"
  }, { tab: { id: tabId }, documentId });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.equal(documentIdentityProbeCounts.get(tabId), 12);
  assert.deepEqual(storageData[storageKey], beforeUnavailable, "unconfirmed renewal cannot mutate the lease");
});

test("relay routes Side Panel messages through the background to an active tab", async () => {
  queryTabs = [{ id: 77, active: true, windowId: 1 }];
  relayResponse = { ok: true, pageReady: true, run: null };
  const response = await invokeRuntimeMessage({
    type: "AIPM_RELAY_TO_CHATGPT",
    payload: { type: "AIPM_GET_STATUS" }
  });
  assert.equal(response.ok, true);
  assert.equal(response.pageReady, true);
  assert.equal(response.contentVersion, "0.4.0");
  assert.equal(tabMessages.at(-1).tabId, 77);
  assert.equal(tabMessages.at(-1).payload.type, "AIPM_GET_STATUS");
  assert.equal(tabQueries.at(-1).active, true);
});

test("structured Run observation failure survives the actual content listener and background status relay", async () => {
  const tabId = 407;
  queryTabs = [{ id: tabId, active: true, windowId: 1, url: "https://chatgpt.com/c/status-boundary" }];
  statusMessageResponder = createContentStatusResponder({
    ok: false,
    errorCode: "RUN_OBSERVATION_TIMEOUT",
    errorPhase: "run-observation",
    retryAfterMs: 1200,
    error: "raw internal timeout details"
  });
  try {
    const response = await invokeRuntimeMessage({
      type: "AIPM_RELAY_TO_CHATGPT",
      targetTabId: tabId,
      payload: { type: "AIPM_GET_STATUS" }
    });

    assert.equal(response.ok, false);
    assert.equal(response.relayErrorCode, "RUN_OBSERVATION_TIMEOUT");
    assert.equal(response.relayErrorPhase, "run-observation");
    assert.equal(response.retryAfterMs, 1200);
    assert.doesNotMatch(response.relayError, /raw internal|RUN_OBSERVATION_TIMEOUT/);
    assert.equal(Object.hasOwn(response, "stack"), false);
  } finally {
    statusMessageResponder = null;
  }
});

test("structured status failures cannot authorize Start, Resume, or content mutation delivery", async () => {
  const tabId = 408;
  queryTabs = [{ id: tabId, active: true, windowId: 1, url: "https://chatgpt.com/c/status-authority" }];
  statusMessageResponder = createContentStatusResponder({
    ok: false,
    errorCode: "READ_ONLY_CONTACT_BUSY",
    errorPhase: "read-only-observation",
    error: "raw busy details"
  });
  const beforeMessages = tabMessages.length;
  try {
    const start = await invokeRuntimeMessage({
      type: "AIPM_RELAY_TO_CHATGPT",
      targetTabId: tabId,
      payload: { type: "AIPM_START", workflow: { id: "must-not-start" } }
    });
    const resume = await invokeRuntimeMessage({
      type: "AIPM_RELAY_TO_CHATGPT",
      targetTabId: tabId,
      payload: {
        type: "AIPM_RESUME",
        expectedRunId: "must-not-resume",
        expectedStateRevision: 1
      }
    });

    assert.equal(start.ok, false);
    assert.equal(start.relayErrorCode, "READ_ONLY_CONTACT_BUSY");
    assert.equal(resume.ok, false);
    assert.equal(resume.relayErrorCode, "READ_ONLY_CONTACT_BUSY");
    const delivered = tabMessages.slice(beforeMessages).map(({ payload }) => payload.type);
    assert.deepEqual(delivered, ["AIPM_GET_STATUS", "AIPM_GET_STATUS"]);
    assert.equal(delivered.includes("AIPM_START"), false);
    assert.equal(delivered.includes("AIPM_RESUME"), false);
  } finally {
    statusMessageResponder = null;
  }
});

test("relay explicitly targets a selected ChatGPT tab without relying on active-tab state", async () => {
  queryTabs = [{ id: 77, active: true, windowId: 1 }, { id: 88, active: false, windowId: 1 }];
  relayResponsesByTab.set(88, { ok: true, pageReady: true, run: null });
  const beforeQueries = tabQueries.length;
  const response = await invokeRuntimeMessage({
    type: "AIPM_RELAY_TO_CHATGPT",
    targetTabId: 88,
    payload: { type: "AIPM_GET_STATUS" }
  });
  assert.equal(response.ok, true);
  assert.equal(tabMessages.at(-1).tabId, 88);
  assert.equal(tabQueries.length, beforeQueries);
});

test("start relay binds the run request to the selected tab id", async () => {
  relayResponsesByTab.set(88, { ok: true });
  currentDocumentInstanceIds.set(88, "instance-88");
  await invokeRuntimeMessage({
    type: "AIPM_RELAY_TO_CHATGPT",
    targetTabId: 88,
    payload: { type: "AIPM_START", workflow: { id: "w" }, keepAwake: true }
  });
  const sent = tabMessages.at(-1);
  assert.equal(sent.tabId, 88);
  assert.equal(sent.payload.bindingTabId, 88);
  assert.equal(sent.payload.keepAwake, true);
  assert.equal(sent.payload.serviceWorkerVersion, "0.4.0");
  assert.equal(sent.payload.executionSessionId, "session-test");
  assert.equal(sent.payload.expectedConversationKey, "chatgpt:c:tab-88");
  assert.equal(sent.payload.expectedDocumentInstanceId, "instance-88");
  assert.equal(sent.payload.expectedRunId, null);
});

test("control relay preserves the user-observed Run revision instead of rebinding at preflight", async () => {
  relayResponsesByTab.set(89, { ok: true, run: { runId: "run-preflight", stateRevision: 9 } });
  currentDocumentInstanceIds.set(89, "instance-89");
  const beforeMessages = tabMessages.length;
  const response = await invokeRuntimeMessage({
    type: "AIPM_RELAY_TO_CHATGPT",
    targetTabId: 89,
    payload: {
      type: "AIPM_RESUME",
      expectedRunId: "run-preflight",
      expectedStateRevision: 8
    }
  });
  assert.equal(response.ok, false);
  assert.equal(response.relayErrorCode, "STALE_CONTROL_INTENT");
  assert.equal(tabMessages.length, beforeMessages + 1, "only the read-only status preflight may be sent");
  relayResponsesByTab.delete(89);
});

test("a matching control snapshot is delivered with its exact Run revision", async () => {
  relayResponsesByTab.set(90, { ok: true, run: { runId: "run-clicked", stateRevision: 12 } });
  currentDocumentInstanceIds.set(90, "instance-90");
  const response = await invokeRuntimeMessage({
    type: "AIPM_RELAY_TO_CHATGPT",
    targetTabId: 90,
    payload: {
      type: "AIPM_RESUME",
      expectedRunId: "run-clicked",
      expectedStateRevision: 12
    }
  });
  assert.equal(response.ok, true);
  const sent = tabMessages.at(-1);
  assert.equal(sent.payload.expectedRunId, "run-clicked");
  assert.equal(sent.payload.expectedStateRevision, 12);
  relayResponsesByTab.delete(90);
});

test("ISSUE31: Stop is durable even when content delivery is lost during reload", async () => {
  const tabId = 331;
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  const documentId = "issue31-document-before-reload";
  const documentInstanceId = `instance-${tabId}`;
  const run = {
    runId: "issue31-running-run",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: `chatgpt:c:tab-${tabId}`,
    executionSessionId: "session-test",
    boundTabId: tabId,
    boundDocumentId: documentId,
    documentInstanceId,
    status: "running",
    phase: "ready",
    stateRevision: 6,
    cursor: { stepIndex: 1, repeatIndex: 0, sendsCompleted: 1 },
    outbox: null,
    waitState: null
  };
  storageData[key] = structuredClone(run);
  currentDocumentIds.set(tabId, documentId);
  currentDocumentInstanceIds.set(tabId, documentInstanceId);
  relayResponsesByTab.set(tabId, { ok: true, run: structuredClone(run) });
  commandFailuresRemaining = 1;

  const response = await invokeRuntimeMessage({
    type: "AIPM_RELAY_TO_CHATGPT",
    targetTabId: tabId,
    payload: {
      type: "AIPM_STOP",
      expectedRunId: run.runId,
      expectedStateRevision: run.stateRevision
    }
  });

  assert.equal(response.ok, true, "a committed Stop must not be reported as a failed authority transition");
  assert.equal(response.stopCommitted, true);
  assert.equal(storageData[key].status, "stopped");
  assert.equal(storageData[key].phase, "stopped");
  assert.equal(storageData[key].stateRevision, 7);
  relayResponsesByTab.delete(tabId);
});

function makeNm1Run(tabId, runId, overrides = {}) {
  return {
    runId,
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: `chatgpt:c:tab-${tabId}`,
    executionSessionId: "session-test",
    boundTabId: tabId,
    boundDocumentId: `nm1-document-${tabId}`,
    documentInstanceId: `instance-${tabId}`,
    status: "running",
    phase: "ready",
    stateRevision: 4,
    cursor: { stepIndex: 1, repeatIndex: 0, sendsCompleted: 1 },
    outbox: null,
    waitState: null,
    ...overrides
  };
}

function seedNm1Run(run) {
  storageData[`aipm.activeRun.v2.tab.${run.boundTabId}`] = structuredClone(run);
  currentDocumentIds.set(run.boundTabId, run.boundDocumentId);
  currentDocumentInstanceIds.set(run.boundTabId, run.documentInstanceId);
  relayResponsesByTab.set(run.boundTabId, { ok: true, run: structuredClone(run) });
}

function relayNm1Stop(tabId, expectedRunId, expectedStateRevision = 4) {
  return invokeRuntimeMessage({
    type: "AIPM_RELAY_TO_CHATGPT",
    targetTabId: tabId,
    payload: { type: "AIPM_STOP", expectedRunId, expectedStateRevision }
  });
}

test("C4: durable Start rechecks stale-pause after awaited identity/storage work", async () => {
  const tabId = 331;
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  const scheduledAt = Date.parse("2030-01-02T03:04:05.000Z");
  const originalDateNow = Date.now;
  let now = scheduledAt + 1_000;
  Date.now = () => now;
  delete storageData[key];
  currentDocumentIds.set(tabId, `nm1-document-${tabId}`);
  currentDocumentInstanceIds.set(tabId, `instance-${tabId}`);
  storageGetGate = deferred();
  storageGetMatchKey = key;
  const getEntered = deferred();
  storageGetEntered = getEntered.resolve;

  try {
    const run = makeNm1Run(tabId, "c4-start-race", {
      stateRevision: 0,
      cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 },
      workflow: {
        schemaVersion: 1,
        id: "c4-start-race",
        name: "C4 start race",
        maxSends: 2,
        steps: [
          { id: "prompt-a", type: "prompt", delivery: "send", prompt: "A", repeat: 1, delayAfterMs: 0 },
          {
            id: "wait",
            type: "wait-until",
            at: new Date(scheduledAt).toISOString(),
            latePolicy: "pause",
            graceMs: 1_000
          },
          { id: "prompt-b", type: "prompt", delivery: "send", prompt: "B", repeat: 1, delayAfterMs: 0 }
        ]
      }
    });
    const pending = invokeRuntimeMessage({
      type: "AIPM_RUN_SET",
      runTransition: "start",
      conversationKey: run.conversationKey,
      documentInstanceId: run.documentInstanceId,
      run
    }, { tab: { id: tabId }, documentId: run.boundDocumentId });

    await getEntered.promise;
    now = scheduledAt + 1_001;
    storageGetGate.resolve();
    const response = await pending;

    assert.equal(response.ok, false);
    assert.equal(response.errorCode, "SCHEDULE_START_STALE");
    assert.equal(storageData[key], undefined, "a stale Start must not persist a running Run");
  } finally {
    Date.now = originalDateNow;
    storageGetGate?.resolve();
    storageGetGate = null;
    storageGetMatchKey = null;
    storageGetEntered = null;
    currentDocumentIds.delete(tabId);
    currentDocumentInstanceIds.delete(tabId);
    delete storageData[key];
  }
});

test("NM-1: unavailable document identity still durably stops before cleanup delivery", async () => {
  const tabId = 332;
  const run = makeNm1Run(tabId, "nm1-unavailable-run");
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  seedNm1Run(run);
  documentIdentityProbeCounts.delete(tabId);
  documentIdentityProbePlans.set(tabId, Array.from({ length: 12 }, () => ({ empty: true })));
  const beforeMessages = tabMessages.length;

  const response = await relayNm1Stop(tabId, run.runId, run.stateRevision);

  assert.equal(response.ok, true);
  assert.equal(response.stopCommitted, true);
  assert.equal(response.cleanupDelivered, false);
  assert.equal(storageData[key].status, "stopped");
  assert.equal(documentIdentityProbeCounts.get(tabId), 12);
  assert.equal(
    tabMessages.slice(beforeMessages).filter(({ payload }) => payload.type !== "AIPM_GET_STATUS").length,
    0,
    "an unavailable identity must block content mutation, not the durable Stop"
  );

  const reloadDocumentId = `nm1-reload-document-${tabId}`;
  const reloadInstanceId = `nm1-reload-instance-${tabId}`;
  currentDocumentIds.set(tabId, reloadDocumentId);
  currentDocumentInstanceIds.set(tabId, reloadInstanceId);
  const recovered = await invokeRuntimeMessage({
    type: "AIPM_RUN_GET",
    conversationKey: run.conversationKey,
    documentInstanceId: reloadInstanceId
  }, { tab: { id: tabId }, documentId: reloadDocumentId });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.run.status, "stopped");
  assert.equal(storageData[key].cursor.sendsCompleted, 1, "reload cannot advance or send after Stop");
  relayResponsesByTab.delete(tabId);
});

test("NM-1: mismatched document identity stops durably without mutating old content", async () => {
  const tabId = 333;
  const run = makeNm1Run(tabId, "nm1-mismatch-run");
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  seedNm1Run(run);
  documentIdentityProbePlans.set(tabId, [{
    documentId: `nm1-new-document-${tabId}`,
    documentInstanceId: `nm1-new-instance-${tabId}`
  }]);
  const beforeMessages = tabMessages.length;

  const response = await relayNm1Stop(tabId, run.runId, run.stateRevision);

  assert.equal(response.ok, true);
  assert.equal(response.stopCommitted, true);
  assert.equal(response.cleanupDelivered, false);
  assert.equal(storageData[key].status, "stopped");
  assert.equal(
    tabMessages.slice(beforeMessages).filter(({ payload }) => payload.type !== "AIPM_GET_STATUS").length,
    0,
    "a mismatched document must receive no Stop cleanup mutation"
  );

  const newDocumentId = `nm1-new-document-${tabId}`;
  const newInstanceId = `nm1-new-instance-${tabId}`;
  currentDocumentIds.set(tabId, newDocumentId);
  currentDocumentInstanceIds.set(tabId, newInstanceId);
  const recovered = await invokeRuntimeMessage({
    type: "AIPM_RUN_GET",
    conversationKey: run.conversationKey,
    documentInstanceId: newInstanceId
  }, { tab: { id: tabId }, documentId: newDocumentId });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.run.status, "stopped");
  assert.equal(storageData[key].cursor.sendsCompleted, 1, "new-document recovery cannot send after Stop");
  relayResponsesByTab.delete(tabId);
});

test("NM-1: a stale Stop for Run A cannot stop current Run B", async () => {
  const tabId = 334;
  const currentRun = makeNm1Run(tabId, "nm1-current-run-b");
  seedNm1Run(currentRun);
  const beforeMessages = tabMessages.length;

  const response = await relayNm1Stop(tabId, "nm1-stale-run-a", currentRun.stateRevision);

  assert.equal(response.ok, false);
  assert.equal(response.relayErrorCode, "STALE_CONTROL_INTENT");
  assert.equal(storageData[`aipm.activeRun.v2.tab.${tabId}`].status, "running");
  assert.equal(storageData[`aipm.activeRun.v2.tab.${tabId}`].runId, currentRun.runId);
  assert.equal(tabMessages.length, beforeMessages, "a stale Stop is rejected before any document contact");
  relayResponsesByTab.delete(tabId);
});

test("NM-1: a Stop targeted at the wrong tab changes neither tab Run", async () => {
  const tabA = 335;
  const tabB = 336;
  const runA = makeNm1Run(tabA, "nm1-tab-a-run");
  const runB = makeNm1Run(tabB, "nm1-tab-b-run");
  seedNm1Run(runA);
  seedNm1Run(runB);
  const beforeMessages = tabMessages.length;

  const response = await relayNm1Stop(tabB, runA.runId, runA.stateRevision);

  assert.equal(response.ok, false);
  assert.equal(response.relayErrorCode, "STALE_CONTROL_INTENT");
  assert.equal(storageData[`aipm.activeRun.v2.tab.${tabA}`].status, "running");
  assert.equal(storageData[`aipm.activeRun.v2.tab.${tabB}`].status, "running");
  assert.equal(tabMessages.length, beforeMessages, "wrong-tab Stop is rejected before any document contact");
  relayResponsesByTab.delete(tabA);
  relayResponsesByTab.delete(tabB);
});

test("NM-1: Stop without an expected Run id is rejected before durable mutation", async () => {
  const tabId = 340;
  const run = makeNm1Run(tabId, "nm1-missing-expected-run");
  seedNm1Run(run);
  const beforeMessages = tabMessages.length;

  const response = await invokeRuntimeMessage({
    type: "AIPM_RELAY_TO_CHATGPT",
    targetTabId: tabId,
    payload: { type: "AIPM_STOP" }
  });

  assert.equal(response.ok, false);
  assert.equal(response.relayErrorCode, "STALE_CONTROL_INTENT");
  assert.equal(storageData[`aipm.activeRun.v2.tab.${tabId}`].status, "running");
  assert.equal(tabMessages.length, beforeMessages);
  relayResponsesByTab.delete(tabId);
});

test("NM-1: normal Stop delivers cleanup once and blocks remaining runner progress", async () => {
  const tabId = 337;
  const run = makeNm1Run(tabId, "nm1-normal-stop-run");
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  seedNm1Run(run);
  const beforeMessages = tabMessages.length;

  const response = await relayNm1Stop(tabId, run.runId, run.stateRevision);

  assert.equal(response.ok, true);
  assert.equal(response.stopCommitted, true);
  assert.equal(response.cleanupDelivered, true);
  assert.equal(storageData[key].status, "stopped");
  assert.equal(
    tabMessages.slice(beforeMessages).filter(({ payload }) => payload.type === "AIPM_STOP").length,
    1,
    "normal Stop cleanup is delivered once and never retried"
  );

  const staleProgress = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    runTransition: "runner",
    conversationKey: run.conversationKey,
    documentInstanceId: run.documentInstanceId,
    run: { ...run, cursor: { ...run.cursor, sendsCompleted: 2 } }
  }, { tab: { id: tabId }, documentId: run.boundDocumentId });
  assert.equal(staleProgress.ok, false);
  assert.equal(staleProgress.errorCode, "RUN_STATE_CONFLICT");
  assert.equal(storageData[key].status, "stopped");
  assert.equal(storageData[key].cursor.sendsCompleted, 1, "remaining prompt progress stays at zero after Stop");
  relayResponsesByTab.delete(tabId);
});

test("NM-1: Stop and completion races preserve the first terminal state", async () => {
  const stopFirstTab = 338;
  const stopFirstRun = makeNm1Run(stopFirstTab, "nm1-stop-first-run");
  const stopFirstKey = `aipm.activeRun.v2.tab.${stopFirstTab}`;
  seedNm1Run(stopFirstRun);
  storageSetGate = deferred();
  storageSetMatchKey = stopFirstKey;
  const stopSetEntered = deferred();
  storageSetEntered = stopSetEntered.resolve;

  const stopFirst = relayNm1Stop(stopFirstTab, stopFirstRun.runId, stopFirstRun.stateRevision);
  await stopSetEntered.promise;
  const lateCompletion = invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    runTransition: "runner",
    conversationKey: stopFirstRun.conversationKey,
    documentInstanceId: stopFirstRun.documentInstanceId,
    run: { ...stopFirstRun, status: "completed", phase: "completed" }
  }, { tab: { id: stopFirstTab }, documentId: stopFirstRun.boundDocumentId });
  storageSetGate.resolve();
  const [stopResponse, completionAfterStop] = await Promise.all([stopFirst, lateCompletion]);
  storageSetGate = null;
  storageSetMatchKey = null;
  storageSetEntered = null;

  assert.equal(stopResponse.ok, true);
  assert.equal(completionAfterStop.ok, false);
  assert.equal(completionAfterStop.errorCode, "RUN_STATE_CONFLICT");
  assert.equal(storageData[stopFirstKey].status, "stopped");
  relayResponsesByTab.delete(stopFirstTab);

  const completionFirstTab = 339;
  const completionFirstRun = makeNm1Run(completionFirstTab, "nm1-completion-first-run");
  const completionFirstKey = `aipm.activeRun.v2.tab.${completionFirstTab}`;
  seedNm1Run(completionFirstRun);
  storageSetGate = deferred();
  storageSetMatchKey = completionFirstKey;
  const completionSetEntered = deferred();
  storageSetEntered = completionSetEntered.resolve;

  const completionFirst = invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    runTransition: "runner",
    conversationKey: completionFirstRun.conversationKey,
    documentInstanceId: completionFirstRun.documentInstanceId,
    run: { ...completionFirstRun, status: "completed", phase: "completed" }
  }, { tab: { id: completionFirstTab }, documentId: completionFirstRun.boundDocumentId });
  await completionSetEntered.promise;
  const lateStop = relayNm1Stop(completionFirstTab, completionFirstRun.runId, completionFirstRun.stateRevision);
  storageSetGate.resolve();
  const [completionResponse, stopAfterCompletion] = await Promise.all([completionFirst, lateStop]);
  storageSetGate = null;
  storageSetMatchKey = null;
  storageSetEntered = null;

  assert.equal(completionResponse.ok, true);
  assert.equal(stopAfterCompletion.ok, false);
  assert.equal(stopAfterCompletion.relayErrorCode, "STALE_CONTROL_INTENT");
  assert.equal(storageData[completionFirstKey].status, "completed");
  relayResponsesByTab.delete(completionFirstTab);
});

test("mutating relay fails closed when an explicit target tab is missing", async () => {
  const beforeMessages = tabMessages.length;
  const response = await invokeRuntimeMessage({
    type: "AIPM_RELAY_TO_CHATGPT",
    payload: { type: "AIPM_START", workflow: { id: "must-not-fallback" } }
  });
  assert.equal(response.ok, false);
  assert.equal(response.relayErrorCode, "TARGET_TAB_REQUIRED");
  assert.equal(tabMessages.length, beforeMessages);
});

test("tab-scoped run store keeps independent run state for different ChatGPT tabs", async () => {
  queryTabs = [{ id: 41, active: true, windowId: 1 }, { id: 42, active: false, windowId: 1 }];
  currentDocumentIds.set(41, "doc-a");
  currentDocumentIds.set(42, "doc-b");
  const runA = { runId: "run-a", provider: "chatgpt", contentVersion: "0.4.0", conversationKey: "chatgpt:c:a", status: "running", keepAwake: true, executionSessionId: "session-test" };
  const runB = { runId: "run-b", provider: "chatgpt", contentVersion: "0.4.0", conversationKey: "chatgpt:c:b", status: "paused", keepAwake: false, executionSessionId: "session-test" };

  const setA = await invokeRuntimeMessage({ type: "AIPM_RUN_SET", run: runA, conversationKey: "chatgpt:c:a", documentInstanceId: "instance-a" }, { tab: { id: 41 }, documentId: "doc-a" });
  const setB = await invokeRuntimeMessage({ type: "AIPM_RUN_SET", run: runB, conversationKey: "chatgpt:c:b", documentInstanceId: "instance-b" }, { tab: { id: 42 }, documentId: "doc-b" });
  assert.equal(setA.run.boundTabId, 41);
  assert.equal(setB.run.boundTabId, 42);
  assert.equal(storageData["aipm.activeRun.v2.tab.41"].runId, "run-a");
  assert.equal(storageData["aipm.activeRun.v2.tab.42"].runId, "run-b");

  const getA = await invokeRuntimeMessage(
    { type: "AIPM_RUN_GET", conversationKey: "chatgpt:c:a" },
    { tab: { id: 41 }, documentId: "doc-a" }
  );
  const getB = await invokeRuntimeMessage(
    { type: "AIPM_RUN_GET", conversationKey: "chatgpt:c:b" },
    { tab: { id: 42 }, documentId: "doc-b" }
  );
  assert.equal(getA.run.runId, "run-a");
  assert.equal(getB.run.runId, "run-b");
});

test("ISSUE23-1: a transient identity probe is reconfirmed before one Run update", async () => {
  const tabId = 231;
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  const stored = {
    runId: "issue23-transient-run",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:issue23-stable",
    documentInstanceId: "issue23-stable-instance",
    executionSessionId: "session-test",
    boundTabId: tabId,
    boundDocumentId: "issue23-stable-document",
    status: "running",
    phase: "ready",
    stateRevision: 7,
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 }
  };
  storageData[key] = structuredClone(stored);
  documentIdentityProbeCounts.set(tabId, 0);
  documentIdentityProbePlans.set(tabId, [
    () => {
      assert.deepEqual(storageData[key], stored, "the first failed read must not mutate storage");
      return { error: new Error("transient identity probe failure") };
    },
    () => {
      assert.deepEqual(storageData[key], stored, "storage stays unchanged until identity is proven");
      return { documentId: stored.boundDocumentId, documentInstanceId: stored.documentInstanceId };
    }
  ]);
  const beforeMessages = tabMessages.length;
  const run = {
    ...stored,
    phase: "waiting-generation",
    cursor: { stepIndex: 0, repeatIndex: 1, sendsCompleted: 1 }
  };

  const response = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    run,
    conversationKey: run.conversationKey,
    documentInstanceId: run.documentInstanceId
  }, { tab: { id: tabId }, documentId: "issue23-stable-document" });

  assert.equal(response.ok, true);
  assert.equal(documentIdentityProbeCounts.get(tabId), 2);
  assert.equal(storageData[key].runId, run.runId);
  assert.equal(storageData[key].stateRevision, 8, "the existing Run is advanced by exactly one revision");
  assert.deepEqual(storageData[key].cursor, run.cursor);
  assert.equal(tabMessages.length, beforeMessages, "identity reconfirmation has no Send authority");
});

test("late identity: an eligible timed-out fulfillment is consumed without suppressing the next fresh read", async () => {
  const tabId = 403;
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  const stored = {
    runId: "high2-timeout-retry-run",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:high2-timeout-retry",
    documentInstanceId: "high2-timeout-retry-instance",
    executionSessionId: "session-test",
    boundTabId: tabId,
    boundDocumentId: "high2-timeout-retry-document",
    status: "running",
    phase: "ready",
    stateRevision: 4,
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 }
  };
  storageData[key] = structuredClone(stored);
  documentIdentityProbeCounts.set(tabId, 0);
  documentIdentityProbePlans.set(tabId, [
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      return {
        documentId: stored.boundDocumentId,
        documentInstanceId: stored.documentInstanceId
      };
    },
    {
      documentId: stored.boundDocumentId,
      documentInstanceId: stored.documentInstanceId
    },
    {
      documentId: stored.boundDocumentId,
      documentInstanceId: stored.documentInstanceId
    }
  ]);

  const response = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    run: { ...stored, phase: "waiting-generation" },
    conversationKey: stored.conversationKey,
    documentInstanceId: stored.documentInstanceId
  }, { tab: { id: tabId }, documentId: stored.boundDocumentId });

  assert.equal(response.ok, true);
  assert.equal(documentIdentityProbeCounts.get(tabId), 1, "the original owner consumes its eligible late fulfillment");
  assert.ok(response.identityObservation?.consecutiveUnavailable >= 1);
  assert.equal(storageData[key].phase, "waiting-generation");
  assert.equal(storageData[key].stateRevision, 5);

  const healthyRead = await invokeRuntimeMessage({
    type: "AIPM_RUN_GET",
    conversationKey: stored.conversationKey,
    documentInstanceId: stored.documentInstanceId
  }, { tab: { id: tabId }, documentId: stored.boundDocumentId });
  assert.equal(healthyRead.ok, true, "a healthy fresh read immediately after recovery is not rejected by observation backoff");
  assert.equal(healthyRead.run?.runId, stored.runId);
  assert.equal(documentIdentityProbeCounts.get(tabId), 2);
});

test("C8: true never-settle identity contacts hit the hard orphan ceiling and fail closed", async () => {
  const tabId = 404;
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  const stored = {
    runId: "high2-timeout-exhausted-run",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:high2-timeout-exhausted",
    documentInstanceId: "high2-timeout-exhausted-instance",
    executionSessionId: "session-test",
    boundTabId: tabId,
    boundDocumentId: "high2-timeout-exhausted-document",
    status: "running",
    phase: "ready",
    stateRevision: 9,
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 }
  };
  storageData[key] = structuredClone(stored);
  documentIdentityProbeCounts.set(tabId, 0);
  documentIdentityProbePlans.set(tabId, Array.from({ length: 3 }, () => () => new Promise(() => {})));
  const beforeMessages = tabMessages.length;

  const response = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    run: { ...stored, phase: "waiting-generation" },
    conversationKey: stored.conversationKey,
    documentInstanceId: stored.documentInstanceId
  }, { tab: { id: tabId }, documentId: stored.boundDocumentId });

  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.equal(documentIdentityProbeCounts.get(tabId), 2, "the hard orphan ceiling forbids a third underlying contact");
  assert.deepEqual(storageData[key], stored, "unconfirmed authority cannot mutate the durable Run");
  assert.equal(tabMessages.length, beforeMessages, "failed authority probes cannot send");
});

function seedC2IdentityRun(tabId, label) {
  const run = {
    runId: `c2-${label}-run`,
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: `chatgpt:c:c2-${label}`,
    documentInstanceId: `c2-${label}-instance`,
    executionSessionId: "session-test",
    boundTabId: tabId,
    boundDocumentId: `c2-${label}-document`,
    status: "running",
    phase: "ready",
    stateRevision: 1,
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 }
  };
  storageData[`aipm.activeRun.v2.tab.${tabId}`] = structuredClone(run);
  documentIdentityProbeCounts.set(tabId, 0);
  return run;
}

function updateC2IdentityRun(tabId, run) {
  return invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    run: { ...run, phase: "waiting-generation" },
    conversationKey: run.conversationKey,
    documentInstanceId: run.documentInstanceId
  }, { tab: { id: tabId }, documentId: run.boundDocumentId });
}

function assertC2Unavailable(response, reason, attempt = 12, totalAttempts = 12) {
  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.deepEqual(
    {
      outcome: response.identityObservation?.outcome,
      reason: response.identityObservation?.reason,
      attempt: response.identityObservation?.attempt,
      totalAttempts: response.identityObservation?.totalAttempts
    },
    { outcome: "unavailable", reason, attempt, totalAttempts }
  );
  assert.equal(Number.isSafeInteger(response.identityObservation?.durationMs), true);
  assert.equal(response.identityObservation.durationMs >= 0, true);
}

test("C2 I1: timeout remains unavailable, classified, bounded, and grants no mutation or Send", async () => {
  const tabId = 510;
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  const stored = seedC2IdentityRun(tabId, "timeout");
  documentIdentityProbePlans.set(tabId, Array.from({ length: 3 }, () => () => new Promise(() => {})));
  const beforeMessages = tabMessages.length;

  const response = await updateC2IdentityRun(tabId, stored);

  assertC2Unavailable(response, "timeout", 2, 12);
  assert.equal(response.identityObservation.durationMs >= 400, true);
  assert.equal(documentIdentityProbeCounts.get(tabId), 2, "true orphans remain below the hard underlying-contact ceiling");
  assert.deepEqual(storageData[key], stored);
  assert.equal(tabMessages.length, beforeMessages);
});

test("C2 I2: executeScript rejection uses a fixed reason without exposing raw Error data", async () => {
  const tabId = 511;
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  const stored = seedC2IdentityRun(tabId, "rejected");
  const secretMessage = "raw browser path C:/secret and account token";
  documentIdentityProbePlans.set(tabId, Array.from({ length: 12 }, () => ({
    error: new Error(secretMessage)
  })));
  const beforeMessages = tabMessages.length;

  const response = await updateC2IdentityRun(tabId, stored);

  assertC2Unavailable(response, "execute-script-rejected");
  assert.doesNotMatch(JSON.stringify(response), /raw browser path|account token|stack/i);
  assert.deepEqual(storageData[key], stored);
  assert.equal(tabMessages.length, beforeMessages);
});

test("C2 I3: a resolved probe without frame 0 is top-frame-missing and grants no authority", async () => {
  const tabId = 512;
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  const stored = seedC2IdentityRun(tabId, "top-frame");
  documentIdentityProbePlans.set(tabId, Array.from({ length: 12 }, () => ({
    frameId: 7,
    documentId: stored.boundDocumentId,
    documentInstanceId: stored.documentInstanceId
  })));
  const beforeMessages = tabMessages.length;

  const response = await updateC2IdentityRun(tabId, stored);

  assertC2Unavailable(response, "top-frame-missing");
  assert.deepEqual(storageData[key], stored);
  assert.equal(tabMessages.length, beforeMessages);
});

test("C2 I4: frame 0 without comparable identity fields remains unavailable", async () => {
  const tabId = 513;
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  const stored = seedC2IdentityRun(tabId, "fields");
  documentIdentityProbePlans.set(tabId, Array.from({ length: 12 }, () => ({})));
  const beforeMessages = tabMessages.length;

  const response = await updateC2IdentityRun(tabId, stored);

  assertC2Unavailable(response, "identity-fields-unavailable");
  assert.deepEqual(storageData[key], stored);
  assert.equal(tabMessages.length, beforeMessages);
});

test("C2 I5: a proven mismatch stays mismatch, returns immediately, and grants no authority", async () => {
  const tabId = 514;
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  const stored = seedC2IdentityRun(tabId, "mismatch");
  documentIdentityProbePlans.set(tabId, [{
    documentId: "different-document",
    documentInstanceId: stored.documentInstanceId
  }]);
  const beforeMessages = tabMessages.length;

  const response = await updateC2IdentityRun(tabId, stored);

  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "DOCUMENT_IDENTITY_MISMATCH");
  assert.equal(response.identityObservation.outcome, "mismatch");
  assert.equal(Object.hasOwn(response.identityObservation, "reason"), false);
  assert.equal(response.identityObservation.attempt, 1);
  assert.equal(documentIdentityProbeCounts.get(tabId), 1, "a proven mismatch is never retried");
  assert.deepEqual(storageData[key], stored);
  assert.equal(tabMessages.length, beforeMessages);
});

test("C2 I6: a timeout followed by a match succeeds without carrying failure authority forward", async () => {
  const tabId = 515;
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  const stored = seedC2IdentityRun(tabId, "retry-success");
  documentIdentityProbePlans.set(tabId, [
    () => new Promise(() => {}),
    { documentId: stored.boundDocumentId, documentInstanceId: stored.documentInstanceId }
  ]);
  const beforeMessages = tabMessages.length;

  const response = await updateC2IdentityRun(tabId, stored);

  assert.equal(response.ok, true);
  assert.equal(documentIdentityProbeCounts.get(tabId), 2);
  assert.equal(storageData[key].phase, "waiting-generation");
  assert.equal(storageData[key].stateRevision, 2);
  assert.equal(tabMessages.length, beforeMessages, "identity recovery itself has no Send authority");
});

test("C2 I7: all bounded attempts unavailable expose only the final safe classification", async () => {
  const tabId = 516;
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  const stored = seedC2IdentityRun(tabId, "all-unavailable");
  documentIdentityProbePlans.set(tabId, [
    { error: new Error("first raw failure") },
    {},
    ...Array.from({ length: 10 }, () => ({
      frameId: 9,
      documentId: stored.boundDocumentId,
      documentInstanceId: stored.documentInstanceId
    }))
  ]);
  const beforeMessages = tabMessages.length;

  const response = await updateC2IdentityRun(tabId, stored);

  assertC2Unavailable(response, "top-frame-missing");
  assert.equal(documentIdentityProbeCounts.get(tabId), 12);
  assert.deepEqual(storageData[key], stored);
  assert.equal(tabMessages.length, beforeMessages);
  assert.doesNotMatch(JSON.stringify(response), /first raw failure/);
});

test("C2 I8: malformed probe results fail closed as probe-result-invalid", async () => {
  const tabId = 517;
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  const stored = seedC2IdentityRun(tabId, "malformed");
  documentIdentityProbePlans.set(tabId, Array.from({ length: 12 }, () => ({
    rawResults: { unexpected: true, documentId: stored.boundDocumentId }
  })));
  const beforeMessages = tabMessages.length;

  const response = await updateC2IdentityRun(tabId, stored);

  assertC2Unavailable(response, "probe-result-invalid");
  assert.deepEqual(storageData[key], stored);
  assert.equal(tabMessages.length, beforeMessages);
});

test("Recovery Mode: completion identity recovery performs five fresh bounded attempts then succeeds", async () => {
  const tabId = 405;
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  const stored = {
    runId: "completion-five-attempt-run",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:completion-five-attempt",
    documentInstanceId: "completion-five-instance",
    executionSessionId: "session-test",
    boundTabId: tabId,
    boundDocumentId: "completion-five-document",
    status: "running",
    stateRevision: 1,
    workflow: {
      recovery: {
        mode: "completion",
        identityAttempts: 5,
        readiness: "long",
        statusRecovery: "persistent"
      }
    },
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 }
  };
  storageData[key] = structuredClone(stored);
  documentIdentityProbeCounts.set(tabId, 0);
  documentIdentityProbePlans.set(tabId, [
    ...Array.from({ length: 4 }, () => ({ error: new Error("transient identity failure") })),
    { documentId: stored.boundDocumentId, documentInstanceId: stored.documentInstanceId }
  ]);

  const response = await invokeRuntimeMessage({
    type: "AIPM_RUN_GET",
    conversationKey: stored.conversationKey,
    documentInstanceId: stored.documentInstanceId,
    readOnlyRecovery: stored.workflow.recovery
  }, { tab: { id: tabId }, documentId: stored.boundDocumentId });

  assert.equal(response.ok, true);
  assert.equal(response.run?.runId, stored.runId);
  assert.equal(documentIdentityProbeCounts.get(tabId), 5);
});

test("Recovery Mode: twelve-probe recovery ceiling fails closed without storage mutation or Send", async () => {
  const tabId = 406;
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  const stored = {
    runId: "completion-ten-exhausted-run",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:completion-ten-exhausted",
    documentInstanceId: "completion-ten-instance",
    executionSessionId: "session-test",
    boundTabId: tabId,
    boundDocumentId: "completion-ten-document",
    status: "running",
    stateRevision: 3,
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 }
  };
  storageData[key] = structuredClone(stored);
  documentIdentityProbeCounts.set(tabId, 0);
  documentIdentityProbePlans.set(tabId, Array.from({ length: 12 }, () => ({
    error: new Error("identity unavailable")
  })));
  const beforeMessages = tabMessages.length;

  const response = await invokeRuntimeMessage({
    type: "AIPM_RUN_GET",
    conversationKey: stored.conversationKey,
    documentInstanceId: stored.documentInstanceId,
    readOnlyRecovery: {
      mode: "completion",
      identityAttempts: 10,
      readiness: "long",
      statusRecovery: "persistent"
    }
  }, { tab: { id: tabId }, documentId: stored.boundDocumentId });

  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.equal(documentIdentityProbeCounts.get(tabId), 12);
  assert.deepEqual(storageData[key], stored);
  assert.equal(tabMessages.length, beforeMessages);
});

test("Recovery Mode: a proven document mismatch rejects immediately even with ten retries selected", async () => {
  const tabId = 407;
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  const stored = {
    runId: "completion-mismatch-run",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:completion-mismatch",
    documentInstanceId: "completion-mismatch-instance",
    executionSessionId: "session-test",
    boundTabId: tabId,
    boundDocumentId: "completion-mismatch-document",
    status: "running",
    stateRevision: 2,
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 }
  };
  storageData[key] = structuredClone(stored);
  documentIdentityProbeCounts.set(tabId, 0);
  documentIdentityProbePlans.set(tabId, [
    { documentId: "different-document", documentInstanceId: "different-instance" },
    () => { throw new Error("mismatch must never be retried"); }
  ]);

  const response = await invokeRuntimeMessage({
    type: "AIPM_RUN_GET",
    conversationKey: stored.conversationKey,
    documentInstanceId: stored.documentInstanceId,
    readOnlyRecovery: {
      mode: "completion",
      identityAttempts: 10,
      readiness: "long",
      statusRecovery: "persistent"
    }
  }, { tab: { id: tabId }, documentId: stored.boundDocumentId });

  assert.equal(response.ok, true);
  assert.equal(response.run, null);
  assert.equal(response.staleDocument, true);
  assert.equal(documentIdentityProbeCounts.get(tabId), 1);
  assert.deepEqual(storageData[key], stored);
});

test("Recovery Mode: SAFE ignores advanced values and keeps the fixed C11 recovery ceiling", async () => {
  const tabId = 408;
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  const stored = {
    runId: "safe-recovery-clamp-run",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:safe-recovery-clamp",
    documentInstanceId: "safe-recovery-clamp-instance",
    executionSessionId: "session-test",
    boundTabId: tabId,
    boundDocumentId: "safe-recovery-clamp-document",
    status: "running",
    stateRevision: 1,
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 }
  };
  storageData[key] = structuredClone(stored);
  documentIdentityProbeCounts.set(tabId, 0);
  documentIdentityProbePlans.set(tabId, Array.from({ length: 12 }, () => ({
    error: new Error("identity unavailable")
  })));

  const response = await invokeRuntimeMessage({
    type: "AIPM_RUN_GET",
    conversationKey: stored.conversationKey,
    documentInstanceId: stored.documentInstanceId,
    readOnlyRecovery: {
      mode: "safe",
      identityAttempts: 10,
      readiness: "long",
      statusRecovery: "persistent"
    }
  }, { tab: { id: tabId }, documentId: stored.boundDocumentId });

  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.equal(documentIdentityProbeCounts.get(tabId), 12);
  assert.deepEqual(storageData[key], stored);
});

test("ISSUE23-2: exhausted identity probes reject the update and durably fail-close the exact Run", async () => {
  const tabId = 232;
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  const stored = {
    runId: "issue23-unconfirmed-run",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:issue23-unconfirmed",
    documentInstanceId: "issue23-unconfirmed-instance",
    executionSessionId: "session-test",
    boundTabId: tabId,
    boundDocumentId: "issue23-unconfirmed-document",
    status: "running",
    phase: "ready",
    resumable: true,
    stateRevision: 7,
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 }
  };
  storageData[key] = structuredClone(stored);
  documentIdentityProbeCounts.set(tabId, 0);
  documentIdentityProbePlans.set(tabId, Array.from({ length: 12 }, () => ({
    error: new Error("identity probe unavailable")
  })));
  const beforeMessages = tabMessages.length;

  const rejected = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    run: { ...stored, phase: "waiting-generation" },
    conversationKey: stored.conversationKey,
    documentInstanceId: stored.documentInstanceId
  }, { tab: { id: tabId }, documentId: stored.boundDocumentId });

  assert.equal(rejected.ok, false);
  assert.equal(rejected.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.equal(documentIdentityProbeCounts.get(tabId), 12);
  assert.deepEqual(storageData[key], stored, "an unconfirmed writer cannot mutate Run state");

  const stopped = await invokeRuntimeMessage({
    type: "AIPM_RUN_FAIL_CLOSED",
    expectedRunId: stored.runId,
    reason: "document_identity_unconfirmed",
    serviceWorkerVersion: "0.4.0"
  }, { tab: { id: tabId } });
  assert.equal(stopped.ok, true);
  assert.equal(storageData[key].status, "paused");
  assert.equal(storageData[key].phase, "ambiguous");
  assert.equal(storageData[key].resumable, false);
  assert.equal(storageData[key].pauseReason, "document_identity_unconfirmed");
  assert.equal(tabMessages.length, beforeMessages, "fail-closed persistence cannot send a prompt");
});

test("ISSUE23: a delayed identity fail-close cannot overwrite Stop or completion", async () => {
  for (const [index, status] of ["stopped", "completed"].entries()) {
    const tabId = 240 + index;
    const key = `aipm.activeRun.v2.tab.${tabId}`;
    const terminal = {
      runId: `issue23-terminal-${status}`,
      provider: "chatgpt",
      contentVersion: "0.4.0",
      conversationKey: `chatgpt:c:issue23-terminal-${status}`,
      executionSessionId: "session-test",
      boundTabId: tabId,
      status,
      phase: status,
      resumable: false,
      stateRevision: 12,
      cursor: { stepIndex: 1, repeatIndex: 0, sendsCompleted: 1 }
    };
    storageData[key] = structuredClone(terminal);

    const response = await invokeRuntimeMessage({
      type: "AIPM_RUN_FAIL_CLOSED",
      expectedRunId: terminal.runId,
      reason: "document_identity_unconfirmed",
      serviceWorkerVersion: "0.4.0"
    }, { tab: { id: tabId } });

    assert.equal(response.ok, true);
    assert.equal(response.changed, false);
    assert.equal(response.terminalRun, true);
    assert.deepEqual(storageData[key], terminal, `${status} must win over delayed fail-close`);
  }
});

test("ISSUE23-3: a mismatch proven on reconfirmation rejects immediately", async () => {
  const tabId = 233;
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  const stored = {
    runId: "issue23-mismatch-run",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:issue23-mismatch",
    documentInstanceId: "issue23-original-instance",
    executionSessionId: "session-test",
    boundTabId: tabId,
    boundDocumentId: "issue23-original-document",
    status: "running",
    phase: "ready",
    stateRevision: 5,
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 }
  };
  storageData[key] = structuredClone(stored);
  documentIdentityProbeCounts.set(tabId, 0);
  documentIdentityProbePlans.set(tabId, [
    { error: new Error("first probe unavailable") },
    { documentId: "issue23-different-document", documentInstanceId: "issue23-different-instance" },
    () => { throw new Error("a proven mismatch must not be retried"); }
  ]);
  const beforeMessages = tabMessages.length;
  const run = {
    ...stored,
    phase: "waiting-generation",
    cursor: { stepIndex: 0, repeatIndex: 1, sendsCompleted: 1 }
  };

  const response = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    run,
    conversationKey: run.conversationKey,
    documentInstanceId: run.documentInstanceId
  }, { tab: { id: tabId }, documentId: "issue23-original-document" });

  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "DOCUMENT_IDENTITY_MISMATCH");
  assert.equal(documentIdentityProbeCounts.get(tabId), 2);
  assert.deepEqual(storageData[key], stored, "a mismatched writer cannot alter existing Run state");
  assert.equal(tabMessages.length, beforeMessages);
});

test("ISSUE23: either conflicting identity component defeats a matching component", async () => {
  const cases = [
    {
      tabId: 234,
      observed: { documentId: "issue23-pair-document", documentInstanceId: "issue23-pair-other-instance" }
    },
    {
      tabId: 235,
      observed: { documentId: "issue23-pair-other-document", documentInstanceId: "issue23-pair-instance" }
    }
  ];

  for (const { tabId, observed } of cases) {
    const key = `aipm.activeRun.v2.tab.${tabId}`;
    delete storageData[key];
    documentIdentityProbeCounts.set(tabId, 0);
    documentIdentityProbePlans.set(tabId, [observed]);
    const run = {
      runId: `issue23-conflicting-pair-${tabId}`,
      provider: "chatgpt",
      contentVersion: "0.4.0",
      conversationKey: `chatgpt:c:issue23-conflicting-pair-${tabId}`,
      documentInstanceId: "issue23-pair-instance",
      executionSessionId: "session-test",
      boundTabId: tabId,
      status: "running",
      cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 }
    };

    const response = await invokeRuntimeMessage({
      type: "AIPM_RUN_SET",
      run,
      conversationKey: run.conversationKey,
      documentInstanceId: run.documentInstanceId
    }, { tab: { id: tabId }, documentId: "issue23-pair-document" });

    assert.equal(response.ok, false);
    assert.equal(response.errorCode, "DOCUMENT_IDENTITY_MISMATCH");
    assert.equal(documentIdentityProbeCounts.get(tabId), 1, "a proven conflict is never retried");
    assert.equal(storageData[key], undefined);
  }
});

test("ISSUE23: a non-top injection result is unavailable ownership evidence", async () => {
  const tabId = 237;
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  delete storageData[key];
  documentIdentityProbeCounts.set(tabId, 0);
  documentIdentityProbePlans.set(tabId, Array.from({ length: 12 }, () => ({
    documentId: "issue23-non-top-document",
    documentInstanceId: "issue23-non-top-instance",
    frameId: 1
  })));
  const run = {
    runId: "issue23-non-top-run",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:issue23-non-top",
    documentInstanceId: "issue23-non-top-instance",
    executionSessionId: "session-test",
    boundTabId: tabId,
    status: "running",
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 }
  };

  const response = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    run,
    conversationKey: run.conversationKey,
    documentInstanceId: run.documentInstanceId
  }, { tab: { id: tabId }, documentId: "issue23-non-top-document" });

  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.equal(documentIdentityProbeCounts.get(tabId), 12);
  assert.equal(storageData[key], undefined);
});

test("ISSUE23-6: navigation during reconfirmation cannot reuse the old document authority", async () => {
  const tabId = 236;
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  const stored = {
    runId: "issue23-navigation-run",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:issue23-navigation",
    documentInstanceId: "issue23-navigation-old-instance",
    executionSessionId: "session-test",
    boundTabId: tabId,
    boundDocumentId: "issue23-navigation-old-document",
    status: "running",
    stateRevision: 4,
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 }
  };
  const newDocumentId = "issue23-navigation-new-document";
  const newInstanceId = "issue23-navigation-new-instance";
  storageData[key] = structuredClone(stored);
  currentDocumentIds.set(tabId, stored.boundDocumentId);
  currentDocumentInstanceIds.set(tabId, stored.documentInstanceId);
  let newDocumentGet = null;
  documentIdentityProbeCounts.set(tabId, 0);
  documentIdentityProbePlans.set(tabId, [
    () => {
      currentDocumentIds.set(tabId, newDocumentId);
      currentDocumentInstanceIds.set(tabId, newInstanceId);
      newDocumentGet = invokeRuntimeMessage({
        type: "AIPM_RUN_GET",
        conversationKey: stored.conversationKey,
        documentInstanceId: newInstanceId
      }, { tab: { id: tabId }, documentId: newDocumentId });
      return { error: new Error("navigation interrupted the first probe") };
    },
    { documentId: newDocumentId, documentInstanceId: newInstanceId },
    { documentId: newDocumentId, documentInstanceId: newInstanceId }
  ]);
  const beforeMessages = tabMessages.length;
  const oldRun = {
    ...stored,
    phase: "waiting-generation",
    cursor: { stepIndex: 0, repeatIndex: 1, sendsCompleted: 1 }
  };

  const response = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    run: oldRun,
    conversationKey: oldRun.conversationKey,
    documentInstanceId: oldRun.documentInstanceId
  }, { tab: { id: tabId }, documentId: oldRun.boundDocumentId });
  const adopted = await newDocumentGet;

  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "DOCUMENT_IDENTITY_MISMATCH");
  assert.equal(adopted.ok, true);
  assert.equal(adopted.run.runId, stored.runId);
  assert.equal(documentIdentityProbeCounts.get(tabId), 3);
  assert.equal(storageData[key].boundDocumentId, newDocumentId);
  assert.equal(storageData[key].documentInstanceId, newInstanceId);
  assert.deepEqual(storageData[key].cursor, stored.cursor, "the old writer's progress never lands");
  assert.equal(tabMessages.length, beforeMessages);
});

test("legacy global run state is quarantined instead of attaching to a requesting tab", async () => {
  delete storageData["aipm.activeRun.v2.tab.55"];
  storageData["aipm.activeRun.v1"] = {
    runId: "legacy",
    conversationKey: "chatgpt:c:legacy",
    status: "paused",
    keepAwake: false
  };
  const response = await invokeRuntimeMessage(
    { type: "AIPM_RUN_GET", conversationKey: "chatgpt:c:legacy" },
    { tab: { id: 55 } }
  );
  assert.equal(response.run, null);
  assert.equal(response.quarantineReason, "legacy-unbound-run");
  assert.equal(storageData["aipm.activeRun.v1"], undefined);
  assert.equal(storageData["aipm.activeRun.v2.tab.55"], undefined);
  assert.equal(storageData["aipm.quarantinedRuns.v1"].at(-1).runId, "legacy");
});

test("a submitted New Chat Run cannot auto-transition to canonical even inside the same document", async () => {
  currentDocumentIds.set(56, "document-live");
  storageData["aipm.activeRun.v2.tab.56"] = {
    runId: "new-live",
    conversationKey: "chatgpt:new:instance-live",
    documentInstanceId: "instance-live",
    boundDocumentId: "document-live",
    boundTabId: 56,
    executionSessionId: "session-test",
    status: "running",
    outbox: { state: "submitted" }
  };
  const response = await invokeRuntimeMessage(
    { type: "AIPM_RUN_GET", conversationKey: "chatgpt:c:created", documentInstanceId: "instance-live" },
    { tab: { id: 56 }, documentId: "document-live" }
  );
  assert.equal(response.run, null);
  assert.equal(response.quarantineReason, "new-chat-recovery");
  assert.equal(storageData["aipm.activeRun.v2.tab.56"], undefined);
  const quarantined = storageData["aipm.quarantinedRuns.v1"].at(-1);
  assert.equal(quarantined.runId, "new-live");
  assert.equal(quarantined.resumable, false);
});

test("a pre-submit New Chat run cannot follow an arbitrary same-document conversation change", async () => {
  currentDocumentIds.set(60, "document-before-submit");
  currentDocumentInstanceIds.set(60, "instance-before-submit");
  storageData["aipm.activeRun.v2.tab.60"] = {
    runId: "new-before-submit",
    conversationKey: "chatgpt:new:instance-before-submit",
    documentInstanceId: "instance-before-submit",
    boundDocumentId: "document-before-submit",
    boundTabId: 60,
    executionSessionId: "session-test",
    status: "running",
    outbox: { state: "prepared" }
  };
  const response = await invokeRuntimeMessage(
    { type: "AIPM_RUN_GET", conversationKey: "chatgpt:c:unrelated", documentInstanceId: "instance-before-submit" },
    { tab: { id: 60 }, documentId: "document-before-submit" }
  );
  assert.equal(response.run, null);
  assert.equal(response.quarantineReason, "new-chat-recovery");
});

test("a reloaded New Chat run is quarantined instead of auto-resuming", async () => {
  storageData["aipm.activeRun.v2.tab.57"] = {
    runId: "new-reloaded",
    conversationKey: "chatgpt:new:instance-reload",
    documentInstanceId: "instance-reload",
    boundDocumentId: "document-before-reload",
    boundTabId: 57,
    executionSessionId: "session-test",
    status: "running",
    workflow: { id: "preserved" },
    cursor: { sendsCompleted: 1 }
  };
  currentDocumentIds.set(57, "document-after-reload");
  const response = await invokeRuntimeMessage(
    { type: "AIPM_RUN_GET", conversationKey: "chatgpt:new:instance-reload", documentInstanceId: "instance-reload" },
    { tab: { id: 57 }, documentId: "document-after-reload" }
  );
  assert.equal(response.run, null);
  assert.equal(response.quarantineReason, "new-chat-recovery");
  const quarantined = storageData["aipm.quarantinedRuns.v1"].at(-1);
  assert.equal(quarantined.runId, "new-reloaded");
  assert.equal(quarantined.resumable, false);
  assert.equal(quarantined.workflow.id, "preserved");
  assert.equal(quarantined.cursor.sendsCompleted, 1);
});

test("a durable run cannot attach to another conversation in the same tab", async () => {
  storageData["aipm.activeRun.v2.tab.58"] = {
    runId: "wrong-conversation",
    conversationKey: "chatgpt:c:original",
    boundTabId: 58,
    executionSessionId: "session-test",
    status: "running",
    keepAwake: true
  };
  currentDocumentIds.set(58, "different-document");
  const response = await invokeRuntimeMessage(
    { type: "AIPM_RUN_GET", conversationKey: "chatgpt:c:different", documentInstanceId: "different" },
    { tab: { id: 58 }, documentId: "different-document" }
  );
  assert.equal(response.run, null);
  assert.equal(response.quarantineReason, "conversation-changed");
  assert.equal(storageData["aipm.activeRun.v2.tab.58"], undefined);
});

test("a stale browser-session content script cannot overwrite current run storage", async () => {
  const response = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    run: {
      runId: "stale-writer",
      conversationKey: "chatgpt:c:stale",
      executionSessionId: "old-session",
      status: "running"
    }
  }, { tab: { id: 59 }, documentId: "stale-document" });
  assert.equal(response.ok, false);
  assert.match(response.error, /ブラウザセッション/);
  assert.equal(storageData["aipm.activeRun.v2.tab.59"], undefined);
});

test("a stale document writer cannot delete a newer stored Run", async () => {
  storageData["aipm.activeRun.v2.tab.62"] = {
    runId: "current-run",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:current",
    executionSessionId: "session-test",
    boundTabId: 62,
    boundDocumentId: "current-document",
    status: "running"
  };
  const response = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    conversationKey: "chatgpt:c:stale",
    documentInstanceId: "stale-instance",
    run: {
      runId: "stale-run",
      provider: "chatgpt",
      contentVersion: "0.4.0",
      conversationKey: "chatgpt:c:other",
      executionSessionId: "session-test",
      boundTabId: 62,
      boundDocumentId: "stale-document",
      status: "running"
    }
  }, { tab: { id: 62 }, documentId: "stale-document" });
  assert.equal(response.ok, false);
  assert.match(response.error, /現在のdocument/);
  assert.equal(storageData["aipm.activeRun.v2.tab.62"].runId, "current-run");
});

test("a stale same-conversation writer cannot roll back a newly bound document", async () => {
  currentDocumentIds.set(64, "new-document");
  storageData["aipm.activeRun.v2.tab.64"] = {
    runId: "same-run",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:same",
    executionSessionId: "session-test",
    boundTabId: 64,
    boundDocumentId: "new-document",
    documentInstanceId: "new-instance",
    cursor: { sendsCompleted: 4 },
    status: "running"
  };
  const response = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    conversationKey: "chatgpt:c:same",
    documentInstanceId: "old-instance",
    run: {
      ...storageData["aipm.activeRun.v2.tab.64"],
      boundDocumentId: "old-document",
      documentInstanceId: "old-instance",
      cursor: { sendsCompleted: 2 }
    }
  }, { tab: { id: 64 }, documentId: "old-document" });
  assert.equal(response.ok, false);
  assert.match(response.error, /現在のdocument/);
  assert.equal(storageData["aipm.activeRun.v2.tab.64"].boundDocumentId, "new-document");
  assert.equal(storageData["aipm.activeRun.v2.tab.64"].cursor.sendsCompleted, 4);
});

test("a current reloaded document can safely adopt the same durable conversation", async () => {
  currentDocumentIds.set(65, "new-document");
  storageData["aipm.activeRun.v2.tab.65"] = {
    runId: "reload-run",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:reload",
    executionSessionId: "session-test",
    boundTabId: 65,
    boundDocumentId: "old-document",
    documentInstanceId: "old-instance",
    cursor: { sendsCompleted: 1 },
    status: "running"
  };
  const getResponse = await invokeRuntimeMessage(
    { type: "AIPM_RUN_GET", conversationKey: "chatgpt:c:reload", documentInstanceId: "new-instance" },
    { tab: { id: 65 }, documentId: "new-document" }
  );
  assert.equal(getResponse.run.boundDocumentId, "new-document");
  assert.equal(getResponse.run.documentInstanceId, "new-instance");
  const setResponse = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    conversationKey: "chatgpt:c:reload",
    documentInstanceId: "new-instance",
    run: getResponse.run
  }, { tab: { id: 65 }, documentId: "new-document" });
  assert.equal(setResponse.ok, true);
  assert.equal(storageData["aipm.activeRun.v2.tab.65"].boundDocumentId, "new-document");
});

test("document-instance identity safely supports ownership checks when documentId metadata is unavailable", async () => {
  currentDocumentIds.set(70, null);
  currentDocumentInstanceIds.set(70, "new-instance");
  storageData["aipm.activeRun.v2.tab.70"] = {
    runId: "instance-fallback",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:instance-fallback",
    executionSessionId: "session-test",
    boundTabId: 70,
    boundDocumentId: "old-document",
    documentInstanceId: "old-instance",
    status: "running"
  };
  const response = await invokeRuntimeMessage(
    {
      type: "AIPM_RUN_GET",
      conversationKey: "chatgpt:c:instance-fallback",
      documentInstanceId: "new-instance"
    },
    { tab: { id: 70 } }
  );
  assert.equal(response.run.documentInstanceId, "new-instance");
  assert.equal(storageData["aipm.activeRun.v2.tab.70"].documentInstanceId, "new-instance");
});

test("a reload GET claims document ownership before an old same-conversation SET arrives", async () => {
  currentDocumentIds.set(69, "new-document");
  storageData["aipm.activeRun.v2.tab.69"] = {
    runId: "reload-claim",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:reload-claim",
    executionSessionId: "session-test",
    boundTabId: 69,
    boundDocumentId: "old-document",
    documentInstanceId: "old-instance",
    cursor: { sendsCompleted: 1 },
    outbox: null,
    status: "running"
  };
  const adopted = await invokeRuntimeMessage(
    { type: "AIPM_RUN_GET", conversationKey: "chatgpt:c:reload-claim", documentInstanceId: "new-instance" },
    { tab: { id: 69 }, documentId: "new-document" }
  );
  assert.equal(adopted.run.boundDocumentId, "new-document");
  assert.equal(storageData["aipm.activeRun.v2.tab.69"].boundDocumentId, "new-document");

  const staleSet = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    conversationKey: "chatgpt:c:reload-claim",
    documentInstanceId: "old-instance",
    run: {
      ...adopted.run,
      boundDocumentId: "old-document",
      documentInstanceId: "old-instance",
      cursor: { sendsCompleted: 0 },
      outbox: { state: "submitted" }
    }
  }, { tab: { id: 69 }, documentId: "old-document" });
  assert.equal(staleSet.ok, false);
  assert.match(staleSet.error, /現在のdocument/);
  assert.equal(storageData["aipm.activeRun.v2.tab.69"].boundDocumentId, "new-document");
  assert.equal(storageData["aipm.activeRun.v2.tab.69"].cursor.sendsCompleted, 1);
  assert.equal(storageData["aipm.activeRun.v2.tab.69"].outbox, null);
});

test("an old-document GET cannot quarantine a newer document Run", async () => {
  currentDocumentIds.set(66, "new-document");
  storageData["aipm.activeRun.v2.tab.66"] = {
    runId: "newer-run",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:newer",
    executionSessionId: "session-test",
    boundTabId: 66,
    boundDocumentId: "new-document",
    documentInstanceId: "new-instance",
    status: "running"
  };
  const response = await invokeRuntimeMessage(
    { type: "AIPM_RUN_GET", conversationKey: "chatgpt:c:old", documentInstanceId: "old-instance" },
    { tab: { id: 66 }, documentId: "old-document" }
  );
  assert.equal(response.run, null);
  assert.equal(response.staleDocument, true);
  assert.equal(storageData["aipm.activeRun.v2.tab.66"].runId, "newer-run");
});

test("an old document cannot resurrect a Run after the current document quarantines it", async () => {
  currentDocumentIds.set(71, "new-document");
  currentDocumentInstanceIds.set(71, "new-instance");
  storageData["aipm.activeRun.v2.tab.71"] = {
    runId: "old-run",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:old",
    executionSessionId: "session-test",
    boundTabId: 71,
    boundDocumentId: "old-document",
    documentInstanceId: "old-instance",
    status: "running"
  };
  const currentGet = await invokeRuntimeMessage(
    { type: "AIPM_RUN_GET", conversationKey: "chatgpt:c:new", documentInstanceId: "new-instance" },
    { tab: { id: 71 }, documentId: "new-document" }
  );
  assert.equal(currentGet.run, null);
  assert.equal(currentGet.quarantined, true);
  assert.equal(storageData["aipm.activeRun.v2.tab.71"], undefined);

  const staleSet = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    conversationKey: "chatgpt:c:old",
    documentInstanceId: "old-instance",
    run: {
      runId: "old-run",
      replacesRunId: null,
      provider: "chatgpt",
      contentVersion: "0.4.0",
      conversationKey: "chatgpt:c:old",
      executionSessionId: "session-test",
      boundTabId: 71,
      boundDocumentId: "old-document",
      documentInstanceId: "old-instance",
      status: "running"
    }
  }, { tab: { id: 71 }, documentId: "old-document" });
  assert.equal(staleSet.ok, false);
  assert.match(staleSet.error, /現在のdocument/);
  assert.equal(storageData["aipm.activeRun.v2.tab.71"], undefined);

  const newSet = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    conversationKey: "chatgpt:c:new",
    documentInstanceId: "new-instance",
    run: {
      runId: "new-run",
      replacesRunId: null,
      provider: "chatgpt",
      contentVersion: "0.4.0",
      conversationKey: "chatgpt:c:new",
      executionSessionId: "session-test",
      boundTabId: 71,
      documentInstanceId: "new-instance",
      status: "running"
    }
  }, { tab: { id: 71 }, documentId: "new-document" });
  assert.equal(newSet.ok, true);
  assert.equal(storageData["aipm.activeRun.v2.tab.71"].runId, "new-run");
});

test("a stale Run generation cannot replace an active newer Run in the same document", async () => {
  currentDocumentIds.set(67, "shared-document");
  currentDocumentInstanceIds.set(67, "shared-instance");
  storageData["aipm.activeRun.v2.tab.67"] = {
    runId: "new-generation",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:generation",
    executionSessionId: "session-test",
    boundTabId: 67,
    boundDocumentId: "shared-document",
    documentInstanceId: "shared-instance",
    status: "running"
  };
  const response = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    conversationKey: "chatgpt:c:generation",
    documentInstanceId: "shared-instance",
    run: {
      ...storageData["aipm.activeRun.v2.tab.67"],
      runId: "old-generation",
      replacesRunId: null
    }
  }, { tab: { id: 67 }, documentId: "shared-document" });
  assert.equal(response.ok, false);
  assert.match(response.error, /Run世代/);
  assert.equal(storageData["aipm.activeRun.v2.tab.67"].runId, "new-generation");
});

test("an explicitly observed terminal Run can be replaced by a new generation", async () => {
  currentDocumentIds.set(68, "shared-document");
  currentDocumentInstanceIds.set(68, "shared-instance");
  storageData["aipm.activeRun.v2.tab.68"] = {
    runId: "terminal-generation",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:generation-replace",
    executionSessionId: "session-test",
    boundTabId: 68,
    boundDocumentId: "shared-document",
    documentInstanceId: "shared-instance",
    status: "completed"
  };
  const response = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    conversationKey: "chatgpt:c:generation-replace",
    documentInstanceId: "shared-instance",
    run: {
      runId: "replacement-generation",
      replacesRunId: "terminal-generation",
      provider: "chatgpt",
      contentVersion: "0.4.0",
      conversationKey: "chatgpt:c:generation-replace",
      executionSessionId: "session-test",
      boundTabId: 68,
      documentInstanceId: "shared-instance",
      status: "running"
    }
  }, { tab: { id: 68 }, documentId: "shared-document" });
  assert.equal(response.ok, true);
  assert.equal(storageData["aipm.activeRun.v2.tab.68"].runId, "replacement-generation");
});

test("a runner update cannot overwrite Pause or Stop, while explicit Resume is allowed", async () => {
  const tabId = 74;
  currentDocumentIds.set(tabId, "control-document");
  currentDocumentInstanceIds.set(tabId, "control-instance");
  const base = {
    runId: "control-run",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:control",
    executionSessionId: "session-test",
    boundTabId: tabId,
    boundDocumentId: "control-document",
    documentInstanceId: "control-instance",
    status: "paused"
  };
  storageData[`aipm.activeRun.v2.tab.${tabId}`] = { ...base };

  const staleRunner = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    runTransition: "runner",
    conversationKey: base.conversationKey,
    documentInstanceId: base.documentInstanceId,
    run: { ...base, status: "running" }
  }, { tab: { id: tabId }, documentId: base.boundDocumentId });
  assert.equal(staleRunner.ok, false);
  assert.equal(staleRunner.errorCode, "RUN_STATE_CONFLICT");
  assert.equal(storageData[`aipm.activeRun.v2.tab.${tabId}`].status, "paused");

  const resumed = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    runTransition: "resume",
    conversationKey: base.conversationKey,
    documentInstanceId: base.documentInstanceId,
    run: { ...base, status: "running" }
  }, { tab: { id: tabId }, documentId: base.boundDocumentId });
  assert.equal(resumed.ok, true);
  assert.equal(storageData[`aipm.activeRun.v2.tab.${tabId}`].status, "running");

  storageData[`aipm.activeRun.v2.tab.${tabId}`] = { ...resumed.run, status: "stopped" };
  const afterStop = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    runTransition: "runner",
    conversationKey: base.conversationKey,
    documentInstanceId: base.documentInstanceId,
    run: { ...resumed.run, status: "running" }
  }, { tab: { id: tabId }, documentId: base.boundDocumentId });
  assert.equal(afterStop.ok, false);
  assert.equal(afterStop.errorCode, "RUN_STATE_CONFLICT");
  assert.equal(storageData[`aipm.activeRun.v2.tab.${tabId}`].status, "stopped");
});

test("Pause crossing a submission remains pending and admits only the exact adjacent runner revision", async () => {
  const tabId = 75;
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  currentDocumentIds.set(tabId, "pause-race-document");
  currentDocumentInstanceIds.set(tabId, "pause-race-instance");
  const base = {
    runId: "pause-race-run",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:pause-race",
    executionSessionId: "session-test",
    boundTabId: tabId,
    boundDocumentId: "pause-race-document",
    documentInstanceId: "pause-race-instance",
    status: "running",
    phase: "submitting",
    stateRevision: 8,
    resumable: true,
    outbox: { state: "prepared", id: "outbox-race" }
  };
  storageData[key] = { ...base };

  const response = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    runTransition: "pause-request",
    conversationKey: base.conversationKey,
    documentInstanceId: base.documentInstanceId,
    run: { ...base, pauseRequested: true, pauseRequestedAt: "2026-08-24T00:00:00.000Z" }
  }, { tab: { id: tabId }, documentId: base.boundDocumentId });

  assert.equal(response.ok, true);
  assert.equal(response.run.status, "running");
  assert.equal(response.run.phase, "submitting");
  assert.equal(response.run.pauseRequested, true);
  assert.equal(response.run.resumable, true);
  assert.equal(response.run.outbox.id, "outbox-race");
  assert.equal(response.run.pauseRequestBaseRevision, 8);
  assert.equal(response.run.pauseRequestRevision, 9);

  const adjacentRunner = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    runTransition: "runner",
    conversationKey: base.conversationKey,
    documentInstanceId: base.documentInstanceId,
    run: {
      ...base,
      phase: "waiting-ack",
      outbox: { state: "submitted", id: "outbox-race" }
    }
  }, { tab: { id: tabId }, documentId: base.boundDocumentId });
  assert.equal(adjacentRunner.ok, true, "the exact in-flight runner must be allowed to finish ACK");
  assert.equal(adjacentRunner.run.pauseRequested, true);
  assert.equal(adjacentRunner.run.stateRevision, 10);

  const replayedOldRunner = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    runTransition: "runner",
    conversationKey: base.conversationKey,
    documentInstanceId: base.documentInstanceId,
    run: { ...base, phase: "waiting-ack", outbox: { state: "submitted", id: "outbox-race" } }
  }, { tab: { id: tabId }, documentId: base.boundDocumentId });
  assert.equal(replayedOldRunner.ok, false, "the stale revision exception is single-use");
  assert.equal(replayedOldRunner.errorCode, "RUN_STATE_CONFLICT");
});

test("an old bound document cannot read an active Run after a newer top document loads", async () => {
  const tabId = 76;
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  currentDocumentIds.set(tabId, "new-top-document");
  storageData[key] = {
    runId: "old-bound-run",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:same-conversation",
    executionSessionId: "session-test",
    boundTabId: tabId,
    boundDocumentId: "old-bound-document",
    documentInstanceId: "old-bound-instance",
    status: "running"
  };

  const response = await invokeRuntimeMessage(
    { type: "AIPM_RUN_GET", conversationKey: "chatgpt:c:same-conversation", documentInstanceId: "old-bound-instance" },
    { tab: { id: tabId }, documentId: "old-bound-document" }
  );

  assert.equal(response.run, null);
  assert.equal(response.staleDocument, true);
  assert.equal(storageData[key].runId, "old-bound-run");
  assert.equal(storageData[key].boundDocumentId, "old-bound-document");
});

test("an old document quarantine cannot erase a queued new-document Run", async () => {
  currentDocumentIds.set(61, "old-document");
  currentDocumentInstanceIds.set(61, "old-instance");
  storageData["aipm.activeRun.v2.tab.61"] = {
    runId: "old-document-run",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:old",
    executionSessionId: "session-test",
    boundTabId: 61,
    boundDocumentId: "old-document",
    status: "running"
  };
  storageSetGate = deferred();
  storageSetMatchKey = "aipm.quarantinedRuns.v1";
  const quarantineEntered = deferred();
  storageSetEntered = quarantineEntered.resolve;

  const oldGet = invokeRuntimeMessage(
    { type: "AIPM_RUN_GET", conversationKey: "chatgpt:c:navigated", documentInstanceId: "old-instance" },
    { tab: { id: 61 }, documentId: "old-document" }
  );
  await quarantineEntered.promise;
  currentDocumentIds.set(61, "new-document");
  currentDocumentInstanceIds.set(61, "new-instance");
  const newSet = invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    conversationKey: "chatgpt:c:new",
    documentInstanceId: "new-instance",
    run: {
      runId: "new-document-run",
      provider: "chatgpt",
      contentVersion: "0.4.0",
      conversationKey: "chatgpt:c:new",
      executionSessionId: "session-test",
      status: "running"
    }
  }, { tab: { id: 61 }, documentId: "new-document" });

  storageSetGate.resolve();
  const [oldResponse, newResponse] = await Promise.all([oldGet, newSet]);
  storageSetGate = null;
  storageSetMatchKey = null;
  storageSetEntered = null;
  assert.equal(oldResponse.run, null);
  assert.equal(newResponse.ok, true);
  assert.equal(storageData["aipm.activeRun.v2.tab.61"].runId, "new-document-run");
});

test("keep-awake uses system level while any opted-in open-tab run is running", async () => {
  queryTabs = [{ id: 41, active: true, windowId: 1 }, { id: 42, active: false, windowId: 1 }];
  delete storageData["aipm.activeRun.v2.tab.41"];
  delete storageData["aipm.activeRun.v2.tab.42"];
  currentDocumentIds.set(41, null);
  currentDocumentInstanceIds.set(41, "awake-instance");
  powerRequests.length = 0;
  const releasesBefore = powerReleaseCount;

  const running = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    conversationKey: "chatgpt:c:a",
    documentInstanceId: "awake-instance",
    run: { runId: "awake", provider: "chatgpt", contentVersion: "0.4.0", conversationKey: "chatgpt:c:a", status: "running", keepAwake: true, executionSessionId: "session-test" }
  }, { tab: { id: 41 } });
  await flushAsync();
  assert.ok(powerRequests.includes("system"));

  await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    conversationKey: "chatgpt:c:a",
    documentInstanceId: "awake-instance",
    runTransition: "pause",
    run: { ...running.run, status: "paused" }
  }, { tab: { id: 41 } });
  await flushAsync();
  assert.ok(powerReleaseCount > releasesBefore);
});

test("a power reconciliation failure does not turn a committed Run into a phantom failed Start", async () => {
  const tabId = 73;
  queryTabs = [{ id: tabId, active: true, windowId: 1 }];
  currentDocumentIds.set(tabId, "power-warning-document");
  currentDocumentInstanceIds.set(tabId, "power-warning-instance");
  delete storageData[`aipm.activeRun.v2.tab.${tabId}`];
  queryError = new Error("tabs unavailable during power reconciliation");

  const response = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    conversationKey: "chatgpt:c:power-warning",
    documentInstanceId: "power-warning-instance",
    run: {
      runId: "power-warning-run",
      replacesRunId: null,
      provider: "chatgpt",
      contentVersion: "0.4.0",
      conversationKey: "chatgpt:c:power-warning",
      executionSessionId: "session-test",
      boundTabId: tabId,
      documentInstanceId: "power-warning-instance",
      status: "running",
      keepAwake: true
    }
  }, { tab: { id: tabId }, documentId: "power-warning-document" });
  assert.equal(response.ok, true);
  assert.equal(response.powerWarning.code, "POWER_RECONCILE_FAILED");
  assert.equal(storageData[`aipm.activeRun.v2.tab.${tabId}`].runId, "power-warning-run");

  const paused = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    conversationKey: "chatgpt:c:power-warning",
    documentInstanceId: "power-warning-instance",
    run: { ...response.run, status: "paused" }
  }, { tab: { id: tabId }, documentId: "power-warning-document" });
  assert.equal(paused.ok, true);
});

test("queued power reconciliation cannot reacquire keep-awake after a later pause", async () => {
  const tabId = 63;
  queryTabs = [{ id: tabId, active: true, windowId: 1 }];
  currentDocumentIds.set(tabId, "power-document");
  delete storageData[`aipm.activeRun.v2.tab.${tabId}`];
  powerEvents.length = 0;
  storageGetGate = deferred();
  storageGetMatchKey = `aipm.activeRun.v2.tab.${tabId}`;
  const getEntered = deferred();
  storageGetEntered = getEntered.resolve;

  const runningRequest = invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    conversationKey: "chatgpt:c:power-race",
    documentInstanceId: "power-instance",
    run: {
      runId: "power-race",
      provider: "chatgpt",
      contentVersion: "0.4.0",
      conversationKey: "chatgpt:c:power-race",
      executionSessionId: "session-test",
      status: "running",
      keepAwake: true
    }
  }, { tab: { id: tabId }, documentId: "power-document" });
  await getEntered.promise;

  const pausedRequest = invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    conversationKey: "chatgpt:c:power-race",
    documentInstanceId: "power-instance",
    runTransition: "pause",
    run: {
      runId: "power-race",
      provider: "chatgpt",
      contentVersion: "0.4.0",
      conversationKey: "chatgpt:c:power-race",
      executionSessionId: "session-test",
      boundTabId: tabId,
      documentInstanceId: "power-instance",
      keepAwake: true,
      status: "paused",
      stateRevision: 1
    }
  }, { tab: { id: tabId }, documentId: "power-document" });

  storageGetGate.resolve();
  storageGetGate = null;
  storageGetMatchKey = null;
  storageGetEntered = null;
  const [runningResponse, pausedResponse] = await Promise.all([runningRequest, pausedRequest]);
  assert.equal(runningResponse.ok, true);
  assert.equal(pausedResponse.ok, true);
  assert.equal(powerEvents.at(-1), "release");
});

test("listing ChatGPT tabs exposes bounded runtime metadata without tab titles", async () => {
  queryTabs = [
    { id: 71, active: true, windowId: 4, title: "Sensitive conversation title" },
    { id: 72, active: false, windowId: 4, title: "Another title" }
  ];
  relayResponsesByTab.set(71, {
    ok: true,
    pageReady: true,
    generationState: "idle",
    blocker: null,
    conversationKey: "chatgpt:c:abc",
    run: { status: "running", plannedSends: 2, cursor: { sendsCompleted: 1 } }
  });
  relayResponsesByTab.set(72, { ok: true, pageReady: true, conversationKey: "chatgpt:c:def", run: null });

  const response = await invokeRuntimeMessage({ type: "AIPM_LIST_CHATGPT_TABS" });
  assert.equal(response.ok, true);
  assert.equal(response.tabs.length, 2);
  assert.equal(response.tabs[0].tabId, 71);
  assert.equal(Object.hasOwn(response.tabs[0], "title"), false);
  assert.equal(response.tabs[0].status.conversationKey, "chatgpt:c:abc");
  assert.equal(response.tabs[0].status.run.status, "running");
  assert.equal(response.serviceWorkerVersion, "0.4.0");
  assert.equal(response.siteAccessGranted, true);
});

test("listing self-heals a ChatGPT tab whose declared receiver is missing", async () => {
  queryTabs = [{ id: 73, active: true, windowId: 4 }];
  relayResponsesByTab.delete(73);
  relayResponse = { ok: true, provider: "chatgpt", pageReady: true, conversationKey: "chatgpt:c:self-healed", contentVersion: "0.4.0", run: null };
  probeResult = { origin: "https://chatgpt.com", corePresent: false, controllerReady: false, version: null };
  receiverUnavailableUntilInjectedTabs.add(73);
  injectedTabs.delete(73);
  const before = scriptExecutions.length;

  const response = await invokeRuntimeMessage({ type: "AIPM_LIST_CHATGPT_TABS" });

  assert.equal(response.ok, true);
  assert.equal(response.tabs.length, 1);
  assert.equal(response.tabs[0].tabId, 73);
  assert.equal(response.tabs[0].status.contentVersion, "0.4.0");
  assert.equal(response.failedChatGptTabs, 0);
  const executions = scriptExecutions.slice(before);
  assert.equal(executions.length, 3);
  assert.ok(executions[0].func);
  assert.ok(executions[1].func);
  assert.deepEqual(executions[2].files, ["src/content-core.js", "src/content-runner.js", "src/content-controller.js"]);
  receiverUnavailableUntilInjectedTabs.delete(73);
});

test("listing excludes a non-ChatGPT tab without injecting content scripts", async () => {
  queryTabs = [{ id: 74, active: true, windowId: 4 }];
  probeResult = { origin: "https://example.com", corePresent: false, controllerReady: false, version: null };
  sendFailuresRemaining = 1;
  const before = scriptExecutions.length;

  const response = await invokeRuntimeMessage({ type: "AIPM_LIST_CHATGPT_TABS" });

  assert.equal(response.ok, true);
  assert.equal(response.tabs.length, 0);
  assert.equal(scriptExecutions.slice(before).filter((x) => x.files).length, 0);
});

test("listing exposes tabs.query failures instead of converting them to an empty list", async () => {
  queryError = new Error("tabs query failed on device");
  const response = await invokeRuntimeMessage({ type: "AIPM_LIST_CHATGPT_TABS" });
  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "TAB_ENUMERATION_FAILED");
});

test("listing reports withheld ChatGPT site access before querying tabs", async () => {
  siteAccessGranted = false;
  const beforeQueries = tabQueries.length;
  const response = await invokeRuntimeMessage({ type: "AIPM_LIST_CHATGPT_TABS" });
  siteAccessGranted = true;
  assert.equal(response.ok, false);
  assert.equal(response.siteAccessGranted, false);
  assert.match(response.error, /サイトアクセス/);
  assert.equal(tabQueries.length, beforeQueries);
});

test("listing retains a URL-confirmed ChatGPT tab when the read-only probe throws", async () => {
  queryTabs = [{ id: 75, active: true, windowId: 4, url: "https://chatgpt.com/c/probe-failure" }];
  receiverUnavailableUntilInjectedTabs.add(75);
  injectedTabs.delete(75);
  probeErrorTabs.add(75);
  const before = scriptExecutions.length;

  const response = await invokeRuntimeMessage({ type: "AIPM_LIST_CHATGPT_TABS" });

  assert.equal(response.ok, true);
  assert.equal(response.tabs.length, 1);
  assert.equal(response.tabs[0].tabId, 75);
  assert.equal(response.tabs[0].status.discoveryError, "probe-failed");
  assert.equal(response.failedChatGptTabs, 1);
  assert.equal(scriptExecutions.slice(before).filter((item) => item.files).length, 0);
  probeErrorTabs.delete(75);
  receiverUnavailableUntilInjectedTabs.delete(75);
});

test("listing surfaces an unclassified active tab failure instead of reporting an empty success", async () => {
  queryTabs = [{ id: 76, active: true, windowId: 4 }];
  receiverUnavailableUntilInjectedTabs.add(76);
  probeErrorTabs.add(76);

  const response = await invokeRuntimeMessage({ type: "AIPM_LIST_CHATGPT_TABS" });

  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "CHATGPT_TAB_DISCOVERY_INCOMPLETE");
  assert.equal(response.tabs.length, 0);
  assert.equal(response.unknownTabFailures, 1);
  probeErrorTabs.delete(76);
  receiverUnavailableUntilInjectedTabs.delete(76);
});

test("one hung receiver cannot block healthy ChatGPT tabs indefinitely", async () => {
  queryTabs = [
    { id: 201, active: true, windowId: 5, url: "https://chatgpt.com/c/healthy" },
    { id: 202, active: false, windowId: 5, url: "https://chatgpt.com/c/hung" }
  ];
  relayResponsesByTab.set(201, { ok: true, conversationKey: "chatgpt:c:healthy" });
  statusNeverTabs.add(202);
  probeResultsByTab.set(202, {
    origin: "https://chatgpt.com",
    corePresent: true,
    controllerReady: false,
    version: "0.4.0"
  });
  const startedAt = Date.now();

  const response = await invokeRuntimeMessage({ type: "AIPM_LIST_CHATGPT_TABS" });

  assert.equal(response.ok, true);
  assert.ok(response.tabs.some((item) => item.tabId === 201));
  assert.equal(response.partial, true);
  assert.ok(Date.now() - startedAt < 3_500);
  statusNeverTabs.delete(202);
  probeResultsByTab.delete(202);
  relayResponsesByTab.delete(201);
});

test("a never-resolving probe is bounded and leaves a confirmed tab visible without injecting", async () => {
  queryTabs = [{ id: 203, active: true, windowId: 5, url: "https://chatgpt.com/c/probe-timeout" }];
  receiverUnavailableUntilInjectedTabs.add(203);
  probeNeverTabs.add(203);
  const before = scriptExecutions.length;
  const startedAt = Date.now();

  const response = await invokeRuntimeMessage({ type: "AIPM_LIST_CHATGPT_TABS" });

  assert.equal(response.ok, true);
  assert.equal(response.tabs[0].status.discoveryError, "probe-timeout");
  assert.equal(scriptExecutions.slice(before).filter((item) => item.files).length, 0);
  assert.ok(Date.now() - startedAt < 2_500);
  probeNeverTabs.delete(203);
  receiverUnavailableUntilInjectedTabs.delete(203);
});

test("a never-resolving tabs.query returns a bounded explicit error", async () => {
  queryNeverResolves = true;
  const startedAt = Date.now();
  const response = await invokeRuntimeMessage({ type: "AIPM_LIST_CHATGPT_TABS" });
  queryNeverResolves = false;
  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "TAB_ENUMERATION_TIMEOUT");
  assert.ok(Date.now() - startedAt < 2_500);
});

test("a never-resolving permission check does not freeze receiver-based discovery", async () => {
  siteAccessNeverResolves = true;
  queryTabs = [{ id: 204, active: true, windowId: 5 }];
  relayResponsesByTab.set(204, { ok: true, conversationKey: "chatgpt:c:permission-timeout" });
  const startedAt = Date.now();

  const response = await invokeRuntimeMessage({ type: "AIPM_LIST_CHATGPT_TABS" });

  siteAccessNeverResolves = false;
  relayResponsesByTab.delete(204);
  assert.equal(response.ok, true);
  assert.equal(response.tabs[0].tabId, 204);
  assert.equal(response.siteAccessGranted, null);
  assert.ok(Date.now() - startedAt < 2_500);
});

test("HIGH-PERF: ten refreshes against a simulated 10s renderer hang create one status and no fallback probe", async () => {
  const tabId = 401;
  queryTabs = [{ id: tabId, active: true, windowId: 7, url: "https://chatgpt.com/c/perf-hang" }];
  statusNeverTabs.add(tabId);
  probeResultsByTab.set(tabId, {
    origin: "https://chatgpt.com",
    corePresent: true,
    controllerReady: true,
    version: "0.4.0"
  });
  const beforeMessages = tabMessages.length;
  const beforeScripts = scriptExecutions.length;

  const responses = await Promise.all(Array.from({ length: 10 }, () => invokeRuntimeMessage({
    type: "AIPM_RELAY_TO_CHATGPT",
    targetTabId: tabId,
    payload: { type: "AIPM_GET_STATUS" }
  })));

  const statusContacts = tabMessages.slice(beforeMessages)
    .filter((item) => item.tabId === tabId && item.payload.type === "AIPM_GET_STATUS");
  const probes = scriptExecutions.slice(beforeScripts)
    .filter((item) => item.target?.tabId === tabId && item.func &&
      !String(item.func).includes("__AIPM_DOCUMENT_INSTANCE_ID__"));
  assert.equal(statusContacts.length, 1);
  assert.equal(probes.length, 0);
  assert.ok(responses.every((response) => response.ok === false));

  statusNeverTabs.delete(tabId);
  probeResultsByTab.delete(tabId);
});

test("HIGH-PERF: ten callers share one content probe after an immediate receiver miss", async () => {
  const tabId = 403;
  queryTabs = [{ id: tabId, active: true, windowId: 7, url: "https://chatgpt.com/c/probe-hang" }];
  receiverUnavailableUntilInjectedTabs.add(tabId);
  injectedTabs.delete(tabId);
  probeNeverTabs.add(tabId);
  const beforeScripts = scriptExecutions.length;

  const responses = await Promise.all(Array.from({ length: 10 }, () => invokeRuntimeMessage({
    type: "AIPM_RELAY_TO_CHATGPT",
    targetTabId: tabId,
    payload: { type: "AIPM_GET_STATUS" }
  })));

  const probes = scriptExecutions.slice(beforeScripts)
    .filter((item) => item.target?.tabId === tabId && item.func &&
      !String(item.func).includes("__AIPM_DOCUMENT_INSTANCE_ID__"));
  assert.equal(probes.length, 1);
  assert.ok(responses.every((response) => response.ok === false));
  receiverUnavailableUntilInjectedTabs.delete(tabId);
  probeNeverTabs.delete(tabId);
});

test("HIGH-PERF: concurrent Run observations keep document identity outstanding at one", async () => {
  const tabId = 402;
  const identityGate = deferred();
  storageData[`aipm.activeRun.v2.tab.${tabId}`] = {
    runId: "perf-run",
    executionSessionId: "session-test",
    provider: "chatgpt",
    conversationKey: "chatgpt:c:perf-run",
    documentInstanceId: "instance-perf-run",
    boundTabId: tabId,
    status: "running"
  };
  documentIdentityProbePlans.set(tabId, [async () => {
    await identityGate.promise;
    return { documentId: "document-perf-run", documentInstanceId: "instance-perf-run" };
  }]);
  const before = documentIdentityProbeCounts.get(tabId) ?? 0;
  const sender = { tab: { id: tabId }, documentId: "document-perf-run" };

  const responses = await Promise.all(Array.from({ length: 10 }, () => invokeRuntimeMessage({
    type: "AIPM_RUN_GET",
    conversationKey: "chatgpt:c:perf-run",
    documentInstanceId: "instance-perf-run",
    readOnlyObservation: true
  }, sender)));

  assert.equal((documentIdentityProbeCounts.get(tabId) ?? 0) - before, 1);
  assert.ok(responses.every((response) => response.ok === false));
  identityGate.resolve();
  await flushAsync();
  documentIdentityProbePlans.delete(tabId);
  delete storageData[`aipm.activeRun.v2.tab.${tabId}`];
});

test("run observation timeout preserves structured failure and cannot wedge a fresh new-document read", async () => {
  const tabId = 499;
  const key = `aipm.activeRun.v2.tab.${tabId}`;
  storageGetNeverOnceKey = key;
  const timedOut = await invokeRuntimeMessage({
    type: "AIPM_RUN_GET",
    conversationKey: "chatgpt:c:before-reload",
    documentInstanceId: "instance-before-reload",
    readOnlyObservation: true
  }, { tab: { id: tabId }, documentId: "document-before-reload" });

  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.errorCode, "RUN_OBSERVATION_TIMEOUT");
  assert.equal(timedOut.errorPhase, "run-observation");
  assert.doesNotMatch(timedOut.error, /RUN_OBSERVATION_TIMEOUT/);

  const recovered = await invokeRuntimeMessage({
    type: "AIPM_RUN_GET",
    conversationKey: "chatgpt:c:after-reload",
    documentInstanceId: "instance-after-reload"
  }, { tab: { id: tabId }, documentId: "document-after-reload" });
  assert.deepEqual(recovered, { ok: true, run: null });
});

test("completion-oriented status recovery is propagated through the background contact", async () => {
  const tabId = 405;
  const before = tabMessages.length;
  const response = await invokeRuntimeMessage({
    type: "AIPM_RELAY_TO_CHATGPT",
    targetTabId: tabId,
    payload: {
      type: "AIPM_GET_STATUS",
      readOnlyRecovery: {
        mode: "completion",
        identityAttempts: 10,
        readiness: "long",
        statusRecovery: "persistent"
      }
    }
  });
  assert.equal(response.ok, true);
  const statusContact = tabMessages.slice(before)
    .find((item) => item.tabId === tabId && item.payload.type === "AIPM_GET_STATUS");
  assert.ok(statusContact);
  assert.equal(statusContact.payload.readOnlyObservation, true);
  assert.equal(statusContact.payload.readOnlyRecovery.mode, "completion");
  assert.equal(statusContact.payload.readOnlyRecovery.identityAttempts, 10);
  assert.equal(statusContact.payload.readOnlyRecovery.statusRetryAttempts, 12);
});

test("active-run guard checks all open tab-scoped runs", async () => {
  queryTabs = [{ id: 41, active: true, windowId: 1 }, { id: 42, active: false, windowId: 1 }];
  storageData["aipm.activeRun.v2.tab.41"] = { status: "completed", executionSessionId: "session-test" };
  storageData["aipm.activeRun.v2.tab.42"] = { status: "paused", executionSessionId: "session-test" };
  const response = await invokeRuntimeMessage({ type: "AIPM_HAS_ACTIVE_RUNS" });
  assert.equal(response.active, true);
  assert.equal(response.count, 1);
});

test("relay fails closed when no active tab accepts the message", async () => {
  queryTabs = [];
  const response = await invokeRuntimeMessage({
    type: "AIPM_RELAY_TO_CHATGPT",
    payload: { type: "AIPM_GET_STATUS" }
  });
  assert.equal(response.ok, false);
  assert.match(response.relayError, /アクティブなブラウザタブを取得できません/);
});

test("relay self-heals by injecting content scripts when the receiver is missing", async () => {
  queryTabs = [{ id: 88, active: true, windowId: 1 }];
  relayResponse = { ok: true, provider: "chatgpt", contentVersion: "0.4.0", pageReady: true, run: null };
  relayResponsesByTab.delete(88);
  probeResult = { origin: "https://chatgpt.com", corePresent: false, controllerReady: false, version: null };
  receiverUnavailableUntilInjectedTabs.add(88);
  injectedTabs.delete(88);
  const before = scriptExecutions.length;
  const response = await invokeRuntimeMessage({
    type: "AIPM_RELAY_TO_CHATGPT",
    payload: { type: "AIPM_GET_STATUS" }
  });
  assert.equal(response.ok, true);
  assert.equal(response.pageReady, true);
  assert.equal(response.contentVersion, "0.4.0");
  const executions = scriptExecutions.slice(before);
  assert.equal(executions.length, 3);
  assert.ok(executions[0].func);
  assert.ok(executions[1].func);
  assert.deepEqual(executions[2].files, ["src/content-core.js", "src/content-runner.js", "src/content-controller.js"]);
  assert.equal(tabMessages.at(-1).tabId, 88);
  receiverUnavailableUntilInjectedTabs.delete(88);
});

test("concurrent discovery and relay share one content-script injection", async () => {
  queryTabs = [{ id: 205, active: true, windowId: 5, url: "https://chatgpt.com/c/concurrent" }];
  relayResponsesByTab.set(205, { ok: true, conversationKey: "chatgpt:c:concurrent" });
  receiverUnavailableUntilInjectedTabs.add(205);
  injectedTabs.delete(205);
  probeResultsByTab.set(205, {
    origin: "https://chatgpt.com",
    corePresent: false,
    controllerReady: false,
    version: null
  });
  injectionGate = deferred();
  const before = scriptExecutions.length;

  const listing = invokeRuntimeMessage({ type: "AIPM_LIST_CHATGPT_TABS" });
  const relay = invokeRuntimeMessage({
    type: "AIPM_RELAY_TO_CHATGPT",
    targetTabId: 205,
    payload: { type: "AIPM_GET_STATUS" }
  });

  const waitDeadline = Date.now() + 2_000;
  while (scriptExecutions.slice(before).filter((item) => item.files).length === 0 && Date.now() < waitDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(scriptExecutions.slice(before).filter((item) => item.files).length, 1);
  injectionGate.resolve();
  const [listResponse, relayResult] = await Promise.all([listing, relay]);

  assert.equal(listResponse.ok, true);
  assert.equal(relayResult.ok, true);
  assert.equal(scriptExecutions.slice(before).filter((item) => item.files).length, 1);
  injectionGate = null;
  receiverUnavailableUntilInjectedTabs.delete(205);
  probeResultsByTab.delete(205);
  relayResponsesByTab.delete(205);
});

test("version-mismatched content remains visible but receives no mutating command", async () => {
  queryTabs = [{ id: 206, active: true, windowId: 5, url: "https://chatgpt.com/c/old-content" }];
  relayResponsesByTab.set(206, {
    ok: true,
    provider: "chatgpt",
    contentVersion: "0.2.5",
    conversationKey: "chatgpt:c:old-content"
  });
  const listResponse = await invokeRuntimeMessage({ type: "AIPM_LIST_CHATGPT_TABS" });
  assert.equal(listResponse.ok, true);
  assert.equal(listResponse.tabs[0].status.discoveryError, "version-mismatch");

  const beforeMessages = tabMessages.length;
  const startResponse = await invokeRuntimeMessage({
    type: "AIPM_RELAY_TO_CHATGPT",
    targetTabId: 206,
    payload: { type: "AIPM_START", workflow: { id: "must-not-send" } }
  });
  const messages = tabMessages.slice(beforeMessages).filter((item) => item.tabId === 206);
  assert.equal(startResponse.ok, false);
  assert.equal(startResponse.relayErrorCode, "CONTENT_VERSION_MISMATCH");
  assert.equal(messages.filter((item) => item.payload.type === "AIPM_GET_STATUS").length, 1);
  assert.equal(messages.filter((item) => item.payload.type === "AIPM_START").length, 0);
  relayResponsesByTab.delete(206);
});

test("relay reports a non-ChatGPT active tab without injecting", async () => {
  queryTabs = [{ id: 99, active: true, windowId: 1 }];
  probeResult = { origin: "https://example.com", corePresent: false, controllerReady: false, version: null };
  sendFailuresRemaining = 1;
  const before = scriptExecutions.length;
  const response = await invokeRuntimeMessage({
    type: "AIPM_RELAY_TO_CHATGPT",
    payload: { type: "AIPM_GET_STATUS" }
  });
  assert.equal(response.ok, false);
  assert.match(response.relayError, /ChatGPTタブを選択/);
  assert.equal(scriptExecutions.slice(before).filter((x) => x.files).length, 0);
});

test("relay waits for an in-progress content bootstrap instead of reinjecting", async () => {
  queryTabs = [{ id: 111, active: true, windowId: 1 }];
  relayResponse = { ok: true, pageReady: true, run: null };
  probeResult = { origin: "https://chatgpt.com", corePresent: true, controllerReady: false, version: "0.4.0" };
  sendFailuresRemaining = 2;
  const before = scriptExecutions.length;
  const response = await invokeRuntimeMessage({
    type: "AIPM_RELAY_TO_CHATGPT",
    payload: { type: "AIPM_GET_STATUS" }
  });
  assert.equal(response.ok, true);
  assert.equal(response.pageReady, true);
  assert.equal(response.contentVersion, "0.4.0");
  const executions = scriptExecutions.slice(before);
  assert.equal(executions.filter((x) => x.files).length, 0);
  assert.ok(tabMessages.filter((x) => x.tabId === 111).length >= 3);
});

test("relay fails closed when an existing content bootstrap never becomes reachable", async () => {
  queryTabs = [{ id: 112, active: true, windowId: 1 }];
  probeResult = { origin: "https://chatgpt.com", corePresent: true, controllerReady: false, version: "0.4.0" };
  sendFailuresRemaining = 20;
  const before = scriptExecutions.length;
  const response = await invokeRuntimeMessage({
    type: "AIPM_RELAY_TO_CHATGPT",
    payload: { type: "AIPM_GET_STATUS" }
  });
  assert.equal(response.ok, false);
  assert.match(response.relayError, /二重注入を避ける/);
  assert.equal(scriptExecutions.slice(before).filter((x) => x.files).length, 0);
  sendFailuresRemaining = 0;
});

test("Overnight C4: ambiguous Start delivery is never retried or falsely reported stopped", async () => {
  queryTabs = [{ id: 113, active: true, windowId: 1 }];
  currentDocumentInstanceIds.set(113, "instance-113");
  probeResult = { origin: "https://chatgpt.com", corePresent: true, controllerReady: true, version: "0.4.0" };
  commandFailuresRemaining = 1;
  const beforeMessages = tabMessages.length;

  const response = await invokeRuntimeMessage({
    type: "AIPM_RELAY_TO_CHATGPT",
    targetTabId: 113,
    payload: { type: "AIPM_START", workflow: { id: "ambiguous" } }
  });

  assert.equal(response.ok, false);
  assert.match(response.relayError, /自動再送しません/);
  assert.match(response.relayError, /状態を更新/);
  assert.doesNotMatch(response.relayError, /停止しました/);
  const sentMessages = tabMessages.slice(beforeMessages).filter((item) => item.tabId === 113);
  assert.equal(sentMessages.filter((item) => item.payload.type === "AIPM_GET_STATUS").length, 1);
  assert.equal(sentMessages.filter((item) => item.payload.type === "AIPM_START").length, 1);
  commandFailuresRemaining = 0;
});

test("browser startup quarantines tab-bound state and releases stale keep-awake", async () => {
  const oldSessionId = sessionStorageData["aipm.executionSession.v1"];
  queryTabs = [{ id: 300, active: true, windowId: 6, url: "https://chatgpt.com/c/reused" }];
  storageData["aipm.activeRun.v2.tab.300"] = {
    runId: "before-restart",
    conversationKey: "chatgpt:c:before-restart",
    executionSessionId: oldSessionId,
    boundTabId: 300,
    status: "running",
    keepAwake: true,
    workflow: { id: "preserve-me" },
    cursor: { sendsCompleted: 2 }
  };
  storageData["aipm.schedules.v1"] = {
    "aipm.wait.before-restart.step": {
      runId: "before-restart",
      stepId: "step",
      tabId: 300,
      whenMs: Date.now() + 60_000,
      executionSessionId: oldSessionId
    }
  };
  storageData["aipm.alarmSignals.v1"] = { stale: { executionSessionId: oldSessionId } };
  storageData["aipm.leases.v1"] = { "chatgpt:c:before-restart": { owner: "old" } };
  storageData["aipm.uiByTab.v2"] = { 300: { quick: { prompt: "stale prompt" } } };
  storageData["aipm.selectedTab.v1"] = 300;
  alarms.set("aipm.wait.before-restart.step", { name: "aipm.wait.before-restart.step", when: Date.now() + 60_000 });
  const releasesBefore = powerReleaseCount;

  await listeners.startup[0]();

  const nextSessionId = sessionStorageData["aipm.executionSession.v1"];
  assert.notEqual(nextSessionId, oldSessionId);
  assert.equal(storageData["aipm.activeRun.v2.tab.300"], undefined);
  const quarantined = storageData["aipm.quarantinedRuns.v1"].find((run) => run.runId === "before-restart");
  assert.equal(quarantined.status, "paused");
  assert.equal(quarantined.resumable, false);
  assert.equal(quarantined.workflow.id, "preserve-me");
  assert.deepEqual(storageData["aipm.schedules.v1"], {});
  assert.deepEqual(storageData["aipm.alarmSignals.v1"], {});
  assert.deepEqual(storageData["aipm.leases.v1"], {});
  assert.equal(storageData["aipm.uiByTab.v2"], undefined);
  assert.equal(storageData["aipm.selectedTab.v1"], undefined);
  assert.equal(alarms.has("aipm.wait.before-restart.step"), false);
  assert.ok(powerReleaseCount > releasesBefore);

  const getResponse = await invokeRuntimeMessage(
    { type: "AIPM_RUN_GET", conversationKey: "chatgpt:c:reused", documentInstanceId: "new-instance" },
    { tab: { id: 300 }, documentId: "new-document" }
  );
  assert.equal(getResponse.run, null);
});

test("closing a tab removes its editor state and selected-target binding", async () => {
  storageData["aipm.uiByTab.v2"] = {
    501: { quick: { prompt: "closed-tab prompt" } },
    502: { quick: { prompt: "other-tab prompt" } }
  };
  storageData["aipm.selectedTab.v1"] = 501;

  listeners.tabRemoved[0](501);
  await flushAsync();
  await flushAsync();

  assert.deepEqual(storageData["aipm.uiByTab.v2"], {
    502: { quick: { prompt: "other-tab prompt" } }
  });
  assert.equal(storageData["aipm.selectedTab.v1"], undefined);
});

test("a transient lifecycle initialization failure is retried by the next runtime request", async () => {
  sessionSetFailuresRemaining = 1;
  await assert.rejects(listeners.startup[0](), /transient session storage failure/);

  queryTabs = [{ id: 400, active: true, windowId: 9, url: "https://chatgpt.com/" }];
  relayResponsesByTab.set(400, {
    ok: true,
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:lifecycle-retry",
    instanceId: "instance-400",
    pageReady: true,
    run: null
  });
  const response = await invokeRuntimeMessage({ type: "AIPM_LIST_CHATGPT_TABS" });
  assert.equal(response.ok, true);
  assert.equal(response.tabs[0].tabId, 400);

  const second = await invokeRuntimeMessage({ type: "AIPM_LIST_CHATGPT_TABS" });
  assert.equal(second.ok, true);
});
