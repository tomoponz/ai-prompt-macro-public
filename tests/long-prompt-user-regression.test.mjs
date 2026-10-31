import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import { createWorkflowHarness } from "./helpers/workflow-harness.mjs";

// Production runner/controller, synthetic adapter and clock. These cases model
// observable input states; they do not reproduce ChatGPT's editor or uploader.
const REPORTED_PROMPT = "test".repeat(20_160);
const REPORTED_OBSERVATION_MS = 29_120;
const SETTLEMENT_DEADLINE_MS = 30_000;
const LARGE_UNICODE_PROMPT = "日本語🚀e\u0301👩‍💻<tag>&\n".repeat(5_000) + "終";
const digest = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const writes = (harness) => harness.transcript.filter((entry) => entry.type === "write");
const conversionEvents = (harness) => harness.transcript.filter((entry) =>
  entry.type === "paste-attachment-timeline" && entry.action === "convert");

function workflow(prompt = REPORTED_PROMPT) {
  return {
    schemaVersion: 1,
    id: "long-prompt-user-regression",
    name: "Synthetic long prompt regression",
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

async function startAndSettle(harness, prompt = REPORTED_PROMPT) {
  await harness.ready();
  const response = await harness.start(workflow(prompt));
  assert.equal(response.ok, true, "the test must reach execution, not fail Start validation");
  await harness.settle();
  await new Promise((resolve) => setImmediate(resolve));
}

function assertNoDispatch(harness) {
  assert.equal(harness.page.clicks, 0);
  assert.deepEqual(harness.stored().cursor, { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 });
  assert.equal(writes(harness).length, 1);
  assert.equal(harness.saves().some((run) =>
    ["submitting", "waiting-ack"].includes(run.phase) ||
    ["submitted", "confirmed"].includes(run.outbox?.state)), false);
}

function assertBlocked(harness, code) {
  const saved = harness.stored();
  assertNoDispatch(harness);
  assert.equal(saved.status, "paused");
  assert.equal(saved.lastErrorCode, code);
  assert.equal(saved.resumable, false);
  assert.equal(saved.outbox?.state, "prepared");
  assert.equal(saved.outbox?.deliveryMode, "pending");
  assert.equal(saved.workflow.steps[0].repeat, 3);
  assert.equal(saved.workflow.steps[0].delayAfterMs, 0);
  assert.equal(digest(saved.workflow.steps[0].prompt), digest(REPORTED_PROMPT));
  assert.equal(harness.page.activeDeliveryTransactions, 0);
}

function assertPendingTimeout(harness) {
  assertBlocked(harness, "paste_attachment_settlement_timeout");
  assert.equal(harness.page.text, "");
  assert.equal(harness.page.attachmentCount, 0);
  const diagnostic = harness.diagnostics().find((entry) => entry.type === "paste_attachment_settlement");
  assert.equal(diagnostic?.lastState, "attachment-pending");
  assert.equal(diagnostic?.deadlineMs, SETTLEMENT_DEADLINE_MS);
  assert.equal(diagnostic?.logicalAttachmentCount, 0);
  assert.ok(diagnostic?.elapsedMs >= REPORTED_OBSERVATION_MS);
  assert.ok(diagnostic?.elapsedMs <= SETTLEMENT_DEADLINE_MS);
  assert.deepEqual(Object.keys(diagnostic).filter((key) =>
    /textContent|innerText|filename|title|url|html|prompt/i.test(key)), []);
  assert.equal(JSON.stringify(harness.diagnostics()).includes(REPORTED_PROMPT), false);
  const elapsed = harness.now() - writes(harness)[0].at;
  assert.ok(elapsed >= SETTLEMENT_DEADLINE_MS);
  assert.ok(elapsed <= SETTLEMENT_DEADLINE_MS + 250);
}

function attachmentNode(harness) {
  const adapter = harness.context.ChatGptAdapter;
  return adapter.getComposerAttachmentState(adapter.findComposer()).logicalNodes[0];
}

function assertConvertedRepeatCompleted(harness) {
  assert.equal(harness.stored().status, "completed");
  assert.equal(harness.page.clicks, 3);
  assert.equal(harness.stored().cursor.sendsCompleted, 3);
  assert.equal(writes(harness).length, 3);
  assert.deepEqual(harness.clicks().map(entry => entry.position), ["0:0", "0:1", "0:2"]);
  assert.equal(harness.saves().some(run => run.outbox?.deliveryMode === "paste-attachment"), true);
  assert.equal(harness.page.activeDeliveryTransactions, 0);
}

for (const [label, prompt] of [
  ["80,640 ASCII characters", REPORTED_PROMPT],
  ["large Unicode containing non-BMP, combining, ZWJ and escaped characters", LARGE_UNICODE_PROMPT]
]) {
  test(`long prompt: ${label} remains exact text for Repeat3 with no delay`, async () => {
    assert.ok(prompt.length >= 80_640);
    const harness = createWorkflowHarness();
    const clickedTextDigests = [];
    const button = harness.context.ChatGptAdapter.findSendButton();
    const originalClick = button.click;
    button.click = function (...args) {
      // clicks().prompt uses the original pendingPrompt in this adapter. Observe
      // the current composer immediately before dispatch to avoid that false oracle.
      clickedTextDigests.push(digest(harness.page.text));
      return originalClick.apply(this, args);
    };
    await startAndSettle(harness, prompt);
    assert.equal(harness.stored().status, "completed");
    assert.equal(harness.stored().cursor.sendsCompleted, 3);
    assert.equal(harness.page.clicks, 3);
    assert.equal(writes(harness).length, 3);
    assert.deepEqual(clickedTextDigests, Array(3).fill(digest(prompt)));
    assert.deepEqual(harness.clicks().map((entry) => entry.position), ["0:0", "0:1", "0:2"]);
    assert.equal(harness.page.attachmentCount, 0);
    assert.equal(harness.page.activeDeliveryTransactions, 0);
  });
}

test("long prompt: reported 80,640/Repeat3/wait0 remains pre-send at 29,120ms and times out without a final attachment", async () => {
  assert.equal(REPORTED_PROMPT.length, 80_640);
  let observed = null;
  let writeAt = null;
  let harness;
  harness = createWorkflowHarness({
    onWrite({ page }) {
      writeAt = harness.now();
      page.text = "";
    },
    onRunGet({ message, storedRun }) {
      if (!observed && writeAt !== null && message.authorityBoundary === "send-preflight" &&
          harness.now() - writeAt >= REPORTED_OBSERVATION_MS) {
        observed = { elapsed: harness.now() - writeAt, run: storedRun };
        assertNoDispatch(harness);
      }
      return null;
    }
  });
  await startAndSettle(harness);
  assert.ok(observed, "the reported observation interval must actually be reached");
  // The report's 29,120ms is an observation, not a replacement production deadline.
  assert.ok(observed.elapsed >= REPORTED_OBSERVATION_MS);
  assert.ok(observed.elapsed <= REPORTED_OBSERVATION_MS + 250);
  assert.equal(observed.run.status, "running");
  assert.equal(observed.run.outbox?.state, "prepared");
  assert.equal(observed.run.outbox?.deliveryMode, "pending");
  assertPendingTimeout(harness);
});

test("long prompt: a synthetic upload failure with no distinguishable DOM signal remains a pending timeout", async () => {
  let syntheticUploadFailed = false;
  let writeAt = null;
  let harness;
  harness = createWorkflowHarness({
    onWrite({ page }) { writeAt = harness.now(); page.text = ""; },
    onRunGet({ message }) {
      if (writeAt !== null && message.authorityBoundary === "send-preflight" &&
          harness.now() - writeAt >= 5_000) syntheticUploadFailed = true;
      // This out-of-band test oracle deliberately changes no adapter signal.
      // There is no uploader/network-failure seam here: do not invent an error
      // classifier or claim this distinguishes real failure from slow conversion.
      return null;
    }
  });
  await startAndSettle(harness);
  assert.equal(syntheticUploadFailed, true);
  assertPendingTimeout(harness);
});

test("long prompt: a ready scoped conversion after 5s completes all three positions", async () => {
  const harness = createWorkflowHarness({
    onWrite({ page }) { page.text = ""; },
    pasteAttachmentTimeline: [{ afterMs: 5_000, type: "convert" }]
  });
  await startAndSettle(harness);
  assert.equal(conversionEvents(harness).length, 3);
  const elapsed = harness.clicks()[0].at - writes(harness)[0].at;
  assert.ok(elapsed >= 5_000 && elapsed < 6_000);
  assertConvertedRepeatCompleted(harness);
});

test("long prompt: KNOWN LIMITATION: indistinguishable queued attachment can satisfy scoped lifecycle acceptance", async () => {
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
  assert.ok(foreignNode, "the independently queued foreign tile must have appeared");
  assert.equal(conversionEvents(harness).length, 0);
  assert.equal(harness.page.userMutationEpoch, 0);
  // No observable marker distinguishes this synthetic foreign tile. Keeping
  // this counterexample makes the product's conditional-provenance limit visible.
  assert.equal(harness.page.clicks, 1);
  assert.deepEqual(harness.clicks().map(entry => entry.position), ["0:0"]);
  assert.equal(harness.stored().cursor.sendsCompleted, 1);
  assert.equal(writes(harness).length, 2);
  assert.equal(harness.stored().lastErrorCode, "paste_attachment_settlement_timeout");
});

for (const trustedEdit of [false, true]) {
  test(`long prompt: same-length changed text is preserved ${trustedEdit ? "with" : "without"} a trusted edit signal`, async () => {
    const changedText = REPORTED_PROMPT.slice(0, -1) + "X";
    assert.equal(changedText.length, REPORTED_PROMPT.length);
    const harness = createWorkflowHarness({
      onWrite({ page }) {
        page.text = changedText;
        if (trustedEdit) page.userMutationEpoch += 1;
      }
    });
    await startAndSettle(harness);
    assertBlocked(harness, trustedEdit ? "composer_user_interaction" : "composer_verification_failed");
    assert.equal(digest(harness.page.text), digest(changedText));
    assert.equal(harness.page.attachmentCount, 0);
    assert.equal(harness.page.userMutationEpoch, trustedEdit ? 1 : 0);
  });
}

for (const [control, status] of [["AIPM_PAUSE", "paused"], ["AIPM_STOP", "stopped"]]) {
  test(`long prompt: ${control} wins even when a queued conversion really occurs afterwards`, async () => {
    let controlResponse = null;
    let controlIssued = false;
    let writeAt = null;
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
    assert.equal(conversionEvents(harness).length, 0);
    assertNoDispatch(harness);
    const stoppedSnapshot = harness.stored();
    harness.advance(20_000 - (harness.now() - writeAt) + 1);
    await harness.settle();
    assert.equal(conversionEvents(harness).length, 1, "the post-cancellation mutation must actually execute");
    assert.equal(harness.page.attachmentCount, 1);
    assert.equal(harness.page.activeDeliveryTransactions, 0);
    assert.deepEqual(harness.stored(), stoppedSnapshot);
    assertNoDispatch(harness);
    const retainedNode = attachmentNode(harness);
    const resume = await harness.control("AIPM_RESUME");
    await harness.settle();
    if (control === "AIPM_STOP") {
      assert.equal(resume.ok, false);
    } else {
      // An explicit Resume may be accepted as a control request. The runner must
      // then reject the now-pre-existing attachment before another write/click.
      assert.equal(resume.ok, true);
      assert.equal(harness.stored().status, "paused");
      assert.equal(harness.stored().lastErrorCode, "unexpected_attachment");
      assert.equal(harness.stored().resumable, false);
    }
    assertNoDispatch(harness);
    assert.equal(attachmentNode(harness), retainedNode);
  });
}
