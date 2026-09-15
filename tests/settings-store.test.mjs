import assert from "node:assert/strict";
import test from "node:test";

import {
  DELAY_SECONDS_MAX,
  DELAY_SECONDS_MIN,
  DEFAULT_SETTINGS,
  MAX_SENDS_MAX,
  SETTINGS_SCHEMA_VERSION,
  SETTINGS_STORAGE_KEY,
  loadSettings,
  mergeSettings,
  normalizeSettings,
  resolveAppearanceMode,
  saveSettings
} from "../src/settings-store.js";
import { MAX_DELAY_MS, MAX_SENDS_PER_RUN } from "../src/workflow.js";
import { RECOVERY_MODES } from "../src/recovery-policy.js";

/* Fake storage area recording every key it is asked to touch, so a test can
   prove settings persistence never reaches Run/lease/identity keys. */
function fakeArea({ data = {}, failGet = false, failSet = false } = {}) {
  const touched = { get: [], set: [] };
  return {
    touched,
    data,
    async get(key) {
      touched.get.push(key);
      if (failGet) throw new Error("read failed");
      return key in data ? { [key]: data[key] } : {};
    },
    async set(entry) {
      touched.set.push(...Object.keys(entry));
      if (failSet) throw new Error("write failed");
      Object.assign(data, entry);
    }
  };
}

test("storage key follows the existing aipm.<name>.vN convention", () => {
  assert.equal(SETTINGS_STORAGE_KEY, "aipm.settings.v1");
  assert.match(SETTINGS_STORAGE_KEY, /^aipm\.[a-zA-Z]+\.v\d+$/);
});

test("defaults are complete, frozen and versioned", () => {
  assert.equal(DEFAULT_SETTINGS.version, SETTINGS_SCHEMA_VERSION);
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS.appearance));
  assert.deepEqual(Object.keys(DEFAULT_SETTINGS).sort(), ["appearance", "defaults", "display", "version"]);
});

test("normalize survives null, primitives, arrays and old shapes", () => {
  for (const input of [null, undefined, 0, "settings", [], true, { appearance: "dark" }, { version: 99 }]) {
    const settings = normalizeSettings(input);
    assert.equal(settings.version, SETTINGS_SCHEMA_VERSION);
    assert.equal(settings.appearance.mode, "system");
    assert.equal(settings.defaults.recoveryMode, "safe");
    assert.equal(settings.display.diagnosticsLevel, "summary");
  }
});

test("normalize keeps partial data and fills the rest with defaults", () => {
  const settings = normalizeSettings({ appearance: { mode: "dark" }, defaults: { maxSends: 7 } });
  assert.equal(settings.appearance.mode, "dark");
  assert.equal(settings.appearance.density, "comfortable");
  assert.equal(settings.defaults.maxSends, 7);
  assert.equal(settings.defaults.keepAwake, false);
});

test("unknown enum members fall back to defaults", () => {
  /* "eva" used to stand in for an unknown theme here. It is a real theme now,
     so the fixture uses a value that is still outside every enum. */
  const settings = normalizeSettings({
    appearance: { theme: "hologram", mode: "sepia", accent: "neon", density: "roomy" },
    defaults: { recoveryMode: "aggressive" },
    display: { diagnosticsLevel: "verbose" }
  });
  assert.equal(settings.appearance.theme, "default");
  assert.equal(settings.appearance.mode, "system");
  assert.equal(settings.appearance.accent, "theme");
  assert.equal(settings.appearance.density, "comfortable");
  assert.equal(settings.defaults.recoveryMode, "safe");
  assert.equal(settings.display.diagnosticsLevel, "summary");
});

test("default delay boundary is derived from the Quick Runtime ceiling", () => {
  assert.equal(DELAY_SECONDS_MIN, 0);
  assert.equal(DELAY_SECONDS_MAX, Math.floor(MAX_DELAY_MS / 1000));
  assert.equal(DELAY_SECONDS_MAX, 300);
});

test("default delay normalization covers every runtime boundary", () => {
  const boundaries = [
    [-1, 0],
    [0, 0],
    [1, 1],
    [299, 299],
    [300, 300],
    [301, 300],
    [3600, 300],
    [Number.MAX_SAFE_INTEGER, 300],
    ["malformed", DEFAULT_SETTINGS.defaults.delaySeconds]
  ];
  for (const [input, expected] of boundaries) {
    assert.equal(
      normalizeSettings({ defaults: { delaySeconds: input } }).defaults.delaySeconds,
      expected,
      `delaySeconds=${String(input)}`
    );
  }
});

test("out-of-range numbers are clamped, not rejected", () => {
  assert.equal(normalizeSettings({ defaults: { maxSends: 0 } }).defaults.maxSends, 1);
  assert.equal(normalizeSettings({ defaults: { maxSends: 9999 } }).defaults.maxSends, MAX_SENDS_MAX);
  assert.equal(normalizeSettings({ defaults: { delaySeconds: 12.9 } }).defaults.delaySeconds, 12);
  assert.equal(normalizeSettings({ defaults: { maxSends: "8" } }).defaults.maxSends, 8);
  assert.equal(normalizeSettings({ defaults: { maxSends: Number.NaN } }).defaults.maxSends, 1);
});

test("stored legacy delay values clamp to the current Quick Runtime ceiling on load", async () => {
  for (const [stored, expected] of [[300, 300], [301, 300], [3600, 300]]) {
    const area = fakeArea({
      data: { [SETTINGS_STORAGE_KEY]: { defaults: { delaySeconds: stored } } }
    });
    const result = await loadSettings(area);
    assert.equal(result.ok, true);
    assert.equal(result.settings.defaults.delaySeconds, expected, `stored delaySeconds=${stored}`);
  }
});

test("maxSends can never exceed the per-Run execution ceiling", () => {
  assert.equal(MAX_SENDS_MAX, MAX_SENDS_PER_RUN);
  assert.ok(normalizeSettings({ defaults: { maxSends: MAX_SENDS_PER_RUN + 25 } }).defaults.maxSends <= MAX_SENDS_PER_RUN);
});

test("recovery mode values stay inside the existing recovery policy enum", () => {
  for (const mode of RECOVERY_MODES) {
    assert.equal(normalizeSettings({ defaults: { recoveryMode: mode } }).defaults.recoveryMode, mode);
  }
});

test("unknown fields are dropped and never reach a consumer", () => {
  const settings = normalizeSettings({
    appearance: { mode: "dark", secretFlag: true },
    defaults: { maxSends: 3, allowUnsafeSend: true },
    display: { diagnosticsLevel: "detailed", readAssistantOutput: true },
    runOverride: { status: "running" }
  });
  assert.equal("secretFlag" in settings.appearance, false);
  assert.equal("allowUnsafeSend" in settings.defaults, false);
  assert.equal("readAssistantOutput" in settings.display, false);
  assert.equal("runOverride" in settings, false);
});

test("merge applies a section patch without dropping other sections", () => {
  const base = normalizeSettings({ appearance: { mode: "dark" }, defaults: { maxSends: 9 } });
  const merged = mergeSettings(base, { display: { diagnosticsLevel: "detailed" } });
  assert.equal(merged.appearance.mode, "dark");
  assert.equal(merged.defaults.maxSends, 9);
  assert.equal(merged.display.diagnosticsLevel, "detailed");
});

test("load returns normalized defaults when nothing is stored", async () => {
  const area = fakeArea();
  const result = await loadSettings(area);
  assert.equal(result.ok, true);
  assert.deepEqual(result.settings, DEFAULT_SETTINGS);
});

test("save then load restores the stored value", async () => {
  const area = fakeArea();
  const saved = await saveSettings({ appearance: { mode: "dark", density: "compact" }, defaults: { maxSends: 12 } }, area);
  assert.equal(saved.ok, true);

  const reloaded = await loadSettings(area);
  assert.equal(reloaded.ok, true);
  assert.equal(reloaded.settings.appearance.mode, "dark");
  assert.equal(reloaded.settings.appearance.density, "compact");
  assert.equal(reloaded.settings.defaults.maxSends, 12);
});

test("malformed stored value normalizes on read instead of throwing", async () => {
  const area = fakeArea({ data: { [SETTINGS_STORAGE_KEY]: "not-an-object" } });
  const result = await loadSettings(area);
  assert.equal(result.ok, true);
  assert.deepEqual(result.settings, DEFAULT_SETTINGS);
});

test("storage read failure reports failure and never claims a stored value", async () => {
  const result = await loadSettings(fakeArea({ failGet: true }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "storage-read-failed");
  assert.deepEqual(result.settings, DEFAULT_SETTINGS);
});

test("storage write failure reports failure and persists nothing", async () => {
  const area = fakeArea({ failSet: true });
  const result = await saveSettings({ appearance: { mode: "dark" } }, area);
  assert.equal(result.ok, false);
  assert.equal(result.error, "storage-write-failed");
  assert.equal(SETTINGS_STORAGE_KEY in area.data, false);
});

test("missing storage area is reported, not silently treated as success", async () => {
  const read = await loadSettings({});
  const write = await saveSettings({ appearance: { mode: "dark" } }, {});
  assert.equal(read.ok, false);
  assert.equal(read.error, "storage-unavailable");
  assert.equal(write.ok, false);
  assert.equal(write.error, "storage-unavailable");
});

test("settings persistence touches only the settings key", async () => {
  const area = fakeArea();
  await saveSettings({ defaults: { keepAwake: true } }, area);
  await loadSettings(area);
  const all = [...area.touched.get, ...area.touched.set];
  assert.ok(all.length > 0);
  for (const key of all) assert.equal(key, SETTINGS_STORAGE_KEY);
});

test("settings never write Run, lease, identity or session keys", async () => {
  const area = fakeArea();
  await saveSettings({ appearance: { mode: "dark" }, defaults: { recoveryMode: "completion" } }, area);
  const forbidden = [
    "aipm.activeRun.v1", "aipm.leases.v1", "aipm.executionSession.v1",
    "aipm.quarantinedRuns.v1", "aipm.uiByTab.v2", "aipm.schedules.v1",
    "aipm.alarmSignals.v1", "aipm.flowLibrary.v1", "aipm.diagnostics.v1"
  ];
  for (const key of forbidden) {
    assert.equal(key in area.data, false, `${key} must not be written by settings`);
    assert.equal(area.touched.set.includes(key), false);
  }
});

test("changing the recovery default does not describe a running Run", async () => {
  /* A Run carries the policy it was created with. Settings only produce a value
     for a future Run, so the stored settings object must contain no Run fields. */
  const area = fakeArea();
  const saved = await saveSettings({ defaults: { recoveryMode: "completion" } }, area);
  const stored = area.data[SETTINGS_STORAGE_KEY];
  assert.equal(saved.settings.defaults.recoveryMode, "completion");
  for (const runField of ["runId", "status", "phase", "outbox", "cursor", "stateRevision", "conversationKey"]) {
    assert.equal(runField in stored, false);
  }
});

test("system appearance mode resolves against the host preference only", () => {
  assert.equal(resolveAppearanceMode("system", true), "dark");
  assert.equal(resolveAppearanceMode("system", false), "light");
  assert.equal(resolveAppearanceMode("dark", false), "dark");
  assert.equal(resolveAppearanceMode("light", true), "light");
  assert.equal(resolveAppearanceMode("nonsense", true), "dark");
});
