import assert from "node:assert/strict";
import test from "node:test";
import * as diagnostics from "../src/diagnostics-ux.js";
import { installSidePanelHarness, deferred } from "./helpers/sidepanel-harness.mjs";

// The original seven fields reflect the reported saved event. Additional fields
// below are synthetic to exercise copying; they are not claimed as real evidence.
const sample = {
  type: "paste_attachment_settlement", at: "2026-10-23T09:07:02.080Z",
  reason: "paste_attachment_settlement_timeout", settlementOutcome: "timeout",
  lastState: "attachment-pending", logicalAttachmentCount: 0, sendActionable: true,
  composerTextState: "empty", candidatesSeen: 0, stableDurationMs: 29101,
  fileTileFallbackSeen: true, fileTileFallbackCount: 1, fallbackAccepted: false,
  fallbackRejectReason: "none", candidateCount: 1, scopeKind: "form",
  derivedRemoveSemanticCount: 1, maxLogicalAttachmentCount: 0, composerDepth: 6,
  userEpochChanged: false, elapsedMs: 29120, deadlineMs: 30000
};
const descendants = node => [node, ...node.children.flatMap(descendants)];
const action = node => descendants(node).find(child => child.dataset.action === "copy-diagnostic-details");
const feedback = node => descendants(node).find(child => child.dataset.role === "diagnostic-copy-status");
const fallback = node => descendants(node).find(child => child.dataset.role === "diagnostic-copy-fallback");
const stringifyNodes = node => descendants(node).map(child => child.textContent || child.value || "").join("\n");

async function render(harness, events) {
  harness.setRelayResponder(() => ({
    ok: true, pageReady: true, generationState: "idle", blocker: null,
    conversationKey: "chatgpt:c:tab-1", instanceId: "instance-1", run: null,
    diagnostics: events
  }));
  await harness.click("refreshTabs");
}

test("diagnostic copy has a strict metadata boundary, including timestamp and missing values", () => {
  assert.equal(typeof diagnostics.diagnosticEventCopyDetails, "function");
  const secret = "PRIVATE_PROMPT_ANSWER_FILENAME_HTML_URL";
  const value = diagnostics.diagnosticEventCopyDetails({ ...sample,
    prompt: secret, answer: secret, filename: secret, url: secret, html: secret,
    runId: secret, workflow: { prompt: secret }, error: secret
  });
  assert.equal(value.found, true);
  for (const field of ["lastState", "logicalAttachmentCount", "sendActionable", "composerTextState",
    "candidatesSeen", "stableDurationMs", "fileTileFallbackSeen", "fallbackRejectReason", "candidateCount"])
    assert.equal(value[field], sample[field]);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_/);
  const missing = diagnostics.diagnosticEventCopyDetails({ type: sample.type });
  assert.equal(missing.at, null);
  assert.equal(missing.sendActionable, null);
  assert.equal(missing.logicalAttachmentCount, null);
  assert.equal(missing.candidatesSeen, null);
  const malformed = diagnostics.diagnosticEventCopyDetails({ ...sample,
    at: `2026-10-23 (${secret})`, fallbackRejectReason: secret, lastState: secret,
    sendActionable: "true", logicalAttachmentCount: "0", stableDurationMs: 1e9
  });
  assert.equal(malformed.at, null);
  assert.equal(malformed.lastState, null);
  assert.equal(malformed.sendActionable, null);
  assert.equal(malformed.logicalAttachmentCount, null);
  assert.equal(malformed.stableDurationMs, 30000);
  assert.doesNotMatch(JSON.stringify(malformed), /PRIVATE_/);
  assert.equal(diagnostics.diagnosticEventCopyDetails({ type: secret, at: sample.at }), null);
});

test("real Side Panel exposes complete selected-event details and copies only after that row is clicked", async () => {
  const h = await installSidePanelHarness({ tabIds: [1] });
  try {
    const other = { ...sample, at: "2026-10-23T09:08:02.080Z", candidatesSeen: 2 };
    await render(h, [{ ...sample, prompt: "PRIVATE_PAYLOAD" }, other]);
    assert.equal(h.clipboard.length, 0);
    const rows = h.el("diagnostics").children;
    assert.equal(rows.length, 2);
    assert.match(stringifyNodes(rows[1]), /Logical attachments/);
    assert.match(stringifyNodes(rows[1]), /Send actionable/);
    assert.match(stringifyNodes(rows[1]), /Fallback reason/);
    assert.ok(action(rows[1]), "each event needs its own explicit copy action");
    const disclosure = rows[1].children[0];
    assert.ok(disclosure.children.indexOf(action(rows[1])) <
      disclosure.children.findIndex(node => node.tagName === "DL"),
    "Copy must appear before long metadata in the scrollable event list");
    await action(rows[1]).dispatch("click");
    assert.equal(h.clipboard.length, 1);
    assert.equal(JSON.parse(h.clipboard[0]).at, sample.at);
    assert.equal(JSON.parse(h.clipboard[0]).candidatesSeen, 0);
    assert.doesNotMatch(h.clipboard[0], /PRIVATE_PAYLOAD/);
    assert.match(feedback(rows[1]).textContent, /コピーしました/);
    assert.equal(h.messages.some(m => ["AIPM_START", "AIPM_RESUME"].includes(m.payload?.type)), false);
  } finally { h.restoreGlobals(); }
});

test("identical refresh preserves expanded event controls without automatic clipboard writes", async () => {
  const h = await installSidePanelHarness({ tabIds: [1] });
  try {
    await render(h, [sample]);
    const row = h.el("diagnostics").children[0];
    const disclosure = descendants(row).find(node => node.tagName === "DETAILS");
    assert.ok(disclosure);
    disclosure.open = true;
    await render(h, [{ ...sample }]);
    assert.equal(h.el("diagnostics").children[0], row);
    assert.equal(disclosure.open, true);
    assert.equal(h.clipboard.length, 0);
  } finally { h.restoreGlobals(); }
});

test("a stale event control cannot copy a replaced event", async () => {
  const h = await installSidePanelHarness({ tabIds: [1] });
  try {
    await render(h, [sample]);
    const staleButton = action(h.el("diagnostics").children[0]);
    assert.ok(staleButton);
    await render(h, []);
    await staleButton.dispatch("click");
    assert.equal(h.clipboard.length, 0);
  } finally { h.restoreGlobals(); }
});

for (const unavailable of [false, true]) {
  test(`clipboard ${unavailable ? "unavailable" : "rejected"}: show only the selected sanitized JSON for manual copy`, async () => {
    const h = await installSidePanelHarness({ tabIds: [1] });
    try {
      let calls = 0;
      navigator.clipboard = unavailable ? undefined : { async writeText() {
        calls += 1;
        throw new Error("PRIVATE_CLIPBOARD_ERROR");
      } };
      await render(h, [{ ...sample, prompt: "PRIVATE_INPUT" }]);
      const row = h.el("diagnostics").children[0];
      assert.ok(action(row));
      assert.equal(calls, 0);
      await action(row).dispatch("click");
      assert.equal(calls, unavailable ? 0 : 1);
      assert.match(feedback(row).textContent, /手動/);
      const text = fallback(row);
      assert.equal(text.hidden, false);
      assert.equal(text.readOnly, true);
      assert.equal(JSON.parse(text.value).at, sample.at);
      assert.equal(text.selectionEnd, text.value.length);
      assert.doesNotMatch(stringifyNodes(row), /PRIVATE_/);
      assert.equal(h.clipboard.length, 0);
    } finally { h.restoreGlobals(); }
  });
}

test("an in-flight copy uses its selected snapshot and cannot report success on a new event", async () => {
  const h = await installSidePanelHarness({ tabIds: [1] });
  try {
    const gate = deferred();
    const copied = [];
    navigator.clipboard = { async writeText(value) { copied.push(value); await gate.promise; } };
    await render(h, [sample]);
    const oldRow = h.el("diagnostics").children[0];
    assert.ok(action(oldRow));
    const pending = action(oldRow).dispatch("click");
    await render(h, [{ ...sample, at: "2026-10-23T09:08:02.080Z" }]);
    const newRow = h.el("diagnostics").children[0];
    gate.resolve();
    await pending;
    assert.equal(copied.length, 1);
    assert.equal(JSON.parse(copied[0]).at, sample.at);
    assert.equal(feedback(newRow).textContent, "");
    assert.equal(fallback(newRow).hidden, true);
  } finally { h.restoreGlobals(); }
});
