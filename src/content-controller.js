"use strict";

var initialRecoveryPromise = initialRecoveryPromise && typeof initialRecoveryPromise.then === "function"
  ? initialRecoveryPromise
  : null;
var identityRecoveredRunReads = identityRecoveredRunReads instanceof WeakSet
  ? identityRecoveredRunReads
  : new WeakSet();

function markIdentityRecoveredRunRead(run, response) {
  if (!run || typeof run !== "object") return;
  const observation = response?.identityObservation;
  if (observation?.outcome === "match" && Number(observation?.consecutiveUnavailable) > 0) {
    identityRecoveredRunReads.add(run);
  }
}

function wasIdentityRecoveredRunRead(run) {
  return Boolean(run && typeof run === "object" && identityRecoveredRunReads.has(run));
}

function hasUnfinishedOutbox(run) {
  return Boolean(run?.outbox);
}

function markDeliveryReviewRequired(run, reason = "delivery-state-review") {
  run.resumable = false;
  run.phase = "ambiguous";
  run.pauseReason = reason;
  run.lastErrorCode = reason;
  run.lastErrorMessage = "送信開始後に実行が中断されました。重複送信を避けるため自動再開できません。ChatGPT側の状態を確認してください。";
}

function cancelActiveRunnerForControl(message) {
  // Stop is an immediate, terminal revoke. Pause is coordinated through the durable Run
  // so an in-flight irreversible Send/ACK can reach an exact result before pausing.
  if (message?.type !== "AIPM_STOP") return;
  if (validateControlMessage(message)) return;
  if (typeof message?.expectedRunId !== "string" || message.expectedRunId !== activeRunnerRunId) return;
  if (message.executionSessionId !== activeRunnerExecutionSessionId) return;
  localRunnerToken += 1;
}

async function getRunStateConversationKeyOrQuarantine() {
  try {
    return ChatGptAdapter.getConversationKey();
  } catch (error) {
    if (error?.code !== "conversation_identity_unknown") throw error;

    // This stop-only path deliberately does not depend on conversation identity or a current
    // top-document probe. A stale caller can at worst pause a Run in its own tab; it can never
    // cause a send or revive a Run. That keeps identity_unknown durable even during navigation.
    await failClosedRunWithoutIdentity(activeRunnerRunId);
    throw error;
  }
}

function throwRunDocumentIdentityFailure(response) {
  const code = response?.errorCode;
  if (code !== "DOCUMENT_IDENTITY_UNCONFIRMED" && code !== "DOCUMENT_IDENTITY_MISMATCH") return;
  const error = new Error(response?.error ?? "Document identity could not be confirmed.");
  error.code = code === "DOCUMENT_IDENTITY_MISMATCH"
    ? "document_identity_mismatch"
    : "document_identity_unconfirmed";
  error.runId = typeof response?.runId === "string" ? response.runId : null;
  if (typeof normalizeDocumentIdentityObservation === "function") {
    error.identityObservation = normalizeDocumentIdentityObservation(
      response?.identityObservation,
      code === "DOCUMENT_IDENTITY_MISMATCH" ? "mismatch" : "unavailable"
    );
  }
  throw error;
}

async function getActiveRun({ readOnlyObservation = false, recovery = null, authorityBoundary = null } = {}) {
  const response = await chrome.runtime.sendMessage({
    type: "AIPM_RUN_GET",
    conversationKey: await getRunStateConversationKeyOrQuarantine(),
    documentInstanceId: instanceId,
    readOnlyObservation,
    readOnlyRecovery: recovery,
    authorityBoundary: authorityBoundary ?? (readOnlyObservation ? "periodic-observation" : "run-read")
  });
  if (response?.identityObservation?.outcome === "mismatch") {
    throwRunDocumentIdentityFailure({
      ...response,
      errorCode: "DOCUMENT_IDENTITY_MISMATCH",
      runId: response.runId ?? activeRunnerRunId
    });
  }
  if (!response?.ok) {
    throwRunDocumentIdentityFailure(response);
    const error = new Error(response?.error ?? "Run state could not be loaded.");
    if (typeof response?.errorCode === "string" && response.errorCode) {
      error.code = response.errorCode.toLowerCase();
    }
    if (typeof response?.errorPhase === "string" && response.errorPhase) error.phase = response.errorPhase;
    if (Number.isFinite(response?.retryAfterMs) && response.retryAfterMs >= 0) {
      error.retryAfterMs = Math.ceil(response.retryAfterMs);
    }
    throw error;
  }
  if (typeof recordDocumentIdentityRecoveryDiagnostic === "function") {
    recordDocumentIdentityRecoveryDiagnostic(response, response.run ?? null);
  }
  markIdentityRecoveredRunRead(response.run ?? null, response);
  return response.run ?? null;
}

function statusObservationFailureResponse(error) {
  let errorCode = null;
  let errorPhase = null;
  let errorMessage = null;
  switch (error?.code) {
    case "read_only_contact_busy":
      errorCode = "READ_ONLY_CONTACT_BUSY";
      errorPhase = "read-only-observation";
      errorMessage = "前回の読み取り確認がまだ完了していません。負荷を増やさないため今回の確認を停止しました。";
      break;
    case "read_only_backoff":
      errorCode = "READ_ONLY_BACKOFF";
      errorPhase = "read-only-observation";
      errorMessage = "読み取り確認は一時的な待機中です。少し待ってから状態を更新してください。";
      break;
    case "read_only_contact_expired":
      errorCode = "READ_ONLY_CONTACT_EXPIRED";
      errorPhase = "read-only-observation";
      errorMessage = "読み取り確認が時間内に完了しませんでした。安全のため今回の確認を停止しました。";
      break;
    case "run_observation_timeout":
      errorCode = "RUN_OBSERVATION_TIMEOUT";
      errorPhase = "run-observation";
      errorMessage = "Run状態の読み取り確認が時間切れになりました。安全のため実行を進めていません。";
      break;
    case "document_identity_unconfirmed":
      errorCode = "DOCUMENT_IDENTITY_UNCONFIRMED";
      errorPhase = "document-identity";
      errorMessage = "document identityを確認できなかったため、安全のため操作を進めていません。";
      break;
    case "document_identity_mismatch":
      errorCode = "DOCUMENT_IDENTITY_MISMATCH";
      errorPhase = "document-identity";
      errorMessage = "接続中にdocumentが変わったため、安全のため操作を進めていません。";
      break;
    default:
      return {
        ok: false,
        error: "状態確認を完了できなかったため、安全のため操作を進めていません。"
      };
  }

  const response = { ok: false, errorCode, errorPhase, error: errorMessage };
  if (["DOCUMENT_IDENTITY_UNCONFIRMED", "DOCUMENT_IDENTITY_MISMATCH"].includes(errorCode) &&
      typeof normalizeDocumentIdentityObservation === "function") {
    response.identityObservation = normalizeDocumentIdentityObservation(
      error?.identityObservation,
      errorCode === "DOCUMENT_IDENTITY_MISMATCH" ? "mismatch" : "unavailable"
    );
  }
  if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs >= 0) {
    response.retryAfterMs = Math.min(60_000, Math.ceil(error.retryAfterMs));
  }
  return response;
}

async function saveActiveRun(run, runTransition = "runner", authorityBoundary = "run-save") {
  run.updatedAt = nowIso();
  const response = await chrome.runtime.sendMessage({
    type: "AIPM_RUN_SET",
    run,
    runTransition,
    conversationKey: await getRunStateConversationKeyOrQuarantine(),
    documentInstanceId: instanceId,
    readOnlyRecovery: run?.workflow?.recovery ?? null,
    authorityBoundary
  });
  if (!response?.ok) {
    throwRunDocumentIdentityFailure(response);
    const error = new Error(response?.error ?? "Run state could not be saved.");
    error.code = response?.errorCode === "RUN_STATE_CONFLICT" ? "run_state_conflict" : "run_state_save_failed";
    throw error;
  }
  Object.assign(run, response.run ?? {});
  if (typeof recordDocumentIdentityRecoveryDiagnostic === "function") {
    recordDocumentIdentityRecoveryDiagnostic(response, run);
  }
  renderStatusPill(run);
}

function createRun(workflow, options = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: crypto.randomUUID(),
    provider: ChatGptAdapter.id,
    conversationKey: ChatGptAdapter.getConversationKey(),
    documentInstanceId: instanceId,
    executionSessionId: options.executionSessionId,
    contentVersion: globalThis.__AIPM_CONTENT_CORE__?.version ?? null,
    replacesRunId: typeof options.replacesRunId === "string" ? options.replacesRunId : null,
    boundTabId: Number.isInteger(options.bindingTabId) ? options.bindingTabId : null,
    keepAwake: options.keepAwake === true,
    workflow,
    plannedSends: workflow.plannedSends,
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
    checkpointLabel: null,
    startedAt: nowIso(),
    updatedAt: nowIso()
  };
}

function preflightWorkflowStartSchedule(workflow, nowMs) {
  const now = Number(nowMs);
  for (const step of workflow?.steps ?? []) {
    if (step?.type !== "wait-until") continue;
    const scheduledAt = Date.parse(step.at);
    const graceMs = Number(step.graceMs);
    if (!Number.isFinite(now) || !Number.isFinite(scheduledAt) || !Number.isFinite(graceMs) || graceMs < 0) {
      return { ok: false, reason: "invalid", stepId: String(step?.id ?? "") };
    }
    if (step.latePolicy === "pause" && now - scheduledAt > graceMs) {
      return { ok: false, reason: "stale-pause", stepId: step.id };
    }
  }
  return { ok: true };
}

async function startRun(workflowInput, options = {}, controlMessage = null) {
  if (startInFlight) return { ok: false, error: "開始処理はすでに進行中です。" };
  startInFlight = true;
  try {
    const existing = await getActiveRun({ authorityBoundary: "control" });
    const invalid = validateControlMessage(controlMessage, existing);
    if (invalid) return invalid;
    if (existing?.status === "running" || existing?.status === "paused") {
      return { ok: false, error: "このタブにはすでにRunがあります。停止してから開始してください。" };
    }

    const workflow = normalizeWorkflow(workflowInput);
    const run = createRun(workflow, { ...options, replacesRunId: existing?.runId ?? null });
    const targetChanged = validateControlMessage(controlMessage);
    if (targetChanged) return targetChanged;
    const schedulePreflight = preflightWorkflowStartSchedule(workflow, Date.now());
    if (!schedulePreflight.ok) {
      return { ok: false, error: "猶予時間を超えて過去になった指定時刻があります。時刻または遅延時の動作を確認してから開始してください。" };
    }
    await saveActiveRun(run, "start");
    // Diagnostics are non-authoritative. Once Start is durably committed, a logging failure
    // must not report failure while leaving a latent running Run for reload recovery.
    appendPostCommitDiagnostic("run_started", { runId: run.runId, phase: run.phase, status: run.status });
    localRunnerToken += 1;
    executeRun(run, localRunnerToken);
    return { ok: true, run };
  } finally {
    startInFlight = false;
  }
}

async function resumeNewChatConfirmation(run) {
  const targetKey = ChatGptAdapter.getConversationKey();
  if (!String(targetKey).startsWith("chatgpt:c:")) {
    return { ok: false, error: "New Chat送信後はcanonical conversationを確認してからResumeしてください。" };
  }

  const blocker = ChatGptAdapter.detectBlocker();
  if (blocker) return { ok: false, error: blockerToError(blocker).message };

  const response = await chrome.runtime.sendMessage({
    type: "AIPM_RUN_CONFIRM_NEW_CHAT_TARGET",
    expectedRunId: run.runId,
    conversationKey: targetKey,
    documentInstanceId: instanceId,
    readOnlyRecovery: run.workflow?.recovery ?? null,
    serviceWorkerVersion: globalThis.__AIPM_CONTENT_CORE__?.version ?? null,
    executionSessionId: run.executionSessionId
  });
  if (!response?.ok || !response.run) {
    return { ok: false, error: response?.error ?? "Resume先のconversationを安全に採用できませんでした。" };
  }
  Object.assign(run, response.run);

  const sentStep = currentStep(run);
  advanceCursor(run, true);
  run.outbox = null;
  const morePositionsRemain = run.cursor.stepIndex < run.workflow.steps.length || run.cursor.repeatIndex > 0;
  const fence = morePositionsRemain ? postSendDelayFence(run, sentStep) : null;
  run.waitState = fence;
  run.status = "running";
  run.phase = fence ? "delay" : "ready";
  run.pauseReason = null;
  run.pauseRequested = false;
  run.pauseRequestedAt = null;
  run.pauseRequestBaseRevision = null;
  run.pauseRequestRevision = null;
  run.lastErrorCode = null;
  run.lastErrorMessage = null;
  run.resumable = true;
  await saveActiveRun(run, "resume");
  appendPostCommitDiagnostic("new_chat_target_confirmed", { runId: run.runId, phase: run.phase, status: run.status });

  localRunnerToken += 1;
  executeRun(run, localRunnerToken);
  return { ok: true };
}

async function resumeRun(controlMessage = null) {
  const run = await getActiveRun({ authorityBoundary: "control" });
  const invalid = validateControlMessage(controlMessage, run);
  if (invalid) return invalid;
  if (!run || run.status !== "paused") return { ok: false, error: "このタブに一時停止中のRunがありません。" };

  try {
    requireRuntimeCursorAuthority(run);
  } catch (error) {
    if (await failClosedStructurallyInvalidRun(run, error)) {
      return { ok: false, error: run.lastErrorMessage };
    }
    throw error;
  }

  if (run.pauseReason === "new-chat-confirmation-required" && run.phase === "new-chat-confirmation-required") {
    return resumeNewChatConfirmation(run);
  }

  if (["unexpected_attachment", "composer_attachment_unconfirmed", "paste_attachment_provenance_lost",
    "paste_attachment_unrecognized", "paste_attachment_settlement_timeout"].includes(run.lastErrorCode)) {
    return { ok: false, error: run.lastErrorMessage || makeError(run.lastErrorCode).message };
  }

  if (hasUnfinishedOutbox(run)) {
    markDeliveryReviewRequired(run);
    await saveActiveRun(run);
    return { ok: false, error: run.lastErrorMessage };
  }
  if (run.resumable === false) {
    return { ok: false, error: "送信成否が曖昧なRunは自動再開できません。停止して状態を確認してください。" };
  }

  const blocker = ChatGptAdapter.detectBlocker();
  if (blocker) return { ok: false, error: blockerToError(blocker).message };

  if (run.phase === "wait-until-late") {
    const step = currentStep(run);
    if (step?.type === "wait-until") run.acceptLateStepId = step.id;
  }

  run.status = "running";
  run.pauseReason = null;
  run.pauseRequested = false;
  run.pauseRequestedAt = null;
  run.pauseRequestBaseRevision = null;
  run.pauseRequestRevision = null;
  await saveActiveRun(run, "resume");

  localRunnerToken += 1;
  executeRun(run, localRunnerToken);
  return { ok: true };
}

async function pauseCurrentRun(controlMessage = null) {
  const run = await getActiveRun({ authorityBoundary: "control" });
  const invalid = validateControlMessage(controlMessage, run);
  if (invalid) return invalid;
  if (!run || run.status !== "running") return { ok: false, error: "このタブに実行中のRunがありません。" };

  const sendOutcomePending = hasUnfinishedOutbox(run) ||
    ["submitting", "waiting-ack", "generating"].includes(run.phase);
  if (sendOutcomePending) {
    // Do not turn a user Pause into submission ambiguity. The runner will either stop at
    // its next provably pre-click boundary, or finish the current click/ACK exactly once
    // and settle this request immediately after committing the cursor.
    run.pauseRequested = true;
    run.pauseRequestedAt = nowIso();
    await saveActiveRun(run, "pause-request");
    appendPostCommitDiagnostic("pause_requested", { runId: run.runId, phase: run.phase, reason: "user-pause" });
    return { ok: true };
  }

  run.status = "paused";
  run.phase = run.phase || "paused";
  run.pauseReason = "user-pause";
  run.pauseRequested = false;
  run.pauseRequestedAt = null;
  run.pauseRequestBaseRevision = null;
  run.pauseRequestRevision = null;
  await saveActiveRun(run, "pause");
  // The durable Pause is authoritative before the local runner is invalidated. This
  // preserves immediacy at a safe boundary without interrupting an ACK window.
  if (run.runId === activeRunnerRunId && run.executionSessionId === activeRunnerExecutionSessionId) {
    localRunnerToken += 1;
  }
  appendPostCommitDiagnostic("run_paused", { runId: run.runId, phase: run.phase, reason: run.pauseReason });
  return { ok: true };
}

async function stopCurrentRun(controlMessage = null) {
  const run = await getActiveRun({ authorityBoundary: "control" });
  const invalid = validateControlMessage(controlMessage, run);
  if (invalid) return invalid;
  if (!run) return { ok: true };
  const step = currentStep(run);
  if (step?.type === "wait-until") await clearAlarm(run, step);
  run.status = "stopped";
  run.phase = "stopped";
  run.pauseReason = "user-stop";
  run.pauseRequested = false;
  run.pauseRequestedAt = null;
  run.pauseRequestBaseRevision = null;
  run.pauseRequestRevision = null;
  run.waitState = null;
  await saveActiveRun(run, "stop");
  // Stop is terminal once its exact Run transition is durable. Diagnostic storage is
  // deliberately downstream so its failure cannot report or create a weaker Run state.
  appendPostCommitDiagnostic("run_stopped", { runId: run.runId, phase: run.phase, status: run.status });
  return { ok: true };
}

// sendPromptSafely durably commits phase="prepared" together with outbox.state="prepared"
// BEFORE it touches the composer, and durably commits phase="submitting" BEFORE the
// irreversible click. A durable snapshot that still reads prepared/prepared therefore
// proves the click has not happened. Every other unfinished outbox — including
// submitting/prepared, which straddles the click, and submitted — stays fail-closed.
function isProvablyUnclickedOutbox(run) {
  return run?.phase === "prepared" && run?.outbox?.state === "prepared";
}

// A Stop that landed first has already written a terminal state that background refuses to
// revive. Recovery must not fight that write, and must not turn it into a rejected promise.
function isStopWinsError(error) {
  return error?.code === "user_stop" || error?.code === "run_state_conflict";
}

async function pauseRunForRecovery(run, reason, phase) {
  try {
    await pauseRun(run, reason, phase);
  } catch (error) {
    if (!isStopWinsError(error)) throw error;
  }
}

async function failClosedStructurallyInvalidRun(run, error) {
  const code = error?.code;
  if (!["workflow_invalid", "schedule_invalid", "send_budget_invalid"].includes(code)) return false;
  run.lastErrorCode = code;
  run.lastErrorMessage = makeError(code).message;
  run.resumable = false;
  await pauseRun(run, "invalid-run", "invalid-run", "pause");
  return true;
}

async function recoverIfNeeded() {
  if (recoveryStarted) return;
  recoveryStarted = true;
  try {
    await recoverActiveRun();
  } catch (error) {
    if (["document_identity_unconfirmed", "document_identity_mismatch"].includes(error?.code) &&
        typeof error.runId === "string") {
      const stopped = await failClosedRunWithoutIdentity(error.runId, error.code);
      if (typeof recordDocumentIdentityFailureDiagnostic === "function") {
        recordDocumentIdentityFailureDiagnostic(error, stopped);
      }
      return;
    }
    // Stop takes priority over recovery. Rejecting here would poison initialRecoveryPromise,
    // the barrier AIPM_START awaits, and permanently block a fresh Start in this document.
    if (!isStopWinsError(error)) throw error;
  }
}

async function recoverActiveRun() {
  const run = await getActiveRun({ authorityBoundary: "recovery" });
  if (!run || run.provider !== ChatGptAdapter.id) return;
  if (["running", "paused"].includes(run.status)) {
    try {
      requireRuntimeCursorAuthority(run);
    } catch (error) {
      if (await failClosedStructurallyInvalidRun(run, error)) {
        renderStatusPill(run);
        return;
      }
      throw error;
    }
  }
  if (run.status !== "running") {
    renderStatusPill(run);
    return;
  }

  const actualKey = ChatGptAdapter.getConversationKey();
  const compatibleConversation = run.conversationKey === actualKey;
  if (!compatibleConversation) return;

  if (run.outbox && run.outbox.state !== "confirmed") {
    if (!isProvablyUnclickedOutbox(run)) {
      run.lastErrorCode = "recovery_ambiguous";
      run.lastErrorMessage = makeError("recovery_ambiguous").message;
      run.resumable = false;
      await pauseRunForRecovery(run, "recovery_ambiguous", "ambiguous");
      return;
    }
    const recoveryComposer = typeof ChatGptAdapter.findComposer === "function"
      ? ChatGptAdapter.findComposer()
      : null;
    const attachmentState = recoveryComposer && typeof ChatGptAdapter.getComposerAttachmentState === "function"
      ? ChatGptAdapter.getComposerAttachmentState(recoveryComposer)
      : null;
    if (attachmentState?.known === true && Number.isSafeInteger(attachmentState.count) && attachmentState.count > 0) {
      run.lastErrorCode = "unexpected_attachment";
      run.lastErrorMessage = makeError("unexpected_attachment").message;
      run.resumable = false;
      await pauseRunForRecovery(run, "unexpected_attachment", "attachment-blocked");
      return;
    }
    // Pre-submit checkpoint: discard the unsent preparation and retry the identical send
    // position. The cursor is deliberately left untouched, so this can neither duplicate a
    // send nor advance past one that never happened.
    run.outbox = null;
    run.phase = "ready";
    await saveActiveRun(run);
    appendPostCommitDiagnostic("recovery_pre_submit", {
      runId: run.runId,
      phase: run.phase,
      reason: "pre-submit-checkpoint"
    });
  }

  if (run.pauseRequested === true && !run.outbox) {
    run.lastErrorCode = null;
    run.lastErrorMessage = null;
    run.resumable = true;
    await pauseRunForRecovery(run, "user-pause", run.phase || "paused");
    return;
  }

  if (String(run.conversationKey).startsWith("chatgpt:new:")) {
    run.lastErrorCode = "new-chat-recovery";
    run.lastErrorMessage = "New Chat由来のRunは再読み込み後に自動再開できません。状態を確認して新しく開始してください。";
    run.resumable = false;
    await pauseRunForRecovery(run, "new-chat-recovery", "paused");
    return;
  }

  run.conversationKey = actualKey;
  localRunnerToken += 1;

  if (run.outbox?.state === "confirmed") {
    if (!(await confirmedOutboxMatchesCurrentPosition(run))) {
      run.lastErrorCode = "recovery_ambiguous";
      run.lastErrorMessage = makeError("recovery_ambiguous").message;
      run.resumable = false;
      await pauseRunForRecovery(run, "recovery_ambiguous", "ambiguous");
      return;
    }
    const lease = await acquireLease(actualKey, run.runId, run.executionSessionId, run.workflow?.recovery);
    if (!lease) {
      run.lastErrorCode = "lease_conflict";
      run.lastErrorMessage = makeError("lease_conflict").message;
      run.resumable = false;
      await pauseRunForRecovery(run, "lease_conflict", "ambiguous");
      return;
    }
    try {
      await waitForReadyStability(run, localRunnerToken, lease);
      const sentStep = currentStep(run);
      advanceCursor(run, true);
      run.outbox = null;
      const morePositionsRemain = run.cursor.stepIndex < run.workflow.steps.length || run.cursor.repeatIndex > 0;
      const fence = morePositionsRemain ? postSendDelayFence(run, sentStep) : null;
      run.waitState = fence;
      run.phase = fence ? "delay" : "ready";
      await saveActiveRun(run);
    } catch (error) {
      const code = error?.code ?? "generation_timeout";
      await releaseLease(lease, run.runId);
      if (isStopWinsError(error)) return;
      run.lastErrorCode = code;
      run.lastErrorMessage = error instanceof Error ? error.message : "Recovery failed";
      run.resumable = false;
      await pauseRunForRecovery(run, code, "ambiguous");
      return;
    }
    await releaseLease(lease, run.runId);
  }

  executeRun(run, localRunnerToken);
}

function displayDeliveredSendCount(run) {
  const stored = Number(run?.cursor?.sendsCompleted ?? 0);
  const completed = Number.isSafeInteger(stored) && stored >= 0 ? stored : 0;
  return completed + (run?.outbox?.state === "confirmed" ? 1 : 0);
}

function renderStatusPill(run) {
  let pill = document.getElementById(STATUS_PILL_ID);
  const visible = run && ["running", "paused"].includes(run.status);
  if (!visible) {
    pill?.remove();
    return;
  }

  if (!pill) {
    pill = document.createElement("div");
    pill.id = STATUS_PILL_ID;
    pill.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "font:12px/1.2 system-ui,sans-serif",
      "padding:8px 10px",
      "border-radius:999px",
      "background:#111",
      "color:#fff",
      "box-shadow:0 4px 18px rgba(0,0,0,.22)",
      "pointer-events:none"
    ].join(";");
    document.documentElement.appendChild(pill);
  }
  // Presentation only: cursor remains the durable budget/runtime authority.
  const completed = displayDeliveredSendCount(run);
  const total = Number(run.plannedSends ?? 0);
  pill.textContent = run.status === "paused" ? `AI Macro paused ${completed}/${total}` : `AI Macro ${completed}/${total}`;
}

function controlStateRevisionToken(value) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function validateControlMessage(message, run = undefined) {
  const contentVersion = globalThis.__AIPM_CONTENT_CORE__?.version ?? null;
  if (message?.serviceWorkerVersion !== contentVersion) {
    return { ok: false, error: "Service WorkerとContent Scriptのversionが一致しません。両方を再読み込みしてください。" };
  }
  if (typeof message?.executionSessionId !== "string" || !message.executionSessionId) {
    return { ok: false, error: "ブラウザセッションを確認できません。拡張機能を再読み込みしてください。" };
  }
  if (run?.executionSessionId && run.executionSessionId !== message.executionSessionId) {
    return { ok: false, error: "Runは別のブラウザセッションに紐づいています。" };
  }
  if (message?.expectedDocumentInstanceId != null && message.expectedDocumentInstanceId !== instanceId) {
    return { ok: false, error: "操作対象のdocumentが接続確認後に変わりました。" };
  }
  if (message?.expectedConversationKey != null && message.expectedConversationKey !== ChatGptAdapter.getConversationKey()) {
    return { ok: false, error: "操作対象の会話が接続確認後に変わりました。" };
  }
  if (run !== undefined && ["AIPM_PAUSE", "AIPM_RESUME", "AIPM_STOP"].includes(message?.type)) {
    if (typeof message?.expectedRunId !== "string" || !message.expectedRunId ||
        message.expectedRunId !== (run?.runId ?? null)) {
      return { ok: false, error: "操作対象のRunが接続確認後に変わりました。" };
    }
    if (!Object.prototype.hasOwnProperty.call(message, "expectedStateRevision")) {
      return { ok: false, error: "操作対象のRun revisionを確認できません。" };
    }
    const expectedRevision = controlStateRevisionToken(message.expectedStateRevision);
    const actualRevision = controlStateRevisionToken(run?.stateRevision);
    if (expectedRevision !== actualRevision) {
      return { ok: false, error: "操作対象のRun状態が接続確認後に変わりました。" };
    }
  } else if (run !== undefined && Object.prototype.hasOwnProperty.call(message ?? {}, "expectedRunId") &&
      message.expectedRunId !== (run?.runId ?? null)) {
    return { ok: false, error: "操作対象のRunが接続確認後に変わりました。" };
  }
  return null;
}

if (globalThis.__AIPM_CONTENT_CONTROLLER_READY__ !== true) {
  initialRecoveryPromise = recoverIfNeeded();
  initialRecoveryPromise.catch(() => {});

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    cancelActiveRunnerForControl(message);
    (async () => {
      switch (message?.type) {
        case "AIPM_ALARM_FIRED": {
          const run = await getActiveRun({ authorityBoundary: "control" });
          const invalid = validateControlMessage(message, run);
          if (invalid) return invalid;
          if (!run || run.runId !== message.runId) return { ok: false, error: "Alarmに対応するRunがありません。" };
          const key = alarmWakeKey(message.runId, message.stepId);
          const wake = alarmWakeResolvers.get(key);
          wake?.(message);
          return { ok: true };
        }
        case "AIPM_GET_STATUS": {
          const run = await getActiveRun({
            readOnlyObservation: message.readOnlyObservation === true,
            recovery: message.readOnlyRecovery ?? null,
            authorityBoundary: message.authorityBoundary ??
              (message.readOnlyObservation === true ? "periodic-observation" : "control")
          });
          const diagnostics = await chrome.storage.local.get(DIAGNOSTICS_KEY);
          const observation = typeof ChatGptAdapter.readPageObservation === "function"
            ? ChatGptAdapter.readPageObservation()
            : {
                composer: ChatGptAdapter.findComposer(),
                generationState: ChatGptAdapter.getGenerationState(),
                blocker: ChatGptAdapter.detectBlocker()
              };
          return {
            ok: true,
            provider: ChatGptAdapter.id,
            pageReady: ChatGptAdapter.matches() && Boolean(observation.composer),
            generationState: observation.generationState,
            blocker: observation.blocker,
            conversationKey: ChatGptAdapter.getConversationKey(),
            contentVersion: globalThis.__AIPM_CONTENT_CORE__?.version ?? null,
            instanceId,
            run,
            diagnostics: diagnostics[DIAGNOSTICS_KEY] ?? []
          };
        }
        case "AIPM_START": {
          await initialRecoveryPromise;
          const invalid = validateControlMessage(message);
          if (invalid) return invalid;
          return startRun(message.workflow, {
            bindingTabId: message.bindingTabId,
            keepAwake: message.keepAwake === true,
            executionSessionId: message.executionSessionId
          }, message);
        }
        case "AIPM_PAUSE":
        case "AIPM_RESUME":
        case "AIPM_STOP": {
          if (message.type === "AIPM_PAUSE") return pauseCurrentRun(message);
          if (message.type === "AIPM_RESUME") return resumeRun(message);
          return stopCurrentRun(message);
        }
        default:
          return { ok: false, error: "Unknown message." };
      }
    })().then(sendResponse).catch((error) => sendResponse(
      message?.type === "AIPM_GET_STATUS"
        ? statusObservationFailureResponse(error)
        : { ok: false, error: error instanceof Error ? error.message : String(error) }
    ));
    return true;
  });

  globalThis.__AIPM_CONTENT_CONTROLLER_READY__ = true;
}
