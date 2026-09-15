import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  diagnosticDetailsRows,
  diagnosticsLevelIsDetailed,
  projectDiagnostic,
  projectDiagnosticEvent,
  projectRunDiagnostic
} from "../src/diagnostics-ux.js";
import { projectRunState } from "../src/run-ux.js";
import { mergeSettings, normalizeSettings } from "../src/settings-store.js";
import { projectRun, projectRunList } from "../src/workspace-projection.js";
import { installSidePanelHarness, tick } from "./helpers/sidepanel-harness.mjs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function primaryText(value) {
  return [value.title, value.summary, value.safetyMeaning, value.nextAction].join(" ");
}

test("A: identity failure is human-readable while code stays advanced", () => {
  const projected = projectDiagnostic({
    code: "document_identity_unconfirmed",
    attempt: 3,
    totalAttempts: 3,
    durationMs: 1480,
    failureCode: "IDENTITY_PROBE_TIMEOUT",
    identitySource: "probe",
    promptBody: "PROMPT SECRET",
    assistantBody: "ASSISTANT SECRET"
  });
  assert.equal(projected.category, "IDENTITY");
  assert.match(projected.summary, /対象ページ.*確認できなかった/);
  assert.doesNotMatch(primaryText(projected), /document_identity_unconfirmed/);
  assert.deepEqual(diagnosticDetailsRows(projected).slice(0, 4), [
    ["Category", "Identity"],
    ["Code", "document_identity_unconfirmed"],
    ["Attempts", "3 / 3"],
    ["Elapsed", "1480 ms"]
  ]);
  assert.deepEqual(diagnosticDetailsRows(projected).slice(-2), [
    ["Identity failure", "IDENTITY_PROBE_TIMEOUT"],
    ["Identity source", "probe"]
  ]);
  assert.doesNotMatch(JSON.stringify(projected), /PROMPT SECRET|ASSISTANT SECRET/);
});

test("A2: identity diagnostics expose only allowlisted primitive failure metadata", () => {
  const projected = projectDiagnostic({
    code: "document_identity_unconfirmed",
    failureCode: "PRIVATE_RENDERER_ERROR",
    identitySource: "untrusted-page",
    reason: "backpressure"
  });
  assert.equal(projected.details.observationState, "backpressure");
  assert.equal(projected.details.failureCode, null);
  assert.equal(projected.details.identitySource, null);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_RENDERER_ERROR|untrusted-page/);
});

test("B: delivery ambiguity never claims that the instruction was not sent", () => {
  const projected = projectDiagnostic({ code: "submission_ambiguous", deliveryCertainty: "ambiguous" });
  assert.equal(projected.category, "DELIVERY");
  assert.match(projected.summary, /送信結果を一意に確認できません/);
  assert.match(projected.summary, /自動再送していません/);
  assert.doesNotMatch(primaryText(projected), /送信されていない|未送信です/);
});

test("C: unexpected attachment explains that existing content was preserved", () => {
  const projected = projectDiagnostic({ code: "unexpected_attachment" });
  assert.equal(projected.category, "ATTACHMENT");
  assert.match(projected.summary, /既存の添付状態/);
  assert.match(projected.summary, /書き換えず停止/);
});

test("D: usage limit, CAPTCHA, login and service errors are classified for intervention", () => {
  for (const code of ["usage-limit", "captcha", "login_required", "service-error"]) {
    const projected = projectDiagnostic({ code });
    assert.equal(projected.category, "SERVICE", code);
    assert.match(projected.title, /手動確認/);
    assert.doesNotMatch(primaryText(projected), new RegExp(code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("E: max sends is a normal bounded stop rather than a security incident", () => {
  const projected = projectDiagnostic({ code: "max_sends" });
  assert.equal(projected.category, "BOUND");
  assert.equal(projected.severity, "attention");
  assert.match(projected.summary, /送信上限/);
  assert.doesNotMatch(primaryText(projected), /攻撃|侵害|FATAL|ERROR/);
});

test("F: unknown code is not reflected into primary or advanced output", () => {
  const projected = projectDiagnostic({
    code: "PRIVATE_RENDERER_DETAIL",
    reason: "private-page-title",
    phase: "private-phase",
    message: "raw Error.message with selector #secret"
  });
  assert.equal(projected.category, "UNKNOWN");
  assert.equal(projected.code, "UNKNOWN_DIAGNOSTIC");
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_RENDERER_DETAIL|private-page-title|private-phase|selector|#secret/);
});

test("F2: primary diagnostic copy hides execution jargon while advanced codes remain available", () => {
  for (const code of [
    "document_identity_unconfirmed",
    "document_identity_recovered",
    "send_confirmed",
    "send_prepared",
    "run_started",
    "max_sends",
    "submission_ambiguous",
    "unexpected_attachment",
    "UNKNOWN_DIAGNOSTIC"
  ]) {
    const projected = projectDiagnostic({ code });
    assert.doesNotMatch(primaryText(projected), /Run|Primary status|document|bounded/i, code);
  }

  const identity = projectDiagnostic({ code: "document_identity_unconfirmed" });
  assert.ok(diagnosticDetailsRows(identity).some(([label, value]) =>
    label === "Code" && value === "document_identity_unconfirmed"));
});

test("G: diagnostics projection cannot downgrade completed/running facts", () => {
  for (const status of ["completed", "running"]) {
    const run = { status, cursor: { sendsCompleted: 2 }, outbox: { state: "confirmed" } };
    const before = structuredClone(run);
    const state = projectRunState(run);
    projectRunDiagnostic(run);
    projectDiagnostic({ code: "UNKNOWN_DIAGNOSTIC" });
    assert.equal(projectRunState(run).kind, state.kind);
    assert.deepEqual(run, before);
  }
});

test("H/I: output and authority fields never enter projections", () => {
  const raw = {
    type: "document_identity_unconfirmed",
    at: "2026-08-29T10:00:00.000Z",
    prompt: "PROMPT BODY",
    assistantText: "ASSISTANT BODY",
    privatePageTitle: "PRIVATE TITLE",
    executionSessionId: "SESSION SECRET",
    documentInstanceId: "DOCUMENT SECRET",
    leaseId: "LEASE SECRET",
    conversationKey: "chatgpt:c:FULL SECRET"
  };
  const serialized = JSON.stringify(projectDiagnosticEvent(raw));
  for (const secret of ["PROMPT BODY", "ASSISTANT BODY", "PRIVATE TITLE", "SESSION SECRET", "DOCUMENT SECRET", "LEASE SECRET", "FULL SECRET"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test("J: Workspace diagnostics remain storage-only and mutation-free", () => {
  const source = `${read("src/workspace.js")}\n${read("src/workspace-projection.js")}`;
  for (const forbidden of [
    "runtime.sendMessage", "tabs.sendMessage", "scripting.executeScript", "setInterval(", "setTimeout(",
    "AIPM_START", "AIPM_PAUSE", "AIPM_RESUME", "AIPM_STOP"
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});

test("K: diagnosticsLevel changes display only and leaves Run snapshot unchanged", () => {
  const run = { status: "running", cursor: { sendsCompleted: 1 }, outbox: null };
  const before = structuredClone(run);
  const summary = normalizeSettings({ display: { diagnosticsLevel: "summary" } });
  const detailed = mergeSettings(summary, { display: { diagnosticsLevel: "detailed" } });
  assert.equal(diagnosticsLevelIsDetailed(summary.display.diagnosticsLevel), false);
  assert.equal(diagnosticsLevelIsDetailed(detailed.display.diagnosticsLevel), true);
  assert.deepEqual(run, before);
});

test("L/M: primary explanation is visible and technical data is in a closed native details", () => {
  const panel = read("src/sidepanel.html");
  const workspace = read("src/workspace.html");
  assert.match(panel, /id="diagnosticsTitle"/);
  assert.match(panel, /id="diagnosticsSummary"/);
  assert.match(panel, /id="diagnosticsSafety"/);
  assert.match(panel, /<details id="diagnosticsAdvanced"[^>]*>/);
  assert.doesNotMatch(panel, /<details id="diagnosticsAdvanced"[^>]*\sopen(?:\s|>)/);
  assert.match(panel, /<summary>技術詳細を表示<\/summary>/);
  assert.match(workspace, /保存された診断情報/);
  assert.match(workspace, /<details id="sideDiagnosticsAdvanced"/);
});

test("N: user-facing diagnostic rendering uses textContent, never HTML injection", () => {
  const source = [
    read("src/diagnostics-ux.js"),
    read("src/connection-diagnostics-ui.js"),
    read("src/sidepanel.js"),
    read("src/workspace.js")
  ].join("\n");
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(read("src/connection-diagnostics-ui.js"), /output\.textContent/);
});

test("O: multi-tab projections stay separated by their exact stored Run key", () => {
  const base = {
    runId: "12345678-a",
    status: "paused",
    workflow: { steps: [], maxSends: 5 },
    cursor: { sendsCompleted: 0 },
    plannedSends: 5,
    resumable: false,
    updatedAt: "2026-08-29T10:00:00.000Z"
  };
  const rows = projectRunList({
    "aipm.activeRun.v2.tab.1": { ...base, lastErrorCode: "document_identity_unconfirmed" },
    "aipm.activeRun.v2.tab.2": { ...base, runId: "87654321-b", lastErrorCode: "unexpected_attachment" }
  });
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.tabId === 1).diagnostic.category, "IDENTITY");
  assert.equal(rows.find((row) => row.tabId === 2).diagnostic.category, "ATTACHMENT");
});

test("Workspace Run projection does not copy raw error messages or full identity values", () => {
  const projected = projectRun({
    runId: "12345678-a",
    status: "paused",
    workflow: { steps: [], maxSends: 5 },
    cursor: { sendsCompleted: 0 },
    plannedSends: 5,
    resumable: false,
    lastErrorCode: "document_identity_unconfirmed",
    errorMessage: "raw selector #prompt-textarea",
    executionSessionId: "SESSION",
    documentInstanceId: "DOCUMENT",
    leaseId: "LEASE",
    conversationKey: "chatgpt:c:FULL-CONVERSATION"
  }, { tabId: 1 });
  const serialized = JSON.stringify(projected);
  assert.match(projected.diagnostic.summary, /対象ページ/);
  assert.doesNotMatch(serialized, /prompt-textarea|SESSION|DOCUMENT|LEASE|FULL-CONVERSATION/);
});

test("Side Panel keeps human copy primary and opens only advanced details in detailed mode", async () => {
  const settingsKey = "aipm.settings.v1";
  const harness = await installSidePanelHarness({
    tabIds: [1],
    storageSeed: {
      [settingsKey]: normalizeSettings({ display: { diagnosticsLevel: "detailed" } })
    }
  });
  const run = {
    runId: "diagnostics-live-run",
    status: "paused",
    stateRevision: 4,
    cursor: { sendsCompleted: 1 },
    plannedSends: 2,
    resumable: false,
    pauseReason: "document_identity_unconfirmed",
    lastErrorCode: "document_identity_unconfirmed",
    workflow: { recovery: { mode: "safe" }, steps: [] }
  };
  try {
    harness.setRelayResponder(() => ({
      ok: true,
      pageReady: true,
      blocker: null,
      run: structuredClone(run),
      diagnostics: [{
        at: "2026-08-29T10:00:00.000Z",
        type: "document_identity_unconfirmed",
        runId: run.runId,
        attempt: 3,
        totalAttempts: 3,
        durationMs: 1480
      }]
    }));
    await harness.click("refreshTabs");
    await tick();
    assert.equal(harness.el("diagnosticsAdvanced").open, true);
    assert.match(harness.el("diagnosticsSummary").textContent, /対象ページ/);
    assert.doesNotMatch(harness.el("diagnosticsSummary").textContent, /document_identity_unconfirmed/);
    const detailText = harness.el("diagnosticsDetails").children
      .flatMap((row) => row.children.map((node) => node.textContent))
      .join(" ");
    assert.match(detailText, /document_identity_unconfirmed/);

    const before = structuredClone(run);
    harness.fireStorageChanged({
      [settingsKey]: {
        oldValue: normalizeSettings({ display: { diagnosticsLevel: "detailed" } }),
        newValue: normalizeSettings({ display: { diagnosticsLevel: "summary" } })
      }
    });
    assert.equal(harness.el("diagnosticsAdvanced").open, false);
    assert.deepEqual(run, before);
  } finally {
    harness.restoreGlobals();
  }
});
