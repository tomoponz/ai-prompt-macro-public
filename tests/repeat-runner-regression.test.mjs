import test from "node:test";
import assert from "node:assert/strict";

import { createWorkflowHarness } from "./helpers/workflow-harness.mjs";

function repeatWorkflow() {
  return {
    schemaVersion: 1,
    id: "repeat-runner-regression",
    name: "Repeat Runner Regression",
    maxSends: 3,
    steps: [{
      id: "repeat-send",
      type: "prompt",
      delivery: "send",
      prompt: "SYNTHETIC",
      repeat: 3,
      delayAfterMs: 0
    }]
  };
}

test("repeat runner baseline completes all three positions exactly once", async () => {
  const harness = createWorkflowHarness();
  await harness.ready();
  await harness.start(repeatWorkflow());
  await harness.settle();

  assert.equal(harness.stored().status, "completed");
  assert.equal(harness.stored().cursor.sendsCompleted, 3);
  assert.equal(harness.page.clicks, 3);
  assert.equal(new Set(harness.clicks().map((entry) => entry.position)).size, 3);
});

// Characterization of a pre-click Pause/Resume gap, not an endorsement of it:
// the runner discards the prepared outbox but retains its own composer text.
// Resume accepts the Run and immediately stops at the draft-present guard.
// Keep protecting unrelated user drafts when adding an owned-draft remedy.
test("characterization: Pause after owned text write leaves Resume blocked by that text", async () => {
  let armed = true;
  let harness;
  harness = createWorkflowHarness({
    async onRunGet({ storedRun, page }) {
      if (!armed || storedRun?.phase !== "prepared" || !page.text) return null;
      armed = false;
      const pause = await harness.control("AIPM_PAUSE");
      assert.equal(pause.ok, true);
      return null;
    }
  });
  await harness.ready();
  await harness.start(repeatWorkflow());
  await harness.settle();

  assert.equal(armed, false, "Pause must land after the runner wrote text");
  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.stored().status, "paused");
  assert.equal(harness.stored().pauseReason, "user-pause");
  assert.equal(harness.stored().resumable, true);
  assert.equal(harness.stored().outbox, null);
  assert.equal(Boolean(harness.page.text), true);
  assert.equal(harness.page.activeDeliveryTransactions, 0);

  const resume = await harness.control("AIPM_RESUME");
  await harness.settle();

  assert.equal(resume.ok, true);
  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.stored().status, "paused");
  assert.equal(harness.stored().pauseReason, "draft_present");
  assert.equal(harness.stored().cursor.sendsCompleted, 0);
});

// Regression for a separate UI-readiness gap. Text settles after 650 ms,
// but the Send control is disabled for 900 ms after the second text write.
// An attachment waits for an actionable Send during settlement; text does not.
// The unchanged final click guards must remain in any eventual waiting fix.
test("transient Send disable after second text write waits and completes all repeats exactly once", async () => {
  let unavailableUntil = 0;
  let harness;
  harness = createWorkflowHarness({
    onWrite({ page }) {
      if (page.clicks === 1) unavailableUntil = harness.now() + 900;
    }
  });
  await harness.ready();
  const originalFindSendButton = harness.context.ChatGptAdapter.findSendButton;
  harness.context.ChatGptAdapter.findSendButton = () => {
    const button = originalFindSendButton();
    button.disabled = harness.now() < unavailableUntil;
    return button;
  };
  await harness.start(repeatWorkflow());
  await harness.settle();

  assert.equal(harness.stored().status, "completed");
  assert.equal(harness.page.clicks, 3);
  assert.equal(harness.stored().cursor.sendsCompleted, 3);
  assert.equal(new Set(harness.clicks().map((entry) => entry.position)).size, 3);
});

for (const unavailableMode of ["disabled", "aria-disabled", "missing", "ambiguous"]) {
  test(`text Send remaining ${unavailableMode} reaches the existing deadline without another click`, async () => {
    let secondWriteAt = null;
    const harness = createWorkflowHarness({
      onWrite({ page }) {
        if (page.clicks === 1) secondWriteAt = harness.now();
      }
    });
    await harness.ready();
    const adapter = harness.context.ChatGptAdapter;
    const originalFindSendButton = adapter.findSendButton;
    adapter.findSendButton = () => {
      const button = originalFindSendButton();
      if (secondWriteAt === null) return button;
      // The production unique-button lookup represents both zero matches and
      // multiple matches as null. Neither condition may authorize a click.
      if (["missing", "ambiguous"].includes(unavailableMode)) return null;
      button.disabled = unavailableMode === "disabled";
      button.getAttribute = () => unavailableMode === "aria-disabled" ? "true" : null;
      return button;
    };
    await harness.start(repeatWorkflow());
    await harness.settle();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(harness.page.clicks, 1);
    assert.equal(harness.stored().cursor.sendsCompleted, 1);
    assert.equal(harness.stored().pauseReason, "send_unavailable");
    assert.equal(harness.stored().outbox?.state, "prepared");
    assert.equal(harness.page.activeDeliveryTransactions, 0);
    const elapsedMs = harness.now() - secondWriteAt;
    assert.ok(elapsedMs >= harness.context.PROMPT_DELIVERY_SETTLEMENT_MAX_MS);
    assert.ok(elapsedMs <= harness.context.PROMPT_DELIVERY_SETTLEMENT_MAX_MS + 100);
    const diagnostic = harness.diagnostics().find((entry) => entry.type === "send_readiness_timeout");
    assert.ok(diagnostic, "the settled timeout records its bounded classification");
    assert.equal(diagnostic.status, "paused");
    assert.equal(diagnostic.reason, "send_unavailable");
    assert.equal(diagnostic.elapsedMs, 30_000);
    assert.equal(diagnostic.deadlineMs, 30_000);
    assert.deepEqual(Object.keys(diagnostic).sort(), [
      "at", "type", "runId", "phase", "status", "reason", "elapsedMs", "deadlineMs"
    ].sort());
    assert.equal(JSON.stringify(diagnostic).includes("SYNTHETIC"), false);
  });
}

for (const intervention of ["stop", "pause", "user-edit", "blocker"]) {
  test(`${intervention} during text Send readiness wait prevents the next click`, async () => {
    let secondWriteAt = null;
    let intervened = false;
    let harness;
    harness = createWorkflowHarness({
      onWrite({ page }) {
        if (page.clicks === 1) secondWriteAt = harness.now();
      },
      async onRunGet({ page }) {
        if (intervened || secondWriteAt === null || harness.now() - secondWriteAt < 800) return null;
        intervened = true;
        if (intervention === "user-edit") {
          page.text = "SYNTHETIC USER EDIT";
          page.userMutationEpoch += 1;
        } else if (intervention === "blocker") {
          page.blocker = "ui-blocked";
        } else {
          const response = await harness.control(intervention === "stop" ? "AIPM_STOP" : "AIPM_PAUSE");
          assert.equal(response.ok, true);
        }
        return null;
      }
    });
    await harness.ready();
    const adapter = harness.context.ChatGptAdapter;
    const originalFindSendButton = adapter.findSendButton;
    adapter.findSendButton = () => {
      const button = originalFindSendButton();
      button.disabled = secondWriteAt !== null && harness.now() - secondWriteAt < 2_000;
      return button;
    };
    await harness.start(repeatWorkflow());
    await harness.settle();

    assert.equal(intervened, true, "intervention must occur during the extra Send wait");
    assert.equal(harness.page.clicks, 1);
    assert.equal(harness.stored().cursor.sendsCompleted, 1);
    assert.equal(harness.page.activeDeliveryTransactions, 0);
    assert.equal(harness.stored().status, intervention === "stop" ? "stopped" : "paused");
    if (intervention === "user-edit") {
      assert.equal(harness.page.text, "SYNTHETIC USER EDIT");
      assert.equal(harness.stored().pauseReason, "paste_attachment_provenance_lost");
    }
    if (intervention === "pause") assert.equal(harness.stored().pauseReason, "user-pause");
  });
}

test("a longer text Send wait renews its lease and still sends each position once", async () => {
  let secondWriteAt = null;
  const renewals = [];
  let harness;
  harness = createWorkflowHarness({
    onWrite({ page }) {
      if (page.clicks === 1) secondWriteAt = harness.now();
    },
    onLease({ message, page }) {
      if (message.type === "AIPM_LEASE_RENEW" && page.clicks === 1 && secondWriteAt !== null) {
        renewals.push(harness.now() - secondWriteAt);
      }
      return null;
    }
  });
  await harness.ready();
  const adapter = harness.context.ChatGptAdapter;
  const originalFindSendButton = adapter.findSendButton;
  adapter.findSendButton = () => {
    const button = originalFindSendButton();
    button.disabled = secondWriteAt !== null && harness.now() - secondWriteAt < 20_000;
    return button;
  };
  await harness.start(repeatWorkflow());
  await harness.settle();

  assert.ok(renewals.some((at) => at > 650 && at < 15_000), "renew the lease before its ordinary TTL");
  assert.equal(harness.stored().status, "completed");
  assert.equal(harness.page.clicks, 3);
  assert.equal(new Set(harness.clicks().map((entry) => entry.position)).size, 3);
});

test("Send becoming disabled after text readiness still fails the final pre-click guard", async () => {
  let secondWriteAt = null;
  let finalDisable = false;
  let harness;
  harness = createWorkflowHarness({
    onWrite({ page }) {
      if (page.clicks === 1) secondWriteAt = harness.now();
    },
    onSave({ run }) {
      if (run.phase === "submitting" && run.cursor.sendsCompleted === 1) finalDisable = true;
    }
  });
  await harness.ready();
  const adapter = harness.context.ChatGptAdapter;
  const originalFindSendButton = adapter.findSendButton;
  adapter.findSendButton = () => {
    const button = originalFindSendButton();
    button.disabled = finalDisable || (secondWriteAt !== null && harness.now() - secondWriteAt < 900);
    return button;
  };
  await harness.start(repeatWorkflow());
  await harness.settle();

  assert.equal(finalDisable, true, "the second text transaction must have finished waiting");
  assert.equal(harness.page.clicks, 1);
  assert.equal(harness.stored().pauseReason, "send_unavailable");
  assert.equal(harness.stored().phase, "ambiguous");
  assert.equal(harness.stored().resumable, false);
});

for (const failureMode of ["reject", "pending"]) {
  test(`text Send timeout diagnostic ${failureMode} cannot block or alter the durable pause`, async () => {
    let observedStatusAtDiagnostic = null;
    let diagnosticAttempts = 0;
    let harness;
    harness = createWorkflowHarness({
      onStorageSet({ entries }) {
        const latest = entries["aipm.diagnostics.v1"]?.at(-1);
        if (latest?.type !== "send_readiness_timeout") return;
        diagnosticAttempts += 1;
        observedStatusAtDiagnostic = harness.stored().status;
        if (failureMode === "pending") return new Promise(() => {});
        throw new Error("synthetic diagnostic storage failure");
      }
    });
    await harness.ready();
    const adapter = harness.context.ChatGptAdapter;
    const originalFindSendButton = adapter.findSendButton;
    adapter.findSendButton = () => {
      const button = originalFindSendButton();
      button.disabled = true;
      return button;
    };
    await harness.start(repeatWorkflow());
    await harness.settle();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(diagnosticAttempts, 1);
    assert.equal(observedStatusAtDiagnostic, "paused", "diagnostic runs only after durable pause");
    assert.equal(harness.page.clicks, 0);
    assert.equal(harness.stored().status, "paused");
    assert.equal(harness.stored().pauseReason, "send_unavailable");
    assert.equal(harness.stored().cursor.sendsCompleted, 0);
    assert.equal(harness.page.activeDeliveryTransactions, 0);
  });
}
