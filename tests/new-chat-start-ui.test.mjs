import { CURRENT_EXTENSION_VERSION } from "./helpers/extension-version.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { installSidePanelHarness, deferred, tick } from "./helpers/sidepanel-harness.mjs";

const UI_KEY = "aipm.uiByTab.v2";
const entry = {
  mode: "workflow", keepAwake: false,
  workflow: { schemaVersion: 1, id: "start-boundary", name: "Start boundary", maxSends: 3,
    steps: [{ id: "first", type: "prompt", delivery: "send", prompt: "SYNTHETIC", repeat: 3, delayAfterMs: 0 }] },
  editorRevision: 1, updatedAt: 1
};
const status = (conversationKey = "chatgpt:c:first", instanceId = "instance-1", run = null) => ({
  ok: true, provider: "chatgpt", contentVersion: CURRENT_EXTENSION_VERSION, pageReady: true,
  generationState: "idle", blocker: null, conversationKey, instanceId, run, diagnostics: []
});
const starts = (h) => h.messages.filter((m) => m.payload?.type === "AIPM_START");
async function setup() {
  const h = await installSidePanelHarness({ tabIds: [1],
    storageSeed: { "aipm.selectedTab.v1": 1, [UI_KEY]: { 1: structuredClone(entry) } } });
  await tick();
  return h;
}
async function refresh(h, next) {
  h.setRelayResponder(() => structuredClone(next));
  await h.click("refreshTabs");
}

async function setupWithIntervals() {
  const original = Object.getOwnPropertyDescriptor(globalThis, "setInterval");
  const intervals = [];
  let installed = globalThis.setInterval;
  const restoreInterval = () => {
    if (original) Object.defineProperty(globalThis, "setInterval", original);
    else delete globalThis.setInterval;
  };
  // Observe the existing harness's inert timer installation, so the test can
  // invoke the production polling callback without arming a real timer.
  Object.defineProperty(globalThis, "setInterval", {
    configurable: true,
    get: () => installed,
    set: (stub) => {
      installed = (callback, delay, ...args) => {
        intervals.push({ callback, delay });
        return stub(callback, delay, ...args);
      };
    }
  });
  try {
    const h = await setup();
    return { h, intervals, restoreGlobals() {
      try { h.restoreGlobals(); } finally { restoreInterval(); }
    } };
  } catch (error) {
    restoreInterval();
    throw error;
  }
}

for (const [label, key] of [["root", "chatgpt:new:root"], ["Project", "chatgpt:new:project:synthetic"]]) {
  test(`${label} New Chat disables both Start buttons and explains manual setup without consuming workflow`, async () => {
    const h = await setup();
    try {
      await refresh(h, status(key));
      const before = structuredClone(h.storage.get(UI_KEY));
      assert.equal(h.el("start").disabled, true);
      assert.equal(h.el("flowStart").disabled, true);
      assert.match(h.el("flowStartReason").textContent, /最初の指示.*手動/);
      assert.match(h.el("nextAction").textContent, /重複|二重/);
      assert.equal(h.el("runDetails").hidden, false, "manual setup and duplicate guidance must be visible");
      assert.equal(!h.el("completionOutcome").hidden && /開始できます/.test(h.el("completionOutcome").textContent), false,
        "visible outcome must not advertise Start while manual setup is required");
      // The handler must reject even a stale/programmatic click on either button.
      await h.click("start");
      await h.click("flowStart");
      assert.equal(starts(h).length, 0);
      assert.deepEqual(h.storage.get(UI_KEY), before);
    } finally { h.restoreGlobals(); }
  });
}

test("fresh route/document observations refresh Start and preserve all requested repetitions", async () => {
  const h = await setup();
  try {
    await refresh(h, status("chatgpt:new:root"));
    assert.equal(h.el("start").disabled, true);
    await refresh(h, status("chatgpt:c:created", "instance-2"));
    assert.equal(h.el("start").disabled, false);
    assert.equal(h.el("flowStart").disabled, false);
    await h.click("start");
    assert.equal(starts(h).length, 1);
    assert.equal(starts(h)[0].payload.expectedConversationKey, "chatgpt:c:created");
    assert.equal(starts(h)[0].payload.expectedDocumentInstanceId, "instance-2");
    assert.equal(starts(h)[0].payload.workflow.steps[0].repeat, 3);
    await refresh(h, status("chatgpt:new:root", "instance-3"));
    assert.equal(h.el("start").disabled, true);
    assert.equal(h.el("flowStart").disabled, true);
  } finally { h.restoreGlobals(); }
});

for (const [label, key] of [["root", "chatgpt:new:root"], ["Project", "chatgpt:new:project:synthetic"]]) {
  test(`${label} New Chat becomes startable in the same document through periodic status refresh`, async () => {
    const fixture = await setupWithIntervals();
    const { h, intervals } = fixture;
    try {
      const polling = intervals.filter(({ delay }) => delay === 1200);
      assert.equal(polling.length, 1, "the panel must register its status poll");
      const poll = polling[0].callback;
      const instanceId = "same-document-instance";
      h.setRelayResponder(() => status(key, instanceId));
      await poll();
      assert.equal(h.el("start").disabled, true);
      assert.equal(h.el("flowStart").disabled, true);
      assert.match(h.el("message").textContent, /最初の指示.*手動/);
      assert.match(h.el("nextAction").textContent, /自動で開始可否を更新/);
      const before = structuredClone(h.storage.get(UI_KEY));
      const previousMessage = h.el("message").textContent;
      const previousAction = h.el("nextAction").textContent;
      const messageCount = h.messages.length;

      // A manual ChatGPT send changes only the conversation key. There is no
      // panel click, document replacement, or tab-discovery refresh here.
      h.setRelayResponder(() => status("chatgpt:c:created", instanceId));
      await poll();
      const requests = h.messages.slice(messageCount);
      assert.equal(requests.filter((m) => m.payload?.type === "AIPM_GET_STATUS").length, 1);
      assert.equal(requests.some((m) => m.type === "AIPM_LIST_CHATGPT_TABS"), false);
      assert.equal(h.el("start").disabled, false);
      assert.equal(h.el("flowStart").disabled, false);
      assert.equal(h.el("flowStartReason").hidden, true);
      assert.equal(h.el("flowStartReason").textContent, "");
      assert.notEqual(h.el("message").textContent, previousMessage);
      assert.notEqual(h.el("nextAction").textContent, previousAction);
      assert.doesNotMatch(h.el("message").textContent, /最初の指示.*手動/);
      assert.doesNotMatch(h.el("nextAction").textContent, /自動で差し引きません/);
      assert.equal(starts(h).length, 0, "becoming ready must not automatically start the macro");
      assert.deepEqual(h.storage.get(UI_KEY), before, "manual setup must not consume any macro repeats");
    } finally { fixture.restoreGlobals(); }
  });
}

for (const [label, next] of [
  ["other conversation", status("chatgpt:c:other")],
  ["replacement document", status("chatgpt:c:first", "instance-2")],
  ["new chat", status("chatgpt:new:root")]
]) {
  test(`Start preparation cancels on a freshly observed ${label}`, async () => {
    const h = await setup();
    const gate = deferred();
    const entered = deferred();
    try {
      await refresh(h, status());
      let held = false;
      h.setStorageReadHook(async (key) => {
        if (!held && Array.isArray(key) && key.includes(UI_KEY)) {
          held = true; entered.resolve(); await gate.promise;
        }
      });
      const click = h.click("start");
      await entered.promise;
      await refresh(h, next);
      gate.resolve();
      await click;
      assert.equal(starts(h).length, 0);
      assert.equal(h.storage.get(UI_KEY)[1].workflow.steps[0].repeat, 3);
    } finally { gate.resolve(); h.restoreGlobals(); }
  });
}

test("legacy paused New Chat keeps Resume available while Start remains closed", async () => {
  const h = await setup();
  try {
    await refresh(h, status("chatgpt:c:confirmed", "instance-1", {
      ...entry, runId: "legacy", stateRevision: 4, status: "paused", phase: "new-chat-confirmation-required",
      conversationKey: "chatgpt:new:root", pauseReason: "new-chat-confirmation-required",
      lastErrorCode: "new-chat-confirmation-required", resumable: false,
      outbox: { state: "submitted" }, plannedSends: 3,
      cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 }
    }));
    assert.equal(h.el("start").disabled, true);
    assert.equal(h.el("resume").disabled, false);
    assert.match(h.el("nextAction").textContent, /再開/);
  } finally { h.restoreGlobals(); }
});

test("a known pre-delivery Start target rejection does not remain an uncertain pending Start", async () => {
  const h = await setup();
  try {
    await refresh(h, status());
    h.setRelayResponder((message) => message.payload.type === "AIPM_START"
      ? { ok: false, relayError: "開始対象が変わりました。", relayErrorCode: "STALE_START_TARGET",
          startDeliveryState: "not-dispatched" }
      : status());
    await h.click("start");
    assert.equal(starts(h).length, 1);
    assert.equal(h.el("start").disabled, false, "fresh explicit Start remains available after a known non-delivery");
    assert.match(h.el("message").textContent, /開始対象が変わりました/);
  } finally { h.restoreGlobals(); }
});
