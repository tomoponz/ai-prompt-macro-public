/*
  Global extension settings (Phase 1 of the three-surface UI architecture).

  Scope boundary
  --------------
  This module owns ONLY extension-local configuration. It never reads or writes
  Run state, lease state, document identity, conversation identity or the
  execution session. Settings corruption must never be able to change how a Run
  executes, so every value returned by this module is normalized into a bounded,
  known-enum shape and unknown fields are dropped rather than passed through.

  These values are GLOBAL DEFAULTS. They describe what a *future* Run should be
  created with. They are not applied to a Run that is already running: a Run
  carries its own settings from the moment it was created.
*/

import { RECOVERY_MODES } from "./recovery-policy.js";
import { MAX_DELAY_MS, MAX_SENDS_PER_RUN } from "./workflow.js";
import { DEFAULT_THEME_ID, THEME_IDS, normalizeThemeId } from "./themes/registry.js";

export const SETTINGS_STORAGE_KEY = "aipm.settings.v1";
export const SETTINGS_SCHEMA_VERSION = 1;

/* Appearance enums.

   `theme` is the visual language and `mode` is the luminance; they stay
   separate axes. The catalogue itself lives in themes/registry.js so the list
   of themes and their per-theme rules (stance, accent policy) cannot drift
   apart from one another.

   `accent` never carries status meaning. It is bounded here purely so that a
   corrupt stored value cannot reach a stylesheet. */
export const THEME_OPTIONS = THEME_IDS;
export const MODE_OPTIONS = ["system", "light", "dark"];
export const ACCENT_OPTIONS = ["theme", "amber", "violet", "green"];
export const DENSITY_OPTIONS = ["comfortable", "compact"];
export const DIAGNOSTICS_LEVEL_OPTIONS = ["summary", "detailed"];

export const DELAY_SECONDS_MIN = 0;
/* Quick prompt delay is owned by workflow.js. Settings stores whole seconds,
   so derive its ceiling from the execution bound instead of maintaining a
   second, potentially wider limit. */
export const DELAY_SECONDS_MAX = Math.floor(MAX_DELAY_MS / 1000);
export const MAX_SENDS_MIN = 1;
/* The per-Run ceiling is owned by workflow.js. It is imported rather than
   duplicated so a settings value can never exceed the execution bound. */
export const MAX_SENDS_MAX = MAX_SENDS_PER_RUN;

export const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_SCHEMA_VERSION,
  appearance: Object.freeze({
    theme: DEFAULT_THEME_ID,
    mode: "system",
    accent: "theme",
    density: "comfortable"
  }),
  defaults: Object.freeze({
    keepAwake: false,
    delaySeconds: 0,
    maxSends: 1,
    recoveryMode: "safe"
  }),
  display: Object.freeze({
    diagnosticsLevel: "summary"
  })
});

function pickEnum(value, allowed, fallback) {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}

function pickBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function pickInteger(value, min, max, fallback) {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.trunc(parsed);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/*
  Accepts anything at all: null, a string, an array, an old shape, a partial
  object, unknown enum members, out-of-range numbers. Always returns a complete,
  frozen, bounded settings object. Unknown fields are dropped, so nothing that
  was not explicitly modelled here can reach a consumer.
*/
export function normalizeSettings(input) {
  const root = plainObject(input);
  const appearance = plainObject(root.appearance);
  const defaults = plainObject(root.defaults);
  const display = plainObject(root.display);

  return Object.freeze({
    version: SETTINGS_SCHEMA_VERSION,
    appearance: Object.freeze({
      /* Not pickEnum: a stored theme may be a legacy id that must MIGRATE
         rather than fall back. `normalizeThemeId` maps "eva" to the design it
         has always meant (eva-restrained) and anything unknown to default. */
      theme: normalizeThemeId(appearance.theme),
      mode: pickEnum(appearance.mode, MODE_OPTIONS, DEFAULT_SETTINGS.appearance.mode),
      accent: pickEnum(appearance.accent, ACCENT_OPTIONS, DEFAULT_SETTINGS.appearance.accent),
      density: pickEnum(appearance.density, DENSITY_OPTIONS, DEFAULT_SETTINGS.appearance.density)
    }),
    defaults: Object.freeze({
      keepAwake: pickBoolean(defaults.keepAwake, DEFAULT_SETTINGS.defaults.keepAwake),
      delaySeconds: pickInteger(
        defaults.delaySeconds, DELAY_SECONDS_MIN, DELAY_SECONDS_MAX, DEFAULT_SETTINGS.defaults.delaySeconds
      ),
      maxSends: pickInteger(defaults.maxSends, MAX_SENDS_MIN, MAX_SENDS_MAX, DEFAULT_SETTINGS.defaults.maxSends),
      recoveryMode: pickEnum(defaults.recoveryMode, RECOVERY_MODES, DEFAULT_SETTINGS.defaults.recoveryMode)
    }),
    display: Object.freeze({
      diagnosticsLevel: pickEnum(
        display.diagnosticsLevel, DIAGNOSTICS_LEVEL_OPTIONS, DEFAULT_SETTINGS.display.diagnosticsLevel
      )
    })
  });
}

/* Merges a partial patch over current settings, then normalizes the result.
   Section-level merge only: callers cannot introduce new sections. */
export function mergeSettings(current, patch) {
  const base = normalizeSettings(current);
  const next = plainObject(patch);
  return normalizeSettings({
    version: SETTINGS_SCHEMA_VERSION,
    appearance: { ...base.appearance, ...plainObject(next.appearance) },
    defaults: { ...base.defaults, ...plainObject(next.defaults) },
    display: { ...base.display, ...plainObject(next.display) }
  });
}

function resolveArea(area) {
  if (area) return area;
  return globalThis.chrome?.storage?.local ?? null;
}

/*
  Reads settings. Never throws.

  `ok:false` means the stored value could not be read. The caller MUST NOT
  present the returned settings as a confirmed stored value in that case; the
  defaults are supplied only so the UI has something safe to render.
*/
export async function loadSettings(area = null) {
  const storage = resolveArea(area);
  if (!storage?.get) {
    return { ok: false, settings: DEFAULT_SETTINGS, error: "storage-unavailable" };
  }
  try {
    const stored = await storage.get(SETTINGS_STORAGE_KEY);
    return { ok: true, settings: normalizeSettings(stored?.[SETTINGS_STORAGE_KEY]), error: null };
  } catch {
    return { ok: false, settings: DEFAULT_SETTINGS, error: "storage-read-failed" };
  }
}

/*
  Applies a patch and persists it. Never throws.

  `ok:false` means nothing was persisted. The caller MUST NOT report success.
  The returned `settings` is what *would* have been written, so the UI can keep
  showing the user's edit while clearly marking it as unsaved.
*/
export async function saveSettings(patch, area = null) {
  const storage = resolveArea(area);
  if (!storage?.get || !storage?.set) {
    return { ok: false, settings: normalizeSettings(patch), error: "storage-unavailable" };
  }
  let current = DEFAULT_SETTINGS;
  try {
    const stored = await storage.get(SETTINGS_STORAGE_KEY);
    current = normalizeSettings(stored?.[SETTINGS_STORAGE_KEY]);
  } catch {
    /* A read failure here is recoverable: fall back to defaults and still try to
       persist the user's explicit choice rather than silently discarding it. */
    current = DEFAULT_SETTINGS;
  }
  const next = mergeSettings(current, patch);
  try {
    await storage.set({ [SETTINGS_STORAGE_KEY]: next });
    return { ok: true, settings: next, error: null };
  } catch {
    return { ok: false, settings: next, error: "storage-write-failed" };
  }
}

/* Resolves `mode: "system"` against the host preference. Appearance only —
   this value never participates in any authority decision. */
export function resolveAppearanceMode(mode, prefersDark = false) {
  const normalized = pickEnum(mode, MODE_OPTIONS, DEFAULT_SETTINGS.appearance.mode);
  if (normalized !== "system") return normalized;
  return prefersDark ? "dark" : "light";
}
