// T2 — irreversible send boundary torture.
//
// `sendPromptSafely()` crosses roughly a dozen awaits between "this Run may send" and the
// single irreversible `sendButton.click()`. Every one of those awaits is a window in which
// the page, the user, the durable Run, the lease or the executable workflow can change
// underneath the runner. A happy-path test never opens those windows, which is exactly how
// the historical Test Escape (automated PASS + browser fixture PASS + real Edge FAIL)
// happened.
//
// This file drives the real content-core / content-runner / content-controller through the
// shared harness and injects one fault at one exact await boundary at a time, sweeping the
// full (boundary x fault) matrix.
import test from "node:test";
import assert from "node:assert/strict";

import { CONVERSATION_KEY, createWorkflowHarness } from "./helpers/workflow-harness.mjs";

const PROMPT = "TORTURE PROMPT";

function singleSendWorkflow() {
  return {
    schemaVersion: 1,
    id: "send-boundary",
    name: "Send Boundary",
    maxSends: 1,
    steps: [{ id: "only", type: "prompt", delivery: "send", prompt: PROMPT, repeat: 1, delayAfterMs: 0 }]
  };
}

// Boundaries 1..3 belong to Start. The send sequence proper begins at 4; the irreversible
// click happens after boundary 23. Names describe the await the runner is parked in when
// the fault lands. This ordering is asserted by `T2: the boundary map matches the runner`
// below, so the matrix cannot silently drift away from the production code.
const PRE_CLICK_BOUNDARIES = [
  [4, "guard:step-dispatch"],
  [5, "lease:acquire"],
  [6, "lease:renew-before-readiness"],
  [7, "guard:readiness-observation"],
  [8, "lease:renew-in-readiness"],
  [9, "save:prepared"],
  [10, "lease:renew-after-prepared"],
  [11, "guard:before-composer-write"],
  [12, "write:settle-window"],
  [13, "guard:settlement-100ms"],
  [14, "guard:settlement-200ms"],
  [15, "guard:settlement-300ms"],
  [16, "guard:settlement-400ms"],
  [17, "guard:settlement-500ms"],
  [18, "guard:settlement-600ms"],
  [19, "save:delivery-mode"],
  [20, "guard:before-submitting-save"],
  [21, "save:submitting"],
  [22, "guard:after-submitting-save"],
  [23, "lease:renew-final"]
];

// The click itself sends no message, so it does not consume a boundary number: boundary 24
// is the first durable write after the click.
const POST_CLICK_BOUNDARIES = [
  [24, "save:submitted"],
  [25, "guard:ack-observation"],
  [26, "lease:renew-in-ack"],
  [27, "save:confirmed"],
  [28, "guard:after-confirmed"],
  [29, "lease:renew-after-confirmed"]
];

// Pause is deliberately deferred once `phase="submitting"` is durably committed, so the
// runner can finish an already-authorized click/ACK exactly once instead of manufacturing
// submission ambiguity out of a user Pause. Settlement remains wholly pre-click and honors
// Pause immediately; boundary 19 is the first point whose durable save/control path defers it.
const FIRST_DEFERRED_PAUSE_BOUNDARY = 19;

// A durable revision conflict is only observable at the next durable write. Between
// `save:submitting` and the click there is deliberately no further write, because the click
// is authorized by exactly that committed state. From boundary 22 on, a revision conflict
// therefore costs the one already-authorized click and then fails closed.
const FIRST_LATE_REVISION_BOUNDARY = 22;

const IDENTITY_MISMATCH = {
  ok: false,
  errorCode: "DOCUMENT_IDENTITY_MISMATCH",
  error: "現在のdocumentと要求元が一致しないため操作を拒否しました。"
};

// Each fault is a change a real Edge session can produce while the runner is parked on one
// of the awaits above. `from` marks the first boundary at which the fault is meaningful:
// mutating the executable workflow before the send position has been captured is simply a
// different workflow, not a race.
const FAULTS = {
  "user-draft-appears": {
    apply: ({ page }) => { page.text = "user draft typed during the await"; }
  },
  "pause": {
    apply: async ({ harness }) => { await harness.control("AIPM_PAUSE"); },
    expectedClicks: (boundary) => (boundary >= FIRST_DEFERRED_PAUSE_BOUNDARY ? 1 : 0)
  },
  "stop": {
    apply: async ({ harness }) => { await harness.control("AIPM_STOP"); }
  },
  "run-revision-changes": {
    // Another writer (a durable Pause request, a New Chat adoption, a fail-close) advanced
    // the stored revision while this runner was parked.
    apply: ({ harness }) => {
      harness.injectDurableRun((run) => ({ ...run, stateRevision: Number(run.stateRevision ?? 0) + 5 }));
    },
    expectedClicks: (boundary) => (boundary >= FIRST_LATE_REVISION_BOUNDARY ? 1 : 0)
  },
  "document-changes": {
    apply: ({ state }) => { state.documentMismatch = true; }
  },
  "conversation-changes": {
    apply: ({ harness }) => { harness.setConversationKey("chatgpt:c:some-other-conversation"); }
  },
  "lease-renew-failure": {
    apply: ({ state }) => { state.leaseRenewFails = true; }
  },
  "workflow-mutation": {
    // A future-step mutation must not expand or replace the Run while the
    // persistence / control / lease awaits before the click are in flight.
    from: 7,
    apply: ({ liveRun }) => {
      liveRun().workflow.steps.push({
        id: "smuggled",
        type: "prompt",
        delivery: "send",
        prompt: "SMUGGLED PROMPT",
        repeat: 1,
        delayAfterMs: 0
      });
      liveRun().workflow.maxSends = 2;
    }
  },
  "send-budget-mutation": {
    from: 7,
    // Deliberately corrupts the send counter itself, so cursor-based assertions do not
    // apply to this fault; the invariant it proves is that the click is refused.
    corruptsCursor: true,
    apply: ({ liveRun }) => { liveRun().cursor.sendsCompleted = 40; }
  },
  "composer-changes": {
    apply: ({ page }) => { page.text = "something else entirely"; }
  },
  "blocker-appears": {
    apply: ({ page }) => { page.blocker = "ui-blocked"; }
  },
  "generation-starts": {
    // Before boundary 9 the runner is still inside its readiness wait, where a permanently
    // generating page is a (much slower) readiness timeout rather than a click race.
    from: 9,
    apply: ({ page }) => { page.generationOverride = "generating"; }
  }
};

function faultApplies(faultName, boundary) {
  return boundary >= (FAULTS[faultName].from ?? 0);
}

function expectedClicks(faultName, boundary) {
  return FAULTS[faultName].expectedClicks?.(boundary) ?? 0;
}

function runBoundaryScenario({ boundary, faultName }) {
  const fault = FAULTS[faultName];
  const state = {
    fired: null,
    injecting: false,
    documentMismatch: false,
    leaseRenewFails: false
  };
  const observed = [];
  let sequence = 0;
  let harness = null;
  let capturedRun = null;

  async function boundaryReached(label) {
    if (state.injecting || state.fired) return;
    sequence += 1;
    observed.push(`${sequence}:${label}`);
    if (sequence !== boundary) return;
    state.fired = label;
    state.injecting = true;
    try {
      await fault.apply({
        harness,
        page: harness.page,
        context: harness.context,
        liveRun: () => capturedRun,
        state
      });
    } finally {
      state.injecting = false;
    }
  }

  harness = createWorkflowHarness({
    async onRunGet() {
      await boundaryReached("guard");
      return state.documentMismatch ? IDENTITY_MISMATCH : null;
    },
    async onRunSet() {
      await boundaryReached("save");
      return state.documentMismatch ? IDENTITY_MISMATCH : null;
    },
    async onLease({ operation }) {
      await boundaryReached(`lease:${operation}`);
      // Background reconfirms the current top document for every lease mutation, so a
      // document change is refused there too, not only on Run reads/writes.
      if (state.documentMismatch) return IDENTITY_MISMATCH;
      if (operation === "renew" && state.leaseRenewFails) return { ok: true, renewed: false };
      return null;
    },
    onWrite() {
      // writePrompt is synchronous inside the runner; the settle window it precedes is the
      // real boundary, so only synchronous faults are meaningful here.
      void boundaryReached("write");
    }
  });

  const realExecuteRun = harness.context.executeRun;
  harness.context.executeRun = (run, token, lease) => {
    capturedRun = run;
    return realExecuteRun(run, token, lease);
  };

  state.clear = () => {
    state.documentMismatch = false;
    state.leaseRenewFails = false;
    harness.page.blocker = null;
    harness.page.generationOverride = null;
    harness.setConversationKey(CONVERSATION_KEY);
  };

  return { harness, state, observed };
}

test("T2: the boundary map still matches the runner's actual await sequence", async () => {
  const { harness, observed } = runBoundaryScenario({ boundary: 999, faultName: "stop" });
  await harness.start(singleSendWorkflow());
  await harness.settle();

  assert.equal(harness.page.clicks, 1, "the unperturbed reference run must send exactly once");
  const labelled = Object.fromEntries(observed.map((entry) => {
    const [index, ...rest] = entry.split(":");
    return [Number(index), rest.join(":")];
  }));
  const kinds = {
    guard: "guard",
    save: "save",
    write: "write",
    "lease:acquire": "lease",
    "lease:renew": "lease",
    "lease:release": "lease"
  };
  for (const [index, name] of [...PRE_CLICK_BOUNDARIES, ...POST_CLICK_BOUNDARIES]) {
    assert.equal(
      kinds[labelled[index]],
      name.split(":")[0],
      `boundary ${index} should be a ${name.split(":")[0]} await but the runner reached ${labelled[index]}`
    );
  }
});

test("T2: no pre-click boundary x fault combination produces an unauthorized Send click", async () => {
  for (const [boundary, label] of PRE_CLICK_BOUNDARIES) {
    for (const faultName of Object.keys(FAULTS)) {
      if (!faultApplies(faultName, boundary)) continue;
      const { harness, state } = runBoundaryScenario({ boundary, faultName });
      await harness.start(singleSendWorkflow());
      await harness.settle();

      const context = `boundary ${boundary} (${label}) x ${faultName}`;
      assert.ok(state.fired, `${context}: the injection point must actually be reached`);

      const allowed = expectedClicks(faultName, boundary);
      assert.equal(harness.page.clicks, allowed, `${context}: unexpected Send click count`);
      assert.ok(
        harness.page.clicks <= 1,
        `${context}: a single authorized send position must never click twice`
      );

      const stored = harness.stored();
      if (allowed === 0) {
        if (!FAULTS[faultName].corruptsCursor) {
          assert.equal(stored.cursor.sendsCompleted, 0, `${context}: a Run that never clicked must not count a send`);
        }
        assert.notEqual(stored.status, "completed", `${context}: a blocked Run must not report completion`);
      }
    }
  }
});

// A blocked pre-click attempt is only half the story. The historical escape was a *later*
// duplicate, so each blocked combination is driven through the full remaining lifecycle:
// the transient fault clears, the document reloads, and the user explicitly Resumes. Across
// all of that, one logical send position may still only ever be clicked once.
test("T2: a blocked pre-click attempt never duplicates across reload plus explicit Resume", async () => {
  for (const [boundary, label] of PRE_CLICK_BOUNDARIES) {
    for (const faultName of Object.keys(FAULTS)) {
      if (!faultApplies(faultName, boundary)) continue;
      if (expectedClicks(faultName, boundary) !== 0) continue;
      const { harness, state } = runBoundaryScenario({ boundary, faultName });
      await harness.start(singleSendWorkflow());
      await harness.settle();

      const context = `boundary ${boundary} (${label}) x ${faultName}`;
      assert.equal(harness.page.clicks, 0, `${context}: the blocked attempt must not click`);

      state.clear();
      await harness.reload(1_000);
      await harness.control("AIPM_RESUME");
      await harness.settle();

      const positions = harness.clicks().map((entry) => entry.position);
      assert.equal(
        new Set(positions).size,
        positions.length,
        `${context}: a logical send position was clicked more than once (${positions.join(", ")})`
      );
      assert.ok(
        harness.page.clicks <= 1,
        `${context}: a one-send workflow produced ${harness.page.clicks} clicks after recovery`
      );

      const stored = harness.stored();
      if (!FAULTS[faultName].corruptsCursor) {
        assert.ok(
          stored.cursor.sendsCompleted <= stored.workflow.maxSends,
          `${context}: sendsCompleted ${stored.cursor.sendsCompleted} exceeded maxSends`
        );
      } else {
        // A forward-jumped counter can only shrink the remaining budget, never grow it.
        assert.ok(
          stored.cursor.sendsCompleted >= stored.workflow.maxSends,
          `${context}: a corrupted counter must not leave send budget available`
        );
      }
    }
  }
});

test("T2: an outbox past the pre-submit checkpoint is never auto-resumable", async () => {
  for (const [boundary, label] of POST_CLICK_BOUNDARIES) {
    for (const faultName of ["document-changes", "run-revision-changes", "blocker-appears", "conversation-changes"]) {
      const { harness, state } = runBoundaryScenario({ boundary, faultName });
      await harness.start(singleSendWorkflow());
      await harness.settle();
      state.clear();
      await harness.reload(1_000);

      const stored = harness.stored();
      const context = `post-click boundary ${boundary} (${label}) x ${faultName}`;
      if (stored.outbox && !(stored.phase === "prepared" && stored.outbox.state === "prepared")) {
        assert.equal(
          stored.resumable,
          false,
          `${context}: an unfinished outbox past the pre-submit checkpoint must not be auto-resumable`
        );
        const resume = await harness.control("AIPM_RESUME");
        await harness.settle();
        assert.equal(resume.ok, false, `${context}: Resume must be refused while delivery is unresolved`);
      }
      assertNoRepeatedPosition(harness, context);
    }
  }
});

test("T2: a fault after the irreversible click never re-clicks the position it already sent", async () => {
  for (const [boundary, label] of POST_CLICK_BOUNDARIES) {
    for (const faultName of Object.keys(FAULTS)) {
      const { harness, state } = runBoundaryScenario({ boundary, faultName });
      await harness.start(singleSendWorkflow());
      await harness.settle();

      const context = `post-click boundary ${boundary} (${label}) x ${faultName}`;
      assert.ok(state.fired, `${context}: the injection point must actually be reached`);
      assertNoRepeatedPosition(harness, context);

      // The transient fault clears and the document reloads: recovery must still not turn
      // one delivery into two.
      state.clear();
      await harness.reload(1_000);
      assertNoRepeatedPosition(harness, `${context} after reload`);
    }
  }
});

// The harness records the durable cursor position at click time, so "the same logical send
// happened twice" is directly observable rather than inferred from a raw click total.
function assertNoRepeatedPosition(harness, context) {
  const positions = harness.clicks().map((entry) => entry.position);
  assert.equal(
    positions.filter((position) => position === "0:0").length,
    1,
    `${context}: the already-delivered send position must be clicked exactly once`
  );
  assert.equal(
    new Set(positions).size,
    positions.length,
    `${context}: a logical send position was clicked more than once (${positions.join(", ")})`
  );
}

test("T2: a user draft that appears inside the write settle window is preserved, unsent", async () => {
  const { harness, state } = runBoundaryScenario({ boundary: 12, faultName: "user-draft-appears" });
  await harness.start(singleSendWorkflow());
  await harness.settle();

  assert.equal(state.fired, "write");
  assert.equal(harness.page.clicks, 0, "the macro must not send over a user draft");
  assert.equal(
    harness.page.text,
    "user draft typed during the await",
    "the user's own text must survive exactly"
  );
  const stored = harness.stored();
  assert.equal(stored.status, "paused");
  assert.equal(stored.lastErrorCode, "composer_verification_failed");
  assert.equal(stored.resumable, false, "an unverifiable composer must not be auto-resumable");
  assert.equal(stored.cursor.sendsCompleted, 0);
});

test("T2: a workflow smuggled in during the pre-click awaits cannot expand this Run", async () => {
  const { harness } = runBoundaryScenario({ boundary: 14, faultName: "workflow-mutation" });
  await harness.start(singleSendWorkflow());
  await harness.settle();

  assert.equal(harness.page.clicks, 0, "a replaced workflow must invalidate the authorized click");
  const stored = harness.stored();
  assert.equal(stored.status, "paused");
  assert.equal(stored.lastErrorCode, "workflow_invalid");
  assert.equal(stored.resumable, false, "an unverifiable workflow must not be auto-resumable");
});

test("T2: Stop injected at every pre-click boundary leaves a terminal Run and no Send", async () => {
  for (const [boundary, label] of PRE_CLICK_BOUNDARIES) {
    const { harness } = runBoundaryScenario({ boundary, faultName: "stop" });
    await harness.start(singleSendWorkflow());
    await harness.settle();

    const context = `Stop at boundary ${boundary} (${label})`;
    assert.equal(harness.page.clicks, 0, `${context}: Stop must prevent the click`);
    assert.equal(harness.stored().status, "stopped", `${context}: Stop must be durable`);

    const resume = await harness.control("AIPM_RESUME");
    await harness.settle();
    assert.equal(resume.ok, false, `${context}: a stopped Run must refuse Resume`);
    assert.equal(harness.page.clicks, 0, `${context}: Resume after Stop must not send`);
  }
});

test("T2: a revision conflict that arrives after the authorized click fails closed, never retries", async () => {
  for (const boundary of [22, 23]) {
    const { harness, state } = runBoundaryScenario({ boundary, faultName: "run-revision-changes" });
    await harness.start(singleSendWorkflow());
    await harness.settle();

    const context = `late revision conflict at boundary ${boundary}`;
    assert.equal(harness.page.clicks, 1, `${context}: the already-authorized click happens exactly once`);
    const stored = harness.stored();
    assert.equal(stored.cursor.sendsCompleted, 0, `${context}: an unconfirmed click must not be counted`);
    assert.notEqual(stored.status, "completed", `${context}: the Run must not claim completion`);

    state.clear();
    await harness.reload(1_000);
    assert.equal(harness.page.clicks, 1, `${context}: recovery must not retry the ambiguous delivery`);
    const recovered = harness.stored();
    assert.equal(recovered.status, "paused", `${context}: recovery must fail closed`);
    assert.equal(recovered.resumable, false, `${context}: an ambiguous delivery must not be auto-resumable`);
    assert.equal(recovered.lastErrorCode, "recovery_ambiguous");
  }
});
