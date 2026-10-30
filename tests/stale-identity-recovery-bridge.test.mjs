import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto, createHash } from "node:crypto";
import { installBackgroundHarness, makeRun, EXTENSION_VERSION } from "./helpers/background-harness.mjs";

// Actual background + content protocol; only browser APIs/storage are synthetic.
// No adapter Send action exists in this fixture.
const background = await installBackgroundHarness();
const sources = ["core", "runner", "controller"].map((part) => ({
  part, source: fs.readFileSync(new URL(`../src/content-${part}.js`, import.meta.url), "utf8")
}));
const clone = (value) => value == null ? value : structuredClone(value);
let nextTab = 3400;

async function createBridge({ replaceAfterRefusal = null, readSuccess = false, callerRebound = false } = {}) {
  const tabId = nextTab++;
  const run = makeRun({
    runId: `bridge-${tabId}`, boundTabId: tabId,
    conversationKey: "chatgpt:c:bridge", boundDocumentId: "document-before",
    documentInstanceId: "instance-before", stateRevision: 19, phase: "generating",
    workflow: { schemaVersion: 1, id: "repeat", maxSends: 20,
      steps: [{ id: "p", type: "prompt", prompt: "synthetic", delivery: "send", repeat: 20, delayAfterMs: 0 }] },
    plannedSends: 20, cursor: { stepIndex: 0, repeatIndex: 8, sendsCompleted: 8 },
    outbox: { id: "confirmed-ninth", state: "confirmed", stepId: "p", promptHash: createHash("sha256").update("synthetic").digest("hex"),
      position: { stepIndex: 0, repeatIndex: 8, sendsCompleted: 8 } }
  });
  background.putRun(tabId, clone(run));
  const callerDocumentId = callerRebound ? "document-after" : "document-before";
  const callerInstanceId = callerRebound ? "instance-after" : "instance-before";
  background.setDocument(tabId, { documentId: readSuccess ? callerDocumentId : "document-other",
    documentInstanceId: readSuccess ? callerInstanceId : "instance-other" });
  const sender = { tab: { id: tabId }, frameId: 0, documentId: callerDocumentId, documentLifecycle: "active" };
  const messages = [];
  const responses = [];
  let replacement = null;
  const context = vm.createContext({
    __AIPM_CONTENT_CONTROLLER_READY__: true, __AIPM_DOCUMENT_INSTANCE_ID__: callerInstanceId,
    crypto: webcrypto, TextEncoder, setTimeout, clearTimeout, console,
    location: { origin: "https://chatgpt.com", pathname: "/c/bridge" }, document: {},
    chrome: { storage: globalThis.chrome.storage, runtime: {
      async sendMessage(message) {
        messages.push(clone(message));
        const response = await background.invoke(message, sender);
        responses.push(clone(response));
        if (message.type === "AIPM_RUN_GET" && response.identityObservation?.outcome === "mismatch" && replaceAfterRefusal) {
          replacement = replaceAfterRefusal(clone(background.storedRun(tabId)));
          background.putRun(tabId, clone(replacement));
        }
        return clone(response);
      }
    } }
  });
  for (const { part, source } of sources) vm.runInContext(source, context, { filename: `content-${part}.js` });
  return { context, tabId, run, messages, responses, replacement: () => replacement };
}

for (const [name, replace] of [
  ["new document binding", (run) => ({ ...run, boundDocumentId: "document-rebound", documentInstanceId: "instance-rebound", stateRevision: 20 })],
  ["same-document revision", (run) => ({ ...run, stateRevision: 20, pauseRequested: true })],
  ["Stop", (run) => ({ ...run, stateRevision: 20, status: "stopped", phase: "stopped" })]
]) {
  test(`a delayed content recovery refusal cannot stop the same Run after ${name}`, async () => {
    const bridge = await createBridge({ replaceAfterRefusal: replace });
    await bridge.context.recoverIfNeeded();
    assert.deepEqual(background.storedRun(bridge.tabId), bridge.replacement());
    const stop = bridge.messages.find((item) => item.type === "AIPM_RUN_FAIL_CLOSED");
    assert.ok(stop?.failClosedGuard?.token, "the original issued guard must reach the actual background");
    assert.equal(stop.failClosedGuard.stateRevision, 19);
    assert.equal(bridge.responses.at(-1).run, null, "stale requests cannot read or claim a newer Run");
    assert.equal(bridge.responses.at(-1).changed, false);
    assert.deepEqual(bridge.messages.map((item) => item.type), ["AIPM_RUN_GET", "AIPM_RUN_FAIL_CLOSED"]);
  });
}

test("an unchanged exact snapshot still stops safely and retains the ninth confirmed delivery", async () => {
  const bridge = await createBridge();
  await bridge.context.recoverIfNeeded();
  const stopped = background.storedRun(bridge.tabId);
  assert.equal(stopped.status, "paused");
  assert.equal(stopped.resumable, false);
  assert.equal(stopped.pauseReason, "document_identity_mismatch");
  assert.equal(stopped.cursor.sendsCompleted, 8);
  assert.deepEqual(stopped.outbox, bridge.run.outbox);
  assert.equal(stopped.stateRevision, 20);
  assert.equal(JSON.stringify(stopped).includes("failClosedGuard"), false);
  assert.equal(JSON.stringify(stopped).includes(bridge.responses[0].failClosedGuard.token), false);
  assert.equal(bridge.messages.filter((message) => message.type === "AIPM_RUN_FAIL_CLOSED").length, 1);
});

for (const pathname of ["/gpts", "/c/other-conversation"]) {
  test(`a current runner can stop its exact observed Run after navigating to ${pathname}`, async () => {
    const bridge = await createBridge({ readSuccess: true });
    const run = await bridge.context.getActiveRun();
    bridge.context.location.pathname = pathname;
    await bridge.context.executeRun(run, bridge.context.localRunnerToken);
    const stopped = background.storedRun(bridge.tabId);
    assert.equal(stopped.status, "paused");
    assert.equal(stopped.pauseReason, "conversation-identity-unknown");
    assert.equal(stopped.cursor.sendsCompleted, 8);
    assert.deepEqual(stopped.outbox, bridge.run.outbox);
  });
}

test("a failed new-chat confirmation uses only the exact observed snapshot capability", async () => {
  const bridge = await createBridge({ readSuccess: true });
  const run = await bridge.context.getActiveRun();
  const send = bridge.context.chrome.runtime.sendMessage;
  bridge.context.chrome.runtime.sendMessage = async (message) => message.type === "AIPM_RUN_NEW_CHAT_CONFIRM_REQUIRED"
    ? { ok: false, error: "Synthetic durable confirmation refusal" } : send(message);
  await assert.rejects(bridge.context.requireNewChatConfirmation(run), { code: "run_state_save_failed" });
  assert.equal(background.storedRun(bridge.tabId).status, "paused");
  assert.equal(background.storedRun(bridge.tabId).outbox.state, "confirmed");
});

test("a read-only rebound view retains authority for the original durable snapshot only", async () => {
  const bridge = await createBridge({ readSuccess: true, callerRebound: true });
  const run = await bridge.context.getActiveRun({ readOnlyObservation: true, authorityBoundary: "run-read" });
  assert.equal(run.boundDocumentId, "document-after");
  assert.equal(background.storedRun(bridge.tabId).boundDocumentId, "document-before");
  assert.equal(bridge.responses[0].failClosedGuard.boundDocumentId, "document-before");
  const stopped = await bridge.context.failClosedRunWithoutIdentity(run);
  assert.equal(stopped?.status, "paused");
  assert.equal(stopped.outbox.state, "confirmed");
  assert.equal(stopped.cursor.sendsCompleted, 8);
});

test("a periodic-only rebound observer cannot gain stop authority over the durable owner", async () => {
  const bridge = await createBridge({ readSuccess: true, callerRebound: true });
  const run = await bridge.context.getActiveRun({ readOnlyObservation: true });
  assert.equal(run.boundDocumentId, "document-after");
  assert.equal(bridge.responses[0].failClosedGuard, undefined);
  assert.equal(await bridge.context.failClosedRunWithoutIdentity(run), null);
  assert.deepEqual(background.storedRun(bridge.tabId), bridge.run);
  assert.deepEqual(bridge.messages.map((item) => item.type), ["AIPM_RUN_GET"]);
});
