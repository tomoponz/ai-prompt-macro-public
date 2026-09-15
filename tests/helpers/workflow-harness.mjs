import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const coreSource = fs.readFileSync(new URL("../../src/content-core.js", import.meta.url), "utf8");
const runnerSource = fs.readFileSync(new URL("../../src/content-runner.js", import.meta.url), "utf8");
const controllerSource = fs.readFileSync(new URL("../../src/content-controller.js", import.meta.url), "utf8");

export const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

export const CONTENT_VERSION = "0.4.0";
export const CONVERSATION_KEY = "chatgpt:c:project-three-prompt";
export const SESSION_ID = "session-block-workflow";
export const TAB_ID = 314;

// Prompt A -> Delay 1 -> Prompt B -> Delay 2 -> Prompt C, shaped the way
// src/workflow.js normalizes a Block Workflow (prompts carry delayAfterMs too).
export function threePromptWorkflow(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "three-prompt",
    name: "Three Prompt",
    maxSends: 3,
    steps: [
      { id: "prompt-a", type: "prompt", delivery: "send", prompt: "PROMPT A", repeat: 1, delayAfterMs: 1000 },
      { id: "delay-1", type: "delay", durationMs: 20_000 },
      { id: "prompt-b", type: "prompt", delivery: "send", prompt: "PROMPT B", repeat: 1, delayAfterMs: 1000 },
      { id: "delay-2", type: "delay", durationMs: 20_000 },
      { id: "prompt-c", type: "prompt", delivery: "send", prompt: "PROMPT C", repeat: 1, delayAfterMs: 1000 }
    ],
    ...overrides
  };
}

// Only these adapter members may ever be touched. Anything that could reach an
// assistant response body would have to appear here first.
export const OUTPUT_BLIND_ADAPTER_SURFACE = new Set([
  "id",
  "matches",
  "getConversationKey",
  "findComposer",
  "findSendButton",
  "findStopButton",
  "getComposerText",
  "getComposerAttachmentState",
  "inspectPromptDelivery",
  "getPromptDeliveryAckState",
  // Both report only whether a generation control existed — never assistant output.
  "startDeliveryAcceptanceWatch",
  "hasObservedDeliveryGeneration",
  "finishPromptDelivery",
  "isComposerWritable",
  "writePrompt",
  "isGenerating",
  "getGenerationState",
  "readPageObservation",
  "detectBlocker"
]);

export function createWorkflowHarness(options = {}) {
  const {
    generationMs = 4_000,
    leaseTtlMs = 15_000,
    ackConfirms = true,
    leaseReleaseFailure = null,
    onSave = null,
    onClick = null,
    onRunSet = null,
    // --- fault-injection hooks -------------------------------------------------
    // Every hook below is optional and inert when omitted, so the harness keeps its
    // original behaviour for existing suites. Each one names an await boundary the
    // runner actually crosses, which is where a torture test injects its fault:
    //   onRunGet   - AIPM_RUN_GET (every assertRunCanContinue / observation read)
    //   onLease    - AIPM_LEASE_ACQUIRE / RENEW / RELEASE
    //   onWrite    - immediately after ChatGptAdapter.writePrompt, i.e. inside the
    //                post-write settle window before the readback
    //   onStorageGet / onStorageSet - chrome.storage.local, which is the only thing
    //                appendDiagnostic touches; a hook may throw or return a promise
    //                that never settles.
    onRunGet = null,
    onLease = null,
    onWrite = null,
    onStorageGet = null,
    onStorageSet = null,
    //   onAlarm     - AIPM_ARM_ALARM / AIPM_CLEAR_ALARM / AIPM_GET_ALARM_SIGNAL
    onAlarm = null,
    conversationKey = CONVERSATION_KEY,
    initialComposerText = "",
    initialAttachmentCount = 0,
    convertPasteToAttachment = false,
    preserveAttachmentAfterClick = false,
    composerTextAfterClick = "",
    pasteAttachmentTimeline = []
  } = options;

  let clock = 1_700_000_000_000;
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(clock);
      else super(...args);
    }
    static now() { return clock; }
  }

  const transcript = [];
  const saves = [];
  const adapterCalls = new Set();
  // `blocker` and `generationOverride` default to inert values so the adapter behaves
  // exactly as before unless a torture test drives them.
  let attachmentNodeSequence = 0;
  let attachmentNodes = [];
  const page = {
    text: String(initialComposerText),
    pendingPrompt: "",
    userMutationEpoch: 0,
    generationEndsAt: -1,
    clicks: 0,
    blocker: null,
    generationOverride: null,
    attachmentReplacementCount: 0,
    activeDeliveryTransactions: 0,
    unscopedAttachmentCount: 0
  };
  Object.defineProperty(page, "attachmentCount", {
    enumerable: true,
    configurable: false,
    get: () => attachmentNodes.length,
    set(value) {
      const nextCount = Math.max(0, Math.floor(Number(value) || 0));
      if (nextCount < attachmentNodes.length) attachmentNodes = attachmentNodes.slice(0, nextCount);
      while (attachmentNodes.length < nextCount) {
        attachmentNodeSequence += 1;
        attachmentNodes.push({ attachmentNodeId: attachmentNodeSequence });
      }
    }
  });
  page.attachmentCount = initialAttachmentCount;
  let currentConversationKey = conversationKey;
  const leases = new Map();
  const storage = new Map();
  let storedRun = null;
  let nonceSeq = 0;
  let leaseReleaseFailuresRemaining = leaseReleaseFailure ? 1 : 0;
  let currentTopDocumentInstanceId = null;
  const pending = [];
  const scheduledPageActions = [];

  const record = (type, extra = {}) => { transcript.push({ type, at: clock, ...extra }); };
  const runDuePageActions = () => {
    scheduledPageActions.sort((left, right) => left.at - right.at);
    while (scheduledPageActions.length > 0 && scheduledPageActions[0].at <= clock) {
      const scheduled = scheduledPageActions.shift();
      switch (scheduled.type) {
        case "convert":
          page.text = "";
          page.attachmentCount = 1;
          break;
        case "replace":
          page.attachmentCount = 0;
          page.attachmentCount = 1;
          page.attachmentReplacementCount += 1;
          break;
        case "extra":
          page.attachmentCount += 1;
          break;
        case "empty":
          page.text = "";
          break;
        case "clear":
          page.attachmentCount = 0;
          break;
        case "temporary":
          // A conversion placeholder that is intentionally not a recognized logical
          // attachment. The composer remains empty and the Macro must keep waiting.
          page.text = "";
          break;
        case "mutation-burst":
          page.surfaceMutationBatches = Number(page.surfaceMutationBatches ?? 0) +
            Math.max(1, Math.floor(Number(scheduled.count) || 1));
          break;
        case "user-interaction":
          page.userMutationEpoch += 1;
          break;
        default:
          throw new Error(`Unknown pasteAttachmentTimeline action: ${scheduled.type}`);
      }
      record("paste-attachment-timeline", { action: scheduled.type });
    }
  };

  const sendButton = {
    disabled: false,
    getAttribute: () => null,
    click() {
      page.clicks += 1;
      // The durable snapshot at click time names the exact logical send position, so a
      // position clicked twice is directly observable.
      const cursor = storedRun?.cursor ?? {};
      record("click", {
        prompt: page.pendingPrompt || page.text,
        clicks: page.clicks,
        // The Run id makes "the same logical position" unambiguous across generations: a
        // replacement Run legitimately starts again at 0:0.
        runId: storedRun?.runId ?? null,
        position: `${cursor.stepIndex ?? "?"}:${cursor.repeatIndex ?? "?"}`
      });
      page.text = String(composerTextAfterClick);
      page.pendingPrompt = "";
      if (!preserveAttachmentAfterClick) page.attachmentCount = 0;
      page.generationEndsAt = clock + generationMs;
      onClick?.({ clock, clicks: page.clicks, context });
    }
  };
  const stopButton = { id: "stop" };

  const composerForm = { contains: (node) => attachmentNodes.includes(node) };
  const composer = { id: "composer", closest: () => composerForm };
  const promptBindingMatches = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const rawAdapter = {
    id: "chatgpt",
    matches: () => true,
    getConversationKey: () => currentConversationKey,
    findComposer: () => composer,
    findSendButton: () => sendButton,
    findStopButton: () => (clock < page.generationEndsAt ? stopButton : null),
    getComposerText: () => page.text,
    getComposerAttachmentState: () => ({
      known: true,
      count: page.attachmentCount,
      logicalNodes: [...attachmentNodes],
      hiddenCount: 0,
      composerForm
    }),
    isComposerWritable: () => true,
    writePrompt(text, binding) {
      assert.ok(binding && typeof binding === "object", "production writePrompt requires an explicit binding");
      const transaction = {
        active: true,
        binding: clone(binding),
        composer,
        composerForm,
        userMutationEpoch: page.userMutationEpoch,
        beforeAttachmentNodes: new Set(attachmentNodes),
        beforeAttachmentCount: attachmentNodes.length,
        attachmentCandidate: null,
        attachmentSignature: null,
        macroAttachmentObserved: false,
        mode: null,
        replacements: 0,
        candidatesSeen: 0,
        maxLogicalCandidates: 0,
        mutations: 0,
        surfaceMutationBaseline: Number(page.surfaceMutationBatches ?? 0),
        startedAt: clock,
        stableSince: clock,
        lastObservedMode: null,
        lastObservedCandidate: null,
        lastObservedTextState: "unknown",
        lastObservedCount: 0,
        invalidReason: null
      };
      page.activeDeliveryTransactions += 1;
      page.text = text;
      page.pendingPrompt = text;
      record("write", { prompt: text });
      if (convertPasteToAttachment === true ||
          (typeof convertPasteToAttachment === "function" && convertPasteToAttachment({ text, page, context }))) {
        page.text = "";
        page.attachmentCount = 1;
      }
      for (const entry of pasteAttachmentTimeline) {
        const afterMs = Math.max(0, Math.floor(Number(entry?.afterMs) || 0));
        scheduledPageActions.push({ at: clock + afterMs, type: entry?.type, count: entry?.count });
      }
      // The runner awaits a settle window right after this call. A fault injected here
      // is therefore observed by the readback that guards the irreversible click.
      onWrite?.({ text, page, context });
      return transaction;
    },
    inspectPromptDelivery(transaction, expectedText, binding, expectedMode = null, options = {}) {
      const diagnostic = (outcome, composerTextState, lastState = "unknown") => ({
        outcome,
        deadlineMs: 30_000,
        lastState,
        candidatesSeen: transaction?.candidatesSeen ?? 0,
        replacements: transaction?.replacements ?? 0,
        replacementCount: transaction?.replacements ?? 0,
        composerTextState,
        scopeKind: "form",
        elapsedMs: Math.min(30_000, Math.max(0, clock - Number(transaction?.startedAt ?? clock))),
        mutations: transaction?.mutations ?? 0,
        mutationCount: transaction?.mutations ?? 0,
        candidateCount: page.attachmentCount,
        logicalAttachmentCount: page.attachmentCount,
        maxLogicalCandidates: transaction?.maxLogicalCandidates ?? 0,
        maxLogicalAttachmentCount: transaction?.maxLogicalCandidates ?? 0,
        headerCandidateCount: page.attachmentCount === 1 ? 1 : 0,
        composerDepth: 1,
        surfaceDepth: 1,
        userEpochChanged: transaction?.userMutationEpoch !== page.userMutationEpoch,
        sendActionable: true,
        stableDurationMs: Math.min(30_000, Math.max(0, clock - Number(transaction?.stableSince ?? clock)))
      });
      if (!transaction?.active || transaction.composer !== composer ||
          !promptBindingMatches(transaction.binding, binding) ||
          transaction.userMutationEpoch !== page.userMutationEpoch) {
        return { ok: false, reason: "user-interaction", diagnostic: diagnostic("user-interaction", "unknown", "invalid") };
      }
      transaction.mutations = Math.max(
        transaction.mutations,
        Math.max(0, Number(page.surfaceMutationBatches ?? 0) - Number(transaction.surfaceMutationBaseline ?? 0))
      );
      let mode = null;
      let candidate = null;
      const normalizedText = context.normalizeComposerComparableText(page.text);
      const composerTextState = normalizedText.length === 0
        ? "empty"
        : (context.composerTextMatchesExpected(expectedText, page.text)
            ? "exact"
            : (context.composerIsEffectivelyEmpty(page.text) ? "minimal" : "other"));
      transaction.maxLogicalCandidates = Math.max(transaction.maxLogicalCandidates, page.attachmentCount);
      if (page.attachmentCount > 1) transaction.invalidReason = "extra-attachment";
      if (transaction.invalidReason) return {
        ok: false,
        reason: transaction.invalidReason,
        diagnostic: diagnostic(
          transaction.invalidReason,
          composerTextState,
          transaction.invalidReason === "extra-attachment" ? "ambiguous" : "invalid"
        )
      };
      if (page.attachmentCount === 0 && page.text === expectedText) {
        mode = "text";
      } else if (page.attachmentCount === 1 && ["empty", "minimal"].includes(composerTextState)) {
        candidate = attachmentNodes[0];
        const beforeAttachmentCount = Number.isInteger(transaction.beforeAttachmentCount)
          ? transaction.beforeAttachmentCount
          : transaction.beforeAttachmentNodes.size;
        const cleanAttachmentBaseline = beforeAttachmentCount === 0 &&
          transaction.beforeAttachmentNodes.size === 0;
        if (cleanAttachmentBaseline &&
            (transaction.macroAttachmentObserved === true || !transaction.beforeAttachmentNodes.has(candidate))) {
          mode = "paste-attachment";
          if (transaction.macroAttachmentObserved !== true) {
            transaction.macroAttachmentObserved = true;
            transaction.attachmentCandidate = candidate;
            transaction.attachmentSignature = "fixture-pasted-text";
            transaction.candidatesSeen += 1;
          } else if (transaction.attachmentCandidate !== candidate) {
            transaction.attachmentCandidate = candidate;
            transaction.replacements += 1;
            transaction.candidatesSeen += 1;
          }
        }
      }
      if (transaction.invalidReason) {
        return {
          ok: false,
          reason: transaction.invalidReason,
          diagnostic: diagnostic(transaction.invalidReason, composerTextState, "invalid")
        };
      }
      if (transaction.lastObservedMode !== mode || transaction.lastObservedTextState !== composerTextState ||
          transaction.lastObservedCount !== page.attachmentCount) {
        transaction.lastObservedMode = mode;
        transaction.lastObservedCandidate = candidate;
        transaction.lastObservedTextState = composerTextState;
        transaction.lastObservedCount = page.attachmentCount;
        transaction.stableSince = clock;
      }
      if (!mode || (expectedMode && expectedMode !== mode)) {
        return {
          ok: false,
          reason: page.attachmentCount > 0
            ? "attachment-provenance-lost"
            : (["empty", "minimal"].includes(composerTextState) ? "settling" : "text-mismatch"),
          diagnostic: diagnostic(
            "pending",
            composerTextState,
            page.attachmentCount === 0 && ["empty", "minimal"].includes(composerTextState)
              ? "attachment-pending"
              : "invalid"
          )
        };
      }
      if (transaction.mode && transaction.mode !== mode) {
        return {
          ok: false,
          reason: "delivery-mode-changed",
          diagnostic: diagnostic("delivery-mode-changed", composerTextState, "invalid")
        };
      }
      if (options.lock === true) transaction.mode = mode;
      return {
        ok: true,
        mode,
        stableMs: clock - transaction.stableSince,
        diagnostic: diagnostic("settled", composerTextState, mode === "text" ? "text-ready" : "attachment-ready")
      };
    },
    getPromptDeliveryAckState(transaction, binding, mode) {
      const valid = transaction?.active && promptBindingMatches(transaction.binding, binding) &&
        transaction.userMutationEpoch === page.userMutationEpoch;
      return {
        known: valid,
        cleared: valid && context.composerIsEffectivelyEmpty(page.text) && page.attachmentCount === 0 &&
          (mode !== "paste-attachment" || transaction.macroAttachmentObserved === true)
      };
    },
    finishPromptDelivery(transaction) {
      if (transaction?.active) page.activeDeliveryTransactions = Math.max(0, page.activeDeliveryTransactions - 1);
      if (transaction) transaction.active = false;
    },
    isGenerating: () => (ackConfirms ? clock < page.generationEndsAt : false),
    getGenerationState: () => (page.generationOverride ?? (rawAdapter.isGenerating() ? "generating" : "idle")),
    readPageObservation: () => ({
      composer: rawAdapter.findComposer(),
      stopButton: rawAdapter.findStopButton(),
      blocker: rawAdapter.detectBlocker(),
      generationState: rawAdapter.getGenerationState()
    }),
    detectBlocker: () => page.blocker ?? null
  };
  const trackedAdapter = new Proxy(rawAdapter, {
    get(target, property) {
      if (typeof property === "string") {
        adapterCalls.add(property);
        assert.ok(
          OUTPUT_BLIND_ADAPTER_SURFACE.has(property),
          `Output-Blind: the runner touched an unexpected adapter member "${property}"`
        );
      }
      return target[property];
    }
  });

  // --- background emulator ---------------------------------------------------
  // Mirrors senderOwnsCurrentTopDocument: only the tab's current top document may read or
  // mutate the stored Run.
  function ownsCurrentTopDocument(message) {
    if (currentTopDocumentInstanceId == null) return true;
    return message?.documentInstanceId === currentTopDocumentInstanceId;
  }

  function setRun(next) {
    const existing = storedRun;
    if (next.executionSessionId !== SESSION_ID) return { ok: false, error: "session mismatch" };
    if (next.provider !== "chatgpt" || next.contentVersion !== CONTENT_VERSION) {
      return { ok: false, error: "provider/version mismatch" };
    }
    if (existing && existing.runId !== next.runId) {
      const existingActive = existing.status === "running" || existing.status === "paused";
      if (existingActive || next.replacesRunId !== existing.runId) {
        return { ok: false, error: "Run世代が一致しないため古い更新を拒否しました。" };
      }
    } else if (!existing && next.replacesRunId != null) {
      return { ok: false, error: "置換対象のRunが存在しないため開始を拒否しました。" };
    }
    if (existing?.runId === next.runId) {
      const revivesStopped = existing.status === "stopped" && next.status !== "stopped";
      const revivesCompleted = existing.status === "completed" && !["completed", "stopped"].includes(next.status);
      const bypassesPause = existing.status === "paused" && next.status === "running" &&
        next.__runTransition !== "resume";
      if (revivesStopped || revivesCompleted || bypassesPause) {
        return { ok: false, errorCode: "RUN_STATE_CONFLICT", error: "新しいPause/Stop/完了状態を古いrunner更新で上書きできません。" };
      }
      // Mirrors background.js: a runner write must present the revision it last observed,
      // and run progress is monotonic.
      const storedRevision = Number(existing.stateRevision);
      const followsPendingPause = next.__runTransition === "runner" &&
        existing.pauseRequested === true &&
        next.status === "running" &&
        typeof existing.outbox?.id === "string" && existing.outbox.id.length > 0 &&
        next.outbox?.id === existing.outbox.id &&
        Number(existing.pauseRequestRevision) === storedRevision &&
        Number(next.stateRevision) === Number(existing.pauseRequestBaseRevision);
      const staleRunner = next.__runTransition === "runner" &&
        Number.isFinite(storedRevision) &&
        Number(next.stateRevision) !== storedRevision &&
        !followsPendingPause;
      const staleControl = ["pause", "pause-request", "resume"].includes(next.__runTransition) &&
        Number.isFinite(storedRevision) &&
        Number(next.stateRevision) !== storedRevision;
      const rewinds = Number(next.cursor?.sendsCompleted ?? 0) < Number(existing.cursor?.sendsCompleted ?? 0) ||
        Number(next.cursor?.stepIndex ?? 0) < Number(existing.cursor?.stepIndex ?? 0) ||
        (Number(next.cursor?.stepIndex ?? 0) === Number(existing.cursor?.stepIndex ?? 0) &&
          Number(next.cursor?.repeatIndex ?? 0) < Number(existing.cursor?.repeatIndex ?? 0));
      if (staleRunner || staleControl || rewinds) {
        return { ok: false, errorCode: "RUN_STATE_CONFLICT", error: "Run状態はすでに新しく更新されています。古い更新を拒否しました。" };
      }
    }
    storedRun = clone(next);
    delete storedRun.__runTransition;
    storedRun.stateRevision = existing?.runId === next.runId && Number.isFinite(Number(existing.stateRevision))
      ? Number(existing.stateRevision) + 1
      : 1;
    if (next.__runTransition === "pause-request") {
      storedRun.status = "running";
      storedRun.pauseRequested = true;
      storedRun.pauseRequestBaseRevision = existing?.stateRevision ?? null;
      storedRun.pauseRequestRevision = storedRun.stateRevision;
    } else if (next.__runTransition === "runner" && next.status === "running" && existing?.pauseRequested === true) {
      storedRun.pauseRequested = true;
      storedRun.pauseRequestedAt = existing.pauseRequestedAt ?? null;
      storedRun.pauseRequestBaseRevision = existing.pauseRequestBaseRevision ?? null;
      storedRun.pauseRequestRevision = existing.pauseRequestRevision ?? null;
    }
    storedRun.boundTabId = TAB_ID;
    saves.push(clone(storedRun));
    return { ok: true, run: clone(storedRun) };
  }

  const context = vm.createContext({
    console,
    Date: FakeDate,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    location: { origin: "https://chatgpt.com", pathname: "/c/project-three-prompt" },
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {}, remove() {} }),
      documentElement: { appendChild() {} }
    },
    chrome: {
      runtime: {
        async sendMessage(message) {
          switch (message?.type) {
            case "AIPM_RUN_GET": {
              if (!ownsCurrentTopDocument(message)) {
                return { ok: false, error: "現在のdocumentを確認できないためRun取得を拒否しました。" };
              }
              if (onRunGet) {
                const intercepted = await onRunGet({
                  message: clone(message),
                  storedRun: clone(storedRun),
                  context,
                  page
                });
                if (intercepted != null) return clone(intercepted);
              }
              return { ok: true, run: clone(storedRun) };
            }
            case "AIPM_RUN_SET": {
              if (!ownsCurrentTopDocument(message)) {
                return { ok: false, error: "現在のdocumentを確認できないためRun更新を拒否しました。" };
              }
              if (onRunSet) {
                const intercepted = await onRunSet({
                  message: clone(message),
                  storedRun: clone(storedRun),
                  context,
                  page
                });
                if (intercepted != null) return clone(intercepted);
              }
              const result = setRun({ ...clone(message.run), __runTransition: message.runTransition });
              if (result.ok && onSave) await onSave({ run: clone(result.run), context, page });
              return result;
            }
            case "AIPM_RUN_FAIL_CLOSED": {
              if (!storedRun || (message.expectedRunId && storedRun.runId !== message.expectedRunId)) {
                return { ok: true, run: null, changed: false };
              }
              if (["stopped", "completed"].includes(storedRun.status)) {
                return { ok: true, run: clone(storedRun), changed: false, terminalRun: true };
              }
              const identityReason = message.reason === "document_identity_unconfirmed"
                ? "document_identity_unconfirmed"
                : (message.reason === "document_identity_mismatch"
                    ? "document_identity_mismatch"
                    : "conversation-identity-unknown");
              storedRun = {
                ...storedRun,
                status: "paused",
                phase: "ambiguous",
                resumable: false,
                pauseReason: identityReason,
                lastErrorCode: identityReason,
                lastErrorMessage: "Run safely stopped.",
                stateRevision: Number(storedRun.stateRevision ?? 0) + 1
              };
              saves.push(clone(storedRun));
              record("fail-closed", { runId: storedRun.runId, reason: identityReason });
              return { ok: true, run: clone(storedRun), changed: true };
            }
            // New Chat is one-shot for automatic execution: background durably pauses the
            // Run after its first click and only an explicit user Resume on a canonical
            // conversation may adopt a target. Mirrors background.js exactly.
            case "AIPM_RUN_NEW_CHAT_CONFIRM_REQUIRED": {
              if (!storedRun || storedRun.runId !== message.expectedRunId) {
                return { ok: false, error: "New Chat confirmation対象のRunが一致しません。" };
              }
              const safeCheckpoint = storedRun.status === "running" &&
                String(storedRun.conversationKey).startsWith("chatgpt:new:") &&
                storedRun.phase === "submitting" &&
                storedRun.outbox?.state === "prepared";
              if (!safeCheckpoint) return { ok: false, error: "New Chat送信状態を安全に確認できません。" };
              storedRun = {
                ...storedRun,
                status: "paused",
                phase: "new-chat-confirmation-required",
                resumable: false,
                pauseReason: "new-chat-confirmation-required",
                lastErrorCode: "new-chat-confirmation-required",
                lastErrorMessage: "New Chatの最初の送信後は自動継続しません。",
                outbox: { ...storedRun.outbox, state: "submitted", submittedAt: new FakeDate().toISOString() },
                stateRevision: Number(storedRun.stateRevision ?? 0) + 1
              };
              saves.push(clone(storedRun));
              record("new-chat-confirmation-required", { runId: storedRun.runId });
              return { ok: true, run: clone(storedRun) };
            }
            case "AIPM_RUN_CONFIRM_NEW_CHAT_TARGET": {
              const targetKey = message.conversationKey;
              if (typeof targetKey !== "string" || !targetKey.startsWith("chatgpt:c:")) {
                return { ok: false, error: "Resume先のcanonical conversationを確認できません。" };
              }
              const pending = storedRun?.status === "paused" &&
                storedRun?.pauseReason === "new-chat-confirmation-required" &&
                String(storedRun?.conversationKey).startsWith("chatgpt:new:");
              if (!storedRun || storedRun.runId !== message.expectedRunId || !pending) {
                return { ok: false, error: "confirmation-required Runが一致しません。" };
              }
              storedRun = {
                ...storedRun,
                conversationKey: targetKey,
                documentInstanceId: message.documentInstanceId ?? storedRun.documentInstanceId,
                boundTabId: TAB_ID,
                stateRevision: Number(storedRun.stateRevision ?? 0) + 1
              };
              saves.push(clone(storedRun));
              record("new-chat-target-confirmed", { runId: storedRun.runId, conversationKey: targetKey });
              return { ok: true, run: clone(storedRun) };
            }
            case "AIPM_ARM_ALARM":
            case "AIPM_CLEAR_ALARM":
            case "AIPM_GET_ALARM_SIGNAL": {
              record(message.type, { runId: message.runId, stepId: message.stepId, whenMs: message.whenMs });
              if (onAlarm) {
                const intercepted = await onAlarm({
                  message: clone(message),
                  operation: message.type.replace("AIPM_", "").toLowerCase(),
                  storedRun: clone(storedRun),
                  context,
                  page
                });
                if (intercepted != null) return clone(intercepted);
              }
              return { ok: true };
            }
            case "AIPM_LEASE_ACQUIRE":
            case "AIPM_LEASE_RENEW":
            case "AIPM_LEASE_RELEASE": {
              if (onLease) {
                const intercepted = await onLease({
                  message: clone(message),
                  operation: message.type.replace("AIPM_LEASE_", "").toLowerCase(),
                  storedRun: clone(storedRun),
                  context,
                  page
                });
                if (intercepted != null) return clone(intercepted);
              }
              return leaseOperation(message);
            }
            default:
              return { ok: true };
          }
        },
        onMessage: { addListener(listener) { context.__listeners.push(listener); } }
      },
      storage: {
        local: {
          async get(key) {
            if (onStorageGet) await onStorageGet({ key, context, page });
            if (typeof key === "string") return storage.has(key) ? { [key]: clone(storage.get(key)) } : {};
            return {};
          },
          async set(entries) {
            if (onStorageSet) await onStorageSet({ entries: clone(entries), context, page });
            for (const [key, value] of Object.entries(entries)) storage.set(key, clone(value));
          }
        }
      }
    }
  });

  function leaseOperation(message) {
    switch (message.type) {
      case "AIPM_LEASE_ACQUIRE": {
        const current = leases.get(message.conversationKey);
        const exactOwnerRecovery = current &&
          current.runId === message.runId &&
          current.documentInstanceId === message.documentInstanceId &&
          storedRun?.runId === message.runId &&
          storedRun?.status === "running";
        if (exactOwnerRecovery) {
          current.expiresAt = clock + leaseTtlMs;
          record("lease-recover", { nonce: current.nonce });
          return {
            ok: true,
            lease: {
              conversationKey: message.conversationKey,
              nonce: current.nonce,
              executionSessionId: SESSION_ID
            },
            recoveredExistingOwner: true
          };
        }
        if (current && Number(current.expiresAt) > clock) {
          record("lease-blocked", { conversationKey: message.conversationKey });
          return { ok: true, lease: null };
        }
        nonceSeq += 1;
        const nonce = `nonce-${nonceSeq}`;
        leases.set(message.conversationKey, {
          runId: message.runId,
          nonce,
          documentInstanceId: message.documentInstanceId,
          expiresAt: clock + leaseTtlMs
        });
        record("lease-acquire", { nonce });
        return { ok: true, lease: { conversationKey: message.conversationKey, nonce, executionSessionId: SESSION_ID } };
      }
      case "AIPM_LEASE_RENEW": {
        const current = leases.get(message.conversationKey);
        const owns = current && current.nonce === message.nonce && current.runId === message.runId &&
          current.documentInstanceId === message.documentInstanceId;
        if (!owns) return { ok: true, renewed: false };
        if (Number(current.expiresAt) <= clock && storedRun?.status !== "running") {
          return { ok: true, renewed: false };
        }
        current.expiresAt = clock + leaseTtlMs;
        return { ok: true, renewed: true };
      }
      case "AIPM_LEASE_RELEASE": {
        const current = leases.get(message.conversationKey);
        if (leaseReleaseFailuresRemaining > 0) {
          leaseReleaseFailuresRemaining -= 1;
          record("lease-release-failed", { mode: leaseReleaseFailure });
          if (leaseReleaseFailure === "reject") throw new Error("lease release transport failed");
          return { ok: false, released: false, error: "lease release was not confirmed" };
        }
        if (current && current.nonce === message.nonce && current.runId === message.runId) {
          leases.delete(message.conversationKey);
          record("lease-release", { nonce: message.nonce });
        }
        return { ok: true, released: true };
      }
      default:
        return { ok: true };
    }
  }

  context.__listeners = [];

  vm.runInContext(coreSource, context, { filename: "content-core.js" });
  vm.runInContext(runnerSource, context, { filename: "content-runner.js" });
  vm.runInContext(controllerSource, context, { filename: "content-controller.js" });

  context.ChatGptAdapter = trackedAdapter;
  context.sleep = async (ms) => {
    clock += Math.max(1, Math.floor(Number(ms) || 0));
    runDuePageActions();
  };
  context.READY_STABLE_MS = 0;
  context.POLL_MS = 100;

  const realExecuteRun = context.executeRun;
  context.executeRun = (...args) => {
    const result = realExecuteRun(...args);
    pending.push(Promise.resolve(result).catch(() => {}));
    return result;
  };
  const realDelayBlock = context.delayBlock;
  context.delayBlock = (run, step, token) => {
    record("delay-block-start", { stepId: step.id });
    return realDelayBlock(run, step, token);
  };

  const control = (type, extra = {}) => new Promise((resolve) => {
    const runControl = ["AIPM_PAUSE", "AIPM_RESUME", "AIPM_STOP"].includes(type);
    context.__listeners[0]({
      type,
      serviceWorkerVersion: CONTENT_VERSION,
      executionSessionId: SESSION_ID,
      expectedDocumentInstanceId: context.instanceId,
      expectedConversationKey: currentConversationKey,
      ...(runControl ? {
        expectedRunId: storedRun?.runId ?? null,
        expectedStateRevision: storedRun?.stateRevision ?? null
      } : {}),
      ...extra
    }, {}, resolve);
  });

  return {
    context,
    page,
    transcript,
    saves: () => clone(saves),
    stored: () => clone(storedRun),
    diagnostics: () => clone(storage.get("aipm.diagnostics.v1") ?? []),
    adapterCalls,
    now: () => clock,
    advance: (ms) => { clock += ms; runDuePageActions(); },
    control,
    start: (workflow = threePromptWorkflow()) => control("AIPM_START", {
      workflow,
      bindingTabId: TAB_ID,
      keepAwake: false,
      expectedRunId: storedRun?.runId ?? null
    }),
    async settle() {
      while (pending.length > 0) await pending.shift();
    },
    // Loading content-controller.js starts an initial recovery pass. Await it before
    // seeding durable state, otherwise that first pass and the test's own reload become two
    // concurrent recoveries racing the same Run.
    async ready() {
      await context.initialRecoveryPromise?.catch(() => {});
      await this.settle();
    },
    clicks: () => transcript.filter((entry) => entry.type === "click"),
    // Pin the tab's current top document; anything else becomes a stale document.
    pinCurrentDocument: () => { currentTopDocumentInstanceId = context.instanceId; },
    rotateDocument: (instanceId = "document-after-navigation") => { currentTopDocumentInstanceId = instanceId; },
    // Service Worker teardown: durable storage survives, in-memory lease bookkeeping does not.
    dropLeases: () => { leases.clear(); },
    // Another live document already owns the conversation lease.
    seizeLease: (documentInstanceId, ttlMs = 10 * 60 * 1000) => {
      leases.set(currentConversationKey, {
        runId: "foreign-run",
        nonce: "foreign-nonce",
        documentInstanceId,
        expiresAt: clock + ttlMs
      });
    },
    // --- torture-test observation / injection surface --------------------------
    conversationKey: () => currentConversationKey,
    // The tab navigated to a different ChatGPT conversation under the live runner.
    setConversationKey: (key) => { currentConversationKey = key; },
    leaseSnapshot: (key = currentConversationKey) => clone(leases.get(key) ?? null),
    storageSnapshot: (key) => clone(storage.get(key) ?? null),
    // A competing document tries to take the conversation lease for itself.
    competingAcquire: (documentInstanceId, runId = "competing-run") => leaseOperation({
      type: "AIPM_LEASE_ACQUIRE",
      conversationKey: currentConversationKey,
      runId,
      documentInstanceId
    }),
    // Replace the durable snapshot without going through a runner write, which is how
    // a corrupted / stale / hand-edited durable state reaches recovery.
    injectDurableRun: (mutate) => {
      storedRun = typeof mutate === "function" ? mutate(clone(storedRun)) : clone(mutate);
      return clone(storedRun);
    },
    // Ctrl+R: the live runner is invalidated and a new document adopts the
    // durable snapshot.
    async reload(idleMs = 0) {
      context.localRunnerToken += 1;
      await this.settle();
      clock += Math.max(0, idleMs);
      runDuePageActions();
      const reloadedAt = clock;
      context.recoveryStarted = false;
      page.text = "";
      await context.recoverIfNeeded();
      await this.settle();
      return reloadedAt;
    }
  };
}

export function promptsSent(harness) {
  return harness.clicks().map((entry) => entry.prompt);
}

export function clickPositions(harness) {
  return harness.clicks().map((entry) => entry.position);
}
