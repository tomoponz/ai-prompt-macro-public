// T11 — malformed recovered durable state.
//
// Recovery restores a durable Run straight into the runtime. It does NOT pass through the
// Side Panel normalizer, so every clamp and default that protects freshly authored input is
// absent. Issue #22 (non-finite maxSends bypassing the 50-send cap) and Issue #28 (a
// malformed `graceMs` turning fail-closed into run-late) were both exactly this shape.
//
// The invariant under test: malformed durable state must never increase execution
// authority. Each corruption is written straight into durable storage - never through a
// runner write - and then recovered.
import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTENT_VERSION,
  CONVERSATION_KEY,
  SESSION_ID,
  TAB_ID,
  createWorkflowHarness
} from "./helpers/workflow-harness.mjs";
import {
  DEFAULT_SESSION_ID,
  installBackgroundHarness,
  makeRun
} from "./helpers/background-harness.mjs";

const MAX_SENDS_PER_RUN = 50;
const CLOCK_START = 1_700_000_000_000;

function baseWorkflow() {
  return {
    schemaVersion: 1,
    id: "malformed",
    name: "Malformed",
    maxSends: 2,
    steps: [{ id: "send", type: "prompt", delivery: "send", prompt: "P", repeat: 2, delayAfterMs: 0 }]
  };
}

function durableRun(instanceId) {
  return {
    schemaVersion: 1,
    runId: "durable-malformed",
    provider: "chatgpt",
    contentVersion: CONTENT_VERSION,
    executionSessionId: SESSION_ID,
    conversationKey: CONVERSATION_KEY,
    documentInstanceId: instanceId,
    boundDocumentId: null,
    boundTabId: TAB_ID,
    replacesRunId: null,
    keepAwake: false,
    workflow: baseWorkflow(),
    plannedSends: 2,
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 },
    status: "running",
    phase: "ready",
    pauseRequested: false,
    pauseRequestedAt: null,
    pauseRequestBaseRevision: null,
    pauseRequestRevision: null,
    pauseReason: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    resumable: true,
    outbox: null,
    waitState: null,
    stateRevision: 3,
    startedAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z"
  };
}

const staleWaitStep = (overrides) => ({
  id: "wait",
  type: "wait-until",
  at: new Date(CLOCK_START - 3_600_000).toISOString(),
  latePolicy: "pause",
  graceMs: 1_000,
  ...overrides
});

const waitThenSend = (overrides) => (run) => {
  run.workflow.steps = [
    staleWaitStep(overrides),
    { id: "send", type: "prompt", delivery: "send", prompt: "P", repeat: 1, delayAfterMs: 0 }
  ];
  run.workflow.maxSends = 1;
};

// `expect: "fail-closed"` requires zero sends plus a bounded, non-auto-resumable state.
// `expect: "inert"` means the corruption cannot grant authority and the Run simply executes
// its own (still bounded) plan.
const CORRUPTIONS = [
  // --- send budget authority ------------------------------------------------
  ["maxSends NaN", (r) => { r.workflow.maxSends = Number.NaN; }, "fail-closed", "send_budget_invalid"],
  ["maxSends string", (r) => { r.workflow.maxSends = "many"; }, "fail-closed", "send_budget_invalid"],
  ["maxSends negative", (r) => { r.workflow.maxSends = -1; }, "fail-closed", "send_budget_invalid"],
  ["maxSends fraction", (r) => { r.workflow.maxSends = 1.5; }, "fail-closed", "send_budget_invalid"],
  ["maxSends missing", (r) => { delete r.workflow.maxSends; }, "fail-closed", "send_budget_invalid"],
  ["maxSends beyond the hard cap", (r) => { r.workflow.maxSends = 9999; }, "fail-closed", "send_budget_invalid"],
  ["maxSends Infinity", (r) => { r.workflow.maxSends = Infinity; }, "fail-closed", "send_budget_invalid"],
  ["repeat beyond the hard cap", (r) => { r.workflow.steps[0].repeat = 9999; }, "fail-closed", "send_budget_invalid"],
  ["repeat NaN", (r) => { r.workflow.steps[0].repeat = Number.NaN; }, "fail-closed", "send_budget_invalid"],
  ["repeat zero", (r) => { r.workflow.steps[0].repeat = 0; }, "fail-closed", "send_budget_invalid"],
  ["repeat fraction", (r) => { r.workflow.steps[0].repeat = 2.5; }, "fail-closed", "send_budget_invalid"],
  [
    "repeat one past the hard cap",
    (r) => { r.workflow.steps[0].repeat = MAX_SENDS_PER_RUN + 1; r.workflow.maxSends = MAX_SENDS_PER_RUN + 1; },
    "fail-closed",
    "send_budget_invalid"
  ],
  ["sendsCompleted NaN", (r) => { r.cursor.sendsCompleted = Number.NaN; }, "fail-closed", "send_budget_invalid"],
  ["sendsCompleted negative", (r) => { r.cursor.sendsCompleted = -5; }, "fail-closed", "send_budget_invalid"],
  ["sendsCompleted fraction", (r) => { r.cursor.sendsCompleted = 0.5; }, "fail-closed", "send_budget_invalid"],
  ["sendsCompleted missing", (r) => { delete r.cursor.sendsCompleted; }, "fail-closed", "send_budget_invalid"],
  ["repeatIndex NaN", (r) => { r.cursor.repeatIndex = Number.NaN; }, "fail-closed", "send_budget_invalid"],
  ["repeatIndex negative", (r) => { r.cursor.repeatIndex = -1; }, "fail-closed", "send_budget_invalid"],
  ["repeatIndex past the step repeat", (r) => { r.cursor.repeatIndex = 9; }, "fail-closed", "send_budget_invalid"],

  // --- workflow authority ---------------------------------------------------
  ["steps not an array", (r) => { r.workflow.steps = "nope"; }, "fail-closed", "workflow_invalid"],
  ["steps empty", (r) => { r.workflow.steps = []; }, "fail-closed", "workflow_invalid"],
  [
    "steps beyond the block ceiling",
    (r) => { r.workflow.steps = Array.from({ length: 41 }, (_, i) => ({ id: `s${i}`, type: "delay", durationMs: 1 })); },
    "fail-closed",
    "workflow_invalid"
  ],
  [
    "duplicated step identity",
    (r) => {
      r.workflow.steps = [
        { id: "dup", type: "delay", durationMs: 1 },
        { id: "dup", type: "prompt", delivery: "send", prompt: "P", repeat: 1, delayAfterMs: 0 }
      ];
      r.workflow.maxSends = 1;
    },
    "fail-closed",
    "workflow_invalid"
  ],
  ["unknown step type", (r) => { r.workflow.steps[0].type = "exfiltrate"; }, "fail-closed", "workflow_invalid"],
  ["unknown delivery", (r) => { r.workflow.steps[0].delivery = "broadcast"; }, "fail-closed", "workflow_invalid"],
  ["blank prompt", (r) => { r.workflow.steps[0].prompt = "   "; }, "fail-closed", "workflow_invalid"],
  ["non-string prompt", (r) => { r.workflow.steps[0].prompt = { toString: () => "P" }; }, "fail-closed", "workflow_invalid"],
  ["delayAfterMs NaN", (r) => { r.workflow.steps[0].delayAfterMs = Number.NaN; }, "fail-closed", "workflow_invalid"],
  ["delayAfterMs negative", (r) => { r.workflow.steps[0].delayAfterMs = -1; }, "fail-closed", "workflow_invalid"],
  ["delayAfterMs beyond the ceiling", (r) => { r.workflow.steps[0].delayAfterMs = 10 * 60 * 1000; }, "fail-closed", "workflow_invalid"],

  // --- schedule authority (Issue #28) ---------------------------------------
  ["wait-until graceMs string", waitThenSend({ graceMs: "not-a-number" }), "fail-closed", "workflow_invalid"],
  ["wait-until graceMs NaN", waitThenSend({ graceMs: Number.NaN }), "fail-closed", "workflow_invalid"],
  ["wait-until graceMs negative", waitThenSend({ graceMs: -1 }), "fail-closed", "workflow_invalid"],
  ["wait-until graceMs beyond the ceiling", waitThenSend({ graceMs: 25 * 60 * 60 * 1000 }), "fail-closed", "workflow_invalid"],

  // --- outbox authority -----------------------------------------------------
  ["outbox in an unknown state", (r) => { r.outbox = { id: "x", state: "teleported" }; }, "fail-closed", "recovery_ambiguous"],
  ["outbox not an object", (r) => { r.outbox = "confirmed"; }, "fail-closed", "recovery_ambiguous"],

  // --- values that cannot grant authority -----------------------------------
  ["waitState of an unknown kind", (r) => { r.waitState = { kind: "teleport", until: 1 }; }, "inert"],
  [
    "waitState until NaN",
    (r) => { r.waitState = { kind: "delay", scope: "after-send", stepId: "send", stepIndex: 0, repeatIndex: 0, until: Number.NaN }; },
    "inert"
  ],
  [
    "waitState until beyond any real deadline",
    (r) => { r.waitState = { kind: "delay", scope: "after-send", stepId: "send", stepIndex: 0, repeatIndex: 0, until: 1e18 }; },
    "inert"
  ],
  [
    "waitState pinned to another position",
    (r) => { r.waitState = { kind: "delay", scope: "after-send", stepId: "send", stepIndex: 7, repeatIndex: 3, until: 1e15 }; },
    "inert"
  ],
  ["stateRevision rewound", (r) => { r.stateRevision = 0; }, "inert"],
  ["stateRevision NaN", (r) => { r.stateRevision = Number.NaN; }, "inert"],
  ["plannedSends inflated", (r) => { r.plannedSends = 9999; }, "inert"],
  ["recovery policy garbage", (r) => { r.workflow.recovery = { mode: "yolo", identityAttempts: 9999 }; }, "inert"]
];

async function recoverCorrupted(corrupt) {
  const harness = createWorkflowHarness();
  await harness.ready();
  const seeded = durableRun(harness.context.instanceId);
  corrupt(seeded);
  harness.injectDurableRun(() => seeded);
  await harness.reload(1_000);
  return harness;
}

test("T11: malformed durable state never authorizes a send beyond the plan it can prove", async () => {
  for (const [name, corrupt, expect, code] of CORRUPTIONS) {
    const harness = await recoverCorrupted(corrupt);
    const stored = harness.stored();
    const context = `recovered durable state / ${name}`;

    assert.ok(
      harness.page.clicks <= MAX_SENDS_PER_RUN,
      `${context}: ${harness.page.clicks} clicks exceeded the absolute hard cap`
    );

    if (expect === "fail-closed") {
      assert.equal(harness.page.clicks, 0, `${context}: an unprovable plan must send nothing`);
      assert.equal(stored.status, "paused", `${context}: it must fail closed`);
      assert.equal(stored.lastErrorCode, code, `${context}: it must fail with a bounded, enumerated code`);
      assert.equal(stored.resumable, false, `${context}: it must not be auto-resumable`);
    } else {
      // The corruption is in a field that carries no execution authority, so the Run simply
      // executes the plan it could always prove - never more.
      assert.ok(harness.page.clicks <= 2, `${context}: an inert corruption must not add sends`);
      assert.ok(
        stored.cursor.sendsCompleted <= 2,
        `${context}: sendsCompleted ${stored.cursor.sendsCompleted} exceeded the provable plan`
      );
    }
  }
});

test("T11: a forged outbox can only ever reduce the sends that actually happen", async () => {
  // A confirmed claim that is not cryptographically and positionally bound to the current
  // durable cursor cannot prove delivery. It must neither click nor advance the cursor.
  const forgedConfirmed = await recoverCorrupted((run) => { run.outbox = { id: "x", state: "confirmed" }; });
  assert.equal(forgedConfirmed.page.clicks, 0, "an unbound confirmation must not click");
  assert.equal(forgedConfirmed.stored().cursor.sendsCompleted, 0, "an unbound confirmation must not advance");
  assert.equal(forgedConfirmed.stored().status, "paused");
  assert.equal(forgedConfirmed.stored().lastErrorCode, "recovery_ambiguous");
  assert.equal(forgedConfirmed.stored().resumable, false);

  // `prepared/prepared` is the one snapshot that proves the click never happened, so it may
  // be discarded and the identical position retried - exactly once.
  const forgedPrepared = await recoverCorrupted((run) => {
    run.outbox = { id: "x", state: "prepared" };
    run.phase = "prepared";
  });
  assert.equal(forgedPrepared.page.clicks, 2, "a provably unclicked preparation retries its own position");
  const positions = forgedPrepared.clicks().map((entry) => entry.position);
  assert.equal(new Set(positions).size, positions.length, "no position may be clicked twice");
});

test("T11: the absolute 50-send ceiling still holds for a durable plan that claims the maximum", async () => {
  // A corrupted durable workflow may legitimately describe up to MAX_SENDS_PER_RUN sends -
  // that is the documented ceiling, and it must be enforced exactly, not approximately.
  const atCap = await recoverCorrupted((run) => {
    run.workflow.steps[0].repeat = MAX_SENDS_PER_RUN;
    run.workflow.maxSends = MAX_SENDS_PER_RUN;
  });
  assert.equal(atCap.page.clicks, MAX_SENDS_PER_RUN, "a plan at the ceiling runs to the ceiling");
  assert.equal(atCap.stored().cursor.sendsCompleted, MAX_SENDS_PER_RUN);
  const positions = atCap.clicks().map((entry) => entry.position);
  assert.equal(new Set(positions).size, MAX_SENDS_PER_RUN, "each position must be clicked exactly once");

  const pastCap = await recoverCorrupted((run) => {
    run.workflow.steps[0].repeat = MAX_SENDS_PER_RUN + 1;
    run.workflow.maxSends = MAX_SENDS_PER_RUN + 1;
  });
  assert.equal(pastCap.page.clicks, 0, "one past the ceiling must send nothing at all");
  assert.equal(pastCap.stored().lastErrorCode, "send_budget_invalid");
});

test("T11: an uninterpretable cursor fails closed instead of being reported completed", async () => {
  for (const [name, corrupt] of [
    ["stepIndex NaN", (r) => { r.cursor.stepIndex = Number.NaN; }],
    ["stepIndex negative", (r) => { r.cursor.stepIndex = -1; }],
    ["stepIndex fraction", (r) => { r.cursor.stepIndex = 0.5; }],
    ["stepIndex past the last step", (r) => { r.cursor.stepIndex = 9; }]
  ]) {
    const harness = await recoverCorrupted(corrupt);
    assert.equal(harness.page.clicks, 0, `${name}: an uninterpretable cursor must send nothing`);
    assert.equal(harness.stored().cursor.sendsCompleted, 0, `${name}: nothing may be counted as sent`);
    assert.equal(harness.stored().status, "paused", `${name}: it must fail closed`);
    assert.equal(harness.stored().resumable, false, `${name}: a corrupted cursor is not resumable`);
    assert.equal(harness.stored().lastErrorCode, "send_budget_invalid", `${name}: bounded reason code`);
  }

  for (const [name, corrupt] of [
    ["cursor object missing", (r) => { delete r.cursor; }],
    ["wait-until at unparseable", waitThenSend({ at: "yesterday" })],
    ["wait-until latePolicy unknown", waitThenSend({ latePolicy: "always-run" })]
  ]) {
    const harness = await recoverCorrupted(corrupt);
    assert.equal(harness.page.clicks, 0, `${name}: an uninterpretable Run must send nothing`);
    assert.equal(harness.stored().status, "paused", `${name}: it must stop`);
    assert.equal(harness.stored().resumable, false, `${name}: structurally invalid state is not resumable`);
    const resumed = await harness.control("AIPM_RESUME");
    await harness.settle();
    assert.equal(resumed.ok, false, `${name}: generic Resume must be refused`);
    assert.equal(harness.page.clicks, 0, `${name}: resuming an uninterpretable Run must still send nothing`);
  }
});

// ---------------------------------------------------------------------------
// The same attack from the other side: a malformed Run offered to background.
// ---------------------------------------------------------------------------

const background = await installBackgroundHarness();

test("T11: background refuses a Run whose identity fields do not belong to this runtime", async () => {
  const tabId = 11001;
  background.setTabs([{ id: tabId, active: true, windowId: 1, url: "https://chatgpt.com/" }]);
  background.setDocument(tabId, { documentId: `document-${tabId}`, documentInstanceId: `instance-${tabId}` });
  const sender = { tab: { id: tabId }, documentId: `document-${tabId}` };
  const good = makeRun({
    runId: "identity-run",
    boundTabId: tabId,
    boundDocumentId: `document-${tabId}`,
    documentInstanceId: `instance-${tabId}`
  });

  for (const [name, mutate] of [
    ["foreign execution session", (run) => { run.executionSessionId = "a-previous-browser-session"; }],
    ["missing execution session", (run) => { delete run.executionSessionId; }],
    ["foreign provider", (run) => { run.provider = "not-chatgpt"; }],
    ["missing provider", (run) => { delete run.provider; }],
    ["foreign content version", (run) => { run.contentVersion = "0.0.1"; }],
    ["missing content version", (run) => { delete run.contentVersion; }],
    ["bound to another tab", (run) => { run.boundTabId = tabId + 1; }],
    ["not an object", () => {}]
  ]) {
    const run = name === "not an object" ? "a string pretending to be a Run" : structuredClone(good);
    if (typeof run === "object") mutate(run);
    const response = await background.invoke({
      type: "AIPM_RUN_SET",
      run,
      runTransition: "start",
      conversationKey: good.conversationKey,
      documentInstanceId: `instance-${tabId}`
    }, sender);

    assert.equal(response.ok, false, `${name}: background must refuse this Run`);
    assert.equal(background.storedRun(tabId), null, `${name}: nothing may be persisted`);
  }
});

test("T11: background refuses a durable Run whose generation or progress would go backwards", async () => {
  const tabId = 11002;
  background.setTabs([{ id: tabId, active: true, windowId: 1, url: "https://chatgpt.com/" }]);
  background.setDocument(tabId, { documentId: `document-${tabId}`, documentInstanceId: `instance-${tabId}` });
  const sender = { tab: { id: tabId }, documentId: `document-${tabId}` };
  const stored = makeRun({
    runId: "progress-run",
    boundTabId: tabId,
    boundDocumentId: `document-${tabId}`,
    documentInstanceId: `instance-${tabId}`,
    cursor: { stepIndex: 2, repeatIndex: 1, sendsCompleted: 4 },
    stateRevision: 9
  });
  background.putRun(tabId, stored);

  for (const [name, mutate] of [
    ["fewer sends completed", (run) => { run.cursor.sendsCompleted = 1; }],
    ["earlier step index", (run) => { run.cursor.stepIndex = 0; }],
    ["earlier repeat index", (run) => { run.cursor.repeatIndex = 0; }],
    ["a stale revision", (run) => { run.stateRevision = 3; }],
    ["a different Run generation", (run) => { run.runId = "some-other-run"; }]
  ]) {
    const attempt = structuredClone(stored);
    mutate(attempt);
    const response = await background.invoke({
      type: "AIPM_RUN_SET",
      run: attempt,
      runTransition: "runner",
      conversationKey: stored.conversationKey,
      documentInstanceId: `instance-${tabId}`
    }, sender);

    assert.equal(response.ok, false, `${name}: a rewinding write must be refused`);
    assert.deepEqual(
      background.storedRun(tabId).cursor,
      { stepIndex: 2, repeatIndex: 1, sendsCompleted: 4 },
      `${name}: durable progress must be untouched`
    );
    assert.equal(background.storedRun(tabId).stateRevision, 9, `${name}: the revision must be untouched`);
  }
});

test("T11: a durable Run left behind by a previous browser session is quarantined, never executed", async () => {
  const tabId = 11003;
  background.setTabs([{ id: tabId, active: true, windowId: 1, url: "https://chatgpt.com/" }]);
  background.setDocument(tabId, { documentId: `document-${tabId}`, documentInstanceId: `instance-${tabId}` });
  background.putRun(tabId, makeRun({
    runId: "previous-session-run",
    boundTabId: tabId,
    boundDocumentId: `document-${tabId}`,
    documentInstanceId: `instance-${tabId}`,
    executionSessionId: "a-previous-browser-session"
  }));

  const response = await background.invoke({
    type: "AIPM_RUN_GET",
    conversationKey: "chatgpt:c:torture",
    documentInstanceId: `instance-${tabId}`
  }, { tab: { id: tabId }, documentId: `document-${tabId}` });

  assert.equal(response.ok, true);
  assert.equal(response.run, null, "a Run from a previous browser session must not be handed to the runtime");
  assert.equal(response.quarantineReason, "stale-browser-session");
  assert.equal(background.storedRun(tabId), null, "the stale Run must be removed from the active slot");
  const quarantined = background.quarantined().at(-1);
  assert.equal(quarantined.runId, "previous-session-run");
  assert.equal(quarantined.status, "paused");
  assert.equal(quarantined.resumable, false, "a quarantined Run must never be auto-resumable");
  assert.equal(DEFAULT_SESSION_ID !== quarantined.executionSessionId, true);
});
