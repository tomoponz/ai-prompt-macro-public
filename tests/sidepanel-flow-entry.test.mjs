import assert from "node:assert/strict";
import test from "node:test";

import { compileAipmFlow } from "../src/flow-compile.js";
import { buildExecutionPlan } from "../src/execution-plan.js";
import { MAX_FLOW_TEXT_BYTES } from "../src/flow-script.js";
import { resolveStartSourceFromEditorEntry } from "../src/sidepanel-start-source.js";
import { UI_STATE_LOCK_NAME, UI_STATE_MAP_KEY } from "../src/ui-state-store.js";
import { installSidePanelHarness, deferred, tick } from "./helpers/sidepanel-harness.mjs";

const SELECTED_KEY = "aipm.selectedTab.v1";
const FULL = { mode: "full", start: "1", end: "1", repeat: "1", checkpointId: "" };
const FLOW = 'flow reviewed { send """REVIEWED FIRST""" repeat 3 { send """REVIEWED NEXT""" } checkpoint "Review" }';
const MULTI = 'flow first { send """FIRST FLOW""" } flow second { repeat 2 { send """SECOND FLOW""" } }';
const pause = (milliseconds = 280) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function entry({ mode = "quick", text = 'flow saved { send """SAVED FLOW""" }', revision = 4,
  selectedIndex = 0, execution = FULL, prompt = "OLD QUICK" } = {}) {
  return {
    mode, keepAwake: false,
    recovery: { mode: "safe", identityAttempts: 3, readiness: "normal", statusRecovery: "normal" },
    quick: { preset: "review", prompt, repeat: "1", delay: "0" },
    workflow: {
      schemaVersion: 1, id: "saved-workflow", name: "Saved workflow", maxSends: 1,
      steps: [{ id: "saved-step", type: "prompt", delivery: "send", prompt: "SAVED WORKFLOW", repeat: 1, delayAfterMs: 0 }]
    },
    flow: { text, selectedIndex, execution: structuredClone(execution), openedLibraryId: null },
    editorRevision: revision, updatedAt: 1
  };
}

async function panel(t, first = entry(), { tabIds = [1, 2] } = {}) {
  const harness = await installSidePanelHarness({
    tabIds,
    storageSeed: { [SELECTED_KEY]: 1, [UI_STATE_MAP_KEY]: { 1: first, 2: entry({ prompt: "TAB TWO" }) } }
  });
  t.after(async () => {
    // Let the production input debounce settle before returning the global DOM to Node.
    await pause();
    harness.restoreGlobals();
  });
  await tick();
  return harness;
}

async function paste(harness, text = FLOW) {
  await harness.click("flowTab");
  harness.el("flowText").value = text;
  await harness.input("flowText");
  await pause();
}

const relays = (harness, type = "AIPM_START") => harness.messages.filter((message) =>
  message?.type === "AIPM_RELAY_TO_CHATGPT" && message?.payload?.type === type);
const saved = (harness, tabId = 1) => structuredClone(harness.storage.get(UI_STATE_MAP_KEY)[tabId]);
const textIn = (node) => [node?.textContent ?? "", ...(node?.children ?? []).map(textIn)].join("\n");

function externalWrite(harness, next) {
  const map = structuredClone(harness.storage.get(UI_STATE_MAP_KEY));
  map[1] = next;
  harness.storage.set(UI_STATE_MAP_KEY, map);
  harness.fireStorageChanged({ [UI_STATE_MAP_KEY]: { newValue: map } });
}

async function entered(gate) {
  let timeout;
  try {
    await Promise.race([
      gate.started,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("production editor save did not reach its lock")), 2000); })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test("U3/U5: pasted Flow previews the production plan and replaces old Quick only through save then Start", async (t) => {
  const h = await panel(t);
  await paste(h);
  const expectedPlan = buildExecutionPlan(compileAipmFlow(FLOW).flows[0], FULL);
  assert.equal(h.el("flowError").hidden, true);
  assert.equal(h.el("flowPlannedSends").textContent, "4");
  assert.match(textIn(h.el("flowPlanSteps")), /REVIEWED FIRST/);
  assert.match(textIn(h.el("flowPlanSteps")), /REVIEWED NEXT/);
  assert.equal(relays(h).length, 0, "input and local validation must never dispatch Start");
  await h.click("start");
  const starts = relays(h);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].targetTabId, 1);
  assert.equal(saved(h).mode, "flow");
  assert.equal(saved(h).flow.text, FLOW);
  assert.deepEqual(starts[0].payload.workflow, resolveStartSourceFromEditorEntry(saved(h)).workflow);
  assert.deepEqual(starts[0].payload.workflow.steps, expectedPlan.workflow.steps);
  assert.equal(JSON.stringify(starts[0].payload).includes("OLD QUICK"), false);
  assert.equal(Object.hasOwn(starts[0].payload, "editorRevision"), false);
});

for (const mode of ["quick", "flow"]) {
  test(`U5: ${mode} Start accepts identical saved content when storage reorders object keys`, async (t) => {
    const h = await panel(t);
    if (mode === "flow") await paste(h);
    else {
      h.el("quickPrompt").value = "REVIEWED QUICK";
      h.el("quickRepeat").value = "3";
    }
    const reorder = (value) => {
      if (Array.isArray(value)) return value.map(reorder);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, reorder(value[key])]));
    };
    let reordered = false;
    h.setStorageReadHook(async (key) => {
      if (!reordered && Array.isArray(key) && key.includes(UI_STATE_MAP_KEY)) {
        const map = h.storage.get(UI_STATE_MAP_KEY);
        assert.equal(map[1].mode, mode, "the editor save must precede this fresh-source read");
        const normalizedOrder = reorder(map);
        assert.notEqual(JSON.stringify(normalizedOrder), JSON.stringify(map), "the fixture must actually change key ordering");
        h.storage.set(UI_STATE_MAP_KEY, normalizedOrder);
        reordered = true;
      }
    });
    await h.click("start");
    assert.equal(reordered, true);
    assert.equal(relays(h).length, 1);
    assert.equal(relays(h)[0].targetTabId, 1);
    assert.deepEqual(relays(h)[0].payload.workflow, resolveStartSourceFromEditorEntry(saved(h)).workflow);
    if (mode === "flow") {
      assert.deepEqual(relays(h)[0].payload.workflow.steps, compileAipmFlow(FLOW).flows[0].workflow.steps);
    } else {
      assert.equal(relays(h)[0].payload.workflow.steps[0].prompt, "REVIEWED QUICK");
      assert.equal(relays(h)[0].payload.workflow.steps[0].repeat, 3);
    }
  });
}

for (const [label, invalid] of [
  ["syntax", 'flow invalid { send """unterminated'],
  ["unsupported Draft", 'flow invalid { draft """DO NOT CONVERT TO SEND""" }'],
  ["51 sends", 'flow invalid { repeat 50 { send """one""" } send """51""" }'],
  ["oversized source", `flow invalid { send """${"x".repeat(MAX_FLOW_TEXT_BYTES)}""" }`],
  ["Markdown and prose", `Here is your Flow:\n\`\`\`\n${FLOW}\n\`\`\``]
]) {
  test(`U4: ${label} invalidates the old preview and never starts or rewrites the input`, async (t) => {
    const h = await panel(t);
    await paste(h);
    h.el("flowText").value = invalid;
    await h.input("flowText");
    assert.equal(h.el("start").disabled, true, "the old validated plan must be unavailable during debounce");
    await h.click("start");
    await pause();
    assert.equal(h.el("flowError").hidden, false);
    assert.match(h.el("flowError").textContent, /line|行/);
    assert.equal(h.el("start").disabled, true);
    await h.click("start");
    assert.equal(relays(h).length, 0);
    assert.equal(h.el("flowText").value, invalid);
  });
}

for (const edit of ["body", "selection"]) {
  test(`U6: ${edit} changes during the editor save abort the captured Start and retain the new input`, async (t) => {
    const h = await panel(t);
    await paste(h, MULTI);
    const gate = h.lockManager.holdNext(UI_STATE_LOCK_NAME);
    const starting = h.click("start");
    try {
      await entered(gate);
      if (edit === "body") {
        h.el("flowText").value = FLOW;
        await h.input("flowText");
      } else {
        h.el("flowSelector").value = "1";
        await h.change("flowSelector");
      }
    } finally {
      gate.release();
      await starting;
    }
    await pause();
    assert.equal(relays(h).length, 0);
    assert.equal(h.el("flowText").value, edit === "body" ? FLOW : MULTI);
    if (edit === "selection") assert.equal(h.el("flowSelector").value, "1");
  });
}

test("U6: editing during the fresh saved-source read refuses stale Start even after its save succeeded", async (t) => {
  const h = await panel(t);
  await paste(h);
  const readGate = deferred();
  const reached = deferred();
  let held = false;
  h.setStorageReadHook(async (key) => {
    if (!held && Array.isArray(key) && key.includes(UI_STATE_MAP_KEY)) {
      held = true;
      reached.resolve();
      await readGate.promise;
    }
  });
  const starting = h.click("start");
  try {
    await entered({ started: reached.promise });
    h.el("flowText").value = MULTI;
    await h.input("flowText");
  } finally {
    readGate.resolve();
    await starting;
  }
  assert.equal(saved(h).flow.text, FLOW, "the first save completed before the controlled fresh read");
  assert.equal(h.el("flowText").value, MULTI);
  assert.equal(relays(h).length, 0);
});

test("U6: changing then restoring the original text during preparation still invalidates the old confirmation", async (t) => {
  const h = await panel(t);
  await paste(h);
  const gate = h.lockManager.holdNext(UI_STATE_LOCK_NAME);
  const starting = h.click("start");
  try {
    await entered(gate);
    h.el("flowText").value = MULTI;
    await h.input("flowText");
    h.el("flowText").value = FLOW;
    await h.input("flowText");
    await pause();
  } finally {
    gate.release();
    await starting;
  }
  assert.equal(h.el("flowText").value, FLOW);
  assert.equal(h.el("flowError").hidden, true, "the restored text can be reviewed again");
  assert.equal(relays(h).length, 0, "a later matching value must not revive an earlier Start intent");
  await h.click("start");
  assert.equal(relays(h).length, 1);
});

test("U6: a different saved Flow returned by the fresh read cannot replace the reviewed source", async (t) => {
  const h = await panel(t);
  await paste(h);
  let changed = false;
  h.setStorageReadHook(async (key) => {
    if (!changed && Array.isArray(key) && key.includes(UI_STATE_MAP_KEY)) {
      changed = true;
      const map = structuredClone(h.storage.get(UI_STATE_MAP_KEY));
      map[1] = entry({ mode: "flow", text: MULTI, revision: map[1].editorRevision + 1 });
      h.storage.set(UI_STATE_MAP_KEY, map);
    }
  });
  await h.click("start");
  assert.equal(changed, true);
  assert.equal(relays(h).length, 0);
  assert.equal(h.el("flowText").value, FLOW);
});

test("U6/U10: target switching during preparation dispatches nothing and saves the draft only to its source tab", async (t) => {
  const h = await panel(t);
  await paste(h);
  const secondBefore = saved(h, 2);
  const gate = h.lockManager.holdNext(UI_STATE_LOCK_NAME);
  const starting = h.click("start");
  let switching;
  try {
    await entered(gate);
    h.el("targetTab").value = "2";
    switching = h.change("targetTab");
    await tick();
  } finally {
    gate.release();
    await Promise.all([starting, switching]);
  }
  assert.equal(relays(h).length, 0);
  assert.equal(saved(h, 1).flow.text, FLOW);
  assert.deepEqual(saved(h, 2), secondBefore);
  assert.equal(h.el("targetTab").value, "2");
});

for (const stage of ["source save", "destination read", "selected target write"]) {
  test(`U6: edits during target-switch ${stage} retain the original target and the newer unsaved input`, async (t) => {
    const h = await panel(t);
    await paste(h);
    const destinationBefore = saved(h, 2);
    const gate = stage === "source save"
      ? h.lockManager.holdNext(UI_STATE_LOCK_NAME)
      : (() => {
          const held = deferred();
          const reached = deferred();
          let intercepted = false;
          const intercept = async () => {
            if (!intercepted) {
              intercepted = true;
              reached.resolve();
              await held.promise;
            }
          };
          if (stage === "destination read") {
            h.setStorageReadHook(async (key) => {
              if (Array.isArray(key) && key.includes(UI_STATE_MAP_KEY)) await intercept();
            });
          } else {
            h.setStorageMutationHook(async (values) => {
              if (values[SELECTED_KEY] === 2) await intercept();
            });
          }
          return { started: reached.promise, release: held.resolve };
        })();
    h.el("targetTab").value = "2";
    const switching = h.change("targetTab");
    try {
      await entered(gate);
      h.el("flowText").value = MULTI;
      await h.input("flowText");
    } finally {
      gate.release();
      await switching;
    }
    await pause();
    assert.equal(h.el("targetTab").value, "1");
    assert.equal(h.storage.get(SELECTED_KEY), 1);
    assert.equal(h.el("flowText").value, MULTI);
    assert.deepEqual(saved(h, 2), destinationBefore);
    assert.equal(relays(h).length, 0);
  });
}

test("U7: repeated Start while save is held creates exactly one Start relay", async (t) => {
  const h = await panel(t);
  await paste(h);
  const gate = h.lockManager.holdNext(UI_STATE_LOCK_NAME);
  const starting = h.click("start");
  try {
    await entered(gate);
    await h.click("start");
    assert.equal(relays(h).length, 0);
  } finally {
    gate.release();
    await starting;
  }
  assert.equal(relays(h).length, 1);
});

test("U8: failed storage save retains pasted input, never falls back to Quick, and permits a later retry", async (t) => {
  const h = await panel(t);
  await paste(h);
  const before = saved(h);
  h.setStorageMutationHook(async (values) => {
    if (Object.hasOwn(values, UI_STATE_MAP_KEY)) throw new Error("simulated write failure");
  });
  await h.click("start");
  assert.equal(relays(h).length, 0);
  assert.deepEqual(saved(h), before);
  assert.equal(h.el("flowText").value, FLOW);
  h.setStorageMutationHook(null);
  await h.click("start");
  assert.equal(relays(h).length, 1);
  assert.equal(relays(h)[0].payload.workflow.steps[0].prompt, "REVIEWED FIRST");
});

test("U8/U9: a Workspace revision conflict preserves the draft, offers a copy exit and refuses Start", async (t) => {
  const h = await panel(t);
  await paste(h);
  const theirs = entry({ mode: "flow", text: MULTI, revision: 50 });
  externalWrite(h, theirs);
  await tick();
  assert.equal(h.el("flowText").value, FLOW);
  assert.equal(h.el("editorStateNotice").hidden, false);
  assert.equal(h.el("start").disabled, true);
  await h.click("start");
  assert.equal(relays(h).length, 0);
  assert.deepEqual(saved(h), theirs);
  await h.click("copyEditorInput");
  assert.ok(h.clipboard.includes(FLOW));
  assert.equal(h.el("flowText").value, FLOW);
});

test("U9: an untouched panel follows Workspace storage without starting and shows the new production plan", async (t) => {
  const h = await panel(t, entry({ mode: "flow" }));
  externalWrite(h, entry({ mode: "flow", text: MULTI, revision: 50, selectedIndex: 1 }));
  await pause();
  assert.equal(h.el("flowText").value, MULTI);
  assert.equal(h.el("flowSelector").value, "1");
  assert.equal(h.el("flowPlannedSends").textContent, "2");
  assert.match(textIn(h.el("flowPlanSteps")), /SECOND FLOW/);
  assert.equal(relays(h).length, 0);
  await h.click("start");
  assert.equal(relays(h).length, 1);
  assert.equal(relays(h)[0].payload.workflow.steps[0].prompt, "SECOND FLOW");
});

test("U9: edits made while clean Workspace-follow read is pending are never replaced", async (t) => {
  const h = await panel(t, entry({ mode: "flow" }));
  const readGate = deferred();
  const reached = deferred();
  let held = false;
  h.setStorageReadHook(async (key) => {
    if (!held && Array.isArray(key) && key.includes(UI_STATE_MAP_KEY)) {
      held = true;
      reached.resolve();
      await readGate.promise;
    }
  });
  externalWrite(h, entry({ mode: "flow", text: MULTI, revision: 50 }));
  try {
    await entered({ started: reached.promise });
    h.el("flowText").value = FLOW;
    await h.input("flowText");
  } finally {
    readGate.resolve();
    await pause();
  }
  assert.equal(h.el("flowText").value, FLOW);
  await h.click("start");
  assert.equal(relays(h).length, 0);
  assert.equal(saved(h).flow.text, MULTI);
});

test("U10: viewing another active browser tab keeps the selected target and reviewed Flow on tab A", async (t) => {
  const h = await panel(t);
  await paste(h);
  const initialList = h.messages.find((message) => message.type === "AIPM_LIST_CHATGPT_TABS");
  assert.ok(initialList);
  h.setListTabsResponder(() => ({
    ok: true, serviceWorkerVersion: "0.4.0", siteAccessGranted: true,
    tabs: [1, 2].map((tabId) => ({
      tabId, windowId: 1, active: tabId === 2,
      status: { pageReady: true, generationState: "idle", blocker: null, run: null,
        provider: "chatgpt", contentVersion: "0.4.0", instanceId: `instance-${tabId}`,
        conversationKey: `chatgpt:c:tab-${tabId}`, discoveryError: null }
    }))
  }));
  await h.click("refreshTabs");
  assert.equal(h.el("targetTab").value, "1");
  assert.equal(h.el("flowText").value, FLOW);
  await h.click("start");
  assert.equal(relays(h).length, 1);
  assert.equal(relays(h)[0].targetTabId, 1);
});

test("U10: a disappeared selected target retains local Flow and never transfers it to another available tab", async (t) => {
  const h = await panel(t);
  await paste(h);
  const secondBefore = saved(h, 2);
  h.setListTabsResponder(() => ({
    ok: true, serviceWorkerVersion: "0.4.0", siteAccessGranted: true,
    tabs: [{ tabId: 2, windowId: 1, active: true,
      status: { pageReady: true, provider: "chatgpt", contentVersion: "0.4.0", run: null,
        instanceId: "instance-2", conversationKey: "chatgpt:c:tab-2", discoveryError: null } }]
  }));
  await h.click("refreshTabs");
  assert.equal(h.el("targetTab").value, "1");
  assert.equal(h.el("flowText").value, FLOW);
  assert.equal(h.el("start").disabled, true);
  await h.click("start");
  assert.equal(relays(h).length, 0);
  assert.deepEqual(saved(h, 2), secondBefore);
  assert.equal(h.el("flowText").value, FLOW);
});

test("U11: a selected Flow and saved partial range stay identical in preview, storage and Start", async (t) => {
  const text = 'flow ignored { send """NOT SELECTED""" } flow selected { send """OUTSIDE RANGE""" checkpoint "Review" send """ONLY THIS""" }';
  const execution = { ...FULL, mode: "range-repeat", start: "3", end: "3", repeat: "2" };
  const original = entry({ mode: "flow", text, selectedIndex: 1, execution });
  const h = await panel(t, original);
  const plan = buildExecutionPlan(compileAipmFlow(text).flows[1], execution);
  assert.equal(h.el("flowSelector").value, "1");
  assert.equal(h.el("flowPreviewRange").textContent, plan.rangeLabel);
  assert.equal(h.el("flowPlannedSends").textContent, "2");
  assert.match(textIn(h.el("flowPlanSteps")), /ONLY THIS/);
  assert.equal(textIn(h.el("flowPlanSteps")).includes("OUTSIDE RANGE"), false);
  await h.click("start");
  assert.equal(relays(h).length, 1);
  // checkpointId is inactive for a range plan; the existing controls may select
  // the first available checkpoint without changing the executed range.
  for (const field of ["mode", "start", "end", "repeat"]) {
    assert.equal(saved(h).flow.execution[field], execution[field]);
  }
  assert.deepEqual(relays(h)[0].payload.workflow.steps, plan.workflow.steps);
});

test("U11: newly pasted text resets an old partial range and selection to the reviewed full first Flow", async (t) => {
  const h = await panel(t, entry({ mode: "flow", text: MULTI, selectedIndex: 1,
    execution: { ...FULL, mode: "step", start: "1" } }));
  await paste(h, FLOW);
  assert.equal(h.el("flowSelector").value, "0");
  assert.equal(h.el("flowPreviewRange").textContent, "Flow全体");
  assert.equal(h.el("flowPlannedSends").textContent, "4");
  await h.click("start");
  assert.equal(relays(h).length, 1);
  assert.equal(saved(h).flow.selectedIndex, 0);
  assert.equal(saved(h).flow.execution.mode, "full");
  assert.deepEqual(relays(h)[0].payload.workflow.steps, compileAipmFlow(FLOW).flows[0].workflow.steps);
});

test("U11: an unavailable saved checkpoint cannot silently fall back to the first checkpoint", async (t) => {
  const text = 'flow selected { send """BEFORE""" checkpoint "First checkpoint" send """AFTER""" }';
  const original = entry({ mode: "flow", text,
    execution: { ...FULL, mode: "after-checkpoint", checkpointId: "no-longer-present" } });
  const h = await panel(t, original);
  assert.equal(h.el("flowError").hidden, false);
  assert.match(h.el("flowError").textContent, /保存済みのFlow・選択・実行範囲を確認できません/);
  assert.equal(h.el("start").disabled, true);
  await h.click("start");
  assert.equal(relays(h).length, 0);
  assert.deepEqual(saved(h), original);
  assert.equal(h.el("flowText").value, text);
});

for (const [label, malformedFlow] of [
  ["out-of-range selection", { text: MULTI, selectedIndex: 99, execution: FULL }],
  ["string selection", { text: MULTI, selectedIndex: "1", execution: FULL }],
  ["missing selection", { text: MULTI, execution: FULL }],
  ["negative selection", { text: MULTI, selectedIndex: -1, execution: FULL }],
  ["missing source text", { selectedIndex: 0, execution: FULL }],
  ["non-string source text", { text: { unexpected: "value" }, selectedIndex: 0, execution: FULL }],
  ["missing execution configuration", { text: MULTI, selectedIndex: 0 }],
  ["null execution configuration", { text: MULTI, selectedIndex: 0, execution: null }],
  ["array execution configuration", { text: MULTI, selectedIndex: 0, execution: [] }],
  ["unknown execution mode", { text: MULTI, selectedIndex: 0, execution: { ...FULL, mode: "unknown-range" } }],
  ["missing range start", { text: MULTI, selectedIndex: 0, execution: { mode: "range", end: "1" } }],
  ["missing range end", { text: MULTI, selectedIndex: 0, execution: { mode: "range", start: "1" } }],
  ["missing range repeat count", { text: MULTI, selectedIndex: 0, execution: { mode: "range-repeat", start: "1", end: "1" } }]
]) {
  test(`U11: restored ${label} cannot be corrected into a Start; explicit new input remains usable`, async (t) => {
    const original = { ...entry({ mode: "flow" }), flow: structuredClone(malformedFlow) };
    const h = await panel(t, original);
    assert.equal(h.el("start").disabled, true);
    assert.ok(!h.el("flowError").hidden || !h.el("flowPlanError").hidden,
      "restored malformed configuration must produce a visible bounded diagnosis");
    assert.equal(textIn(h.el("flowPlanSteps")).trim(), "", "fallback source or range must not become a reviewed plan");
    await h.click("start");
    assert.equal(relays(h).length, 0);
    assert.deepEqual(saved(h), original, "Start must not overwrite malformed saved data with UI defaults");

    await paste(h, FLOW);
    assert.equal(h.el("flowError").hidden, true);
    assert.equal(h.el("flowSelector").value, "0");
    assert.equal(h.el("flowPreviewRange").textContent, "Flow全体");
    assert.equal(h.el("flowPlannedSends").textContent, "4");
    assert.equal(relays(h).length, 0, "replacing the text only enables review");
    await h.click("start");
    assert.equal(relays(h).length, 1);
    assert.deepEqual(relays(h)[0].payload.workflow.steps, compileAipmFlow(FLOW).flows[0].workflow.steps);
    assert.equal(saved(h).flow.text, FLOW);
    assert.equal(saved(h).flow.execution.mode, "full");
  });
}

test("U11: settings autosave and reopening cannot turn malformed saved Flow into executable defaults", async (t) => {
  const malformedFlow = { selectedIndex: 0, execution: structuredClone(FULL) };
  const h = await panel(t, { ...entry({ mode: "flow" }), flow: malformedFlow });
  assert.equal(h.el("start").disabled, true);
  h.el("keepAwake").checked = true;
  await h.change("keepAwake");
  await tick();
  const persisted = saved(h);
  assert.equal(persisted.keepAwake, true, "an unrelated editor preference can still be saved");
  assert.deepEqual(persisted.flow, malformedFlow, "autosave must preserve the raw invalid source instead of UI defaults");
  assert.equal(relays(h).length, 0);
  h.restoreGlobals();

  const reopened = await panel(t, persisted);
  assert.equal(reopened.el("start").disabled, true);
  await reopened.click("start");
  assert.equal(relays(reopened).length, 0);
  assert.deepEqual(saved(reopened).flow, malformedFlow);
});

test("U11: an invalid Flow saved beside Quick stays invalid when its entry opens without blocking valid Quick", async (t) => {
  const malformedFlow = { text: MULTI, selectedIndex: 99, execution: structuredClone(FULL) };
  const h = await panel(t, { ...entry({ mode: "quick" }), flow: malformedFlow });
  await h.click("flowTab");
  assert.equal(h.el("start").disabled, true);
  assert.equal(h.el("flowError").hidden, false);
  assert.equal(textIn(h.el("flowPlanSteps")).trim(), "");
  await h.click("start");
  assert.equal(relays(h).length, 0);
  assert.deepEqual(saved(h).flow, malformedFlow);

  await h.click("quickTab");
  await tick();
  assert.deepEqual(saved(h).flow, malformedFlow, "mode autosave must not repair the inactive Flow slot");
  await h.click("start");
  assert.equal(relays(h).length, 1);
  assert.equal(relays(h)[0].payload.workflow.steps[0].prompt, "OLD QUICK");
  assert.deepEqual(saved(h).flow, malformedFlow);
});

test("U12: editing and switching authoring modes cannot mutate the active Run or remove exact-Run Stop", async (t) => {
  const h = await panel(t);
  await paste(h);
  let activeRun = null;
  h.setRelayResponder(async (message) => {
    if (message.payload.type === "AIPM_START") {
      activeRun = { runId: "reviewed-run", status: "running", phase: "ready", stateRevision: 1,
        sentCount: 0, cursor: { stepIndex: 0, repeatIndex: 0 }, workflow: structuredClone(message.payload.workflow) };
    }
    if (message.payload.type === "AIPM_STOP") activeRun = null;
    return { ok: true, pageReady: true, provider: "chatgpt", contentVersion: "0.4.0", generationState: "idle",
      blocker: null, conversationKey: "chatgpt:c:tab-1", instanceId: "instance-1", run: activeRun, diagnostics: [] };
  });
  await h.click("start");
  assert.equal(relays(h).length, 1);
  const dispatched = structuredClone(relays(h)[0]);
  const runningWorkflow = structuredClone(activeRun.workflow);
  assert.equal(h.el("stop").disabled, false);
  h.el("flowText").value = MULTI;
  await h.input("flowText");
  await pause();
  await h.click("quickTab");
  await h.click("flowTab");
  assert.deepEqual(relays(h)[0], dispatched);
  assert.deepEqual(activeRun.workflow, runningWorkflow);
  assert.equal(h.el("start").disabled, true);
  assert.equal(h.el("stop").disabled, false);
  await h.click("stop");
  const stops = relays(h, "AIPM_STOP");
  assert.equal(stops.length, 1);
  assert.equal(stops[0].targetTabId, 1);
  assert.equal(stops[0].payload.expectedRunId, "reviewed-run");
  assert.equal(relays(h).length, 1);
});
