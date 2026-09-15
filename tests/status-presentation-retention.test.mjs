/*
  A refresh that never ran must not erase what the tab already told us.

  The Side Panel re-polls the target tab every 1.2 seconds. That poll shares a
  single-outstanding-contact gate with periodic discovery and with the runner's own
  observations, so under load it is routinely refused (READ_ONLY_CONTACT_BUSY /
  READ_ONLY_BACKOFF) or runs out of its own budget (STATUS_REFRESH_TIMEOUT). Those
  codes mean "we did not get to look", not "the tab is unhealthy" — but the panel
  used to render `{pageReady:false, run:null}` for every one of them, which flipped a
  healthy Run's badge to 待機中 and its connection line to 確認できません for one tick
  before the next poll restored it. That is the visible oscillation.

  Retention is presentation only. Every control that could cause a send stays disabled
  while the shown state is unconfirmed, and Stop — a durable revoke — stays available.
  The paired assertions below exist so a future change cannot buy smoother UI by
  letting a cached snapshot authorize a mutation.
*/

import assert from "node:assert/strict";
import test from "node:test";

import { installSidePanelHarness, tick } from "./helpers/sidepanel-harness.mjs";

const RUNNING_RUN = {
  runId: "run-retention",
  status: "running",
  phase: "ready",
  plannedSends: 40,
  cursor: { stepIndex: 0, sendsCompleted: 12 },
  workflow: { steps: [{ id: "s1", type: "prompt", repeat: 40 }] },
  resumable: true,
  outbox: null
};

function healthyStatus(run) {
  return {
    ok: true,
    provider: "chatgpt",
    contentVersion: "0.4.0",
    pageReady: true,
    generationState: "idle",
    blocker: null,
    conversationKey: "chatgpt:c:fixture",
    instanceId: "fixture-instance",
    run: structuredClone(run),
    diagnostics: []
  };
}

function relayFailure(code) {
  return { ok: false, relayError: `relay refused: ${code}`, relayErrorCode: code };
}

const TRANSIENT_CODES = [
  "READ_ONLY_CONTACT_BUSY",
  "READ_ONLY_BACKOFF",
  "READ_ONLY_CONTACT_EXPIRED",
  "RUN_OBSERVATION_TIMEOUT",
  "TAB_STATUS_TIMEOUT",
  "STATUS_REFRESH_TIMEOUT"
];

for (const code of TRANSIENT_CODES) {
  test(`${code} keeps the confirmed presentation instead of erasing it`, async () => {
    const harness = await installSidePanelHarness({ tabIds: [1] });
    let response = healthyStatus(RUNNING_RUN);
    harness.setRelayResponder(() => response);
    try {
      await harness.click("refreshTabs");
      await tick();
      assert.equal(harness.el("statusBadge").textContent, "実行中");
      assert.match(harness.el("progress").textContent, /送信 12\/40/);
      assert.equal(harness.el("runCard").dataset.observation, "fresh");

      response = relayFailure(code);
      await harness.click("refreshTabs");
      await tick();

      assert.equal(harness.el("statusBadge").textContent, "実行中", "a refusal to observe must not idle the Run");
      assert.match(harness.el("progress").textContent, /送信 12\/40/, "delivered progress must survive");
      assert.equal(harness.el("runCard").dataset.observation, "refreshing");
      assert.match(harness.el("message").textContent, /再確認/);
      assert.doesNotMatch(harness.el("connectionStatus").textContent, /確認できません/);

      // Presentation is retained; authority is not.
      assert.equal(harness.el("start").disabled, true, "Start must require a fresh confirmation");
      assert.equal(harness.el("flowStart").disabled, true, "Flow Start must require a fresh confirmation");
      assert.equal(harness.el("pause").disabled, true, "Pause must require a fresh confirmation");
      assert.equal(harness.el("resume").disabled, true, "Resume must require a fresh confirmation");
      assert.equal(harness.el("stop").disabled, false, "Stop is a durable revoke and must stay available");
      assert.equal(harness.el("runDetails").hidden, false, "stale observation must not collapse Run controls");
      assert.equal(harness.el("runCard").dataset.promoted, "true");
      assert.equal(harness.el("startSection").hidden, true);
    } finally {
      harness.restoreGlobals();
    }
  });
}

test("a recovered observation restores a fresh, operable presentation", async () => {
  const harness = await installSidePanelHarness({ tabIds: [1] });
  let response = healthyStatus(RUNNING_RUN);
  harness.setRelayResponder(() => response);
  try {
    await harness.click("refreshTabs");
    await tick();

    response = relayFailure("READ_ONLY_BACKOFF");
    await harness.click("refreshTabs");
    await tick();
    assert.equal(harness.el("runCard").dataset.observation, "refreshing");
    assert.equal(harness.el("pause").disabled, true);

    // A failed observation also puts the panel's own gate into backoff, so the very next
    // refresh is refused too and the presentation legitimately stays unconfirmed. Recovery
    // is only observable once that backoff has elapsed.
    response = healthyStatus(RUNNING_RUN);
    await new Promise((resolve) => setTimeout(resolve, 1_400));
    await harness.click("refreshTabs");
    await tick();
    assert.equal(harness.el("runCard").dataset.observation, "fresh");
    assert.equal(harness.el("statusBadge").textContent, "実行中");
    assert.equal(harness.el("pause").disabled, false, "a fresh confirmation must restore run control");
  } finally {
    harness.restoreGlobals();
  }
});

test("a non-transient relay failure still erases the presentation", async () => {
  const harness = await installSidePanelHarness({ tabIds: [1] });
  let response = healthyStatus(RUNNING_RUN);
  harness.setRelayResponder(() => response);
  try {
    await harness.click("refreshTabs");
    await tick();
    assert.equal(harness.el("statusBadge").textContent, "実行中");

    // A changed document is a real state change, not a missed observation.
    response = relayFailure("DOCUMENT_IDENTITY_MISMATCH");
    await harness.click("refreshTabs");
    await tick();

    assert.notEqual(harness.el("runCard").dataset.observation, "refreshing");
    assert.equal(harness.el("statusBadge").textContent, "待機中", "a real state change must erase the Run view");
    assert.equal(harness.el("start").disabled, true);
    assert.match(harness.el("message").textContent, /DOCUMENT_IDENTITY_MISMATCH|relay refused/);
    assert.equal(harness.el("runDetails").hidden, false, "failure feedback remains visible after an idle projection");
    assert.equal(harness.el("runCard").dataset.active, "true", "a retained durable Stop stays sticky");
  } finally {
    harness.restoreGlobals();
  }
});

test("a transient failure cannot resurrect a presentation that a real state change erased", async () => {
  const harness = await installSidePanelHarness({ tabIds: [1] });
  let response = healthyStatus(RUNNING_RUN);
  harness.setRelayResponder(() => response);
  try {
    await harness.click("refreshTabs");
    await tick();
    assert.equal(harness.el("statusBadge").textContent, "実行中");

    response = relayFailure("DOCUMENT_IDENTITY_MISMATCH");
    await harness.click("refreshTabs");
    await tick();
    assert.equal(harness.el("statusBadge").textContent, "待機中");

    // The erased view is not a confirmed observation, so nothing may be retained from it.
    response = relayFailure("READ_ONLY_BACKOFF");
    await harness.click("refreshTabs");
    await tick();
    assert.notEqual(harness.el("runCard").dataset.observation, "refreshing");
    assert.equal(harness.el("statusBadge").textContent, "待機中");
    assert.equal(harness.el("start").disabled, true);
  } finally {
    harness.restoreGlobals();
  }
});
