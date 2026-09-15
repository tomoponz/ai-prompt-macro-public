import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createWorkflowHarness } from "./helpers/workflow-harness.mjs";

const LONG_PROMPT = Array(320).fill("C10.1 slow pasted text conversion").join("\n");
const sidepanelSource = fs.readFileSync(new URL("../src/sidepanel.js", import.meta.url), "utf8");
const runUxSource = fs.readFileSync(new URL("../src/run-ux.js", import.meta.url), "utf8");

function workflow(repeat = 1) {
  return {
    schemaVersion: 1,
    id: `c10-1-long-settlement-${repeat}`,
    name: "C10.1 long attachment settlement",
    maxSends: repeat,
    steps: [{
      id: "slow-paste",
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
  await harness.start(workflow(repeat));
  await harness.settle();
  return harness;
}

test("C10.1 R1 RED: a Macro attachment finalized after 20 seconds must still send exactly once", async () => {
  const harness = await run({
    onWrite: ({ page }) => { page.text = ""; },
    pasteAttachmentTimeline: [{ afterMs: 20_000, type: "convert" }]
  });

  assert.equal(harness.page.clicks, 1);
  assert.equal(harness.stored().status, "completed");
  assert.equal(
    harness.saves().some((saved) => saved.outbox?.deliveryMode === "paste-attachment"),
    true
  );
});

test("C10.1 R2: a Macro attachment finalized after 25 seconds settles before the deadline", async () => {
  const harness = await run({
    onWrite: ({ page }) => { page.text = ""; },
    pasteAttachmentTimeline: [{ afterMs: 25_000, type: "convert" }]
  });

  assert.equal(harness.page.clicks, 1);
  assert.equal(harness.stored().status, "completed");
  assert.ok(harness.clicks()[0].at - harness.transcript.find((entry) => entry.type === "write").at < 30_000);
});

test("C10.1 R3: no final attachment by the bounded deadline sends zero", async () => {
  const harness = await run({ onWrite: ({ page }) => { page.text = ""; } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.stored().lastErrorCode, "paste_attachment_settlement_timeout");
  const diagnostic = harness.diagnostics().find((entry) => entry.type === "paste_attachment_settlement");
  assert.equal(diagnostic?.lastState, "attachment-pending");
  assert.equal(diagnostic?.deadlineMs, 30_000);
  assert.equal(diagnostic?.logicalAttachmentCount, 0);
  assert.deepEqual(
    Object.keys(diagnostic ?? {}).filter((key) => /textContent|innerText|filename|title|url|html|prompt/i.test(key)),
    []
  );
});

test("C10.1 pending UI describes bounded conversion without changing Run authority", () => {
  assert.match(sidepanelSource, /projectRunUx/);
  assert.match(runUxSource, /run\?\.phase === "prepared"/);
  assert.match(runUxSource, /run\?\.outbox\?\.deliveryMode === "pending"/);
  assert.match(runUxSource, /長文をChatGPTの添付形式へ変換し/);
});

test("C10.1 R4: a final attachment after 5 seconds sends without waiting for the maximum", async () => {
  const harness = await run({
    onWrite: ({ page }) => { page.text = ""; },
    pasteAttachmentTimeline: [{ afterMs: 5_000, type: "convert" }]
  });
  const write = harness.transcript.find((entry) => entry.type === "write");
  const click = harness.clicks()[0];

  assert.equal(harness.page.clicks, 1);
  assert.ok(click.at - write.at >= 5_000);
  assert.ok(click.at - write.at < 6_000);
});

test("C10.1 R5: short TEXT keeps the sub-second fast path", async () => {
  const harness = await run();
  const write = harness.transcript.find((entry) => entry.type === "write");
  const click = harness.clicks()[0];

  assert.equal(harness.page.clicks, 1);
  assert.ok(click.at - write.at < 1_000);
  assert.equal(harness.saves().some((saved) => saved.outbox?.deliveryMode === "text"), true);
});

test("C10.1 R6: a temporary conversion state at 10 seconds and final tile at 20 seconds sends once", async () => {
  const harness = await run({
    onWrite: ({ page }) => { page.text = ""; },
    pasteAttachmentTimeline: [
      { afterMs: 10_000, type: "temporary" },
      { afterMs: 20_000, type: "convert" }
    ]
  });

  assert.equal(harness.page.clicks, 1);
  assert.equal(harness.transcript.filter((entry) => entry.type === "paste-attachment-timeline").length, 2);
});

test("C10.1 R7: a second attachment permanently contaminates provenance and sends zero", async () => {
  const harness = await run({
    onWrite: ({ page }) => { page.text = ""; },
    pasteAttachmentTimeline: [
      { afterMs: 10_000, type: "convert" },
      { afterMs: 10_050, type: "extra" },
      { afterMs: 10_100, type: "clear" }
    ]
  });

  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.stored().resumable, false);
});

test("C10.1 R8: trusted user interaction at 15 seconds invalidates the transaction", async () => {
  const harness = await run({
    onWrite: ({ page }) => { page.text = ""; },
    pasteAttachmentTimeline: [
      { afterMs: 15_000, type: "user-interaction" },
      { afterMs: 20_000, type: "convert" }
    ]
  });

  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.stored().resumable, false);
});

test("C10.1 R9: durable Stop at 15 seconds wins over late attachment settlement", async () => {
  let stopIssued = false;
  let harness;
  harness = createWorkflowHarness({
    onWrite: ({ page }) => { page.text = ""; },
    pasteAttachmentTimeline: [{ afterMs: 20_000, type: "convert" }],
    onRunGet: async ({ message }) => {
      if (!stopIssued && message.authorityBoundary === "send-preflight" && harness.now() >= 1_700_000_015_000) {
        stopIssued = true;
        await harness.control("AIPM_STOP");
      }
      return null;
    }
  });
  await harness.ready();
  await harness.start(workflow());
  await harness.settle();
  harness.advance(10_000);

  assert.equal(stopIssued, true);
  assert.equal(harness.stored().status, "stopped");
  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.page.activeDeliveryTransactions, 0);
});

test("C10.1 R10: document mismatch during settlement sends zero", async () => {
  let rotated = false;
  let harness;
  harness = createWorkflowHarness({
    onWrite: ({ page }) => { page.text = ""; },
    pasteAttachmentTimeline: [{ afterMs: 20_000, type: "convert" }],
    onRunGet: ({ message, context }) => {
      if (!rotated && message.authorityBoundary === "send-preflight" && harness.now() >= 1_700_000_015_000) {
        rotated = true;
        context.instanceId = "c10-1-navigation-document";
      }
      return null;
    }
  });
  await harness.ready();
  harness.pinCurrentDocument();
  await harness.start(workflow());
  await harness.settle();

  assert.equal(rotated, true);
  assert.equal(harness.page.clicks, 0);
});

test("C10.1 R11: recovered transient identity observation retains fresh exactly-once authority", async () => {
  let recoveryObserved = false;
  let harness;
  harness = createWorkflowHarness({
    onWrite: ({ page }) => { page.text = ""; },
    pasteAttachmentTimeline: [{ afterMs: 20_000, type: "convert" }],
    onRunGet: ({ message, storedRun }) => {
      if (!recoveryObserved && message.authorityBoundary === "send-preflight" &&
          harness.now() >= 1_700_000_015_000) {
        recoveryObserved = true;
        return {
          ok: true,
          run: storedRun,
          identityObservation: {
            outcome: "match",
            reason: "timeout",
            attempt: 2,
            totalAttempts: 3,
            durationMs: 700,
            boundary: "send-preflight",
            episodeId: "c10-1-recovered",
            consecutiveUnavailable: 1,
            recoveryElapsedMs: 800
          }
        };
      }
      return null;
    }
  });
  await harness.ready();
  await harness.start(workflow());
  await harness.settle();

  assert.equal(recoveryObserved, true);
  assert.equal(harness.page.clicks, 1);
});

test("C10.1 R12: reload invalidates local provenance and a residual late tile is never adopted", async () => {
  let invalidated = false;
  let harness;
  harness = createWorkflowHarness({
    onWrite: ({ page }) => { page.text = ""; },
    pasteAttachmentTimeline: [{ afterMs: 20_000, type: "convert" }],
    onRunGet: ({ message, context }) => {
      if (!invalidated && message.authorityBoundary === "send-preflight" &&
          harness.now() >= 1_700_000_010_000) {
        invalidated = true;
        context.localRunnerToken += 1;
      }
      return null;
    }
  });
  await harness.ready();
  await harness.start(workflow());
  await harness.settle();
  harness.advance(15_000);
  assert.equal(harness.page.attachmentCount, 1);
  await harness.reload();

  assert.equal(invalidated, true);
  assert.equal(harness.page.clicks, 0);
});

test("C10.1 R14: a final tile outside the bounded composer surface sends zero", async () => {
  const harness = await run({
    onWrite: ({ page }) => {
      page.text = "";
      page.unscopedAttachmentCount = 1;
    }
  });

  assert.equal(harness.page.unscopedAttachmentCount, 1);
  assert.equal(harness.page.clicks, 0);
});

test("C10.1 R15: ambiguous attachment ACK clicks once and is never retried", async () => {
  const harness = await run({
    ackConfirms: false,
    onWrite: ({ page }) => { page.text = ""; },
    pasteAttachmentTimeline: [{ afterMs: 5_000, type: "convert" }]
  });

  assert.equal(harness.page.clicks, 1);
  assert.equal(harness.stored().lastErrorCode, "submission_ambiguous");
  assert.equal(harness.stored().resumable, false);
});

test("C10.1 replacement cap permits four bounded React replacements", async () => {
  const harness = await run({
    onWrite: ({ page }) => { page.text = ""; },
    pasteAttachmentTimeline: [
      { afterMs: 5_000, type: "convert" },
      { afterMs: 5_050, type: "replace" },
      { afterMs: 5_100, type: "replace" },
      { afterMs: 5_150, type: "replace" },
      { afterMs: 5_200, type: "replace" }
    ]
  });

  assert.equal(harness.page.attachmentReplacementCount, 4);
  assert.equal(harness.page.clicks, 1);
});

test("C10.1 Practical: repeated React tile replacement is advisory while logical state remains safe", async () => {
  const harness = await run({
    onWrite: ({ page }) => { page.text = ""; },
    pasteAttachmentTimeline: [
      { afterMs: 5_000, type: "convert" },
      { afterMs: 5_050, type: "replace" },
      { afterMs: 5_100, type: "replace" },
      { afterMs: 5_150, type: "replace" },
      { afterMs: 5_200, type: "replace" },
      { afterMs: 5_250, type: "replace" }
    ]
  });

  assert.equal(harness.page.attachmentReplacementCount, 5);
  assert.equal(harness.page.clicks, 1);
});

test("C10.1 coalesced mutation batches remain bounded during long conversion", async () => {
  const harness = await run({
    onWrite: ({ page }) => { page.text = ""; },
    pasteAttachmentTimeline: [
      { afterMs: 10_000, type: "mutation-burst", count: 1_024 },
      { afterMs: 20_000, type: "convert" }
    ]
  });

  assert.equal(harness.page.clicks, 1);
});

test("C10.1 Practical: renderer mutation volume is advisory while the final logical state is safe", async () => {
  const harness = await run({
    onWrite: ({ page }) => { page.text = ""; },
    pasteAttachmentTimeline: [
      { afterMs: 10_000, type: "mutation-burst", count: 1_025 },
      { afterMs: 20_000, type: "convert" }
    ]
  });

  assert.equal(harness.page.clicks, 1);
});

for (const repeat of [5, 20, 40]) {
  test(`C10.1 delayed attachment Repeat=${repeat} uses a fresh transaction per position`, async () => {
    const harness = await run({
      onWrite: ({ page }) => { page.text = ""; },
      pasteAttachmentTimeline: [{ afterMs: 20_000, type: "convert" }]
    }, repeat);

    assert.equal(harness.page.clicks, repeat);
    assert.equal(new Set(harness.clicks().map((entry) => entry.position)).size, repeat);
    assert.equal(harness.stored().status, "completed");
  });
}
