import { projectDiagnostic } from "./diagnostics-ux.js";

const KNOWN_CODES = new Set([
  "SITE_ACCESS_DENIED",
  "SITE_ACCESS_CHECK_TIMEOUT",
  "TAB_ENUMERATION_TIMEOUT",
  "TAB_ENUMERATION_FAILED",
  "TAB_DISCOVERY_FAILED",
  "TAB_STATUS_TIMEOUT",
  "TAB_STATUS_FAILED",
  "TAB_ORIGIN_UNAVAILABLE",
  "TAB_NAVIGATING",
  "NOT_CHATGPT_TAB",
  "TARGET_TAB_REQUIRED",
  "CONTENT_STATUS_ERROR",
  "CONTENT_PROBE_TIMEOUT",
  "CONTENT_PROBE_INVALID",
  "CONTENT_PROBE_FAILED",
  "CONTENT_VERSION_MISMATCH",
  "CONTENT_PROVIDER_MISMATCH",
  "CONTENT_IDENTITY_MISSING",
  "CONTENT_RECEIVER_TIMEOUT",
  "CONTENT_RECEIVER_UNREACHABLE",
  "CONTENT_BOOTSTRAP_UNREACHABLE",
  "CONTENT_INJECTION_UNCERTAIN",
  "CONTENT_INJECTION_TIMEOUT",
  "CONTENT_INJECTION_FAILED",
  "COMMAND_DELIVERY_TIMEOUT",
  "COMMAND_DELIVERY_FAILED",
  "CHATGPT_TAB_DISCOVERY_INCOMPLETE"
]);

const KNOWN_PHASES = new Set([
  "permissions",
  "tabs-query",
  "discovery",
  "status",
  "status-retry",
  "probe",
  "injection",
  "post-injection-status",
  "command-delivery",
  "relay"
]);

const RELAY_PHASES = {
  TARGET_TAB_REQUIRED: "relay",
  NOT_CHATGPT_TAB: "probe",
  CONTENT_STATUS_ERROR: "status",
  CONTENT_PROBE_TIMEOUT: "probe",
  CONTENT_PROBE_INVALID: "probe",
  CONTENT_PROBE_FAILED: "probe",
  CONTENT_VERSION_MISMATCH: "probe",
  CONTENT_PROVIDER_MISMATCH: "status",
  CONTENT_IDENTITY_MISSING: "status",
  TAB_STATUS_TIMEOUT: "status",
  TAB_STATUS_FAILED: "status",
  CONTENT_RECEIVER_TIMEOUT: "status-retry",
  CONTENT_RECEIVER_UNREACHABLE: "status-retry",
  CONTENT_BOOTSTRAP_UNREACHABLE: "status-retry",
  CONTENT_INJECTION_UNCERTAIN: "injection",
  CONTENT_INJECTION_TIMEOUT: "injection",
  CONTENT_INJECTION_FAILED: "injection",
  COMMAND_DELIVERY_TIMEOUT: "command-delivery",
  COMMAND_DELIVERY_FAILED: "command-delivery"
};

const GUIDANCE = {
  SITE_ACCESS_DENIED: "Edgeの拡張機能設定でchatgpt.comへのサイトアクセスを許可してください。",
  SITE_ACCESS_CHECK_TIMEOUT: "サイトアクセス確認が時間切れです。Edgeを再起動して再確認してください。",
  TAB_ENUMERATION_TIMEOUT: "タブ一覧取得が時間切れです。Edgeを再起動して再確認してください。",
  TAB_ENUMERATION_FAILED: "タブ一覧を取得できません。Edgeを再起動して再確認してください。",
  TAB_DISCOVERY_FAILED: "対象タブの検出処理に失敗しました。対象タブを前面にして再読み込みしてください。",
  TAB_STATUS_TIMEOUT: "ChatGPTタブの状態確認が時間切れです。ChatGPTタブを再読み込みしてください。",
  TAB_STATUS_FAILED: "ChatGPTタブの状態を確認できません。ChatGPTタブを再読み込みしてください。",
  TAB_ORIGIN_UNAVAILABLE: "対象タブがChatGPTのページか安全に確認できません。対象タブを前面にして再読み込みしてください。",
  TAB_NAVIGATING: "対象タブが移動中です。ページ読み込み完了後に再確認してください。",
  NOT_CHATGPT_TAB: "選択したタブをChatGPTとして確認できません。対象タブを確認してください。",
  TARGET_TAB_REQUIRED: "操作対象のChatGPTタブを明示的に選択してください。",
  CONTENT_STATUS_ERROR: "ChatGPTタブから取得した状態を安全に確認できません。ChatGPTタブを再読み込みしてください。",
  CONTENT_PROBE_TIMEOUT: "ChatGPTタブの確認が時間切れです。サイトアクセスを確認して再読み込みしてください。",
  CONTENT_PROBE_INVALID: "ChatGPTタブの確認結果を利用できません。ChatGPTタブを再読み込みしてください。",
  CONTENT_PROBE_FAILED: "ChatGPTタブを安全に確認できません。サイトアクセスを確認して再読み込みしてください。",
  CONTENT_VERSION_MISMATCH: "拡張機能とChatGPTタブの内部状態が一致しません。拡張機能とChatGPTタブを再読み込みしてください。",
  CONTENT_PROVIDER_MISMATCH: "対象ページをChatGPTとして確認できません。ChatGPTタブを再読み込みしてください。",
  CONTENT_IDENTITY_MISSING: "ChatGPTタブのページまたは会話が同じものか確認できません。ChatGPTタブを再読み込みしてください。",
  CONTENT_RECEIVER_TIMEOUT: "ChatGPTタブとの再接続が時間切れです。ChatGPTタブを再読み込みしてください。",
  CONTENT_RECEIVER_UNREACHABLE: "ChatGPTタブへ接続できません。ChatGPTタブを再読み込みしてください。",
  CONTENT_BOOTSTRAP_UNREACHABLE: "ChatGPTタブ側の準備完了を確認できません。ChatGPTタブを再読み込みしてください。",
  CONTENT_INJECTION_UNCERTAIN: "ChatGPTタブ側の準備結果を確認できないため、安全のため停止しています。ChatGPTタブを再読み込みしてください。",
  CONTENT_INJECTION_TIMEOUT: "ChatGPTタブ側の準備が時間切れです。サイトアクセスを確認して再読み込みしてください。",
  CONTENT_INJECTION_FAILED: "ChatGPTタブ側の準備に失敗しました。サイトアクセスを確認して再読み込みしてください。",
  COMMAND_DELIVERY_TIMEOUT: "操作の到達確認が時間切れです。自動再送せず、ChatGPT側の状態を確認してください。",
  COMMAND_DELIVERY_FAILED: "操作の到達を確認できません。自動再送せず、ChatGPT側の状態を確認してください。",
  CHATGPT_TAB_DISCOVERY_INCOMPLETE: "ChatGPTタブを安全に特定できません。対象タブを前面にして再読み込みしてください。",
  UNKNOWN_CONNECTION_FAILURE: "接続失敗の原因を安全に特定できませんでした。ChatGPTタブを確認し、必要なら再読み込みしてください。"
};

function boundedFailure(value) {
  if (!value || typeof value !== "object") return null;
  const rawCode = typeof value.code === "string" ? value.code : null;
  const code = rawCode && KNOWN_CODES.has(rawCode) ? rawCode : "UNKNOWN_CONNECTION_FAILURE";
  const rawPhase = typeof value.phase === "string" ? value.phase : null;
  const phase = rawPhase && KNOWN_PHASES.has(rawPhase) ? rawPhase : "unknown";
  const tabId = Number.isInteger(value.tabId) ? value.tabId : null;
  return { code, phase, tabId };
}

export function diagnosticFromRelayFailure(relayErrorCode, selectedTabId) {
  if (typeof relayErrorCode !== "string" || !relayErrorCode) return null;
  const phase = RELAY_PHASES[relayErrorCode] ?? "relay";
  return boundedFailure({ code: relayErrorCode, phase, tabId: selectedTabId });
}

function emptyDiagnosticState(tabId = null) {
  return {
    tabId: Number.isInteger(tabId) ? tabId : null,
    pendingStatusFailure: null,
    latchedDiagnostic: null
  };
}

export function updateConnectionDiagnosticState(state, event = {}) {
  const current = state && typeof state === "object"
    ? state
    : emptyDiagnosticState(event?.tabId);
  const eventTabId = Number.isInteger(event?.tabId) ? event.tabId : null;

  if (event?.type === "target-changed") return emptyDiagnosticState(eventTabId);
  if (eventTabId == null || current.tabId !== eventTabId) return current;

  if (event?.type === "relay-succeeded" && event?.requestType === "AIPM_GET_STATUS") {
    return emptyDiagnosticState(current.tabId);
  }

  if (event?.type !== "relay-failed" || !event?.diagnostic) return current;
  if (event.requestType !== "AIPM_GET_STATUS") {
    return {
      ...current,
      pendingStatusFailure: null,
      latchedDiagnostic: event.diagnostic
    };
  }

  if (current.pendingStatusFailure) {
    return {
      ...current,
      pendingStatusFailure: null,
      latchedDiagnostic: event.diagnostic
    };
  }

  return {
    ...current,
    pendingStatusFailure: event.diagnostic
  };
}

export function selectConnectionDiagnostic(response, selectedTabId) {
  const tabId = Number.isInteger(selectedTabId) ? selectedTabId : null;
  if (response?.siteAccessGranted === false) {
    return { code: "SITE_ACCESS_DENIED", phase: "permissions", tabId };
  }

  const errors = Array.isArray(response?.discoveryErrors)
    ? response.discoveryErrors.map(boundedFailure).filter(Boolean)
    : [];
  const selectedErrors = tabId == null ? [] : errors.filter((error) => error.tabId === tabId);
  if (selectedErrors.length > 0) return selectedErrors.at(-1);

  if (typeof response?.errorCode === "string") {
    return boundedFailure({ code: response.errorCode, phase: "discovery", tabId });
  }

  return null;
}

export function formatConnectionDiagnostic(diagnostic) {
  const projected = projectConnectionDiagnostic(diagnostic);
  return projected ? `${projected.title} — ${projected.summary} ${projected.nextAction}` : "";
}

export function projectConnectionDiagnostic(diagnostic) {
  if (!diagnostic) return null;
  const safe = boundedFailure(diagnostic) ?? {
    code: "UNKNOWN_CONNECTION_FAILURE",
    phase: "unknown",
    tabId: null
  };
  const projected = projectDiagnostic({
    code: safe.code,
    phase: safe.phase,
    sourceLayer: "connection"
  });
  return {
    ...projected,
    nextAction: GUIDANCE[safe.code] ?? GUIDANCE.UNKNOWN_CONNECTION_FAILURE
  };
}
