import assert from "node:assert/strict";
import test from "node:test";

import { createWorkflowHarness } from "./helpers/workflow-harness.mjs";

const LONG_PROMPT = Array.from({ length: 600 }, (_, index) =>
  `Practical long-paste line ${index}: strict features remain available.`).join("\n");
const CLAUDE_DEVELOPMENT_SIZE_PROMPT = `CLAUDE DEVELOPMENT\n${"C".repeat(48 * 1024)}`;
const GEMINI_DEVELOPMENT_SIZE_PROMPT = `GEMINI DEVELOPMENT\n${"G".repeat(64 * 1024)}`;

function workflow(prompt, repeat = 1) {
  return {
    schemaVersion: 1,
    id: `practical-long-paste-${repeat}`,
    name: "Practical long-paste",
    maxSends: repeat,
    steps: [{
      id: "practical-prompt",
      type: "prompt",
      delivery: "send",
      prompt,
      repeat,
      delayAfterMs: 0
    }]
  };
}

async function run(prompt, options = {}, repeat = 1) {
  const harness = createWorkflowHarness(options);
  await harness.ready();
  const response = await harness.start(workflow(prompt, repeat));
  await harness.settle();
  return { harness, response };
}

function assertRequiredAttachmentSuccess(harness, repeat = 1) {
  // Feature acceptance, deliberately not an assertion that stopping is success.
  // The fixture knows it converted the approved prompt; production must acquire
  // sufficient evidence to accept that case without accepting unrelated files.
  assert.equal(harness.stored().status, "completed");
  assert.equal(harness.page.clicks, repeat);
  assert.equal(harness.stored().cursor.sendsCompleted, repeat);
  assert.equal(new Set(harness.clicks().map(entry => entry.position)).size, repeat);
  assert.equal(harness.saves().some(saved => saved.outbox?.deliveryMode === "paste-attachment"), true);
}

test("LP1: normal short composer text sends once in text mode", async () => {
  const { harness } = await run("LP1 short");
  assert.equal(harness.page.clicks, 1);
  assert.equal(harness.saves().some((saved) => saved.outbox?.deliveryMode === "text"), true);
});

test("LP2: a long Prompt may remain ordinary composer text", async () => {
  const { harness } = await run(LONG_PROMPT);
  assert.equal(harness.page.clicks, 1);
  assert.equal(harness.stored().status, "completed");
});

test("LP3: an immediate conversion of the approved prompt must send once", async () => {
  const { harness } = await run(LONG_PROMPT, { convertPasteToAttachment: true });
  assertRequiredAttachmentSuccess(harness);
});

test("LP4: asynchronous conversion of the approved prompt must send once", async () => {
  const { harness } = await run(LONG_PROMPT, {
    pasteAttachmentTimeline: [{ afterMs: 350, type: "convert" }]
  });
  assert.equal(harness.transcript.some((entry) =>
    entry.type === "paste-attachment-timeline" && entry.action === "convert"), true);
  assertRequiredAttachmentSuccess(harness);
});

test("LP5: repeated exact long text waits for generation completion before its next Send", async () => {
  const generationMs = 4_000;
  const { harness } = await run(LONG_PROMPT, { generationMs }, 2);
  const clicks = harness.clicks();
  assert.equal(clicks.length, 2);
  assert.ok(clicks[1].at >= clicks[0].at + generationMs);
  assert.equal(harness.stored().status, "completed");
  assert.equal(harness.stored().cursor.sendsCompleted, 2);
});

test("LP6: exact long text with an ambiguous ACK is never replayed", async () => {
  const { harness } = await run(LONG_PROMPT, { ackConfirms: false }, 2);
  assert.equal(harness.page.clicks, 1);
  assert.equal(harness.stored().status, "paused");
  assert.equal(harness.stored().lastErrorCode, "submission_ambiguous");
  assert.equal(harness.stored().outbox?.state, "submitted");
  assert.equal(harness.stored().cursor.sendsCompleted, 0);
  const resume = await harness.control("AIPM_RESUME");
  await harness.settle();
  assert.equal(resume.ok, false);
  assert.equal(harness.page.clicks, 1);
});

test("LP7: Pause after exact long-text ACK preserves the remaining repeat for explicit Resume", async () => {
  let pauseRequested = false;
  let harness;
  harness = createWorkflowHarness({
    async onSave({ run }) {
      if (pauseRequested || run.outbox?.state !== "confirmed") return;
      pauseRequested = true;
      const pause = await harness.control("AIPM_PAUSE");
      assert.equal(pause.ok, true);
    }
  });
  await harness.ready();
  await harness.start(workflow(LONG_PROMPT, 2));
  await harness.settle();
  assert.equal(pauseRequested, true);
  assert.equal(harness.page.clicks, 1);
  assert.equal(harness.stored().status, "paused");
  assert.equal(harness.stored().cursor.sendsCompleted, 1);
  assert.equal(harness.stored().outbox, null);
  const resume = await harness.control("AIPM_RESUME");
  await harness.settle();
  assert.equal(resume.ok, true);
  assert.equal(harness.page.clicks, 2);
  assert.equal(new Set(harness.clicks().map((entry) => entry.position)).size, 2);
  assert.equal(harness.stored().status, "completed");
});

test("LP8: a pre-existing user attachment is preserved and blocks mutation", async () => {
  const { harness } = await run(LONG_PROMPT, { initialAttachmentCount: 1 });
  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.page.attachmentCount, 1);
  assert.equal(harness.transcript.some((entry) => entry.type === "write"), false);
});

test("LP9: approved initial text is included once without changing the macro", async () => {
  const manualText = "SYNTHETIC INITIAL INPUT";
  const harness = createWorkflowHarness({ initialComposerText: manualText });
  Object.assign(harness.context, {
    navigation: { currentEntry: { key: "lp9-entry", id: "lp9-id" },
      addEventListener() {}, removeEventListener() {} },
    addEventListener() {}, removeEventListener() {}
  });
  harness.context.window = harness.context;
  await harness.ready();
  assert.equal((await harness.start(workflow(LONG_PROMPT, 2))).ok, true);
  await harness.settle();
  assert.equal(harness.stored().status, "completed");
  assert.equal(harness.page.clicks, 2);
  assert.deepEqual(harness.clicks().map(entry => entry.prompt), [manualText + "\n" + LONG_PROMPT, LONG_PROMPT]);
  assert.equal(harness.stored().workflow.steps[0].prompt, LONG_PROMPT);
  assert.equal(harness.stored().cursor.sendsCompleted, 2);
});

test("LP10: twenty approved long-paste conversions must complete twenty distinct positions", async () => {
  const { harness } = await run(LONG_PROMPT, { convertPasteToAttachment: true }, 20);
  assertRequiredAttachmentSuccess(harness, 20);
});

for (const [caseId, prompt] of [
  ["LP11", CLAUDE_DEVELOPMENT_SIZE_PROMPT],
  ["LP12", GEMINI_DEVELOPMENT_SIZE_PROMPT]
]) {
  test(`${caseId}: development-sized exact composer text still completes Repeat20`, async () => {
    const { harness } = await run(prompt, {}, 20);
    assert.equal(harness.page.clicks, 20);
    assert.equal(new Set(harness.clicks().map((entry) => entry.position)).size, 20);
    assert.equal(harness.stored().status, "completed");
    assert.equal(harness.stored().cursor.sendsCompleted, 20);
  });

  test(`${caseId}: development-sized converted prompts must complete Repeat20`, async () => {
    const { harness } = await run(prompt, { convertPasteToAttachment: true }, 20);
    assertRequiredAttachmentSuccess(harness, 20);
  });
}

for (const [caseId, clearAfterMs] of [["LP5", 1000], ["LP6", 500], ["LP7", 4500]]) {
  test(`${caseId} attachment: an approved tile may remain while generation settles`, async () => {
    const { harness } = await run(LONG_PROMPT, {
      generationMs: 4000, convertPasteToAttachment: true, preserveAttachmentAfterClick: true,
      pasteAttachmentTimeline: [{ afterMs: clearAfterMs, type: "clear" }]
    });
    assertRequiredAttachmentSuccess(harness);
  });
}

test("LP13 attachment: minimal newline residue must remain cleared across converted Repeat20", async () => {
  const { harness } = await run(LONG_PROMPT, {
    convertPasteToAttachment: true, composerTextAfterClick: "\n"
  }, 20);
  assertRequiredAttachmentSuccess(harness, 20);
});

test("LP13: minimal newline residue remains cleared across exact-text Repeat20", async () => {
  const { harness } = await run(LONG_PROMPT, {
    composerTextAfterClick: "\n"
  }, 20);
  assert.equal(harness.page.clicks, 20);
  assert.equal(new Set(harness.clicks().map((entry) => entry.position)).size, 20);
  assert.equal(harness.page.text, "\n");
  assert.equal(harness.stored().status, "completed");
});
