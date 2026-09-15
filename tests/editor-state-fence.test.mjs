/*
  Phase 4A — Side Panel integration of the editor state fence.

  The store's own tests prove the compare-and-set. These drive the real
  `src/sidepanel.js` through the DOM shim to prove the panel actually uses it:
  that it carries a revision across a restore, presents it on every save, adopts
  the revision a successful save returns, refuses a stale one without writing,
  and — the part that matters most — never replaces what the user has typed
  because some other surface saved first.
*/
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { installSidePanelHarness, tick } from "./helpers/sidepanel-harness.mjs";

const UI_KEY = "aipm.uiByTab.v2";
const TAB = 1;
const OTHER_TAB = 2;

const source = fs.readFileSync(new URL("../src/sidepanel.js", import.meta.url), "utf8");

const seededEntry = (overrides = {}) => ({
  mode: "quick",
  keepAwake: false,
  recovery: { readiness: "normal", status: "normal" },
  quick: { preset: "review", prompt: "SEEDED", repeat: "3", delay: "1.5" },
  workflow: { schemaVersion: 1, name: "seed", maxSends: 10, steps: [] },
  flow: { text: "flow seed { }", selectedIndex: 0, openedLibraryId: null, execution: { mode: "full" } },
  editorRevision: 4,
  updatedAt: 1_000,
  ...overrides
});

async function panel(seedEntry = seededEntry()) {
  const harness = await installSidePanelHarness({
    storageSeed: {
      "aipm.selectedTab.v1": TAB,
      [UI_KEY]: { [TAB]: seedEntry, [OTHER_TAB]: seededEntry({ editorRevision: 40, quick: { prompt: "OTHER" } }) }
    }
  });
  await tick();
  return harness;
}

const stored = (harness, tabId = TAB) => harness.storage.get(UI_KEY)?.[String(tabId)] ?? null;
const notice = (harness) => ({
  text: harness.el("editorStateNotice").textContent,
  hidden: harness.el("editorStateNotice").hidden
});

/* A save the panel definitely performs: multi-tab.test.mjs pins keepAwake's
   change handler to saveUiState(). */
async function triggerSave(harness) {
  harness.el("keepAwake").checked = !harness.el("keepAwake").checked;
  await harness.change("keepAwake");
  await tick();
}

/* Models another surface having written this tab's entry. */
function writeFromAnotherSurface(harness, { tabId = TAB, editorRevision, prompt = "THEIRS" } = {}) {
  const map = structuredClone(harness.storage.get(UI_KEY) ?? {});
  map[String(tabId)] = seededEntry({ editorRevision, quick: { preset: "review", prompt, repeat: "3", delay: "1.5" } });
  harness.storage.set(UI_KEY, map);
  return { [UI_KEY]: { newValue: structuredClone(map) } };
}

/* ------------------------------------------------- 19-21 revision lifecycle */

test("19. a restore adopts the stored editorRevision as its expected value", async () => {
  const harness = await panel();
  try {
    assert.equal(stored(harness).editorRevision, 4, "precondition: the seed carries revision 4");
    await triggerSave(harness);
    assert.equal(stored(harness).editorRevision, 5, "the save must present 4 and advance to 5");
  } finally {
    harness.restoreGlobals();
  }
});

test("20-21. each successful save advances the revision the panel then presents", async () => {
  const harness = await panel();
  try {
    await triggerSave(harness);
    await triggerSave(harness);
    await triggerSave(harness);
    assert.equal(stored(harness).editorRevision, 7, "three saves from revision 4");
    assert.equal(notice(harness).hidden, true, "a healthy save clears the notice");
  } finally {
    harness.restoreGlobals();
  }
});

test("an entry with no revision is migrated lazily on the next save", async () => {
  const legacyShaped = seededEntry();
  delete legacyShaped.editorRevision;
  delete legacyShaped.updatedAt;
  const harness = await panel(legacyShaped);
  try {
    assert.equal(Object.hasOwn(stored(harness), "editorRevision"), false, "precondition: no revision stored");
    await triggerSave(harness);
    assert.equal(stored(harness).editorRevision, 1);
    assert.ok(stored(harness).updatedAt > 0);
  } finally {
    harness.restoreGlobals();
  }
});

/* ------------------------------------------------------- 22 stale rejection */

test("22. a stale save neither overwrites the other surface's entry nor stays silent", async () => {
  const harness = await panel();
  try {
    harness.el("quickPrompt").value = "MINE";
    writeFromAnotherSurface(harness, { editorRevision: 9, prompt: "THEIRS" });

    await triggerSave(harness);

    const after = stored(harness);
    assert.equal(after.quick.prompt, "THEIRS", "the other surface's content must survive untouched");
    assert.equal(after.editorRevision, 9, "a refused save must not advance the revision");
    assert.equal(notice(harness).hidden, false, "the refusal must be visible, not silent");
    assert.match(notice(harness).text, /別の画面/);
  } finally {
    harness.restoreGlobals();
  }
});

test("a stale save leaves the unsaved input in the editor exactly as typed", async () => {
  const harness = await panel();
  try {
    harness.el("quickPrompt").value = "MINE";
    harness.el("flowText").value = "flow mine { }";
    writeFromAnotherSurface(harness, { editorRevision: 9 });

    await triggerSave(harness);

    assert.equal(harness.el("quickPrompt").value, "MINE");
    assert.equal(harness.el("flowText").value, "flow mine { }");
  } finally {
    harness.restoreGlobals();
  }
});

test("a save for a tab whose revision was never read is refused rather than unfenced", async () => {
  const harness = await panel();
  try {
    /* Drop this tab's entry behind the panel's back and hand it a revision it
       never observed. The panel still holds revision 4, so the write is refused
       instead of blindly recreating the entry. */
    writeFromAnotherSurface(harness, { editorRevision: 12 });
    await triggerSave(harness);
    assert.equal(stored(harness).editorRevision, 12);
    assert.equal(notice(harness).hidden, false);
  } finally {
    harness.restoreGlobals();
  }
});

/* ------------------------------------------------- 23-26 storage.onChanged */

test("23. an external change to a dirty current tab raises a bounded notice and retains input", async () => {
  const harness = await panel();
  try {
    harness.el("quickPrompt").value = "MY UNSAVED INPUT";
    const change = writeFromAnotherSurface(harness, { editorRevision: 9 });
    harness.fireStorageChanged(change, "local");
    await tick();
    assert.equal(notice(harness).hidden, false);
    assert.match(notice(harness).text, /保存済み内容を読み直して/);
    assert.equal(harness.el("quickPrompt").value, "MY UNSAVED INPUT");
    /* No stack, no storage contents, no internal code in the user-facing text. */
    assert.equal(/THEIRS|editorRevision|aipm\./.test(notice(harness).text), false);
  } finally {
    harness.restoreGlobals();
  }
});

test("24. a change to a different tab is not this tab's problem", async () => {
  const harness = await panel();
  try {
    const change = writeFromAnotherSurface(harness, { tabId: OTHER_TAB, editorRevision: 99 });
    harness.fireStorageChanged(change, "local");
    assert.equal(notice(harness).hidden, true);
    await triggerSave(harness);
    assert.equal(stored(harness).editorRevision, 5, "the current tab's own save still succeeds");
  } finally {
    harness.restoreGlobals();
  }
});

test("25. unrelated keys and unrelated storage areas are ignored", async () => {
  const harness = await panel();
  try {
    for (const [changes, area] of [
      [{ "aipm.diagnostics.v1": { newValue: [1, 2, 3] } }, "local"],
      [{ "aipm.flowLibrary.v1": { newValue: { entries: [] } } }, "local"],
      [{ "aipm.settings.v1": { newValue: {} } }, "local"],
      [{ "aipm.activeRun.v2.tab.1": { newValue: { status: "running" } } }, "local"],
      [{ [UI_KEY]: { newValue: { [TAB]: seededEntry({ editorRevision: 9 }) } } }, "session"],
      [{ [UI_KEY]: { newValue: { [TAB]: seededEntry({ editorRevision: 9 }) } } }, "sync"]
    ]) {
      harness.fireStorageChanged(changes, area);
      assert.equal(notice(harness).hidden, true, `${area} / ${Object.keys(changes)[0]} must be ignored`);
    }
  } finally {
    harness.restoreGlobals();
  }
});

test("26. an external change never replaces what is on screen", async () => {
  const harness = await panel();
  try {
    harness.el("quickPrompt").value = "UNSAVED WORK";
    harness.el("flowText").value = "flow unsaved { }";
    const change = writeFromAnotherSurface(harness, { editorRevision: 9, prompt: "THEIRS" });

    harness.fireStorageChanged(change, "local");
    await tick();

    assert.equal(harness.el("quickPrompt").value, "UNSAVED WORK");
    assert.equal(harness.el("flowText").value, "flow unsaved { }");
  } finally {
    harness.restoreGlobals();
  }
});

test("the panel's own save is not mistaken for somebody else's", async () => {
  const harness = await panel();
  try {
    await triggerSave(harness);
    /* Replay the echo the browser would deliver for the write we just made. */
    harness.fireStorageChanged({ [UI_KEY]: { newValue: structuredClone(harness.storage.get(UI_KEY)) } }, "local");
    assert.equal(notice(harness).hidden, true, "our own echo must not look like a conflict");
  } finally {
    harness.restoreGlobals();
  }
});

test("Phase 4C RED: an external revision observed during a successful panel save is not cleared", async () => {
  const harness = await panel();
  try {
    let observed = false;
    harness.setStorageMutationHook(async (values) => {
      if (observed || !Object.hasOwn(values, UI_KEY)) return;
      observed = true;
      const external = structuredClone(values[UI_KEY]);
      external[String(TAB)] = seededEntry({ editorRevision: 6, quick: { prompt: "THEIRS" } });
      harness.fireStorageChanged({ [UI_KEY]: { newValue: external } }, "local");
    });

    harness.el("quickPrompt").value = "MINE";
    await triggerSave(harness);

    assert.equal(observed, true);
    assert.equal(stored(harness).editorRevision, 5, "the panel's revision-5 CAS itself succeeded");
    assert.equal(notice(harness).hidden, false);
    assert.match(notice(harness).text, /別の画面/);
    assert.equal(harness.el("quickPrompt").value, "MINE");

    await triggerSave(harness);
    assert.equal(stored(harness).editorRevision, 5, "the conflicted panel must not issue a second write");
  } finally {
    harness.restoreGlobals();
  }
});

/* ------------------------------------------- 27-32 unchanged panel behaviour */

test("27. Flow input validates on the existing 250ms debounce without automatically saving", async () => {
  assert.match(source, /FLOW_PARSE_DEBOUNCE_MS = 250/);
  assert.match(source, /flowParseTimer = setTimeout\(/);
  const harness = await panel();
  try {
    await harness.click("flowTab");
    const before = structuredClone(stored(harness));
    harness.el("flowText").value = 'flow typed { send """typed""" }';
    await harness.input("flowText");
    assert.deepEqual(stored(harness), before, "a keystroke must not save synchronously");
    assert.equal(harness.el("start").disabled, true, "the previous preview is unavailable during validation");

    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(harness.el("flowError").hidden, true);
    assert.equal(harness.el("flowPlannedSends").textContent, "1");
    assert.deepEqual(stored(harness), before, "local validation must leave persisted editor state untouched");
    assert.equal(harness.messages.some((message) => message.payload?.type === "AIPM_START"), false);
  } finally {
    harness.restoreGlobals();
  }
});

test("28-32. the restored editor state and every persisted field still round-trip", async () => {
  const harness = await panel();
  try {
    /* 28-31: the seed reached the controls through the new read path. */
    assert.equal(harness.el("quickPrompt").value, "SEEDED");
    assert.equal(harness.el("flowText").value, "flow seed { }");
    assert.equal(harness.el("workflowName").value, "seed");
    assert.equal(harness.el("readinessRecovery").value, "normal");
    assert.equal(harness.el("keepAwake").checked, false);

    harness.el("quickPrompt").value = "EDITED";
    harness.el("quickRepeat").value = "5";
    harness.el("quickDelay").value = "2.5";
    harness.el("flowText").value = "flow edited { }";
    await harness.input("flowText");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await triggerSave(harness);

    const after = stored(harness);
    assert.equal(after.quick.prompt, "EDITED");
    assert.equal(after.quick.repeat, "5");
    assert.equal(after.quick.delay, "2.5");
    assert.equal(after.flow.text, "flow edited { }");
    assert.equal(after.keepAwake, true, "32: keep-awake still persists per tab");
    assert.ok(after.recovery && typeof after.recovery === "object", "31: recovery still persists per tab");
    assert.ok(after.workflow && typeof after.workflow === "object", "30: workflow still persists per tab");
    assert.equal(after.mode, "quick");
  } finally {
    harness.restoreGlobals();
  }
});

test("a sibling tab's entry is never collateral damage of this tab's save", async () => {
  const harness = await panel();
  try {
    await triggerSave(harness);
    const other = stored(harness, OTHER_TAB);
    assert.equal(other.editorRevision, 40);
    assert.equal(other.quick.prompt, "OTHER");
  } finally {
    harness.restoreGlobals();
  }
});

/* ------------------------------------------------------------ static shape */

test("the panel no longer writes the map itself and adds no Run authority", () => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  /* The unfenced read-modify-write is gone. */
  assert.equal(code.includes("map[String(targetTabId)] = snapshot"), false);
  assert.equal(/chrome\.storage\.local\.set\(\{\s*\[UI_STATE_MAP_KEY\]/.test(code), false);
  assert.match(code, /mutateUiStateForTab\(targetTabId, \(\) => \{[\s\S]*?return snapshot;\s*\}, \{ expectedRevision \}\)/);
  assert.match(code, /readUiStateForTab\(tabId\)/);
  /* The editor fence is not the Run fence. The panel still handles the Run's
     stateRevision elsewhere; what matters is that the editor path does not. */
  const editorPath = code.slice(code.indexOf("function saveUiState"), code.indexOf("function workflowFromUi"));
  assert.ok(editorPath.length > 200);
  for (const authority of ["stateRevision", "runId", "lease", "outbox", "executionSession", "AIPM_"]) {
    assert.equal(editorPath.includes(authority), false, `the editor path must not touch ${authority}`);
  }
  /* Phase 4A adds no renderer contact and no timer. */
  assert.equal(code.includes("executeScript"), false);
  assert.equal(code.includes("chrome.scripting"), false);
  assert.equal(code.includes("tabs.sendMessage"), false);
  assert.match(code, /chrome\.storage\?\.onChanged\?\.addListener\?\.\(onEditorStateChanged\)/);
});

test("selected tab semantics stay exact while Phase 4D Start fresh-reads saved editor state", () => {
  assert.match(source, /SELECTED_TAB_KEY = "aipm\.selectedTab\.v1"/);
  assert.match(source, /chrome\.storage\.local\.set\(\{ \[SELECTED_TAB_KEY\]: nextTabId \}\)/);
  assert.match(source, /type: "AIPM_START"/);
  assert.match(source, /const startSource = await readStartSourceForTab\(intentTabId, \{ expectedEntry \}\)/);
  assert.match(source, /intentTabId,\s*intentEpoch,\s*selectedTabId,\s*targetEpoch/);
  assert.doesNotMatch(source, /editorRevision:\s*startSource/);
});

/* ============================================================================
   Phase 4A follow-up — a target switch must not discard unsaved editor state.

   `saveUiState` deliberately does not reject: an autosave nobody awaited must
   not become an unhandled rejection, and a storage hiccup must not abort a
   Start. But `switchTargetTab` used to await it and ignore the outcome, so a
   refused save still let the panel move to the next tab and apply that tab's
   state over the DOM. The unsaved input was gone and the other surface's
   version was what remained on disk.

   These drive the real switch handler and assert the panel stays put.
   ========================================================================== */

async function switchTo(harness, tabId) {
  harness.el("targetTab").value = String(tabId);
  await harness.change("targetTab");
  for (let turn = 0; turn < 8; turn += 1) await tick();
}

function typeUnsavedWork(harness) {
  harness.el("quickPrompt").value = "MINE";
  harness.el("flowText").value = "flow mine { }";
}

function assertStayedOnSourceTab(harness, context) {
  assert.equal(harness.storage.get("aipm.selectedTab.v1"), TAB, `${context}: the stored selection must not move`);
  assert.equal(harness.el("targetTab").value, String(TAB), `${context}: the control must snap back to the source tab`);
  assert.equal(harness.el("quickPrompt").value, "MINE", `${context}: unsaved input must survive`);
  assert.equal(harness.el("flowText").value, "flow mine { }", `${context}: unsaved Flow text must survive`);
  assert.equal(notice(harness).hidden, false, `${context}: the refusal must be visible`);
}

test("A. a stale source save aborts the target switch and keeps the unsaved input", async () => {
  const harness = await panel();
  try {
    typeUnsavedWork(harness);
    writeFromAnotherSurface(harness, { editorRevision: 9, prompt: "THEIRS" });

    await switchTo(harness, OTHER_TAB);

    assertStayedOnSourceTab(harness, "stale");
    assert.match(notice(harness).text, /別の画面/);

    /* The other surface's entry is untouched: not overwritten, not advanced,
       not merged, not retried. */
    const sourceEntry = stored(harness);
    assert.equal(sourceEntry.quick.prompt, "THEIRS");
    assert.equal(sourceEntry.editorRevision, 9);

    /* Tab B's state was never applied over the editor. */
    assert.notEqual(harness.el("quickPrompt").value, "OTHER");
    assert.equal(stored(harness, OTHER_TAB).editorRevision, 40, "the destination entry is untouched too");
  } finally {
    harness.restoreGlobals();
  }
});

test("B. an unavailable lock aborts the target switch and writes nothing unfenced", async () => {
  const harness = await panel();
  try {
    typeUnsavedWork(harness);
    const before = structuredClone(harness.storage.get(UI_KEY));
    /* The store resolves navigator.locks at call time, so removing the manager
       models a context where the Web Locks API is not usable. */
    globalThis.navigator.locks = { request: "unavailable" };

    await switchTo(harness, OTHER_TAB);

    assertStayedOnSourceTab(harness, "lock");
    assert.match(notice(harness).text, /同時編集/);
    assert.deepEqual(harness.storage.get(UI_KEY), before, "no unfenced write may reach storage");
  } finally {
    harness.restoreGlobals();
  }
});

test("C. a failing storage write aborts the target switch without an unhandled rejection", async () => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  const harness = await panel();
  try {
    typeUnsavedWork(harness);
    const before = structuredClone(harness.storage.get(UI_KEY));
    harness.setStorageMutationHook(async (values) => {
      if (Object.hasOwn(values, UI_KEY)) throw new Error("write failed");
    });

    await switchTo(harness, OTHER_TAB);
    await new Promise((resolve) => setTimeout(resolve, 60));

    assertStayedOnSourceTab(harness, "write failure");
    assert.deepEqual(harness.storage.get(UI_KEY), before, "the failed write must leave storage alone");
    assert.deepEqual(rejections, [], "a failed save must not surface as an unhandled rejection");
  } finally {
    process.off("unhandledRejection", onRejection);
    harness.restoreGlobals();
  }
});

test("D. a healthy source save still completes the target switch", async () => {
  const harness = await panel();
  try {
    harness.el("quickPrompt").value = "SOURCE EDIT";

    await switchTo(harness, OTHER_TAB);

    assert.equal(harness.storage.get("aipm.selectedTab.v1"), OTHER_TAB, "the selection moves");
    assert.equal(stored(harness).quick.prompt, "SOURCE EDIT", "the source tab's edit was persisted");
    assert.equal(stored(harness).editorRevision, 5, "and its revision advanced");
    assert.equal(harness.el("quickPrompt").value, "OTHER", "the destination state was applied");
    assert.equal(notice(harness).hidden, true, "a healthy switch shows no warning");

    /* The panel is fully operational on the new tab: its revision is tracked,
       so a save there succeeds rather than being refused as unfenced. */
    await triggerSave(harness);
    assert.equal(stored(harness, OTHER_TAB).editorRevision, 41);
  } finally {
    harness.restoreGlobals();
  }
});

test("D2. after an abort the panel stays put and recovers nothing on its own", async () => {
  const harness = await panel();
  try {
    typeUnsavedWork(harness);
    writeFromAnotherSurface(harness, { editorRevision: 9, prompt: "THEIRS" });
    await switchTo(harness, OTHER_TAB);
    assertStayedOnSourceTab(harness, "abort");

    /* A further save is still refused, and re-selecting the tab the panel is
       already on is a no-op: nothing re-reads, nothing merges, nothing retries
       and the warning does not quietly clear itself. The user's own text is
       still in front of them, which is the whole point. */
    await switchTo(harness, TAB);
    await triggerSave(harness);
    assert.equal(stored(harness).editorRevision, 9, "no silent recovery");
    assert.equal(stored(harness).quick.prompt, "THEIRS", "and no silent overwrite");
    assert.equal(harness.el("quickPrompt").value, "MINE", "the unsaved input is still on screen");
    assert.equal(notice(harness).hidden, false, "the warning stands until the user acts");
  } finally {
    harness.restoreGlobals();
  }
});

test("Phase 4C H: an external revision observed during the source save aborts target switching", async () => {
  const harness = await panel();
  try {
    typeUnsavedWork(harness);
    let observed = false;
    harness.setStorageMutationHook(async (values) => {
      if (observed || !Object.hasOwn(values, UI_KEY)) return;
      observed = true;
      const external = structuredClone(values[UI_KEY]);
      external[String(TAB)] = seededEntry({ editorRevision: 6, quick: { prompt: "EXTERNAL" } });
      harness.fireStorageChanged({ [UI_KEY]: { newValue: external } }, "local");
    });

    await switchTo(harness, OTHER_TAB);

    assert.equal(observed, true);
    assertStayedOnSourceTab(harness, "post-save conflict");
    assert.equal(stored(harness).editorRevision, 5, "the source CAS may succeed, but its conflict forbids the switch");
    assert.equal(stored(harness, OTHER_TAB).editorRevision, 40);
  } finally {
    harness.restoreGlobals();
  }
});

test("D3. reopening the panel adopts the current revision and saves normally again", async () => {
  /* The documented recovery: the user copies their text out and reopens the
     Side Panel. A fresh panel reads revision 9 and is healthy from there. */
  const harness = await panel(seededEntry({ editorRevision: 9, quick: { preset: "review", prompt: "THEIRS", repeat: "3", delay: "1.5" } }));
  try {
    assert.equal(harness.el("quickPrompt").value, "THEIRS", "the fresh panel shows what is stored");
    await triggerSave(harness);
    assert.equal(stored(harness).editorRevision, 10);
    assert.equal(notice(harness).hidden, true);
  } finally {
    harness.restoreGlobals();
  }
});

test("E. autosave still swallows every failure into a bounded notice", async () => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const staleHarness = await panel();
    writeFromAnotherSurface(staleHarness, { editorRevision: 9 });
    await triggerSave(staleHarness);
    assert.equal(notice(staleHarness).hidden, false);
    staleHarness.restoreGlobals();

    const lockHarness = await panel();
    globalThis.navigator.locks = { request: "unavailable" };
    await triggerSave(lockHarness);
    assert.match(notice(lockHarness).text, /同時編集/);
    lockHarness.restoreGlobals();

    const writeHarness = await panel();
    writeHarness.setStorageMutationHook(async (values) => {
      if (Object.hasOwn(values, UI_KEY)) throw new Error("write failed");
    });
    await triggerSave(writeHarness);
    assert.equal(notice(writeHarness).hidden, false);
    writeHarness.restoreGlobals();

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(rejections, [], "no failure mode may escape as an unhandled rejection");
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("F. Start still builds its workflow snapshot and carries no editor revision", async () => {
  const harness = await panel();
  try {
    await harness.click("start");
    for (let turn = 0; turn < 8; turn += 1) await tick();

    const relayed = harness.messages.filter((message) => message?.payload?.type === "AIPM_START");
    assert.equal(relayed.length, 1, "Start must still dispatch exactly one AIPM_START");
    const payload = relayed[0].payload;
    assert.ok(payload.workflow && Array.isArray(payload.workflow.steps), "the durable workflow snapshot is intact");
    assert.equal(typeof payload.keepAwake, "boolean");
    /* Editor bookkeeping is not Run authority and must not ride along. */
    const serialized = JSON.stringify(payload);
    for (const forbidden of ["editorRevision", "updatedAt", "aipm.uiByTab"]) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} must not reach the Run`);
    }
  } finally {
    harness.restoreGlobals();
  }
});

test("Phase 4D H: a failed Quick editor save blocks Start before any relay", async () => {
  const harness = await panel();
  try {
    harness.setStorageMutationHook(async (values) => {
      if (Object.hasOwn(values, UI_KEY)) throw new Error("write failed");
    });
    await harness.click("start");
    for (let turn = 0; turn < 8; turn += 1) await tick();

    const relayed = harness.messages.filter((message) => message?.payload?.type === "AIPM_START");
    assert.equal(relayed.length, 0, "an unsaved Quick source must never reach the Run path");
    assert.match(harness.el("message").textContent, /保存できなかった|開始しませんでした/);
  } finally {
    harness.restoreGlobals();
  }
});

test("saveUiState reports a bounded outcome and switchTargetTab honours it", () => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /ok: true,[\s\S]*editorRevision: result\.editorRevision,[\s\S]*conflictedAfterSave/);
  assert.match(code, /return \{ ok: false, reason \}/);
  assert.match(code, /return Promise\.resolve\(\{ ok: false, reason: "skipped" \}\)/);
  assert.match(code, /const saved = await saveUiState\(previousTabId, previousState, true\)/);
  assert.match(code, /if \(!saved\?\.ok \|\| saved\?\.stale\) \{/);
  /* Aborting the switch is a UI decision, not a Run decision. */
  const switchBody = code.slice(code.indexOf("function switchTargetTab"), code.indexOf("function runControlSnapshot"));
  assert.ok(switchBody.length > 400);
  for (const authority of ["AIPM_", "stateRevision", "lease", "outbox", "executionSession", "runId"]) {
    assert.equal(switchBody.includes(authority), false, `the switch path must not touch ${authority}`);
  }
});
