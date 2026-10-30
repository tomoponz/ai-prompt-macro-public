import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installBackgroundHarness, makeRun, EXTENSION_VERSION } from "./helpers/background-harness.mjs";

// Actual background with synthetic extension APIs. No browser or provider sends.
const background = await installBackgroundHarness();
const previousVersion = "0.4.3";
let nextTab = 8700;
const sender = (tabId) => ({ tab: { id: tabId }, frameId: 0,
  documentId: `document-${tabId}`, documentLifecycle: "active" });
const runFor = (tabId, overrides = {}) => makeRun({
  runId: `version-run-${tabId}`, boundTabId: tabId, boundDocumentId: `document-${tabId}`,
  documentInstanceId: `instance-${tabId}`, ...overrides
});
const startFor = (tabId) => ({
  type: "AIPM_START", expectedConversationKey: "chatgpt:c:torture",
  expectedDocumentInstanceId: `instance-${tabId}`,
  workflow: { schemaVersion: 1, maxSends: 1, steps: [{ id: "hold", type: "checkpoint" }] }
});

test("the new protocol build has one consistent runtime version distinct from the previous content", () => {
  const readJson = (name) => JSON.parse(fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));
  const manifest = readJson("manifest.json");
  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");
  assert.notEqual(manifest.version, previousVersion, "version_name alone cannot distinguish old content");
  assert.equal(pkg.version, manifest.version);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  assert.equal(manifest.version_name.split(" ")[0], manifest.version);
  const core = fs.readFileSync(new URL("../src/content-core.js", import.meta.url), "utf8");
  const versions = [...core.matchAll(/__AIPM_CONTENT_CORE__ = \{ version: "([^"]+)", ready: (?:false|true) \}/g)];
  assert.equal(versions.length, 2);
  assert.deepEqual(versions.map((match) => match[1]), [manifest.version, manifest.version]);
});

for (const command of ["AIPM_START", "AIPM_PAUSE", "AIPM_RESUME"]) {
  test(`previous 0.4.3 content cannot receive ${command} or mutate a Run through relay`, async () => {
    const tabId = nextTab++;
    const run = runFor(tabId, { status: command === "AIPM_RESUME" ? "paused" : "running" });
    if (command !== "AIPM_START") background.putRun(tabId, structuredClone(run));
    const before = structuredClone(background.storedRun(tabId));
    background.setStatusResponder(tabId, () => ({ ...background.defaultStatus(tabId), contentVersion: previousVersion }));
    const payload = command === "AIPM_START" ? startFor(tabId) : {
      type: command, expectedRunId: run.runId, expectedStateRevision: run.stateRevision
    };
    const response = await background.relay(payload, tabId);
    assert.equal(response.ok, false);
    assert.equal(response.relayErrorCode, "CONTENT_VERSION_MISMATCH");
    if (command === "AIPM_START") assert.equal(response.startDeliveryState, "not-dispatched");
    assert.equal(background.commandsDelivered(tabId).length, 0);
    assert.deepEqual(background.storedRun(tabId), before);
  });
}

test("a previous 0.4.3 Run write is rejected before any stored state changes", async () => {
  const tabId = nextTab++;
  const run = runFor(tabId);
  background.putRun(tabId, structuredClone(run));
  const response = await background.invoke({
    type: "AIPM_RUN_SET", runTransition: "runner", documentInstanceId: run.documentInstanceId,
    conversationKey: run.conversationKey,
    run: { ...run, contentVersion: previousVersion, phase: "prepared" }
  }, sender(tabId));
  assert.equal(response.ok, false);
  assert.match(response.error, /version/);
  assert.deepEqual(background.storedRun(tabId), run);
  assert.equal(background.commandsDelivered(tabId).length, 0);
});

test("fresh matching content receives one Start with the current worker version", async () => {
  const tabId = nextTab++;
  const response = await background.relay(startFor(tabId), tabId);
  assert.equal(response.ok, true);
  const delivered = background.commandsDelivered(tabId);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].payload.type, "AIPM_START");
  assert.equal(delivered[0].payload.serviceWorkerVersion, EXTENSION_VERSION);
  assert.equal(background.storedRun(tabId), null, "the fake command receipt is not a real content execution");
});

test("fresh matching content can still persist an authorized Run transition", async () => {
  const tabId = nextTab++;
  const run = runFor(tabId);
  background.putRun(tabId, structuredClone(run));
  const response = await background.invoke({
    type: "AIPM_RUN_SET", runTransition: "runner", documentInstanceId: run.documentInstanceId,
    conversationKey: run.conversationKey, run: { ...run, phase: "prepared" }
  }, sender(tabId));
  assert.equal(response.ok, true);
  assert.equal(background.storedRun(tabId).phase, "prepared");
  assert.equal(background.storedRun(tabId).stateRevision, run.stateRevision + 1);
});

test("explicit Stop retains its monotonic durable revoke even if old content cannot receive cleanup", async () => {
  const tabId = nextTab++;
  const run = runFor(tabId);
  background.putRun(tabId, structuredClone(run));
  background.setStatusResponder(tabId, () => ({ ...background.defaultStatus(tabId), contentVersion: previousVersion }));
  const response = await background.relay({ type: "AIPM_STOP", expectedRunId: run.runId }, tabId);
  assert.equal(response.ok, true);
  assert.equal(response.stopCommitted, true);
  assert.equal(response.cleanupDelivered, false);
  assert.equal(background.storedRun(tabId).status, "stopped");
  assert.equal(background.commandsDelivered(tabId).length, 0);
});
