import assert from "node:assert/strict";
import test from "node:test";

import {
  canDispatchTargetIntent,
  chooseInitialTargetId,
  retainTargetOnRefresh,
  targetHealth
} from "../src/target-selection.js";
import {
  EXTENSION_VERSION,
  installBackgroundHarness
} from "./helpers/background-harness.mjs";

const healthy = (tabId, { active = false, title = "ChatGPT" } = {}) => ({
  tabId,
  title,
  active,
  status: {
    provider: "chatgpt",
    contentVersion: EXTENSION_VERSION,
    discoveryError: null
  }
});

function browserTab(id, { active = false, title = "ChatGPT" } = {}) {
  return { id, active, title, windowId: 1, url: "https://chatgpt.com/" };
}

const startPayload = {
  type: "AIPM_START",
  workflow: {
    schemaVersion: 1,
    id: "practical-target",
    name: "Practical target",
    maxSends: 1,
    recovery: {
      mode: "safe",
      identityAttempts: 3,
      readiness: "normal",
      statusRecovery: "normal"
    },
    steps: [{
      id: "target-send",
      type: "prompt",
      delivery: "send",
      prompt: "TARGET TAB",
      repeat: 1,
      delayAfterMs: 0
    }]
  }
};

test("T1/T2: one or two eligible ChatGPT tabs remain explicit ID choices", () => {
  assert.equal(chooseInitialTargetId(Number.NaN, [healthy(101, { active: true })]), 101);
  const two = [healthy(101, { active: true }), healthy(202)];
  assert.equal(targetHealth(101, two, EXTENSION_VERSION).ready, true);
  assert.equal(targetHealth(202, two, EXTENSION_VERSION).ready, true);
});

test("T3/T4: selecting B routes to B even while browser-active A changes independently", async () => {
  const harness = await installBackgroundHarness();
  const A = 301;
  const B = 302;
  harness.setTabs([browserTab(A, { active: true }), browserTab(B)]);

  const response = await harness.relay(startPayload, B);

  assert.equal(response.ok, true);
  assert.equal(harness.commandsDelivered(A).length, 0);
  assert.equal(harness.commandsDelivered(B).length, 1);
  assert.equal(harness.commandsDelivered(B)[0].payload.bindingTabId, B);
});

test("T5/ID4: a removed selected B stays selected-but-unreachable and never falls back to A", () => {
  const A = healthy(401, { active: true });
  const selectedB = 402;
  assert.equal(retainTargetOnRefresh(selectedB), selectedB);
  assert.equal(targetHealth(selectedB, [A], EXTENSION_VERSION).ready, false);
  assert.equal(targetHealth(selectedB, [A], EXTENSION_VERSION).reason, "target-unreachable");
  assert.equal(canDispatchTargetIntent(selectedB, 7, selectedB, 7, 0, false), false);
});

test("T6: identical titles never replace tab ID as routing authority", async () => {
  const harness = await installBackgroundHarness();
  const A = 501;
  const B = 502;
  harness.setTabs([
    browserTab(A, { active: true, title: "Identical ChatGPT" }),
    browserTab(B, { title: "Identical ChatGPT" })
  ]);

  const listed = await harness.invoke({ type: "AIPM_LIST_CHATGPT_TABS" });
  assert.equal(listed.ok, true);
  assert.deepEqual(new Set(listed.tabs.map((tab) => tab.tabId)), new Set([A, B]));
  assert.equal(listed.tabs[0].title, listed.tabs[1].title);

  await harness.relay(startPayload, B);
  assert.equal(harness.commandsDelivered(A).length, 0);
  assert.equal(harness.commandsDelivered(B).length, 1);
});

test("T7: simultaneous explicit starts remain isolated per target tab", async () => {
  const harness = await installBackgroundHarness();
  const A = 601;
  const B = 602;
  harness.setTabs([browserTab(A, { active: true }), browserTab(B)]);

  const [left, right] = await Promise.all([
    harness.relay(startPayload, A),
    harness.relay(startPayload, B)
  ]);

  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  assert.equal(harness.commandsDelivered(A).length, 1);
  assert.equal(harness.commandsDelivered(B).length, 1);
  assert.equal(harness.commandsDelivered(A)[0].payload.bindingTabId, A);
  assert.equal(harness.commandsDelivered(B)[0].payload.bindingTabId, B);
});

test("T8: reopening the Side Panel restores the remembered tab ID, including temporary absence", () => {
  const remembered = 702;
  const present = [healthy(701, { active: true }), healthy(remembered)];
  assert.equal(chooseInitialTargetId(remembered, present), remembered);
  assert.equal(chooseInitialTargetId(remembered, [present[0]]), remembered);
  assert.equal(retainTargetOnRefresh(remembered), remembered);
});
