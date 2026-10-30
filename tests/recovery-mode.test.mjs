import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  normalizeRecoveryPolicy,
  recoveryRuntimeBounds
} from "../src/recovery-policy.js";
import {
  createWorkflowHarness,
  threePromptWorkflow
} from "./helpers/workflow-harness.mjs";
import { deferred, installBackgroundHarness } from "./helpers/background-harness.mjs";

test("SAFE is immutable baseline while completion settings are hard bounded", () => {
  assert.deepEqual(normalizeRecoveryPolicy(), {
    mode: "safe",
    identityAttempts: 3,
    readiness: "normal",
    statusRecovery: "normal"
  });
  assert.deepEqual(normalizeRecoveryPolicy({
    mode: "safe",
    identityAttempts: 10,
    readiness: "long",
    statusRecovery: "persistent"
  }), {
    mode: "safe",
    identityAttempts: 3,
    readiness: "normal",
    statusRecovery: "normal"
  });
  assert.deepEqual(normalizeRecoveryPolicy({
    mode: "completion",
    identityAttempts: 10,
    readiness: "long",
    statusRecovery: "persistent"
  }), {
    mode: "completion",
    identityAttempts: 10,
    readiness: "long",
    statusRecovery: "persistent"
  });
  assert.equal(normalizeRecoveryPolicy({ mode: "completion", identityAttempts: 999 }).identityAttempts, 5);
  assert.equal(normalizeRecoveryPolicy({ mode: "completion", readiness: "unbounded" }).readiness, "long");
  assert.equal(normalizeRecoveryPolicy({ mode: "completion", statusRecovery: "forever" }).statusRecovery, "persistent");
});

test("runtime recovery bounds are finite and completion changes observations only", () => {
  const safe = recoveryRuntimeBounds({ mode: "safe" });
  const completion = recoveryRuntimeBounds({ mode: "completion", identityAttempts: 10 });
  assert.deepEqual({
    readinessTimeoutMs: safe.readinessTimeoutMs,
    statusRetryTimeoutMs: safe.statusRetryTimeoutMs,
    statusRetryAttempts: safe.statusRetryAttempts,
    sidePanelStatusTimeoutMs: safe.sidePanelStatusTimeoutMs
  }, {
    readinessTimeoutMs: 30 * 60 * 1000,
    statusRetryTimeoutMs: 1500,
    statusRetryAttempts: 8,
    sidePanelStatusTimeoutMs: 4000
  });
  assert.deepEqual({
    identityAttempts: completion.identityAttempts,
    readinessTimeoutMs: completion.readinessTimeoutMs,
    statusRetryTimeoutMs: completion.statusRetryTimeoutMs,
    statusRetryAttempts: completion.statusRetryAttempts,
    sidePanelStatusTimeoutMs: completion.sidePanelStatusTimeoutMs
  }, {
    identityAttempts: 10,
    readinessTimeoutMs: 60 * 60 * 1000,
    statusRetryTimeoutMs: 3000,
    statusRetryAttempts: 12,
    sidePanelStatusTimeoutMs: 7000
  });
  for (const value of Object.values(completion)) {
    if (typeof value === "number") assert.equal(Number.isFinite(value), true);
  }
});

test("COMPLETION-ORIENTED does not retry an ambiguous Send", async () => {
  const harness = createWorkflowHarness({ ackConfirms: false });
  const workflow = threePromptWorkflow({
    recovery: {
      mode: "completion",
      identityAttempts: 10,
      readiness: "long",
      statusRecovery: "persistent"
    }
  });

  const started = await harness.start(workflow);
  assert.equal(started.ok, true);
  await harness.settle();

  const run = harness.stored();
  assert.equal(harness.page.clicks, 1);
  assert.equal(run.status, "paused");
  assert.equal(run.phase, "ambiguous");
  assert.equal(run.resumable, false);
  assert.equal(run.cursor.sendsCompleted, 0);

  const resumed = await harness.control("AIPM_RESUME");
  await harness.settle();
  assert.equal(resumed.ok, false);
  assert.equal(harness.page.clicks, 1, "completion recovery cannot replay an ambiguous mutation");
});

test("COMPLETION-ORIENTED keeps durable Stop terminal with zero later Sends", async () => {
  let stopPromise = null;
  const harness = createWorkflowHarness({
    generationMs: 20_000,
    onClick: ({ clicks, context }) => {
      if (clicks === 1) stopPromise = context.__stopForRecoveryMode();
    }
  });
  harness.context.__stopForRecoveryMode = () => harness.control("AIPM_STOP");
  const workflow = threePromptWorkflow({
    recovery: {
      mode: "completion",
      identityAttempts: 10,
      readiness: "long",
      statusRecovery: "persistent"
    }
  });

  assert.equal((await harness.start(workflow)).ok, true);
  await harness.settle();
  if (stopPromise) await stopPromise;
  await harness.settle();

  assert.equal(harness.stored().status, "stopped");
  assert.equal(harness.page.clicks, 1);
  harness.advance(2 * 60 * 60 * 1000);
  await harness.reload();
  assert.equal(harness.stored().status, "stopped");
  assert.equal(harness.page.clicks, 1, "Stop remains terminal despite the longer readiness policy");
});

for (const mode of ["safe", "completion"]) {
  test(`${mode} recovery dispatches Start once and never retries a timed-out command`, async (t) => {
    const previousChrome = globalThis.chrome;
    const background = await installBackgroundHarness();
    const tabId = mode === "safe" ? 81 : 82;
    const delivered = deferred();
    const reply = deferred();
    const timers = new Map();
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
      if (ms !== 1500) return realSetTimeout(callback, ms, ...args);
      const token = {};
      timers.set(token, () => callback(...args));
      return token;
    });
    t.mock.method(globalThis, "clearTimeout", (token) => {
      if (!timers.delete(token)) realClearTimeout(token);
    });
    background.setCommandResponder(tabId, () => {
      delivered.resolve();
      return reply.promise;
    });
    try {
      const pending = background.relay({
        type: "AIPM_START", expectedConversationKey: "chatgpt:c:torture",
        expectedDocumentInstanceId: `instance-${tabId}`,
        readOnlyRecovery: { mode, identityAttempts: 10, statusRecovery: "persistent" }
      }, tabId);
      await delivered.promise;
      assert.equal(background.commandsDelivered(tabId).length, 1);
      assert.equal(timers.size, 1, "only the actual command-delivery deadline is outstanding");
      [...timers.values()][0]();
      const response = await pending;
      assert.equal(response.ok, false);
      assert.equal(response.relayErrorCode, "COMMAND_DELIVERY_TIMEOUT");
      assert.equal(response.startDeliveryState, "attempted");
      assert.equal(background.commandsDelivered(tabId).length, 1, "timeout cannot retry a mutation");
      reply.resolve({ ok: true });
      await new Promise((resolve) => realSetTimeout(resolve, 0));
      assert.equal(background.commandsDelivered(tabId).length, 1, "a late reply cannot trigger another delivery");
    } finally {
      reply.resolve({ ok: true });
      globalThis.chrome = previousChrome;
    }
  });
}

test("production recovery retains its ambiguity fence and existing permission scope", () => {
  const background = fs.readFileSync(new URL("../src/background.js", import.meta.url), "utf8");
  const runner = fs.readFileSync(new URL("../src/content-runner.js", import.meta.url), "utf8");
  const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

  assert.doesNotMatch(background, /retryExistingReceiver\(tab\.id, deliveredPayload/);
  assert.match(runner, /throw makeError\("submission_ambiguous"\)/);
  assert.match(runner, /readinessTimeoutForRun\(run\)/);
  assert.deepEqual(manifest.permissions, ["storage", "sidePanel", "alarms", "scripting", "power"]);
  assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*"]);
});
