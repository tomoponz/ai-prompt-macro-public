import test from "node:test";
import assert from "node:assert/strict";

import { installSidePanelHarness, deferred, tick } from "./helpers/sidepanel-harness.mjs";

function observedRun(runId, stateRevision = 7) {
  return {
    runId,
    stateRevision,
    status: "running",
    phase: "ready",
    plannedSends: 2,
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 },
    workflow: {
      recovery: { mode: "safe", identityAttempts: 3 },
      steps: [{ id: "p1", type: "prompt", delivery: "send", prompt: "P", repeat: 2 }]
    }
  };
}

function statusFor(run) {
  return {
    ok: true,
    provider: "chatgpt",
    contentVersion: "0.4.1",
    pageReady: true,
    generationState: "idle",
    blocker: null,
    conversationKey: "chatgpt:c:tab-1",
    instanceId: "instance-1",
    run,
    diagnostics: []
  };
}

test("R1: status unavailable still lets the exact observed Run reach durable Stop", async () => {
  const panel = await installSidePanelHarness({ tabIds: [1] });
  const durable = { run: observedRun("run-a") };
  let statusAvailable = true;
  try {
    panel.setRelayResponder((message) => {
      if (message.payload?.type === "AIPM_GET_STATUS") {
        if (!statusAvailable) throw new Error("status unavailable");
        return statusFor(durable.run);
      }
      if (message.payload?.type === "AIPM_STOP" &&
          message.targetTabId === 1 &&
          message.payload.expectedRunId === durable.run.runId) {
        durable.run = { ...durable.run, status: "stopped", phase: "stopped" };
        return { ok: true, stopCommitted: true, run: durable.run };
      }
      return { ok: false, relayError: "stale" };
    });

    await panel.click("refreshTabs");
    assert.equal(panel.el("stop").disabled, false, "the observed running Run is stoppable");

    statusAvailable = false;
    await panel.click("refreshTabs");
    assert.equal(panel.el("stop").disabled, false, "a transient status failure must retain exact Stop authority");

    await panel.click("stop");
    assert.equal(durable.run.status, "stopped", "the exact observed Run must be durably stopped");
    const stop = panel.messages.find((entry) => entry.payload?.type === "AIPM_STOP");
    assert.equal(stop?.targetTabId, 1);
    assert.equal(stop?.payload?.expectedRunId, "run-a");
  } finally {
    panel.restoreGlobals();
  }
});

test("R2: a stale observed Stop cannot stop a replacement Run", async () => {
  const panel = await installSidePanelHarness({ tabIds: [1] });
  const runA = observedRun("run-a", 3);
  let currentRun = runA;
  let statusAvailable = true;
  try {
    panel.setRelayResponder((message) => {
      if (message.payload?.type === "AIPM_GET_STATUS") {
        if (!statusAvailable) throw new Error("status unavailable");
        return statusFor(currentRun);
      }
      if (message.payload?.type === "AIPM_STOP") {
        if (message.payload.expectedRunId !== currentRun.runId) {
          return { ok: false, relayError: "stale Run", relayErrorCode: "STALE_CONTROL_INTENT" };
        }
        currentRun = { ...currentRun, status: "stopped", phase: "stopped" };
        return { ok: true, stopCommitted: true, run: currentRun };
      }
      return { ok: false, relayError: "unexpected" };
    });

    await panel.click("refreshTabs");
    statusAvailable = false;
    currentRun = observedRun("run-b", 1);
    await panel.click("refreshTabs");
    await panel.click("stop");

    assert.equal(currentRun.runId, "run-b");
    assert.equal(currentRun.status, "running", "background refusal must leave replacement Run B untouched");
    const stop = panel.messages.find((entry) => entry.payload?.type === "AIPM_STOP");
    assert.equal(stop?.payload?.expectedRunId, "run-a", "the panel must not rebind stale Stop to Run B");
  } finally {
    panel.restoreGlobals();
  }
});

for (const outcome of ["success", "rejection", "throw"]) {
  test(`F1: deferred Stop A ${outcome} cannot consume B's Stop snapshot or feedback`, async () => {
    const panel = await installSidePanelHarness({ tabIds: [1, 2], storageSeed: { "aipm.selectedTab.v1": 1 } });
    const received = deferred();
    const completion = deferred();
    const runA = observedRun("run-a", 8);
    const runB = observedRun("run-b", 12);
    let failBStatus = false;
    let stopB = null;
    try {
      await tick();
      panel.setRelayResponder(async (message) => {
        const tabId = message.targetTabId;
        if (message.payload?.type === "AIPM_GET_STATUS") {
          if (tabId === 2 && failBStatus) throw new Error("B status unavailable");
          return statusFor(tabId === 1 ? runA : runB);
        }
        if (message.payload?.type === "AIPM_STOP" && tabId === 1) {
          assert.equal(message.payload.expectedRunId, "run-a");
          assert.equal(message.payload.expectedStateRevision, 8);
          received.resolve();
          await completion.promise;
          if (outcome === "throw") throw new Error("OLD A CONTROL ERROR");
          if (outcome === "rejection") return { ok: false, error: "OLD A CONTROL ERROR" };
          runA.status = "stopped";
          return { ok: true, stopCommitted: true };
        }
        if (message.payload?.type === "AIPM_STOP" && tabId === 2) {
          stopB = message;
          return { ok: true, stopCommitted: true };
        }
        throw new Error("unexpected control");
      });
      await panel.click("refreshTabs");
      const stoppingA = panel.click("stop");
      await received.promise;
      panel.el("targetTab").value = "2";
      await panel.change("targetTab");
      assert.equal(panel.el("runCard").dataset.state, "running");
      const guidanceB = panel.el("message").textContent;
      failBStatus = true;
      completion.resolve();
      await stoppingA;
      const guidanceAfterCompletion = panel.el("message").textContent;
      await panel.click("refreshTabs");
      assert.equal(panel.el("stop").disabled, false, "B's retained durable Stop survives its failed observation");
      assert.equal(guidanceAfterCompletion, guidanceB, "A completion must not render feedback into B");
      assert.equal(panel.el("runCard").dataset.active, "true");
      assert.doesNotMatch(panel.el("message").textContent, /OLD A CONTROL ERROR/);
      await panel.click("stop");
      assert.equal(stopB?.targetTabId, 2);
      assert.equal(stopB?.payload.expectedRunId, "run-b");
      assert.equal(stopB?.payload.expectedStateRevision, 12);
      assert.equal(runB.status, "running", "A's command itself never mutates B");
      assert.equal(panel.messages.filter((message) => message.payload?.type === "AIPM_START").length, 0);
    } finally {
      completion.resolve();
      panel.restoreGlobals();
    }
  });
}
