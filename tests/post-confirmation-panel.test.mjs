import assert from "node:assert/strict";
import test from "node:test";
import { installSidePanelHarness } from "./helpers/sidepanel-harness.mjs";
import { CURRENT_EXTENSION_VERSION } from "./helpers/extension-version.mjs";
import { diagnosticEventCopyDetails, projectDiagnosticEvent, diagnosticDetailsRows } from "../src/diagnostics-ux.js";

for (const status of ["running", "paused"]) {
  for (const state of ["confirmed", "submitted", "prepared"]) {
    test(`target summary and main progress agree after ${status}/${state}`, async () => {
      const h = await installSidePanelHarness({ tabIds: [1] });
      try {
        const run = { runId: "test-run", status, phase: "awaiting_completion",
          plannedSends: 20, resumable: false, pauseReason: "document_identity_unconfirmed",
          cursor: { sendsCompleted: 8, stepIndex: 0 }, outbox: { state },
          workflow: { steps: [{ id: "p1", type: "prompt", prompt: "synthetic" }] } };
        const payload = { provider: "chatgpt", contentVersion: CURRENT_EXTENSION_VERSION,
          pageReady: true, conversationKey: "chatgpt:c:fixture", instanceId: "fixture-doc", run };
        const original = JSON.stringify(run);
        h.setListTabsResponder(() => ({ ok: true, serviceWorkerVersion: CURRENT_EXTENSION_VERSION,
          tabs: [{ tabId: 1, windowId: 1, active: true, status: payload }] }));
        h.setRelayResponder(() => ({ ok: true, ...payload, diagnostics: [] }));
        await h.click("refreshTabs");
        const count = state === "confirmed" ? 9 : 8;
        assert.match(h.el("progress").textContent, new RegExp(`送信 ${count}/20`));
        assert.match(h.el("targetTab").children[0].textContent, new RegExp(`${count}/20`));
        assert.match(h.el("targetTabHint").textContent, new RegExp(`${count}/20`));
        if (status === "paused") {
          assert.match(h.el("targetTab").children[0].textContent, /安全のため停止/);
          assert.match(h.el("targetTabHint").textContent, /安全のため停止/);
        }
        assert.equal(JSON.stringify(run), original, "presentation cannot advance the execution cursor");
        assert.equal(h.messages.some(m => ["AIPM_START", "AIPM_RESUME"].includes(m.payload?.type)), false);
      } finally { h.restoreGlobals(); }
    });
  }
}

test("selected identity event copy retains bounded root-cause metadata without content or authority ids", () => {
  const secret = "PRIVATE_PROMPT_BODY_URL_DOCUMENT_ID";
  const raw = { type: "document_identity_unconfirmed", at: "2026-01-01T12:00:00.000Z",
    phase: "identity-fail-closed", reason: "document-lifecycle-changed", outcome: "unavailable",
    attempt: 1, totalAttempts: 1, durationMs: 0, boundary: "lease-renew",
    consecutiveUnavailable: 1, recoveryElapsedMs: 0, failureCode: "IDENTITY_LIFECYCLE_INVALIDATED",
    identitySource: "document-lifetime-grant", prompt: secret, answer: secret,
    expectedDocumentId: secret, actualDocumentId: secret, episodeId: secret, runId: secret };
  const value = diagnosticEventCopyDetails(raw);
  for (const key of ["phase", "reason", "outcome", "boundary", "consecutiveUnavailable",
    "recoveryElapsedMs", "failureCode", "identitySource"]) assert.equal(value[key], raw[key], key);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_/);
  const invalid = diagnosticEventCopyDetails({ ...raw, phase: secret, reason: secret,
    outcome: secret, boundary: secret, failureCode: secret, identitySource: secret });
  assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE_/);
  for (const key of ["phase", "reason", "outcome", "boundary", "failureCode", "identitySource"])
    assert.equal(invalid[key], null, key);
  const missing = diagnosticEventCopyDetails({ type: raw.type });
  for (const key of ["phase", "reason", "outcome", "boundary", "consecutiveUnavailable",
    "recoveryElapsedMs", "failureCode", "identitySource"]) assert.equal(missing[key], null, key);
  assert.equal(diagnosticEventCopyDetails({ ...raw, phase: "ambiguous" }).phase, "ambiguous",
    "durable identity fail-closed phase must not be dropped from the saved event");
});

test("missing identity observation is not presented as one measured zero-duration attempt", () => {
  const event = { type: "document_identity_unconfirmed", at: "2026-01-01T12:00:00.000Z",
    attempt: 1, totalAttempts: 1, durationMs: 0, recoveryElapsedMs: 0, consecutiveUnavailable: 1,
    identityObservationMissing: true, reason: "unknown", boundary: "lease-renew" };
  const copy = diagnosticEventCopyDetails(event);
  for (const key of ["attempt", "totalAttempts", "durationMs", "recoveryElapsedMs", "consecutiveUnavailable"])
    assert.equal(copy[key], null, key);
  assert.equal(copy.identityObservationMissing, true);
  const rows = diagnosticDetailsRows(projectDiagnosticEvent(event));
  assert.equal(rows.some(([label]) => ["Attempts", "Elapsed"].includes(label)), false);
  assert.ok(rows.some(([label, value]) => label === "Identity metadata" && value === "not recorded"));
  assert.ok(rows.some(([label, value]) => label === "Identity boundary" && value === "lease-renew"));
  const legacy = { ...event };
  delete legacy.identityObservationMissing;
  assert.equal(diagnosticEventCopyDetails(legacy).durationMs, 0, "do not invent missing status for legacy events");
  assert.equal(diagnosticEventCopyDetails(legacy).identityObservationMissing, null);
});

test("real panel selected-event copy includes identity details only after explicit action", async () => {
  const h = await installSidePanelHarness({ tabIds: [1] });
  try {
    h.setRelayResponder(() => ({ ok: true, pageReady: true, run: null,
      diagnostics: [{ type: "document_identity_unconfirmed", at: "2026-01-01T12:00:00.000Z",
        reason: "document-lifecycle-changed", boundary: "run-save", phase: "identity-fail-closed",
        failureCode: "IDENTITY_LIFECYCLE_INVALIDATED", identitySource: "document-lifetime-grant",
        identityObservationMissing: false, episodeId: "document-lifetime-grant", prompt: "PRIVATE_BODY" }] }));
    await h.click("refreshTabs");
    const descendants = node => [node, ...node.children.flatMap(descendants)];
    const nodes = descendants(h.el("diagnostics"));
    const action = nodes.find(node => node.dataset.action === "copy-diagnostic-details");
    assert.ok(action);
    assert.equal(h.clipboard.length, 0);
    await action.dispatch("click");
    const copied = JSON.parse(h.clipboard[0]);
    assert.equal(copied.boundary, "run-save");
    assert.equal(copied.reason, "document-lifecycle-changed");
    assert.equal(copied.identitySource, "document-lifetime-grant");
    assert.equal(copied.identityObservationMissing, false);
    assert.doesNotMatch(h.clipboard[0], /PRIVATE_BODY/);
    assert.equal(h.messages.some(m => ["AIPM_START", "AIPM_RESUME"].includes(m.payload?.type)), false);
  } finally { h.restoreGlobals(); }
});
