import test from "node:test";
import assert from "node:assert/strict";

import { createWorkflowHarness } from "./helpers/workflow-harness.mjs";

function onePromptWorkflow(prompt = "C7 SHORT PROMPT") {
  return {
    schemaVersion: 1,
    id: "c7-attachment-safety",
    name: "C7 attachment safety",
    maxSends: 1,
    steps: [{
      id: "c7-send",
      type: "prompt",
      delivery: "send",
      prompt,
      repeat: 1,
      delayAfterMs: 0
    }]
  };
}

async function startAndSettle(harness, prompt = "C7 SHORT PROMPT") {
  await harness.ready();
  const response = await harness.start(onePromptWorkflow(prompt));
  await harness.settle();
  return response;
}

test("R1: a pre-existing composer attachment blocks Start delivery", async () => {
  const harness = createWorkflowHarness({ initialAttachmentCount: 1 });
  await startAndSettle(harness);
  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.stored().lastErrorCode, "unexpected_attachment");
});

test("R2: a pre-existing attachment prevents both Prompt write and Send", async () => {
  const harness = createWorkflowHarness({ initialAttachmentCount: 1 });
  await startAndSettle(harness);
  assert.equal(harness.transcript.some((entry) => entry.type === "write"), false);
  assert.equal(harness.page.clicks, 0);
});

test("R3: an attachment appearing immediately after write prevents Send", async () => {
  const harness = createWorkflowHarness({
    onWrite: ({ page }) => { page.attachmentCount = 1; }
  });
  await startAndSettle(harness);
  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.stored().lastErrorCode, "paste_attachment_provenance_lost");
});

test("R4: attachment conversion with an empty composer remains untouched and sends nothing", async () => {
  const harness = createWorkflowHarness({
    onWrite: ({ page }) => {
      page.userMutationEpoch += 1;
      page.attachmentCount = 1;
      page.text = "";
    }
  });
  await startAndSettle(harness, "C7 LONG PROMPT");
  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.page.attachmentCount, 1, "the extension must not delete user-visible attachment state");
  assert.equal(harness.stored().lastErrorCode, "paste_attachment_provenance_lost");
  assert.equal(harness.stored().resumable, false);
});

test("R5: an attachment appearing after submitting persistence is caught before click", async () => {
  let armed = true;
  const harness = createWorkflowHarness({
    onSave: ({ run, page }) => {
      if (armed && run.phase === "submitting") {
        armed = false;
        page.attachmentCount = 1;
      }
    }
  });
  await startAndSettle(harness);
  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.stored().lastErrorCode, "paste_attachment_provenance_lost");
});

test("R6: prepared recovery with a residual attachment never retries automatically", async () => {
  const harness = createWorkflowHarness({
    onWrite: ({ page }) => {
      page.userMutationEpoch += 1;
      page.attachmentCount = 1;
      page.text = "";
    }
  });
  await startAndSettle(harness, "C7 LONG PROMPT");
  const prepared = harness.saves().find((run) => run.phase === "prepared" && run.outbox?.state === "prepared");
  assert.ok(prepared, "the pre-submit durable snapshot must exist");

  harness.injectDurableRun({ ...prepared, status: "running", resumable: true });
  await harness.reload();

  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.transcript.filter((entry) => entry.type === "write").length, 1,
    "reload must not write the Prompt a second time while the attachment remains");
  assert.equal(harness.stored().resumable, false);
  assert.equal(harness.stored().phase, "attachment-blocked");
  assert.equal(harness.stored().outbox?.state, "prepared", "pre-click evidence remains durable for review");
});

test("R7: generic Resume cannot bypass an attachment conversion failure", async () => {
  const harness = createWorkflowHarness({
    onWrite: ({ page }) => {
      page.userMutationEpoch += 1;
      page.attachmentCount = 1;
      page.text = "";
    }
  });
  await startAndSettle(harness, "C7 LONG PROMPT");
  const before = harness.page.clicks;
  const response = await harness.control("AIPM_RESUME");
  await harness.settle();
  assert.equal(response.ok, false);
  assert.equal(harness.page.clicks, before);
  assert.equal(harness.page.attachmentCount, 1);

  const preExisting = createWorkflowHarness({ initialAttachmentCount: 1 });
  await startAndSettle(preExisting);
  assert.equal(preExisting.stored().outbox, null);
  const preExistingResume = await preExisting.control("AIPM_RESUME");
  await preExisting.settle();
  assert.equal(preExistingResume.ok, false);
  assert.match(preExistingResume.error, /添付ファイル/);
  assert.equal(preExisting.page.clicks, 0);
});

test("R8: Stop after attachment failure is durable and never deletes the attachment", async () => {
  const harness = createWorkflowHarness({ initialAttachmentCount: 1 });
  await startAndSettle(harness);
  const response = await harness.control("AIPM_STOP");
  await harness.settle();
  assert.equal(response.ok, true);
  assert.equal(harness.stored().status, "stopped");
  assert.equal(harness.page.attachmentCount, 1);
});

test("R9: manual attachment cleanup permits one exact fresh Run", async () => {
  const harness = createWorkflowHarness({ initialAttachmentCount: 1 });
  await startAndSettle(harness);
  await harness.control("AIPM_STOP");
  await harness.settle();

  harness.page.attachmentCount = 0;
  const response = await harness.start(onePromptWorkflow("C7 CLEAN RETRY"));
  await harness.settle();
  assert.equal(response.ok, true);
  assert.deepEqual(harness.clicks().map((entry) => entry.prompt), ["C7 CLEAN RETRY"]);
});

test("R10: a normal short Prompt with zero attachments still sends exactly once", async () => {
  const harness = createWorkflowHarness();
  await startAndSettle(harness, "C7 NORMAL");
  assert.deepEqual(harness.clicks().map((entry) => entry.prompt), ["C7 NORMAL"]);
  assert.equal(harness.stored().status, "completed");
});

test("C7: unknown or malformed attachment observations fail closed before Prompt mutation", async () => {
  for (const state of [
    { known: false, count: 0 },
    { known: true, count: Number.NaN },
    { known: true, count: -1 },
    { known: true, count: 1.5 },
    null
  ]) {
    const harness = createWorkflowHarness();
    harness.context.ChatGptAdapter.getComposerAttachmentState = () => state;
    await startAndSettle(harness);
    assert.equal(harness.page.clicks, 0);
    assert.equal(harness.transcript.some((entry) => entry.type === "write"), false);
    assert.equal(harness.stored().lastErrorCode, "composer_attachment_unconfirmed");
  }
});
