import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { createReadOnlyBackpressure } from "../src/read-only-backpressure.js";
import { recoveryRuntimeBounds } from "../src/recovery-policy.js";
import { preflightWorkflowStartSchedule } from "../src/workflow.js";
import { normalizeTargetTitle } from "../src/target-display.js";

const backgroundSource = fs.readFileSync(new URL("../src/background.js", import.meta.url), "utf8")
  .replace(/^import \{ createReadOnlyBackpressure \} from "\.\/read-only-backpressure\.js";\s*/, "")
  .replace(/^import \{ recoveryRuntimeBounds \} from "\.\/recovery-policy\.js";\s*/, "")
  .replace(/^import \{ preflightWorkflowStartSchedule \} from "\.\/workflow\.js";\s*/, "")
  .replace(/^import \{ normalizeTargetTitle \} from "\.\/target-display\.js";\s*/, "");

function createBackgroundHarness() {
  const listeners = { installed: [], startup: [], message: [], alarm: [], tabRemoved: [], tabUpdated: [] };
  const storageData = {};
  const sessionData = {};
  const alarmData = new Map();
  let powerReleaseCount = 0;

  const local = {
    async get(key) {
      if (key == null) return { ...storageData };
      if (typeof key === "string") return { [key]: storageData[key] };
      if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, storageData[item]]));
      return { ...storageData };
    },
    async set(values) { Object.assign(storageData, values); },
    async remove(key) {
      for (const item of Array.isArray(key) ? key : [key]) delete storageData[item];
    }
  };
  const session = {
    async get(key) {
      if (typeof key === "string") return { [key]: sessionData[key] };
      if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, sessionData[item]]));
      return { ...sessionData };
    },
    async set(values) { Object.assign(sessionData, values); },
    async remove(key) {
      for (const item of Array.isArray(key) ? key : [key]) delete sessionData[item];
    }
  };

  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    crypto: webcrypto,
    createReadOnlyBackpressure,
    recoveryRuntimeBounds,
    preflightWorkflowStartSchedule,
    normalizeTargetTitle,
    chrome: {
      runtime: {
        getManifest() { return { version: "0.4.0" }; },
        onInstalled: { addListener(fn) { listeners.installed.push(fn); } },
        onStartup: { addListener(fn) { listeners.startup.push(fn); } },
        onMessage: { addListener(fn) { listeners.message.push(fn); } }
      },
      sidePanel: { async setPanelBehavior() {} },
      storage: { local, session },
      alarms: {
        onAlarm: { addListener(fn) { listeners.alarm.push(fn); } },
        create(name, info) { alarmData.set(name, { name, ...info }); },
        async clear(name) { return alarmData.delete(name); },
        async get(name) { return alarmData.get(name) ?? null; }
      },
      tabs: {
        onRemoved: { addListener(fn) { listeners.tabRemoved.push(fn); } },
        onUpdated: { addListener(fn) { listeners.tabUpdated.push(fn); } },
        async query() { return []; },
        async sendMessage() { return { ok: true }; }
      },
      scripting: { async executeScript() { return []; } },
      permissions: { async contains() { return true; } },
      power: {
        requestKeepAwake() {},
        releaseKeepAwake() { powerReleaseCount += 1; }
      }
    }
  });

  vm.runInContext(backgroundSource, context);
  return { listeners, storageData, sessionData, alarmData, getPowerReleaseCount: () => powerReleaseCount };
}

test("extension update quarantines an in-flight run instead of reviving it in the new execution session", async () => {
  const harness = createBackgroundHarness();
  const oldSession = "session-before-update";
  harness.sessionData["aipm.executionSession.v1"] = oldSession;
  harness.storageData["aipm.activeRun.v2.tab.501"] = {
    runId: "run-before-update",
    conversationKey: "chatgpt:c:update-target",
    executionSessionId: oldSession,
    boundTabId: 501,
    status: "running",
    keepAwake: true,
    workflow: { id: "must-not-revive" },
    cursor: { stepIndex: 0, repeatIndex: 1, sendsCompleted: 1 }
  };
  harness.storageData["aipm.schedules.v1"] = {
    "aipm.wait.run-before-update.step": {
      runId: "run-before-update",
      stepId: "step",
      tabId: 501,
      whenMs: Date.now() + 60_000,
      executionSessionId: oldSession
    }
  };
  harness.storageData["aipm.alarmSignals.v1"] = {
    old: { runId: "run-before-update", executionSessionId: oldSession }
  };
  harness.storageData[`aipm.lease.v2.${encodeURIComponent("chatgpt:c:update-target")}`] = {
    runId: "run-before-update",
    tabId: 501,
    executionSessionId: oldSession,
    expiresAt: Date.now() + 60_000
  };
  harness.storageData["aipm.uiByTab.v2"] = { 501: { quick: { prompt: "stale" } } };
  harness.storageData["aipm.selectedTab.v1"] = 501;
  harness.alarmData.set("aipm.wait.run-before-update.step", {
    name: "aipm.wait.run-before-update.step",
    when: Date.now() + 60_000
  });

  assert.equal(harness.listeners.installed.length, 1);
  await harness.listeners.installed[0]({ reason: "update" });

  const nextSession = harness.sessionData["aipm.executionSession.v1"];
  assert.notEqual(nextSession, oldSession);
  assert.equal(harness.storageData["aipm.activeRun.v2.tab.501"], undefined);
  const quarantined = harness.storageData["aipm.quarantinedRuns.v1"];
  assert.equal(Array.isArray(quarantined), true);
  const run = quarantined.find((item) => item.runId === "run-before-update");
  assert.ok(run);
  assert.equal(run.status, "paused");
  assert.equal(run.resumable, false);
  assert.equal(run.pauseReason, "extension-reload");
  assert.equal(run.workflow.id, "must-not-revive");
  assert.equal(Object.keys(harness.storageData["aipm.schedules.v1"]).length, 0);
  assert.equal(Object.keys(harness.storageData["aipm.alarmSignals.v1"]).length, 0);
  assert.equal(harness.storageData[`aipm.lease.v2.${encodeURIComponent("chatgpt:c:update-target")}`], undefined);
  assert.equal(harness.storageData["aipm.uiByTab.v2"], undefined);
  assert.equal(harness.storageData["aipm.selectedTab.v1"], undefined);
  assert.equal(harness.alarmData.has("aipm.wait.run-before-update.step"), false);
  assert.ok(harness.getPowerReleaseCount() >= 1);
});
