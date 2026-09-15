// A focused Service Worker harness for the torture suites.
//
// `tests/background.test.mjs` builds its fake `chrome` inline and grows it per assertion.
// The torture suites need the same Service Worker but with explicit, scriptable control of
// the three things every safety decision depends on:
//
//   - what the document-identity probe returns, attempt by attempt
//   - what the content script answers for AIPM_GET_STATUS
//   - whether a command delivery succeeds, fails, or never settles
//
// `installBackgroundHarness()` installs `globalThis.chrome` and imports `src/background.js`
// exactly once per test file (module-level listeners and caches are per-import), so a file
// calls it once and gives each test its own tab id.
export const EXTENSION_VERSION = "0.4.0";
export const DEFAULT_SESSION_ID = "session-torture";

const SESSION_KEY = "aipm.executionSession.v1";

export function activeRunKey(tabId) {
  return `aipm.activeRun.v2.tab.${tabId}`;
}

export function leaseKey(conversationKey) {
  return `aipm.lease.v2.${encodeURIComponent(conversationKey)}`;
}

export function alarmName(runId, stepId) {
  return `aipm.wait.${encodeURIComponent(runId)}.${encodeURIComponent(stepId)}`;
}

export function makeRun(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: "run-torture",
    provider: "chatgpt",
    contentVersion: EXTENSION_VERSION,
    executionSessionId: DEFAULT_SESSION_ID,
    conversationKey: "chatgpt:c:torture",
    documentInstanceId: "instance-1",
    boundDocumentId: "document-1",
    boundTabId: null,
    replacesRunId: null,
    keepAwake: false,
    workflow: {
      schemaVersion: 1,
      id: "torture",
      name: "Torture",
      maxSends: 3,
      steps: [{ id: "p1", type: "prompt", delivery: "send", prompt: "P1", repeat: 1, delayAfterMs: 0 }]
    },
    plannedSends: 1,
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 },
    status: "running",
    phase: "ready",
    pauseRequested: false,
    pauseRequestedAt: null,
    pauseRequestBaseRevision: null,
    pauseRequestRevision: null,
    pauseReason: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    resumable: true,
    outbox: null,
    waitState: null,
    stateRevision: 1,
    startedAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    ...overrides
  };
}

export async function installBackgroundHarness() {
  const listeners = { installed: [], startup: [], message: [], alarm: [], tabRemoved: [], tabUpdated: [] };
  const storageData = {};
  const sessionStorageData = { [SESSION_KEY]: DEFAULT_SESSION_ID };
  const alarms = new Map();
  const tabMessages = [];
  const scriptExecutions = [];
  const powerEvents = [];

  // Per-tab scriptable state.
  const documents = new Map(); // tabId -> { documentId, documentInstanceId }
  const identityPlans = new Map(); // tabId -> array of probe outcomes, consumed in order
  const identityProbeCounts = new Map();
  const statusResponders = new Map(); // tabId -> (payload) => response | throws
  const commandResponders = new Map(); // tabId -> (payload) => response | throws
  const probeResults = new Map(); // tabId -> content probe result

  let tabs = [];
  let siteAccessGranted = true;
  // Optional storage fault injectors. Each is called with the raw argument and may throw or
  // return a promise that never settles, which is how partial durable-write failures are
  // reproduced.
  let storageSetFault = null;
  let storageGetFault = null;

  const defaultProbe = {
    origin: "https://chatgpt.com",
    corePresent: true,
    controllerReady: true,
    version: EXTENSION_VERSION
  };

  function currentDocument(tabId) {
    return documents.get(tabId) ?? { documentId: `document-${tabId}`, documentInstanceId: `instance-${tabId}` };
  }

  function defaultStatus(tabId) {
    const doc = currentDocument(tabId);
    return {
      ok: true,
      provider: "chatgpt",
      contentVersion: EXTENSION_VERSION,
      pageReady: true,
      generationState: "idle",
      blocker: null,
      conversationKey: "chatgpt:c:torture",
      instanceId: doc.documentInstanceId,
      run: storageData[activeRunKey(tabId)] ?? null,
      diagnostics: []
    };
  }

  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: EXTENSION_VERSION }),
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      onMessage: { addListener: (fn) => listeners.message.push(fn) }
    },
    sidePanel: { async setPanelBehavior() {} },
    permissions: {
      async contains() { return siteAccessGranted; }
    },
    storage: {
      local: {
        // The real chrome.storage.local hands back structured clones. Returning live
        // references instead would silently make a *failed* durable write still mutate
        // storage, which is exactly the class of bug these suites hunt.
        async get(key) {
          if (storageGetFault) await storageGetFault(key);
          const read = (item) => (item in storageData ? structuredClone(storageData[item]) : undefined);
          if (typeof key === "string") return { [key]: read(key) };
          if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, read(item)]));
          return structuredClone(storageData);
        },
        async set(values) {
          if (storageSetFault) await storageSetFault(values);
          Object.assign(storageData, structuredClone(values));
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
        async set(values) { Object.assign(sessionStorageData, values); },
        async remove(key) {
          for (const item of Array.isArray(key) ? key : [key]) delete sessionStorageData[item];
        }
      }
    },
    alarms: {
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
      create(name, info) { alarms.set(name, { name, ...info }); },
      async clear(name) { return alarms.delete(name); },
      async get(name) { return alarms.get(name) ?? null; }
    },
    tabs: {
      onRemoved: { addListener: (fn) => listeners.tabRemoved.push(fn) },
      onUpdated: { addListener: (fn) => listeners.tabUpdated.push(fn) },
      async query() { return tabs; },
      async sendMessage(tabId, payload, options) {
        tabMessages.push({ tabId, payload, options });
        if (payload?.type === "AIPM_GET_STATUS") {
          const responder = statusResponders.get(tabId);
          if (responder) return responder(payload);
          return defaultStatus(tabId);
        }
        const responder = commandResponders.get(tabId);
        if (responder) return responder(payload);
        return { ok: true };
      }
    },
    scripting: {
      async executeScript(details) {
        scriptExecutions.push(details);
        const tabId = details.target?.tabId;
        if (details.files) return [{ result: null }];
        const isIdentityProbe = String(details.func).includes("__AIPM_DOCUMENT_INSTANCE_ID__");
        if (!isIdentityProbe) {
          return [{ result: probeResults.get(tabId) ?? defaultProbe, frameId: 0, documentId: currentDocument(tabId).documentId }];
        }
        identityProbeCounts.set(tabId, (identityProbeCounts.get(tabId) ?? 0) + 1);
        const plan = identityPlans.get(tabId);
        let outcome = null;
        if (Array.isArray(plan) && plan.length > 0) outcome = plan.shift();
        if (typeof outcome === "function") outcome = await outcome();
        if (outcome?.never === true) return new Promise(() => {});
        if (outcome?.error) throw outcome.error;
        if (outcome?.empty === true) return [];
        if (outcome && Object.hasOwn(outcome, "rawResults")) return outcome.rawResults;
        const doc = currentDocument(tabId);
        return [{
          result: outcome ? (outcome.documentInstanceId ?? null) : doc.documentInstanceId,
          frameId: outcome && Object.hasOwn(outcome, "frameId") ? outcome.frameId : 0,
          documentId: outcome ? (outcome.documentId ?? null) : doc.documentId
        }];
      }
    },
    power: {
      requestKeepAwake: (level) => powerEvents.push(`request:${level}`),
      releaseKeepAwake: () => powerEvents.push("release")
    }
  };

  await import(`../../src/background.js?torture=${Date.now()}-${Math.random()}`);

  function invoke(message, sender = {}) {
    return new Promise((resolve, reject) => {
      let handled = false;
      for (const listener of listeners.message) {
        if (listener(message, sender, resolve) === true) handled = true;
      }
      if (!handled) reject(new Error("message was not handled"));
    });
  }

  return {
    listeners,
    storageData,
    sessionStorageData,
    alarms,
    tabMessages,
    scriptExecutions,
    powerEvents,
    invoke,
    relay: (payload, targetTabId) => invoke({ type: "AIPM_RELAY_TO_CHATGPT", payload, targetTabId }),
    sessionId: () => sessionStorageData[SESSION_KEY],
    setTabs: (next) => { tabs = next; },
    setSiteAccess: (granted) => { siteAccessGranted = granted; },
    setDocument: (tabId, doc) => { documents.set(tabId, doc); },
    // Each entry is consumed by one probe attempt. Supported shapes:
    //   { documentInstanceId, documentId, frameId }  explicit observation
    //   { error: new Error(...) }                    executeScript rejection
    //   { never: true }                              a probe that never settles
    //   { empty: true }                              no frames returned
    //   { rawResults: [...] }                        arbitrary raw result array
    setIdentityPlan: (tabId, plan) => { identityPlans.set(tabId, [...plan]); },
    identityProbeCount: (tabId) => identityProbeCounts.get(tabId) ?? 0,
    setStatusResponder: (tabId, responder) => { statusResponders.set(tabId, responder); },
    setCommandResponder: (tabId, responder) => { commandResponders.set(tabId, responder); },
    setContentProbe: (tabId, result) => { probeResults.set(tabId, result); },
    setStorageSetFault: (fault) => { storageSetFault = fault; },
    setStorageGetFault: (fault) => { storageGetFault = fault; },
    defaultStatus,
    storedRun: (tabId) => storageData[activeRunKey(tabId)] ?? null,
    putRun: (tabId, run) => { storageData[activeRunKey(tabId)] = run; },
    quarantined: () => storageData["aipm.quarantinedRuns.v1"] ?? [],
    schedules: () => storageData["aipm.schedules.v1"] ?? {},
    signals: () => storageData["aipm.alarmSignals.v1"] ?? {},
    commandsDelivered: (tabId) => tabMessages.filter(
      (entry) => entry.tabId === tabId && entry.payload?.type !== "AIPM_GET_STATUS"
    ),
    triggerStartup: async () => {
      for (const listener of listeners.startup) await listener();
    },
    triggerTabRemoved: async (tabId) => {
      for (const listener of listeners.tabRemoved) await listener(tabId);
      await flushAsync();
    },
    triggerTabLoading: async (tabId) => {
      for (const listener of listeners.tabUpdated) await listener(tabId, { status: "loading" });
      await flushAsync();
    }
  };
}

export const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
