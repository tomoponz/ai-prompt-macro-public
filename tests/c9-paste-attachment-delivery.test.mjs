import test from "node:test";
import assert from "node:assert/strict";

import { createWorkflowHarness } from "./helpers/workflow-harness.mjs";

function attachmentWorkflow(repeat = 1, prompt = "C9 LONG PROMPT\n".repeat(400)) {
  return {
    schemaVersion: 1,
    id: `c9-paste-attachment-${repeat}`,
    name: "C9 paste attachment delivery",
    maxSends: repeat,
    steps: [{
      id: "c9-long-prompt",
      type: "prompt",
      delivery: "send",
      prompt,
      repeat,
      delayAfterMs: 0
    }]
  };
}

async function startAndSettle(repeat) {
  const harness = createWorkflowHarness({ convertPasteToAttachment: true });
  await harness.ready();
  const response = await harness.start(attachmentWorkflow(repeat));
  await harness.settle();
  return { harness, response };
}

async function runHarness(options = {}, { repeat = 1, prompt } = {}) {
  const harness = createWorkflowHarness(options);
  await harness.ready();
  const response = await harness.start(attachmentWorkflow(repeat, prompt));
  await harness.settle();
  return { harness, response };
}

test("C9 R1: a pre-existing attachment blocks Prompt mutation and Send", async () => {
  const { harness } = await runHarness({ initialAttachmentCount: 1 });
  assert.equal(harness.transcript.some((entry) => entry.type === "write"), false);
  assert.equal(harness.page.clicks, 0);
});

test("C9 R2: a short Prompt remains TEXT mode and sends exactly once", async () => {
  const { harness } = await runHarness({}, { prompt: "C9 SHORT" });
  assert.equal(harness.page.clicks, 1);
  assert.equal(harness.saves().some((run) => run.outbox?.deliveryMode === "text"), true);
});

test("C9 R3 RED: a Macro long paste converted to one attachment sends exactly once", async () => {
  const { harness, response } = await startAndSettle(1);
  assert.equal(response.ok, true);
  assert.equal(harness.page.clicks, 1);
  assert.equal(harness.stored().status, "completed");
});

test("C9 R4 RED: Macro paste attachment delivery repeats five times exactly once", async () => {
  const { harness, response } = await startAndSettle(5);
  assert.equal(response.ok, true);
  assert.equal(harness.page.clicks, 5);
  assert.equal(new Set(harness.clicks().map((entry) => entry.position)).size, 5);
  assert.equal(harness.stored().status, "completed");
});

for (const userRace of ["file-attach", "drop", "paste", "typing", "attachment-remove"]) {
  test(`C9 R5: trusted user ${userRace} invalidates Macro attachment provenance`, async () => {
    const { harness } = await runHarness({
      convertPasteToAttachment: true,
      onWrite: ({ page }) => { page.userMutationEpoch += 1; }
    });
    assert.equal(harness.page.clicks, 0);
    assert.equal(harness.stored().lastErrorCode, "paste_attachment_provenance_lost");
  });
}

test("C9 R6: an unknown second attachment after Macro paste sends zero", async () => {
  const { harness } = await runHarness({
    convertPasteToAttachment: true,
    onWrite: ({ page }) => { page.attachmentCount = 2; }
  });
  assert.equal(harness.page.clicks, 0);
});

test("C9 R7 Practical: React may replace the iteration-owned tile before click", async () => {
  const { harness } = await runHarness({
    convertPasteToAttachment: true,
    onSave: ({ run, page }) => {
      if (run.phase !== "submitting") return;
      page.attachmentCount = 0;
      page.attachmentCount = 1;
    }
  });
  assert.equal(harness.page.clicks, 1);
  assert.equal(harness.stored().status, "completed");
});

test("C9 R8: a document change during attachment delivery sends zero", async () => {
  let changed = false;
  const harness = createWorkflowHarness({
    convertPasteToAttachment: true,
    onWrite: ({ context }) => {
      if (!changed) {
        changed = true;
        context.instanceId = "document-after-paste";
      }
    }
  });
  await harness.ready();
  harness.pinCurrentDocument();
  await harness.start(attachmentWorkflow());
  await harness.settle();
  assert.equal(harness.page.clicks, 0);
});

test("C9 R9: a conversation change during attachment delivery sends zero", async () => {
  let harness;
  harness = createWorkflowHarness({
    convertPasteToAttachment: true,
    onWrite: () => harness.setConversationKey("chatgpt:c:different-conversation")
  });
  await harness.ready();
  await harness.start(attachmentWorkflow());
  await harness.settle();
  assert.equal(harness.page.clicks, 0);
});

test("C9 R10: a Run revision race after attachment conversion sends zero", async () => {
  let harness;
  let changed = false;
  harness = createWorkflowHarness({
    convertPasteToAttachment: true,
    onRunGet: () => {
      if (!changed && harness.page.attachmentCount === 1) {
        changed = true;
        harness.injectDurableRun((run) => ({ ...run, stateRevision: run.stateRevision + 1 }));
      }
      return null;
    }
  });
  await harness.ready();
  await harness.start(attachmentWorkflow());
  await harness.settle();
  assert.equal(harness.page.clicks, 0);
});

test("C9 R11: durable Stop during attachment conversion wins and sends zero", async () => {
  let harness;
  let stopped = false;
  harness = createWorkflowHarness({
    convertPasteToAttachment: true,
    onRunGet: async () => {
      if (!stopped && harness.page.attachmentCount === 1) {
        stopped = true;
        await harness.control("AIPM_STOP");
      }
      return null;
    }
  });
  await harness.ready();
  await harness.start(attachmentWorkflow());
  await harness.settle();
  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.stored().status, "stopped");
});

test("C9 R12: reload before click loses local provenance and never auto-sends", async () => {
  let invalidated = false;
  const harness = createWorkflowHarness({
    convertPasteToAttachment: true,
    onRunGet: ({ context, page }) => {
      if (!invalidated && page.attachmentCount === 1) {
        invalidated = true;
        context.localRunnerToken += 1;
      }
      return null;
    }
  });
  await harness.ready();
  await harness.start(attachmentWorkflow());
  await harness.settle();
  const clicksBefore = harness.page.clicks;
  await harness.reload();
  assert.equal(clicksBefore, 0);
  assert.equal(harness.page.clicks, 0);
});

test("C9 R13: ambiguous attachment ACK never retries the irreversible click", async () => {
  const { harness } = await runHarness({ convertPasteToAttachment: true, ackConfirms: false });
  assert.equal(harness.page.clicks, 1);
  await harness.reload();
  assert.equal(harness.page.clicks, 1);
});

test("C9 R14: each Repeat position creates a fresh attachment transaction", async () => {
  const { harness } = await runHarness({ convertPasteToAttachment: true }, { repeat: 2 });
  assert.equal(harness.page.clicks, 2);
  assert.deepEqual(harness.clicks().map((entry) => entry.position), ["0:0", "0:1"]);
  assert.equal(harness.page.attachmentCount, 0);
});

test("C9 R15: a residual sent attachment prevents every later position", async () => {
  const { harness } = await runHarness({
    convertPasteToAttachment: true,
    preserveAttachmentAfterClick: true
  }, { repeat: 2 });
  assert.equal(harness.page.clicks, 1);
  assert.equal(harness.page.attachmentCount, 1);
});

for (const repeat of [20, 40]) {
  test(`C9 R${repeat === 20 ? 16 : 17}: attachment Repeat=${repeat} completes exactly`, async () => {
    const { harness } = await runHarness({ convertPasteToAttachment: true }, { repeat });
    assert.equal(harness.page.clicks, repeat);
    assert.equal(new Set(harness.clicks().map((entry) => entry.position)).size, repeat);
    assert.equal(harness.stored().status, "completed");
  });
}

test("C9 R18: C8 recovered identity keeps the same attachment transaction exactly once", async () => {
  let recovered = false;
  const { harness } = await runHarness({
    convertPasteToAttachment: true,
    onRunGet: ({ storedRun }) => {
      if (!recovered && storedRun?.outbox?.state === "prepared") {
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
            episodeId: "c9-recovery",
            consecutiveUnavailable: 3,
            recoveryElapsedMs: 700
          }
        };
      }
      return null;
    }
  });
  assert.equal(harness.page.clicks, 1);
});

test("C9 R19: an unknown attachment added after C8 recovery sends zero", async () => {
  let injected = false;
  const { harness } = await runHarness({
    convertPasteToAttachment: true,
    onRunGet: ({ storedRun, page }) => {
      if (!injected && page.attachmentCount === 1) {
        injected = true;
        page.attachmentCount = 2;
        return {
          ok: true,
          run: storedRun,
          identityObservation: {
            outcome: "match",
            reason: "timeout",
            attempt: 4,
            totalAttempts: 5,
            boundary: "send-preflight",
            episodeId: "c9-extra",
            consecutiveUnavailable: 3
          }
        };
      }
      return null;
    }
  });
  assert.equal(harness.page.clicks, 0);
});

test("C9 R20: assistant-history attachments are outside composer authority", async () => {
  const harness = createWorkflowHarness({ convertPasteToAttachment: true });
  harness.page.assistantAttachmentCount = 9;
  await harness.ready();
  await harness.start(attachmentWorkflow());
  await harness.settle();
  assert.equal(harness.page.clicks, 1);
  assert.equal(harness.adapterCalls.has("readAssistantAttachment"), false);
});

test("C9 Pause: attachment Send #2 is confirmed once, then Resume continues at #3", async () => {
  let armed = true;
  let pauseResponse = null;
  let harness;
  harness = createWorkflowHarness({
    convertPasteToAttachment: true,
    async onRunSet({ message, page }) {
      if (!armed || message.run?.phase !== "waiting-ack" || page.clicks !== 2) return null;
      armed = false;
      pauseResponse = await harness.control("AIPM_PAUSE");
      return null;
    }
  });
  await harness.ready();
  await harness.start(attachmentWorkflow(5));
  await harness.settle();

  assert.equal(armed, false);
  assert.equal(pauseResponse?.ok, true);
  assert.equal(harness.page.clicks, 2);
  assert.equal(harness.stored().status, "paused");
  assert.equal(harness.stored().cursor.sendsCompleted, 2);

  const resume = await harness.control("AIPM_RESUME");
  await harness.settle();
  assert.equal(resume.ok, true);
  assert.equal(harness.stored().status, "completed");
  assert.equal(harness.stored().cursor.sendsCompleted, 5);
  assert.equal(harness.page.clicks, 5);
  assert.equal(new Set(harness.clicks().map((entry) => entry.position)).size, 5);
});

test("C9 sequence: long A/B, short C, long D preserve exact order and mode", async () => {
  const prompts = ["A", "B", "D"].map((value) => Array(400).fill(value).join("\n"));
  prompts.splice(2, 0, "C SHORT");
  const workflow = {
    schemaVersion: 1,
    id: "c9-sequence",
    name: "C9 sequence",
    maxSends: 4,
    steps: prompts.map((prompt, index) => ({
      id: `c9-${index}`,
      type: "prompt",
      delivery: "send",
      prompt,
      repeat: 1,
      delayAfterMs: 0
    }))
  };
  const harness = createWorkflowHarness({
    convertPasteToAttachment: ({ text }) => text !== "C SHORT"
  });
  await harness.ready();
  await harness.start(workflow);
  await harness.settle();
  assert.deepEqual(harness.clicks().map((entry) => entry.prompt), prompts);
  assert.equal(harness.page.clicks, 4);
});
