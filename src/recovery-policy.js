export const RECOVERY_MODES = ["safe", "completion"];
export const IDENTITY_RETRY_OPTIONS = [3, 5, 10];
export const READINESS_OPTIONS = ["normal", "long"];
export const STATUS_RECOVERY_OPTIONS = ["normal", "persistent"];

const IDENTITY_SUSPENSION_WINDOW_MS = 10_000;
const IDENTITY_SUSPENSION_PROBE_LIMIT = 12;
const IDENTITY_SUSPENSION_BACKOFF_BASE_MS = 100;
const IDENTITY_SUSPENSION_BACKOFF_MAX_MS = 1_000;

export const SAFE_RECOVERY_POLICY = Object.freeze({
  mode: "safe",
  identityAttempts: 3,
  readiness: "normal",
  statusRecovery: "normal"
});

export function normalizeRecoveryPolicy(input = {}) {
  const mode = input?.mode === "completion" ? "completion" : "safe";
  if (mode === "safe") return { ...SAFE_RECOVERY_POLICY };
  const identityAttempts = IDENTITY_RETRY_OPTIONS.includes(Number(input?.identityAttempts))
    ? Number(input.identityAttempts)
    : 5;
  const readiness = READINESS_OPTIONS.includes(input?.readiness) ? input.readiness : "long";
  const statusRecovery = STATUS_RECOVERY_OPTIONS.includes(input?.statusRecovery)
    ? input.statusRecovery
    : "persistent";
  return { mode, identityAttempts, readiness, statusRecovery };
}

export function recoveryRuntimeBounds(input = {}) {
  const policy = normalizeRecoveryPolicy(input);
  return Object.freeze({
    ...policy,
    // identityAttempts remains the short periodic-observation burst. Fresh-authority
    // boundaries use one fixed, bounded C11 suspension episode; the UI cannot expand
    // its wall-clock, probe-count, or backoff bounds.
    identityRecoveryWindowMs: IDENTITY_SUSPENSION_WINDOW_MS,
    identityRecoveryProbeLimit: IDENTITY_SUSPENSION_PROBE_LIMIT,
    identityRecoveryBackoffBaseMs: IDENTITY_SUSPENSION_BACKOFF_BASE_MS,
    identityRecoveryBackoffMaxMs: IDENTITY_SUSPENSION_BACKOFF_MAX_MS,
    readinessTimeoutMs: policy.readiness === "long" ? 60 * 60 * 1000 : 30 * 60 * 1000,
    statusRetryTimeoutMs: policy.statusRecovery === "persistent" ? 3_000 : 1_500,
    statusRetryAttempts: policy.statusRecovery === "persistent" ? 12 : 8,
    sidePanelStatusTimeoutMs: policy.statusRecovery === "persistent" ? 7_000 : 4_000
  });
}

export function recoveryModeLabel(input = {}) {
  return normalizeRecoveryPolicy(input).mode === "completion"
    ? "完了を優先"
    : "標準";
}

export function recoveryModeDescription(input = {}) {
  return normalizeRecoveryPolicy(input).mode === "completion"
    ? "安全条件は変えず、ページを操作しない状態の再確認と準備待ちを、上限内でより長く行います。完了を保証する設定ではありません。"
    : "通常の回数と待機時間で、ページを操作せずに状態を再確認します。確認には上限があります。";
}

export const RECOVERY_SAFETY_DESCRIPTION =
  "どちらも送信結果が不明な指示は自動再送しません。対象タブ・会話・ページの確認、同じ会話の同時操作防止、最大50回の自動送信、回答本文を読まない安全条件は同じです。";
