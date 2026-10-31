"use strict";

// This capability is deliberately document-local: no DOM evidence or prompt text is
// added to persisted Run state. Reinjecting the runner revokes even a pending grant.
if (typeof pausedPromptReceipt !== "undefined" && pausedPromptReceipt) {
  disposePausedPromptCandidate(pausedPromptReceipt);
}
var pausedPromptReceipt = null;
var pausedPromptReceiptEpoch = typeof pausedPromptReceiptEpoch === "number"
  ? pausedPromptReceiptEpoch + 1 : 1;
// Preserve an in-flight finalizer across reinjection just like the live runner.
var localPauseFinalization = typeof localPauseFinalization !== "undefined" ? localPauseFinalization : null;

function isLocalPauseFinalizing(run) {
  return !!localPauseFinalization && localPauseFinalization.runId === run?.runId &&
    localPauseFinalization.executionSessionId === run.executionSessionId;
}

function disposePausedPromptCandidate(candidate) {
  if (candidate && typeof ChatGptAdapter.disposePausedPromptText === "function") {
    ChatGptAdapter.disposePausedPromptText(candidate.domReceipt);
  }
}

function revokePausedPromptReceipt() {
  disposePausedPromptCandidate(pausedPromptReceipt);
  pausedPromptReceipt = null;
}

function pausedPromptRunMatches(candidate, run) {
  return !!candidate && candidate.epoch === pausedPromptReceiptEpoch &&
    candidate.runId === run?.runId && candidate.executionSessionId === run.executionSessionId &&
    candidate.conversationKey === run.conversationKey && candidate.documentInstanceId === instanceId &&
    candidate.workflow === JSON.stringify(run.workflow) && candidate.cursor === JSON.stringify(run.cursor);
}

function pausedPromptTextMatches(candidate, run, step) {
  return pausedPromptRunMatches(candidate, run) &&
    candidate.originalPrompt === step?.prompt &&
    typeof ChatGptAdapter.inspectPausedPromptText === "function" &&
    ChatGptAdapter.inspectPausedPromptText(candidate.domReceipt, candidate.expectedText, candidate.binding) === true;
}

function capturePausedPromptCandidate(transaction, binding, run, step) {
  if (typeof ChatGptAdapter.capturePausedPromptText !== "function") return null;
  const expectedText = typeof transaction?.expectedText === "string" ? transaction.expectedText : step.prompt;
  const domReceipt = ChatGptAdapter.capturePausedPromptText(transaction, expectedText, binding);
  if (!domReceipt) return null;
  return {
    domReceipt, binding, expectedText, originalPrompt: step.prompt,
    epoch: pausedPromptReceiptEpoch, runId: run.runId,
    executionSessionId: run.executionSessionId, conversationKey: run.conversationKey,
    documentInstanceId: instanceId, workflow: JSON.stringify(run.workflow), cursor: JSON.stringify(run.cursor)
  };
}

function armPausedPromptReceipt(candidate, run) {
  // A late Pause response cannot restore a Stop-revoked capability or clear one
  // belonging to a newer runner.
  if (!pausedPromptRunMatches(candidate, run) || candidate.binding.runnerToken !== localRunnerToken) {
    disposePausedPromptCandidate(candidate);
    return;
  }
  revokePausedPromptReceipt();
  if (canRetainPausedPromptInput(run) &&
      pausedPromptTextMatches(candidate, run, currentStep(run))) {
    candidate.pausedRevision = run.stateRevision;
    pausedPromptReceipt = candidate;
  } else {
    disposePausedPromptCandidate(candidate);
  }
}

// Only the explicit Resume controller calls this. Taking the capability consumes
// the slot before any persistence await, so concurrent Resume cannot reuse it.
function takePausedPromptReceipt(run) {
  const candidate = pausedPromptReceipt;
  pausedPromptReceipt = null;
  if (candidate && canRetainPausedPromptInput(run) && candidate.pausedRevision === run.stateRevision &&
      pausedPromptTextMatches(candidate, run, currentStep(run))) return candidate;
  disposePausedPromptCandidate(candidate);
  return null;
}

function canRetainPausedPromptInput(run) {
  return run?.status === "paused" && ((run.pauseReason === "user-pause" && !run.outbox) ||
    (run.phase === "prepared" && run.outbox?.state === "prepared" && run.resumable === true));
}

// Initial composer content is an in-memory, one-use capability. It is never copied
// into the workflow or restored after a reload, later iteration, or user edit.
var initialPromptAppend = null;
function revokeInitialPromptAppend() {
  if (initialPromptAppend?.plan) ChatGptAdapter.disposePromptAppend?.(initialPromptAppend.plan);
  initialPromptAppend = null;
}

async function captureInitialPromptAppend(run) {
  revokeInitialPromptAppend();
  const firstPrompt = run.workflow.steps.find((step) => step.type === "prompt");
  if (firstPrompt?.delivery !== "send" || typeof ChatGptAdapter.preparePromptAppend !== "function") return;
  const plan = ChatGptAdapter.preparePromptAppend(firstPrompt.prompt);
  if (plan) {
    initialPromptAppend = {
      plan, runId: run.runId, executionSessionId: run.executionSessionId,
      conversationKey: run.conversationKey, documentInstanceId: instanceId,
      stepId: firstPrompt.id, workflow: JSON.stringify(run.workflow)
    };
    // A hash-only obligation survives reload/Pause without storing the existing
    // input. Losing the local capability must never silently omit that input.
    run.initialInputRequirement = {
      stepId: firstPrompt.id,
      promptHash: await sha256(firstPrompt.prompt),
      inputHash: await sha256(plan.expectedText)
    };
  }
}

function initialAppendForPosition(run, step) {
  const receipt = initialPromptAppend;
  if (!receipt || receipt.runId !== run.runId) return null;
  if (receipt.executionSessionId !== run.executionSessionId || receipt.conversationKey !== run.conversationKey ||
      receipt.documentInstanceId !== instanceId || receipt.workflow !== JSON.stringify(run.workflow) ||
      run.cursor.sendsCompleted !== 0 || run.cursor.repeatIndex !== 0 || receipt.stepId !== step.id ||
      ChatGptAdapter.inspectPromptAppend?.(receipt.plan) !== true) throw makeError("draft_present");
  return receipt.plan;
}

var MAX_WORKFLOW_STEPS = 40;
var MAX_WAIT_DURATION_MS = 24 * 60 * 60 * 1000;
var MAX_POST_SEND_DELAY_MS = 5 * 60 * 1000;
var PROMPT_DELIVERY_SETTLEMENT_MAX_MS = Number.isFinite(PROMPT_DELIVERY_SETTLEMENT_MAX_MS)
  ? PROMPT_DELIVERY_SETTLEMENT_MAX_MS
  : 30_000;
var PROMPT_DELIVERY_TEXT_STABLE_MS = Number.isFinite(PROMPT_DELIVERY_TEXT_STABLE_MS)
  ? PROMPT_DELIVERY_TEXT_STABLE_MS
  : 650;
var PROMPT_DELIVERY_ATTACHMENT_STABLE_MS = Number.isFinite(PROMPT_DELIVERY_ATTACHMENT_STABLE_MS)
  ? PROMPT_DELIVERY_ATTACHMENT_STABLE_MS
  : 160;
var PROMPT_DELIVERY_SETTLEMENT_POLL_MS = Number.isFinite(PROMPT_DELIVERY_SETTLEMENT_POLL_MS)
  ? PROMPT_DELIVERY_SETTLEMENT_POLL_MS
  : 50;
var PROMPT_DELIVERY_PENDING_POLL_MS = Number.isFinite(PROMPT_DELIVERY_PENDING_POLL_MS)
  ? PROMPT_DELIVERY_PENDING_POLL_MS
  : 250;

function normalizeRuntimeRecoveryPolicy(value) {
  const mode = value?.mode === "completion" ? "completion" : "safe";
  if (mode === "safe") {
    return { mode: "safe", identityAttempts: 3, readiness: "normal", statusRecovery: "normal" };
  }
  const identityAttempts = [3, 5, 10].includes(Number(value?.identityAttempts))
    ? Number(value.identityAttempts)
    : 5;
  return {
    mode,
    identityAttempts,
    readiness: value?.readiness === "normal" ? "normal" : "long",
    statusRecovery: value?.statusRecovery === "normal" ? "normal" : "persistent"
  };
}

function readinessTimeoutForRun(run) {
  return normalizeRuntimeRecoveryPolicy(run?.workflow?.recovery).readiness === "long"
    ? 60 * 60 * 1000
    : GENERATION_TIMEOUT_MS;
}

function requireRuntimeWorkflowSteps(workflow) {
  const steps = workflow?.steps;
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_WORKFLOW_STEPS) {
    throw makeError("workflow_invalid", { field: "steps.length" });
  }
  return steps;
}

// The content script is the final execution boundary. Do not clamp malformed values here:
// JavaScript comparisons against NaN are false and could otherwise disable every ceiling.
function requireRuntimeInteger(value, field, min, max) {
  const supportedType = typeof value === "number" || typeof value === "string";
  const emptyString = typeof value === "string" && value.trim() === "";
  const parsed = supportedType && !emptyString ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw makeError("send_budget_invalid", { field });
  }
  return parsed;
}

function requireRuntimeDuration(value, field, max) {
  const supportedType = typeof value === "number" || typeof value === "string";
  const emptyString = typeof value === "string" && value.trim() === "";
  const parsed = supportedType && !emptyString ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    throw makeError("workflow_invalid", { field });
  }
  return parsed;
}

function requireUniqueRuntimeStepIds(steps) {
  const seen = new Set();
  for (let index = 0; index < steps.length; index += 1) {
    const id = steps[index]?.id;
    if (typeof id !== "string" || !id || seen.has(id)) {
      throw makeError("workflow_invalid", { field: `steps[${index}].id` });
    }
    seen.add(id);
  }
}

function requireRuntimeWorkflowAuthority(workflow) {
  normalizeRuntimeRecoveryPolicy(workflow?.recovery);
  const steps = requireRuntimeWorkflowSteps(workflow);
  requireUniqueRuntimeStepIds(steps);
  const allowedTypes = new Set(["prompt", "delay", "wait-until", "checkpoint"]);
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!allowedTypes.has(step?.type)) throw makeError("workflow_invalid", { field: `steps[${index}].type` });
    if (step.type === "delay") {
      requireRuntimeDuration(step.durationMs, `steps[${index}].durationMs`, MAX_WAIT_DURATION_MS);
    } else if (step.type === "wait-until") {
      if (!Number.isFinite(Date.parse(String(step.at ?? ""))) ||
          !["pause", "run", "skip"].includes(step.latePolicy)) {
        throw makeError("schedule_invalid", { field: `steps[${index}]` });
      }
      requireRuntimeDuration(step.graceMs, `steps[${index}].graceMs`, MAX_WAIT_DURATION_MS);
    } else if (step.type === "prompt") {
      if (!['send', 'draft'].includes(step.delivery) || typeof step.prompt !== "string" || !step.prompt.trim()) {
        throw makeError("workflow_invalid", { field: `steps[${index}]` });
      }
      if (step.delivery === "send") {
        requireRuntimeDuration(step.delayAfterMs, `steps[${index}].delayAfterMs`, MAX_POST_SEND_DELAY_MS);
      }
    }
  }
  return steps;
}

function countRuntimePlannedSends(steps) {
  let plannedSends = 0;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step?.type !== "prompt" || step?.delivery === "draft") continue;
    const repeat = requireRuntimeInteger(step.repeat, `steps[${index}].repeat`, 1, MAX_SENDS_PER_RUN);
    if (plannedSends > MAX_SENDS_PER_RUN - repeat) {
      throw makeError("send_budget_invalid", { field: "plannedSends" });
    }
    plannedSends += repeat;
  }
  return plannedSends;
}

function requireRuntimeCursorAuthority(run) {
  const steps = requireRuntimeWorkflowAuthority(run?.workflow);
  const plannedSends = countRuntimePlannedSends(steps);
  const maxSends = requireRuntimeInteger(run?.workflow?.maxSends, "maxSends", 1, MAX_SENDS_PER_RUN);
  if (plannedSends > maxSends) throw makeError("send_budget_invalid", { field: "maxSends" });

  // steps.length is a valid crash-recovery boundary: the final cursor commit may be
  // durable while the subsequent terminal completed commit has not landed yet.
  const stepIndex = requireRuntimeInteger(run?.cursor?.stepIndex, "cursor.stepIndex", 0, steps.length);
  const sendsCompleted = requireRuntimeInteger(
    run?.cursor?.sendsCompleted,
    "cursor.sendsCompleted",
    0,
    MAX_SENDS_PER_RUN
  );

  let sendsBeforeCurrent = 0;
  for (let index = 0; index < stepIndex; index += 1) {
    const step = steps[index];
    if (step.type === "prompt" && step.delivery === "send") {
      sendsBeforeCurrent += requireRuntimeInteger(
        step.repeat,
        `steps[${index}].repeat`,
        1,
        MAX_SENDS_PER_RUN
      );
    }
  }

  let repeatIndex = 0;
  if (stepIndex === steps.length) {
    repeatIndex = requireRuntimeInteger(run?.cursor?.repeatIndex, "cursor.repeatIndex", 0, 0);
  } else {
    const current = steps[stepIndex];
    const repeat = current.type === "prompt" && current.delivery === "send"
      ? requireRuntimeInteger(current.repeat, `steps[${stepIndex}].repeat`, 1, MAX_SENDS_PER_RUN)
      : 1;
    repeatIndex = requireRuntimeInteger(run?.cursor?.repeatIndex, "cursor.repeatIndex", 0, repeat - 1);
    if (current.type === "prompt" && current.delivery === "send") {
      sendsBeforeCurrent += repeatIndex;
    } else if (repeatIndex !== 0) {
      throw makeError("send_budget_invalid", { field: "cursor.repeatIndex" });
    }
  }

  if (sendsCompleted !== sendsBeforeCurrent) {
    throw makeError("send_budget_invalid", { field: "cursor.sendsCompleted" });
  }
  return { steps, plannedSends, maxSends, stepIndex, repeatIndex, sendsCompleted };
}

function assertSendBudgetAvailable(run, step, expectedPosition = null) {
  const steps = requireRuntimeWorkflowSteps(run?.workflow);
  const stepIndex = requireRuntimeInteger(run?.cursor?.stepIndex, "cursor.stepIndex", 0, steps.length - 1);
  const current = steps[stepIndex];
  if (current?.type !== "prompt" || current?.delivery !== "send" ||
      typeof current.id !== "string" || !current.id ||
      typeof current.prompt !== "string" || !current.prompt.trim() ||
      step?.type !== current.type || step?.delivery !== current.delivery ||
      step?.id !== current.id || step?.prompt !== current.prompt) {
    throw makeError("workflow_invalid", { field: "workflow.steps" });
  }

  // Recompute the plan from the durable workflow; plannedSends is display metadata, not authority.
  const plannedSends = countRuntimePlannedSends(steps);
  const maxSends = requireRuntimeInteger(run.workflow.maxSends, "maxSends", 1, MAX_SENDS_PER_RUN);
  const sendsCompleted = requireRuntimeInteger(
    run?.cursor?.sendsCompleted,
    "cursor.sendsCompleted",
    0,
    MAX_SENDS_PER_RUN
  );
  const repeat = requireRuntimeInteger(current.repeat, "currentStep.repeat", 1, MAX_SENDS_PER_RUN);
  const suppliedRepeat = requireRuntimeInteger(step.repeat, "suppliedStep.repeat", 1, MAX_SENDS_PER_RUN);
  const repeatIndex = requireRuntimeInteger(run?.cursor?.repeatIndex, "cursor.repeatIndex", 0, repeat - 1);
  if (suppliedRepeat !== repeat) throw makeError("workflow_invalid", { field: "currentStep.repeat" });

  const position = {
    stepIndex,
    repeatIndex,
    sendsCompleted,
    stepId: current.id,
    prompt: current.prompt,
    repeat,
    // Bind the irreversible click to the complete executable workflow that was
    // approved at send entry. A future-step mutation must not expand or replace
    // the Run while persistence/control/lease awaits are in flight.
    workflowSnapshot: JSON.stringify({ maxSends, steps })
  };
  if (expectedPosition && (
    expectedPosition.stepIndex !== position.stepIndex ||
    expectedPosition.repeatIndex !== position.repeatIndex ||
    expectedPosition.sendsCompleted !== position.sendsCompleted ||
    expectedPosition.stepId !== position.stepId ||
    expectedPosition.prompt !== position.prompt ||
    expectedPosition.repeat !== position.repeat ||
    expectedPosition.workflowSnapshot !== position.workflowSnapshot
  )) {
    throw makeError("workflow_invalid", { field: "cursor.stepIndex" });
  }

  if (plannedSends > maxSends) throw makeError("send_budget_invalid", { field: "maxSends" });
  if (sendsCompleted >= maxSends || sendsCompleted >= MAX_SENDS_PER_RUN) throw makeError("max_sends");
  return position;
}

async function confirmedOutboxMatchesCurrentPosition(run) {
  return outboxMatchesCurrentPosition(run, "confirmed");
}

async function outboxMatchesCurrentPosition(run, state) {
  try {
    if (!run?.outbox || run.outbox.state !== state) return false;
    requireRuntimeCursorAuthority(run);
    const step = currentStep(run);
    const expectedPosition = assertSendBudgetAvailable(run, step);
    const storedPosition = run.outbox.position;
    if (!storedPosition ||
        storedPosition.stepIndex !== expectedPosition.stepIndex ||
        storedPosition.repeatIndex !== expectedPosition.repeatIndex ||
        storedPosition.sendsCompleted !== expectedPosition.sendsCompleted ||
        run.outbox.stepId !== expectedPosition.stepId) {
      return false;
    }
    const promptMatches = run.outbox.promptHash === await sha256(expectedPosition.prompt);
    const requirement = run.initialInputRequirement;
    return promptMatches && (!requirement || (requirement.stepId === expectedPosition.stepId &&
      requirement.promptHash === run.outbox.promptHash && requirement.inputHash === run.outbox.inputHash));
  } catch {
    return false;
  }
}

function normalizeWorkflow(workflow) {
  if (Number(workflow?.schemaVersion) !== SCHEMA_VERSION) throw new Error("Unsupported workflow schema.");
  const sourceSteps = requireRuntimeWorkflowSteps(workflow);

  const allowedTypes = new Set(["prompt", "delay", "wait-until", "checkpoint"]);
  const steps = sourceSteps.map((step, index) => {
    const type = allowedTypes.has(step?.type) ? step.type : "prompt";
    const id = String(step?.id || `block-${index + 1}`);

    if (type === "checkpoint") {
      return { id, type, label: String(step?.label || "Manual checkpoint") };
    }
    if (type === "delay") {
      return {
        id,
        type,
        durationMs: requireRuntimeDuration(
          step?.durationMs === undefined ? 5000 : step.durationMs,
          `steps[${index}].durationMs`,
          MAX_WAIT_DURATION_MS
        )
      };
    }
    if (type === "wait-until") {
      const timestamp = Date.parse(String(step?.at ?? ""));
      if (!Number.isFinite(timestamp)) throw makeError("schedule_invalid");
      return {
        id,
        type,
        at: new Date(timestamp).toISOString(),
        latePolicy: ["pause", "run", "skip"].includes(step?.latePolicy) ? step.latePolicy : "pause",
        graceMs: requireRuntimeDuration(
          step?.graceMs === undefined ? 5 * 60 * 1000 : step.graceMs,
          `steps[${index}].graceMs`,
          MAX_WAIT_DURATION_MS
        )
      };
    }

    const delivery = step?.delivery === "draft" ? "draft" : "send";
    const text = String(step?.prompt ?? "").trim();
    if (!text) throw new Error(`Block ${index + 1} has no prompt.`);
    return {
      id,
      type: "prompt",
      delivery,
      prompt: text,
      repeat: delivery === "draft"
        ? 1
        : requireRuntimeInteger(step?.repeat === undefined ? 1 : step.repeat, `steps[${index}].repeat`, 1, MAX_SENDS_PER_RUN),
      delayAfterMs: delivery === "draft"
        ? 0
        : requireRuntimeDuration(
          step?.delayAfterMs === undefined ? 0 : step.delayAfterMs,
          `steps[${index}].delayAfterMs`,
          MAX_POST_SEND_DELAY_MS
        )
    };
  });

  requireUniqueRuntimeStepIds(steps);
  const plannedSends = countRuntimePlannedSends(steps);
  const maxSends = requireRuntimeInteger(
    workflow.maxSends === undefined ? Math.max(1, plannedSends) : workflow.maxSends,
    "maxSends",
    1,
    MAX_SENDS_PER_RUN
  );
  if (plannedSends > maxSends) throw makeError("send_budget_invalid", { field: "maxSends" });
  return {
    ...workflow,
    recovery: normalizeRuntimeRecoveryPolicy(workflow?.recovery),
    steps,
    maxSends,
    plannedSends
  };
}

function currentStep(run) {
  return run.workflow.steps[run.cursor.stepIndex] ?? null;
}

function advanceCursor(run, wasSend) {
  const step = currentStep(run);
  if (!step) return;
  if (wasSend && run.initialInputRequirement?.stepId === step.id) {
    delete run.initialInputRequirement;
    revokeInitialPromptAppend();
  }
  const repeatableSend = step.type === "prompt" && step.delivery !== "draft";
  if (repeatableSend && run.cursor.repeatIndex + 1 < Math.max(1, Number(step.repeat ?? 1))) {
    run.cursor.repeatIndex += 1;
    if (wasSend) run.cursor.sendsCompleted += 1;
    return;
  }
  if (wasSend) run.cursor.sendsCompleted += 1;
  run.cursor.stepIndex += 1;
  run.cursor.repeatIndex = 0;
}

async function pauseRun(run, reason, phase = "paused", runTransition = "runner") {
  run.status = "paused";
  run.phase = phase;
  run.pauseReason = reason;
  run.pauseRequested = false;
  run.pauseRequestedAt = null;
  run.pauseRequestBaseRevision = null;
  run.pauseRequestRevision = null;
  await saveActiveRun(run, runTransition);
  // The durable Pause is authoritative. Losing its diagnostic must not make the caller
  // re-enter error handling and attempt a second, potentially weaker transition.
  appendPostCommitDiagnostic("run_paused", { runId: run.runId, phase, reason, status: run.status });
}

async function renewLeaseHeartbeat(lease, runId, heartbeat) {
  if (!lease || Date.now() < heartbeat.nextRenewAt) return;
  if (!(await renewLease(lease, runId))) throw makeError("lease_conflict");
  heartbeat.nextRenewAt = Date.now() + LEASE_HEARTBEAT_MS;
}

function readCurrentPageObservation() {
  if (typeof ChatGptAdapter.readPageObservation === "function") {
    return ChatGptAdapter.readPageObservation();
  }
  const composer = typeof ChatGptAdapter.findComposer === "function"
    ? ChatGptAdapter.findComposer()
    : null;
  return {
    composer,
    stopButton: typeof ChatGptAdapter.findStopButton === "function"
      ? ChatGptAdapter.findStopButton()
      : null,
    blocker: ChatGptAdapter.detectBlocker(),
    generationState: ChatGptAdapter.getGenerationState()
  };
}

function runObservationIntervalMs() {
  return typeof RUN_OBSERVATION_INTERVAL_MS === "number"
    ? RUN_OBSERVATION_INTERVAL_MS
    : Math.max(1_200, Number(POLL_MS) || 0);
}

function requireObservedRunCanContinue(run, latest) {
  if (!latest || latest.runId !== run.runId || latest.status === "stopped") {
    throw makeError("user_stop");
  }
}

async function observeRunCanContinue(run, token, observation, { deferPause = false } = {}) {
  if (typeof getActiveRun !== "function") {
    await assertRunCanContinue(run, token);
    observation.nextCheckAt = Date.now() + runObservationIntervalMs();
    return;
  }
  assertLocalRunnerToken(token);
  assertConversationStillMatches(run);
  if (Date.now() < observation.nextCheckAt) return;
  const latest = await getActiveRun({
    readOnlyObservation: true,
    recovery: run.workflow?.recovery,
    authorityBoundary: "readiness"
  });
  assertLocalRunnerToken(token);
  requireObservedRunCanContinue(run, latest);
  if (latest.status === "paused" || latest.pauseRequested === true) {
    await assertRunCanContinue(run, token, { deferPause });
  }
  observation.nextCheckAt = Date.now() + runObservationIntervalMs();
}

async function waitUntilReady(run, token, timeoutMs = GENERATION_TIMEOUT_MS, lease = null) {
  const startedAt = Date.now();
  const heartbeat = { nextRenewAt: 0 };
  const runObservation = { nextCheckAt: 0 };
  while (Date.now() - startedAt < timeoutMs) {
    await observeRunCanContinue(run, token, runObservation);
    await renewLeaseHeartbeat(lease, run.runId, heartbeat);
    const page = readCurrentPageObservation();
    if (page.blocker) throw blockerToError(page.blocker);
    if (page.generationState === "idle") return;
    await sleep(POLL_MS);
  }
  throw makeError("composer_not_ready");
}

function assertConversationStillMatches(run) {
  if (!isConversationTransitionAllowed(run, ChatGptAdapter.getConversationKey())) {
    throw makeError("conversation_changed");
  }
}

function isRunErrorResumable(run, code) {
  const nonResumable = new Set([
    "submission_ambiguous",
    "recovery_ambiguous",
    "composer_verification_failed",
    "composer_user_interaction",
    "unexpected_attachment",
    "composer_attachment_unconfirmed",
    "paste_attachment_unverified",
    "paste_attachment_provenance_lost",
    "paste_attachment_unrecognized",
    "paste_attachment_settlement_timeout",
    "lease_conflict",
    "conversation_changed",
    "document_identity_unconfirmed",
    "document_identity_mismatch",
    "workflow_invalid",
    "schedule_invalid",
    "send_budget_invalid",
    "max_sends"
  ]);
  const deliveryAlreadyStarted = ["submitted", "confirmed"].includes(run?.outbox?.state) ||
    ["submitting", "waiting-ack", "new-chat-confirmation-required"].includes(run?.phase);
  return !nonResumable.has(code) && !deliveryAlreadyStarted;
}

function canResumeConfirmedObservation(run, code) {
  return run?.outbox?.state === "confirmed" && [
    "generation_timeout", "composer_not_ready", "ui_blocked", "captcha",
    "login_required", "usage_limit", "service_error"
  ].includes(code);
}

function assertComposerHasNoAttachments(composer) {
  if (typeof ChatGptAdapter.getComposerAttachmentState !== "function") {
    throw makeError("composer_attachment_unconfirmed");
  }
  const state = ChatGptAdapter.getComposerAttachmentState(composer);
  if (state?.known !== true || !Number.isSafeInteger(state.count) || state.count < 0 ||
      (Number.isSafeInteger(state.hiddenCount) && state.hiddenCount > 0)) {
    throw makeError("composer_attachment_unconfirmed");
  }
  if (state.count !== 0) throw makeError("unexpected_attachment");
  return state;
}

function assertLocalRunnerToken(token) {
  if (token !== localRunnerToken) throw makeError("user_stop");
}

function createPromptDeliveryBinding(run, step, expectedPosition, promptHash, token) {
  return Object.freeze({
    deliveryAttemptToken: run.outbox?.id ?? null,
    runId: run.runId,
    executionSessionId: run.executionSessionId,
    stateRevision: Number(run.stateRevision),
    stepId: step.id,
    stepIndex: expectedPosition.stepIndex,
    repeatIndex: expectedPosition.repeatIndex,
    sendsCompleted: expectedPosition.sendsCompleted,
    promptHash,
    inputHash: run.outbox?.inputHash ?? promptHash,
    documentInstanceId: instanceId,
    conversationKey: ChatGptAdapter.getConversationKey(),
    runnerToken: token
  });
}

function assertPromptDeliveryRunBinding(run, step, expectedPosition, promptHash, token, binding) {
  assertLocalRunnerToken(token);
  assertConversationStillMatches(run);
  assertSendBudgetAvailable(run, step, expectedPosition);
  if (!binding || binding.deliveryAttemptToken !== run.outbox?.id ||
      binding.runId !== run.runId || binding.executionSessionId !== run.executionSessionId ||
      binding.stepId !== step.id || binding.stepIndex !== run.cursor.stepIndex ||
      binding.repeatIndex !== run.cursor.repeatIndex || binding.sendsCompleted !== run.cursor.sendsCompleted ||
      binding.promptHash !== promptHash || binding.inputHash !== (run.outbox?.inputHash ?? promptHash) ||
      binding.documentInstanceId !== instanceId ||
      binding.conversationKey !== ChatGptAdapter.getConversationKey() || binding.runnerToken !== token) {
    throw makeError("run_state_conflict");
  }
}

function requirePromptDeliveryState(transaction, step, binding, expectedMode = null, options = {}) {
  if (typeof ChatGptAdapter.inspectPromptDelivery !== "function") {
    throw makeError("paste_attachment_provenance_lost");
  }
  const expectedText = typeof transaction?.expectedText === "string" ? transaction.expectedText : step.prompt;
  const state = ChatGptAdapter.inspectPromptDelivery(transaction, expectedText, binding, expectedMode, options);
  // The adapter owns scoped lifecycle checks: clean attachment baseline, the same
  // composer/binding, one recognized candidate, no trusted interference and ready
  // Send. This is conditional lifecycle evidence, not a claim about file bytes.
  if (state?.ok === true && ["text", "paste-attachment"].includes(state.mode)) return state;
  if (state?.reason === "user-interaction") throw makeError("composer_user_interaction");
  if (String(state?.reason ?? "").includes("attachment") ||
      ["user-interaction", "delivery-mode-changed", "composer-replaced",
        "transaction-invalid"].includes(state?.reason)) {
    throw makeError("paste_attachment_provenance_lost", { attachmentSettlement: state?.diagnostic ?? null });
  }
  throw makeError("composer_verification_failed");
}

function promptDeliverySettlementError(state, transaction) {
  const diagnostic = state?.diagnostic ?? {
    outcome: "timeout",
    deadlineMs: PROMPT_DELIVERY_SETTLEMENT_MAX_MS,
    lastState: "unknown",
    candidatesSeen: 0,
    replacements: 0,
    replacementCount: 0,
    composerTextState: "unknown",
    scopeKind: "unknown",
    elapsedMs: PROMPT_DELIVERY_SETTLEMENT_MAX_MS,
    mutations: 0,
    mutationCount: 0,
    candidateCount: 0,
    logicalAttachmentCount: 0,
    maxLogicalCandidates: 0,
    maxLogicalAttachmentCount: 0,
    headerCandidateCount: 0,
    composerDepth: 0,
    surfaceDepth: 0,
    userEpochChanged: false,
    sendActionable: false,
    stableDurationMs: 0,
    fileTileFallbackSeen: false,
    fileTileFallbackCount: 0,
    derivedRemoveSemanticCount: 0,
    fallbackAccepted: false,
    fallbackRejectReason: "no-file-tile"
  };
  const reason = String(state?.reason ?? "");
  if (reason === "user-interaction") return makeError("composer_user_interaction");
  if (["user-interaction", "extra-attachment", "delivery-mode-changed",
    "composer-replaced", "transaction-invalid"].includes(reason) ||
      reason.includes("provenance")) {
    return makeError("paste_attachment_provenance_lost", { attachmentSettlement: diagnostic });
  }
  if (reason === "attachment-unconfirmed") {
    return makeError("paste_attachment_unrecognized", { attachmentSettlement: diagnostic });
  }
  return makeError("paste_attachment_settlement_timeout", { attachmentSettlement: diagnostic });
}

async function waitForPromptDeliverySettlement(run, token, transaction, step, binding, expectedPosition, promptHash, lease = null) {
  const startedAt = Date.now();
  let nextAuthorityAt = startedAt + POLL_MS;
  let lastState = null;
  let waitingForTextSend = false;
  const heartbeat = { nextRenewAt: 0 };
  while (Date.now() - startedAt <= PROMPT_DELIVERY_SETTLEMENT_MAX_MS) {
    waitingForTextSend = false;
    assertPromptDeliveryRunBinding(run, step, expectedPosition, promptHash, token, binding);
    lastState = ChatGptAdapter.inspectPromptDelivery(
      transaction,
      typeof transaction?.expectedText === "string" ? transaction.expectedText : step.prompt,
      binding,
      null,
      { settling: true }
    );
    if (lastState?.ok === true && ["text", "paste-attachment"].includes(lastState.mode)) {
      const requiredStableMs = lastState.mode === "text"
        ? PROMPT_DELIVERY_TEXT_STABLE_MS
        : PROMPT_DELIVERY_ATTACHMENT_STABLE_MS;
      const observedStableMs = Number.isFinite(Number(lastState.stableMs))
        ? Number(lastState.stableMs)
        : requiredStableMs;
      if (observedStableMs >= requiredStableMs) {
        // Text can settle before the page enables Send. Keep the same owned
        // transaction alive within the existing settlement deadline; no click has
        // occurred, and the final synchronous Send guards still run afterwards.
        const sendButton = lastState.mode === "text" ? ChatGptAdapter.findSendButton() : null;
        waitingForTextSend = lastState.mode === "text" && (
          !sendButton || sendButton.disabled || sendButton.getAttribute("aria-disabled") === "true"
        );
        if (!waitingForTextSend) {
          return requirePromptDeliveryState(transaction, step, binding, lastState.mode, { lock: true });
        }
        const blocker = ChatGptAdapter.detectBlocker();
        if (blocker) throw blockerToError(blocker);
        await renewLeaseHeartbeat(lease, run.runId, heartbeat);
      }
    } else if (lastState?.reason === "text-mismatch") {
      throw makeError("composer_verification_failed");
    } else if (["user-interaction", "extra-attachment", "attachment-provenance-lost",
      "delivery-mode-changed", "attachment-unconfirmed",
      "composer-replaced", "transaction-invalid"].includes(lastState?.reason)) {
      throw promptDeliverySettlementError(lastState, transaction);
    }
    if (Date.now() >= nextAuthorityAt) {
      await assertRunCanContinue(run, token, { authorityBoundary: "send-preflight" });
      assertPromptDeliveryRunBinding(run, step, expectedPosition, promptHash, token, binding);
      nextAuthorityAt = Date.now() + POLL_MS;
    }
    const pollMs = lastState?.diagnostic?.lastState === "attachment-pending"
      ? PROMPT_DELIVERY_PENDING_POLL_MS
      : PROMPT_DELIVERY_SETTLEMENT_POLL_MS;
    await sleep(pollMs);
  }
  if (waitingForTextSend) {
    throw makeError("send_unavailable", {
      textSendReadiness: {
        elapsedMs: Math.min(PROMPT_DELIVERY_SETTLEMENT_MAX_MS, Math.max(0, Date.now() - startedAt)),
        deadlineMs: PROMPT_DELIVERY_SETTLEMENT_MAX_MS
      }
    });
  }
  throw promptDeliverySettlementError(lastState, transaction);
}

function sameJsonAuthorityValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameJsonAuthorityValue(value, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] &&
    sameJsonAuthorityValue(left[key], right[key]));
}

function sameRunWorkflowAndCursorAuthority(run, latest) {
  const exactFields = [
    "runId",
    "provider",
    "contentVersion",
    "executionSessionId",
    "boundTabId",
    "boundDocumentId",
    "documentInstanceId",
    "conversationKey",
    "status",
    "phase"
  ];
  if (!exactFields.every((field) => sameJsonAuthorityValue(latest?.[field] ?? null, run?.[field] ?? null))) {
    return false;
  }
  if (Number(latest?.plannedSends) !== Number(run?.plannedSends)) return false;
  if (!sameJsonAuthorityValue(latest?.cursor ?? null, run?.cursor ?? null)) return false;
  if (!sameJsonAuthorityValue(latest?.workflow ?? null, run?.workflow ?? null)) return false;
  if (!sameJsonAuthorityValue(latest?.outbox ?? null, run?.outbox ?? null)) return false;
  if (!sameJsonAuthorityValue(latest?.initialInputRequirement ?? null, run?.initialInputRequirement ?? null)) return false;
  return sameJsonAuthorityValue(latest?.waitState ?? null, run?.waitState ?? null);
}

async function failClosedRunWithoutIdentity(runOrId = null, reason = null, identityFailure = null) {
  const identityReason = ["document_identity_unconfirmed", "document_identity_mismatch"].includes(reason);
  const runId = typeof runOrId === "string" ? runOrId : runOrId?.runId;
  const guard = identityReason
    ? identityFailure?.identityFailClosedGuard
    : (runOrId && typeof runOrId === "object" ? runFailClosedGuards.get(runOrId)?.guard : null);
  // Refusals must retain their own authority. Never substitute a cached/newer Run
  // after a handled/stale reply or an identity failure with no issued capability.
  if (identityFailure?.identityFailClosedHandled === true ||
      !guard || typeof guard.token !== "string" || guard.token.length === 0) return null;
  const response = await chrome.runtime.sendMessage({
    type: "AIPM_RUN_FAIL_CLOSED",
    expectedRunId: typeof runId === "string" ? runId : null,
    reason: identityReason ? reason : null,
    failClosedGuard: guard,
    documentInstanceId: instanceId,
    serviceWorkerVersion: globalThis.__AIPM_CONTENT_CORE__?.version ?? null
  });
  if (!response?.ok) {
    const error = new Error(response?.error ?? "Run could not be durably stopped.");
    error.code = "run_state_save_failed";
    throw error;
  }
  return response.run ?? null;
}

async function requireNewChatConfirmation(run) {
  const response = await chrome.runtime.sendMessage({
    type: "AIPM_RUN_NEW_CHAT_CONFIRM_REQUIRED",
    expectedRunId: run.runId,
    serviceWorkerVersion: globalThis.__AIPM_CONTENT_CORE__?.version ?? null,
    executionSessionId: run.executionSessionId
  });
  if (!response?.ok || response.run?.status !== "paused" ||
      response.run?.pauseReason !== "new-chat-confirmation-required") {
    await failClosedRunWithoutIdentity(run).catch(() => {});
    const error = new Error(response?.error ?? "New Chat confirmation state could not be saved.");
    error.code = "run_state_save_failed";
    throw error;
  }
  Object.assign(run, response.run);
  appendPostCommitDiagnostic("new_chat_confirmation_required", {
    runId: run.runId,
    phase: run.phase,
    reason: run.pauseReason,
    status: run.status
  });
  throw makeError("user_stop");
}

async function assertRunCanContinue(
  run,
  token,
  { deferPause = false, authorityBoundary = "run-read" } = {}
) {
  assertLocalRunnerToken(token);
  assertConversationStillMatches(run);
  const latest = await getActiveRun({
    readOnlyObservation: true,
    recovery: run.workflow?.recovery,
    authorityBoundary
  });
  assertLocalRunnerToken(token);
  if (!latest || latest.runId !== run.runId || latest.status === "stopped") throw makeError("user_stop");
  if (latest.status === "paused") {
    while (true) {
      await sleep(runObservationIntervalMs());
      assertLocalRunnerToken(token);
      assertConversationStillMatches(run);
      const refreshed = await getActiveRun({
        readOnlyObservation: true,
        recovery: run.workflow?.recovery,
        authorityBoundary: "readiness"
      });
      assertLocalRunnerToken(token);
      requireObservedRunCanContinue(run, refreshed);
      if (refreshed.status === "running") {
        // A shared observation may wake the runner, but cannot authorize its next
        // mutation. Re-read the exact Run through the fresh authority path first.
        const authoritative = await getActiveRun({
          readOnlyObservation: true,
          recovery: run.workflow?.recovery,
          authorityBoundary: "run-read"
        });
        assertLocalRunnerToken(token);
        requireObservedRunCanContinue(run, authoritative);
        if (authoritative.status !== "running") continue;
        Object.assign(run, authoritative);
        inheritRunFailClosedGuard(run, authoritative);
        return;
      }
    }
  }
  // A recovery episode may have waited across other durable activity. Only that path needs
  // an additional exact snapshot fence here; ordinary reads keep the established submitting
  // transaction semantics in which its committed state authorizes the single pending click.
  const recoveredIdentity = typeof wasIdentityRecoveredRunRead === "function" &&
    wasIdentityRecoveredRunRead(latest);
  if (recoveredIdentity && !sameRunWorkflowAndCursorAuthority(run, latest)) {
    throw makeError("run_state_conflict");
  }
  if (latest.pauseRequested === true) {
    // Import only the control fence and its revision. The runner's unsaved workflow,
    // cursor, outbox, and phase remain its own mutation state and must not be rolled back
    // by an observation snapshot.
    run.stateRevision = latest.stateRevision;
    run.pauseRequested = true;
    run.pauseRequestedAt = latest.pauseRequestedAt ?? null;
    run.pauseRequestBaseRevision = latest.pauseRequestBaseRevision ?? null;
    run.pauseRequestRevision = latest.pauseRequestRevision ?? null;
    if (!deferPause) throw makeError("user_pause");
    return;
  }
  if (recoveredIdentity && Number(latest.stateRevision) !== Number(run.stateRevision)) {
    throw makeError("run_state_conflict");
  }
  inheritRunFailClosedGuard(run, latest);
}

async function waitForReadyStability(run, token, lease = null) {
  let stableSince = null;
  const startedAt = Date.now();
  const heartbeat = { nextRenewAt: 0 };
  const runObservation = { nextCheckAt: 0 };
  while (Date.now() - startedAt < readinessTimeoutForRun(run)) {
    await observeRunCanContinue(run, token, runObservation, { deferPause: true });
    await renewLeaseHeartbeat(lease, run.runId, heartbeat);
    const page = readCurrentPageObservation();
    if (page.blocker) throw blockerToError(page.blocker);
    if (page.generationState === "idle") {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= READY_STABLE_MS) return;
    } else {
      stableSince = null;
    }
    await sleep(POLL_MS);
  }
  throw makeError("generation_timeout");
}

async function sendPromptSafely(run, step, lease, token, pausedPrompt = null) {
  const expectedPosition = assertSendBudgetAvailable(run, step);
  await waitUntilReady(run, token, readinessTimeoutForRun(run), lease);

  const blocker = ChatGptAdapter.detectBlocker();
  if (blocker) throw blockerToError(blocker);

  const composer = ChatGptAdapter.findComposer();
  if (!composer) throw makeError("composer_missing");
  const appendPlan = pausedPrompt ? null : initialAppendForPosition(run, step);
  if (pausedPrompt) {
    if (pausedPrompt.resumeToken !== token || !pausedPromptTextMatches(pausedPrompt, run, step)) {
      throw makeError("draft_present");
    }
  } else if (!appendPlan && !composerIsEffectivelyEmpty(ChatGptAdapter.getComposerText(composer))) {
    throw makeError("draft_present");
  }
  assertComposerHasNoAttachments(composer);

  const promptHash = await sha256(step.prompt);
  const expectedText = pausedPrompt?.expectedText ?? appendPlan?.expectedText ?? step.prompt;
  const inputHash = expectedText === step.prompt ? promptHash : await sha256(expectedText);
  if (run.initialInputRequirement && (
      run.initialInputRequirement.stepId !== step.id || run.initialInputRequirement.promptHash !== promptHash ||
      run.initialInputRequirement.inputHash !== inputHash)) throw makeError("draft_present");
  run.phase = "prepared";
  run.outbox = {
    id: crypto.randomUUID(),
    stepId: step.id,
    promptHash,
    inputHash,
    position: {
      stepIndex: expectedPosition.stepIndex,
      repeatIndex: expectedPosition.repeatIndex,
      sendsCompleted: expectedPosition.sendsCompleted
    },
    deliveryMode: "pending",
    state: "prepared",
    preparedAt: nowIso()
  };
  await saveActiveRun(run);
  appendPostCommitDiagnostic("send_prepared", { runId: run.runId, phase: run.phase, stepId: step.id });

  if (!(await renewLease(lease, run.runId))) throw makeError("lease_conflict");

  await assertRunCanContinue(run, token, { authorityBoundary: "send-preflight" });
  assertLocalRunnerToken(token);
  assertConversationStillMatches(run);
  const composerBeforeWrite = ChatGptAdapter.findComposer();
  if (!composerBeforeWrite) throw makeError("composer_missing");
  if (pausedPrompt) {
    if (pausedPrompt.resumeToken !== token || !pausedPromptTextMatches(pausedPrompt, run, step)) {
      throw makeError("draft_present");
    }
  } else if (appendPlan ? ChatGptAdapter.inspectPromptAppend?.(appendPlan) !== true
    : !composerIsEffectivelyEmpty(ChatGptAdapter.getComposerText(composerBeforeWrite))) {
    throw makeError("draft_present");
  }
  assertComposerHasNoAttachments(composerBeforeWrite);
  const deliveryBinding = createPromptDeliveryBinding(run, step, expectedPosition, promptHash, token);
  let deliveryTransaction;
  try {
    deliveryTransaction = pausedPrompt
      ? ChatGptAdapter.adoptPausedPromptText(pausedPrompt.domReceipt, expectedText, deliveryBinding)
      : ChatGptAdapter.writePrompt(step.prompt, deliveryBinding, appendPlan);
  } finally {
    // Even a partially handled paste is one attempt; it must never be appended again.
    if (appendPlan) revokeInitialPromptAppend();
  }
  deliveryTransaction.expectedText = expectedText;
  try {
    const observedDelivery = await waitForPromptDeliverySettlement(
      run,
      token,
      deliveryTransaction,
      step,
      deliveryBinding,
      expectedPosition,
      promptHash,
      lease
    );
    const deliveryMode = observedDelivery.mode;
    run.outbox.deliveryMode = deliveryMode;
    // A recovered identity read must compare the complete durable outbox, including
    // delivery mode. Persist that read-only-observed mode before any later recovery
    // transaction can authorize the irreversible Send boundary.
    await saveActiveRun(run, "runner", "send-preflight");

    const sendButton = ChatGptAdapter.findSendButton();
    if (!sendButton || sendButton.disabled || sendButton.getAttribute("aria-disabled") === "true") {
      throw makeError("send_unavailable");
    }

    await assertRunCanContinue(run, token, { authorityBoundary: "send-preflight" });
    assertPromptDeliveryRunBinding(run, step, expectedPosition, promptHash, token, deliveryBinding);
    run.phase = "submitting";
    await saveActiveRun(run, "runner", "send-preflight");
    await assertRunCanContinue(run, token, { deferPause: true, authorityBoundary: "send-preflight" });
    if (!(await renewLease(lease, run.runId))) throw makeError("lease_conflict");
    assertPromptDeliveryRunBinding(run, step, expectedPosition, promptHash, token, deliveryBinding);
    const finalDelivery = requirePromptDeliveryState(deliveryTransaction, step, deliveryBinding, deliveryMode);
    if (finalDelivery.mode !== deliveryMode) throw makeError("paste_attachment_provenance_lost");
    const finalSendButton = ChatGptAdapter.findSendButton();
    if (!finalSendButton || finalSendButton.disabled || finalSendButton.getAttribute("aria-disabled") === "true") {
      throw makeError("send_unavailable");
    }
    const blockerBeforeClick = ChatGptAdapter.detectBlocker();
    if (blockerBeforeClick) throw blockerToError(blockerBeforeClick);
    if (ChatGptAdapter.getGenerationState() !== "idle") throw makeError("send_unavailable");
    // Persistence, control, and lease awaits happened since the first check. This synchronous
    // critical section revalidates the exact Run position and live delivery provenance; no
    // await is allowed between these checks and the irreversible click.
    assertPromptDeliveryRunBinding(run, step, expectedPosition, promptHash, token, deliveryBinding);

    const startedOnNewChat = String(run.conversationKey).startsWith("chatgpt:new:");
    // Generation is idle at this exact point (checked above), so any generation control the
    // watch records from here on was caused by this click. Arming it here is synchronous and
    // suspends nothing, which keeps this critical section unbroken up to the click itself.
    if (typeof ChatGptAdapter.startDeliveryAcceptanceWatch === "function") {
      ChatGptAdapter.startDeliveryAcceptanceWatch(deliveryTransaction);
    }
    finalSendButton.click();

  // New Chat is intentionally one-shot for automatic execution. The first click is allowed,
  // then background durably pauses this Run without relying on route identity or document
  // probing. No canonical route is guessed or adopted here; explicit user Resume is required.
    if (startedOnNewChat) {
      await requireNewChatConfirmation(run);
    }

    run.outbox.state = "submitted";
    run.outbox.submittedAt = nowIso();
    run.phase = "waiting-ack";
    await saveActiveRun(run);
  // The submitted outbox is durable and the ACK observation below decides delivery.
  // A logging failure must not manufacture ambiguity by aborting that observation window.
    appendPostCommitDiagnostic("send_clicked", { runId: run.runId, phase: run.phase, stepId: step.id });

    const ackStartedAt = Date.now();
    let confirmed = false;
    let sawGeneration = false;
    let sawComposerCleared = false;
    const heartbeat = { nextRenewAt: 0 };
    const runObservation = { nextCheckAt: 0 };
    while (Date.now() - ackStartedAt < ACK_TIMEOUT_MS) {
      assertConversationStillMatches(run);
      await observeRunCanContinue(run, token, runObservation, { deferPause: true });
      await renewLeaseHeartbeat(lease, run.runId, heartbeat);
      const page = readCurrentPageObservation();
      if (page.blocker) throw blockerToError(page.blocker);

      // Delivery still requires BOTH a started generation and a cleared composer, but each is
      // latched independently because their lifetimes differ. The cleared composer is durable;
      // the generation control is a transient edge that a short reply retires within a few
      // hundred milliseconds — often before this loop, which sits behind a durable write and
      // two cross-context guards, can look at it. Demanding that one instantaneous sample
      // catch both turns a delivered send into a false UNKNOWN. Latching discards no safety:
      // both signals are still required, and neither latch can be set before the click.
      if (page.generationState === "generating") sawGeneration = true;
      else if (!sawGeneration && typeof ChatGptAdapter.hasObservedDeliveryGeneration === "function") {
        sawGeneration = ChatGptAdapter.hasObservedDeliveryGeneration(deliveryTransaction, deliveryBinding);
      }

      const ackState = typeof ChatGptAdapter.getPromptDeliveryAckState === "function"
        ? ChatGptAdapter.getPromptDeliveryAckState(deliveryTransaction, deliveryBinding, deliveryMode)
        : { known: false, cleared: false };
      if (ackState.known === true && ackState.cleared === true) sawComposerCleared = true;

      if (sawGeneration && sawComposerCleared) {
        confirmed = true;
        break;
      }
      await sleep(POLL_MS);
    }

    if (!confirmed) throw makeError("submission_ambiguous");

    run.outbox.state = "confirmed";
    run.outbox.confirmedAt = nowIso();
    run.phase = "generating";
    await saveActiveRun(run);
  // Delivery certainty is monotonic: once confirmed is durable, observability cannot
  // demote it to ambiguous or prevent the cursor from being committed exactly once.
    appendPostCommitDiagnostic("send_confirmed", { runId: run.runId, phase: run.phase, stepId: step.id });

    await waitForReadyStability(run, token, lease);
    run.phase = "ready";
    await saveActiveRun(run);
    return lease;
  } catch (error) {
    if (run.phase === "prepared" && run.outbox?.state === "prepared" &&
        (error?.code === "user_pause" || isRunErrorResumable(run, error?.code))) {
      error.pausedPromptCandidate = capturePausedPromptCandidate(deliveryTransaction, deliveryBinding, run, step);
    }
    throw error;
  } finally {
    if (typeof ChatGptAdapter.finishPromptDelivery === "function") {
      ChatGptAdapter.finishPromptDelivery(deliveryTransaction);
    }
  }
}

// The post-send delay is a durable fence: its deadline is written in the very same
// commit that advances the cursor, so a reload inside delayAfterMs can restore the
// remaining time instead of firing the next send at a page that is still loading.
function postSendDelayFence(run, step) {
  const duration = requireRuntimeDuration(
    step?.delayAfterMs === undefined ? 0 : step.delayAfterMs,
    "currentStep.delayAfterMs",
    MAX_POST_SEND_DELAY_MS
  );
  if (duration === 0) return null;
  return {
    kind: "delay",
    scope: "after-send",
    stepId: step.id,
    stepIndex: run.cursor.stepIndex,
    repeatIndex: run.cursor.repeatIndex,
    until: Date.now() + duration
  };
}

async function awaitPostSendDelay(run, token) {
  const fence = run.waitState;
  if (fence?.kind !== "delay" || fence.scope !== "after-send") return;
  const until = Number(fence.until);
  const samePosition = fence.stepIndex === run.cursor.stepIndex && fence.repeatIndex === run.cursor.repeatIndex;
  if (!Number.isFinite(until) || !samePosition) {
    run.waitState = null;
    run.phase = "ready";
    await saveActiveRun(run);
    return;
  }

  const deadline = Math.min(until, Date.now() + 5 * 60 * 1000);
  if (run.phase !== "delay") {
    run.phase = "delay";
    await saveActiveRun(run);
  }
  appendPostCommitDiagnostic("delay_pending", { runId: run.runId, phase: run.phase, stepId: fence.stepId });
  while (Date.now() < deadline) {
    await assertRunCanContinue(run, token);
    await sleep(Math.min(1000, Math.max(1, deadline - Date.now())));
  }
  run.waitState = null;
  run.phase = "ready";
  await saveActiveRun(run);
}

async function armAlarm(run, step, whenMs) {
  const response = await chrome.runtime.sendMessage({
    type: "AIPM_ARM_ALARM",
    runId: run.runId,
    stepId: step.id,
    whenMs,
    serviceWorkerVersion: run.contentVersion,
    executionSessionId: run.executionSessionId
  });
  if (!response?.ok) throw makeError("alarm_failed");
}

async function clearAlarm(run, step) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "AIPM_CLEAR_ALARM",
      runId: run.runId,
      stepId: step.id,
      serviceWorkerVersion: run.contentVersion,
      executionSessionId: run.executionSessionId
    });
    if (!response?.ok) throw makeError("alarm_failed");
  } catch {
    // Alarm cleanup is an authority transition: cursor advance is forbidden until the
    // exact schedule and wake signal are confirmed removed. Prompt delivery is never retried.
    throw makeError("alarm_failed");
  }
}

function alarmWakeKey(runId, stepId) {
  return `${runId}:${stepId}`;
}

function waitForAlarmWake(runId, stepId, timeoutMs = 1000) {
  const key = alarmWakeKey(runId, stepId);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (alarmWakeResolvers.get(key) === wake) alarmWakeResolvers.delete(key);
      resolve(null);
    }, timeoutMs);
    const wake = (payload) => {
      clearTimeout(timeout);
      if (alarmWakeResolvers.get(key) === wake) alarmWakeResolvers.delete(key);
      resolve(payload);
    };
    alarmWakeResolvers.set(key, wake);
  });
}

async function getAlarmSignal(run, step) {
  const response = await chrome.runtime.sendMessage({
    type: "AIPM_GET_ALARM_SIGNAL",
    runId: run.runId,
    stepId: step.id,
    serviceWorkerVersion: run.contentVersion,
    executionSessionId: run.executionSessionId
  });
  return response?.signal ?? null;
}

async function waitUntilBlock(run, step, token) {
  const scheduledAt = Date.parse(step.at);
  if (!Number.isFinite(scheduledAt)) throw makeError("schedule_invalid");
  const graceMs = requireRuntimeDuration(step.graceMs, "currentStep.graceMs", MAX_WAIT_DURATION_MS);

  run.phase = "waiting-time";
  run.waitState = { kind: "wait-until", stepId: step.id, scheduledAt, armedAt: Date.now() };
  await saveActiveRun(run);
  appendPostCommitDiagnostic("schedule_armed", { runId: run.runId, phase: run.phase, stepId: step.id });
  await armAlarm(run, step, scheduledAt);

  let firedAt = null;
  while (firedAt == null) {
    await assertRunCanContinue(run, token);
    const signal = await getAlarmSignal(run, step);
    if (Number(signal?.scheduledAt) === scheduledAt && Number.isFinite(Number(signal?.firedAt))) {
      firedAt = Number(signal.firedAt);
      break;
    }
    if (Date.now() >= scheduledAt) {
      firedAt = Date.now();
      break;
    }
    await waitForAlarmWake(run.runId, step.id, Math.min(1000, Math.max(50, scheduledAt - Date.now())));
  }

  await clearAlarm(run, step);
  const lateness = Math.max(0, firedAt - scheduledAt);

  if (lateness > graceMs && step.latePolicy === "skip") {
    run.waitState = null;
    run.phase = "ready";
    advanceCursor(run, false);
    await saveActiveRun(run);
    appendPostCommitDiagnostic("schedule_skipped", {
      runId: run.runId,
      phase: run.phase,
      stepId: step.id,
      reason: "late"
    });
    return;
  }

  if (lateness > graceMs && step.latePolicy !== "run" && run.acceptLateStepId !== step.id) {
    run.status = "paused";
    run.phase = "wait-until-late";
    run.pauseReason = "schedule-late";
    run.lastErrorCode = "schedule_late";
    run.lastErrorMessage = makeError("schedule_late").message;
    run.resumable = true;
    await saveActiveRun(run);
    appendPostCommitDiagnostic("schedule_late", { runId: run.runId, phase: run.phase, stepId: step.id, reason: "late" });
    await assertRunCanContinue(run, token);
  }

  run.waitState = null;
  run.phase = "ready";
  run.pauseReason = null;
  run.acceptLateStepId = null;
  run.lastErrorCode = null;
  run.lastErrorMessage = null;
  advanceCursor(run, false);
  await saveActiveRun(run);
}

async function delayBlock(run, step, token) {
  const duration = requireRuntimeDuration(step.durationMs, "currentStep.durationMs", MAX_WAIT_DURATION_MS);
  const existingUntil = run.waitState?.kind === "delay" && run.waitState?.stepId === step.id
    ? Number(run.waitState.until)
    : NaN;
  const until = Number.isFinite(existingUntil) ? existingUntil : Date.now() + duration;
  run.phase = "delay";
  run.waitState = { kind: "delay", stepId: step.id, until };
  await saveActiveRun(run);
  appendPostCommitDiagnostic("delay_started", { runId: run.runId, phase: run.phase, stepId: step.id });
  while (Date.now() < until) {
    await assertRunCanContinue(run, token);
    await sleep(Math.min(1000, Math.max(1, until - Date.now())));
  }
  run.waitState = null;
  run.phase = "ready";
  advanceCursor(run, false);
  await saveActiveRun(run);
}

async function prepareDraft(run, step, token) {
  await waitUntilReady(run, token, readinessTimeoutForRun(run));
  const blocker = ChatGptAdapter.detectBlocker();
  if (blocker) throw blockerToError(blocker);
  const composer = ChatGptAdapter.findComposer();
  if (!composer) throw makeError("composer_missing");
  if (!composerIsEffectivelyEmpty(ChatGptAdapter.getComposerText(composer))) throw makeError("draft_present");
  assertComposerHasNoAttachments(composer);

  const promptHash = await sha256(step.prompt);
  // Draft owns only this composer transaction; it never prepares a Send outbox.
  const draftAttemptToken = crypto.randomUUID();
  const currentDraftBinding = () => Object.freeze({
    ...createPromptDeliveryBinding(run, step, run.cursor, promptHash, token),
    deliveryAttemptToken: draftAttemptToken,
    boundTabId: run.boundTabId,
    boundDocumentId: run.boundDocumentId
  });
  const draftBinding = currentDraftBinding();
  const assertDraftAuthority = () => {
    assertLocalRunnerToken(token);
    assertConversationStillMatches(run);
    if (!sameJsonAuthorityValue(draftBinding, currentDraftBinding())) throw makeError("run_state_conflict");
  };
  await assertRunCanContinue(run, token);
  assertDraftAuthority();
  const composerBeforeWrite = ChatGptAdapter.findComposer();
  if (!composerBeforeWrite) throw makeError("composer_missing");
  if (!composerIsEffectivelyEmpty(ChatGptAdapter.getComposerText(composerBeforeWrite))) throw makeError("draft_present");
  assertComposerHasNoAttachments(composerBeforeWrite);
  const blockerBeforeWrite = ChatGptAdapter.detectBlocker();
  if (blockerBeforeWrite) throw blockerToError(blockerBeforeWrite);
  if (ChatGptAdapter.getGenerationState() !== "idle") throw makeError("composer_not_ready");
  const draftTransaction = ChatGptAdapter.writePrompt(step.prompt, draftBinding);
  try {
    await sleep(120);
    await assertRunCanContinue(run, token);
    assertDraftAuthority();
    requirePromptDeliveryState(draftTransaction, step, draftBinding, "text");
  } finally {
    ChatGptAdapter.finishPromptDelivery(draftTransaction);
  }

  advanceCursor(run, false);
  run.status = "paused";
  run.phase = "draft-ready";
  run.pauseReason = "draft-ready";
  run.resumable = true;
  await saveActiveRun(run);
  appendPostCommitDiagnostic("draft_ready", { runId: run.runId, phase: run.phase, stepId: step.id });
  await assertRunCanContinue(run, token);
  run.phase = "ready";
  run.pauseReason = null;
  await saveActiveRun(run);
}

async function executeRun(run, token, initialLease = null, pausedPrompt = null) {
  let lease = initialLease;
  let pauseFinalization = null;
  if (!pausedPrompt) revokePausedPromptReceipt();
  activeRunnerRunId = run.runId;
  activeRunnerToken = token;
  activeRunnerExecutionSessionId = run.executionSessionId;
  try {
    requireRuntimeCursorAuthority(run);
    if (run.outbox?.state === "confirmed") {
      // Explicit Resume of a confirmed delivery observes readiness only. The
      // confirmed position never re-enters writePrompt or the Send boundary.
      if (!(await confirmedOutboxMatchesCurrentPosition(run))) throw makeError("recovery_ambiguous");
      lease = await acquireLease(run.conversationKey, run.runId, run.executionSessionId, run.workflow?.recovery, run);
      if (!lease) throw makeError("lease_conflict");
      await waitForReadyStability(run, token, lease);
      const sentStep = currentStep(run);
      advanceCursor(run, true);
      run.outbox = null;
      const more = run.cursor.stepIndex < run.workflow.steps.length || run.cursor.repeatIndex > 0;
      const fence = more ? postSendDelayFence(run, sentStep) : null;
      run.waitState = fence;
      run.phase = fence ? "delay" : "ready";
      await saveActiveRun(run);
      await releaseLease(lease, run.runId);
      lease = null;
    }
    await awaitPostSendDelay(run, token);
    while (run.cursor.stepIndex < run.workflow.steps.length) {
      await assertRunCanContinue(run, token);
      const step = currentStep(run);
      if (!step) break;

      if (step.type === "checkpoint") {
        advanceCursor(run, false);
        run.status = "paused";
        run.phase = "checkpoint";
        run.pauseReason = "manual-checkpoint";
        run.checkpointLabel = step.label || "Manual checkpoint";
        await saveActiveRun(run);
        appendPostCommitDiagnostic("checkpoint", { runId: run.runId, phase: run.phase, stepId: step.id });
        await assertRunCanContinue(run, token);
        run.phase = "ready";
        run.pauseReason = null;
        run.checkpointLabel = null;
        await saveActiveRun(run);
        continue;
      }

      if (step.type === "delay") {
        await releaseLease(lease, run.runId);
        lease = null;
        await delayBlock(run, step, token);
        continue;
      }

      if (step.type === "wait-until") {
        await releaseLease(lease, run.runId);
        lease = null;
        await waitUntilBlock(run, step, token);
        continue;
      }

      if (step.type === "prompt" && step.delivery === "draft") {
        await releaseLease(lease, run.runId);
        lease = null;
        await prepareDraft(run, step, token);
        continue;
      }

      if (!lease) {
        lease = await acquireLease(run.conversationKey, run.runId, run.executionSessionId, run.workflow?.recovery, run);
        if (!lease) throw makeError("lease_conflict");
      }
      if (!(await renewLease(lease, run.runId))) throw makeError("lease_conflict");
      lease = await migrateLeaseIfNeeded(lease, run);
      const promptToResume = pausedPrompt;
      pausedPrompt = null;
      try {
        lease = await sendPromptSafely(run, step, lease, token, promptToResume);
      } finally {
        disposePausedPromptCandidate(promptToResume);
      }
      advanceCursor(run, true);
      run.outbox = null;
      const morePositionsRemain = run.cursor.stepIndex < run.workflow.steps.length || run.cursor.repeatIndex > 0;
      const fence = morePositionsRemain ? postSendDelayFence(run, step) : null;
      run.waitState = fence;
      run.phase = fence ? "delay" : "ready";
      await saveActiveRun(run);

      await releaseLease(lease, run.runId);
      lease = null;

      await awaitPostSendDelay(run, token);
    }

    run.status = "completed";
    run.phase = "completed";
    run.pauseReason = null;
    run.pauseRequested = false;
    run.pauseRequestedAt = null;
    run.pauseRequestBaseRevision = null;
    run.pauseRequestRevision = null;
    run.outbox = null;
    run.waitState = null;
    await saveActiveRun(run);
    // completed is terminal and durable; diagnostics are downstream observability only.
    appendPostCommitDiagnostic("run_completed", { runId: run.runId, phase: run.phase, status: run.status });
  } catch (error) {
    const code = error?.code ?? "unknown";
    if (code === "user_stop" || code === "run_state_conflict") return;

    if (code === "user_pause") {
      // Durable Pause can become visible before its response reaches this runner.
      // Resume must not consume the receipt or reuse the old lease until both the
      // receipt and the release below have finished. The controller reports busy.
      pauseFinalization = { runId: run.runId, executionSessionId: run.executionSessionId, token };
      localPauseFinalization = pauseFinalization;
      // prepared/prepared proves the irreversible click has not happened. Only that
      // pre-submit outbox may be discarded so Resume restarts the same cursor position.
      if (run.phase === "prepared" && run.outbox?.state === "prepared") {
        run.outbox = null;
        run.phase = "ready";
      }
      run.lastErrorCode = null;
      run.lastErrorMessage = null;
      run.resumable = true;
      try {
        await pauseRun(run, "user-pause", run.phase || "paused", "pause");
        armPausedPromptReceipt(error.pausedPromptCandidate, run);
      } catch (pauseError) {
        disposePausedPromptCandidate(error.pausedPromptCandidate);
        if (pauseError?.code !== "run_state_conflict") throw pauseError;
      }
      return;
    }

    if (code === "document_identity_unconfirmed") {
      const stopped = await failClosedRunWithoutIdentity(run.runId, code, error).catch(() => null);
      if (stopped && typeof recordDocumentIdentityFailureDiagnostic === "function") {
        recordDocumentIdentityFailureDiagnostic(error, stopped);
      }
      return;
    }

    if (code === "document_identity_mismatch") {
      await failClosedRunWithoutIdentity(run.runId, code, error).catch(() => {});
      return;
    }

    if (code === "conversation_identity_unknown" || code === "conversation_changed") {
      await failClosedRunWithoutIdentity(run).catch(() => {});
      return;
    }

    const confirmedWait = canResumeConfirmedObservation(run, code);
    const provablyPreSend = run.phase === "prepared" && run.outbox?.state === "prepared";
    const resumable = confirmedWait || isRunErrorResumable(run, code);
    run.lastErrorCode = code;
    run.lastErrorMessage = error instanceof Error ? error.message : "Macro error";
    run.resumable = resumable;
    if (resumable) {
      // Resume must not race the old runner's receipt installation or lease
      // release, including error pauses and confirmed wait-only recovery.
      pauseFinalization = { runId: run.runId, executionSessionId: run.executionSessionId, token };
      localPauseFinalization = pauseFinalization;
    }
    try {
      // This error is raised only before the sole provider click. Keep that
      // certainty without weakening the handling of in-flight deliveries.
      const attachmentBlockedBeforeSend = code === "paste_attachment_unverified" &&
        run.outbox?.state === "prepared";
      await pauseRun(run, code, attachmentBlockedBeforeSend ? "attachment-blocked"
        : confirmedWait ? "confirmed-wait" : provablyPreSend ? "prepared" : resumable ? "paused" : "ambiguous");
      if (provablyPreSend && resumable) armPausedPromptReceipt(error.pausedPromptCandidate, run);
      const textSendReadiness = error?.details?.textSendReadiness;
      if (code === "send_unavailable" && textSendReadiness) {
        const recordReadinessDiagnostic = typeof appendDeferredPostCommitDiagnostic === "function"
          ? appendDeferredPostCommitDiagnostic
          : appendPostCommitDiagnostic;
        recordReadinessDiagnostic("send_readiness_timeout", {
          runId: run.runId,
          phase: run.phase,
          status: run.status,
          reason: code,
          elapsedMs: textSendReadiness.elapsedMs,
          deadlineMs: textSendReadiness.deadlineMs
        });
      }
    } catch (pauseError) {
      disposePausedPromptCandidate(error.pausedPromptCandidate);
      if (pauseError?.code !== "run_state_conflict") throw pauseError;
    }
    const settlement = error?.details?.attachmentSettlement;
    if (["paste_attachment_provenance_lost", "paste_attachment_unrecognized",
      "paste_attachment_settlement_timeout"].includes(code) && settlement && typeof settlement === "object") {
      const recordSettlementDiagnostic = typeof appendDeferredPostCommitDiagnostic === "function"
        ? appendDeferredPostCommitDiagnostic
        : appendPostCommitDiagnostic;
      recordSettlementDiagnostic("paste_attachment_settlement", {
        runId: run.runId,
        phase: run.phase,
        status: run.status,
        reason: code,
        settlementOutcome: code === "paste_attachment_settlement_timeout"
          ? "timeout"
          : (code === "paste_attachment_unrecognized" ? "unrecognized" : "provenance-lost"),
        composerTextState: settlement.composerTextState,
        scopeKind: settlement.scopeKind,
        durationMs: settlement.elapsedMs,
        elapsedMs: settlement.elapsedMs,
        deadlineMs: settlement.deadlineMs,
        lastState: settlement.lastState,
        candidatesSeen: settlement.candidatesSeen,
        replacements: settlement.replacements,
        replacementCount: settlement.replacementCount,
        mutations: settlement.mutations,
        mutationCount: settlement.mutationCount,
        candidateCount: settlement.candidateCount,
        logicalAttachmentCount: settlement.logicalAttachmentCount,
        maxLogicalCandidates: settlement.maxLogicalCandidates,
        maxLogicalAttachmentCount: settlement.maxLogicalAttachmentCount,
        headerCandidateCount: settlement.headerCandidateCount,
        composerDepth: settlement.composerDepth,
        surfaceDepth: settlement.surfaceDepth,
        userEpochChanged: settlement.userEpochChanged,
        sendActionable: settlement.sendActionable,
        stableDurationMs: settlement.stableDurationMs,
        fileTileFallbackSeen: settlement.fileTileFallbackSeen,
        fileTileFallbackCount: settlement.fileTileFallbackCount,
        derivedRemoveSemanticCount: settlement.derivedRemoveSemanticCount,
        fallbackAccepted: settlement.fallbackAccepted,
        fallbackRejectReason: settlement.fallbackRejectReason
      });
    }
  } finally {
    disposePausedPromptCandidate(pausedPrompt);
    try {
      await releaseLease(lease, run.runId);
    } finally {
      if (activeRunnerRunId === run.runId && activeRunnerToken === token) {
        activeRunnerRunId = null;
        activeRunnerToken = null;
        activeRunnerExecutionSessionId = null;
      }
      if (pauseFinalization && localPauseFinalization === pauseFinalization) localPauseFinalization = null;
    }
  }
}
