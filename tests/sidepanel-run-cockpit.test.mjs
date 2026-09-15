import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  readStartSourceForTab,
  resolveStartSourceFromEditorEntry,
  START_SOURCE_ERROR_CODES
} from "../src/sidepanel-start-source.js";
import { installSidePanelHarness, deferred, tick } from "./helpers/sidepanel-harness.mjs";

const UI_KEY = "aipm.uiByTab.v2";
const SELECTED_KEY = "aipm.selectedTab.v1";

function prompt(id, text) {
  return { id, type: "prompt", delivery: "send", prompt: text, repeat: 1, delayAfterMs: 0 };
}

function editorEntry({ revision = 1, mode = "workflow", text = "SAVED", tab = 1 } = {}) {
  return {
    mode,
    keepAwake: false,
    recovery: { mode: "safe", identityAttempts: 3, readiness: "normal", statusRecovery: "normal" },
    quick: { preset: "review", prompt: text, repeat: "1", delay: "0" },
    workflow: {
      schemaVersion: 1,
      id: `workflow-${tab}`,
      name: `Workflow ${tab}`,
      maxSends: 1,
      steps: [prompt(`prompt-${tab}`, text)]
    },
    flow: {
      text: `flow flow-${tab} { send """${text}""" }`,
      selectedIndex: 0,
      openedLibraryId: null,
      execution: { mode: "full", start: "1", end: "1", repeat: "1", checkpointId: "" }
    },
    editorRevision: revision,
    updatedAt: 1
  };
}

function fakeArea(map, { fail = false } = {}) {
  return {
    async get() {
      if (fail) throw new Error("raw storage detail must not escape");
      return { [UI_KEY]: structuredClone(map) };
    }
  };
}

function startMessages(harness) {
  return harness.messages.filter((message) =>
    message?.type === "AIPM_RELAY_TO_CHATGPT" && message?.payload?.type === "AIPM_START");
}

test("Phase 4D A/B: exact-tab fresh reads select only the requested saved workflow", async () => {
  const map = { 1: editorEntry({ tab: 1, text: "TAB A" }), 2: editorEntry({ tab: 2, text: "TAB B" }) };
  const a = await readStartSourceForTab(1, { storageArea: fakeArea(map) });
  const b = await readStartSourceForTab(2, { storageArea: fakeArea(map) });
  assert.equal(a.workflow.steps[0].prompt, "TAB A");
  assert.equal(b.workflow.steps[0].prompt, "TAB B");
  assert.equal(Object.hasOwn(a, "editorRevision"), false, "editor revision must not enter Run authority");
});

test("Phase 4D D/E: the returned workflow is a deep saved snapshot with no DOM dependency", () => {
  const entry = editorEntry({ text: "SAVED" });
  const resolved = resolveStartSourceFromEditorEntry(entry);
  entry.workflow.steps[0].prompt = "UNSAVED OR LATER";
  assert.equal(resolved.workflow.steps[0].prompt, "SAVED");
  assert.equal(JSON.stringify(resolved).includes("document"), false);
});

test("Phase 4D F/G/H: missing, malformed and failed storage reads fail closed", async () => {
  await assert.rejects(
    () => readStartSourceForTab(9, { storageArea: fakeArea({}) }),
    (error) => error?.code === START_SOURCE_ERROR_CODES.EDITOR_STATE_MISSING
  );
  assert.throws(
    () => resolveStartSourceFromEditorEntry({ ...editorEntry(), mode: "unknown" }),
    (error) => error?.code === START_SOURCE_ERROR_CODES.EDITOR_STATE_INVALID
  );
  await assert.rejects(
    () => readStartSourceForTab(1, { storageArea: fakeArea({}, { fail: true }) }),
    (error) => error?.code === "UI_STATE_READ_FAILED" && !error.message.includes("raw storage")
  );
});

test("Phase 4D A: real Side Panel Start uses the latest Workspace-saved state, not its restored DOM", async () => {
  const initial = editorEntry({ revision: 4, text: "OLD RESTORED" });
  const harness = await installSidePanelHarness({
    tabIds: [1],
    storageSeed: { [SELECTED_KEY]: 1, [UI_KEY]: { 1: initial } }
  });
  try {
    await tick();
    harness.storage.set(UI_KEY, { 1: editorEntry({ revision: 5, text: "LATEST WORKSPACE" }) });
    await harness.click("start");
    const starts = startMessages(harness);
    assert.equal(starts.length, 1);
    assert.equal(starts[0].targetTabId, 1);
    assert.equal(starts[0].payload.workflow.steps[0].prompt, "LATEST WORKSPACE");
    assert.equal(Object.hasOwn(starts[0].payload, "editorRevision"), false);
  } finally {
    harness.restoreGlobals();
  }
});

test("Side Panel scheduled-time control renders local minutes and preserves its saved ISO value", async () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = "Asia/Tokyo";
  let harness;
  try {
    const original = editorEntry();
    original.workflow.steps.push({
      id: "scheduled", type: "wait-until", at: "2026-09-05T00:15:43.987Z",
      latePolicy: "pause", graceMs: 300000
    });
    harness = await installSidePanelHarness({
      tabIds: [1], storageSeed: { [SELECTED_KEY]: 1, [UI_KEY]: { 1: original } }
    });
    await tick();
    const descendants = (node) => [node, ...node.children.flatMap(descendants)];
    const when = descendants(harness.el("steps")).find((node) => node.type === "datetime-local");
    assert.equal(when.value, "2026-09-05T09:15");
    assert.equal(harness.storage.get(UI_KEY)[1].workflow.steps[1].at, original.workflow.steps[1].at);
    when.value = "2026-09-06T10:45";
    await when.dispatch("change");
    await tick();
    assert.deepEqual(harness.storage.get(UI_KEY)[1].workflow.steps[1], {
      ...original.workflow.steps[1], at: "2026-09-06T01:45:00.000Z"
    });
    assert.equal(startMessages(harness).length, 0);
  } finally {
    harness?.restoreGlobals();
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test("Phase 4D Quick decision: compact Quick DOM is saved, then fresh-read before Start", async () => {
  const harness = await installSidePanelHarness({
    tabIds: [1],
    storageSeed: { [SELECTED_KEY]: 1, [UI_KEY]: { 1: editorEntry({ mode: "quick", text: "OLD QUICK" }) } }
  });
  try {
    await tick();
    harness.el("quickPrompt").value = "VISIBLE QUICK";
    harness.el("quickRepeat").value = "2";
    await harness.click("start");
    const starts = startMessages(harness);
    assert.equal(starts.length, 1);
    assert.equal(starts[0].payload.workflow.steps[0].prompt, "VISIBLE QUICK");
    assert.equal(starts[0].payload.workflow.steps[0].repeat, 2);
    assert.equal(harness.storage.get(UI_KEY)[1].quick.prompt, "VISIBLE QUICK");
  } finally {
    harness.restoreGlobals();
  }
});

test("Phase 4D D: a later Workspace save cannot retroactively mutate the dispatched Run snapshot", async () => {
  const harness = await installSidePanelHarness({
    tabIds: [1],
    storageSeed: { [SELECTED_KEY]: 1, [UI_KEY]: { 1: editorEntry({ revision: 4, text: "RUN SNAPSHOT N" }) } }
  });
  try {
    await tick();
    harness.setRelayResponder(async (message) => {
      if (message?.payload?.type === "AIPM_START") {
        harness.storage.set(UI_KEY, { 1: editorEntry({ revision: 5, text: "EDITOR N PLUS ONE" }) });
      }
      return { ok: true };
    });
    await harness.click("start");
    const starts = startMessages(harness);
    assert.equal(starts.length, 1);
    assert.equal(starts[0].payload.workflow.steps[0].prompt, "RUN SNAPSHOT N");
    assert.equal(harness.storage.get(UI_KEY)[1].workflow.steps[0].prompt, "EDITOR N PLUS ONE");
  } finally {
    harness.restoreGlobals();
  }
});

test("Phase 4D C: a target switch while the Start read is pending aborts with Wrong Send 0", async () => {
  const gate = deferred();
  const harness = await installSidePanelHarness({
    tabIds: [1, 2],
    storageSeed: {
      [SELECTED_KEY]: 1,
      [UI_KEY]: { 1: editorEntry({ tab: 1, text: "TAB A" }), 2: editorEntry({ tab: 2, text: "TAB B" }) }
    }
  });
  try {
    await tick();
    let held = false;
    harness.setStorageReadHook(async (key) => {
      const touchesEditor = key === UI_KEY || (Array.isArray(key) && key.includes(UI_KEY));
      if (touchesEditor && !held) {
        held = true;
        await gate.promise;
      }
    });
    const starting = harness.click("start");
    await tick();
    harness.el("targetTab").value = "2";
    const switching = harness.change("targetTab");
    await tick();
    gate.resolve();
    await Promise.all([starting, switching]);
    assert.equal(startMessages(harness).length, 0);
  } finally {
    harness.restoreGlobals();
  }
});

test("Phase 4D G/H: the real Start boundary grants no relay on malformed or unreadable state", async () => {
  const harness = await installSidePanelHarness({
    tabIds: [1],
    storageSeed: { [SELECTED_KEY]: 1, [UI_KEY]: { 1: editorEntry() } }
  });
  try {
    await tick();
    harness.storage.set(UI_KEY, { 1: { ...editorEntry({ revision: 2 }), mode: "invalid" } });
    await harness.click("start");
    assert.equal(startMessages(harness).length, 0);

    harness.storage.set(UI_KEY, { 1: editorEntry({ revision: 3 }) });
    harness.setStorageReadHook(async (key) => {
      if (key === UI_KEY || (Array.isArray(key) && key.includes(UI_KEY))) throw new Error("private detail");
    });
    await harness.click("start");
    assert.equal(startMessages(harness).length, 0);
    assert.equal(harness.el("message").textContent.includes("private detail"), false);
  } finally {
    harness.restoreGlobals();
  }
});

test("Phase 4D layout: Side Panel exposes a cockpit and keeps full authoring inert", () => {
  const html = fs.readFileSync(new URL("../src/sidepanel.html", import.meta.url), "utf8");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "every control has exactly one DOM identity");
  assert.equal(ids.filter((id) => id === "start").length, 1);
  assert.match(html, /<section id="runCard"[^>]*aria-label="実行コントロール"/);
  assert.match(html, /id="savedAutomation"/);
  assert.match(html, /id="quickPanel"/);
  assert.match(html, /id="authoringCompatibilityState"[^>]*\bhidden\b[^>]*\binert\b/);
  assert.doesNotMatch(html, /<nav class="tabs" aria-label="自動化モード">/);
  assert.doesNotMatch(html, /savedAutomationFreshness/);
  assert.ok(html.indexOf('id="targetTab"') < html.indexOf('id="runCard"'));
  assert.ok(html.indexOf('id="runCard"') < html.indexOf('id="savedAutomation"'));
});

test("production presentation expands active, confirmation and fail-closed states, then returns to compact idle", async () => {
  const harness = await installSidePanelHarness({ tabIds: [1], storageSeed: { [SELECTED_KEY]: 1 } });
  try {
    await tick();
    assert.equal(harness.el("runDetails").hidden, true);
    assert.equal(harness.el("progress").hidden, true);
    assert.equal(harness.el("startSection").hidden, false);
    const runBase = {
      runId: "disclosure", stateRevision: 3, status: "running", phase: "delay",
      plannedSends: 2, cursor: { stepIndex: 0, sendsCompleted: 0 },
      workflow: { steps: [prompt("p", "UNCHANGED")] }, outbox: null, resumable: true
    };
    for (const [delta, kind] of [
      [{}, "running"],
      [{ status: "paused", pauseReason: "user-pause" }, "user-paused"],
      [{ status: "paused", phase: "checkpoint", pauseReason: "manual-checkpoint", checkpointLabel: "確認する" }, "confirmation-required"],
      [{ status: "paused", resumable: false, pauseReason: "generation_timeout", outbox: { state: "confirmed" } }, "fail-closed"]
    ]) {
      harness.setRelayResponder(() => ({ ok: true, pageReady: true, blocker: null, run: { ...runBase, ...delta } }));
      await harness.click("refreshTabs");
      assert.equal(harness.el("runCard").dataset.state, kind);
      assert.equal(harness.el("runDetails").hidden, false);
      assert.equal(harness.el("runCard").dataset.promoted, "true");
      assert.ok(harness.el("message").textContent);
      assert.ok(harness.el("nextAction").textContent);
      if (kind !== "fail-closed") {
        assert.equal(harness.el("stop").disabled, false);
        assert.equal(harness.el("startSection").hidden, true);
      } else {
        assert.match(harness.el("message").textContent, /送信.*確認済み/);
        assert.match(harness.el("message").textContent, /自動再送しません/);
      }
    }
    harness.setRelayResponder(() => ({ ok: true, pageReady: true, run: null }));
    await harness.click("refreshTabs");
    assert.equal(harness.el("runCard").dataset.promoted, "false");
    assert.equal(harness.el("runDetails").hidden, true);
    assert.equal(harness.el("startSection").hidden, false);
    assert.equal(startMessages(harness).length, 0, "presentation changes do not dispatch a Run");
  } finally {
    harness.restoreGlobals();
  }
});
