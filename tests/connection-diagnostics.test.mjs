import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  diagnosticFromRelayFailure,
  formatConnectionDiagnostic,
  projectConnectionDiagnostic,
  selectConnectionDiagnostic,
  updateConnectionDiagnosticState
} from "../src/connection-diagnostics.js";

test("site access denial takes precedence without exposing raw browser data", () => {
  const diagnostic = selectConnectionDiagnostic({
    siteAccessGranted: false,
    discoveryErrors: [{ code: "CONTENT_PROBE_FAILED", phase: "probe", tabId: 42 }]
  }, 42);
  assert.deepEqual(diagnostic, { code: "SITE_ACCESS_DENIED", phase: "permissions", tabId: 42 });
  assert.doesNotMatch(formatConnectionDiagnostic(diagnostic), /SITE_ACCESS_DENIED/);
  assert.match(formatConnectionDiagnostic(diagnostic), /サイトアクセス/);
  assert.equal(projectConnectionDiagnostic(diagnostic).code, "SITE_ACCESS_DENIED");
});

test("selected tab receives its bounded discovery code and phase", () => {
  const diagnostic = selectConnectionDiagnostic({
    siteAccessGranted: true,
    discoveryErrors: [
      { code: "TAB_STATUS_FAILED", phase: "status", tabId: 41 },
      { code: "CONTENT_PROBE_TIMEOUT", phase: "probe", tabId: 42 }
    ]
  }, 42);
  assert.deepEqual(diagnostic, { code: "CONTENT_PROBE_TIMEOUT", phase: "probe", tabId: 42 });
  assert.match(formatConnectionDiagnostic(diagnostic), /ChatGPTタブの確認が時間切れ/);
  assert.doesNotMatch(formatConnectionDiagnostic(diagnostic), /CONTENT_PROBE_TIMEOUT/);
  assert.equal(projectConnectionDiagnostic(diagnostic).details.phase, "probe");
});

test("primary connection guidance hides implementation jargon while retaining diagnostic codes", () => {
  const cases = [
    ["TAB_ORIGIN_UNAVAILABLE", "discovery"],
    ["TAB_STATUS_FAILED", "status"],
    ["CONTENT_PROBE_TIMEOUT", "probe"],
    ["CONTENT_VERSION_MISMATCH", "probe"],
    ["CONTENT_PROVIDER_MISMATCH", "status"],
    ["CONTENT_IDENTITY_MISSING", "status"],
    ["CONTENT_RECEIVER_TIMEOUT", "status-retry"],
    ["CONTENT_BOOTSTRAP_UNREACHABLE", "status-retry"],
    ["CONTENT_INJECTION_FAILED", "injection"]
  ];

  for (const [code, phase] of cases) {
    const diagnostic = { code, phase, tabId: 42 };
    const projection = projectConnectionDiagnostic(diagnostic);
    const message = formatConnectionDiagnostic(diagnostic);
    assert.equal(projection.code, code);
    assert.match(message, /ChatGPT|拡張機能|対象タブ/);
    assert.doesNotMatch(message, /Content Script|Service Worker|origin|provider|document|identity|receiver|version|注入/i);
  }
});

test("injection failures remain distinguishable", () => {
  const diagnostic = selectConnectionDiagnostic({
    siteAccessGranted: true,
    discoveryErrors: [{ code: "CONTENT_INJECTION_FAILED", phase: "injection", tabId: 7 }]
  }, 7);
  assert.deepEqual(diagnostic, { code: "CONTENT_INJECTION_FAILED", phase: "injection", tabId: 7 });
});

test("authoritative relay code is converted without a second discovery guess", () => {
  const diagnostic = diagnosticFromRelayFailure("CONTENT_PROBE_TIMEOUT", 42);
  assert.deepEqual(diagnostic, { code: "CONTENT_PROBE_TIMEOUT", phase: "probe", tabId: 42 });
});

test("unknown relay code is collapsed before UI display", () => {
  const diagnostic = diagnosticFromRelayFailure("SECRET_RAW_ERROR", 9);
  assert.deepEqual(diagnostic, { code: "UNKNOWN_CONNECTION_FAILURE", phase: "relay", tabId: 9 });
  const message = formatConnectionDiagnostic(diagnostic);
  assert.doesNotMatch(message, /SECRET_RAW_ERROR/);
});

test("unknown discovery values are collapsed instead of echoing raw diagnostics", () => {
  const diagnostic = selectConnectionDiagnostic({
    siteAccessGranted: true,
    discoveryErrors: [{ code: "SECRET_RAW_ERROR", phase: "raw-browser-message", tabId: 9 }]
  }, 9);
  assert.deepEqual(diagnostic, { code: "UNKNOWN_CONNECTION_FAILURE", phase: "unknown", tabId: 9 });
  const message = formatConnectionDiagnostic(diagnostic);
  assert.doesNotMatch(message, /SECRET_RAW_ERROR|raw-browser-message/);
});

test("errors for other tabs are not shown on the selected target", () => {
  const diagnostic = selectConnectionDiagnostic({
    siteAccessGranted: true,
    discoveryErrors: [{ code: "CONTENT_PROBE_FAILED", phase: "probe", tabId: 11 }]
  }, 12);
  assert.equal(diagnostic, null);
});

test("sidepanel preserves relayErrorCode for the diagnostics UI", async () => {
  const source = await readFile(new URL("../src/sidepanel.js", import.meta.url), "utf8");
  assert.match(source, /response\?\.relayErrorCode/);
  assert.match(source, /relayError\.code = relayErrorCode/);
  assert.match(source, /relayError\.phase = response\.relayErrorPhase/);
  assert.match(source, /relayError\.retryAfterMs = Math\.min\(60_000/);
  assert.match(source, /aipm:connection-diagnostic/);
  assert.match(source, /aipm:connection-diagnostic-success/);
});

test("one transient status relay failure stays hidden until it repeats", () => {
  const diagnostic = diagnosticFromRelayFailure("CONTENT_STATUS_ERROR", 42);
  const selected = updateConnectionDiagnosticState(null, { type: "target-changed", tabId: 42 });
  const firstFailure = updateConnectionDiagnosticState(selected, {
    type: "relay-failed",
    tabId: 42,
    requestType: "AIPM_GET_STATUS",
    diagnostic
  });
  assert.equal(firstFailure.latchedDiagnostic, null);
  assert.deepEqual(firstFailure.pendingStatusFailure, diagnostic);

  const repeatedFailure = updateConnectionDiagnosticState(firstFailure, {
    type: "relay-failed",
    tabId: 42,
    requestType: "AIPM_GET_STATUS",
    diagnostic
  });
  assert.deepEqual(repeatedFailure.latchedDiagnostic, diagnostic);
});

test("a successful status relay clears the same tab diagnostic latch", () => {
  const diagnostic = diagnosticFromRelayFailure("CONTENT_PROBE_FAILED", 42);
  let state = updateConnectionDiagnosticState(null, { type: "target-changed", tabId: 42 });
  state = updateConnectionDiagnosticState(state, {
    type: "relay-failed",
    tabId: 42,
    requestType: "AIPM_START",
    diagnostic
  });
  assert.deepEqual(state.latchedDiagnostic, diagnostic);

  state = updateConnectionDiagnosticState(state, {
    type: "relay-succeeded",
    tabId: 42,
    requestType: "AIPM_GET_STATUS"
  });
  assert.equal(state.latchedDiagnostic, null);
  assert.equal(state.pendingStatusFailure, null);
});

test("healthy status events cannot clear another tab diagnostic", () => {
  const diagnostic = diagnosticFromRelayFailure("CONTENT_PROBE_FAILED", 42);
  let state = updateConnectionDiagnosticState(null, { type: "target-changed", tabId: 42 });
  state = updateConnectionDiagnosticState(state, {
    type: "relay-failed",
    tabId: 42,
    requestType: "AIPM_START",
    diagnostic
  });
  const unchanged = updateConnectionDiagnosticState(state, {
    type: "relay-succeeded",
    tabId: 43,
    requestType: "AIPM_GET_STATUS"
  });
  assert.deepEqual(unchanged, state);
});
