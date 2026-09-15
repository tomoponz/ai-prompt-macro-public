/*
  Settings page controller.

  This surface only reads and writes `aipm.settings.v1`. It sends no runtime
  messages, touches no Run state, and cannot influence Send behaviour. Changing a
  value here never mutates a Run: these are defaults for future Runs.
*/

import {
  ACCENT_OPTIONS,
  DELAY_SECONDS_MAX,
  DELAY_SECONDS_MIN,
  DENSITY_OPTIONS,
  DIAGNOSTICS_LEVEL_OPTIONS,
  MODE_OPTIONS,
  THEME_OPTIONS,
  loadSettings,
  saveSettings
} from "./settings-store.js";
import { applyAppearance } from "./theme.js";
import { themeById, themesByGroup, normalizeThemeId } from "./themes/registry.js";
import { recoveryModeDescription } from "./recovery-policy.js";

const el = {
  page: document.querySelector(".page"),
  status: document.querySelector("#saveStatus"),
  theme: document.querySelector("#theme"),
  themeHint: document.querySelector("#themeHint"),
  modeHint: document.querySelector("#modeHint"),
  accentHint: document.querySelector("#accentHint"),
  mode: document.querySelector("#mode"),
  accent: document.querySelector("#accent"),
  density: document.querySelector("#density"),
  keepAwake: document.querySelector("#keepAwake"),
  delaySeconds: document.querySelector("#delaySeconds"),
  delaySecondsHint: document.querySelector("#delaySecondsHint"),
  maxSends: document.querySelector("#maxSends"),
  recoveryMode: document.querySelector("#recoveryMode"),
  recoveryModeDescription: document.querySelector("#recoveryModeDescription"),
  diagnosticsLevel: document.querySelector("#diagnosticsLevel")
};

/* Last value confirmed to be in storage. Never populated from an unread or
   failed read, so the UI can always tell "stored" from "not stored". */
let confirmed = null;
let saveQueue = Promise.resolve();
const darkQuery = globalThis.matchMedia?.("(prefers-color-scheme: dark)") ?? null;

/* The Settings form advertises the same whole-second boundary enforced by the
   Quick Runtime. Both the input contract and its visible explanation come from
   settings-store.js, whose maximum is derived from workflow.js. */
function configureExecutionBounds() {
  if (el.delaySeconds) {
    el.delaySeconds.min = String(DELAY_SECONDS_MIN);
    el.delaySeconds.max = String(DELAY_SECONDS_MAX);
  }
  if (el.delaySecondsHint) {
    el.delaySecondsHint.textContent = `${DELAY_SECONDS_MIN}〜${DELAY_SECONDS_MAX}秒。`;
  }
}

function setStatus(state, text) {
  if (!el.status) return;
  el.status.dataset.state = state;
  el.status.textContent = text;
}

/* The attribute mapping itself lives in theme.js, so this page, the Side Panel
   and the Workspace can never disagree about what a stored appearance means. */
function paintAppearance(appearance) {
  applyAppearance(document.documentElement, appearance, darkQuery?.matches === true);
}

/* One <optgroup> per catalogue group. textContent only: no display name is
   interpolated into markup. */
function buildThemeOptions() {
  if (!el.theme || el.theme.options.length > 0) return;
  for (const group of themesByGroup()) {
    if (group.themes.length === 0) continue;
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const entry of group.themes) {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = entry.displayName;
      optgroup.append(option);
    }
    el.theme.append(optgroup);
  }
}

const STANCE_NOTE = {
  both: "このテーマはライト / ダークの両方に対応しています。",
  light: "このテーマはライト表示専用です。外観モードの選択に関わらずライトで表示します。",
  dark: "このテーマはダーク表示専用です。外観モードの選択に関わらずダークで表示します。"
};

/*
  Says what the theme actually does, rather than implying every control applies
  to every theme. A pinned mode and an ignored accent are both stated plainly.
*/
function describeTheme(themeId) {
  const entry = themeById(themeId);
  if (el.modeHint) el.modeHint.textContent = STANCE_NOTE[entry.stance] ?? STANCE_NOTE.both;
  if (el.accentHint) {
    el.accentHint.textContent = entry.accentPolicy === "fixed"
      ? "このテーマは配色設計上、専用のアクセント色を使います。ここでの選択は保存されますが、このテーマの表示には適用しません。"
      : "開始などの主要ボタンと進捗バーの色です。状態表示（実行中・安全のため停止など）の色と意味は変わりません。";
  }
  if (el.mode) el.mode.disabled = entry.stance !== "both";
}

function render(settings) {
  buildThemeOptions();
  if (el.theme) el.theme.value = normalizeThemeId(settings.appearance.theme);
  describeTheme(settings.appearance.theme);
  if (el.mode) el.mode.value = settings.appearance.mode;
  if (el.accent) el.accent.value = settings.appearance.accent;
  if (el.density) el.density.value = settings.appearance.density;
  if (el.keepAwake) el.keepAwake.checked = settings.defaults.keepAwake === true;
  if (el.delaySeconds) el.delaySeconds.value = String(settings.defaults.delaySeconds);
  if (el.maxSends) el.maxSends.value = String(settings.defaults.maxSends);
  if (el.recoveryMode) el.recoveryMode.value = settings.defaults.recoveryMode;
  if (el.recoveryModeDescription) {
    el.recoveryModeDescription.textContent = recoveryModeDescription({ mode: settings.defaults.recoveryMode });
  }
  if (el.diagnosticsLevel) el.diagnosticsLevel.value = settings.display.diagnosticsLevel;
  paintAppearance(settings.appearance);
}

function readPatch() {
  return {
    appearance: {
      theme: THEME_OPTIONS.includes(el.theme?.value) ? el.theme.value : undefined,
      /* A pinned mode must not be written back as the user's preference: the
         stored mode stays whatever they chose for themes that honour it. */
      mode: MODE_OPTIONS.includes(el.mode?.value) ? el.mode.value : undefined,
      accent: ACCENT_OPTIONS.includes(el.accent?.value) ? el.accent.value : undefined,
      density: DENSITY_OPTIONS.includes(el.density?.value) ? el.density.value : undefined
    },
    defaults: {
      keepAwake: el.keepAwake?.checked === true,
      delaySeconds: el.delaySeconds?.value,
      maxSends: el.maxSends?.value,
      recoveryMode: el.recoveryMode?.value
    },
    display: {
      diagnosticsLevel: DIAGNOSTICS_LEVEL_OPTIONS.includes(el.diagnosticsLevel?.value)
        ? el.diagnosticsLevel.value
        : undefined
    }
  };
}

function commit() {
  /* Serialized so rapid edits cannot interleave a stale read-modify-write. */
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    setStatus("saving", "保存しています…");
    const patch = readPatch();
    /* Appearance is applied optimistically so the page responds immediately.
       It is presentation only; a failed save is still reported as failed. */
    const result = await saveSettings(patch);
    if (result.ok) {
      confirmed = result.settings;
      render(result.settings);
      setStatus("saved", "保存しました");
      return;
    }
    /* Keep the user's edit on screen, but never claim it was stored. */
    render(result.settings);
    setStatus(
      "error",
      result.error === "storage-unavailable"
        ? "保存できません（この環境では保存領域を利用できません）"
        : "保存できませんでした。もう一度お試しください。"
    );
  });
  return saveQueue;
}

function bind() {
  /* Appearance repaints on input, before the save round-trip, so the control the
     user just moved responds at once. It stays presentation only: a failed save
     is still reported as failed by commit() below. */
  for (const node of [el.theme, el.mode, el.accent, el.density]) {
    node?.addEventListener("change", () => {
      describeTheme(el.theme?.value);
      paintAppearance({
        theme: el.theme?.value,
        mode: el.mode?.value,
        accent: el.accent?.value,
        density: el.density?.value
      });
    });
  }

  const inputs = [el.theme, el.mode, el.accent, el.density, el.keepAwake, el.recoveryMode, el.diagnosticsLevel];
  for (const node of inputs) node?.addEventListener("change", () => commit());
  /* Numbers commit on blur/change rather than per keystroke, so a half-typed
     value is never persisted or clamped under the cursor. */
  for (const node of [el.delaySeconds, el.maxSends]) node?.addEventListener("change", () => commit());

  darkQuery?.addEventListener?.("change", () => {
    if (confirmed) paintAppearance(confirmed.appearance);
  });
}

async function initialize() {
  configureExecutionBounds();
  const result = await loadSettings();
  if (result.ok) {
    confirmed = result.settings;
    render(result.settings);
    setStatus("idle", "保存済みの設定を表示しています");
  } else {
    /* Defaults are rendered so the page is usable, but they are explicitly not
       presented as stored values. */
    render(result.settings);
    setStatus(
      "error",
      result.error === "storage-unavailable"
        ? "設定を読み込めません（この環境では保存領域を利用できません）"
        : "設定を読み込めませんでした。表示は初期値です。"
    );
  }
  el.page?.setAttribute("aria-busy", "false");
  bind();
}

initialize();
