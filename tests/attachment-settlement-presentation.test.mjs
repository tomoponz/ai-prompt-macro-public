import assert from "node:assert/strict";
import test from "node:test";
import { projectDiagnosticEvent, diagnosticDetailsRows } from "../src/diagnostics-ux.js";

const event = {
  type: "paste_attachment_settlement", at: "2026-10-23T09:07:02.080Z",
  reason: "paste_attachment_settlement_timeout", lastState: "attachment-pending",
  logicalAttachmentCount: 0, composerTextState: "minimal", sendActionable: true,
  stableDurationMs: 29120, candidatesSeen: 0, scopeKind: "form", composerDepth: 2,
  fileTileFallbackSeen: false, fileTileFallbackCount: 0, derivedRemoveSemanticCount: 0,
  fallbackAccepted: false, fallbackRejectReason: "no-file-tile", userEpochChanged: false,
  maxLogicalAttachmentCount: 0
};

test("settlement details expose the bounded evidence needed to distinguish detector and Send readiness", () => {
  const projected = projectDiagnosticEvent(event);
  const details = projected.details.attachmentSettlement;
  assert.equal(details.lastState, "attachment-pending");
  assert.equal(details.logicalAttachmentCount, 0);
  assert.equal(details.composerTextState, "minimal");
  assert.equal(details.sendActionable, true);
  assert.equal(details.fallbackAccepted, false);
  assert.equal(details.fallbackRejectReason, "no-file-tile");
  const rows = new Map(diagnosticDetailsRows(projected));
  assert.equal(rows.get("Logical attachments"), "0");
  assert.equal(rows.get("Send actionable"), "true");
  assert.equal(rows.get("Composer text state"), "minimal");
  assert.equal(rows.get("User interaction changed"), "false");
});

test("missing settlement evidence remains unavailable, never invented as zero or false", () => {
  const projected = projectDiagnosticEvent({ type: event.type, at: event.at });
  assert.equal(projected.details.attachmentSettlement.lastState, null);
  assert.equal(projected.details.attachmentSettlement.logicalAttachmentCount, null);
  assert.equal(projected.details.attachmentSettlement.sendActionable, null);
  assert.equal(new Map(diagnosticDetailsRows(projected)).has("Send actionable"), false);
});

test("settlement presentation drops content, filenames, arbitrary strings and coercible values", () => {
  const secret = "PRIVATE_PROMPT_ANSWER_FILENAME_HTML_URL";
  const projected = projectDiagnosticEvent({ ...event,
    lastState: secret, composerTextState: secret, scopeKind: secret,
    fallbackRejectReason: secret, logicalAttachmentCount: "1", sendActionable: "true",
    prompt: secret, answer: secret, filename: secret, html: secret, url: secret
  });
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_PROMPT/);
  const details = projected.details.attachmentSettlement;
  assert.equal(details.logicalAttachmentCount, null);
  assert.equal(details.sendActionable, null);
  assert.equal(details.lastState, null);
});

test("settlement counters are bounded and do not appear on an unrelated event", () => {
  const projected = projectDiagnosticEvent({ ...event, candidatesSeen: 99999, stableDurationMs: 99999 });
  assert.equal(projected.details.attachmentSettlement.candidatesSeen, 64);
  assert.equal(projected.details.attachmentSettlement.stableDurationMs, 30000);
  const unrelated = projectDiagnosticEvent({ ...event, type: "send_confirmed" });
  assert.equal(unrelated.details.attachmentSettlement, null);
  assert.equal(new Map(diagnosticDetailsRows(unrelated)).has("Logical attachments"), false);
});
