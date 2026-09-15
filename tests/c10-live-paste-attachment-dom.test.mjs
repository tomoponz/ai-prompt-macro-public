import test from "node:test";
import assert from "node:assert/strict";

import { createWorkflowHarness } from "./helpers/workflow-harness.mjs";

const LONG_PROMPT = Array(300).fill("C10 production-like pasted text").join("\n");

function workflow(repeat = 1) {
  return {
    schemaVersion: 1,
    id: `c10-live-pasted-text-${repeat}`,
    name: "C10 live pasted text",
    maxSends: repeat,
    steps: [{
      id: "c10-prompt",
      type: "prompt",
      delivery: "send",
      prompt: LONG_PROMPT,
      repeat,
      delayAfterMs: 0
    }]
  };
}

async function run(options = {}, repeat = 1) {
  const harness = createWorkflowHarness(options);
  await harness.ready();
  const response = await harness.start(workflow(repeat));
  await harness.settle();
  return { harness, response };
}

test("C10 R3 RED: attachment conversion after 350ms settles as paste-attachment", async () => {
  const { harness } = await run({
    pasteAttachmentTimeline: [{ afterMs: 350, type: "convert" }]
  });
  assert.equal(harness.page.clicks, 1);
  assert.equal(harness.saves().some((saved) => saved.outbox?.deliveryMode === "paste-attachment"), true);
  assert.equal(harness.stored().status, "completed");
});

test("C10 R4 RED: one bounded temporary-to-final replacement preserves provenance", async () => {
  const { harness } = await run({
    pasteAttachmentTimeline: [
      { afterMs: 300, type: "convert" },
      { afterMs: 420, type: "replace" }
    ]
  });
  assert.equal(harness.page.attachmentReplacementCount, 1);
  assert.equal(harness.page.clicks, 1);
  assert.equal(harness.saves().some((saved) => saved.outbox?.deliveryMode === "paste-attachment"), true);
  assert.equal(harness.stored().status, "completed");
});

test("C10 R5: a second attachment during settlement sends zero", async () => {
  const { harness } = await run({
    pasteAttachmentTimeline: [
      { afterMs: 300, type: "convert" },
      { afterMs: 420, type: "extra" }
    ]
  });
  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.stored().resumable, false);
});

test("C10 R6 RED: initial exact text does not cause premature TEXT settlement", async () => {
  const { harness } = await run({
    pasteAttachmentTimeline: [{ afterMs: 350, type: "convert" }]
  });
  const deliveryModes = harness.saves().map((saved) => saved.outbox?.deliveryMode).filter(Boolean);
  assert.equal(deliveryModes.includes("text"), false);
  assert.equal(deliveryModes.includes("paste-attachment"), true);
});

test("C10 R7: empty composer with no attachment times out fail-closed", async () => {
  const { harness } = await run({
    onWrite: ({ page }) => { page.text = ""; }
  });
  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.stored().lastErrorCode, "paste_attachment_settlement_timeout");
});

test("C10 R8: attachment plus remaining composer text is ambiguous and sends zero", async () => {
  const { harness } = await run({
    onWrite: ({ page }) => { page.attachmentCount = 1; }
  });
  assert.equal(harness.page.clicks, 0);
});

test("C10 R9: an attachment outside the scoped composer surface grants no authority", async () => {
  const { harness } = await run({
    onWrite: ({ page }) => {
      page.text = "";
      page.unscopedAttachmentCount = 1;
    }
  });
  assert.equal(harness.page.unscopedAttachmentCount, 1);
  assert.equal(harness.page.clicks, 0);
});

test("C10 R10: assistant-history attachment state is never consulted", async () => {
  const harness = createWorkflowHarness({
    pasteAttachmentTimeline: [{ afterMs: 350, type: "convert" }]
  });
  harness.page.assistantAttachmentCount = 12;
  await harness.ready();
  await harness.start(workflow());
  await harness.settle();
  assert.equal(harness.page.clicks, 1);
  assert.equal(harness.adapterCalls.has("readAssistantAttachment"), false);
});

for (const repeat of [5, 20, 40]) {
  test(`C10 delayed/replaced attachment Repeat=${repeat} completes exactly`, async () => {
    const { harness } = await run({
      pasteAttachmentTimeline: [
        { afterMs: 300, type: "convert" },
        { afterMs: 420, type: "replace" }
      ]
    }, repeat);
    assert.equal(harness.page.clicks, repeat);
    assert.equal(new Set(harness.clicks().map((entry) => entry.position)).size, repeat);
    assert.equal(harness.stored().status, "completed");
  });
}

test("C10 C8 recovered identity keeps delayed attachment exactly once", async () => {
  let recovered = false;
  const { harness } = await run({
    pasteAttachmentTimeline: [{ afterMs: 350, type: "convert" }],
    onRunGet: ({ message, storedRun, page }) => {
      if (!recovered && message.authorityBoundary === "send-preflight" && page.attachmentCount === 1) {
        recovered = true;
        return {
          ok: true,
          run: storedRun,
          identityObservation: {
            outcome: "match",
            reason: "timeout",
            attempt: 4,
            totalAttempts: 5,
            durationMs: 700,
            boundary: "send-preflight",
            episodeId: "c10-recovered",
            consecutiveUnavailable: 3,
            recoveryElapsedMs: 700
          }
        };
      }
      return null;
    }
  });
  assert.equal(recovered, true);
  assert.equal(harness.page.clicks, 1);
});

test("C10 C8 identity mismatch during settlement sends zero", async () => {
  let changed = false;
  const harness = createWorkflowHarness({
    pasteAttachmentTimeline: [{ afterMs: 350, type: "convert" }],
    onRunGet: ({ message, context }) => {
      if (!changed && message.authorityBoundary === "send-preflight") {
        changed = true;
        context.instanceId = "c10-different-document";
      }
      return null;
    }
  });
  await harness.ready();
  harness.pinCurrentDocument();
  await harness.start(workflow());
  await harness.settle();
  assert.equal(changed, true);
  assert.equal(harness.page.clicks, 0);
});

test("C10 C8 exhausted identity recovery during settlement sends zero", async () => {
  let exhausted = false;
  const { harness } = await run({
    pasteAttachmentTimeline: [{ afterMs: 350, type: "convert" }],
    onRunGet: ({ message, storedRun }) => {
      if (!exhausted && message.authorityBoundary === "send-preflight") {
        exhausted = true;
        return {
          ok: false,
          errorCode: "DOCUMENT_IDENTITY_UNCONFIRMED",
          error: "identity unavailable",
          runId: storedRun.runId,
          identityObservation: {
            outcome: "unavailable",
            reason: "timeout",
            attempt: 5,
            totalAttempts: 5,
            boundary: "send-preflight",
            episodeId: "c10-exhausted",
            consecutiveUnavailable: 5
          }
        };
      }
      return null;
    }
  });
  assert.equal(exhausted, true);
  assert.equal(harness.page.clicks, 0);
});

test("C10 Stop during settlement is terminal and cleans the local transaction", async () => {
  let stopped = false;
  let harness;
  harness = createWorkflowHarness({
    pasteAttachmentTimeline: [{ afterMs: 350, type: "convert" }],
    onRunGet: async ({ message }) => {
      if (!stopped && message.authorityBoundary === "send-preflight") {
        stopped = true;
        await harness.control("AIPM_STOP");
      }
      return null;
    }
  });
  await harness.ready();
  await harness.start(workflow());
  await harness.settle();
  assert.equal(stopped, true);
  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.stored().status, "stopped");
  assert.equal(harness.page.activeDeliveryTransactions, 0);
});

test("C10 Pause during settlement reaches the pre-click safe boundary", async () => {
  let paused = false;
  let harness;
  harness = createWorkflowHarness({
    pasteAttachmentTimeline: [{ afterMs: 350, type: "convert" }],
    onRunGet: async ({ message }) => {
      if (!paused && message.authorityBoundary === "send-preflight") {
        paused = true;
        await harness.control("AIPM_PAUSE");
      }
      return null;
    }
  });
  await harness.ready();
  await harness.start(workflow());
  await harness.settle();
  assert.equal(paused, true);
  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.stored().status, "paused");
  assert.equal(harness.page.activeDeliveryTransactions, 0);
});

test("C10 bounded settlement diagnostic contains no Prompt or attachment content", async () => {
  const { harness } = await run({ onWrite: ({ page }) => { page.text = ""; } });
  await new Promise((resolve) => setImmediate(resolve));
  const diagnostic = harness.diagnostics().find((entry) => entry.type === "paste_attachment_settlement");
  assert.ok(diagnostic);
  assert.equal(diagnostic.settlementOutcome, "timeout");
  assert.equal(diagnostic.composerTextState, "empty");
  assert.equal(JSON.stringify(diagnostic).includes(LONG_PROMPT.slice(0, 40)), false);
  assert.deepEqual(
    Object.keys(diagnostic).filter((key) => /textContent|innerText|filename|title|url|documentId/i.test(key)),
    []
  );
});
