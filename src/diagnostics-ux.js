/*
  Pure diagnostics presentation.

  This module accepts already-observed metadata and returns an allowlisted view
  model. It performs no I/O and grants no authority. Prompt/assistant text,
  renderer content, raw Error messages and authority identifiers are never
  copied into the result.
*/

const CATEGORY_LABELS = Object.freeze({
  TARGET: "Target",
  IDENTITY: "Identity",
  DELIVERY: "Delivery",
  ATTACHMENT: "Attachment",
  SERVICE: "Service",
  BOUND: "Bound",
  USER: "User",
  UNKNOWN: "Unknown"
});

const KNOWN_EVENT_CODES = new Set([
  "checkpoint",
  "delay_pending",
  "delay_started",
  "document_identity_recovered",
  "document_identity_unconfirmed",
  "draft_ready",
  "new_chat_confirmation_required",
  "new_chat_target_confirmed",
  "paste_attachment_settlement",
  "pause_requested",
  "recovery_pre_submit",
  "run_completed",
  "run_paused",
  "run_started",
  "run_stopped",
  "schedule_armed",
  "schedule_late",
  "schedule_skipped",
  "send_clicked",
  "send_confirmed",
  "send_prepared"
]);

const KNOWN_OBSERVATION_STATES = new Set([
  "attachment-pending",
  "backpressure",
  "confirmed",
  "document-lifecycle-changed",
  "execute-script-rejected",
  "execution-session-changed",
  "identity-fields-unavailable",
  "invalid",
  "late",
  "null",
  "pending",
  "probe-result-invalid",
  "recovered",
  "stale-result",
  "timeout",
  "top-frame-missing",
  "unknown"
]);

const KNOWN_IDENTITY_FAILURE_CODES = new Set([
  "IDENTITY_BACKPRESSURE",
  "IDENTITY_EXECUTION_SESSION_CHANGED",
  "IDENTITY_FIELDS_UNAVAILABLE",
  "IDENTITY_LIFECYCLE_INVALIDATED",
  "IDENTITY_PROBE_INVALID",
  "IDENTITY_PROBE_REJECTED",
  "IDENTITY_PROBE_TIMEOUT",
  "IDENTITY_STALE_RESULT",
  "IDENTITY_TOP_FRAME_MISSING",
  "IDENTITY_UNKNOWN"
]);

const KNOWN_PHASES = new Set([
  "awaiting_completion",
  "command-delivery",
  "completed",
  "delay",
  "discovery",
  "draft-ready",
  "injection",
  "manual-checkpoint",
  "new-chat-confirmation-required",
  "paused",
  "permissions",
  "post-injection-status",
  "prepared",
  "probe",
  "ready",
  "relay",
  "status",
  "status-retry",
  "stopped",
  "tabs-query",
  "waiting-time"
]);

const TEMPLATE = Object.freeze({
  TARGET: {
    severity: "attention",
    title: "対象タブの確認が必要です",
    summary: "対象のChatGPT画面または入力欄を安全に確認できませんでした。",
    safetyMeaning: "確認できない画面には自動操作しません。",
    nextAction: "対象のChatGPTタブを確認・再読み込みし、Side Panelの「更新」を押してください。"
  },
  IDENTITY: {
    severity: "safety-stop",
    title: "対象ページを確認できませんでした",
    summary: "対象ページまたは会話が同じものか確認できなかったため、安全のため自動継続しませんでした。",
    safetyMeaning: "別の画面や会話へ誤って送信しないための停止です。",
    nextAction: "ChatGPT側を確認し、必要なら停止して新しい実行を開始してください。"
  },
  DELIVERY: {
    severity: "safety-stop",
    title: "送信結果を確認できませんでした",
    summary: "送信結果を一意に確認できませんでした。重複送信を避けるため、同じ指示を自動再送していません。",
    safetyMeaning: "送信済み・未送信のどちらとも断定せず、安全側で停止しています。",
    nextAction: "ChatGPT側の入力欄と送信履歴を確認し、Side Panelからこの実行を停止してください。"
  },
  ATTACHMENT: {
    severity: "safety-stop",
    title: "入力欄の添付状態を確認してください",
    summary: "入力欄に既存または確認できない添付状態があったため、内容を書き換えず停止しました。",
    safetyMeaning: "既存の下書きや添付を壊さないための停止です。",
    nextAction: "ChatGPT側の入力欄と添付を確認し、必要なら整理してから新しい実行を開始してください。"
  },
  SERVICE: {
    severity: "attention",
    title: "ChatGPT側で手動確認が必要です",
    summary: "ChatGPT側の利用制限、ログイン、本人確認、またはサービス状態を確認してください。",
    safetyMeaning: "確認画面や制限を自動で回避せず停止します。",
    nextAction: "ChatGPT側で必要な操作を手動で完了し、Side Panelの状態を確認してください。"
  },
  BOUND: {
    severity: "attention",
    title: "設定された安全上限で停止しました",
    summary: "送信上限または時間・回数の上限に達したため、自動継続を停止しました。",
    safetyMeaning: "無制限に試行や送信を続けないための停止です。",
    nextAction: "実行結果と設定を確認し、必要な場合だけ新しい実行を開始してください。"
  },
  USER: {
    severity: "info",
    title: "ユーザーの確認を待っています",
    summary: "一時停止または確認ポイントで、次の操作を待っています。",
    safetyMeaning: "確認なしに次の送信へ進みません。",
    nextAction: "ChatGPT側を確認し、続ける場合は再開、終了する場合は停止してください。"
  },
  UNKNOWN: {
    severity: "attention",
    title: "詳細情報を表示できませんでした",
    summary: "診断情報を安全な説明へ分類できませんでした。",
    safetyMeaning: "診断表示だけで実行状態や送信可否は変更されません。",
    nextAction: "上のステータスと理由、およびChatGPT側の状態を確認してください。"
  }
});

function boundedCode(value, max = 64) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(trimmed)) return null;
  return trimmed.slice(0, max);
}

function boundedInteger(value, max) {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return Math.min(value, max);
}

function isoOrNull(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function normalizedCode(value) {
  return boundedCode(value)?.toLowerCase().replace(/-/gu, "_") ?? null;
}

function classify(code) {
  if (!code) return "UNKNOWN";
  if (code === "user_pause" || code === "user_stop" || code === "manual_checkpoint" ||
      code === "draft_ready" || code === "new_chat_confirmation_required" || code === "pause_requested" ||
      code === "checkpoint" || code === "schedule_late") return "USER";
  if (code.includes("attachment") || code.includes("paste_attachment")) return "ATTACHMENT";
  if (code.includes("submission") || code.includes("delivery") || code.includes("outbox") ||
      code === "recovery_ambiguous" || code === "send_clicked" || code === "send_confirmed" ||
      code === "send_prepared" || code === "recovery_pre_submit") return "DELIVERY";
  if (code.includes("document_identity") || code.includes("conversation_identity") ||
      code === "conversation_changed" || code === "content_identity_missing" || code === "identity_timeout") {
    return "IDENTITY";
  }
  if (code.includes("usage_limit") || code.includes("captcha") || code.includes("login_required") ||
      code.includes("service_error") || code === "ui_blocked") return "SERVICE";
  if (code.startsWith("tab_") || code.startsWith("content_") || code.startsWith("site_access") ||
      code.includes("composer") || code === "send_unavailable" || code === "draft_present" ||
      code === "not_chatgpt_tab" || code === "target_tab_required" || code === "chatgpt_tab_discovery_incomplete") {
    return "TARGET";
  }
  if (code.includes("max_sends") || code.includes("timeout") || code.includes("schedule_late") ||
      code.includes("bounded") || code === "generation_timeout") return "BOUND";
  if (KNOWN_EVENT_CODES.has(code)) return "USER";
  return "UNKNOWN";
}

function detailsFrom(raw, { code, category } = {}) {
  const attempt = boundedInteger(raw?.attempt, 50);
  const totalAttempts = boundedInteger(raw?.totalAttempts, 50);
  const consecutiveUnavailable = boundedInteger(raw?.consecutiveUnavailable, 50);
  const durationMs = boundedInteger(raw?.durationMs ?? raw?.elapsedMs, 600_000);
  const phaseCandidate = boundedCode(raw?.phase, 40);
  const phase = KNOWN_PHASES.has(phaseCandidate) ? phaseCandidate : null;
  const recoveryMode = ["safe", "completion"].includes(raw?.recoveryMode) ? raw.recoveryMode : null;
  const observationCandidate = boundedCode(raw?.observationState ?? raw?.reason ?? raw?.lastState, 48);
  const observationState = KNOWN_OBSERVATION_STATES.has(observationCandidate) ? observationCandidate : null;
  const deliveryCertainty = ["confirmed", "ambiguous", "pending", "unknown"].includes(raw?.deliveryCertainty)
    ? raw.deliveryCertainty
    : (category === "DELIVERY" && code === "send_confirmed" ? "confirmed" : null);
  const sourceLayer = ["side-panel", "workspace", "background", "content", "connection"].includes(raw?.sourceLayer)
    ? raw.sourceLayer
    : null;
  const failureCodeCandidate = boundedCode(raw?.failureCode, 48);
  const failureCode = KNOWN_IDENTITY_FAILURE_CODES.has(failureCodeCandidate) ? failureCodeCandidate : null;
  const identitySource = ["probe", "document-lifetime-grant", "bound-content-sender"].includes(raw?.identitySource)
    ? raw.identitySource
    : null;
  return {
    attempt,
    totalAttempts,
    consecutiveUnavailable,
    durationMs,
    recoveryMode,
    observationState,
    timestamp: isoOrNull(raw?.at ?? raw?.timestamp),
    deliveryCertainty,
    sourceLayer,
    failureCode,
    identitySource,
    phase
  };
}

function specialize(base, code) {
  if (code === "send_confirmed") {
    return {
      ...base,
      severity: "info",
      title: "送信確認の保存記録",
      summary: "保存された診断情報では、送信確認が記録されています。",
      safetyMeaning: "この記録だけを現在の送信権限には使用しません。",
      nextAction: "現在の実行状態は、上のステータスと理由で確認してください。"
    };
  }
  if (["send_prepared", "send_clicked", "recovery_pre_submit"].includes(code)) {
    return {
      ...base,
      severity: "info",
      title: "送信処理の保存記録",
      summary: "送信処理の途中経過が記録されています。",
      safetyMeaning: "途中記録だけで送信済み・未送信を断定しません。",
      nextAction: "現在の実行状態は、上のステータスと理由で確認してください。"
    };
  }
  if (code === "document_identity_recovered") {
    return {
      ...base,
      severity: "info",
      title: "対象ページ確認の復旧記録",
      summary: "一時的に確認できなかった対象ページを、限られた回数の再確認で確認できた記録です。",
      safetyMeaning: "この保存記録は新しい操作権限を与えません。",
      nextAction: "現在の実行状態は、上のステータスと理由で確認してください。"
    };
  }
  if (["run_started", "run_completed", "run_stopped", "new_chat_target_confirmed"].includes(code)) {
    return {
      ...base,
      severity: "info",
      title: "実行状態の保存記録",
      summary: "実行状態の変化が保存された診断情報に記録されています。",
      safetyMeaning: "保存記録は現在の接続状態や操作権限を証明しません。",
      nextAction: "現在の実行状態は、上のステータスと理由で確認してください。"
    };
  }
  if (code === "document_identity_unconfirmed") {
    return {
      ...base,
      summary: "対象ページが送信準備時と同じページか確認できなかったため、安全のため自動継続しませんでした。"
    };
  }
  if (code === "conversation_identity_unknown" || code === "conversation_changed") {
    return {
      ...base,
      summary: "対象の会話が同じものか確認できなかったため、別の会話へ送らず停止しました。"
    };
  }
  if (code === "unexpected_attachment") {
    return {
      ...base,
      summary: "入力欄に既存の添付状態があったため、内容を書き換えず停止しました。"
    };
  }
  if (code === "max_sends") {
    return {
      ...base,
      title: "送信回数の上限で停止しました",
      summary: "1回の実行に設定された送信上限へ達したため、自動継続を停止しました。",
      safetyMeaning: "上限を超える送信を防ぐ通常の安全動作です。"
    };
  }
  if (code === "captcha") return { ...base, summary: "CAPTCHAまたは本人確認を検出したため、自動操作を停止しました。" };
  if (code === "login_required") return { ...base, summary: "ChatGPTへのログインが必要なため、自動操作を停止しました。" };
  if (code === "usage_limit") return { ...base, summary: "ChatGPTの利用上限を検出したため、自動操作を停止しました。" };
  if (code === "service_error") return { ...base, summary: "ChatGPT側のサービスエラーを検出したため、自動操作を停止しました。" };
  return base;
}

/** Returns only allowlisted, presentation-only fields. */
export function projectDiagnostic(raw = {}) {
  const candidate = raw?.code ?? raw?.lastErrorCode ?? raw?.pauseReason ?? raw?.type ?? raw?.blocker;
  const normalized = normalizedCode(candidate);
  const category = classify(normalized);
  const safeUnknown = ["unknown_connection_failure", "unknown_diagnostic"].includes(normalized);
  const knownCode = category === "UNKNOWN" && !safeUnknown
    ? "UNKNOWN_DIAGNOSTIC"
    : boundedCode(candidate);
  const copy = specialize(TEMPLATE[category], normalized);
  return {
    severity: copy.severity,
    category,
    categoryLabel: CATEGORY_LABELS[category],
    title: copy.title,
    summary: copy.summary,
    safetyMeaning: copy.safetyMeaning,
    nextAction: copy.nextAction,
    code: knownCode,
    details: detailsFrom(raw, { code: normalized, category })
  };
}

export function projectRunDiagnostic(run = null, { blocker = null } = {}) {
  if (!run || typeof run !== "object") return blocker ? projectDiagnostic({ blocker }) : null;
  const code = run.lastErrorCode ?? run.pauseReason ?? blocker;
  if (code) {
    return projectDiagnostic({
      code,
      recoveryMode: run.workflow?.recovery?.mode,
      deliveryCertainty: run.outbox?.state,
      timestamp: run.updatedAt
    });
  }
  if (run.outbox && run.status === "paused" && run.resumable === false) {
    const projected = projectDiagnostic({ code: "submission_ambiguous", deliveryCertainty: "ambiguous", timestamp: run.updatedAt });
    return { ...projected, code: null };
  }
  return blocker ? projectDiagnostic({ blocker }) : null;
}

export function projectDiagnosticEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const type = normalizedCode(raw.type);
  if (!type || !KNOWN_EVENT_CODES.has(type)) return projectDiagnostic({ code: "UNKNOWN_DIAGNOSTIC", at: raw.at });
  return projectDiagnostic({ ...raw, code: type });
}

export function diagnosticDetailsRows(projection) {
  if (!projection || typeof projection !== "object") return [];
  const rows = [];
  if (projection.categoryLabel) rows.push(["Category", projection.categoryLabel]);
  if (projection.code) rows.push(["Code", projection.code]);
  const details = projection.details ?? {};
  if (details.attempt != null) {
    rows.push(["Attempts", details.totalAttempts == null ? String(details.attempt) : `${details.attempt} / ${details.totalAttempts}`]);
  } else if (details.consecutiveUnavailable != null) {
    rows.push(["Attempts", String(details.consecutiveUnavailable)]);
  }
  if (details.durationMs != null) rows.push(["Elapsed", `${details.durationMs} ms`]);
  if (details.recoveryMode) rows.push(["Recovery", details.recoveryMode]);
  if (details.observationState) rows.push(["Observation", details.observationState]);
  if (details.timestamp) rows.push(["Timestamp", details.timestamp]);
  if (details.deliveryCertainty) rows.push(["Delivery", details.deliveryCertainty]);
  if (details.sourceLayer) rows.push(["Source", details.sourceLayer]);
  if (details.failureCode) rows.push(["Identity failure", details.failureCode]);
  if (details.identitySource) rows.push(["Identity source", details.identitySource]);
  if (details.phase) rows.push(["Phase", details.phase]);
  return rows;
}

export function diagnosticsLevelIsDetailed(value) {
  return value === "detailed";
}
