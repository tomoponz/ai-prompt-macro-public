export const DEFAULT_BROWSER_PROFILE = "full";

export const BROWSER_PROFILES = Object.freeze(["smoke", "full", "torture"]);

const ALL_PROFILES = Object.freeze([...BROWSER_PROFILES]);

export const BROWSER_SCENARIO_GROUPS = Object.freeze([
  Object.freeze({
    id: "bootstrap",
    profiles: ALL_PROFILES,
    requires: Object.freeze([]),
    tags: Object.freeze(["startup", "target-selection"]),
    legacyScenarios: Object.freeze([
      "MV3 extension load",
      "two exact ChatGPT fixture tabs",
      "production-like ProseMirror composer shape"
    ])
  }),
  Object.freeze({
    id: "settings-wiring",
    profiles: Object.freeze(["full"]),
    requires: Object.freeze(["bootstrap"]),
    tags: Object.freeze(["settings"]),
    legacyScenarios: Object.freeze(["Settings Wiring across two exact tabs"])
  }),
  Object.freeze({
    id: "sidepanel-multitab",
    profiles: Object.freeze(["smoke", "full"]),
    requires: Object.freeze(["bootstrap"]),
    tags: Object.freeze(["side-panel", "multi-tab"]),
    legacyScenarios: Object.freeze([
      "Multi-Tab Visibility presentation metadata",
      "320/360/400/480/720px sticky Side Panel controls"
    ])
  }),
  Object.freeze({
    id: "workspace-boundary",
    profiles: Object.freeze(["smoke", "full"]),
    requires: Object.freeze(["bootstrap"]),
    tags: Object.freeze(["workspace"]),
    legacyScenarios: Object.freeze([
      "Workspace multi-run visibility",
      "Workspace 380/420/480 layout",
      "Workspace pure preview without renderer mutation"
    ])
  }),
  Object.freeze({
    id: "core-delivery-reload",
    profiles: Object.freeze(["smoke", "full"]),
    requires: Object.freeze(["bootstrap"]),
    tags: Object.freeze(["success", "exactly-once"]),
    legacyScenarios: Object.freeze([
      "normal Start and whitespace-preserving Send",
      "three sends exactly once",
      "durable reload recovery",
      "non-target tab receives zero sends",
      "assistant output remains out of extension storage"
    ])
  }),
  // The live failure class: a delivered send whose acceptance evidence was transient.
  // It belongs in SMOKE because it is the shape production actually failed on, and it is
  // the one repeat scenario deliberately calibrated against a SHORT generation window.
  Object.freeze({
    id: "short-reply-delivery",
    profiles: ALL_PROFILES,
    requires: Object.freeze(["bootstrap"]),
    tags: Object.freeze(["success", "exactly-once", "delivery-certainty"]),
    legacyScenarios: Object.freeze([
      "short reply Repeat=20 confirms every delivered send"
    ])
  }),
  Object.freeze({
    id: "parallel-repeat-stress",
    profiles: Object.freeze(["torture"]),
    requires: Object.freeze(["bootstrap"]),
    tags: Object.freeze(["success", "exactly-once", "multi-tab", "stress"]),
    legacyScenarios: Object.freeze([
      "two independent tabs complete Repeat=20 concurrently"
    ])
  }),
  Object.freeze({
    id: "attachment-guard",
    profiles: Object.freeze(["smoke", "full"]),
    requires: Object.freeze(["bootstrap"]),
    tags: Object.freeze(["fail-closed", "stop", "attachment"]),
    legacyScenarios: Object.freeze([
      "C7 pre-existing attachment blocks Start",
      "C7 residual attachment blocks a fresh Run",
      "Stop terminates attachment-blocked Runs"
    ])
  }),
  Object.freeze({
    id: "attachment-baseline",
    profiles: Object.freeze(["full"]),
    requires: Object.freeze(["bootstrap"]),
    tags: Object.freeze(["attachment", "success"]),
    legacyScenarios: Object.freeze([
      "C9 single paste attachment delivery",
      "production adapter minimal-residue Repeat=5",
      "production adapter 48KB/64KB pasted-text delivery"
    ])
  }),
  Object.freeze({
    id: "attachment-repeat-stress",
    profiles: Object.freeze(["torture"]),
    requires: Object.freeze(["bootstrap"]),
    tags: Object.freeze(["attachment", "exactly-once", "stress"]),
    repeat40: true,
    legacyScenarios: Object.freeze([
      "C9 attachment Repeat=5/20/40",
      "C10 live pasted-text Repeat=1/5/20/40",
      "C10.2 live file-tile Repeat=1/5/20/40",
      "C10.3 depth-7 Repeat=1/5/20/40",
      "C10.4 three-button Repeat=1/3/20"
    ])
  }),
  Object.freeze({
    id: "attachment-compatibility-safety",
    profiles: Object.freeze(["full"]),
    requires: Object.freeze(["bootstrap"]),
    tags: Object.freeze(["attachment", "fail-closed", "stop", "identity"]),
    legacyScenarios: Object.freeze([
      "C10.3 depth boundaries and actionable Send",
      "C10.3 never-actionable Send bounded fail-closed",
      "C10.3 pre-existing depth-7 tile",
      "C10.2 remove semantics and multiple tiles",
      "C10.2 pre-existing live file tile blocks Start",
      "C10.2 user and Stop races",
      "C10.2 bounded identity recovery"
    ])
  }),
  Object.freeze({
    id: "attachment-settlement-stress",
    profiles: Object.freeze(["torture"]),
    requires: Object.freeze(["bootstrap"]),
    tags: Object.freeze(["attachment", "fail-closed", "stop", "stress"]),
    legacyScenarios: Object.freeze([
      "C10.1 5-second and 20-second settlement",
      "C10.1 bounded settlement timeout",
      "C10.1 trusted interaction and Stop races",
      "C10 extra/text/outside-surface failures",
      "C9 extra attachment, trusted interaction, and Stop races"
    ])
  }),
  Object.freeze({
    id: "renderer-delay-identity",
    profiles: Object.freeze(["torture"]),
    requires: Object.freeze(["bootstrap"]),
    tags: Object.freeze(["identity", "exactly-once", "stress"]),
    legacyScenarios: Object.freeze([
      "post-confirmed same-document renderer stall"
    ])
  }),
  Object.freeze({
    id: "identity-recovery-stress",
    profiles: Object.freeze(["torture"]),
    requires: Object.freeze(["bootstrap"]),
    tags: Object.freeze(["identity", "exactly-once", "stress"]),
    repeat40: true,
    legacyScenarios: Object.freeze([
      "Issue #23 Repeat=40 identity-boundary collapse",
      "C11 short identity blackout",
      "C11 five-second identity blackout",
      "C11 document lifecycle invalidation"
    ])
  }),
  Object.freeze({
    id: "core-recovery",
    profiles: Object.freeze(["smoke", "full"]),
    requires: Object.freeze(["bootstrap"]),
    tags: Object.freeze(["fail-closed", "exactly-once", "stop"]),
    legacyScenarios: Object.freeze([
      "ambiguous reload no-retry",
      "New Chat explicit Resume",
      "same-document navigation fail-closed"
    ])
  })
]);

export function parseBrowserProfile(args = []) {
  if (args.length === 0) return DEFAULT_BROWSER_PROFILE;
  if (args.length !== 1 || !args[0].startsWith("--profile=")) {
    throw new Error("Expected exactly one optional --profile=smoke|full|torture argument");
  }
  const profile = args[0].slice("--profile=".length);
  if (!BROWSER_PROFILES.includes(profile)) {
    throw new Error(`Unknown browser profile: ${profile || "(empty)"}`);
  }
  return profile;
}

export function scenarioGroupsForProfile(profile) {
  if (!BROWSER_PROFILES.includes(profile)) throw new Error(`Unknown browser profile: ${profile}`);
  return BROWSER_SCENARIO_GROUPS.filter((group) => group.profiles.includes(profile));
}

export function scenarioGroupIdsForProfile(profile) {
  return scenarioGroupsForProfile(profile).map((group) => group.id);
}

export function releaseCoverageGaps() {
  return BROWSER_SCENARIO_GROUPS
    .filter((group) => !group.profiles.includes("full") && !group.profiles.includes("torture"))
    .map((group) => group.id);
}
