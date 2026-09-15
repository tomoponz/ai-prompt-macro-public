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

test("LP3: an immediate pasted-text conversion belongs to this clean iteration", async () => {
  const { harness } = await run(LONG_PROMPT, { convertPasteToAttachment: true });
  assert.equal(harness.page.clicks, 1);
  assert.equal(harness.saves().some((saved) => saved.outbox?.deliveryMode === "paste-attachment"), true);
});

test("LP4: exact text may asynchronously convert to one pasted-text tile", async () => {
  const { harness } = await run(LONG_PROMPT, {
    pasteAttachmentTimeline: [{ afterMs: 350, type: "convert" }]
  });
  assert.equal(harness.page.clicks, 1);
  assert.equal(harness.saves().some((saved) => saved.outbox?.deliveryMode === "paste-attachment"), true);
});

for (const [caseId, clearAfterMs, relation] of [
  ["LP5", 1_000, "during"],
  ["LP6", 500, "shortly-after-start"],
  ["LP7", 4_500, "after-completion"]
]) {
  test(`${caseId}: an iteration-owned tile may settle ${relation} generation`, async () => {
    const generationMs = 4_000;
    const { harness } = await run(LONG_PROMPT, {
      generationMs,
      convertPasteToAttachment: true,
      preserveAttachmentAfterClick: true,
      pasteAttachmentTimeline: [{ afterMs: clearAfterMs, type: "clear" }]
    });
    const click = harness.clicks()[0];
    const clear = harness.transcript.find((entry) =>
      entry.type === "paste-attachment-timeline" && entry.action === "clear");
    assert.ok(click);
    assert.ok(clear);
    if (caseId === "LP7") assert.ok(clear.at > click.at + generationMs);
    else assert.ok(clear.at < click.at + generationMs);
    assert.equal(harness.page.clicks, 1);
    assert.equal(harness.stored().status, "completed");
  });
}

test("LP8: a pre-existing user attachment is preserved and blocks mutation", async () => {
  const { harness } = await run(LONG_PROMPT, { initialAttachmentCount: 1 });
  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.page.attachmentCount, 1);
  assert.equal(harness.transcript.some((entry) => entry.type === "write"), false);
});

test("LP9: pre-existing manual text is preserved and blocks mutation", async () => {
  const manualText = "ユーザーが入力中の下書き";
  const { harness } = await run(LONG_PROMPT, { initialComposerText: manualText });
  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.page.text, manualText);
  assert.equal(harness.transcript.some((entry) => entry.type === "write"), false);
  assert.equal(harness.stored().lastErrorCode, "draft_present");
});

test("LP10: twenty consecutive long-paste conversions use twenty fresh iteration owners", async () => {
  const { harness } = await run(LONG_PROMPT, { convertPasteToAttachment: true }, 20);
  assert.equal(harness.page.clicks, 20);
  assert.equal(new Set(harness.clicks().map((entry) => entry.position)).size, 20);
  assert.equal(harness.stored().status, "completed");
});

for (const [caseId, prompt] of [
  ["LP11", CLAUDE_DEVELOPMENT_SIZE_PROMPT],
  ["LP12", GEMINI_DEVELOPMENT_SIZE_PROMPT]
]) {
  test(`${caseId}: development-sized Prompt Repeat20 completes as pasted-text`, async () => {
    const { harness } = await run(prompt, { convertPasteToAttachment: true }, 20);
    assert.equal(harness.page.clicks, 20);
    assert.equal(new Set(harness.clicks().map((entry) => entry.position)).size, 20);
    assert.equal(harness.stored().status, "completed");
  });
}

test("LP13: minimal newline residue remains cleared across pasted-text Repeat20", async () => {
  const { harness } = await run(LONG_PROMPT, {
    convertPasteToAttachment: true,
    composerTextAfterClick: "\n"
  }, 20);
  assert.equal(harness.page.clicks, 20);
  assert.equal(new Set(harness.clicks().map((entry) => entry.position)).size, 20);
  assert.equal(harness.page.text, "\n");
  assert.equal(harness.stored().status, "completed");
});
