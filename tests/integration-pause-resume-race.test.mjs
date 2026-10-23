import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createWorkflowHarness } from "./helpers/workflow-harness.mjs";

const TEXT = "SYNTHETIC PAUSE FINALIZATION TEXT";
const runnerSource = fs.readFileSync(new URL("../src/content-runner.js", import.meta.url), "utf8");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); }
  };
}

async function pendingPauseFinalization(boundary) {
  const entered = deferred();
  const release = deferred();
  let pauseArmed = true;
  let gateArmed = true;
  let harness;
  const hold = async () => {
    if (!gateArmed) return;
    gateArmed = false;
    entered.resolve();
    await release.promise;
  };
  harness = createWorkflowHarness({
    async onRunGet({ storedRun, page }) {
      if (pauseArmed && storedRun?.phase === "prepared" && page.text) {
        pauseArmed = false;
        assert.equal((await harness.control("AIPM_PAUSE")).ok, true);
      }
      return null;
    },
    async onSave({ run }) {
      // The background emulator has committed Pause already. Only its response
      // to the old content invocation is held; the UI may independently Resume.
      if (boundary === "pause-response" && run.status === "paused" && run.pauseReason === "user-pause") {
        await hold();
      }
    },
    async onLease({ message, storedRun }) {
      if (boundary === "lease-release" && message.type === "AIPM_LEASE_RELEASE" &&
          storedRun?.status === "paused" && storedRun.pauseReason === "user-pause") {
        await hold();
      }
      return null;
    }
  });
  const lifecycle = eventTarget();
  Object.assign(harness.context, {
    navigation: Object.assign(eventTarget(), { currentEntry: { key: "entry-1", id: "entry-id-1" } }),
    addEventListener: lifecycle.addEventListener,
    removeEventListener: lifecycle.removeEventListener
  });
  harness.context.window = harness.context;
  await harness.ready();
  assert.equal((await harness.start({
    schemaVersion: 1, id: "pause-finalization-race", maxSends: 1,
    steps: [{ id: "send", type: "prompt", delivery: "send", prompt: TEXT, repeat: 1, delayAfterMs: 0 }]
  })).ok, true);
  await entered.promise;
  assert.equal(pauseArmed, false);
  assert.equal(harness.stored().status, "paused");
  assert.equal(harness.stored().pauseReason, "user-pause");
  assert.equal(harness.stored().outbox, null);
  assert.equal(harness.page.text, TEXT);
  return { harness, release: release.resolve };
}

const writes = harness => harness.transcript.filter(entry => entry.type === "write").length;

for (const boundary of ["pause-response", "lease-release"]) {
  for (const edited of [false, true]) {
    test(`Resume during ${boundary} is rejected until finalization; ${edited ? "user edit survives" : "later explicit Resume sends once"}`,
      { timeout: 10_000 }, async () => {
        const { harness, release } = await pendingPauseFinalization(boundary);
        const paused = harness.stored();
        const oldRunnerToken = harness.context.localRunnerToken;
        try {
          // This control is a separate message, not awaited by the held save or
          // lease hook. Rejection must be prompt and must not create latent work.
          const response = await harness.control("AIPM_RESUME");
          assert.equal(response.ok, false, "Do not report Resume success before the old Pause has finalized");
          assert.equal(typeof response.error, "string");
          assert.ok(response.error.length > 0, "Explain that Pause is still completing and explicit Resume can be retried");
          assert.equal(harness.context.localRunnerToken, oldRunnerToken);
          assert.deepEqual(harness.stored(), paused, "Pending Resume must not mutate durable Run authority");
          assert.equal(harness.page.clicks, 0);
          assert.equal(writes(harness), 1);
          if (edited) {
            harness.page.text = "SYNTHETIC USER EDIT WHILE PAUSED";
            harness.page.userMutationEpoch += 1;
          }
        } finally {
          release();
          await harness.settle();
        }

        assert.equal(harness.stored().status, "paused", "Finalization must not automatically resume a rejected request");
        assert.equal(harness.stored().pauseReason, "user-pause");
        assert.equal(harness.page.clicks, 0);
        assert.equal(writes(harness), 1);
        assert.equal(harness.context.activeRunnerRunId, null);
        assert.equal(harness.context.localPauseFinalization, null);

        assert.equal((await harness.control("AIPM_RESUME")).ok, true);
        await harness.settle();
        assert.equal(writes(harness), 1, "Never rewrite the retained text or the user's edit");
        if (edited) {
          assert.equal(harness.page.clicks, 0);
          assert.equal(harness.stored().status, "paused");
          assert.equal(harness.stored().pauseReason, "draft_present");
          assert.equal(harness.page.text, "SYNTHETIC USER EDIT WHILE PAUSED");
        } else {
          assert.equal(harness.stored().status, "completed");
          assert.equal(harness.stored().cursor.sendsCompleted, 1);
          assert.equal(harness.page.clicks, 1);
        }
      });
  }

  test(`Stop during ${boundary} stays terminal and revokes pending ownership`,
    { timeout: 10_000 }, async () => {
      const { harness, release } = await pendingPauseFinalization(boundary);
      try {
        assert.equal((await harness.control("AIPM_STOP")).ok, true);
        assert.equal(harness.stored().status, "stopped");
        assert.equal((await harness.control("AIPM_RESUME")).ok, false);
      } finally {
        release();
        await harness.settle();
      }
      assert.equal(harness.stored().status, "stopped");
      assert.equal(harness.page.clicks, 0);
      assert.equal(writes(harness), 1);
      assert.equal(harness.page.text, TEXT);
      assert.equal(harness.context.localPauseFinalization, null);
      assert.equal(harness.context.pausedPromptReceipt, null, "An old Pause response must not restore ownership revoked by Stop");
    });

  test(`Runner reinjection during ${boundary} preserves the pending guard and revokes ownership`,
    { timeout: 10_000 }, async () => {
      const { harness, release } = await pendingPauseFinalization(boundary);
      const finalizer = harness.context.localPauseFinalization;
      // Keep the harness's pending-promise tracking while executing the real
      // production reinjection initializers and replacing their global helpers.
      const trackedExecute = harness.context.executeRun;
      try {
        vm.runInContext(runnerSource, harness.context, { filename: "content-runner-reinjected.js" });
        harness.context.executeRun = trackedExecute;
        assert.equal(harness.context.localPauseFinalization, finalizer);
        assert.equal((await harness.control("AIPM_RESUME")).ok, false);
      } finally {
        release();
        await harness.settle();
      }
      assert.equal(harness.context.localPauseFinalization, null);
      assert.equal(harness.context.pausedPromptReceipt, null);
      assert.equal(harness.stored().status, "paused");
      assert.equal((await harness.control("AIPM_RESUME")).ok, true);
      await harness.settle();
      assert.equal(harness.stored().pauseReason, "draft_present");
      assert.equal(harness.page.clicks, 0);
      assert.equal(writes(harness), 1);
      assert.equal(harness.page.text, TEXT);
    });
}
