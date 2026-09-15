import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BROWSER_SCENARIO_GROUPS,
  DEFAULT_BROWSER_PROFILE,
  parseBrowserProfile,
  releaseCoverageGaps,
  scenarioGroupIdsForProfile,
  scenarioGroupsForProfile
} from "./browser-profiles.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const fixturePath = path.join(repoRoot, "tests", "browser-fixture-e2e.mjs");
const fixtureSource = fs.readFileSync(fixturePath, "utf8");

test("A: direct execution defaults explicitly to FULL", () => {
  assert.equal(DEFAULT_BROWSER_PROFILE, "full");
  assert.equal(parseBrowserProfile([]), "full");
});

test("B-D: smoke, full, and torture select only their declared groups", () => {
  for (const profile of ["smoke", "full", "torture"]) {
    assert.equal(parseBrowserProfile([`--profile=${profile}`]), profile);
    const selected = scenarioGroupsForProfile(profile);
    assert.ok(selected.length > 0);
    assert.ok(selected.every((group) => group.profiles.includes(profile)));
  }
});

test("E: malformed, duplicate, and unknown profile arguments fail fast", () => {
  for (const args of [["--profile=garbage"], ["--profile="], ["smoke"], ["--profile=smoke", "extra"]]) {
    assert.throws(() => parseBrowserProfile(args), /profile|argument/i);
  }
});

test("E: the real fixture rejects an unknown profile before launching a browser", () => {
  const result = spawnSync(process.execPath, [fixturePath, "--profile=garbage"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown browser profile: garbage/);
  assert.doesNotMatch(result.stdout, /Browser profile:/);
});

test("F: every legacy scenario group remains in FULL or TORTURE release coverage", () => {
  assert.deepEqual(releaseCoverageGaps(), []);
  assert.ok(BROWSER_SCENARIO_GROUPS.every((group) => group.legacyScenarios.length > 0));
});

test("F: fixture gates and coverage manifest have no orphan scenario group", () => {
  const referenced = [...fixtureSource.matchAll(/runsScenarioGroup\("([^"]+)"\)/g)]
    .map((match) => match[1])
    .sort();
  const declared = BROWSER_SCENARIO_GROUPS
    .map((group) => group.id)
    .filter((id) => id !== "bootstrap")
    .sort();
  assert.deepEqual(referenced, declared);
});

test("G: every Repeat40 group is TORTURE-only and remains Repeat40", () => {
  const repeat40Groups = BROWSER_SCENARIO_GROUPS.filter((group) => group.repeat40 === true);
  assert.deepEqual(repeat40Groups.map((group) => group.id), [
    "attachment-repeat-stress",
    "identity-recovery-stress"
  ]);
  assert.ok(repeat40Groups.every((group) => group.profiles.includes("torture")));
  assert.ok(repeat40Groups.every((group) => !group.profiles.includes("smoke")));
  assert.match(fixtureSource, /for \(const repeat of \[5, 20, 40\]\)/);
  assert.match(fixtureSource, /repeat: 40, delaySeconds: 0/);
  assert.match(fixtureSource, /Repeat=40 must produce exactly 40 sends/);
});

test("profile gating preserves existing assertions, timeouts, and fault intensity", () => {
  assert.ok((fixtureSource.match(/assert\./g) ?? []).length >= 204);
  assert.match(fixtureSource, /const TEST_TIMEOUT_MS = 25_000/);
  assert.match(fixtureSource, /const LONG_RUN_TIMEOUT_MS = 240_000/);
  assert.match(fixtureSource, /for \(const repeat of \[1, 5, 20, 40\]\)/);
  assert.doesNotMatch(fixtureSource, /(?:test|describe|it)\.skip\b/);
});

test("H: stress groups never enter SMOKE", () => {
  const smoke = new Set(scenarioGroupIdsForProfile("smoke"));
  const stress = BROWSER_SCENARIO_GROUPS.filter((group) => group.tags.includes("stress"));
  assert.ok(stress.length >= 3);
  assert.ok(stress.every((group) => !smoke.has(group.id)));
});

test("I: SMOKE represents success, fail-closed, exactly-once, Stop, attachment, and Workspace", () => {
  const tags = new Set(scenarioGroupsForProfile("smoke").flatMap((group) => group.tags));
  for (const required of ["success", "fail-closed", "exactly-once", "stop", "attachment", "workspace"]) {
    assert.ok(tags.has(required), `SMOKE is missing ${required}`);
  }
});

test("J: every profile contains the bootstrap required by all standalone groups", () => {
  for (const profile of ["smoke", "full", "torture"]) {
    const selected = new Set(scenarioGroupIdsForProfile(profile));
    assert.ok(selected.has("bootstrap"));
    for (const group of scenarioGroupsForProfile(profile)) {
      assert.ok(group.requires.every((required) => selected.has(required)), `${profile}:${group.id}`);
    }
  }
});

test("C10.2 pre-existing live file tile remains in FULL", () => {
  const fullScenarios = scenarioGroupsForProfile("full").flatMap((group) => group.legacyScenarios);
  assert.ok(fullScenarios.includes("C10.2 pre-existing live file tile blocks Start"));
});

test("npm scripts expose Windows-compatible profile arguments and ordered release aggregation", () => {
  const scripts = packageJson.scripts;
  assert.equal(scripts["test:browser"], "npm run test:browser:full");
  assert.equal(scripts["test:browser:smoke"], "node tests/browser-fixture-e2e.mjs --profile=smoke");
  assert.equal(scripts["test:browser:full"], "node tests/browser-fixture-e2e.mjs --profile=full");
  assert.equal(scripts["test:browser:torture"], "node tests/browser-fixture-e2e.mjs --profile=torture");
  assert.equal(scripts["test:browser:release"], "npm run test:browser:full && npm run test:browser:torture");
});
