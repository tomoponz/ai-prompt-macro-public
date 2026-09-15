import test from "node:test";
import assert from "node:assert/strict";

import { createWorkflowHarness } from "./helpers/workflow-harness.mjs";

const CLOCK_START = 1_700_000_000_000;

test("R4: schedule_skipped diagnostic never-settle cannot block cursor commit or the next Prompt", async () => {
  const diagnosticNeverSettles = new Promise(() => {});
  const harness = createWorkflowHarness({
    onStorageGet: () => diagnosticNeverSettles
  });
  const workflow = {
    schemaVersion: 1,
    id: "skip-diagnostic",
    name: "Skip diagnostic",
    maxSends: 1,
    steps: [
      { id: "lead", type: "delay", durationMs: 10_000 },
      {
        id: "skip",
        type: "wait-until",
        at: new Date(CLOCK_START + 1_000).toISOString(),
        latePolicy: "skip",
        graceMs: 1_000
      },
      { id: "after", type: "prompt", delivery: "send", prompt: "AFTER SKIP", repeat: 1, delayAfterMs: 0 }
    ]
  };

  const started = await harness.start(workflow);
  assert.equal(started.ok, true);

  for (let attempt = 0; attempt < 50 && harness.stored()?.status !== "completed"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.equal(harness.page.clicks, 1, "the next Prompt must still send exactly once");
  assert.equal(harness.stored().cursor.sendsCompleted, 1);
  assert.equal(harness.stored().status, "completed");
});
