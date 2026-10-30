import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { CURRENT_EXTENSION_VERSION } from "./helpers/extension-version.mjs";

const sources = Object.fromEntries(["core", "runner", "controller"].map((part) => [
  part, fs.readFileSync(new URL(`../src/content-${part}.js`, import.meta.url), "utf8")
]));
const clone = (value) => value == null ? value : structuredClone(value);

function createBootstrap({ initialRun = null, rejectRecovery = () => false, includeRejectedRunId = true, includeRejectedGuard = false } = {}) {
  let storedRun = clone(initialRun);
  let diagnostics = [];
  const messages = [];
  const listeners = [];
  let stopClaim = null;
  const adapter = {
    id: "chatgpt", matches: () => true,
    getConversationKey: () => "chatgpt:c:entrypoint-fixture",
    readPageObservation: () => ({ composer: {}, generationState: "generating", blocker: null })
  };
  const context = vm.createContext({
    crypto: webcrypto, TextEncoder, setTimeout, clearTimeout, console,
    location: { origin: "https://chatgpt.com", pathname: "/c/entrypoint-fixture" },
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {}, remove() {} }),
      documentElement: { appendChild() {} }
    },
    chrome: {
      runtime: {
        onMessage: { addListener(fn) { listeners.push(fn); } },
        async sendMessage(message) {
          messages.push(clone(message));
          if (message.type === "AIPM_RUN_GET") {
            if (message.authorityBoundary === "recovery" && rejectRecovery()) {
              stopClaim = includeRejectedGuard ? {
                token: "synthetic-entrypoint-claim", ...Object.fromEntries(
                  ["runId", "stateRevision", "executionSessionId", "conversationKey", "boundDocumentId", "documentInstanceId"]
                    .map((key) => [key, storedRun?.[key]]))
              } : null;
              return {
                ok: false, errorCode: "DOCUMENT_IDENTITY_UNCONFIRMED",
                ...(includeRejectedRunId ? { runId: storedRun?.runId ?? null } : {}),
                ...(stopClaim ? { failClosedGuard: clone(stopClaim) } : {}),
                identityObservation: {
                  outcome: "unavailable", reason: "top-frame-missing", boundary: "recovery",
                  episodeId: "content-sender-invalid", source: "document-lifetime-grant",
                  attempt: 1, totalAttempts: 1, durationMs: 0,
                  consecutiveUnavailable: 1, recoveryElapsedMs: 0,
                  failureCode: "IDENTITY_TOP_FRAME_MISSING"
                }
              };
            }
            return { ok: true, run: clone(storedRun) };
          }
          if (message.type === "AIPM_RUN_FAIL_CLOSED") {
            if (!stopClaim || JSON.stringify(message.failClosedGuard) !== JSON.stringify(stopClaim) ||
                message.documentInstanceId !== context.instanceId ||
                Object.entries(stopClaim).some(([key, value]) => key !== "token" && storedRun?.[key] !== value)) {
              return { ok: true, run: null, changed: false };
            }
            stopClaim = null;
            if (!storedRun || message.expectedRunId !== storedRun.runId) return { ok: true, run: null };
            storedRun = { ...storedRun, status: "paused", phase: "ambiguous", resumable: false,
              pauseReason: message.reason, lastErrorCode: message.reason };
            return { ok: true, run: clone(storedRun) };
          }
          return { ok: false, error: "Unexpected synthetic mutation" };
        }
      },
      storage: { local: {
        async get(key) { return key === "aipm.diagnostics.v1" ? { [key]: clone(diagnostics) } : {}; },
        async set(values) { if (values["aipm.diagnostics.v1"]) diagnostics = clone(values["aipm.diagnostics.v1"]); }
      } }
    }
  });
  function inject() {
    vm.runInContext(sources.core, context, { filename: "content-core.js" });
    vm.runInContext(sources.runner, context, { filename: "content-runner.js" });
    context.ChatGptAdapter = adapter;
    vm.runInContext(sources.controller, context, { filename: "content-controller.js" });
  }
  inject();
  return {
    context, messages, listeners, inject,
    stored: () => clone(storedRun),
    diagnostics: () => clone(diagnostics),
    async ready() {
      await context.initialRecoveryPromise?.catch(() => {});
      await new Promise((resolve) => setImmediate(resolve));
    },
    seedConfirmedRun() {
      storedRun = {
        ...context.createRun({ schemaVersion: 1, id: "entrypoint", maxSends: 20,
          steps: [{ id: "p", type: "prompt", delivery: "send", prompt: "synthetic", repeat: 20, delayAfterMs: 0 }] },
        { bindingTabId: 1, executionSessionId: "synthetic-session" }),
        status: "running", phase: "generating",
        cursor: { stepIndex: 0, repeatIndex: 8, sendsCompleted: 8 },
        outbox: { id: "synthetic-ninth", state: "confirmed", stepId: "p", position: { stepIndex: 0, repeatIndex: 8, sendsCompleted: 8 } }
      };
      return clone(storedRun);
    },
    dispatch(message) {
      return new Promise((resolve) => listeners[0]({
        serviceWorkerVersion: CURRENT_EXTENSION_VERSION, executionSessionId: "synthetic-session",
        expectedDocumentInstanceId: context.instanceId,
        expectedConversationKey: "chatgpt:c:entrypoint-fixture",
        ...message
      }, {}, resolve));
    }
  };
}

const recoveryReads = (harness) => harness.messages.filter((item) =>
  item.type === "AIPM_RUN_GET" && item.authorityBoundary === "recovery");

test("periodic status cannot restart initial recovery while the ninth confirmed Run exists", async () => {
  const harness = createBootstrap();
  await harness.ready();
  harness.seedConfirmedRun();
  assert.equal(recoveryReads(harness).length, 1);
  for (let index = 0; index < 4; index += 1) {
    const status = await harness.dispatch({ type: "AIPM_GET_STATUS", readOnlyObservation: true });
    assert.equal(status.ok, true);
    assert.equal(status.run.outbox.state, "confirmed");
  }
  assert.equal(recoveryReads(harness).length, 1);
  assert.equal(harness.messages.some((item) => item.type === "AIPM_RUN_FAIL_CLOSED"), false);
});

test("same-global three-script reinjection preserves the completed recovery barrier", async () => {
  const harness = createBootstrap();
  await harness.ready();
  harness.seedConfirmedRun();
  const promise = harness.context.initialRecoveryPromise;
  const instanceId = harness.context.instanceId;
  harness.inject();
  await harness.ready();
  assert.equal(harness.context.initialRecoveryPromise, promise);
  assert.equal(harness.context.instanceId, instanceId);
  assert.equal(harness.listeners.length, 1);
  assert.equal(recoveryReads(harness).length, 1);
});

test("an authorized guarded recovery refusal stops the exact confirmed Run without resending", async () => {
  const oldDocument = createBootstrap();
  await oldDocument.ready();
  const existingRun = oldDocument.seedConfirmedRun();
  const freshDocument = createBootstrap({ initialRun: existingRun, rejectRecovery: () => true, includeRejectedGuard: true });
  await freshDocument.ready();
  assert.notEqual(freshDocument.context.instanceId, oldDocument.context.instanceId);
  assert.equal(recoveryReads(freshDocument).length, 1);
  const stopped = freshDocument.stored();
  assert.equal(stopped.status, "paused");
  assert.equal(stopped.phase, "ambiguous");
  assert.equal(stopped.outbox.state, "confirmed");
  assert.equal(stopped.cursor.sendsCompleted, 8);
  const event = freshDocument.diagnostics().find((item) => item.type === "document_identity_unconfirmed");
  assert.equal(event.reason, "top-frame-missing");
  assert.equal(event.boundary, "recovery");
  assert.equal(event.attempt, 1);
  assert.equal(event.durationMs, 0);
  assert.equal(event.episodeId, "content-sender-invalid");
  assert.equal(event.identitySource, "document-lifetime-grant");
  assert.notEqual(event.identityObservationMissing, true);
  assert.deepEqual(freshDocument.messages.map((item) => item.type), ["AIPM_RUN_GET", "AIPM_RUN_FAIL_CLOSED"]);
});

test("a legacy recovery refusal exposing only a Run ID cannot stop a confirmed Run", async () => {
  const owner = createBootstrap();
  await owner.ready();
  const existingRun = owner.seedConfirmedRun();
  const rejected = createBootstrap({ initialRun: existingRun, rejectRecovery: () => true });
  await rejected.ready();
  assert.deepEqual(rejected.stored(), existingRun);
  assert.deepEqual(rejected.messages.map((item) => item.type), ["AIPM_RUN_GET"]);
  assert.deepEqual(rejected.diagnostics(), []);
});

test("a rejected bootstrap with no authorized Run ID cannot request a stop of the confirmed top-frame Run", async () => {
  const owner = createBootstrap();
  await owner.ready();
  const existingRun = owner.seedConfirmedRun();
  const rejected = createBootstrap({
    initialRun: existingRun, rejectRecovery: () => true, includeRejectedRunId: false
  });
  await rejected.ready();
  assert.equal(recoveryReads(rejected).length, 1);
  assert.deepEqual(rejected.messages.map((item) => item.type), ["AIPM_RUN_GET"]);
  assert.deepEqual(rejected.stored(), existingRun);
  assert.equal(rejected.diagnostics().length, 0, "no diagnostic may falsely claim the unrelated Run was paused");
});

for (const type of ["AIPM_START", "AIPM_RESUME"]) {
  test(`${type} retries failed initial recovery, while status does not`, async () => {
    let reject = true;
    const harness = createBootstrap({ rejectRecovery: () => reject });
    await harness.ready();
    assert.equal(harness.context.recoveryStarted, false);
    assert.equal(harness.context.initialRecoveryPromise, null);
    assert.equal(recoveryReads(harness).length, 1);
    harness.seedConfirmedRun();
    const status = await harness.dispatch({ type: "AIPM_GET_STATUS", readOnlyObservation: true });
    assert.equal(status.ok, true);
    assert.equal(recoveryReads(harness).length, 1);
    reject = false;
    const response = await harness.dispatch({ type });
    assert.equal(response.ok, false, "an existing running Run cannot be started/resumed again");
    assert.equal(recoveryReads(harness).length, 2, "only the explicit command retries the bootstrap read");
    assert.equal(harness.messages.some((item) => item.type === "AIPM_RUN_FAIL_CLOSED"), false);
  });
}
