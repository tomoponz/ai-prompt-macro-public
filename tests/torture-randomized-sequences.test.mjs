// T12 — deterministic randomized operation sequences.
//
// Every other suite in this harness attacks a boundary someone already thought of. This one
// exists for the boundaries nobody listed. It is deliberately NOT the primary evidence:
// T1-T11 carry the named invariants, and this suite only widens the search around them.
//
// Determinism rules:
//   - the pseudo-random generator is a self-contained mulberry32; there is no dependency
//   - the seed list is fixed, so every run executes byte-identical sequences
//   - every assertion message carries the seed and the exact operation log, so a failure is
//     replayable by pasting the seed into ONLY_SEED below
import test from "node:test";
import assert from "node:assert/strict";

import { CONVERSATION_KEY, clickPositions, createWorkflowHarness } from "./helpers/workflow-harness.mjs";
import { installSidePanelHarness, tick } from "./helpers/sidepanel-harness.mjs";

// Set to a number to replay one failing seed in isolation.
const ONLY_SEED = null;
const RUNTIME_SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233];
const LIBRARY_SEEDS = [7, 11, 17, 23, 29, 31, 37, 41];
const OPERATIONS_PER_SEQUENCE = 14;

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function seedsFor(list) {
  return ONLY_SEED == null ? list : [ONLY_SEED];
}

// ---------------------------------------------------------------------------
// Runtime sequences
// ---------------------------------------------------------------------------

const RUNTIME_OPERATIONS = [
  "START",
  "PAUSE",
  "RESUME",
  "STOP",
  "RELOAD",
  "DOCUMENT_CHANGE",
  "IDENTITY_UNAVAILABLE",
  "LEASE_FAIL",
  "DIAGNOSTIC_FAIL",
  "WAIT_BOUNDARY"
];

const MAX_SENDS = 3;
const DIAGNOSTICS_KEY = "aipm.diagnostics.v1";

function fuzzWorkflow() {
  return {
    schemaVersion: 1,
    id: "fuzz",
    name: "Fuzz",
    maxSends: MAX_SENDS,
    steps: [{ id: "fuzz-send", type: "prompt", delivery: "send", prompt: "FUZZ", repeat: MAX_SENDS, delayAfterMs: 0 }]
  };
}

const IDENTITY_MISMATCH = {
  ok: false,
  errorCode: "DOCUMENT_IDENTITY_MISMATCH",
  error: "現在のdocumentと要求元が一致しないため操作を拒否しました。"
};
const IDENTITY_UNCONFIRMED = {
  ok: false,
  errorCode: "DOCUMENT_IDENTITY_UNCONFIRMED",
  error: "現在のdocumentを再確認できないため操作を拒否しました。"
};

function touchesDiagnostics(key) {
  if (typeof key === "string") return key === DIAGNOSTICS_KEY;
  if (Array.isArray(key)) return key.includes(DIAGNOSTICS_KEY);
  if (key && typeof key === "object") return Object.hasOwn(key, DIAGNOSTICS_KEY);
  return false;
}

function createRuntimeSequenceHarness() {
  // Faults are counted down so a transient failure really is transient: the sequence must
  // be able to recover, which is what makes a later duplicate send observable.
  const faults = { mismatch: 0, unconfirmed: 0, leaseRenew: 0, diagnostics: 0 };
  const failDiagnostics = ({ key, entries }) => {
    if (faults.diagnostics <= 0 || !touchesDiagnostics(key ?? entries)) return;
    faults.diagnostics -= 1;
    throw new Error("diagnostic storage is unavailable");
  };
  const identityFault = () => {
    if (faults.mismatch > 0) {
      faults.mismatch -= 1;
      return IDENTITY_MISMATCH;
    }
    if (faults.unconfirmed > 0) {
      faults.unconfirmed -= 1;
      return IDENTITY_UNCONFIRMED;
    }
    return null;
  };

  const harness = createWorkflowHarness({
    onRunGet: () => identityFault(),
    onRunSet: () => identityFault(),
    onLease: ({ operation }) => {
      const identity = identityFault();
      if (identity) return identity;
      if (operation === "renew" && faults.leaseRenew > 0) {
        faults.leaseRenew -= 1;
        return { ok: true, renewed: false };
      }
      return null;
    },
    onStorageGet: failDiagnostics,
    onStorageSet: failDiagnostics
  });

  // The harness turns `sleep` into a pure clock advance, which starves real timers. Yielding
  // one check-phase tick per sleep keeps the watchdog below able to fire.
  const advance = harness.context.sleep;
  harness.context.sleep = async (ms) => {
    await advance(ms);
    await new Promise((resolve) => setImmediate(resolve));
  };

  return { harness, faults };
}

async function settleBounded(harness, label) {
  let timer;
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: the runner did not settle within 10s`)), 10_000);
  });
  try {
    await Promise.race([harness.settle(), watchdog]);
  } catch (error) {
    // Break any surviving loop so the process can exit, then surface the failure.
    harness.context.localRunnerToken += 1;
    await harness.settle();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function applyRuntimeOperation(operation, { harness, faults, random }) {
  switch (operation) {
    case "START":
      return harness.start(fuzzWorkflow());
    case "PAUSE":
      return harness.control("AIPM_PAUSE");
    case "RESUME":
      return harness.control("AIPM_RESUME");
    case "STOP":
      return harness.control("AIPM_STOP");
    case "RELOAD":
      return harness.reload(Math.floor(random() * 5_000));
    case "DOCUMENT_CHANGE":
      faults.mismatch = 1 + Math.floor(random() * 2);
      return null;
    case "IDENTITY_UNAVAILABLE":
      faults.unconfirmed = 1 + Math.floor(random() * 3);
      return null;
    case "LEASE_FAIL":
      faults.leaseRenew = 1 + Math.floor(random() * 2);
      return null;
    case "DIAGNOSTIC_FAIL":
      faults.diagnostics = 1 + Math.floor(random() * 4);
      return null;
    case "WAIT_BOUNDARY":
      harness.advance(Math.floor(random() * 30_000));
      return null;
    default:
      throw new Error(`unknown operation ${operation}`);
  }
}

function assertRuntimeInvariants(harness, context) {
  // A replacement Run legitimately starts again at position 0:0, so both the
  // no-duplicate-position and the send-budget invariants are per Run generation.
  const byRun = new Map();
  for (const entry of harness.clicks()) {
    if (!byRun.has(entry.runId)) byRun.set(entry.runId, []);
    byRun.get(entry.runId).push(entry.position);
  }
  for (const [runId, positions] of byRun) {
    assert.equal(
      new Set(positions).size,
      positions.length,
      `${context}: Run ${runId} clicked a logical send position more than once (${positions.join(", ")})`
    );
    assert.ok(
      positions.length <= MAX_SENDS,
      `${context}: Run ${runId} made ${positions.length} clicks, exceeding the planned ${MAX_SENDS}`
    );
  }
  void clickPositions;

  const stored = harness.stored();
  if (!stored) return;
  assert.ok(
    ["running", "paused", "stopped", "completed"].includes(stored.status),
    `${context}: unexpected Run status ${stored.status}`
  );
  const sends = Number(stored.cursor?.sendsCompleted ?? 0);
  assert.ok(
    Number.isFinite(sends) && sends >= 0 && sends <= MAX_SENDS,
    `${context}: sendsCompleted ${stored.cursor?.sendsCompleted} is outside the plan`
  );
  const clicksForStoredRun = (byRun.get(stored.runId) ?? []).length;
  assert.ok(
    sends <= clicksForStoredRun + (stored.outbox?.state === "confirmed" ? 1 : 0),
    `${context}: ${sends} sends were counted but Run ${stored.runId} only clicked ${clicksForStoredRun} times`
  );
  // An unfinished delivery past the provably-unclicked checkpoint may never be offered for
  // automatic resumption.
  if (stored.outbox && !(stored.phase === "prepared" && stored.outbox.state === "prepared")) {
    assert.equal(
      stored.resumable,
      false,
      `${context}: an unresolved delivery (${stored.phase}/${stored.outbox.state}) was marked auto-resumable`
    );
  }
  if (stored.status === "completed") {
    assert.equal(stored.outbox, null, `${context}: a completed Run must not keep an unfinished outbox`);
  }
}

for (const seed of seedsFor(RUNTIME_SEEDS)) {
  test(`T12: runtime operation sequence stays safe for seed ${seed}`, async () => {
    const random = mulberry32(seed);
    const { harness, faults } = createRuntimeSequenceHarness();
    await harness.ready();
    const log = [];
    // runId -> number of clicks recorded at the moment that Run became durably stopped.
    const stoppedRuns = new Map();

    for (let step = 0; step < OPERATIONS_PER_SEQUENCE; step += 1) {
      const operation = RUNTIME_OPERATIONS[Math.floor(random() * RUNTIME_OPERATIONS.length)];
      // An operation that fails closed is a legitimate outcome of an injected fault - for
      // example recovery refusing to adopt a Run while document identity is unproven. What
      // must never happen is an invariant breaking, so the outcome is recorded and the
      // sequence continues.
      let outcome = "ok";
      try {
        const response = await applyRuntimeOperation(operation, { harness, faults, random });
        if (response && response.ok === false) outcome = "refused";
      } catch (error) {
        outcome = `threw:${error?.code ?? error?.message ?? "unknown"}`;
      }
      log.push(`${operation}:${outcome}`);
      const context = `seed=${seed} step=${step + 1}/${OPERATIONS_PER_SEQUENCE} ops=[${log.join(",")}]`;
      await settleBounded(harness, context);
      assertRuntimeInvariants(harness, context);

      // Stop is monotonic: once a Run is durably stopped, that exact Run may never click
      // again, no matter what a later replacement Run does.
      const stored = harness.stored();
      if (stored?.status === "stopped") stoppedRuns.set(stored.runId, harness.clicks().length);
      for (const [runId, clicksAtStop] of stoppedRuns) {
        const nowClicks = harness.clicks().filter((entry) => entry.runId === runId).length;
        assert.ok(
          nowClicks <= clicksAtStop,
          `${context}: stopped Run ${runId} sent again after its terminal state`
        );
      }
    }

    // Clear every injected fault and let the sequence come to rest; the same invariants must
    // still hold once the transient failures are over.
    faults.mismatch = 0;
    faults.unconfirmed = 0;
    faults.leaseRenew = 0;
    faults.diagnostics = 0;
    harness.setConversationKey(CONVERSATION_KEY);
    await settleBounded(harness, `seed=${seed} final settle ops=[${log.join(",")}]`);
    assertRuntimeInvariants(harness, `seed=${seed} final ops=[${log.join(",")}]`);
  });
}

// ---------------------------------------------------------------------------
// Flow Library sequences
// ---------------------------------------------------------------------------

const LIBRARY_OPERATIONS = [
  "LIBRARY_SELECT",
  "LIBRARY_OPEN",
  "LIBRARY_UPDATE",
  "LIBRARY_DUPLICATE",
  "LIBRARY_DELETE",
  "LIBRARY_SEARCH",
  "LIBRARY_IMPORT",
  "EDITOR_TYPE",
  "TAB_SWITCH"
];

const ENTRY_COUNT = 3;
const entrySource = (tag) => `flow f${tag} { send """SOURCE-${tag}""" }`;

function sourceMap(harness) {
  return new Map((harness.library()?.entries ?? []).map((entry) => [entry.id, entry.source]));
}

async function seedLibrary(harness) {
  const ids = [];
  for (let index = 0; index < ENTRY_COUNT; index += 1) {
    harness.el("flowLibraryName").value = `Entry ${index}`;
    harness.el("flowLibraryDescription").value = `desc ${index}`;
    harness.el("flowText").value = entrySource(index);
    await harness.click("flowLibrarySaveNew");
    ids.push(harness.library().entries[0].id);
  }
  return ids;
}

for (const seed of seedsFor(LIBRARY_SEEDS)) {
  test(`T12: Flow Library operation sequence stays consistent for seed ${seed}`, async () => {
    const random = mulberry32(seed);
    const harness = await installSidePanelHarness();
    await tick();
    const originalIds = await seedLibrary(harness);
    harness.setConfirmResponder(() => random() < 0.5);
    const log = [];

    try {
      for (let step = 0; step < OPERATIONS_PER_SEQUENCE; step += 1) {
        const operation = LIBRARY_OPERATIONS[Math.floor(random() * LIBRARY_OPERATIONS.length)];
        log.push(operation);
        const context = `seed=${seed} step=${step + 1}/${OPERATIONS_PER_SEQUENCE} ops=[${log.join(",")}]`;

        const before = sourceMap(harness);
        const listed = harness.listedIds();
        const selectedBefore = harness.el("flowLibraryList").value;
        const editorBefore = harness.el("flowText").value;
        const updateEnabledBefore = harness.el("flowLibraryUpdate").disabled === false;

        switch (operation) {
          case "LIBRARY_SELECT": {
            if (listed.length > 0) {
              harness.el("flowLibraryList").value = listed[Math.floor(random() * listed.length)];
              await harness.change("flowLibraryList");
            }
            break;
          }
          case "LIBRARY_OPEN":
            await harness.click("flowLibraryOpen");
            break;
          case "LIBRARY_UPDATE":
            await harness.click("flowLibraryUpdate");
            break;
          case "LIBRARY_DUPLICATE":
            await harness.click("flowLibraryDuplicate");
            break;
          case "LIBRARY_DELETE":
            await harness.click("flowLibraryDelete");
            break;
          case "LIBRARY_SEARCH":
            harness.el("flowLibrarySearch").value = ["", "Entry", "Entry 1", "コピー", "zzz"][Math.floor(random() * 5)];
            await harness.input("flowLibrarySearch");
            break;
          case "LIBRARY_IMPORT":
            harness.el("flowImportText").value = entrySource(`imported-${step}`);
            await harness.click("flowImportPaste");
            break;
          case "EDITOR_TYPE":
            harness.el("flowText").value = entrySource(`typed-${step}`);
            break;
          case "TAB_SWITCH":
            harness.el("targetTab").value = String(1 + Math.floor(random() * 2));
            await harness.change("targetTab");
            break;
          default:
            throw new Error(`unknown operation ${operation}`);
        }
        await tick();

        const after = sourceMap(harness);
        const ids = [...after.keys()];
        assert.equal(new Set(ids).size, ids.length, `${context}: duplicate Library entry ids`);

        const changed = [...after.entries()].filter(([id, source]) => before.has(id) && before.get(id) !== source);
        if (operation === "LIBRARY_UPDATE") {
          assert.ok(changed.length <= 1, `${context}: Update changed ${changed.length} entries`);
          if (changed.length === 1) {
            const [changedId, changedSource] = changed[0];
            assert.equal(updateEnabledBefore, true, `${context}: Update wrote while it was not enabled`);
            assert.equal(changedId, selectedBefore, `${context}: Update wrote to a non-selected entry`);
            assert.equal(changedSource, editorBefore, `${context}: Update wrote something other than the editor`);
          }
        } else {
          assert.equal(
            changed.length,
            0,
            `${context}: ${operation} changed the source of ${changed.map(([id]) => id).join(", ")}`
          );
        }

        // No surviving original entry may ever hold a different original's source.
        for (const [id, source] of after) {
          const originalIndex = originalIds.indexOf(id);
          if (originalIndex < 0) continue;
          for (let other = 0; other < ENTRY_COUNT; other += 1) {
            if (other === originalIndex) continue;
            assert.notEqual(
              source,
              entrySource(other),
              `${context}: entry ${id} holds entry ${other}'s source`
            );
          }
        }
      }

      assert.equal(harness.lockManager.held.maxConcurrent, 1, `seed=${seed}: Library writes interleaved`);
    } finally {
      harness.restoreGlobals();
    }
  });
}

test("T12: the generator is deterministic, so a reported seed really is replayable", () => {
  const first = Array.from({ length: 8 }, mulberry32(42));
  const second = Array.from({ length: 8 }, mulberry32(42));
  assert.deepEqual(first, second, "the same seed must produce the same sequence");
  assert.notDeepEqual(first, Array.from({ length: 8 }, mulberry32(43)), "different seeds must differ");
  for (const value of first) {
    assert.ok(value >= 0 && value < 1, "values must stay in [0, 1)");
  }
});
