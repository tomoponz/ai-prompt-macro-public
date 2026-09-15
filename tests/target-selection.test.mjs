import test from "node:test";
import assert from "node:assert/strict";

import {
  canDispatchTargetIntent,
  chooseInitialTargetId,
  isCurrentTargetRequest,
  retainTargetOnRefresh,
  targetHealth
} from "../src/target-selection.js";

const healthy = (tabId, active = false) => ({
  tabId,
  active,
  status: {
    provider: "chatgpt",
    contentVersion: "0.4.0",
    discoveryError: null
  }
});

test("a remembered explicit target remains locked while temporarily absent", () => {
  const tabs = [healthy(22, true)];
  assert.equal(chooseInitialTargetId(11, tabs), 11);
  assert.equal(retainTargetOnRefresh(11, tabs), 11);
  assert.equal(targetHealth(11, tabs, "0.4.0").ready, false);
  assert.equal(targetHealth(11, tabs, "0.4.0").reason, "target-unreachable");
});

test("initial one-tab mode safely selects the only confirmed ChatGPT tab", () => {
  const tabs = [healthy(31, true)];
  assert.equal(chooseInitialTargetId(Number.NaN, tabs), 31);
  assert.equal(targetHealth(31, tabs, "0.4.0").ready, true);
});

test("two tabs remain independently selectable but degraded targets fail closed", () => {
  const tabs = [
    healthy(41, true),
    { ...healthy(42), status: { ...healthy(42).status, discoveryError: "probe-timeout" } }
  ];
  assert.equal(targetHealth(41, tabs, "0.4.0").ready, true);
  assert.equal(targetHealth(42, tabs, "0.4.0").ready, false);
  assert.equal(targetHealth(42, tabs, "0.4.0").reason, "probe-timeout");
});

test("version or provider mismatch cannot become an operable target", () => {
  const old = { ...healthy(51), status: { ...healthy(51).status, contentVersion: "0.2.5" } };
  const otherProvider = { ...healthy(52), status: { ...healthy(52).status, provider: "other" } };
  assert.equal(targetHealth(51, [old], "0.4.0").reason, "version-mismatch");
  assert.equal(targetHealth(52, [otherProvider], "0.4.0").reason, "provider-mismatch");
});

test("late status and Start intents are discarded after a target switch", () => {
  assert.equal(isCurrentTargetRequest(61, 4, 62, 5), false);
  assert.equal(isCurrentTargetRequest(61, 4, 61, 4), true);
  assert.equal(canDispatchTargetIntent(61, 4, 61, 4, 1), false);
  assert.equal(canDispatchTargetIntent(61, 4, 61, 4, 0), true);
  assert.equal(canDispatchTargetIntent(61, 4, 61, 4, 0, false), false);
});
