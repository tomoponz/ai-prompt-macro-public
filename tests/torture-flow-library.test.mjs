// T10 — Flow Library asynchronous race torture.
//
// The Library is not execution authority, but it decides which source text a later Start
// will compile. Every one of its actions is asynchronous (a cross-panel lock, a durable
// read, a durable write), and the user can keep clicking during all of it. The three
// properties under test are blunt counts:
//
//   wrong-entry overwrite = 0
//   source / metadata mixing = 0
//   stale tab mutation = 0
//
// This drives the real `src/sidepanel.js` handlers through a DOM shim, because the property
// being tested *is* the ordering inside those handlers.
import test from "node:test";
import assert from "node:assert/strict";

import { installSidePanelHarness, tick } from "./helpers/sidepanel-harness.mjs";

const SOURCE_A = 'flow alpha { send """ALPHA""" }';
const SOURCE_B = 'flow beta { send """BETA""" }';
const EDITED_A = 'flow alpha { send """ALPHA EDITED""" }';

async function panelWithTwoEntries() {
  const harness = await installSidePanelHarness();
  await tick();

  harness.el("flowLibraryName").value = "Entry A";
  harness.el("flowLibraryDescription").value = "desc A";
  harness.el("flowText").value = SOURCE_A;
  await harness.click("flowLibrarySaveNew");

  harness.el("flowLibraryName").value = "Entry B";
  harness.el("flowLibraryDescription").value = "desc B";
  harness.el("flowText").value = SOURCE_B;
  await harness.click("flowLibrarySaveNew");

  const entries = harness.library().entries;
  const a = entries.find((entry) => entry.name === "Entry A");
  const b = entries.find((entry) => entry.name === "Entry B");
  assert.ok(a && b, "both entries must exist before the race");
  return { harness, a, b };
}

async function selectEntry(harness, entryId) {
  harness.el("flowLibraryList").value = entryId;
  await harness.change("flowLibraryList");
}

async function openEntry(harness, entryId) {
  await selectEntry(harness, entryId);
  await harness.click("flowLibraryOpen");
}

function assertNoMixing(harness, { a, b }, context) {
  const freshA = harness.libraryEntry(a.id);
  const freshB = harness.libraryEntry(b.id);
  if (freshA) {
    assert.notEqual(freshA.source, SOURCE_B, `${context}: entry A must never hold entry B's source`);
    assert.notEqual(freshA.name, "Entry B", `${context}: entry A must never hold entry B's name`);
  }
  if (freshB) {
    assert.notEqual(freshB.source, EDITED_A, `${context}: entry B must never hold entry A's edited source`);
    assert.notEqual(freshB.source, SOURCE_A, `${context}: entry B must never hold entry A's source`);
    assert.notEqual(freshB.name, "Entry A", `${context}: entry B must never hold entry A's name`);
  }
}

test("T10: Open A -> edit A -> Select B -> delayed Update never overwrites B with A", async () => {
  const { harness, a, b } = await panelWithTwoEntries();
  await openEntry(harness, a.id);
  harness.el("flowText").value = EDITED_A;

  // Update is clicked while A is the selected *and* opened entry, then the cross-panel lock
  // parks the action while the user selects B.
  const gate = harness.lockManager.holdNext();
  const update = harness.click("flowLibraryUpdate");
  await gate.started;
  await selectEntry(harness, b.id);
  gate.release();
  await update;
  await tick();

  assert.equal(harness.libraryEntry(b.id).source, SOURCE_B, "wrong-entry overwrite must be 0");
  assert.equal(harness.libraryEntry(b.id).name, "Entry B");
  assertNoMixing(harness, { a, b }, "delayed Update after selection change");
  assert.match(harness.el("flowLibraryStatus").textContent, /選択|変わ/);
  harness.restoreGlobals();
});

test("T10: Open A -> Select B -> tab switch -> delayed Update mutates nothing", async () => {
  const { harness, a, b } = await panelWithTwoEntries();
  await openEntry(harness, a.id);
  harness.el("flowText").value = EDITED_A;

  const gate = harness.lockManager.holdNext();
  const update = harness.click("flowLibraryUpdate");
  await gate.started;

  // The user switches the target ChatGPT tab while the Library action is parked.
  harness.el("targetTab").value = "2";
  await harness.change("targetTab");
  await tick();

  gate.release();
  await update;
  await tick();

  assert.equal(harness.libraryEntry(a.id).source, SOURCE_A, "stale tab mutation must be 0");
  assert.equal(harness.libraryEntry(b.id).source, SOURCE_B);
  assertNoMixing(harness, { a, b }, "delayed Update after tab switch");
  harness.restoreGlobals();
});

test("T10: a dirty editor requires confirmation before Open replaces it, and Cancel keeps it", async () => {
  const { harness, a, b } = await panelWithTwoEntries();
  await openEntry(harness, a.id);
  harness.el("flowText").value = EDITED_A;

  harness.setConfirmResponder(() => false);
  await selectEntry(harness, b.id);
  await harness.click("flowLibraryOpen");
  await tick();

  assert.equal(harness.confirmations.length, 1, "a dirty editor must ask before being discarded");
  assert.equal(harness.el("flowText").value, EDITED_A, "Cancel must keep the unsaved edit");
  assert.equal(harness.libraryEntry(a.id).source, SOURCE_A, "Cancel must not save anything");
  assert.equal(harness.libraryEntry(b.id).source, SOURCE_B);
  assertNoMixing(harness, { a, b }, "dirty Open cancelled");
  harness.restoreGlobals();
});

test("T10: confirming the dirty-editor prompt opens B exactly, discarding only the editor text", async () => {
  const { harness, a, b } = await panelWithTwoEntries();
  await openEntry(harness, a.id);
  harness.el("flowText").value = EDITED_A;

  harness.setConfirmResponder(() => true);
  await selectEntry(harness, b.id);
  await harness.click("flowLibraryOpen");
  await tick();

  assert.equal(harness.confirmations.length, 1);
  assert.equal(harness.el("flowText").value, SOURCE_B, "Confirm must load exactly the selected entry");
  assert.equal(harness.libraryEntry(a.id).source, SOURCE_A, "the discarded edit must not be written to A");
  assert.equal(harness.libraryEntry(b.id).source, SOURCE_B);
  assertNoMixing(harness, { a, b }, "dirty Open confirmed");
  harness.restoreGlobals();
});

test("T10: Duplicate B while A is opened copies B and leaves the opened entry alone", async () => {
  const { harness, a, b } = await panelWithTwoEntries();
  await openEntry(harness, a.id);
  harness.el("flowText").value = EDITED_A;

  await selectEntry(harness, b.id);
  await harness.click("flowLibraryDuplicate");
  await tick();

  const copies = harness.library().entries.filter((entry) => entry.name.includes("のコピー"));
  assert.equal(copies.length, 1, "exactly one duplicate must be created");
  assert.equal(copies[0].source, SOURCE_B, "the duplicate must carry the selected entry's source");
  assert.equal(harness.libraryEntry(a.id).source, SOURCE_A, "duplicating B must not touch A");
  assert.equal(harness.el("flowText").value, EDITED_A, "duplicating must not replace the editor");
  assertNoMixing(harness, { a, b }, "duplicate B while A opened");
  harness.restoreGlobals();
});

test("T10: Delete B while A is opened removes only B and keeps A openable", async () => {
  const { harness, a, b } = await panelWithTwoEntries();
  await openEntry(harness, a.id);
  harness.el("flowText").value = EDITED_A;

  harness.setConfirmResponder(() => true);
  await selectEntry(harness, b.id);
  await harness.click("flowLibraryDelete");
  await tick();

  assert.equal(harness.libraryEntry(b.id), null, "B must be gone");
  assert.equal(harness.libraryEntry(a.id).source, SOURCE_A, "A must survive untouched");
  assert.equal(harness.el("flowText").value, EDITED_A, "the editor content must be preserved");

  // Deleting the selected entry re-selects the only remaining one, which happens to be the
  // opened entry A. Update must then act on A and nothing else.
  assert.equal(harness.el("flowLibraryList").value, a.id, "the selection must fall back to a real entry");
  assert.equal(harness.el("flowLibraryUpdate").disabled, false, "selected == opened, so Update is available");
  await harness.click("flowLibraryUpdate");
  await tick();
  assert.equal(harness.libraryEntry(a.id).source, EDITED_A, "Update must write the editor into A");
  assert.equal(harness.library().entries.length, 1, "no deleted entry may reappear");
  harness.restoreGlobals();
});

test("T10: deleting the opened entry clears the opened identity so Update cannot resurrect it", async () => {
  const { harness, a, b } = await panelWithTwoEntries();
  await openEntry(harness, a.id);
  harness.el("flowText").value = EDITED_A;

  harness.setConfirmResponder(() => true);
  await selectEntry(harness, a.id);
  await harness.click("flowLibraryDelete");
  await tick();

  assert.equal(harness.libraryEntry(a.id), null, "the opened entry must actually be deleted");
  assert.equal(harness.el("flowText").value, EDITED_A, "the editor keeps its content after a delete");

  // Selecting B and pressing Update must not re-create A, nor write A's text into B.
  await selectEntry(harness, b.id);
  await harness.click("flowLibraryUpdate");
  await tick();

  assert.equal(harness.libraryEntry(a.id), null, "a deleted entry must not be resurrected");
  assert.equal(harness.libraryEntry(b.id).source, SOURCE_B, "wrong-entry overwrite must be 0");
  harness.restoreGlobals();
});

test("T10: a reload restores a still-valid opened entry and drops a missing one", async () => {
  const { harness, a } = await panelWithTwoEntries();
  await openEntry(harness, a.id);
  await tick();

  const storedLibrary = harness.library();
  const storedUi = structuredClone(harness.storage.get("aipm.uiByTab.v2") ?? {});
  const storedSelected = harness.storage.get("aipm.selectedTab.v1");
  harness.restoreGlobals();

  // Reload with the opened entry still present.
  const restored = await installSidePanelHarness({
    storageSeed: {
      "aipm.flowLibrary.v1": storedLibrary,
      "aipm.uiByTab.v2": storedUi,
      "aipm.selectedTab.v1": storedSelected
    }
  });
  await tick();
  assert.equal(restored.el("flowText").value, SOURCE_A, "a valid opened entry survives the reload");
  assert.equal(restored.el("flowLibraryUpdate").disabled, false, "Update stays available for the opened entry");
  restored.restoreGlobals();

  // Reload with the opened entry deleted from the Library behind the panel's back.
  const withoutA = {
    ...storedLibrary,
    entries: storedLibrary.entries.filter((entry) => entry.id !== a.id)
  };
  const orphaned = await installSidePanelHarness({
    storageSeed: {
      "aipm.flowLibrary.v1": withoutA,
      "aipm.uiByTab.v2": storedUi,
      "aipm.selectedTab.v1": storedSelected
    }
  });
  await tick();
  assert.equal(orphaned.libraryEntry(a.id), null, "the opened entry really is gone");
  assert.equal(
    orphaned.el("flowLibraryUpdate").disabled,
    true,
    "a missing opened entry must not leave Update pointing at whatever is selected"
  );
  await orphaned.click("flowLibraryUpdate");
  await tick();
  assert.equal(orphaned.library().entries.length, withoutA.entries.length, "no entry may be created or replaced");
  orphaned.restoreGlobals();
});

test("T10: Import while an entry is opened clears the opened identity and writes nothing", async () => {
  const { harness, a, b } = await panelWithTwoEntries();
  await openEntry(harness, a.id);
  const revisionBefore = harness.library().revision;

  harness.el("flowImportText").value = 'flow imported { send """IMPORTED""" }';
  await harness.click("flowImportPaste");
  await tick();

  assert.equal(harness.el("flowText").value, 'flow imported { send """IMPORTED""" }');
  assert.equal(harness.library().revision, revisionBefore, "Import must not write to the Library");
  assert.equal(harness.libraryEntry(a.id).source, SOURCE_A, "Import must not overwrite the previously opened entry");
  assert.equal(
    harness.el("flowLibraryUpdate").disabled,
    true,
    "after Import nothing is opened, so Update must be unavailable"
  );

  // Pressing Update right after Import must not adopt whatever happens to be selected.
  await selectEntry(harness, b.id);
  await harness.click("flowLibraryUpdate");
  await tick();
  assert.equal(harness.libraryEntry(b.id).source, SOURCE_B, "wrong-entry overwrite must be 0 after Import");
  harness.restoreGlobals();
});

test("T10: rapid search and selection mutation cannot retarget an in-flight Update", async () => {
  const { harness, a, b } = await panelWithTwoEntries();
  await openEntry(harness, a.id);
  harness.el("flowText").value = EDITED_A;
  await selectEntry(harness, a.id);

  const gate = harness.lockManager.holdNext();
  const update = harness.click("flowLibraryUpdate");
  await gate.started;

  // A burst of search/selection churn while the Update is parked.
  for (const query of ["Entry", "Entry B", "", "B", "Entry A", "zzz", ""]) {
    harness.el("flowLibrarySearch").value = query;
    await harness.input("flowLibrarySearch");
  }
  gate.release();
  await update;
  await tick();

  const freshA = harness.libraryEntry(a.id);
  const freshB = harness.libraryEntry(b.id);
  assert.equal(freshB.source, SOURCE_B, "wrong-entry overwrite must be 0 under selection churn");
  assert.equal(freshB.name, "Entry B");
  assert.ok(
    freshA.source === SOURCE_A || freshA.source === EDITED_A,
    "A may be updated or refused, but must never take another entry's content"
  );
  assertNoMixing(harness, { a, b }, "search churn during Update");
  harness.restoreGlobals();
});

test("T10: metadata edited during the await is never mixed into the saved entry", async () => {
  const { harness, a, b } = await panelWithTwoEntries();
  await openEntry(harness, a.id);
  await selectEntry(harness, a.id);
  harness.el("flowText").value = EDITED_A;
  harness.el("flowLibraryName").value = "Entry A renamed";

  const gate = harness.lockManager.holdNext();
  const update = harness.click("flowLibraryUpdate");
  await gate.started;
  // The user keeps typing in the metadata fields while the write is parked.
  harness.el("flowLibraryName").value = "Entry A renamed again";
  harness.el("flowLibraryDescription").value = "changed mid-flight";
  gate.release();
  await update;
  await tick();

  const freshA = harness.libraryEntry(a.id);
  assert.notEqual(
    freshA.name,
    "Entry A renamed again",
    "metadata typed after the click must not be smuggled into the click's write"
  );
  assert.notEqual(freshA.description, "changed mid-flight");
  assert.ok(
    (freshA.name === "Entry A renamed" && freshA.source === EDITED_A) ||
    (freshA.name === "Entry A" && freshA.source === SOURCE_A),
    `source and metadata must come from the same snapshot (saw ${freshA.name} / ${freshA.source})`
  );
  assertNoMixing(harness, { a, b }, "metadata change during await");
  harness.restoreGlobals();
});

test("T10: editor source edited during the await is never mixed into the saved entry", async () => {
  const { harness, a, b } = await panelWithTwoEntries();
  await openEntry(harness, a.id);
  await selectEntry(harness, a.id);
  harness.el("flowText").value = EDITED_A;

  const gate = harness.lockManager.holdNext();
  const update = harness.click("flowLibraryUpdate");
  await gate.started;
  harness.el("flowText").value = 'flow alpha { send """TYPED AFTER THE CLICK""" }';
  gate.release();
  await update;
  await tick();

  const freshA = harness.libraryEntry(a.id);
  assert.notEqual(
    freshA.source,
    'flow alpha { send """TYPED AFTER THE CLICK""" }',
    "text typed after the click must not be saved by that click"
  );
  assert.ok(
    freshA.source === EDITED_A || freshA.source === SOURCE_A,
    `only the click-time snapshot may be written (saw ${freshA.source})`
  );
  assertNoMixing(harness, { a, b }, "editor change during await");
  harness.restoreGlobals();
});

test("T10: concurrent same-surface Library actions admit only one mutation", async () => {
  const { harness, a, b } = await panelWithTwoEntries();
  await openEntry(harness, a.id);
  await selectEntry(harness, a.id);
  harness.el("flowText").value = EDITED_A;
  const revisionBefore = harness.library().revision;

  harness.setConfirmResponder(() => true);
  const update = harness.click("flowLibraryUpdate");
  const duplicate = harness.click("flowLibraryDuplicate");
  await Promise.all([update, duplicate]);
  await tick();

  assert.equal(harness.lockManager.held.maxConcurrent, 1, "Library writes must never interleave");
  const library = harness.library();
  assert.equal(library.revision, revisionBefore + 1, "the second click is coalesced instead of becoming a stale writer");
  const ids = library.entries.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "no duplicate ids may be produced by concurrent actions");
  assert.equal(harness.libraryEntry(b.id).source, SOURCE_B, "an unrelated entry must be untouched");
  assertNoMixing(harness, { a, b }, "concurrent actions");
  harness.restoreGlobals();
});
