const NEW_CHAT_CONFIRMATION = "new-chat-confirmation-required";

const RUN_STATE_COPY = Object.freeze({
  idle: {
    label: "待機中",
    reason: "現在実行中の自動化はありません。",
    safetyLabel: "新しく開始できます"
  },
  running: {
    label: "実行中",
    reason: "AIの回答本文を読まず、必要な画面状態だけを確認して進行しています。",
    safetyLabel: "実行中の保存記録"
  },
  "user-paused": {
    label: "一時停止中",
    reason: "ユーザー操作で一時停止しています。",
    safetyLabel: "再開または停止を選べます"
  },
  "confirmation-required": {
    label: "確認が必要",
    reason: "自動継続する前に人間の確認を待っています。",
    safetyLabel: "確認後にだけ再開できます"
  },
  "fail-closed": {
    label: "安全のため停止",
    reason: "不確かな状態で自動継続しないよう停止しています。",
    safetyLabel: "自動再開しない安全停止"
  },
  completed: {
    label: "完了",
    reason: "予定した自動化フローを完了しました。",
    safetyLabel: "完了"
  },
  stopped: {
    label: "停止済み",
    reason: "この実行は停止済みです。",
    safetyLabel: "停止済み"
  },
  unknown: {
    label: "状態不明",
    reason: "保存された実行状態を判別できません。",
    safetyLabel: "現在状態の確認が必要"
  }
});

export function canStartRun({ targetReady = false, pageReady = false, blocker = null } = {}) {
  return targetReady === true && pageReady === true && !blocker;
}

export function canResumePausedRun(run = null) {
  if (run?.status !== "paused") return false;
  if (run.pauseReason === NEW_CHAT_CONFIRMATION && run.phase === NEW_CHAT_CONFIRMATION) return true;
  if (run.outbox) return false;
  if (run.lastErrorCode === "max_sends") return false;
  return run.resumable !== false;
}

export function displayDeliveredSendCount(run = null) {
  const stored = Number(run?.cursor?.sendsCompleted ?? 0);
  const completed = Number.isSafeInteger(stored) && stored >= 0 ? stored : 0;
  return completed + (run?.outbox?.state === "confirmed" ? 1 : 0);
}

function runningReason(run) {
  if (run?.phase === "waiting-time") return "指定時刻まで安全に待機しています。";
  if (run?.phase === "delay") return "設定した待機時間が終わるまで待っています。";
  if (run?.phase === "prepared" && run?.outbox?.state === "prepared" &&
      run?.outbox?.deliveryMode === "pending") {
    return "長文をChatGPTの添付形式へ変換し、安全確認の完了を待っています。";
  }
  return RUN_STATE_COPY.running.reason;
}

function confirmationReason(run) {
  const reasons = {
    [NEW_CHAT_CONFIRMATION]: "新しい会話への最初の送信後です。内容と対象会話の確認を待っています。",
    "manual-checkpoint": "確認ポイントに到達しました。内容の確認を待っています。",
    "draft-ready": "AIへの指示を入力欄へ入れました。自動送信はしていません。内容の確認を待っています。",
    "schedule-late": "指定時刻を許容範囲以上過ぎたため、続行してよいか確認を待っています。"
  };
  return reasons[run?.pauseReason] ?? RUN_STATE_COPY["confirmation-required"].reason;
}

// The presence of an unfinished outbox says only "a send was in flight". It does not say
// which check failed, and every fail-closed with an outbox used to render the same sentence,
// so an identity or observation failure was indistinguishable from an unconfirmed send. Name
// the actual cause when the durable record has one, and keep the generic sentence as the
// fallback for an outbox whose cause was not recorded.
function failClosedReason(run) {
  const reason = String(run?.pauseReason ?? run?.lastErrorCode ?? "");
  // A later observation failure cannot undo durable delivery confirmation.
  if (run?.outbox?.state === "confirmed") {
    let unconfirmed = "自動化を安全に続けられる状態";
    if (reason === "generation_timeout") unconfirmed = "生成完了";
    else if (reason === "composer_not_ready") unconfirmed = "次の入力が可能な状態";
    else if (reason.includes("document_identity") || reason.includes("document-identity")) {
      unconfirmed = "対象ページが送信準備時と同じページであること";
    } else if (reason.includes("conversation")) {
      unconfirmed = "対象の会話が同じであること";
    }
    return `送信は確認済みですが、${unconfirmed}を確認できないため停止しました。同じ指示は自動再送しません。`;
  }
  if (reason.includes("submission_ambiguous") || reason.includes("delivery")) {
    return "送信結果を一意に確認できないため、同じ指示を自動再送せず停止しました。";
  }
  if (reason.includes("document_identity") || reason.includes("document-identity")) {
    return "対象ページが送信準備時と同じページであることを確認できないため、安全のため停止しました。";
  }
  if (reason.includes("conversation")) {
    return "対象の会話が同じか確認できないため、別の会話へ送らず停止しました。";
  }
  if (reason.includes("max_sends") || reason.includes("max-sends")) {
    return "送信回数の上限に達したため、自動継続を停止しました。";
  }
  // An unfinished outbox still means a send was in flight, so the duplicate-send assurance
  // must remain even when the recorded cause has no dedicated sentence.
  if (run?.outbox) {
    return "送信状態を一意に確定できないため、重複送信を避けて自動継続しませんでした。";
  }
  return RUN_STATE_COPY["fail-closed"].reason;
}

/**
 * Pure projection of durable Run facts. This is presentation only: callers
 * must never use the returned kind or copy as mutation authority.
 */
export function projectRunState(run = null) {
  let kind = "unknown";
  if (!run) kind = "idle";
  else if (run.status === "running") kind = "running";
  else if (run.status === "completed") kind = "completed";
  else if (run.status === "stopped") kind = "stopped";
  else if (run.status === "paused") {
    if (run.pauseReason === "user-pause" && canResumePausedRun(run)) kind = "user-paused";
    else if (canResumePausedRun(run)) kind = "confirmation-required";
    else kind = "fail-closed";
  }

  const copy = RUN_STATE_COPY[kind];
  const reason = kind === "running"
    ? runningReason(run)
    : kind === "confirmation-required"
      ? confirmationReason(run)
      : kind === "fail-closed"
        ? failClosedReason(run)
        : copy.reason;
  return { kind, label: copy.label, reason, safetyLabel: copy.safetyLabel };
}

/** Separate, non-authoritative observation axis for the Side Panel. */
export function projectConnectionState({
  hasTarget = false,
  targetReady = false,
  pageReady = false,
  blocker = null
} = {}) {
  if (!hasTarget) {
    return { kind: "unavailable", label: "接続状態: 対象のChatGPTタブがありません" };
  }
  if (!targetReady) {
    return { kind: "unknown", label: "接続状態: 対象タブの現在状態を確認できません" };
  }
  if (!pageReady) {
    return { kind: "unavailable", label: "接続状態: 対象タブの入力欄を確認できません" };
  }
  if (blocker) {
    const labels = {
      "usage-limit": "接続状態: ChatGPTの利用上限を確認してください",
      captcha: "接続状態: CAPTCHA / 本人確認を手動で完了してください",
      "service-error": "接続状態: ChatGPTのサービスエラーを確認してください",
      "login-required": "接続状態: ChatGPTへのログインが必要です",
      "ui-blocked": "接続状態: ChatGPT上の確認画面を手動で完了してください"
    };
    return { kind: "blocked", label: labels[blocker] ?? "接続状態: ChatGPT側で手動確認が必要です" };
  }
  return { kind: "available", label: "接続状態: 対象タブから応答があります" };
}

export function projectRunUx(context = {}) {
  const nextAction = nextActionForRun(context).replace(/^次の操作:\s*/u, "");
  return {
    ...projectRunState(context.run),
    connection: projectConnectionState(context),
    nextAction
  };
}

export function completionOutcomeForRun({
  run = null,
  hasTarget = false,
  targetReady = false,
  pageReady = false,
  blocker = null
} = {}) {
  const state = projectRunState(run);
  if (state.kind === "completed") return { kind: "completed", text: "完了 — 予定した手順を完了しました。" };
  if (state.kind === "fail-closed") {
    return { kind: "fail-closed", text: "安全のため停止 — 不確かな状態では自動継続しません。" };
  }
  if (state.kind === "confirmation-required") {
    return { kind: "confirmation", text: "確認が必要 — 内容を確認して再開または停止してください。" };
  }
  if (state.kind === "user-paused") {
    return { kind: "paused", text: "一時停止中 — 再開または停止を選べます。" };
  }
  if (state.kind === "stopped") return { kind: "stopped", text: "停止済み — 必要なら新しく開始できます。" };
  if (state.kind === "running") {
    return { kind: "running", text: "実行中 — 必要なら一時停止または停止を使用できます。" };
  }
  if (!hasTarget || !targetReady || !pageReady || blocker) {
    return { kind: "attention", text: "接続確認が必要 — 対象ChatGPTタブの現在状態を確認してください。" };
  }
  return { kind: "ready", text: "待機中 — 保存済みの実行内容を確認して開始できます。" };
}

export function blockerMessage(blocker) {
  const messages = {
    "usage-limit": "ChatGPTの利用上限を検出したため停止しています。",
    captcha: "CAPTCHA / 本人確認を検出したため停止しています。自動突破は行いません。",
    "service-error": "ChatGPTのサービスエラーを検出したため停止しています。",
    "login-required": "ChatGPTへのログインが必要なため停止しています。",
    "ui-blocked": "ChatGPT上に操作を妨げる画面があるため停止しています。"
  };
  return messages[blocker] ?? "ChatGPT側で安全停止の対象を検出しました。";
}

export function nextActionForRun({
  run = null,
  hasTarget = false,
  targetReady = false,
  pageReady = false,
  blocker = null
} = {}) {
  if (!hasTarget) {
    return "次の操作: chatgpt.comを開き、上の「更新」を押してください。";
  }
  if (!targetReady || !pageReady) {
    return "次の操作: 選択中のChatGPTタブを再読み込みし、上の「更新」を押してください。";
  }
  if (blocker) {
    if (run?.status === "paused") {
      if (!canResumePausedRun(run)) {
        return "次の操作: ChatGPTタブで表示内容を確認し、必要な操作を手動で完了してから「停止」を押してください。同じ指示は自動再送されません。";
      }
      return "次の操作: ChatGPTタブで表示内容を確認し、必要な操作を手動で完了してから「再開」を押してください。";
    }
    if (run?.status === "running") {
      return "次の操作: ChatGPTタブで表示内容を確認し、必要な操作を手動で完了してください。このパネルの状態を確認し、終了するなら「停止」を押してください。";
    }
    return "次の操作: ChatGPTタブで必要な操作を手動で完了し、上の「更新」を押してください。接続状態と保存済みの実行内容を確認し、「開始」が使える状態になったら押してください。";
  }
  if (run?.status === "paused") {
    if (run.pauseReason === NEW_CHAT_CONFIRMATION && canResumePausedRun(run)) {
      return "次の操作: 同じChatGPTタブで、作成された会話と最初の指示が1回だけ送られていることを確認し、「再開」を押してください。";
    }
    if (!canResumePausedRun(run)) {
      return "次の操作: ChatGPT側の状態を確認し、「停止」を押してください。同じ指示は自動再送されません。";
    }
    if (run.pauseReason === "user-pause") {
      return "次の操作: 続けるなら「再開」、終了するなら「停止」を押してください。";
    }
    if (run.pauseReason === "manual-checkpoint") {
      return "次の操作: ChatGPTと手順を確認し、続けるなら「再開」を押してください。";
    }
    if (run.pauseReason === "draft-ready") {
      return "次の操作: ChatGPTの入力欄を確認し、必要なら自分で送信してください。生成が終わり、次へ進めてよいことを確認してから「再開」を押してください。";
    }
    if (run.pauseReason === "schedule-late") {
      return "次の操作: ChatGPTと予定時刻を確認し、続けるなら「再開」、やめるなら「停止」を押してください。";
    }
    return "次の操作: ChatGPT側の表示と入力欄を確認し、問題がなければ「再開」を押してください。";
  }
  if (run?.status === "running") {
    return "次の操作: 必要なら、いつでも「一時停止」または「停止」を押せます。";
  }
  if (run?.status === "completed") {
    return "次の操作: 結果をChatGPT側で確認するか、設定を変えて新しく開始できます。";
  }
  if (run?.status === "stopped") {
    return "次の操作: 必要なら設定を確認し、新しく「開始」を押してください。";
  }
  return "次の操作: 指示と回数を確認し、「開始」を押してください。";
}
