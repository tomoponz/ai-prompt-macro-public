import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { createWorkflowHarness } from "./helpers/workflow-harness.mjs";

const coreSource = fs.readFileSync(new URL("../src/content-core.js", import.meta.url), "utf8");

function coreContext(response = {}) {
  const context = vm.createContext({
    crypto: webcrypto,
    location: { origin: "https://chatgpt.com", pathname: "/c/synthetic-conversation", search: "", hash: "" },
    document: {},
    chrome: { runtime: { async sendMessage() { return response; } } }
  });
  vm.runInContext(coreSource, context, { filename: "content-core.js" });
  return context;
}

const failure = (identityObservation) => ({
  ok: false,
  errorCode: "DOCUMENT_IDENTITY_UNCONFIRMED",
  error: "Synthetic identity refusal",
  ...(identityObservation === undefined ? {} : { identityObservation })
});

const immediateObservation = Object.freeze({
  outcome: "unavailable", reason: "document-lifecycle-changed",
  boundary: "lease-renew", episodeId: "synthetic-immediate-invalidation",
  attempt: 1, totalAttempts: 1, durationMs: 0,
  consecutiveUnavailable: 1, recoveryElapsedMs: 0,
  failureCode: "IDENTITY_LIFECYCLE_INVALIDATED", source: "document-lifetime-grant"
});

test("identity diagnostics distinguish absent observation from an observed immediate refusal", async () => {
  const context = coreContext(failure());
  let caught;
  try {
    await context.renewLease({ conversationKey: "chatgpt:c:synthetic-conversation", nonce: "n", executionSessionId: "s" }, "r");
  } catch (error) { caught = error; }
  assert.equal(caught?.code, "document_identity_unconfirmed");
  assert.equal(caught.identityObservation.observationMissing, true);
  assert.equal(caught.identityObservation.boundary, "lease-renew", "locally known boundary must not become run-read");
  const normalizedAgain = context.normalizeDocumentIdentityObservation(caught.identityObservation);
  assert.equal(normalizedAgain.observationMissing, true, "error-to-diagnostic normalization must retain absence");
  assert.equal(normalizedAgain.boundary, "lease-renew");

  const actual = context.normalizeDocumentIdentityObservation(immediateObservation);
  assert.notEqual(actual.observationMissing, true);
  assert.equal(actual.attempt, 1);
  assert.equal(actual.durationMs, 0);
  assert.equal(actual.reason, "document-lifecycle-changed");
  assert.equal(actual.source, "document-lifetime-grant");
});

test("missing acquisition metadata retains the lease-acquire boundary", async () => {
  const context = coreContext(failure());
  await assert.rejects(context.acquireLease("chatgpt:c:synthetic-conversation", "r", "s"), (error) => {
    assert.equal(error.identityObservation.observationMissing, true);
    assert.equal(error.identityObservation.boundary, "lease-acquire");
    return true;
  });
});

test("provided identity metadata survives lease refusal without being replaced by generic defaults", async () => {
  const context = coreContext(failure(immediateObservation));
  await assert.rejects(context.renewLease({ conversationKey: "chatgpt:c:synthetic-conversation", nonce: "n" }, "r"), (error) => {
    const observation = error.identityObservation;
    assert.equal(observation.reason, immediateObservation.reason);
    assert.equal(observation.episodeId, immediateObservation.episodeId);
    assert.equal(observation.failureCode, immediateObservation.failureCode);
    assert.equal(observation.boundary, "lease-renew");
    assert.notEqual(observation.observationMissing, true);
    return true;
  });
});

test("same conversation identity survives query/hash and replacement of composer DOM", () => {
  const context = coreContext();
  const instance = context.instanceId;
  const key = context.ChatGptAdapter.getConversationKey();
  context.location.search = "?model=synthetic&share=false";
  context.location.hash = "#synthetic-message";
  context.document = { replacementComposer: { synthetic: true } };
  assert.equal(context.ChatGptAdapter.getConversationKey(), key);
  assert.equal(context.instanceId, instance);
  vm.runInContext(coreSource, context, { filename: "content-core-reinjected.js" });
  assert.equal(context.instanceId, instance, "reinjection in the same global document retains its instance ID");
});

test("different conversation and unknown route cannot be accepted as the prior conversation", () => {
  const context = coreContext();
  const key = context.ChatGptAdapter.getConversationKey();
  context.location.pathname = "/c/other-synthetic-conversation";
  assert.notEqual(context.ChatGptAdapter.getConversationKey(), key);
  assert.equal(context.isConversationTransitionAllowed({ conversationKey: key }, context.ChatGptAdapter.getConversationKey()), false);
  context.location.pathname = "/gpts";
  assert.throws(() => context.ChatGptAdapter.getConversationKey(), { code: "conversation_identity_unknown" });
});

const longRepeat = {
  schemaVersion: 1, id: "synthetic-long-20", maxSends: 20,
  steps: [{ id: "long-prompt", type: "prompt", delivery: "send", prompt: "test".repeat(20160), repeat: 20, delayAfterMs: 0 }]
};

for (const [label, metadata] of [["missing metadata", undefined], ["observed immediate invalidation", immediateObservation]]) {
  test(`9th confirmed send remains confirmed and is never resent after identity refusal: ${label}`, async () => {
    let refused = false;
    const harness = createWorkflowHarness({
      convertPasteToAttachment: true,
      generationMs: 6000,
      onLease({ operation, storedRun, page }) {
        if (operation === "renew" && page.clicks === 9 && storedRun?.outbox?.state === "confirmed") {
          refused = true;
          return failure(metadata);
        }
        return null;
      }
    });
    await harness.ready();
    assert.equal((await harness.start(longRepeat)).ok, true);
    await harness.settle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(refused, true, "fixture must reach a renewal after the 9th confirmed delivery");
    const run = harness.stored();
    assert.equal(harness.page.clicks, 9);
    assert.equal(run.status, "paused");
    assert.equal(run.resumable, false);
    assert.equal(run.outbox?.state, "confirmed");
    assert.equal(run.cursor.sendsCompleted, 8, "9th confirmation remains in the outbox until its progress commit");
    assert.equal(run.lastErrorCode, "document_identity_unconfirmed");
    const event = harness.diagnostics().findLast((item) => item.type === "document_identity_unconfirmed");
    assert.ok(event);
    assert.equal(event.boundary, "lease-renew");
    assert.equal(event.identityObservationMissing === true, metadata === undefined);
    if (metadata) {
      assert.equal(event.reason, metadata.reason);
      assert.equal(event.episodeId, metadata.episodeId);
      assert.equal(event.failureCode, metadata.failureCode);
      assert.equal(event.identitySource, metadata.source);
    }
    assert.equal(JSON.stringify(event).includes(longRepeat.steps[0].prompt), false, "no prompt enters diagnostic metadata");
    assert.equal((await harness.control("AIPM_RESUME")).ok, false);
    await harness.settle();
    await harness.reload();
    assert.equal(harness.page.clicks, 9, "explicit Resume refusal and reload cannot repeat the confirmed send");
  });
}

test("synthetic long-attachment workflow completes 20 sends when identity remains confirmed", async () => {
  // This exercises the real runner/controller but a fake adapter. It is not a
  // production attachment detector or live ChatGPT acceptance test.
  const harness = createWorkflowHarness({ convertPasteToAttachment: true, generationMs: 6000 });
  await harness.ready();
  assert.equal((await harness.start(longRepeat)).ok, true);
  await harness.settle();
  assert.equal(harness.page.clicks, 20);
  assert.equal(harness.stored().cursor.sendsCompleted, 20);
  assert.equal(harness.stored().status, "completed");
  assert.equal(harness.stored().outbox, null);
});

test("missing Run save/read observations keep their locally known authority boundary", async () => {
  const harness = createWorkflowHarness({
    onRunGet() { return failure(); },
    onRunSet() { return failure(); }
  });
  await harness.ready();
  await assert.rejects(harness.context.getActiveRun({ readOnlyObservation: true, authorityBoundary: "readiness" }), (error) => {
    assert.equal(error.identityObservation.observationMissing, true);
    assert.equal(error.identityObservation.boundary, "readiness");
    return true;
  });
  await assert.rejects(harness.context.saveActiveRun({}, "runner", "send-preflight"), (error) => {
    assert.equal(error.identityObservation.observationMissing, true);
    assert.equal(error.identityObservation.boundary, "send-preflight");
    return true;
  });
});
