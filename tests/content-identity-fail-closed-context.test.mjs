import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { createWorkflowHarness } from "./helpers/workflow-harness.mjs";

const sources = Object.fromEntries(["core", "runner", "controller"].map((part) => [
  part, fs.readFileSync(new URL(`../src/content-${part}.js`, import.meta.url), "utf8")
]));
const clone = (value) => value == null ? value : structuredClone(value);
const guard = Object.freeze({
  token: "synthetic-stop-only-claim", runId: "confirmed-run", stateRevision: 19,
  executionSessionId: "synthetic-session", conversationKey: "chatgpt:c:synthetic",
  boundDocumentId: "synthetic-document", documentInstanceId: "synthetic-instance"
});
const refusal = (extra = {}) => ({
  ok: false, errorCode: "DOCUMENT_IDENTITY_UNCONFIRMED", runId: guard.runId,
  failClosedGuard: clone(guard), identityObservation: {
    outcome: "unavailable", reason: "top-frame-missing", boundary: "recovery",
    episodeId: "synthetic-refusal", attempt: 1, totalAttempts: 1, durationMs: 0
  }, ...extra
});

function createContext(response = refusal()) {
  const messages = [];
  const context = vm.createContext({
    __AIPM_CONTENT_CONTROLLER_READY__: true,
    __AIPM_DOCUMENT_INSTANCE_ID__: "synthetic-instance",
    crypto: webcrypto, TextEncoder, setTimeout, clearTimeout, console,
    location: { origin: "https://chatgpt.com", pathname: "/c/synthetic" },
    document: {},
    chrome: { runtime: { async sendMessage(message) {
      messages.push(clone(message));
      return message.type === "AIPM_RUN_FAIL_CLOSED"
        ? { ok: true, run: null, changed: false, staleFailClosedGuard: true }
        : clone(response);
    } } }
  });
  for (const part of ["core", "runner", "controller"]) {
    vm.runInContext(sources[part], context, { filename: `content-${part}.js` });
  }
  return { context, messages };
}

for (const helper of ["throwRunDocumentIdentityFailure", "throwDocumentIdentityFailure"]) {
  test(`${helper} retains the exact refusal guard without inventing a new snapshot`, () => {
    const { context } = createContext();
    let caught;
    try { context[helper](refusal(), "lease-renew"); } catch (error) { caught = error; }
    assert.equal(caught?.code, "document_identity_unconfirmed");
    assert.deepEqual(clone(caught.identityFailClosedGuard), guard);
    assert.equal(caught.identityObservation.boundary, "recovery");
  });

  for (const flag of ["lifecycleCommitted", "mismatchCommitted", "lifecycleContextStale", "mismatchContextStale", "failClosedAuthorityUnavailable"]) {
    test(`${helper} suppresses a second stop after ${flag}`, () => {
      const { context } = createContext();
      let caught;
      try { context[helper](refusal({ [flag]: true })); } catch (error) { caught = error; }
      assert.equal(caught.identityFailClosedHandled, true);
    });
  }
}

test("the fail-closed request carries its original guard and the calling content instance", async () => {
  const { context, messages } = createContext();
  const stopped = await context.failClosedRunWithoutIdentity(guard.runId, "document_identity_unconfirmed", {
    identityFailClosedGuard: clone(guard)
  });
  assert.equal(stopped, null);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].failClosedGuard, guard);
  assert.equal(messages[0].documentInstanceId, context.instanceId);
  assert.equal(messages[0].expectedRunId, guard.runId);
});

for (const [name, contextFields] of [
  ["missing", {}], ["null", { identityFailClosedGuard: null }],
  ["malformed", { identityFailClosedGuard: { stateRevision: 19 } }],
  ["already handled", { identityFailClosedGuard: clone(guard), identityFailClosedHandled: true }]
]) {
  test(`${name} refusal authority cannot fall back to a Run-ID-only identity stop`, async () => {
    const { context, messages } = createContext();
    assert.equal(await context.failClosedRunWithoutIdentity(guard.runId, "document_identity_unconfirmed", contextFields), null);
    assert.deepEqual(messages, []);
  });
}

test("a stale recovery stop does not record a false durable pause diagnostic", async () => {
  const { context, messages } = createContext();
  const recorded = [];
  context.recordDocumentIdentityFailureDiagnostic = (...args) => recorded.push(args);
  await context.recoverIfNeeded();
  assert.deepEqual(messages.map((message) => message.type), ["AIPM_RUN_GET", "AIPM_RUN_FAIL_CLOSED"]);
  assert.deepEqual(messages[1].failClosedGuard, guard);
  assert.deepEqual(recorded, []);
});

test("a mismatch GET response preserves its guard through recovery's synthetic error", async () => {
  const { context, messages } = createContext(refusal({
    ok: true, run: null, errorCode: undefined,
    identityObservation: { outcome: "mismatch", boundary: "recovery", reason: "document-id-mismatch" }
  }));
  await context.recoverIfNeeded();
  const stop = messages.find((message) => message.type === "AIPM_RUN_FAIL_CLOSED");
  assert.deepEqual(stop?.failClosedGuard, guard);
  assert.equal(stop.reason, "document_identity_mismatch");
});

for (const code of ["DOCUMENT_IDENTITY_UNCONFIRMED", "DOCUMENT_IDENTITY_MISMATCH"]) {
  test(`the runner preserves a lease refusal guard after a confirmed send: ${code}`, async () => {
    let refused = false;
    const harness = createWorkflowHarness({
      generationMs: 6000,
      onLease({ operation, storedRun, page }) {
        if (operation !== "renew" || page.clicks !== 1 || storedRun?.outbox?.state !== "confirmed") return null;
        refused = true;
        return refusal({ errorCode: code, runId: storedRun.runId,
          failClosedGuard: { ...guard, runId: storedRun.runId, stateRevision: storedRun.stateRevision } });
      }
    });
    await harness.ready();
    const messages = [];
    const send = harness.context.chrome.runtime.sendMessage;
    harness.context.chrome.runtime.sendMessage = async (message) => {
      messages.push(clone(message));
      return send(message);
    };
    assert.equal((await harness.start({ schemaVersion: 1, id: "guarded", maxSends: 2,
      steps: [{ id: "p", type: "prompt", prompt: "synthetic", delivery: "send", repeat: 2, delayAfterMs: 0 }] })).ok, true);
    await harness.settle();
    assert.equal(refused, true);
    const stops = messages.filter((message) => message.type === "AIPM_RUN_FAIL_CLOSED");
    assert.equal(stops.length, 1);
    assert.equal(stops[0].failClosedGuard?.token, guard.token);
    assert.equal(stops[0].failClosedGuard.runId, harness.stored().runId);
    assert.equal(harness.page.clicks, 1);
    assert.equal(harness.stored().outbox.state, "confirmed");
    assert.equal(harness.stored().cursor.sendsCompleted, 0);
    assert.equal(JSON.stringify(harness.stored()).includes(guard.token), false);
    assert.equal(JSON.stringify(harness.diagnostics()).includes(guard.token), false);
  });
}

test("Run-object capabilities cannot be replaced by another object's newer revision", async () => {
  const { context, messages } = createContext();
  const oldRun = { ...guard };
  delete oldRun.token;
  const newRun = { ...oldRun, stateRevision: 20 };
  context.rememberRunFailClosedGuard(oldRun, { failClosedGuard: clone(guard) });
  context.rememberRunFailClosedGuard(newRun, { failClosedGuard: { ...guard, token: "newer-claim", stateRevision: 20 } });
  context.inheritRunFailClosedGuard(oldRun, newRun);
  await context.failClosedRunWithoutIdentity(oldRun);
  assert.deepEqual(messages[0].failClosedGuard, guard);
  assert.equal(JSON.stringify(oldRun).includes("claim"), false);
  assert.equal(await context.failClosedRunWithoutIdentity(oldRun.runId), null, "Run ID alone never borrows the newer capability");
  assert.equal(messages.length, 1);
});

test("an identity refusal with no capability cannot borrow a previously successful observation", async () => {
  const { context, messages } = createContext();
  const run = { ...guard };
  delete run.token;
  context.rememberRunFailClosedGuard(run, { failClosedGuard: clone(guard) });
  assert.equal(await context.failClosedRunWithoutIdentity(run, "document_identity_unconfirmed", {}), null);
  assert.deepEqual(messages, []);
});

test("lease renewal captures its own Run guard before awaits and cannot overwrite a newer local revision", async () => {
  const { context } = createContext();
  const run = { ...guard };
  delete run.token;
  context.rememberRunFailClosedGuard(run, { failClosedGuard: clone(guard) });
  const messages = [];
  let finishRenewal;
  context.chrome.runtime.sendMessage = async (message) => {
    messages.push(clone(message));
    if (message.type === "AIPM_LEASE_ACQUIRE") return {
      ok: true, lease: { conversationKey: run.conversationKey, nonce: "n", executionSessionId: run.executionSessionId },
      failClosedGuard: clone(guard)
    };
    return new Promise((resolve) => { finishRenewal = resolve; });
  };
  const lease = await context.acquireLease(run.conversationKey, run.runId, run.executionSessionId, null, run);
  const renewal = context.renewLease(lease, run.runId);
  run.stateRevision = 20;
  context.rememberRunFailClosedGuard(run, { failClosedGuard: { ...guard, stateRevision: 20, token: "new-local-snapshot" } });
  finishRenewal({ ok: true, renewed: true, failClosedGuard: { ...guard, token: "old-renewal-snapshot" } });
  assert.equal(await renewal, true);
  assert.deepEqual(messages[1].failClosedGuard, guard);
  assert.equal(context.runFailClosedGuards.get(run).guard.token, "new-local-snapshot");
  assert.equal(JSON.stringify(lease).includes("claim"), false);
});
