import { createReadOnlyBackpressure } from "./read-only-backpressure.js";
import { recoveryRuntimeBounds } from "./recovery-policy.js";
import { preflightWorkflowStartSchedule } from "./workflow.js";
import { normalizeTargetTitle } from "./target-display.js";

const ALARM_PREFIX = "aipm.wait.";
const SCHEDULES_KEY = "aipm.schedules.v1";
const SIGNALS_KEY = "aipm.alarmSignals.v1";
const ACTIVE_RUN_KEY_PREFIX = "aipm.activeRun.v2.tab.";
const LEGACY_ACTIVE_RUN_KEY = "aipm.activeRun.v1";
const LEASES_KEY = "aipm.leases.v1";
const LEASE_KEY_PREFIX = "aipm.lease.v2.";
const UI_STATE_MAP_KEY = "aipm.uiByTab.v2";
const SELECTED_TAB_KEY = "aipm.selectedTab.v1";
const EXECUTION_SESSION_KEY = "aipm.executionSession.v1";
const QUARANTINED_RUNS_KEY = "aipm.quarantinedRuns.v1";
const RECEIVER_RETRY_ATTEMPTS = 8;
const RECEIVER_RETRY_DELAY_MS = 100;
const STATUS_ATTEMPT_TIMEOUT_MS = 500;
const DOCUMENT_IDENTITY_ATTEMPTS = 3;
const DOCUMENT_IDENTITY_RETRY_DELAY_MS = 100;
const DOCUMENT_IDENTITY_GATE_LIFETIME_MS = 1_500;
const DOCUMENT_IDENTITY_RECOVERY_WAIT_SLICE_MS = 50;
const API_TIMEOUT_MS = 1_500;
const RECEIVER_RETRY_TIMEOUT_MS = 1_500;
const RUN_OBSERVATION_TIMEOUT_MS = 2_000;
const RUN_AUTHORITY_OBSERVATION_LIFETIME_MS = 12_000;
const LEASE_TTL_MS = 15_000;
const CHATGPT_ORIGIN = "https://chatgpt.com";
const CHATGPT_HOST_PERMISSION = "https://chatgpt.com/*";
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const contentInjectionByTab = new Map();
const uncertainInjectionTabs = new Set();
const runStateByTab = new Map();
// Periodic observations may consume only one uncancellable slot. The second and final
// slot is reserved for a fresh user mutation preflight; exact Stop does not use either.
const statusContactByTab = createReadOnlyBackpressure({ maxObservationOutstandingPerKey: 1 });
const contentProbeByTab = createReadOnlyBackpressure({ maxObservationOutstandingPerKey: 1 });
// One periodic orphan plus one fresh-authority orphan is the hard per-tab ceiling. A
// timeout never cancels executeScript, so the recovery episode waits for admission instead
// of spawning another underlying probe immediately.
const documentIdentityByTab = createReadOnlyBackpressure({
  maxOutstandingPerKey: 2,
  maxObservationOutstandingPerKey: 1,
  maxUnderlyingLifetimeMs: DOCUMENT_IDENTITY_GATE_LIFETIME_MS
});
const runObservationByTab = createReadOnlyBackpressure({ maxOutstandingPerKey: 1 });
const runAuthorityObservationByTab = createReadOnlyBackpressure({
  maxOutstandingPerKey: 2,
  maxUnderlyingLifetimeMs: RUN_AUTHORITY_OBSERVATION_LIFETIME_MS
});
const stopIntentByTab = new Map();
const documentAuthorityEpochByTab = new Map();
const identityRecoveryEpisodesByTab = new Map();
// A fresh content-originated authority boundary may establish one browser-attested
// top-document grant for the current document lifetime. Normal Run/Lease messages then
// compare their MessageSender identity locally instead of re-entering the renderer.
// This map is deliberately process-local: a Service Worker restart must re-prove once.
const documentAuthorityGrantByTab = new Map();
const DOCUMENT_IDENTITY_WORKER_TOKEN = Symbol("document-identity-worker");

function registerIdentityRecoveryEpisode(tabId, expectedRunId = null) {
  let resolveCancellation;
  const episode = {
    tabId,
    expectedRunId: typeof expectedRunId === "string" && expectedRunId ? expectedRunId : null,
    cancelled: false,
    reason: null,
    cancellationPromise: new Promise((resolve) => { resolveCancellation = resolve; }),
    cancel(reason) {
      if (episode.cancelled) return;
      episode.cancelled = true;
      episode.reason = reason;
      resolveCancellation(reason);
    },
    dispose() {
      const episodes = identityRecoveryEpisodesByTab.get(tabId);
      episodes?.delete(episode);
      if (episodes?.size === 0) identityRecoveryEpisodesByTab.delete(tabId);
    }
  };
  let episodes = identityRecoveryEpisodesByTab.get(tabId);
  if (!episodes) {
    episodes = new Set();
    identityRecoveryEpisodesByTab.set(tabId, episodes);
  }
  episodes.add(episode);
  return episode;
}

function cancelIdentityRecoveryEpisodes(tabId, reason, expectedRunId = null) {
  const episodes = identityRecoveryEpisodesByTab.get(tabId);
  if (!episodes) return;
  for (const episode of episodes) {
    if (expectedRunId != null && episode.expectedRunId !== expectedRunId) continue;
    episode.cancel(reason);
  }
}

function cancelAllIdentityRecoveryEpisodes(reason) {
  for (const tabId of identityRecoveryEpisodesByTab.keys()) {
    cancelIdentityRecoveryEpisodes(tabId, reason);
  }
}

function documentAuthorityEpoch(tabId) {
  return documentAuthorityEpochByTab.get(tabId) ?? 0;
}

function invalidateDocumentAuthority(tabId, { forgetOuterContacts = false } = {}) {
  cancelIdentityRecoveryEpisodes(tabId, "document-lifecycle-changed");
  documentAuthorityEpochByTab.set(tabId, documentAuthorityEpoch(tabId) + 1);
  documentAuthorityGrantByTab.delete(tabId);
  /* A retained availability hint must not outlive the document it described. */
  confirmedStatusByTab.delete(tabId);
  statusContactByTab.forget(tabId);
  contentProbeByTab.forget(tabId);
  documentIdentityByTab.forget(tabId);
  if (forgetOuterContacts) {
    runObservationByTab.forget(tabId);
    runAuthorityObservationByTab.forget(tabId);
  }
}

function stopIntentMatches(tabId, runId) {
  return typeof runId === "string" && stopIntentByTab.get(tabId)?.runId === runId;
}
let executionSessionPromise = null;
let executionSessionGeneration = 0;
let lifecycleBarrier = Promise.resolve();
let lifecycleRecoveryPromise = null;
let scheduleMutationQueue = Promise.resolve();
let leaseMutationQueue = Promise.resolve();
let powerReconcileQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(async () => {
  const sessionBoundary = beginNewExecutionSession("extension-reload");
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await sessionBoundary;
  await restoreAlarms();
  await schedulePowerReconcile();
});

chrome.runtime.onStartup.addListener(async () => {
  await beginNewExecutionSession("browser-restart");
  await restoreAlarms();
  await schedulePowerReconcile();
});

chrome.tabs.onRemoved?.addListener((tabId) => {
  invalidateDocumentAuthority(tabId, { forgetOuterContacts: true });
  stopIntentByTab.delete(tabId);
  handleRemovedTab(tabId).catch(() => {});
});

chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
  if (changeInfo?.status === "loading") {
    uncertainInjectionTabs.delete(tabId);
    invalidateDocumentAuthority(tabId);
  }
});

function alarmName(runId, stepId) {
  return `${ALARM_PREFIX}${encodeURIComponent(runId)}.${encodeURIComponent(stepId)}`;
}

function activeRunKey(tabId) {
  return `${ACTIVE_RUN_KEY_PREFIX}${tabId}`;
}

function makeOperationError(code, phase, tabId = null) {
  const error = new Error(code);
  error.code = code;
  error.phase = phase;
  error.tabId = Number.isInteger(tabId) ? tabId : null;
  return error;
}

async function withTimeout(factory, timeoutMs, details) {
  let timeoutId;
  try {
    return await Promise.race([
      Promise.resolve().then(factory),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(makeOperationError(details.code, details.phase, details.tabId)),
          timeoutMs
        );
      })
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function operationFailure(error, fallback) {
  return {
    code: typeof error?.code === "string" ? error.code : fallback.code,
    phase: typeof error?.phase === "string" ? error.phase : fallback.phase,
    tabId: Number.isInteger(error?.tabId) ? error.tabId : (Number.isInteger(fallback.tabId) ? fallback.tabId : null)
  };
}

function messageFailureResponse(error) {
  if (typeof error?.code !== "string" || !error.code) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const safeMessages = {
    READ_ONLY_CONTACT_BUSY: "前回の読み取り確認がまだ完了していません。負荷を増やさないため今回の確認を停止しました。",
    READ_ONLY_BACKOFF: "読み取り確認は一時的な待機中です。少し待ってから状態を更新してください。",
    READ_ONLY_CONTACT_EXPIRED: "読み取り確認が時間内に完了しませんでした。安全のため今回の確認を停止しました。",
    RUN_OBSERVATION_TIMEOUT: "Run状態の読み取り確認が時間切れになりました。安全のため実行を進めていません。"
  };
  const response = {
    ok: false,
    errorCode: error.code,
    errorPhase: typeof error.phase === "string" && error.phase ? error.phase : "read-only-observation",
    error: safeMessages[error.code] ?? "安全確認を完了できなかったため、操作を進めませんでした。"
  };
  if (Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0) {
    response.retryAfterMs = Math.ceil(error.retryAfterMs);
  }
  return response;
}

async function getExecutionSessionId() {
  if (executionSessionPromise) return executionSessionPromise;
  const attempt = (async () => {
    const stored = await chrome.storage.session.get(EXECUTION_SESSION_KEY);
    const existing = stored[EXECUTION_SESSION_KEY];
    if (typeof existing === "string" && existing) return existing;
    const created = crypto.randomUUID();
    await chrome.storage.session.set({ [EXECUTION_SESSION_KEY]: created });
    return created;
  })();
  executionSessionPromise = attempt;
  try {
    return await attempt;
  } catch (error) {
    if (executionSessionPromise === attempt) executionSessionPromise = null;
    throw error;
  }
}

function serializeRunState(tabId, operation) {
  const previous = runStateByTab.get(tabId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  runStateByTab.set(tabId, current);
  return current.finally(() => {
    if (runStateByTab.get(tabId) === current) runStateByTab.delete(tabId);
  });
}

function serializeScheduleMutation(operation) {
  const current = scheduleMutationQueue.catch(() => {}).then(operation);
  scheduleMutationQueue = current;
  return current;
}

function serializeLeaseMutation(operation) {
  const current = leaseMutationQueue.catch(() => {}).then(operation);
  leaseMutationQueue = current;
  return current;
}

function leaseStorageKey(conversationKey) {
  return `${LEASE_KEY_PREFIX}${encodeURIComponent(conversationKey)}`;
}

function schedulePowerReconcile() {
  const current = powerReconcileQueue.catch(() => {}).then(reconcilePowerState);
  powerReconcileQueue = current;
  return current;
}

async function reconcilePowerAfterMutation() {
  try {
    await schedulePowerReconcile();
    return null;
  } catch (error) {
    return operationFailure(error, { code: "POWER_RECONCILE_FAILED", phase: "power-reconcile" });
  }
}

async function validateSessionBoundMessage(message) {
  const executionSessionId = await getExecutionSessionId();
  if (message?.serviceWorkerVersion !== EXTENSION_VERSION) {
    return { ok: false, error: "Content ScriptとService Workerのversionが一致しません。" };
  }
  if (message?.executionSessionId !== executionSessionId) {
    return { ok: false, error: "要求は現在のブラウザセッションに紐づいていません。" };
  }
  return null;
}

function leaseOwnerMatches(current, request, sender, executionSessionId) {
  const senderTabId = sender?.tab?.id;
  const sameDocument = typeof sender?.documentId === "string"
    ? current?.documentId === sender.documentId
    : current?.documentInstanceId === request.documentInstanceId;
  return current?.runId === request.runId &&
    current?.nonce === request.nonce &&
    current?.tabId === senderTabId &&
    current?.executionSessionId === executionSessionId &&
    sameDocument;
}

async function getLeaseOwnerRun(current) {
  if (!Number.isInteger(current?.tabId) || typeof current?.runId !== "string") return null;
  const key = activeRunKey(current.tabId);
  const stored = await chrome.storage.local.get(key);
  return stored[key] && typeof stored[key] === "object" ? stored[key] : null;
}

function bindingMatchesSender(binding, request, sender) {
  if (typeof sender?.documentId === "string" && typeof binding?.boundDocumentId === "string") {
    return binding.boundDocumentId === sender.documentId;
  }
  return typeof request?.documentInstanceId === "string" &&
    binding?.documentInstanceId === request.documentInstanceId;
}

function leaseDocumentMatchesSender(lease, request, sender) {
  if (typeof sender?.documentId === "string" && typeof lease?.documentId === "string") {
    return lease.documentId === sender.documentId;
  }
  return typeof request?.documentInstanceId === "string" &&
    lease?.documentInstanceId === request.documentInstanceId;
}

async function mutateConversationLease(message, sender) {
  const invalid = await validateSessionBoundMessage(message);
  if (invalid) return invalid;
  const requestExecutionGeneration = executionSessionGeneration;
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId) || typeof message?.runId !== "string" || !message.runId ||
      typeof message?.conversationKey !== "string" || !message.conversationKey.startsWith("chatgpt:")) {
    return { ok: false, error: "Lease要求の対象が不正です。" };
  }
  let identity = await reconfirmContentDocument(
    tabId,
    sender?.documentId ?? null,
    message.documentInstanceId ?? null,
    identityRecoveryOptions(
      message.readOnlyRecovery,
      message.type === "AIPM_LEASE_ACQUIRE"
        ? "lease-acquire"
        : (message.type === "AIPM_LEASE_RENEW" ? "lease-renew" : "lease-release"),
      false,
      message.runId
    ),
    sender
  );
  if (identity.status !== "match") {
    return withIdentityObservation({
      ok: false,
      errorCode: identity.status === "mismatch"
        ? "DOCUMENT_IDENTITY_MISMATCH"
        : "DOCUMENT_IDENTITY_UNCONFIRMED",
      error: identity.status === "mismatch"
        ? "現在のdocumentとLease要求元が一致しないため操作を拒否しました。"
        : "現在のdocumentを再確認できないためLease操作を拒否しました。"
    }, identity);
  }

  const refuseInvalidatedLeaseAuthority = () => {
    const reason = contentAuthorityInvalidReason(tabId, identity);
    if (!reason) return null;
    identity = invalidateMatchedContentIdentity(identity, reason);
    return {
      ok: false,
      errorCode: "DOCUMENT_IDENTITY_UNCONFIRMED",
      error: "document authorityが失効したためLease操作を拒否しました。"
    };
  };

  const executionSessionId = await getExecutionSessionId();
  if (executionSessionGeneration !== requestExecutionGeneration || message.executionSessionId !== executionSessionId) {
    return withIdentityObservation({
      ok: false,
      errorCode: "RUN_STATE_CONFLICT",
      error: "Service Worker sessionが変わったため古いLease操作を拒否しました。"
    }, identity);
  }
  const result = await serializeLeaseMutation(async () => {
    const invalidatedAtEntry = refuseInvalidatedLeaseAuthority();
    if (invalidatedAtEntry) return invalidatedAtEntry;
    if (executionSessionGeneration !== requestExecutionGeneration ||
        await getExecutionSessionId() !== executionSessionId) {
      return { ok: false, errorCode: "RUN_STATE_CONFLICT", error: "古いLease操作を拒否しました。" };
    }
    if (stopIntentMatches(tabId, message.runId) && message.type !== "AIPM_LEASE_RELEASE") {
      return { ok: true, lease: null, renewed: false, stopPending: true };
    }
    if (message.type !== "AIPM_LEASE_RELEASE") {
      const runKey = activeRunKey(tabId);
      const runStored = await chrome.storage.local.get(runKey);
      const ownerRun = runStored[runKey] ?? null;
      if (ownerRun && (ownerRun.runId !== message.runId || ownerRun.status === "stopped" ||
          ownerRun.status === "completed" || ownerRun.executionSessionId !== executionSessionId)) {
        return { ok: true, lease: null, renewed: false, staleRun: true };
      }
    }
    const key = leaseStorageKey(message.conversationKey);
    const stored = await chrome.storage.local.get(key);
    const current = stored[key] && typeof stored[key] === "object" ? stored[key] : null;
    const now = Date.now();

    if (message.type === "AIPM_LEASE_ACQUIRE") {
      const ownerRun = current ? await getLeaseOwnerRun(current) : null;
      const ownerStillRunning = ownerRun?.runId === current?.runId &&
        ownerRun?.executionSessionId === executionSessionId &&
        ownerRun?.status === "running";
      const exactOwnerRecovery = ownerStillRunning &&
        current?.runId === message.runId &&
        current?.tabId === tabId &&
        current?.executionSessionId === executionSessionId &&
        typeof current?.nonce === "string" && current.nonce &&
        bindingMatchesSender(ownerRun, message, sender) &&
        leaseDocumentMatchesSender(current, message, sender);
      if (exactOwnerRecovery) {
        const invalidatedBeforeRecovery = refuseInvalidatedLeaseAuthority();
        if (invalidatedBeforeRecovery) return invalidatedBeforeRecovery;
        await chrome.storage.local.set({ [key]: { ...current, expiresAt: now + LEASE_TTL_MS } });
        return {
          ok: true,
          lease: { conversationKey: message.conversationKey, nonce: current.nonce, executionSessionId },
          recoveredExistingOwner: true
        };
      }
      const reloadRebind = ownerStillRunning &&
        current?.runId === message.runId &&
        current?.tabId === tabId &&
        current?.executionSessionId === executionSessionId &&
        bindingMatchesSender(ownerRun, message, sender) &&
        !leaseDocumentMatchesSender(current, message, sender);
      if (current && Number(current.expiresAt ?? 0) > now && !reloadRebind) {
        return { ok: true, lease: null };
      }
      if (current && ownerStillRunning && !reloadRebind) {
        return { ok: true, lease: null, blockedByRunningOwner: true };
      }
      const nonce = crypto.randomUUID();
      const next = {
        runId: message.runId,
        nonce,
        tabId,
        documentId: typeof sender?.documentId === "string" ? sender.documentId : null,
        documentInstanceId: message.documentInstanceId ?? null,
        executionSessionId,
        expiresAt: now + LEASE_TTL_MS
      };
      const invalidatedBeforeAcquire = refuseInvalidatedLeaseAuthority();
      if (invalidatedBeforeAcquire) return invalidatedBeforeAcquire;
      await chrome.storage.local.set({ [key]: next });
      return {
        ok: true,
        lease: { conversationKey: message.conversationKey, nonce, executionSessionId },
        reboundAfterReload: reloadRebind
      };
    }

    if (typeof message?.nonce !== "string" || !leaseOwnerMatches(current, message, sender, executionSessionId)) {
      return { ok: true, renewed: false, released: false };
    }
    if (message.type === "AIPM_LEASE_RENEW") {
      if (Number(current.expiresAt ?? 0) <= now) {
        const ownerRun = await getLeaseOwnerRun(current);
        const liveOwner = ownerRun?.runId === current.runId &&
          ownerRun?.executionSessionId === executionSessionId &&
          ownerRun?.status === "running";
        if (!liveOwner) return { ok: true, renewed: false };
      }
      const invalidatedBeforeRenew = refuseInvalidatedLeaseAuthority();
      if (invalidatedBeforeRenew) return invalidatedBeforeRenew;
      await chrome.storage.local.set({ [key]: { ...current, expiresAt: now + LEASE_TTL_MS } });
      return { ok: true, renewed: true };
    }
    if (message.type === "AIPM_LEASE_RELEASE") {
      const invalidatedBeforeRelease = refuseInvalidatedLeaseAuthority();
      if (invalidatedBeforeRelease) return invalidatedBeforeRelease;
      await chrome.storage.local.remove(key);
      return { ok: true, released: true };
    }
    return { ok: false, error: "Unknown lease operation." };
  });
  return withIdentityObservation(result, identity);
}

async function appendQuarantinedRun(sourceKey, run, reason) {
  const stored = await chrome.storage.local.get(QUARANTINED_RUNS_KEY);
  const existing = Array.isArray(stored[QUARANTINED_RUNS_KEY]) ? stored[QUARANTINED_RUNS_KEY] : [];
  const quarantined = {
    ...run,
    status: "paused",
    resumable: false,
    pauseReason: reason,
    lastErrorCode: reason,
    lastErrorMessage: "以前のブラウザセッションまたは別の会話に紐づくRunを安全のため隔離しました。",
    quarantinedAt: new Date().toISOString(),
    quarantinedFrom: sourceKey
  };
  await chrome.storage.local.set({
    [QUARANTINED_RUNS_KEY]: [...existing, quarantined].slice(-20)
  });
  return quarantined;
}

async function quarantineRunKey(key, run, reason) {
  if (run && typeof run === "object") await appendQuarantinedRun(key, run, reason);
  await chrome.storage.local.remove(key);
}

async function failClosedRunForTab(tabId, message) {
  if (message?.serviceWorkerVersion !== EXTENSION_VERSION) {
    return { ok: false, error: "Content ScriptとService Workerのversionが一致しません。" };
  }
  return serializeRunState(tabId, async () => {
    const key = activeRunKey(tabId);
    const stored = await chrome.storage.local.get(key);
    const run = stored[key];
    if (!run || typeof run !== "object") return { ok: true, run: null, changed: false };
    if (typeof message?.expectedRunId === "string" && message.expectedRunId && run.runId !== message.expectedRunId) {
      return { ok: true, run: null, changed: false, staleRun: true };
    }
    if (Object.prototype.hasOwnProperty.call(message ?? {}, "expectedStateRevision") &&
        stateRevisionToken(run.stateRevision) !== stateRevisionToken(message.expectedStateRevision)) {
      return { ok: true, run: null, changed: false, staleRun: true, staleRevision: true };
    }
    if (typeof message?.expectedExecutionSessionId === "string" && message.expectedExecutionSessionId &&
        run.executionSessionId !== message.expectedExecutionSessionId) {
      return { ok: true, run: null, changed: false, staleRun: true, staleExecutionSession: true };
    }
    if (typeof message?.expectedConversationKey === "string" && message.expectedConversationKey &&
        run.conversationKey !== message.expectedConversationKey) {
      return { ok: true, run: null, changed: false, staleRun: true, staleConversation: true };
    }
    if (Object.prototype.hasOwnProperty.call(message ?? {}, "expectedBoundDocumentId") &&
        run.boundDocumentId !== message.expectedBoundDocumentId) {
      return { ok: true, run: null, changed: false, staleRun: true, staleDocumentBinding: true };
    }
    if (Object.prototype.hasOwnProperty.call(message ?? {}, "expectedDocumentInstanceId") &&
        run.documentInstanceId !== message.expectedDocumentInstanceId) {
      return { ok: true, run: null, changed: false, staleRun: true, staleDocumentInstance: true };
    }
    if (run.status === "stopped" || run.status === "completed") {
      return { ok: true, run: { ...run }, changed: false, terminalRun: true };
    }
    const identityReason = message?.reason === "document_identity_unconfirmed"
      ? "document_identity_unconfirmed"
      : (message?.reason === "document_identity_mismatch"
          ? "document_identity_mismatch"
          : "conversation-identity-unknown");
    const identityMessage = identityReason === "document_identity_unconfirmed"
      ? "現在のdocument identityを再確認できないためRunを安全停止しました。Stop後に新しく開始してください。"
      : (identityReason === "document_identity_mismatch"
          ? "現在のdocumentがRunのdocumentと一致しないためRunを安全停止しました。Stop後に新しく開始してください。"
          : "conversation identityを確認できないためRunを安全停止しました。Stop後に新しく開始してください。");
    const paused = {
      ...run,
      status: "paused",
      phase: "ambiguous",
      resumable: false,
      pauseReason: identityReason,
      lastErrorCode: identityReason,
      lastErrorMessage: identityMessage,
      updatedAt: new Date().toISOString(),
      stateRevision: nextStateRevision(run)
    };
    await chrome.storage.local.set({ [key]: paused });
    const powerWarning = await reconcilePowerAfterMutation();
    return { ok: true, run: paused, changed: true, powerWarning };
  });
}

async function durablyStopRunForTab(tabId, expectedRunId) {
  const stopToken = Symbol("durable-stop");
  stopIntentByTab.set(tabId, { runId: expectedRunId, token: stopToken });
  cancelIdentityRecoveryEpisodes(tabId, "stop-requested", expectedRunId);
  try {
    const executionSessionId = await getExecutionSessionId();
    return await serializeRunState(tabId, async () => {
      const key = activeRunKey(tabId);
      const stored = await chrome.storage.local.get(key);
      const run = stored[key];
      if (!run || run.runId !== expectedRunId || run.boundTabId !== tabId ||
          run.executionSessionId !== executionSessionId) {
        return { ok: false, errorCode: "STALE_CONTROL_INTENT", error: "停止対象のRunがすでに変わりました。" };
      }
      if (run.status === "completed") {
        return { ok: false, errorCode: "STALE_CONTROL_INTENT", error: "完了済みRunへ古い停止操作は適用しません。" };
      }
      if (run.status === "stopped") return { ok: true, run: { ...run }, stopCommitted: true };

      const stopped = {
        ...run,
        status: "stopped",
        phase: "stopped",
        pauseReason: "user-stop",
        waitState: null,
        updatedAt: new Date().toISOString(),
        stateRevision: nextStateRevision(run)
      };
      await chrome.storage.local.set({ [key]: stopped });

      let scheduleCleanupFailed = false;
      try {
        await serializeScheduleMutation(() => clearTabSchedules(tabId));
      } catch {
        // The terminal Run state is the execution authority. Schedule cleanup is best-effort
        // after that monotonic revoke and can never make recovery executable again.
        scheduleCleanupFailed = true;
      }
      const powerWarning = await reconcilePowerAfterMutation();
      return { ok: true, run: stopped, stopCommitted: true, scheduleCleanupFailed, powerWarning };
    });
  } finally {
    if (stopIntentByTab.get(tabId)?.token === stopToken) stopIntentByTab.delete(tabId);
  }
}

async function requireNewChatConfirmationForTab(tabId, message) {
  const invalid = await validateSessionBoundMessage(message);
  if (invalid) return invalid;
  if (typeof message?.expectedRunId !== "string" || !message.expectedRunId) {
    return { ok: false, error: "New Chat confirmation requires an exact Run id." };
  }
  return serializeRunState(tabId, async () => {
    const key = activeRunKey(tabId);
    const stored = await chrome.storage.local.get(key);
    const run = stored[key];
    if (!run || run.runId !== message.expectedRunId) {
      return { ok: false, error: "New Chat confirmation対象のRunが一致しません。" };
    }
    const safeCheckpoint = run.status === "running" &&
      String(run.conversationKey).startsWith("chatgpt:new:") &&
      run.phase === "submitting" &&
      run.outbox?.state === "prepared";
    if (!safeCheckpoint) {
      return { ok: false, error: "New Chat送信状態を安全に確認できません。" };
    }
    const paused = {
      ...run,
      status: "paused",
      phase: "new-chat-confirmation-required",
      resumable: false,
      pauseReason: "new-chat-confirmation-required",
      lastErrorCode: "new-chat-confirmation-required",
      lastErrorMessage: "New Chatの最初の送信後は自動継続しません。対象conversationを確認してResumeしてください。",
      outbox: {
        ...run.outbox,
        state: "submitted",
        submittedAt: new Date().toISOString()
      },
      updatedAt: new Date().toISOString(),
      stateRevision: nextStateRevision(run)
    };
    await chrome.storage.local.set({ [key]: paused });
    const powerWarning = await reconcilePowerAfterMutation();
    return { ok: true, run: paused, powerWarning };
  });
}

function isNewChatConfirmationPending(run, currentConversationKey) {
  return run?.status === "paused" &&
    run?.pauseReason === "new-chat-confirmation-required" &&
    String(run?.conversationKey).startsWith("chatgpt:new:") &&
    String(currentConversationKey).startsWith("chatgpt:c:");
}

async function confirmNewChatTargetForTab(tabId, message, sender) {
  const invalid = await validateSessionBoundMessage(message);
  if (invalid) return invalid;
  const targetKey = message?.conversationKey;
  if (typeof targetKey !== "string" || !targetKey.startsWith("chatgpt:c:")) {
    return { ok: false, error: "Resume先のcanonical conversationを確認できません。" };
  }
  if (typeof message?.expectedRunId !== "string" || !message.expectedRunId) {
    return { ok: false, error: "Resumeにはexact Run idが必要です。" };
  }
  const requestExecutionGeneration = executionSessionGeneration;
  let identity = await reconfirmContentDocument(
    tabId,
    sender?.documentId ?? null,
    message.documentInstanceId ?? null,
    identityRecoveryOptions(message.readOnlyRecovery, "control", false, message.expectedRunId),
    sender
  );
  if (identity.status !== "match") {
    return withIdentityObservation({
      ok: false,
      errorCode: identity.status === "mismatch"
        ? "DOCUMENT_IDENTITY_MISMATCH"
        : "DOCUMENT_IDENTITY_UNCONFIRMED",
      error: "現在のdocumentを確認できないためResume先の採用を拒否しました。"
    }, identity);
  }
  if (executionSessionGeneration !== requestExecutionGeneration) {
    return withIdentityObservation({
      ok: false,
      errorCode: "RUN_STATE_CONFLICT",
      error: "Service Worker sessionが変わったため古いResume先採用を拒否しました。"
    }, identity);
  }
  return serializeRunState(tabId, async () => {
    if (executionSessionGeneration !== requestExecutionGeneration) {
      return { ok: false, errorCode: "RUN_STATE_CONFLICT", error: "古いResume先採用を拒否しました。" };
    }
    const key = activeRunKey(tabId);
    const stored = await chrome.storage.local.get(key);
    const run = stored[key];
    if (!run || run.runId !== message.expectedRunId || !isNewChatConfirmationPending(run, targetKey)) {
      return { ok: false, error: "confirmation-required Runが一致しません。" };
    }
    const adopted = {
      ...run,
      conversationKey: targetKey,
      documentInstanceId: message.documentInstanceId ?? run.documentInstanceId,
      boundDocumentId: typeof sender?.documentId === "string" ? sender.documentId : run.boundDocumentId,
      boundTabId: tabId,
      updatedAt: new Date().toISOString(),
      stateRevision: nextStateRevision(run)
    };
    const invalidReason = contentAuthorityInvalidReason(tabId, identity);
    if (invalidReason) {
      identity = invalidateMatchedContentIdentity(identity, invalidReason);
      return withIdentityObservation({
        ok: false,
        errorCode: "DOCUMENT_IDENTITY_UNCONFIRMED",
        error: "document authorityが失効したためResume先の採用を拒否しました。"
      }, identity);
    }
    await chrome.storage.local.set({ [key]: adopted });
    return { ok: true, run: adopted };
  });
}

async function clearTabSchedules(tabId) {
  const schedules = await readMap(SCHEDULES_KEY);
  const signals = await readMap(SIGNALS_KEY);
  let changed = false;
  for (const [name, schedule] of Object.entries(schedules)) {
    if (schedule?.tabId !== tabId) continue;
    await chrome.alarms.clear(name);
    delete schedules[name];
    delete signals[name];
    changed = true;
  }
  if (changed) await chrome.storage.local.set({ [SCHEDULES_KEY]: schedules, [SIGNALS_KEY]: signals });
}

async function quarantineStaleSessionState(reason, currentSessionId) {
  const stored = await chrome.storage.local.get(null);
  const staleRunEntries = Object.entries(stored).filter(([key, run]) =>
    (key.startsWith(ACTIVE_RUN_KEY_PREFIX) || key === LEGACY_ACTIVE_RUN_KEY) && run && typeof run === "object"
  );
  for (const [key, run] of staleRunEntries) {
    if (run.executionSessionId !== currentSessionId) await appendQuarantinedRun(key, run, reason);
  }

  const staleRunKeys = staleRunEntries
    .filter(([, run]) => run.executionSessionId !== currentSessionId)
    .map(([key]) => key);
  const staleLeaseKeys = Object.keys(stored).filter((key) => key.startsWith(LEASE_KEY_PREFIX));
  await serializeScheduleMutation(async () => {
    const schedules = await readMap(SCHEDULES_KEY);
    for (const name of Object.keys(schedules)) await chrome.alarms.clear(name);
    await chrome.storage.local.set({ [SCHEDULES_KEY]: {}, [SIGNALS_KEY]: {} });
  });
  await chrome.storage.local.set({ [LEASES_KEY]: {} });
  await chrome.storage.local.remove([
    ...staleRunKeys,
    ...staleLeaseKeys,
    UI_STATE_MAP_KEY,
    SELECTED_TAB_KEY
  ]);
}

async function beginNewExecutionSession(reason) {
  // Invalidate every in-flight read-only authority episode synchronously. A late result
  // from the previous worker/session generation must never authorize the new generation.
  cancelAllIdentityRecoveryEpisodes("execution-session-changed");
  documentAuthorityGrantByTab.clear();
  executionSessionGeneration += 1;
  lifecycleBarrier = lifecycleBarrier.catch(() => {}).then(async () => {
    const nextSessionId = crypto.randomUUID();
    executionSessionPromise = Promise.resolve(nextSessionId);
    await chrome.storage.session.set({ [EXECUTION_SESSION_KEY]: nextSessionId });
    await quarantineStaleSessionState(reason, nextSessionId);
    chrome.power?.releaseKeepAwake();
    return nextSessionId;
  });
  return lifecycleBarrier;
}

async function ensureLifecycleReady() {
  try {
    await lifecycleBarrier;
  } catch {
    if (!lifecycleRecoveryPromise) {
      const recovery = beginNewExecutionSession("lifecycle-retry");
      const tracked = recovery.finally(() => {
        if (lifecycleRecoveryPromise === tracked) lifecycleRecoveryPromise = null;
      });
      lifecycleRecoveryPromise = tracked;
    }
    await lifecycleRecoveryPromise;
  }
}

async function handleRemovedTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  uncertainInjectionTabs.delete(tabId);
  contentInjectionByTab.delete(tabId);
  confirmedStatusByTab.delete(tabId);
  await serializeRunState(tabId, async () => {
    const key = activeRunKey(tabId);
    const stored = await chrome.storage.local.get(key);
    if (stored[key]) await quarantineRunKey(key, stored[key], "tab-closed");
  });
  await serializeScheduleMutation(() => clearTabSchedules(tabId));
  const uiState = await chrome.storage.local.get([UI_STATE_MAP_KEY, SELECTED_TAB_KEY]);
  const uiByTab = uiState[UI_STATE_MAP_KEY] && typeof uiState[UI_STATE_MAP_KEY] === "object"
    ? { ...uiState[UI_STATE_MAP_KEY] }
    : {};
  if (Object.hasOwn(uiByTab, String(tabId))) {
    delete uiByTab[String(tabId)];
    await chrome.storage.local.set({ [UI_STATE_MAP_KEY]: uiByTab });
  }
  if (Number(uiState[SELECTED_TAB_KEY]) === tabId) await chrome.storage.local.remove(SELECTED_TAB_KEY);
  await schedulePowerReconcile();
}

async function readMap(key) {
  const stored = await chrome.storage.local.get(key);
  return stored[key] && typeof stored[key] === "object" ? stored[key] : {};
}

async function restoreAlarms() {
  return serializeScheduleMutation(async () => {
    const executionSessionId = await getExecutionSessionId();
    const schedules = await readMap(SCHEDULES_KEY);
    for (const [name, schedule] of Object.entries(schedules)) {
      if (!name.startsWith(ALARM_PREFIX)) continue;
      if (schedule?.executionSessionId !== executionSessionId) {
        await chrome.alarms.clear(name);
        continue;
      }
      const existing = await chrome.alarms.get(name);
      if (!existing && Number.isFinite(Number(schedule.whenMs))) {
        chrome.alarms.create(name, { when: Math.max(Date.now() + 100, Number(schedule.whenMs)) });
      }
    }
  });
}

async function armSchedule({ runId, stepId, whenMs }, sender) {
  const when = Number(whenMs);
  if (!runId || !stepId || !Number.isFinite(when)) return { ok: false, error: "Invalid schedule." };
  const executionSessionId = await getExecutionSessionId();

  const name = alarmName(runId, stepId);
  const schedules = await readMap(SCHEDULES_KEY);
  const signals = await readMap(SIGNALS_KEY);
  delete signals[name];
  schedules[name] = {
    runId: String(runId),
    stepId: String(stepId),
    whenMs: when,
    tabId: sender?.tab?.id ?? null,
    executionSessionId,
    armedAt: Date.now()
  };
  await chrome.storage.local.set({ [SCHEDULES_KEY]: schedules, [SIGNALS_KEY]: signals });

  await chrome.alarms.clear(name);
  if (when <= Date.now()) {
    await fireSchedule(name, schedules[name]);
  } else {
    chrome.alarms.create(name, { when });
  }
  return { ok: true, name };
}

async function clearSchedule({ runId, stepId }) {
  const name = alarmName(runId, stepId);
  await chrome.alarms.clear(name);
  const schedules = await readMap(SCHEDULES_KEY);
  delete schedules[name];
  const signals = await readMap(SIGNALS_KEY);
  delete signals[name];
  await chrome.storage.local.set({ [SCHEDULES_KEY]: schedules, [SIGNALS_KEY]: signals });
  return { ok: true };
}

async function fireSchedule(name, schedule) {
  const executionSessionId = await getExecutionSessionId();
  if (schedule?.executionSessionId !== executionSessionId) {
    await chrome.alarms.clear(name);
    const schedules = await readMap(SCHEDULES_KEY);
    delete schedules[name];
    await chrome.storage.local.set({ [SCHEDULES_KEY]: schedules });
    return;
  }
  const firedAt = Date.now();
  const signals = await readMap(SIGNALS_KEY);
  signals[name] = {
    runId: schedule.runId,
    stepId: schedule.stepId,
    scheduledAt: Number(schedule.whenMs),
    firedAt,
    executionSessionId
  };

  const schedules = await readMap(SCHEDULES_KEY);
  delete schedules[name];
  await chrome.storage.local.set({ [SIGNALS_KEY]: signals, [SCHEDULES_KEY]: schedules });

  if (Number.isInteger(schedule.tabId)) {
    try {
      await withTimeout(
        () => chrome.tabs.sendMessage(schedule.tabId, {
          type: "AIPM_ALARM_FIRED",
          name,
          runId: schedule.runId,
          stepId: schedule.stepId,
          scheduledAt: Number(schedule.whenMs),
          firedAt,
          serviceWorkerVersion: EXTENSION_VERSION,
          executionSessionId
        }),
        API_TIMEOUT_MS,
        { code: "ALARM_DELIVERY_TIMEOUT", phase: "alarm-delivery", tabId: schedule.tabId }
      );
    } catch {
      // The signal remains persisted for reload/recovery; no automatic tab creation.
    }
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  await serializeScheduleMutation(async () => {
    const schedules = await readMap(SCHEDULES_KEY);
    const schedule = schedules[alarm.name];
    if (!schedule) return;
    await fireSchedule(alarm.name, schedule);
  });
});

function sameDocument(run, currentDocumentId, currentDocumentInstanceId) {
  if (typeof run?.boundDocumentId === "string" && typeof currentDocumentId === "string") {
    return run.boundDocumentId === currentDocumentId;
  }
  return typeof run?.documentInstanceId === "string" &&
    typeof currentDocumentInstanceId === "string" &&
    run.documentInstanceId === currentDocumentInstanceId;
}

function conversationCompatible(run, currentConversationKey, currentDocumentId, currentDocumentInstanceId) {
  if (!run || !currentConversationKey || run.conversationKey !== currentConversationKey) return false;
  if (!String(currentConversationKey).startsWith("chatgpt:new:")) return true;
  return sameDocument(run, currentDocumentId, currentDocumentInstanceId);
}

const DOCUMENT_IDENTITY_UNAVAILABLE_REASONS = new Set([
  "timeout",
  "execute-script-rejected",
  "backpressure",
  "top-frame-missing",
  "identity-fields-unavailable",
  "probe-result-invalid",
  "stale-result",
  "document-lifecycle-changed",
  "execution-session-changed",
  "unknown"
]);

const DOCUMENT_IDENTITY_FAILURE_CODES = Object.freeze({
  timeout: "IDENTITY_PROBE_TIMEOUT",
  "execute-script-rejected": "IDENTITY_PROBE_REJECTED",
  backpressure: "IDENTITY_BACKPRESSURE",
  "top-frame-missing": "IDENTITY_TOP_FRAME_MISSING",
  "identity-fields-unavailable": "IDENTITY_FIELDS_UNAVAILABLE",
  "probe-result-invalid": "IDENTITY_PROBE_INVALID",
  "stale-result": "IDENTITY_STALE_RESULT",
  "document-lifecycle-changed": "IDENTITY_LIFECYCLE_INVALIDATED",
  "execution-session-changed": "IDENTITY_EXECUTION_SESSION_CHANGED",
  unknown: "IDENTITY_UNKNOWN"
});

const DOCUMENT_IDENTITY_BOUNDARIES = new Set([
  "periodic-observation",
  "readiness",
  "run-read",
  "run-save",
  "lease-acquire",
  "lease-renew",
  "lease-release",
  "control",
  "send-preflight",
  "recovery"
]);

function normalizeDocumentIdentityBoundary(value, readOnlyObservation = false) {
  if (DOCUMENT_IDENTITY_BOUNDARIES.has(value)) return value;
  return readOnlyObservation ? "periodic-observation" : "run-read";
}

function identityAdmissionClass(boundary) {
  return boundary === "periodic-observation" ? "observation" : "fresh-authority";
}

function identityRecoveryOptions(recovery, boundary, readOnlyObservation = false, expectedRunId = null) {
  const bounds = recoveryRuntimeBounds(recovery);
  return {
    readOnlyObservation,
    boundary: normalizeDocumentIdentityBoundary(boundary, readOnlyObservation),
    expectedRunId: typeof expectedRunId === "string" && expectedRunId ? expectedRunId : null,
    maxAttempts: bounds.identityAttempts,
    maxTotalProbes: bounds.identityRecoveryProbeLimit,
    recoveryWindowMs: bounds.identityRecoveryWindowMs,
    retryBackoffBaseMs: bounds.identityRecoveryBackoffBaseMs,
    retryBackoffMaxMs: bounds.identityRecoveryBackoffMaxMs
  };
}

function identityEpisodeId() {
  return typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `identity-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function boundedIdentityDurationMs(value) {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(60_000, Math.ceil(value));
}

function identityObservationSummary(identity) {
  const outcome = ["match", "mismatch", "unavailable"].includes(identity?.status)
    ? identity.status
    : "unavailable";
  const attempt = Number.isSafeInteger(identity?.attempts) && identity.attempts > 0
    ? Math.min(12, identity.attempts)
    : 1;
  const totalAttempts = Number.isSafeInteger(identity?.totalAttempts) && identity.totalAttempts > 0
    ? Math.min(12, identity.totalAttempts)
    : attempt;
  const summary = {
    outcome,
    attempt,
    totalAttempts: Math.max(attempt, totalAttempts),
    durationMs: boundedIdentityDurationMs(identity?.durationMs),
    boundary: normalizeDocumentIdentityBoundary(identity?.boundary),
    episodeId: typeof identity?.episodeId === "string" && identity.episodeId
      ? identity.episodeId.slice(0, 80)
      : "identity-unknown",
    consecutiveUnavailable: Number.isSafeInteger(identity?.consecutiveUnavailable) && identity.consecutiveUnavailable >= 0
      ? Math.min(12, identity.consecutiveUnavailable)
      : (outcome === "unavailable" ? attempt : 0),
    recoveryElapsedMs: boundedIdentityDurationMs(identity?.recoveryElapsedMs ?? identity?.durationMs),
    source: ["document-lifetime-grant", "bound-content-sender"].includes(identity?.source)
      ? identity.source
      : "probe"
  };
  if (outcome === "unavailable" || summary.consecutiveUnavailable > 0) {
    summary.reason = DOCUMENT_IDENTITY_UNAVAILABLE_REASONS.has(identity?.reason)
      ? identity.reason
      : "unknown";
    summary.failureCode = DOCUMENT_IDENTITY_FAILURE_CODES[summary.reason] ?? "IDENTITY_UNKNOWN";
  }
  return summary;
}

function withIdentityObservation(response, identity) {
  return { ...response, identityObservation: identityObservationSummary(identity) };
}

// Reads the tab's current top document: the browser's own documentId plus the content
// script's per-document instance id. Probe observations are not authority decisions.
function decodeCurrentTopDocumentResults(results, startedAt = Date.now()) {
  const unavailable = (reason) => ({
    outcome: "unavailable",
    reason: DOCUMENT_IDENTITY_UNAVAILABLE_REASONS.has(reason) ? reason : "unknown",
    top: null,
    durationMs: boundedIdentityDurationMs(Date.now() - startedAt)
  });
  if (!Array.isArray(results)) return unavailable("probe-result-invalid");
  const top = results.find((item) => item && typeof item === "object" && item.frameId === 0);
  if (!top) return unavailable("top-frame-missing");
  return {
    outcome: "observed",
    top: {
      documentId: typeof top.documentId === "string" && top.documentId ? top.documentId : null,
      documentInstanceId: typeof top.result === "string" && top.result ? top.result : null
    },
    durationMs: boundedIdentityDurationMs(Date.now() - startedAt)
  };
}

function withOwnedIdentityAttempt(probe, ownedAttempt) {
  if (!ownedAttempt) return probe;
  Object.defineProperty(probe, "ownedAttempt", {
    value: ownedAttempt,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return probe;
}

async function readCurrentTopDocument(
  tabId,
  {
    readOnlyObservation = false,
    boundary = null,
    episodeId = "identity-unknown",
    timeoutMs = STATUS_ATTEMPT_TIMEOUT_MS
  } = {}
) {
  const startedAt = Date.now();
  const normalizedBoundary = normalizeDocumentIdentityBoundary(boundary, readOnlyObservation);
  const admissionClass = identityAdmissionClass(normalizedBoundary);
  const unavailable = (reason) => ({
    outcome: "unavailable",
    reason: DOCUMENT_IDENTITY_UNAVAILABLE_REASONS.has(reason) ? reason : "unknown",
    top: null,
    durationMs: boundedIdentityDurationMs(Date.now() - startedAt)
  });
  if (!Number.isInteger(tabId)) return unavailable("probe-result-invalid");
  let ownedAttempt = null;
  try {
    const executeProbe = () => chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => globalThis.__AIPM_DOCUMENT_INSTANCE_ID__ ?? null
    });
    const timeoutDetails = {
      code: "DOCUMENT_IDENTITY_TIMEOUT",
      phase: "document-identity",
      tabId
    };
    const gateOptions = {
      timeoutMs: Math.max(1, Math.min(STATUS_ATTEMPT_TIMEOUT_MS, Number(timeoutMs) || STATUS_ATTEMPT_TIMEOUT_MS)),
      timeoutErrorFactory: () => makeOperationError(
        timeoutDetails.code,
        timeoutDetails.phase,
        timeoutDetails.tabId
      ),
      fingerprint: `${normalizedBoundary}:${episodeId}`,
      admissionClass,
      continueRecoveryEpisode: true,
      shouldBackoff: (error) => error?.code === "DOCUMENT_IDENTITY_TIMEOUT"
    };
    let results;
    if (admissionClass === "fresh-authority") {
      ownedAttempt = documentIdentityByTab.startOwned(tabId, executeProbe, gateOptions);
      results = await ownedAttempt.publicPromise;
    } else {
      results = await documentIdentityByTab.run(tabId, executeProbe, gateOptions);
    }
    return withOwnedIdentityAttempt(decodeCurrentTopDocumentResults(results, startedAt), ownedAttempt);
  } catch (error) {
    if (error?.code === "DOCUMENT_IDENTITY_TIMEOUT") {
      return withOwnedIdentityAttempt(unavailable("timeout"), ownedAttempt);
    }
    if (error?.code === "READ_ONLY_CONTACT_EXPIRED") {
      return withOwnedIdentityAttempt(unavailable("stale-result"), ownedAttempt);
    }
    if (["READ_ONLY_CONTACT_BUSY", "READ_ONLY_BACKOFF"].includes(error?.code)) {
      return withOwnedIdentityAttempt(unavailable("backpressure"), ownedAttempt);
    }
    return withOwnedIdentityAttempt(unavailable("execute-script-rejected"), ownedAttempt);
  }
}

const identitySleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function identityEpisodeInvalidReason(episode) {
  if (!episode) return null;
  if (episode.cancellation?.cancelled) {
    return episode.cancellation.reason === "execution-session-changed"
      ? "execution-session-changed"
      : (episode.cancellation.reason === "document-lifecycle-changed"
          ? "document-lifecycle-changed"
          : "unknown");
  }
  if (episode.workerToken !== DOCUMENT_IDENTITY_WORKER_TOKEN ||
      executionSessionGeneration !== episode.executionGeneration) {
    return "execution-session-changed";
  }
  if (documentAuthorityEpoch(episode.tabId) !== episode.authorityEpoch) {
    return "document-lifecycle-changed";
  }
  if (episode.expectedRunId && stopIntentMatches(episode.tabId, episode.expectedRunId)) return "unknown";
  return null;
}

async function waitForIdentitySlice(ms, cancellation = null) {
  if (!cancellation) {
    await identitySleep(ms);
    return false;
  }
  const outcome = await Promise.race([
    identitySleep(ms).then(() => false),
    cancellation.cancellationPromise.then(() => true)
  ]);
  return outcome === true;
}

async function waitForIdentityAdmission(tabId, admissionClass, deadline, fingerprint, cancellation = null) {
  while (Date.now() < deadline) {
    if (cancellation?.cancelled) return false;
    const state = documentIdentityByTab.state(tabId, { admissionClass, fingerprint });
    if (state.state === "idle") return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    if (state.state === "backoff") {
      if (state.sameFingerprint) return true;
      if (await waitForIdentitySlice(
        Math.min(remaining, Math.max(1, state.retryAfterMs)),
        cancellation
      )) return false;
      continue;
    }
    if (state.state === "in-flight") {
      const outcomes = [
        documentIdentityByTab.waitForRelease(tabId),
        identitySleep(Math.min(remaining, DOCUMENT_IDENTITY_RECOVERY_WAIT_SLICE_MS))
      ];
      if (cancellation) outcomes.push(cancellation.cancellationPromise);
      await Promise.race(outcomes).catch(() => {});
      if (cancellation?.cancelled) return false;
      continue;
    }
    if (await waitForIdentitySlice(
      Math.min(remaining, DOCUMENT_IDENTITY_RECOVERY_WAIT_SLICE_MS),
      cancellation
    )) return false;
  }
  return false;
}

async function waitForOwnedIdentitySettlement(handle, episode) {
  const eligibilityDeadline = Math.min(episode.deadline, handle.authorityExpiresAtMs);
  while (true) {
    const settlement = handle.settlement();
    if (settlement) return { state: "settled", settlement };
    const invalidReason = identityEpisodeInvalidReason(episode);
    if (invalidReason) return { state: "invalidated", reason: invalidReason };
    const remaining = eligibilityDeadline - Date.now();
    if (remaining <= 0) {
      handle.supersede();
      handle.expireIfDue();
      return {
        state: episode.deadline <= handle.authorityExpiresAtMs
          ? "deadline-exhausted"
          : "attempt-expired"
      };
    }
    const outcome = await Promise.race([
      handle.settlementPromise.then((lateSettlement) => ({ state: "settled", settlement: lateSettlement })),
      episode.cancellation.cancellationPromise.then(() => ({
        state: "invalidated",
        reason: identityEpisodeInvalidReason(episode) ?? "unknown"
      })),
      identitySleep(Math.min(remaining, DOCUMENT_IDENTITY_RECOVERY_WAIT_SLICE_MS)).then(() => null)
    ]);
    if (outcome) return outcome;
  }
}

function compareDocumentIdentity(probe, documentId, documentInstanceId = null) {
  if (probe?.outcome !== "observed" || !probe.top) {
    return {
      status: "unavailable",
      reason: DOCUMENT_IDENTITY_UNAVAILABLE_REASONS.has(probe?.reason) ? probe.reason : "unknown"
    };
  }
  const top = probe.top;
  let comparable = false;

  if (typeof documentId === "string" && documentId &&
      typeof top.documentId === "string" && top.documentId) {
    comparable = true;
    if (top.documentId !== documentId) return { status: "mismatch", reason: null };
  }
  if (typeof documentInstanceId === "string" && documentInstanceId &&
      typeof top.documentInstanceId === "string" && top.documentInstanceId) {
    comparable = true;
    if (top.documentInstanceId !== documentInstanceId) return { status: "mismatch", reason: null };
  }
  return comparable
    ? { status: "match", reason: null }
    : { status: "unavailable", reason: "identity-fields-unavailable" };
}

// Only this read-only probe is retried. A proven mismatch returns immediately, and callers
// perform each Run/Lease/command mutation at most once after a positive match.
async function reconfirmCurrentTopDocument(
  tabId,
  documentId,
  documentInstanceId = null,
  {
    readOnlyObservation = false,
    maxAttempts = DOCUMENT_IDENTITY_ATTEMPTS,
    maxTotalProbes = null,
    recoveryWindowMs = 4_000,
    retryBackoffBaseMs = DOCUMENT_IDENTITY_RETRY_DELAY_MS,
    retryBackoffMaxMs = DOCUMENT_IDENTITY_RETRY_DELAY_MS,
    boundary = null,
    expectedRunId = null
  } = {}
) {
  const startedAt = Date.now();
  const normalizedBoundary = normalizeDocumentIdentityBoundary(boundary, readOnlyObservation);
  const periodicOnly = normalizedBoundary === "periodic-observation";
  const legacyAttempts = [3, 5, 10].includes(Number(maxAttempts))
    ? Number(maxAttempts)
    : DOCUMENT_IDENTITY_ATTEMPTS;
  const configuredProbeLimit = Number.isSafeInteger(maxTotalProbes)
    ? Math.min(12, Math.max(legacyAttempts, maxTotalProbes))
    : Math.min(12, legacyAttempts + 2);
  const attempts = periodicOnly ? legacyAttempts : configuredProbeLimit;
  const legacyWindow = legacyAttempts * STATUS_ATTEMPT_TIMEOUT_MS +
    Math.max(0, legacyAttempts - 1) * DOCUMENT_IDENTITY_RETRY_DELAY_MS;
  const windowMs = periodicOnly
    ? legacyWindow
    : Math.min(10_000, Math.max(1, Number(recoveryWindowMs) || 4_000));
  const backoffBaseMs = Math.min(1_000, Math.max(
    DOCUMENT_IDENTITY_RETRY_DELAY_MS,
    Number(retryBackoffBaseMs) || DOCUMENT_IDENTITY_RETRY_DELAY_MS
  ));
  const backoffMaxMs = Math.min(2_000, Math.max(
    backoffBaseMs,
    Number(retryBackoffMaxMs) || backoffBaseMs
  ));
  const deadline = startedAt + windowMs;
  const episodeId = identityEpisodeId();
  const admissionClass = identityAdmissionClass(normalizedBoundary);
  const episodeFingerprint = `${normalizedBoundary}:${episodeId}`;
  const authorityEpoch = documentAuthorityEpoch(tabId);
  const executionGeneration = executionSessionGeneration;
  let executionSessionId = null;
  let consecutiveUnavailable = 0;
  let lastReason = "unknown";
  let probesStarted = 0;
  const unavailableIdentity = (reason, attempt = Math.max(1, probesStarted), extraUnavailable = 0) => ({
    status: "unavailable",
    reason: DOCUMENT_IDENTITY_UNAVAILABLE_REASONS.has(reason) ? reason : "unknown",
    top: null,
    attempts: Math.max(1, attempt),
    totalAttempts: attempts,
    durationMs: boundedIdentityDurationMs(Date.now() - startedAt),
    boundary: normalizedBoundary,
    episodeId,
    consecutiveUnavailable: consecutiveUnavailable + extraUnavailable,
    recoveryElapsedMs: boundedIdentityDurationMs(Date.now() - startedAt)
  });
  if (!periodicOnly) {
    try {
      executionSessionId = await getExecutionSessionId();
    } catch {
      return unavailableIdentity("execution-session-changed", 1, 1);
    }
    if (executionSessionGeneration !== executionGeneration) {
      return unavailableIdentity("execution-session-changed", 1, 1);
    }
  }
  const cancellation = periodicOnly
    ? null
    : registerIdentityRecoveryEpisode(tabId, expectedRunId);
  const episode = periodicOnly
    ? null
    : {
        tabId,
        workerToken: DOCUMENT_IDENTITY_WORKER_TOKEN,
        episodeToken: Symbol("document-identity-episode"),
        episodeId,
        fingerprint: episodeFingerprint,
        admissionClass,
        authorityBoundary: normalizedBoundary,
        authorityEpoch,
        executionGeneration,
        executionSessionId,
        expectedRunId: typeof expectedRunId === "string" && expectedRunId ? expectedRunId : null,
        deadline,
        cancellation
      };

  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const invalidReason = periodicOnly
        ? (executionSessionGeneration !== executionGeneration
            ? "execution-session-changed"
            : (documentAuthorityEpoch(tabId) !== authorityEpoch ? "document-lifecycle-changed" : null))
        : identityEpisodeInvalidReason(episode);
      if (invalidReason) return unavailableIdentity(invalidReason, probesStarted, 1);
      if (!periodicOnly) {
        let currentExecutionSessionId;
        try {
          currentExecutionSessionId = await getExecutionSessionId();
        } catch {
          return unavailableIdentity("execution-session-changed", probesStarted, 1);
        }
        if (currentExecutionSessionId !== executionSessionId) {
          return unavailableIdentity("execution-session-changed", probesStarted, 1);
        }
        const admitted = await waitForIdentityAdmission(
          tabId,
          admissionClass,
          deadline,
          episodeFingerprint,
          cancellation
        );
        if (!admitted) {
          return unavailableIdentity(identityEpisodeInvalidReason(episode) ?? lastReason, probesStarted, 1);
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      probesStarted = attempt;
      let probe = await readCurrentTopDocument(tabId, {
        readOnlyObservation,
        boundary: normalizedBoundary,
        episodeId,
        timeoutMs: remaining
      });
      const publicTimedOut = !periodicOnly && probe?.reason === "timeout" && probe?.ownedAttempt;
      if (publicTimedOut) {
        const selectedAttempt = {
          episodeToken: episode.episodeToken,
          handle: probe.ownedAttempt
        };
        const late = await waitForOwnedIdentitySettlement(selectedAttempt.handle, episode);
        if (late.state === "invalidated") {
          return unavailableIdentity(late.reason, attempt, 1);
        }
        if (late.state === "settled") {
          const eligible = selectedAttempt.episodeToken === episode.episodeToken &&
            selectedAttempt.handle.isSettlementEligible(late.settlement, {
              key: tabId,
              fingerprint: episodeFingerprint,
              admissionClass,
              deadlineMs: deadline
            });
          if (!eligible) {
            selectedAttempt.handle.supersede();
            probe = {
              outcome: "unavailable",
              reason: "stale-result",
              top: null,
              durationMs: boundedIdentityDurationMs(Date.now() - startedAt)
            };
          } else if (late.settlement.outcome === "fulfilled") {
            probe = decodeCurrentTopDocumentResults(late.settlement.value, startedAt);
          } else {
            probe = {
              outcome: "unavailable",
              reason: "execute-script-rejected",
              top: null,
              durationMs: boundedIdentityDurationMs(Date.now() - startedAt)
            };
          }
        } else {
          probe = {
            outcome: "unavailable",
            reason: "timeout",
            top: null,
            durationMs: boundedIdentityDurationMs(Date.now() - startedAt)
          };
        }
      }

      const postProbeInvalidReason = periodicOnly
        ? (executionSessionGeneration !== executionGeneration
            ? "execution-session-changed"
            : (documentAuthorityEpoch(tabId) !== authorityEpoch ? "document-lifecycle-changed" : null))
        : identityEpisodeInvalidReason(episode);
      if (postProbeInvalidReason) return unavailableIdentity(postProbeInvalidReason, attempt, 1);
      if (!periodicOnly) {
        let currentExecutionSessionId;
        try {
          currentExecutionSessionId = await getExecutionSessionId();
        } catch {
          return unavailableIdentity("execution-session-changed", attempt, 1);
        }
        if (currentExecutionSessionId !== executionSessionId) {
          return unavailableIdentity("execution-session-changed", attempt, 1);
        }
      }

      const decision = compareDocumentIdentity(probe, documentId, documentInstanceId);
      if (decision.status === "unavailable") {
        consecutiveUnavailable += 1;
        lastReason = decision.reason;
      } else if (publicTimedOut) {
        consecutiveUnavailable += 1;
        lastReason = "timeout";
      }
      const identity = {
        status: decision.status,
        reason: decision.status === "unavailable" ? decision.reason : lastReason,
        top: probe.top ?? null,
        attempts: attempt,
        totalAttempts: attempts,
        durationMs: boundedIdentityDurationMs(Date.now() - startedAt),
        boundary: normalizedBoundary,
        episodeId,
        consecutiveUnavailable,
        recoveryElapsedMs: boundedIdentityDurationMs(Date.now() - startedAt)
      };
      if (decision.status !== "unavailable") return identity;
      if (attempt === attempts || Date.now() >= deadline) return identity;
      const retryDelayMs = periodicOnly
        ? DOCUMENT_IDENTITY_RETRY_DELAY_MS
        : Math.min(backoffMaxMs, backoffBaseMs * (2 ** Math.min(10, consecutiveUnavailable - 1)));
      if (await waitForIdentitySlice(
        Math.min(retryDelayMs, Math.max(1, deadline - Date.now())),
        cancellation
      )) {
        return unavailableIdentity(identityEpisodeInvalidReason(episode) ?? lastReason, attempt, 1);
      }
    }
    return unavailableIdentity(lastReason);
  } finally {
    cancellation?.dispose();
  }
}

function contentSenderAuthorityFailure(sender) {
  if (Number.isInteger(sender?.frameId) && sender.frameId !== 0) return "top-frame-missing";
  if (typeof sender?.documentLifecycle === "string" && sender.documentLifecycle !== "active") {
    return "document-lifecycle-changed";
  }
  return null;
}

function contentSenderCanHoldDocumentGrant(sender) {
  return sender?.frameId === 0 && contentSenderAuthorityFailure(sender) == null;
}

function documentGrantMatches(grant, {
  tabId,
  documentId,
  documentInstanceId,
  executionSessionId,
  executionGeneration,
  authorityEpoch
}) {
  if (!grant || grant.tabId !== tabId || grant.executionSessionId !== executionSessionId ||
      grant.executionGeneration !== executionGeneration || grant.authorityEpoch !== authorityEpoch) {
    return false;
  }
  let comparable = false;
  if (typeof grant.documentId === "string" && grant.documentId) {
    if (typeof documentId !== "string" || !documentId || grant.documentId !== documentId) return false;
    comparable = true;
  }
  if (typeof grant.documentInstanceId === "string" && grant.documentInstanceId) {
    if (typeof documentInstanceId !== "string" || !documentInstanceId ||
        grant.documentInstanceId !== documentInstanceId) return false;
    comparable = true;
  }
  return comparable;
}

function documentGrantIdentity(grant, boundary, startedAt) {
  return {
    status: "match",
    reason: null,
    top: {
      documentId: grant.documentId,
      documentInstanceId: grant.documentInstanceId
    },
    attempts: 1,
    totalAttempts: 1,
    durationMs: boundedIdentityDurationMs(Date.now() - startedAt),
    boundary: normalizeDocumentIdentityBoundary(boundary),
    episodeId: "document-lifetime-grant",
    consecutiveUnavailable: 0,
    recoveryElapsedMs: boundedIdentityDurationMs(Date.now() - startedAt),
    source: "document-lifetime-grant",
    authorityEpoch: grant.authorityEpoch,
    executionGeneration: grant.executionGeneration
  };
}

const BOUND_CONTENT_SENDER_RECOVERY_REASONS = new Set([
  "timeout",
  "execute-script-rejected",
  "backpressure",
  "identity-fields-unavailable",
  "probe-result-invalid",
  "stale-result"
]);

function recoverUnavailableIdentityFromBoundContentSender(identity, binding, {
  tabId,
  documentId,
  documentInstanceId,
  executionSessionId,
  executionGeneration,
  authorityEpoch,
  boundary,
  startedAt,
  sender
}) {
  if (identity?.status !== "unavailable" ||
      !BOUND_CONTENT_SENDER_RECOVERY_REASONS.has(identity.reason) ||
      !contentSenderCanHoldDocumentGrant(sender) ||
      !binding || binding.executionSessionId !== executionSessionId ||
      binding.boundTabId !== tabId ||
      typeof binding.boundDocumentId !== "string" || !binding.boundDocumentId ||
      typeof binding.documentInstanceId !== "string" || !binding.documentInstanceId ||
      typeof documentId !== "string" || !documentId ||
      typeof documentInstanceId !== "string" || !documentInstanceId ||
      binding.boundDocumentId !== documentId || binding.documentInstanceId !== documentInstanceId) {
    return null;
  }
  return {
    ...identity,
    status: "match",
    top: { documentId, documentInstanceId },
    durationMs: boundedIdentityDurationMs(Date.now() - startedAt),
    boundary,
    episodeId: typeof identity.episodeId === "string" && identity.episodeId
      ? identity.episodeId
      : "bound-content-sender",
    consecutiveUnavailable: Math.max(1, Number(identity.consecutiveUnavailable) || 0),
    recoveryElapsedMs: boundedIdentityDurationMs(Date.now() - startedAt),
    source: "bound-content-sender",
    authorityEpoch,
    executionGeneration
  };
}

function invalidateMatchedContentIdentity(identity, reason) {
  return {
    ...identity,
    status: "unavailable",
    reason: DOCUMENT_IDENTITY_UNAVAILABLE_REASONS.has(reason) ? reason : "unknown",
    top: null,
    consecutiveUnavailable: Math.max(1, Number(identity?.consecutiveUnavailable) || 0),
    recoveryElapsedMs: boundedIdentityDurationMs(identity?.recoveryElapsedMs ?? identity?.durationMs)
  };
}

function contentAuthorityInvalidReason(tabId, identity) {
  if (identity?.status !== "match") return "unknown";
  if (identity.executionGeneration !== executionSessionGeneration) return "execution-session-changed";
  if (identity.authorityEpoch !== documentAuthorityEpoch(tabId)) return "document-lifecycle-changed";
  return null;
}

/*
  MessageSender.tab/frameId/documentId are supplied by the browser, while the content
  instance id is confined to the extension's isolated world. A fresh non-periodic probe
  establishes their exact tuple once. tabs.onUpdated(loading), tab close, content-instance
  replacement, execution-session change, and Service Worker restart all prevent reuse.

  A periodic observation may consume an already-established grant, but it can never create
  one that a later mutation would trust. If reuse is unavailable, the existing bounded
  read-only probe remains the fail-closed fallback for this one authority transaction.
*/
async function reconfirmContentDocument(
  tabId,
  documentId,
  documentInstanceId,
  options,
  sender,
  durableBinding = null
) {
  const startedAt = Date.now();
  const boundary = normalizeDocumentIdentityBoundary(options?.boundary, options?.readOnlyObservation === true);
  const senderFailure = contentSenderAuthorityFailure(sender);
  if (senderFailure) {
    return {
      status: "unavailable",
      reason: senderFailure,
      top: null,
      attempts: 1,
      totalAttempts: 1,
      durationMs: boundedIdentityDurationMs(Date.now() - startedAt),
      boundary,
      episodeId: "content-sender-invalid",
      consecutiveUnavailable: 1,
      recoveryElapsedMs: boundedIdentityDurationMs(Date.now() - startedAt),
      source: "document-lifetime-grant"
    };
  }

  const executionGeneration = executionSessionGeneration;
  const authorityEpoch = documentAuthorityEpoch(tabId);
  let executionSessionId = null;
  try {
    executionSessionId = await getExecutionSessionId();
  } catch {
    executionSessionId = null;
  }
  if (executionSessionId && contentSenderCanHoldDocumentGrant(sender)) {
    const grant = documentAuthorityGrantByTab.get(tabId);
    if (documentGrantMatches(grant, {
      tabId,
      documentId,
      documentInstanceId,
      executionSessionId,
      executionGeneration,
      authorityEpoch
    })) {
      return documentGrantIdentity(grant, boundary, startedAt);
    }
  }

  let identity = await reconfirmCurrentTopDocument(
    tabId,
    documentId,
    documentInstanceId,
    options
  );
  identity.source = "probe";
  let executionSessionStillCurrent = false;
  if (executionSessionId) {
    try {
      executionSessionStillCurrent = await getExecutionSessionId() === executionSessionId;
    } catch {
      executionSessionStillCurrent = false;
    }
  }
  const senderRecoveredIdentity = recoverUnavailableIdentityFromBoundContentSender(
    identity,
    durableBinding,
    {
      tabId,
      documentId,
      documentInstanceId,
      executionSessionId,
      executionGeneration,
      authorityEpoch,
      boundary,
      startedAt,
      sender
    }
  );
  if (senderRecoveredIdentity) identity = senderRecoveredIdentity;
  if (identity.status === "match") {
    if (executionSessionGeneration !== executionGeneration || !executionSessionStillCurrent) {
      return invalidateMatchedContentIdentity(identity, "execution-session-changed");
    }
    if (documentAuthorityEpoch(tabId) !== authorityEpoch) {
      return invalidateMatchedContentIdentity(identity, "document-lifecycle-changed");
    }
    identity.authorityEpoch = authorityEpoch;
    identity.executionGeneration = executionGeneration;
  }
  const mayEstablishGrant = identity.status === "match" &&
    boundary !== "periodic-observation" &&
    executionSessionId &&
    contentSenderCanHoldDocumentGrant(sender) &&
    executionSessionGeneration === executionGeneration &&
    documentAuthorityEpoch(tabId) === authorityEpoch &&
    executionSessionStillCurrent;
  if (mayEstablishGrant) {
    documentAuthorityGrantByTab.set(tabId, Object.freeze({
      tabId,
      documentId: typeof identity.top?.documentId === "string" ? identity.top.documentId : null,
      documentInstanceId: typeof identity.top?.documentInstanceId === "string"
        ? identity.top.documentInstanceId
        : null,
      executionSessionId,
      executionGeneration,
      authorityEpoch
    }));
  }
  return identity;
}

async function senderOwnsCurrentTopDocument(tabId, documentId, documentInstanceId = null) {
  const identity = await reconfirmCurrentTopDocument(tabId, documentId, documentInstanceId);
  return identity.status === "match";
}

async function getRunForTab(
  tabId,
  currentConversationKey = null,
  currentDocumentId = null,
  currentDocumentInstanceId = null,
  readOnlyObservation = false,
  readOnlyRecovery = null,
  authorityBoundary = null,
  sender = null
) {
  const requestExecutionGeneration = executionSessionGeneration;
  const executionSessionId = await getExecutionSessionId();
  const key = activeRunKey(tabId);
  const stored = await chrome.storage.local.get([key, LEGACY_ACTIVE_RUN_KEY]);
  let run = stored[key];
  if (run) {
    if (run.executionSessionId !== executionSessionId) {
      if (!readOnlyObservation) await quarantineRunKey(key, run, "stale-browser-session");
      return { ok: true, run: null, quarantined: true, quarantineReason: "stale-browser-session" };
    }
    const identity = await reconfirmContentDocument(
      tabId,
      currentDocumentId,
      currentDocumentInstanceId,
      identityRecoveryOptions(readOnlyRecovery, authorityBoundary, readOnlyObservation, run.runId),
      sender,
      run
    );
    if (identity.status === "unavailable") {
      const unavailableRunId = typeof run.runId === "string" ? run.runId : null;
      const lifecycleInvalidated = ["document-lifecycle-changed", "execution-session-changed"]
        .includes(identity.reason);
      // A temporary observation outage may suspend, but an authority/session epoch change
      // invalidates the recovery transaction itself. Commit the exact Run fail-closed here:
      // the old content document may already be gone and cannot be relied on to relay the
      // terminal transition. Ordinary UNAVAILABLE remains recoverable and does not mutate.
      const durableLifecycleStop = readOnlyObservation && lifecycleInvalidated && unavailableRunId
        ? await failClosedRunForTab(tabId, {
            serviceWorkerVersion: EXTENSION_VERSION,
            expectedRunId: unavailableRunId,
            expectedStateRevision: run.stateRevision,
            expectedExecutionSessionId: run.executionSessionId,
            expectedConversationKey: run.conversationKey,
            expectedBoundDocumentId: run.boundDocumentId,
            expectedDocumentInstanceId: run.documentInstanceId,
            reason: "document_identity_unconfirmed"
          })
        : null;
      return withIdentityObservation({
        ok: false,
        errorCode: "DOCUMENT_IDENTITY_UNCONFIRMED",
        runId: unavailableRunId,
        lifecycleInvalidated,
        lifecycleCommitted: durableLifecycleStop?.run?.resumable === false,
        lifecycleContextStale: durableLifecycleStop?.staleRun === true,
        error: "現在のdocument identityを再確認できないためRun取得を拒否しました。"
      }, identity);
    }
    if (identity.status === "mismatch") {
      // A read-only mismatch is positive evidence that the exact runner document is no
      // longer current. Unlike UNAVAILABLE it is terminal: synchronize the exact Run's
      // durable state before the stale caller is released. The non-read-only path is
      // already inside serializeRunState and its content caller performs the same exact
      // fail-closed transition after this response, avoiding nested serialization here.
      const mismatchRunId = typeof run.runId === "string" ? run.runId : null;
      const durableMismatch = readOnlyObservation && mismatchRunId
        ? await failClosedRunForTab(tabId, {
            serviceWorkerVersion: EXTENSION_VERSION,
            expectedRunId: mismatchRunId,
            expectedStateRevision: run.stateRevision,
            expectedExecutionSessionId: run.executionSessionId,
            expectedConversationKey: run.conversationKey,
            expectedBoundDocumentId: run.boundDocumentId,
            expectedDocumentInstanceId: run.documentInstanceId,
            reason: "document_identity_mismatch"
          })
        : null;
      return withIdentityObservation({
        ok: true,
        run: null,
        runId: mismatchRunId,
        staleDocument: true,
        quarantineReason: "stale-document-request",
        mismatchCommitted: durableMismatch?.run?.pauseReason === "document_identity_mismatch",
        mismatchContextStale: durableMismatch?.staleRun === true
      }, identity);
    }
    if (executionSessionGeneration !== requestExecutionGeneration ||
        await getExecutionSessionId() !== executionSessionId) {
      return withIdentityObservation({
        ok: false,
        errorCode: "RUN_STATE_CONFLICT",
        error: "Service Worker sessionが変わったため古いRun観測を拒否しました。"
      }, identity);
    }
    const refreshed = await chrome.storage.local.get(key);
    run = refreshed[key] ?? null;
    if (!run) return withIdentityObservation({ ok: true, run: null }, identity);
    const invalidatedAfterRefresh = contentAuthorityInvalidReason(tabId, identity);
    if (invalidatedAfterRefresh) {
      return withIdentityObservation({
        ok: false,
        errorCode: "DOCUMENT_IDENTITY_UNCONFIRMED",
        runId: typeof run.runId === "string" ? run.runId : null,
        lifecycleInvalidated: true,
        error: "document authorityが失効したためRun取得を拒否しました。"
      }, invalidateMatchedContentIdentity(identity, invalidatedAfterRefresh));
    }
    if (stopIntentMatches(tabId, run.runId)) {
      return withIdentityObservation({
        ok: false,
        errorCode: "RUN_STATE_CONFLICT",
        error: "Stop処理中のRunへ古い読み取り権限を返しません。"
      }, identity);
    }
    if (run.executionSessionId !== executionSessionId) {
      if (!readOnlyObservation) await quarantineRunKey(key, run, "stale-browser-session");
      return withIdentityObservation({
        ok: true,
        run: null,
        quarantined: true,
        quarantineReason: "stale-browser-session"
      }, identity);
    }
    if (!conversationCompatible(run, currentConversationKey, currentDocumentId, currentDocumentInstanceId)) {
      if (isNewChatConfirmationPending(run, currentConversationKey)) {
        return withIdentityObservation({ ok: true, run: { ...run }, confirmationRequired: true }, identity);
      }
      const reason = String(run.conversationKey).startsWith("chatgpt:new:")
        ? "new-chat-recovery"
        : "conversation-changed";
      if (!readOnlyObservation) await quarantineRunKey(key, run, reason);
      const powerWarning = readOnlyObservation ? null : await reconcilePowerAfterMutation();
      return withIdentityObservation({ ok: true, run: null, quarantined: true, quarantineReason: reason, powerWarning }, identity);
    }

    if (run.provider && run.provider !== "chatgpt") {
      if (!readOnlyObservation) await quarantineRunKey(key, run, "provider-changed");
      const powerWarning = readOnlyObservation ? null : await reconcilePowerAfterMutation();
      return withIdentityObservation({
        ok: true,
        run: null,
        quarantined: true,
        quarantineReason: "provider-changed",
        powerWarning
      }, identity);
    }

    const rebound = {
      ...run,
      conversationKey: currentConversationKey,
      boundDocumentId: typeof currentDocumentId === "string" ? currentDocumentId : run.boundDocumentId,
      documentInstanceId: typeof currentDocumentInstanceId === "string"
        ? currentDocumentInstanceId
        : run.documentInstanceId
    };
    const bindingChanged = rebound.boundDocumentId !== run.boundDocumentId ||
      rebound.documentInstanceId !== run.documentInstanceId ||
      rebound.conversationKey !== run.conversationKey;
    const invalidatedBeforeReturn = contentAuthorityInvalidReason(tabId, identity);
    if (invalidatedBeforeReturn) {
      return withIdentityObservation({
        ok: false,
        errorCode: "DOCUMENT_IDENTITY_UNCONFIRMED",
        runId: typeof run.runId === "string" ? run.runId : null,
        lifecycleInvalidated: true,
        error: "document authorityが失効したためRun取得を拒否しました。"
      }, invalidateMatchedContentIdentity(identity, invalidatedBeforeReturn));
    }
    if (bindingChanged && !readOnlyObservation) await chrome.storage.local.set({ [key]: rebound });
    const invalidatedAfterRebind = contentAuthorityInvalidReason(tabId, identity);
    if (invalidatedAfterRebind) {
      return withIdentityObservation({
        ok: false,
        errorCode: "DOCUMENT_IDENTITY_UNCONFIRMED",
        runId: typeof run.runId === "string" ? run.runId : null,
        lifecycleInvalidated: true,
        error: "document authorityが失効したためRun取得を拒否しました。"
      }, invalidateMatchedContentIdentity(identity, invalidatedAfterRebind));
    }
    return withIdentityObservation({ ok: true, run: rebound }, identity);
  }

  const legacy = stored[LEGACY_ACTIVE_RUN_KEY];
  if (legacy) {
    if (!readOnlyObservation) await quarantineRunKey(LEGACY_ACTIVE_RUN_KEY, legacy, "legacy-unbound-run");
    return { ok: true, run: null, quarantined: true, quarantineReason: "legacy-unbound-run" };
  }
  return { ok: true, run: null };
}

// Run state carries a monotonic revision assigned here. Runner, Pause, and Resume writes
// must present the revision they last observed. Stop remains monotonic and is allowed to win
// a same-Run race, but it is separately bound to the user-observed Run id in the relay.
function nextStateRevision(existing) {
  const current = Number(existing?.stateRevision);
  return Number.isFinite(current) ? current + 1 : 1;
}

function stateRevisionToken(value) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function isStaleRunnerRevision(existing, run, runTransition) {
  if (runTransition !== "runner") return false;
  if (!existing || existing.runId !== run.runId) return false;
  const storedRevision = Number(existing.stateRevision);
  if (!Number.isFinite(storedRevision)) return false;
  if (Number(run.stateRevision) === storedRevision) return false;
  // A durable Pause request may interleave once with the exact runner revision it
  // observed. No other stale writer is admitted, and later writes use the new revision.
  const followsPendingPause = existing.pauseRequested === true &&
    run.status === "running" &&
    typeof existing.outbox?.id === "string" && existing.outbox.id.length > 0 &&
    run.outbox?.id === existing.outbox.id &&
    stateRevisionToken(existing.pauseRequestRevision) === stateRevisionToken(existing.stateRevision) &&
    stateRevisionToken(run.stateRevision) === stateRevisionToken(existing.pauseRequestBaseRevision);
  return !followsPendingPause;
}

function isStaleControlRevision(existing, run, runTransition) {
  if (!["pause", "pause-request", "resume"].includes(runTransition)) return false;
  if (!existing || existing.runId !== run.runId) return false;
  return stateRevisionToken(run.stateRevision) !== stateRevisionToken(existing.stateRevision);
}

// Second, independent guard: run progress is monotonic by construction (advanceCursor only
// moves forward), so any write that rewinds it is stale no matter what revision it claims.
function rollsBackRunProgress(existing, run) {
  if (!existing || existing.runId !== run.runId) return false;
  const beforeSends = Number(existing.cursor?.sendsCompleted ?? 0);
  const afterSends = Number(run.cursor?.sendsCompleted ?? 0);
  if (Number.isFinite(beforeSends) && Number.isFinite(afterSends) && afterSends < beforeSends) return true;
  const beforeStep = Number(existing.cursor?.stepIndex ?? 0);
  const afterStep = Number(run.cursor?.stepIndex ?? 0);
  if (Number.isFinite(beforeStep) && Number.isFinite(afterStep)) {
    if (afterStep < beforeStep) return true;
    if (afterStep === beforeStep) {
      const beforeRepeat = Number(existing.cursor?.repeatIndex ?? 0);
      const afterRepeat = Number(run.cursor?.repeatIndex ?? 0);
      if (Number.isFinite(beforeRepeat) && Number.isFinite(afterRepeat) && afterRepeat < beforeRepeat) return true;
    }
  }
  return false;
}

async function setRunForTab(
  tabId,
  run,
  documentId = null,
  currentConversationKey = null,
  currentDocumentInstanceId = null,
  runTransition = "runner",
  readOnlyRecovery = null,
  authorityBoundary = "run-save",
  sender = null
) {
  if (!run || typeof run !== "object") return { ok: false, error: "Invalid run state." };
  const requestExecutionGeneration = executionSessionGeneration;
  const executionSessionId = await getExecutionSessionId();
  if (run.executionSessionId !== executionSessionId) {
    return { ok: false, error: "Runは現在のブラウザセッションに紐づいていません。安全のため保存を拒否しました。" };
  }
  if (run.provider !== "chatgpt" || run.contentVersion !== EXTENSION_VERSION) {
    return { ok: false, error: "RunのproviderまたはContent Script versionが一致しません。" };
  }
  if (Number.isInteger(run.boundTabId) && run.boundTabId !== tabId) {
    return { ok: false, error: "Runの対象タブが一致しません。" };
  }
  const key = activeRunKey(tabId);
  const identity = await reconfirmContentDocument(
    tabId,
    documentId,
    currentDocumentInstanceId,
    identityRecoveryOptions(readOnlyRecovery, authorityBoundary, false, run.runId),
    sender,
    run
  );
  if (identity.status !== "match") {
    return withIdentityObservation({
      ok: false,
      errorCode: identity.status === "mismatch"
        ? "DOCUMENT_IDENTITY_MISMATCH"
        : "DOCUMENT_IDENTITY_UNCONFIRMED",
      error: identity.status === "mismatch"
        ? "現在のdocumentとRun更新元が一致しないため更新を拒否しました。"
        : "現在のdocumentを再確認できないためRun更新を拒否しました。"
    }, identity);
  }
  if (executionSessionGeneration !== requestExecutionGeneration ||
      await getExecutionSessionId() !== executionSessionId) {
    return withIdentityObservation({
      ok: false,
      errorCode: "RUN_STATE_CONFLICT",
      error: "Service Worker sessionが変わったため古いRun更新を拒否しました。"
    }, identity);
  }
  if (stopIntentMatches(tabId, run.runId)) {
    return withIdentityObservation({
      ok: false,
      errorCode: "RUN_STATE_CONFLICT",
      error: "Stop処理中のRunへ古い更新を適用しません。"
    }, identity);
  }
  const existingStored = await chrome.storage.local.get(key);
  const existing = existingStored[key] ?? null;
  if (existing && existing.runId !== run.runId) {
    const existingActive = existing.status === "running" || existing.status === "paused";
    if (existingActive || run.replacesRunId !== existing.runId) {
      return { ok: false, error: "Run世代が一致しないため古い更新を拒否しました。" };
    }
  } else if (!existing && run.replacesRunId != null) {
    return { ok: false, error: "置換対象のRunが存在しないため開始を拒否しました。" };
  }
  if (existing?.runId === run.runId) {
    const revivesStopped = existing.status === "stopped" && run.status !== "stopped";
    const revivesCompleted = existing.status === "completed" && !["completed", "stopped"].includes(run.status);
    const bypassesPause = existing.status === "paused" && run.status === "running" && runTransition !== "resume";
    if (revivesStopped || revivesCompleted || bypassesPause) {
      return {
        ok: false,
        errorCode: "RUN_STATE_CONFLICT",
        error: "新しいPause/Stop/完了状態を古いrunner更新で上書きできません。"
      };
    }
  }
  if (isStaleRunnerRevision(existing, run, runTransition) ||
      isStaleControlRevision(existing, run, runTransition) ||
      rollsBackRunProgress(existing, run)) {
    return {
      ok: false,
      errorCode: "RUN_STATE_CONFLICT",
      error: "Run状態はすでに新しく更新されています。古い更新を拒否しました。"
    };
  }
  if (!conversationCompatible(run, currentConversationKey, documentId, currentDocumentInstanceId)) {
    const sameStoredWriter = existing?.runId === run.runId;
    if (sameStoredWriter) await quarantineRunKey(key, existing, "conversation-changed");
    else await appendQuarantinedRun("rejected-run-set", run, "conversation-changed");
    const powerWarning = await reconcilePowerAfterMutation();
    return {
      ok: false,
      error: "Runの会話またはdocument identityが一致しません。安全のため隔離しました。",
      powerWarning
    };
  }
  let storedRun = {
    ...run,
    stateRevision: nextStateRevision(existing?.runId === run.runId ? existing : null),
    conversationKey: currentConversationKey,
    documentInstanceId: currentDocumentInstanceId,
    boundTabId: tabId,
    boundDocumentId: typeof documentId === "string" ? documentId : run.boundDocumentId
  };
  if (runTransition === "pause-request") {
    storedRun = {
      ...storedRun,
      status: "running",
      pauseRequested: true,
      pauseRequestedAt: run.pauseRequestedAt ?? new Date().toISOString(),
      pauseRequestBaseRevision: stateRevisionToken(existing?.stateRevision),
      pauseRequestRevision: stateRevisionToken(storedRun.stateRevision)
    };
  } else if (runTransition === "runner" && run.status === "running" && existing?.pauseRequested === true) {
    storedRun = {
      ...storedRun,
      pauseRequested: true,
      pauseRequestedAt: existing.pauseRequestedAt ?? null,
      pauseRequestBaseRevision: stateRevisionToken(existing.pauseRequestBaseRevision),
      pauseRequestRevision: stateRevisionToken(existing.pauseRequestRevision)
    };
  }
  if (runTransition === "start") {
    const schedulePreflight = preflightWorkflowStartSchedule(storedRun.workflow, Date.now());
    if (!schedulePreflight.ok) {
      return {
        ok: false,
        errorCode: "SCHEDULE_START_STALE",
        error: "猶予時間を超えて過去になった指定時刻があるため、Run開始を保存しませんでした。"
      };
    }
  }
  if (stopIntentMatches(tabId, run.runId)) {
    return withIdentityObservation({
      ok: false,
      errorCode: "RUN_STATE_CONFLICT",
      error: "Stop処理中のRunへ古い更新を適用しません。"
    }, identity);
  }
  if (executionSessionGeneration !== requestExecutionGeneration ||
      await getExecutionSessionId() !== executionSessionId) {
    return withIdentityObservation({
      ok: false,
      errorCode: "RUN_STATE_CONFLICT",
      error: "Service Worker sessionが変わったため古いRun更新を拒否しました。"
    }, identity);
  }
  const invalidatedBeforeSave = contentAuthorityInvalidReason(tabId, identity);
  if (invalidatedBeforeSave) {
    return withIdentityObservation({
      ok: false,
      errorCode: "DOCUMENT_IDENTITY_UNCONFIRMED",
      error: "document authorityが失効したためRun更新を拒否しました。"
    }, invalidateMatchedContentIdentity(identity, invalidatedBeforeSave));
  }
  await chrome.storage.local.set({ [key]: storedRun });
  const powerWarning = await reconcilePowerAfterMutation();
  return withIdentityObservation({ ok: true, run: storedRun, powerWarning }, identity);
}

async function getOpenBrowserTabs() {
  const tabs = await withTimeout(
    () => chrome.tabs.query({}),
    API_TIMEOUT_MS,
    { code: "TAB_ENUMERATION_TIMEOUT", phase: "tabs-query" }
  );
  if (!Array.isArray(tabs)) throw new Error("chrome.tabs.query returned an invalid tab list.");
  return tabs
    .filter((tab) => Number.isInteger(tab?.id))
    .map((tab) => {
      const candidateUrl = typeof tab.pendingUrl === "string" ? tab.pendingUrl : tab.url;
      let chatGptOriginHint = false;
      let originKnown = false;
      try {
        const origin = new URL(candidateUrl).origin;
        originKnown = true;
        chatGptOriginHint = origin === CHATGPT_ORIGIN;
      } catch {
        // Sensitive URL values are never returned or persisted; only this exact-origin boolean is retained.
      }
      // Existing host permission exposes Tab.title only for matching pages. Keep it
      // outside status/Run/diagnostic payloads and discard it with this tab-list snapshot.
      let displayTitle = "";
      if (chatGptOriginHint) {
        try {
          if (new URL(tab.url).origin === CHATGPT_ORIGIN) displayTitle = normalizeTargetTitle(tab.title);
        } catch { /* Display failure is not discovery failure. */ }
      }
      return {
        id: tab.id,
        windowId: Number.isInteger(tab.windowId) ? tab.windowId : null,
        active: tab.active === true,
        originKnown,
        chatGptOriginHint,
        displayTitle
      };
    });
}

async function getOpenTabRuns() {
  const executionSessionId = await getExecutionSessionId();
  const tabs = await getOpenBrowserTabs();
  if (tabs.length === 0) return { tabs, runs: [] };
  const keys = tabs.map((tab) => activeRunKey(tab.id));
  const stored = await chrome.storage.local.get(keys);
  return {
    tabs,
    runs: tabs.map((tab) => {
      const run = stored[activeRunKey(tab.id)] ?? null;
      return { tabId: tab.id, run: run?.executionSessionId === executionSessionId ? run : null };
    })
  };
}

async function reconcilePowerState() {
  if (!chrome.power) return;
  const { runs } = await getOpenTabRuns();
  const keepAwake = runs.some(({ run }) => run?.status === "running" && run?.keepAwake === true);
  if (keepAwake) chrome.power.requestKeepAwake("system");
  else chrome.power.releaseKeepAwake();
}

async function hasActiveRuns() {
  const { runs } = await getOpenTabRuns();
  const active = runs.filter(({ run }) => run?.status === "running" || run?.status === "paused");
  return { ok: true, active: active.length > 0, count: active.length };
}

/*
  Last CONFIRMED discovery status, per tab.

  Why this can exist without becoming authority
  ---------------------------------------------
  Discovery is a periodic READ-ONLY observation and feeds one thing: whether the
  Side Panel offers the target as available. No mutation reads it. Start, Pause,
  Resume and Stop all go through relayToChatGpt, which opens a FRESH-authority
  connection (`connectToChatGpt({ freshAuthority: true })`, which in turn refuses
  to reuse a periodic snapshot and waits for the in-flight observation to be
  released), reconfirms the current top document, and delivers an exact
  expectation tuple. The content script then independently fences the extension
  version, the execution session, the conversation key and the document instance
  before anything irreversible happens.

  So a retained value can make the button available a moment longer than the
  newest probe would; it can never make a Send land anywhere it should not.

  Two bounds keep it honest:
    - it is dropped the moment document authority is invalidated, which is what a
      navigation, reload or lifecycle change does — so it cannot survive the very
      events it would be dangerous across;
    - it expires by age regardless, so a tab that stops answering becomes
      unavailable on its own.
*/
const CONFIRMED_STATUS_RETENTION_MS = 5_000;
const confirmedStatusByTab = new Map();

function rememberConfirmedTabStatus(tabId, status) {
  if (!Number.isInteger(tabId) || status?.ok !== true) return;
  confirmedStatusByTab.set(tabId, { status, at: Date.now() });
}

function recallConfirmedTabStatus(tabId) {
  const entry = confirmedStatusByTab.get(tabId);
  if (!entry) return null;
  if (Date.now() - entry.at > CONFIRMED_STATUS_RETENTION_MS) {
    confirmedStatusByTab.delete(tabId);
    return null;
  }
  return entry.status;
}

function boundedTabStatus(status, fallback = {}) {
  return {
    pageReady: status?.pageReady === true,
    generationState: status?.generationState ?? null,
    blocker: status?.blocker ?? null,
    conversationKey: status?.conversationKey ?? null,
    run: status?.run ?? null,
    provider: status?.provider ?? null,
    instanceId: status?.instanceId ?? null,
    contentVersion: status?.contentVersion ?? fallback.contentVersion ?? null,
    discoveryError: fallback.discoveryError ?? null,
    /* True only when this item repeats a previously confirmed observation while a
       fresh one is still in flight. Presentation may show it; nothing may treat
       it as authority. */
    statusPending: fallback.statusPending === true
  };
}

function tabListItem(tab, status, fallback = {}) {
  return {
    tabId: tab.id,
    windowId: Number.isInteger(tab.windowId) ? tab.windowId : null,
    active: tab.active === true,
    displayTitle: normalizeTargetTitle(tab.displayTitle),
    status: boundedTabStatus(status, fallback)
  };
}

async function requestTabStatus(
  tabId,
  timeoutMs = STATUS_ATTEMPT_TIMEOUT_MS,
  { freshAuthority = false, readOnlyRecovery = null } = {}
) {
  try {
    if (freshAuthority && statusContactByTab.state(tabId).state === "in-flight") {
      // A user mutation never reuses a periodic snapshot as authority. It may wait for
      // that one bounded observation's quarantine to end, then performs a fresh read.
      // The expired result is never reused as authority.
      await statusContactByTab.waitForRelease(tabId);
    }
    const recovery = recoveryRuntimeBounds(readOnlyRecovery);
    const fingerprint = freshAuthority
      ? Symbol("fresh-status-authority")
      : JSON.stringify(["periodic-status", recovery.mode, recovery.identityAttempts, recovery.statusRecovery]);
    const effectiveTimeoutMs = freshAuthority
      ? Math.max(timeoutMs, recovery.identityRecoveryWindowMs + 1_000)
      : timeoutMs;
    const response = await statusContactByTab.run(
      tabId,
      () => chrome.tabs.sendMessage(
        tabId,
        {
          type: "AIPM_GET_STATUS",
          readOnlyObservation: !freshAuthority,
          readOnlyRecovery: recovery,
          authorityBoundary: freshAuthority ? "control" : "periodic-observation"
        },
        { frameId: 0 }
      ),
      {
        timeoutMs: effectiveTimeoutMs,
        timeoutErrorFactory: () => makeOperationError("TAB_STATUS_TIMEOUT", "status", tabId),
        fingerprint,
        admissionClass: freshAuthority ? "fresh-authority" : "observation",
        shouldBackoff: (error) => error?.code === "TAB_STATUS_TIMEOUT"
      }
    );
    uncertainInjectionTabs.delete(tabId);
    return {
      connected: true,
      response,
      error: null
    };
  } catch (error) {
    return {
      connected: false,
      response: null,
      error: operationFailure(error, { code: "TAB_STATUS_FAILED", phase: "status", tabId })
    };
  }
}

function candidateDiscovery(tab, status, fallback = {}, errors = []) {
  const reportedVersion = status?.contentVersion ?? fallback.contentVersion ?? null;
  const versionObserved = Boolean(status && typeof status === "object") || fallback.contentVersion != null;
  const discoveryError = versionObserved && reportedVersion !== EXTENSION_VERSION
    ? "version-mismatch"
    : (fallback.discoveryError ?? null);
  /* One place, so every path that actually confirmed a tab feeds the retention. */
  if (!discoveryError && fallback.statusPending !== true) rememberConfirmedTabStatus(tab.id, status);
  return {
    kind: "candidate",
    item: tabListItem(tab, status, { ...fallback, contentVersion: reportedVersion, discoveryError }),
    failed: Boolean(discoveryError),
    errors
  };
}

async function discoverChatGptTab(tab) {
  const direct = await requestTabStatus(tab.id);
  if (direct.connected && direct.response?.ok) {
    return candidateDiscovery(tab, direct.response);
  }
  if (tab.originKnown && !tab.chatGptOriginHint) {
    return { kind: "non-provider", item: null, failed: false, errors: [] };
  }
  if (statusContactByTab.state(tab.id).state !== "idle") {
    if (tab.chatGptOriginHint) {
      /*
        READ_ONLY_CONTACT_BUSY means this observation was never attempted: the one
        outstanding read-only contact this tab is allowed was already in use. That
        is a concurrency condition, not evidence about the tab. Reporting it as
        "status-timeout" made a healthy, already-confirmed target momentarily
        unavailable and refused Start with "接続を安全に確認できません", purely
        because two read-only observers overlapped.

        A genuine timeout, a backoff after one, or an expired contact are all real
        evidence and keep failing closed exactly as before.
      */
      const retained = direct.error?.code === "READ_ONLY_CONTACT_BUSY"
        ? recallConfirmedTabStatus(tab.id)
        : null;
      if (retained) return candidateDiscovery(tab, retained, { statusPending: true }, []);
      return candidateDiscovery(
        tab,
        null,
        { discoveryError: "status-timeout" },
        [direct.error ?? { code: "TAB_STATUS_TIMEOUT", phase: "status", tabId: tab.id }]
      );
    }
    return {
      kind: "unknown",
      item: null,
      failed: false,
      errors: [direct.error ?? { code: "TAB_STATUS_TIMEOUT", phase: "status", tabId: tab.id }]
    };
  }
  if (!tab.chatGptOriginHint && !tab.active && !direct.connected) {
    return {
      kind: "unknown",
      item: null,
      failed: false,
      errors: [direct.error ?? { code: "TAB_ORIGIN_UNAVAILABLE", phase: "status", tabId: tab.id }]
    };
  }

  const probe = await inspectContentScript(tab.id);
  if (probe.origin && probe.origin !== CHATGPT_ORIGIN) {
    if (!tab.chatGptOriginHint) return { kind: "non-provider", item: null, failed: false, errors: [] };
    return candidateDiscovery(
      tab,
      direct.response,
      { contentVersion: probe.version, discoveryError: "navigation-in-progress" },
      [probe.inspectError ?? { code: "TAB_NAVIGATING", phase: "probe", tabId: tab.id }]
    );
  }

  const originConfirmed = tab.chatGptOriginHint || probe.origin === CHATGPT_ORIGIN;
  if (!originConfirmed) {
    return {
      kind: "unknown",
      item: null,
      failed: false,
      errors: [probe.inspectError ?? direct.error ?? { code: "CONTENT_PROBE_FAILED", phase: "probe", tabId: tab.id }]
    };
  }

  if (probe.inspectError) {
    const discoveryError = probe.inspectError.code === "CONTENT_PROBE_TIMEOUT" ? "probe-timeout" : "probe-failed";
    return candidateDiscovery(tab, direct.response, { discoveryError }, [probe.inspectError]);
  }

  if (direct.connected) {
    return candidateDiscovery(
      tab,
      direct.response,
      {
        contentVersion: probe.version,
        discoveryError: "status-error"
      },
      [{ code: "CONTENT_STATUS_ERROR", phase: "status", tabId: tab.id }]
    );
  }

  if (probe.version && probe.version !== EXTENSION_VERSION) {
    return candidateDiscovery(
      tab,
      null,
      { contentVersion: probe.version, discoveryError: "version-mismatch" },
      [{ code: "CONTENT_VERSION_MISMATCH", phase: "probe", tabId: tab.id }]
    );
  }

  if (probe.corePresent || probe.controllerReady) {
    const retry = await retryExistingReceiver(tab.id, { type: "AIPM_GET_STATUS" });
    if (retry.connected && retry.response?.ok) {
      return candidateDiscovery(tab, retry.response);
    }
    return candidateDiscovery(
      tab,
      retry.response,
      {
        contentVersion: probe.version,
        discoveryError: retry.connected ? "status-error" : "receiver-unreachable"
      },
      [retry.error ?? { code: "CONTENT_RECEIVER_UNREACHABLE", phase: "status-retry", tabId: tab.id }]
    );
  }

  try {
    const connected = await injectContentScript(tab.id, { originConfirmed });
    if (connected.response?.ok) return candidateDiscovery(tab, connected.response);
    return candidateDiscovery(
      tab,
      connected.response,
      { discoveryError: "status-error" },
      [{ code: "CONTENT_STATUS_ERROR", phase: "post-injection-status", tabId: tab.id }]
    );
  } catch (error) {
    const failure = operationFailure(error, { code: "CONTENT_INJECTION_FAILED", phase: "injection", tabId: tab.id });
    const discoveryError = failure.code === "CONTENT_VERSION_MISMATCH"
      ? "version-mismatch"
      : (failure.code.endsWith("TIMEOUT") ? "injection-timeout" : "injection-failed");
    return candidateDiscovery(tab, null, { contentVersion: probe.version, discoveryError }, [failure]);
  }
}

async function getChatGptSiteAccess() {
  if (!chrome.permissions?.contains) return null;
  try {
    return await withTimeout(
      () => chrome.permissions.contains({ origins: [CHATGPT_HOST_PERMISSION] }),
      API_TIMEOUT_MS,
      { code: "SITE_ACCESS_CHECK_TIMEOUT", phase: "permissions" }
    );
  } catch {
    return null;
  }
}

async function listChatGptTabs() {
  const siteAccessGranted = await getChatGptSiteAccess();
  if (siteAccessGranted === false) {
    return {
      ok: false,
      error: "Edgeの拡張機能詳細で、chatgpt.comへのサイトアクセスを許可してください。",
      serviceWorkerVersion: EXTENSION_VERSION,
      siteAccessGranted
    };
  }

  let tabs;
  try {
    tabs = await getOpenBrowserTabs();
  } catch (error) {
    const failure = operationFailure(error, { code: "TAB_ENUMERATION_FAILED", phase: "tabs-query" });
    return {
      ok: false,
      error: "ブラウザタブ一覧を取得できませんでした。Edgeを再起動してから再試行してください。",
      errorCode: failure.code,
      discoveryErrors: [failure],
      serviceWorkerVersion: EXTENSION_VERSION,
      siteAccessGranted
    };
  }

  const settled = await Promise.allSettled(tabs.map((tab) => discoverChatGptTab(tab)));
  const discovered = settled.map((result, index) => result.status === "fulfilled"
    ? result.value
    : {
        kind: "unknown",
        item: null,
        failed: false,
        errors: [operationFailure(result.reason, {
          code: "TAB_DISCOVERY_FAILED",
          phase: "discovery",
          tabId: tabs[index]?.id
        })]
      });
  const items = discovered.flatMap(({ item }) => item ? [item] : []);
  const discoveryErrors = discovered.flatMap(({ errors }) => Array.isArray(errors) ? errors : []);
  const unknownTabFailures = discovered.filter(({ kind }) => kind === "unknown").length;
  items.sort((a, b) => Number(b.active) - Number(a.active) || a.tabId - b.tabId);
  if (items.length === 0 && unknownTabFailures > 0) {
    return {
      ok: false,
      error: "ChatGPTタブを安全に確認できませんでした。対象タブを前面にして再読み込みし、サイトアクセスを確認してください。",
      errorCode: "CHATGPT_TAB_DISCOVERY_INCOMPLETE",
      tabs: [],
      partial: true,
      failedChatGptTabs: 0,
      unknownTabFailures,
      discoveryErrors,
      serviceWorkerVersion: EXTENSION_VERSION,
      siteAccessGranted
    };
  }
  return {
    ok: true,
    tabs: items,
    partial: unknownTabFailures > 0 || discovered.some(({ failed }) => failed),
    failedChatGptTabs: discovered.filter(({ item, failed }) => item && failed).length,
    unknownTabFailures,
    discoveryErrors,
    serviceWorkerVersion: EXTENSION_VERSION,
    siteAccessGranted
  };
}

async function inspectContentScript(tabId, { freshAuthority = false } = {}) {
  try {
    if (freshAuthority && contentProbeByTab.state(tabId).state === "in-flight") {
      await contentProbeByTab.waitForRelease(tabId);
    }
    const fingerprint = freshAuthority ? Symbol("fresh-content-probe") : "periodic-content-probe";
    const results = await contentProbeByTab.run(
      tabId,
      () => chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({
          origin: location.origin,
          corePresent:
            Boolean(globalThis.__AIPM_CONTENT_CORE__) ||
            typeof ChatGptAdapter !== "undefined",
          controllerReady: globalThis.__AIPM_CONTENT_CONTROLLER_READY__ === true,
          version: globalThis.__AIPM_CONTENT_CORE__?.version ?? null
        })
      }),
      {
        timeoutMs: API_TIMEOUT_MS,
        timeoutErrorFactory: () => makeOperationError("CONTENT_PROBE_TIMEOUT", "probe", tabId),
        fingerprint,
        admissionClass: freshAuthority ? "fresh-authority" : "observation",
        shouldBackoff: (error) => error?.code === "CONTENT_PROBE_TIMEOUT"
      }
    );
    const result = results?.[0]?.result;
    if (!result || typeof result !== "object") {
      throw makeOperationError("CONTENT_PROBE_INVALID", "probe", tabId);
    }
    return { ...result, inspectError: null };
  } catch (error) {
    return {
      origin: null,
      corePresent: false,
      controllerReady: false,
      version: null,
      inspectError: operationFailure(error, { code: "CONTENT_PROBE_FAILED", phase: "probe", tabId })
    };
  }
}

const relaySleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function retryExistingReceiver(
  tabId,
  payload,
  totalTimeoutMs = RECEIVER_RETRY_TIMEOUT_MS,
  { freshAuthority = false, maxAttempts = RECEIVER_RETRY_ATTEMPTS, readOnlyRecovery = null } = {}
) {
  const deadline = Date.now() + totalTimeoutMs;
  let lastError = null;
  const boundedAttempts = Math.min(12, Math.max(1, Number.isInteger(maxAttempts) ? maxAttempts : RECEIVER_RETRY_ATTEMPTS));
  for (let attempt = 0; attempt < boundedAttempts; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    if (attempt > 0) await relaySleep(Math.min(RECEIVER_RETRY_DELAY_MS, remaining));
    const result = await requestTabStatus(
      tabId,
      Math.min(STATUS_ATTEMPT_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
      { freshAuthority, readOnlyRecovery }
    );
    if (payload?.type !== "AIPM_GET_STATUS") {
      throw new Error("retryExistingReceiver only supports read-only status checks.");
    }
    if (result.connected) return result;
    lastError = result.error;
    // Timeout does not cancel tabs.sendMessage. Admission stays closed until the
    // underlying request settles, so retrying here could only spin or rebuild backlog.
    if (statusContactByTab.state(tabId).state !== "idle") break;
  }
  return {
    connected: false,
    response: null,
    error: lastError ?? { code: "CONTENT_RECEIVER_TIMEOUT", phase: "status-retry", tabId }
  };
}

async function injectContentScript(tabId, { originConfirmed = false, freshAuthority = false, recovery = null } = {}) {
  if (uncertainInjectionTabs.has(tabId)) {
    throw makeOperationError("CONTENT_INJECTION_UNCERTAIN", "injection", tabId);
  }
  const existing = contentInjectionByTab.get(tabId);
  if (existing) return existing;

  const operation = (async () => {
    const bounds = recoveryRuntimeBounds(recovery);
    const ready = await retryExistingReceiver(
      tabId,
      { type: "AIPM_GET_STATUS" },
      400,
      { freshAuthority, maxAttempts: bounds.statusRetryAttempts, readOnlyRecovery: bounds }
    );
    if (ready.connected) return { injected: false, response: ready.response };

    const probe = await inspectContentScript(tabId, { freshAuthority });
    if (probe.origin && probe.origin !== CHATGPT_ORIGIN) {
      throw makeOperationError("NOT_CHATGPT_TAB", "probe", tabId);
    }
    if (!originConfirmed && probe.origin !== CHATGPT_ORIGIN) {
      throw makeOperationError(probe.inspectError?.code ?? "CONTENT_PROBE_FAILED", "probe", tabId);
    }
    if (probe.version && probe.version !== EXTENSION_VERSION) {
      throw makeOperationError("CONTENT_VERSION_MISMATCH", "probe", tabId);
    }
    if (probe.corePresent || probe.controllerReady) {
      const bootstrapped = await retryExistingReceiver(
        tabId,
        { type: "AIPM_GET_STATUS" },
        bounds.statusRetryTimeoutMs,
        { freshAuthority, maxAttempts: bounds.statusRetryAttempts, readOnlyRecovery: bounds }
      );
      if (bootstrapped.connected) return { injected: false, response: bootstrapped.response };
      throw makeOperationError("CONTENT_BOOTSTRAP_UNREACHABLE", "status-retry", tabId);
    }

    try {
      await withTimeout(
        () => chrome.scripting.executeScript({
          target: { tabId },
          files: ["src/content-core.js", "src/content-runner.js", "src/content-controller.js"]
        }),
        API_TIMEOUT_MS,
        { code: "CONTENT_INJECTION_TIMEOUT", phase: "injection", tabId }
      );
    } catch (error) {
      if (error?.code === "CONTENT_INJECTION_TIMEOUT") uncertainInjectionTabs.add(tabId);
      throw error;
    }
    const injected = await retryExistingReceiver(
      tabId,
      { type: "AIPM_GET_STATUS" },
      bounds.statusRetryTimeoutMs,
      { freshAuthority, maxAttempts: bounds.statusRetryAttempts, readOnlyRecovery: bounds }
    );
    if (!injected.connected) {
      throw makeOperationError("CONTENT_RECEIVER_UNREACHABLE", "post-injection-status", tabId);
    }
    return { injected: true, response: injected.response };
  })();

  contentInjectionByTab.set(tabId, operation);
  try {
    return await operation;
  } finally {
    if (contentInjectionByTab.get(tabId) === operation) contentInjectionByTab.delete(tabId);
  }
}

async function resolveRelayTab(targetTabId) {
  if (Number.isInteger(targetTabId)) return { id: targetTabId };

  let tabs = [];
  try {
    tabs = await withTimeout(
      () => chrome.tabs.query({ active: true, lastFocusedWindow: true }),
      API_TIMEOUT_MS,
      { code: "ACTIVE_TAB_QUERY_TIMEOUT", phase: "active-tab-query" }
    );
  } catch (error) {
    return {
      error: `アクティブタブを取得できませんでした: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  const tab = tabs.find((candidate) => Number.isInteger(candidate?.id));
  if (!tab) return { error: "アクティブなブラウザタブを取得できませんでした。" };
  return tab;
}

function connectionFailure(message, code) {
  return { ok: false, relayError: message, relayErrorCode: code };
}

function contentStatusObservationFailure(response) {
  let errorCode = null;
  let errorPhase = null;
  let errorMessage = null;
  switch (response?.errorCode) {
    case "READ_ONLY_CONTACT_BUSY":
      errorCode = "READ_ONLY_CONTACT_BUSY";
      errorPhase = "read-only-observation";
      errorMessage = "前回の読み取り確認がまだ完了していません。負荷を増やさないため今回の確認を停止しました。";
      break;
    case "READ_ONLY_BACKOFF":
      errorCode = "READ_ONLY_BACKOFF";
      errorPhase = "read-only-observation";
      errorMessage = "読み取り確認は一時的な待機中です。少し待ってから状態を更新してください。";
      break;
    case "READ_ONLY_CONTACT_EXPIRED":
      errorCode = "READ_ONLY_CONTACT_EXPIRED";
      errorPhase = "read-only-observation";
      errorMessage = "読み取り確認が時間内に完了しませんでした。安全のため今回の確認を停止しました。";
      break;
    case "RUN_OBSERVATION_TIMEOUT":
      errorCode = "RUN_OBSERVATION_TIMEOUT";
      errorPhase = "run-observation";
      errorMessage = "Run状態の読み取り確認が時間切れになりました。安全のため実行を進めていません。";
      break;
    case "DOCUMENT_IDENTITY_UNCONFIRMED":
      errorCode = "DOCUMENT_IDENTITY_UNCONFIRMED";
      errorPhase = "document-identity";
      errorMessage = "document identityを確認できなかったため、安全のため操作を進めていません。";
      break;
    case "DOCUMENT_IDENTITY_MISMATCH":
      errorCode = "DOCUMENT_IDENTITY_MISMATCH";
      errorPhase = "document-identity";
      errorMessage = "接続中にdocumentが変わったため、安全のため操作を進めていません。";
      break;
    default:
      return connectionFailure(
        "選択したChatGPTタブの状態を確認できませんでした。ページを再読み込みしてください。",
        "CONTENT_STATUS_ERROR"
      );
  }

  const failure = connectionFailure(errorMessage, errorCode);
  failure.relayErrorPhase = errorPhase;
  if (["DOCUMENT_IDENTITY_UNCONFIRMED", "DOCUMENT_IDENTITY_MISMATCH"].includes(errorCode)) {
    failure.identityObservation = identityObservationSummary({
      status: errorCode === "DOCUMENT_IDENTITY_MISMATCH" ? "mismatch" : "unavailable",
      reason: response?.identityObservation?.reason,
      attempts: response?.identityObservation?.attempt,
      totalAttempts: response?.identityObservation?.totalAttempts,
      durationMs: response?.identityObservation?.durationMs
    });
  }
  if (Number.isFinite(response?.retryAfterMs) && response.retryAfterMs >= 0) {
    failure.retryAfterMs = Math.min(60_000, Math.ceil(response.retryAfterMs));
  }
  return failure;
}

function validateContentStatus(response) {
  if (!response?.ok) {
    return contentStatusObservationFailure(response);
  }
  if (response.contentVersion !== EXTENSION_VERSION) {
    return connectionFailure(
      `Service Worker v${EXTENSION_VERSION} とContent Script v${response.contentVersion ?? "不明"}が一致しません。拡張機能とChatGPTタブを再読み込みしてください。`,
      "CONTENT_VERSION_MISMATCH"
    );
  }
  if (response.provider !== "chatgpt") {
    return connectionFailure("選択したタブをChatGPTとして安全に確認できませんでした。", "CONTENT_PROVIDER_MISMATCH");
  }
  if (typeof response.instanceId !== "string" || !response.instanceId ||
      typeof response.conversationKey !== "string" || !response.conversationKey.startsWith("chatgpt:")) {
    return connectionFailure("選択したChatGPTタブのdocument／会話identityを確認できませんでした。", "CONTENT_IDENTITY_MISSING");
  }
  return null;
}

async function connectToChatGpt(tabId, { freshAuthority = false, recovery = null } = {}) {
  const bounds = recoveryRuntimeBounds(recovery);
  const direct = await requestTabStatus(tabId, STATUS_ATTEMPT_TIMEOUT_MS, {
    freshAuthority,
    readOnlyRecovery: bounds
  });
  if (direct.connected) {
    const invalid = validateContentStatus(direct.response);
    return invalid ?? { ok: true, response: direct.response };
  }
  if (statusContactByTab.state(tabId).state !== "idle") {
    return connectionFailure(
      "選択したChatGPTタブの前回の状態確認がまだ完了していません。負荷を増やさないため再試行せず停止しました。",
      direct.error?.code ?? "TAB_STATUS_TIMEOUT"
    );
  }

  const probe = await inspectContentScript(tabId, { freshAuthority });
  if (probe.origin && probe.origin !== CHATGPT_ORIGIN) {
    return connectionFailure("ChatGPTタブを選択した状態で実行してください。", "NOT_CHATGPT_TAB");
  }
  if (probe.origin !== CHATGPT_ORIGIN) {
    return connectionFailure(
      "選択したタブをChatGPTとして確認できませんでした。サイトアクセスを確認してページを再読み込みしてください。",
      probe.inspectError?.code ?? "CONTENT_PROBE_FAILED"
    );
  }
  if (probe.version && probe.version !== EXTENSION_VERSION) {
    return connectionFailure(
      `Service Worker v${EXTENSION_VERSION} とContent Script v${probe.version ?? "不明"}が一致しません。ChatGPTタブを再読み込みしてください。`,
      "CONTENT_VERSION_MISMATCH"
    );
  }

  if (probe.corePresent || probe.controllerReady) {
    const retry = await retryExistingReceiver(
      tabId,
      { type: "AIPM_GET_STATUS" },
      bounds.statusRetryTimeoutMs,
      { freshAuthority, maxAttempts: bounds.statusRetryAttempts, readOnlyRecovery: bounds }
    );
    if (!retry.connected) {
      return connectionFailure(
        "ChatGPT側のContent Scriptが読み込み途中または不完全です。二重注入を避けるため停止しました。ChatGPTタブを再読み込みしてください。",
        retry.error?.code ?? "CONTENT_RECEIVER_UNREACHABLE"
      );
    }
    const invalid = validateContentStatus(retry.response);
    return invalid ?? { ok: true, response: retry.response };
  }

  try {
    const injected = await injectContentScript(tabId, { originConfirmed: true, freshAuthority, recovery: bounds });
    const invalid = validateContentStatus(injected.response);
    return invalid ?? { ok: true, response: injected.response };
  } catch (error) {
    const failure = operationFailure(error, { code: "CONTENT_INJECTION_FAILED", phase: "injection", tabId });
    return connectionFailure(
      "ChatGPTへの安全な接続に失敗しました。サイトアクセスを確認し、ChatGPTタブを再読み込みしてください。",
      failure.code
    );
  }
}

async function relayToChatGpt(payload, targetTabId = null) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, relayError: "送信内容が不正です。" };
  }
  if (payload.type !== "AIPM_GET_STATUS" && !Number.isInteger(targetTabId)) {
    return connectionFailure("変更操作には明示的な対象タブが必要です。", "TARGET_TAB_REQUIRED");
  }

  const tab = await resolveRelayTab(targetTabId);
  if (tab.error) return { ok: false, relayError: tab.error };

  // Stop is a tab/run-bound monotonic revoke. Commit it before any document contact;
  // document identity gates only the best-effort content cleanup delivery below.
  let durableStop = null;
  if (payload.type === "AIPM_STOP") {
    if (typeof payload.expectedRunId !== "string" || !payload.expectedRunId) {
      return connectionFailure(
        "停止対象のRunを確認できません。状態を更新してから再操作してください。",
        "STALE_CONTROL_INTENT"
      );
    }
    durableStop = await durablyStopRunForTab(tab.id, payload.expectedRunId);
    if (!durableStop.ok) {
      return connectionFailure(durableStop.error, durableStop.errorCode ?? "STALE_CONTROL_INTENT");
    }
  }

  const requestedRecovery = recoveryRuntimeBounds(payload.readOnlyRecovery ?? payload.workflow?.recovery);
  const connection = await connectToChatGpt(tab.id, {
    freshAuthority: payload.type !== "AIPM_GET_STATUS",
    recovery: requestedRecovery
  });
  if (!connection.ok) {
    if (durableStop) {
      return {
        ok: true,
        run: durableStop.run,
        stopCommitted: true,
        cleanupDelivered: false,
        scheduleCleanupFailed: durableStop.scheduleCleanupFailed === true,
        powerWarning: durableStop.powerWarning
      };
    }
    return connection;
  }
  if (payload.type === "AIPM_GET_STATUS") return connection.response;

  const runControl = ["AIPM_PAUSE", "AIPM_RESUME", "AIPM_STOP"].includes(payload.type);
  if (runControl && !durableStop) {
    const observedRun = connection.response.run ?? null;
    if (typeof payload.expectedRunId !== "string" || !payload.expectedRunId ||
        observedRun?.runId !== payload.expectedRunId) {
      return connectionFailure(
        "操作対象のRunがクリック後に変わりました。状態を更新してから再操作してください。",
        "STALE_CONTROL_INTENT"
      );
    }
    if (payload.type !== "AIPM_STOP") {
      const suppliedRevision = Object.prototype.hasOwnProperty.call(payload, "expectedStateRevision")
        ? stateRevisionToken(payload.expectedStateRevision)
        : Symbol("missing-revision");
      if (typeof suppliedRevision === "symbol" || suppliedRevision !== stateRevisionToken(observedRun.stateRevision)) {
        return connectionFailure(
          "操作対象のRun状態がクリック後に変わりました。状態を更新してから再操作してください。",
          "STALE_CONTROL_INTENT"
        );
      }
    }
  }

  // Retry only the read-only identity probe. The command delivery below is still attempted
  // at most once, after a positive identity match, and is never retried if delivery is
  // ambiguous.
  const expectedInstanceId = connection.response.instanceId ?? null;
  const confirmedRecovery = recoveryRuntimeBounds(
    connection.response.run?.workflow?.recovery ?? requestedRecovery
  );
  const requestExecutionGeneration = executionSessionGeneration;
  const identity = await reconfirmCurrentTopDocument(tab.id, null, expectedInstanceId, {
    ...identityRecoveryOptions(
      confirmedRecovery,
      "control",
      false,
      payload.expectedRunId ?? connection.response.run?.runId ?? null
    )
  });
  if (identity.status === "mismatch") {
    if (durableStop) {
      return withIdentityObservation({
        ok: true,
        run: durableStop.run,
        stopCommitted: true,
        cleanupDelivered: false,
        scheduleCleanupFailed: durableStop.scheduleCleanupFailed === true,
        powerWarning: durableStop.powerWarning
      }, identity);
    }
    return withIdentityObservation(connectionFailure(
      "接続確認後にChatGPTタブのdocumentが変わりました。重複実行を避けるため停止しました。状態を確認してから再実行してください。",
      "DOCUMENT_CHANGED_BEFORE_DELIVERY"
    ), identity);
  }
  if (identity.status === "unavailable") {
    if (durableStop) {
      return withIdentityObservation({
        ok: true,
        run: durableStop.run,
        stopCommitted: true,
        cleanupDelivered: false,
        scheduleCleanupFailed: durableStop.scheduleCleanupFailed === true,
        powerWarning: durableStop.powerWarning
      }, identity);
    }
    return withIdentityObservation(connectionFailure(
      "選択したChatGPTタブのdocument identityを再確認できません。誤送信を避けるため操作を届けず停止しました。",
      "DOCUMENT_IDENTITY_UNCONFIRMED"
    ), identity);
  }
  if (executionSessionGeneration !== requestExecutionGeneration) {
    if (durableStop) {
      return withIdentityObservation({
        ok: true,
        run: durableStop.run,
        stopCommitted: true,
        cleanupDelivered: false,
        scheduleCleanupFailed: durableStop.scheduleCleanupFailed === true,
        powerWarning: durableStop.powerWarning
      }, identity);
    }
    return withIdentityObservation(connectionFailure(
      "Service Worker sessionが変わったため古い操作を届けませんでした。",
      "STALE_CONTROL_INTENT"
    ), identity);
  }
  const pinnedDocument = identity.top;

  const executionSessionId = await getExecutionSessionId();
  const deliveredRun = durableStop?.run ?? connection.response.run ?? null;
  const deliveredPayload = {
    ...payload,
    serviceWorkerVersion: EXTENSION_VERSION,
    executionSessionId,
    expectedConversationKey: connection.response.conversationKey ?? null,
    expectedDocumentInstanceId: connection.response.instanceId ?? null,
    expectedRunId: runControl ? payload.expectedRunId : connection.response.run?.runId ?? null,
    ...(runControl ? { expectedStateRevision: stateRevisionToken(deliveredRun?.stateRevision) } : {}),
    ...(payload.type === "AIPM_START" ? { bindingTabId: tab.id } : {})
  };
  // documentId and frameId are mutually exclusive. A confirmed instance can still use the
  // top-frame fallback on browsers that omit documentId; the content-side instance fence
  // remains mandatory.
  const deliveryTarget = pinnedDocument?.documentId
    ? { documentId: pinnedDocument.documentId }
    : { frameId: 0 };

  try {
    const response = await withTimeout(
      () => chrome.tabs.sendMessage(tab.id, deliveredPayload, deliveryTarget),
      API_TIMEOUT_MS,
      { code: "COMMAND_DELIVERY_TIMEOUT", phase: "command-delivery", tabId: tab.id }
    );
    if (durableStop) {
      return {
        ok: true,
        run: durableStop.run,
        stopCommitted: true,
        cleanupDelivered: response?.ok === true,
        scheduleCleanupFailed: durableStop.scheduleCleanupFailed === true,
        powerWarning: durableStop.powerWarning
      };
    }
    return withIdentityObservation(response, identity);
  } catch (error) {
    if (durableStop) {
      return {
        ok: true,
        run: durableStop.run,
        stopCommitted: true,
        cleanupDelivered: false,
        scheduleCleanupFailed: durableStop.scheduleCleanupFailed === true,
        powerWarning: durableStop.powerWarning
      };
    }
    const failure = operationFailure(error, { code: "COMMAND_DELIVERY_FAILED", phase: "command-delivery", tabId: tab.id });
    return {
      ok: false,
      relayErrorCode: failure.code,
      relayError: "選択したChatGPTタブへの操作が届いたか確認できません。重複実行を避けるため自動再送しません。状態を更新し、Runが表示された場合はその状態を確認してください。"
    };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const supported = new Set([
    "AIPM_ARM_ALARM",
    "AIPM_CLEAR_ALARM",
    "AIPM_GET_ALARM_SIGNAL",
    "AIPM_RELAY_TO_CHATGPT",
    "AIPM_LIST_CHATGPT_TABS",
    "AIPM_HAS_ACTIVE_RUNS",
    "AIPM_RUN_GET",
    "AIPM_RUN_SET",
    "AIPM_RUN_FAIL_CLOSED",
    "AIPM_RUN_NEW_CHAT_CONFIRM_REQUIRED",
    "AIPM_RUN_CONFIRM_NEW_CHAT_TARGET",
    "AIPM_LEASE_ACQUIRE",
    "AIPM_LEASE_RENEW",
    "AIPM_LEASE_RELEASE"
  ]);
  if (!supported.has(message?.type)) return false;

  (async () => {
    await ensureLifecycleReady();
    if (message.type === "AIPM_RELAY_TO_CHATGPT") {
      return relayToChatGpt(message.payload, Number.isInteger(message.targetTabId) ? message.targetTabId : null);
    }
    if (message.type === "AIPM_LIST_CHATGPT_TABS") return listChatGptTabs();
    if (message.type === "AIPM_HAS_ACTIVE_RUNS") return hasActiveRuns();
    if (["AIPM_LEASE_ACQUIRE", "AIPM_LEASE_RENEW", "AIPM_LEASE_RELEASE"].includes(message.type)) {
      return mutateConversationLease(message, sender);
    }
    if (["AIPM_RUN_FAIL_CLOSED", "AIPM_RUN_NEW_CHAT_CONFIRM_REQUIRED", "AIPM_RUN_CONFIRM_NEW_CHAT_TARGET"].includes(message.type)) {
      const tabId = sender?.tab?.id;
      if (!Number.isInteger(tabId)) return { ok: false, error: "Run safety state requires a ChatGPT tab sender." };
      if (message.type === "AIPM_RUN_FAIL_CLOSED") return failClosedRunForTab(tabId, message);
      if (message.type === "AIPM_RUN_NEW_CHAT_CONFIRM_REQUIRED") return requireNewChatConfirmationForTab(tabId, message);
      return confirmNewChatTargetForTab(tabId, message, sender);
    }
    if (message.type === "AIPM_RUN_GET") {
      const tabId = sender?.tab?.id;
      if (!Number.isInteger(tabId)) return { ok: false, error: "Run state requires a ChatGPT tab sender." };
      const authorityBoundary = normalizeDocumentIdentityBoundary(
        message.authorityBoundary,
        message.readOnlyObservation === true
      );
      const readRun = () => getRunForTab(
          tabId,
          message.conversationKey ?? null,
          sender?.documentId ?? null,
          message.documentInstanceId ?? null,
          message.readOnlyObservation === true,
          message.readOnlyRecovery ?? null,
          authorityBoundary,
          sender
        );
      if (message.readOnlyObservation === true) {
        const fingerprint = JSON.stringify([
          message.conversationKey ?? null,
          sender?.documentId ?? null,
          message.documentInstanceId ?? null,
          authorityBoundary
        ]);
        const periodicOnly = authorityBoundary === "periodic-observation";
        const observationGate = periodicOnly ? runObservationByTab : runAuthorityObservationByTab;
        const recovery = recoveryRuntimeBounds(message.readOnlyRecovery);
        return observationGate.run(tabId, readRun, {
          timeoutMs: periodicOnly
            ? RUN_OBSERVATION_TIMEOUT_MS
            : recovery.identityRecoveryWindowMs + 1_000,
          timeoutErrorFactory: () => makeOperationError(
            "RUN_OBSERVATION_TIMEOUT",
            periodicOnly ? "run-observation" : authorityBoundary,
            tabId
          ),
          fingerprint,
          shouldBackoff: (error) => error?.code === "RUN_OBSERVATION_TIMEOUT"
        }).catch((error) => {
          if (typeof error?.phase !== "string") error.phase = "run-observation";
          if (!Number.isInteger(error?.tabId)) error.tabId = tabId;
          throw error;
        });
      }
      return serializeRunState(tabId, readRun);
    }
    if (message.type === "AIPM_RUN_SET") {
      const tabId = sender?.tab?.id;
      if (!Number.isInteger(tabId)) return { ok: false, error: "Run state requires a ChatGPT tab sender." };
      return serializeRunState(tabId, () => setRunForTab(
          tabId,
          message.run,
          sender?.documentId ?? null,
          message.conversationKey ?? null,
          message.documentInstanceId ?? null,
          message.runTransition ?? "runner",
          message.readOnlyRecovery ?? message.run?.workflow?.recovery ?? null,
          message.authorityBoundary ?? "run-save",
          sender
        ));
    }
    if (["AIPM_ARM_ALARM", "AIPM_CLEAR_ALARM", "AIPM_GET_ALARM_SIGNAL"].includes(message.type)) {
      const invalid = await validateSessionBoundMessage(message);
      if (invalid) return invalid;
    }
    if (message.type === "AIPM_ARM_ALARM") {
      return serializeScheduleMutation(() => armSchedule(message, sender));
    }
    if (message.type === "AIPM_CLEAR_ALARM") {
      return serializeScheduleMutation(() => clearSchedule(message));
    }
    const name = alarmName(message.runId, message.stepId);
    const signals = await readMap(SIGNALS_KEY);
    const executionSessionId = await getExecutionSessionId();
    const signal = signals[name]?.executionSessionId === executionSessionId ? signals[name] : null;
    return { ok: true, signal };
  })().then(sendResponse).catch((error) => sendResponse(messageFailureResponse(error)));
  return true;
});
