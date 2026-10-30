import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import { createWorkflowHarness } from "./helpers/workflow-harness.mjs";

// These are feature requirements, not a claim that converted attachments are
// provider-verified. Positive cases require conditional scoped lifecycle acceptance;
// the residual-risk case below explicitly records what these observations cannot prove.
//
// This harness loads production runner/controller code but supplies a synthetic
// adapter and clock. Its conversion options express test ground truth only; no
// new provenance flag is supplied to production. Neither a click nor the
// harness's original pendingPrompt proves actual attachment bytes, upload
// completion, or ChatGPT acceptance. A future fix must satisfy BOTH the desired
// successes and the rejection cases without using this model as file evidence.
const ASCII_PROMPT = "test".repeat(20_160);
const UNICODE_PROMPT = "日本語🚀e\u0301👩‍💻<&>\n".repeat(6_000) + "終";
const digest = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const writes = (harness) => harness.transcript.filter((entry) => entry.type === "write");
const conversions = (harness) => harness.transcript.filter((entry) =>
  entry.type === "paste-attachment-timeline" && entry.action === "convert");

function workflow(prompt = ASCII_PROMPT) {
  return {
    schemaVersion: 1,
    id: "long-prompt-feature-acceptance",
    name: "Synthetic converted long prompt acceptance",
    maxSends: 3,
    steps: [{
      id: "long-prompt",
      type: "prompt",
      delivery: "send",
      prompt,
      repeat: 3,
      delayAfterMs: 0
    }]
  };
}

async function startAndSettle(harness, prompt = ASCII_PROMPT) {
  await harness.ready();
  const response = await harness.start(workflow(prompt));
  assert.equal(response.ok, true, "execution must start rather than fail initial validation");
  await harness.settle();
}

function attachmentNode(harness) {
  const adapter = harness.context.ChatGptAdapter;
  return adapter.getComposerAttachmentState(adapter.findComposer()).logicalNodes[0];
}

function assertCompletedThree(harness, prompt) {
  const run = harness.stored();
  assert.deepEqual({
    status: run.status,
    clicks: harness.page.clicks,
    sendsCompleted: run.cursor.sendsCompleted,
    writes: writes(harness).length,
    error: run.lastErrorCode ?? null
  }, {
    status: "completed",
    clicks: 3,
    sendsCompleted: 3,
    writes: 3,
    error: null
  });
  const positions = harness.clicks().map((entry) => entry.position);
  assert.deepEqual(positions, ["0:0", "0:1", "0:2"]);
  assert.equal(new Set(positions).size, 3, "each logical position dispatches once");
  // Check only the original input supplied to each synthetic write. This is not
  // an oracle for the resulting attachment's bytes or provider-side receipt.
  assert.deepEqual(writes(harness).map((entry) => digest(entry.prompt)), Array(3).fill(digest(prompt)));
  assert.equal(run.workflow.steps[0].repeat, 3);
  assert.equal(run.workflow.steps[0].delayAfterMs, 0);
  assert.equal(harness.page.activeDeliveryTransactions, 0);
}

function assertNoDispatch(harness, expectedWrites) {
  assert.equal(harness.page.clicks, 0);
  assert.equal(writes(harness).length, expectedWrites);
  assert.deepEqual(harness.stored().cursor, { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 });
  assert.equal(harness.saves().some((run) =>
    ["submitting", "waiting-ack"].includes(run.phase) ||
    ["submitted", "confirmed"].includes(run.outbox?.state)), false);
  assert.equal(harness.page.activeDeliveryTransactions, 0);
}

for (const [label, prompt] of [["80,640 ASCII characters", ASCII_PROMPT], ["large Unicode", UNICODE_PROMPT]]) {
  test(`REQUIRED feature: ${label} converted to an attachment completes Repeat3 with wait0`, async () => {
    assert.ok(prompt.length >= 80_640);
    let syntheticConversions = 0;
    const harness = createWorkflowHarness({
      convertPasteToAttachment: true,
      onWrite({ page }) {
        assert.equal(page.text, "");
        assert.equal(page.attachmentCount, 1);
        syntheticConversions += 1;
      }
    });
    await startAndSettle(harness, prompt);
    assert.ok(syntheticConversions >= 1, "the fixture conversion must actually occur");
    assertCompletedThree(harness, prompt);
    assert.equal(syntheticConversions, 3);
  });
}

test("REQUIRED feature: a fixture-owned conversion finishing after 5s completes each of three repeats", async () => {
  const harness = createWorkflowHarness({
    onWrite({ page }) { page.text = ""; },
    pasteAttachmentTimeline: [{ afterMs: 5_000, type: "convert" }]
  });
  await startAndSettle(harness);
  assert.ok(conversions(harness).length >= 1, "the delayed conversion must actually occur");
  assertCompletedThree(harness, ASCII_PROMPT);
  assert.equal(conversions(harness).length, 3);
  for (let index = 0; index < 3; index += 1) {
    assert.ok(harness.clicks()[index].at - writes(harness)[index].at >= 5_000);
  }
});

test("KNOWN LIMITATION: a queued foreign attachment with indistinguishable lifecycle signals is conditionally accepted", async () => {
  let foreignNode = null;
  let writeAt = null;
  let harness;
  harness = createWorkflowHarness({
    onWrite({ page }) { writeAt = harness.now(); page.text = ""; },
    // The prompt's simulated conversion cannot explain the earlier foreign tile.
    pasteAttachmentTimeline: [{ afterMs: 60_000, type: "convert" }],
    onRunGet({ message, page }) {
      if (!foreignNode && writeAt !== null && message.authorityBoundary === "send-preflight" &&
          harness.now() - writeAt >= 5_000) {
        page.attachmentCount = 1;
        foreignNode = attachmentNode(harness);
      }
      return null;
    }
  });
  await startAndSettle(harness);
  assert.ok(foreignNode, "the independently queued foreign tile must actually appear");
  assert.equal(conversions(harness).length, 0);
  assert.equal(harness.page.userMutationEpoch, 0);
  // This is an explicit counterexample to content-provenance guarantees, not
  // a claim that the foreign file is correct or a known live ChatGPT behavior.
  // Production receives no test-only "foreign" marker. The first tile satisfies
  // the approved scoped lifecycle policy; the next position lacks a ready tile.
  assert.equal(harness.page.clicks, 1);
  assert.deepEqual(harness.clicks().map(entry => entry.position), ["0:0"]);
  assert.equal(harness.stored().cursor.sendsCompleted, 1);
  assert.equal(writes(harness).length, 2);
  assert.equal(harness.stored().status, "paused");
  assert.equal(harness.stored().lastErrorCode, "paste_attachment_settlement_timeout");
  assert.equal(harness.page.attachmentCount, 0);
  assert.equal(harness.page.activeDeliveryTransactions, 0);
});

test("REQUIRED rejection: a pre-existing attachment survives without any prompt write", async () => {
  const harness = createWorkflowHarness({ initialAttachmentCount: 1 });
  const retainedNode = attachmentNode(harness);
  await startAndSettle(harness);
  assertNoDispatch(harness, 0);
  assert.equal(harness.stored().status, "paused");
  assert.equal(harness.stored().lastErrorCode, "unexpected_attachment");
  assert.equal(harness.stored().resumable, false);
  assert.equal(harness.page.text, "");
  assert.equal(harness.page.attachmentCount, 1);
  assert.equal(attachmentNode(harness), retainedNode);
});

test("REQUIRED rejection: a trusted same-length user edit is preserved without Send", async () => {
  const editedText = ASCII_PROMPT.slice(0, -1) + "X";
  const harness = createWorkflowHarness({
    onWrite({ page }) { page.text = editedText; page.userMutationEpoch += 1; }
  });
  await startAndSettle(harness);
  assert.equal(editedText.length, ASCII_PROMPT.length);
  assert.equal(harness.page.userMutationEpoch, 1);
  assertNoDispatch(harness, 1);
  assert.equal(harness.stored().status, "paused");
  assert.equal(harness.stored().lastErrorCode, "paste_attachment_provenance_lost");
  assert.equal(harness.stored().resumable, false);
  assert.equal(digest(harness.page.text), digest(editedText));
  assert.equal(harness.page.attachmentCount, 0);
});

for (const [control, status] of [["AIPM_PAUSE", "paused"], ["AIPM_STOP", "stopped"]]) {
  test(`REQUIRED rejection: ${control} prevents Send even after delayed conversion executes`, async () => {
    let writeAt = null;
    let controlIssued = false;
    let controlResponse = null;
    let harness;
    harness = createWorkflowHarness({
      onWrite({ page }) { writeAt = harness.now(); page.text = ""; },
      pasteAttachmentTimeline: [{ afterMs: 20_000, type: "convert" }],
      async onRunGet({ message }) {
        if (!controlIssued && writeAt !== null && message.authorityBoundary === "send-preflight" &&
            harness.now() - writeAt >= 15_000) {
          controlIssued = true;
          controlResponse = await harness.control(control);
        }
        return null;
      }
    });
    await startAndSettle(harness);
    assert.equal(controlIssued, true);
    assert.equal(controlResponse?.ok, true);
    assert.equal(harness.stored().status, status);
    assert.equal(conversions(harness).length, 0);
    assertNoDispatch(harness, 1);
    const cancelledRun = harness.stored();
    harness.advance(20_000 - (harness.now() - writeAt) + 1);
    await harness.settle();
    assert.equal(conversions(harness).length, 1, "the mutation must occur after cancellation");
    assert.equal(harness.page.text, "");
    assert.equal(harness.page.attachmentCount, 1);
    assert.deepEqual(harness.stored(), cancelledRun);
    assertNoDispatch(harness, 1);
  });
}


test("REQUIRED rejection: a queued foreign attachment accompanied by a trusted file action is preserved", async () => {
  let foreignNode = null;
  let writeAt = null;
  let harness;
  harness = createWorkflowHarness({
    onWrite({ page }) { writeAt = harness.now(); page.text = ""; },
    onRunGet({ message, page }) {
      if (!foreignNode && writeAt !== null && message.authorityBoundary === "send-preflight" &&
          harness.now() - writeAt >= 5_000) {
        page.attachmentCount = 1;
        page.userMutationEpoch += 1;
        foreignNode = attachmentNode(harness);
      }
      return null;
    }
  });
  await startAndSettle(harness);
  assert.ok(foreignNode);
  assertNoDispatch(harness, 1);
  assert.equal(harness.stored().lastErrorCode, "paste_attachment_provenance_lost");
  assert.equal(harness.stored().resumable, false);
  assert.equal(harness.page.attachmentCount, 1);
  assert.equal(attachmentNode(harness), foreignNode);
});
