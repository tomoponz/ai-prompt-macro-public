/*
  Theme catalogue render harness.

  Every theme in the catalogue is rendered in a real browser, on all three real
  extension pages, and measured. This is deliberately a SEPARATE harness from
  tests/browser-fixture-e2e.mjs: that fixture exercises Send, Stop and delivery
  certainty, and must not be loaded down with presentation checks.

  Nothing here starts a Run, contacts a ChatGPT renderer, or touches Run state.
  The only thing written is the appearance section of the settings key, through
  the same storage path the Settings page uses, so the real listener repaints.

  Tier 1  every theme, its native stance, comfortable density
          Side Panel @ 360 + Workspace desktop + Settings desktop
  Tier 2  structurally difficult themes at 320 / 360 / 380 / 420 / 480
  Tier 3  both-stance themes in light AND dark; every theme in compact density
  Tier 4  a bounded switch-stress cycle through the whole catalogue
*/

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

import { THEMES, THEME_IDS } from "../src/themes/registry.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const SETTINGS_KEY = "aipm.settings.v1";

/* Themes whose geometry is most likely to break a narrow panel: thick frames,
   large touch targets, dense tables, wide type, or an ornament. */
const RESPONSIVE_SUBSET = [
  "eva-command", "mecha", "industrial-control", "brutalist-utility",
  "operator-dense", "japanese-systems", "swiss-information", "eva-restrained"
];
const WIDTHS = [320, 360, 380, 420, 480];
const PRODUCT_DARK_BACKGROUNDS = Object.freeze({
  "chatgpt-native": "rgb(0, 0, 0)",
  "google-native": "rgb(15, 15, 15)",
  "claude-native": "rgb(21, 21, 21)",
  "microsoft-fluent": "rgb(32, 32, 32)",
  "apple-utility": "rgb(0, 0, 0)"
});
const EVIDENCE_DIR = process.env.AIPM_THEME_SCREENSHOT_DIR || null;
if (EVIDENCE_DIR) fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

function browserExecutable() {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ||
    path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  const dirs = fs.existsSync(cache)
    ? fs.readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort()
    : [];
  for (const dir of dirs.reverse()) {
    for (const rel of [["chrome-win64", "chrome.exe"], ["chrome-win", "chrome.exe"],
      ["chrome-linux", "chrome"], ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"]]) {
      const candidate = path.join(cache, dir, ...rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error("chromium not found; run `npm run browser:install`");
}

let failures = 0;
const check = (label, fn) => {
  try {
    fn();
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${label}\n        ${error.message}`);
  }
};

async function waitForManualUxStylesheet(page) {
  await page.waitForFunction(
    () => [...document.styleSheets].some((sheet) => sheet.href?.endsWith("/themes/manual-ux.css")),
    null,
    { timeout: 5_000 }
  );
}

/*
  Drives the real Settings controls, exactly as a user does, and waits for the
  page to repaint. This is the path that proves every catalogue theme is genuinely
  selectable from the selector rather than only reachable through storage.
*/
async function applyThemeViaSettingsUi(page, appearance) {
  await page.evaluate(({ value }) => {
    const set = (id, v) => {
      const node = document.querySelector(id);
      if (!node || v == null) return;
      node.value = v;
      node.dispatchEvent(new Event("change", { bubbles: true }));
    };
    set("#theme", value.theme);
    set("#mode", value.mode);
    set("#accent", value.accent);
    set("#density", value.density);
  }, { value: appearance });
  await page.waitForFunction(
    (id) => document.documentElement.dataset.aipmTheme === id,
    appearance.theme,
    { timeout: 5_000 }
  );
  await waitForManualUxStylesheet(page);
  /* The Settings page paints optimistically and persists afterwards. Wait for
     its own "saved" signal so the write has actually landed before anything
     else writes the same key — otherwise a late save would race the next
     surface's write. This waits on real state, never on a fixed delay. */
  await page.waitForFunction(
    () => document.querySelector("#saveStatus")?.dataset.state === "saved",
    null,
    { timeout: 5_000 }
  );
}

/* Applies an appearance through the real storage path and waits for the
   surface's own listener to finish repainting. Used for the Side Panel and the
   Workspace, which subscribe to settings changes. */
async function applyTheme(page, appearance) {
  await page.evaluate(async ({ key, value }) => {
    const stored = await chrome.storage.local.get(key);
    const next = { ...(stored[key] ?? {}), appearance: { ...value } };
    await chrome.storage.local.set({ [key]: next });
  }, { key: SETTINGS_KEY, value: appearance });
  await page.waitForFunction(
    (id) => document.documentElement.dataset.aipmTheme === id,
    appearance.theme,
    { timeout: 5_000 }
  );
  await waitForManualUxStylesheet(page);
}

/* One measurement of a rendered surface. Reads geometry only. */
async function measure(page, controlSelector) {
  return page.evaluate((selector) => {
    const root = document.documentElement;
    const controls = [...document.querySelectorAll(selector)]
      .map((node) => ({ node, box: node.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && box.height > 0);
    const overflowing = [...document.querySelectorAll("body *")]
      .map((node) => ({ node, box: node.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && box.right > innerWidth + 0.5)
      .slice(0, 5)
      .map(({ node }) => `${node.tagName}.${String(node.className ?? "").slice(0, 40)}`);
    /* The theme ornament is deliberately inert and deliberately visible, so it
       is excluded here. This probe exists for the Phase 4D compatibility block
       and anything else that must never come back into view. */
    const hidden = [...document.querySelectorAll("[hidden], [inert]")]
      .filter((node) => !node.closest(".aipm-theme-decoration"));
    const hiddenVisible = hidden.filter((node) => {
      const box = node.getBoundingClientRect();
      return box.width > 0 || box.height > 0;
    }).length;
    const style = getComputedStyle(document.body);
    return {
      theme: root.dataset.aipmTheme,
      mode: root.dataset.aipmMode,
      accent: root.dataset.aipmAccent,
      density: root.dataset.aipmDensity,
      documentWidth: root.scrollWidth,
      viewportWidth: innerWidth,
      controlCount: controls.length,
      clipped: controls.filter(({ box }) => box.left < -0.5 || box.right > innerWidth + 0.5).length,
      overflowing,
      hiddenVisible,
      /* An ornament painting above a control would be a real defect, so probe
         the topmost element at each control centre. */
      ornamentOverControl: controls.filter(({ box }) => {
        const hit = document.elementFromPoint(
          Math.min(innerWidth - 1, Math.max(0, box.left + box.width / 2)),
          Math.min(innerHeight - 1, Math.max(0, box.top + box.height / 2))
        );
        return Boolean(hit?.closest?.(".aipm-theme-decoration"));
      }).length,
      bodyBackground: style.backgroundColor,
      bodyColor: style.color,
      fontFamily: style.fontFamily
    };
  }, controlSelector);
}

/* Captures the computed component language, not only palette tokens. Keeping
   this on real extension pages prevents a token-only implementation from
   passing merely because every catalogue id resolves to a different colour. */
async function fidelityFingerprint(page, selectors) {
  return page.evaluate((roles) => {
    const readStyle = (selector, pseudo = null) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const style = getComputedStyle(node, pseudo);
      return {
        background: style.background,
        color: style.color,
        border: style.border,
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        letterSpacing: style.letterSpacing,
        lineHeight: style.lineHeight,
        minHeight: style.minHeight,
        height: style.height,
        textTransform: style.textTransform,
        content: style.content
      };
    };
    return {
      body: readStyle("body"),
      surface: readStyle(roles.surface),
      badge: readStyle(roles.badge),
      progress: readStyle(roles.progress),
      progressOverlay: readStyle(roles.progress, "::after"),
      primary: readStyle(roles.primary),
      danger: readStyle(roles.danger),
      diagnostics: readStyle(roles.diagnostics),
      navigation: readStyle(roles.navigation)
    };
  }, selectors);
}

async function screenshot(page, name) {
  if (!EVIDENCE_DIR) return;
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: true });
}

function assertSane(label, m, { expectMode = null } = {}) {
  check(`${label} — no horizontal overflow`, () => {
    assert.ok(m.documentWidth <= m.viewportWidth,
      `${m.documentWidth} > ${m.viewportWidth}; overflowing: ${JSON.stringify(m.overflowing)}`);
  });
  check(`${label} — no clipped controls`, () => {
    assert.equal(m.clipped, 0, `${m.clipped} control(s) outside the viewport`);
  });
  check(`${label} — controls are present`, () => {
    assert.ok(m.controlCount > 0, "no visible controls were found at all");
  });
  check(`${label} — no ornament covers a control`, () => {
    assert.equal(m.ornamentOverControl, 0,
      `${m.ornamentOverControl} control(s) sit under the ornament`);
  });
  check(`${label} — hidden compatibility DOM stays hidden`, () => {
    assert.equal(m.hiddenVisible, 0, `${m.hiddenVisible} hidden/inert node(s) became visible`);
  });
  check(`${label} — theme actually painted`, () => {
    assert.ok(/rgb/.test(m.bodyBackground), `body background did not resolve: ${m.bodyBackground}`);
    assert.notEqual(m.bodyBackground, m.bodyColor, "background and text resolved to the same colour");
  });
  if (expectMode) {
    check(`${label} — stance pinned to ${expectMode}`, () => {
      assert.equal(m.mode, expectMode);
    });
  }
}

const startedAt = Date.now();
const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), "aipm-theme-render-"));
let context;

try {
  context = await chromium.launchPersistentContext(profilePath, {
    executablePath: browserExecutable(),
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${repoRoot}`, `--load-extension=${repoRoot}`]
  });

  const worker = context.serviceWorkers()[0] ??
    await context.waitForEvent("serviceworker", { timeout: 10_000 });
  const extensionId = new URL(worker.url()).host;

  const sidePanel = await context.newPage();
  await sidePanel.goto(`chrome-extension://${extensionId}/src/sidepanel.html`);
  const workspace = await context.newPage();
  await workspace.goto(`chrome-extension://${extensionId}/src/workspace.html`);
  await workspace.waitForFunction(
    () => document.querySelector(".workspace")?.getAttribute("aria-busy") === "false",
    null, { timeout: 10_000 }
  );
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/src/options.html`);
  await settings.waitForFunction(
    () => document.querySelector(".page")?.getAttribute("aria-busy") === "false",
    null, { timeout: 10_000 }
  );

  const SIDE_CONTROLS = ".actions button, .target-presentation-fields input, " +
    ".target-presentation-fields select, #targetTab, .run-state-badge";
  const WORKSPACE_CONTROLS = "#groupFilter, .nav-links button, .filter-chip, .nav-footer button";
  const SETTINGS_CONTROLS = "#theme, #mode, #accent, #density, #recoveryMode, #diagnosticsLevel";
  const fidelityFingerprints = new Map();

  for (const [name, page] of [["Side Panel", sidePanel], ["Workspace", workspace], ["Settings", settings]]) {
    const loaded = await page.evaluate(() => ({
      fidelity: [...document.styleSheets].some((sheet) => sheet.href?.endsWith("/themes/fidelity.css")),
      manualUx: [...document.styleSheets].some((sheet) => sheet.href?.endsWith("/themes/manual-ux.css"))
    }));
    check(`${name} loads the component fidelity layer`, () => assert.equal(loaded.fidelity, true));
    check(`${name} loads the reviewed manual UX layer`, () => assert.equal(loaded.manualUx, true));
  }

  /* ------------------------------------------------ the selector is complete */
  const offered = await settings.evaluate(() =>
    [...document.querySelectorAll("#theme option")].map((o) => o.value));
  check("Settings offers every catalogue theme", () => {
    assert.deepEqual([...offered].sort(), [...THEME_IDS].sort());
    assert.equal(offered.length, THEME_IDS.length);
  });
  /* Selecting a theme must repaint the Settings page itself immediately. */
  await applyThemeViaSettingsUi(settings, { theme: "brutalist-utility", mode: "system", accent: "theme", density: "comfortable" });
  const settingsRepaint = await settings.evaluate(() => document.documentElement.dataset.aipmTheme);
  check("Settings repaints itself on selection", () => {
    assert.equal(settingsRepaint, "brutalist-utility");
  });

  const groups = await settings.evaluate(() =>
    [...document.querySelectorAll("#theme optgroup")].map((g) => g.label));
  check("Settings groups the catalogue", () => {
    assert.ok(groups.length >= 4, `expected grouped options, saw ${groups.length} optgroups`);
  });

  /* ----------------------------------------------------------------- Tier 1 */
  console.log("Tier 1: every theme, native stance, three surfaces");
  await sidePanel.setViewportSize({ width: 360, height: 900 });
  for (const entry of THEMES) {
    const appearance = { theme: entry.id, mode: "system", accent: "violet", density: "comfortable" };
    const expectMode = entry.stance === "both" ? null : entry.stance;

    await applyTheme(sidePanel, appearance);
    assertSane(`side-panel/360 ${entry.id}`, await measure(sidePanel, SIDE_CONTROLS), { expectMode });
    const sideFingerprint = await fidelityFingerprint(sidePanel, {
      surface: ".card", badge: ".run-state-badge", progress: ".progress-track",
      primary: "button.primary", danger: "button.danger", diagnostics: ".diagnostics-card",
      navigation: "header button"
    });
    await screenshot(sidePanel, `${entry.id}-side-panel-360`);

    await applyTheme(workspace, appearance);
    assertSane(`workspace/desktop ${entry.id}`, await measure(workspace, WORKSPACE_CONTROLS), { expectMode });
    const workspaceFingerprint = await fidelityFingerprint(workspace, {
      surface: ".panel", badge: ".status-badge", progress: ".progress-track",
      primary: ".primary-action", danger: ".danger-action", diagnostics: ".diag-block",
      navigation: ".nav-links button.is-active"
    });
    await screenshot(workspace, `${entry.id}-workspace`);

    await applyThemeViaSettingsUi(settings, appearance);
    const m = await measure(settings, SETTINGS_CONTROLS);
    assertSane(`settings/desktop ${entry.id}`, m, { expectMode });
    const settingsFingerprint = await fidelityFingerprint(settings, {
      surface: ".card", badge: ".save-status", progress: ".field",
      primary: "button", danger: "button", diagnostics: ".scope-note",
      navigation: ".page-header"
    });
    await screenshot(settings, `${entry.id}-settings`);
    fidelityFingerprints.set(entry.id, JSON.stringify({
      side: sideFingerprint, workspace: workspaceFingerprint, settings: settingsFingerprint
    }));
    /* A fixed-accent theme must ignore the stored accent while keeping it. */
    check(`settings ${entry.id} — accent policy honoured`, () => {
      assert.equal(m.accent, entry.accentPolicy === "fixed" ? "theme" : "violet");
    });
  }
  const labFingerprints = THEMES
    .filter((entry) => entry.origin.startsWith("ui-lab:"))
    .map((entry) => fidelityFingerprints.get(entry.id));
  check("all 21 UI Lab themes retain a distinct rendered component system", () => {
    assert.equal(labFingerprints.length, 21);
    assert.equal(new Set(labFingerprints).size, 21, "two UI Lab themes render the same component fingerprint");
  });

  /* ----------------------------------------------------------------- Tier 2 */
  console.log("Tier 2: structurally difficult themes at 320-480px");
  for (const id of RESPONSIVE_SUBSET) {
    const modes = ["eva-command", "eva-restrained"].includes(id) ? ["light", "dark"] : ["system"];
    for (const mode of modes) {
      await applyTheme(sidePanel, { theme: id, mode, accent: "theme", density: "comfortable" });
      for (const width of WIDTHS) {
        await sidePanel.setViewportSize({ width, height: 900 });
        const m = await measure(sidePanel, SIDE_CONTROLS);
        assertSane(`side-panel/${width} ${id}/${mode}`, m, {
          expectMode: mode === "system" ? null : mode
        });
        // Idle disclosure hides these controls. Expand only the presentation
        // fixture for geometry, then restore it; never create or start a Run.
        const runControls = await sidePanel.evaluate(() => {
          const details = document.querySelector("#runDetails");
          const wasHidden = details.hidden;
          try {
            details.hidden = false;
            return [...document.querySelectorAll(".actions button")].map((button) => {
              const box = button.getBoundingClientRect();
              return { id: button.id, top: Math.round(box.top), left: box.left,
                right: box.right, width: box.width, height: box.height };
            });
          } finally {
            details.hidden = wasHidden;
          }
        });
        check(`side-panel/${width} ${id}/${mode} — three expanded Run controls fit one row`, () => {
          assert.deepEqual(runControls.map((control) => control.id), ["pause", "resume", "stop"]);
          assert.equal(new Set(runControls.map((control) => control.top)).size, 1);
          for (const [index, control] of runControls.entries()) {
            assert.ok(control.width > 0 && control.height > 0, `${control.id} must have visible bounds`);
            assert.ok(control.left >= -0.5 && control.right <= width + 0.5, `${control.id} must fit horizontally`);
            if (index > 0) assert.ok(control.left >= runControls[index - 1].right, "controls must not overlap");
          }
        });
        if (id === "eva-command") {
          const tileSizes = await sidePanel.evaluate(() => [...new Set(
            [...document.querySelectorAll(".aipm-hex-tile")]
              .map((tile) => Math.round(tile.getBoundingClientRect().width))
          )]);
          check(`side-panel/${width} ${id}/${mode} — tuned tile size`, () => {
            assert.deepEqual(tileSizes, [width <= 410 ? 53 : 56]);
          });
          await screenshot(sidePanel, `${id}-side-panel-${mode}-${width}`);
        }
        if (id === "eva-restrained") {
          await screenshot(sidePanel, `${id}-side-panel-${mode}-${width}`);
        }
      }
    }
  }
  await sidePanel.setViewportSize({ width: 360, height: 900 });

  /* ----------------------------------------------------------------- Tier 3 */
  console.log("Tier 3: both-stance modes and compact density");
  for (const entry of THEMES.filter((t) => t.stance === "both")) {
    for (const mode of ["light", "dark"]) {
      await applyTheme(sidePanel, { theme: entry.id, mode, accent: "theme", density: "comfortable" });
      const m = await measure(sidePanel, SIDE_CONTROLS);
      assertSane(`side-panel ${entry.id}/${mode}`, m, { expectMode: mode });
      if (mode === "dark" && Object.hasOwn(PRODUCT_DARK_BACKGROUNDS, entry.id)) {
        check(`side-panel ${entry.id}/dark — reviewed product background`, () => {
          assert.equal(m.bodyBackground, PRODUCT_DARK_BACKGROUNDS[entry.id]);
        });
        await screenshot(sidePanel, `${entry.id}-side-panel-dark`);
      }
      if (entry.id === "eva-command") await screenshot(sidePanel, `eva-command-side-panel-${mode}`);
      if (entry.id === "eva-restrained") {
        await screenshot(sidePanel, `eva-restrained-side-panel-${mode}`);
        await applyTheme(workspace, { theme: entry.id, mode, accent: "theme", density: "comfortable" });
        assertSane(`workspace ${entry.id}/${mode}`, await measure(workspace, WORKSPACE_CONTROLS), {
          expectMode: mode
        });
        await screenshot(workspace, `eva-restrained-workspace-${mode}`);
        await applyThemeViaSettingsUi(settings, { theme: entry.id, mode, accent: "theme", density: "comfortable" });
        assertSane(`settings ${entry.id}/${mode}`, await measure(settings, SETTINGS_CONTROLS), {
          expectMode: mode
        });
        await screenshot(settings, `eva-restrained-settings-${mode}`);
      }
    }
  }
  for (const entry of THEMES) {
    await applyTheme(sidePanel, { theme: entry.id, mode: "system", accent: "theme", density: "compact" });
    const m = await measure(sidePanel, SIDE_CONTROLS);
    assertSane(`side-panel/compact ${entry.id}`, m);
    check(`side-panel/compact ${entry.id} — density applied`, () => {
      assert.equal(m.density, "compact");
    });
    if (entry.id === "eva-restrained") {
      await screenshot(sidePanel, "eva-restrained-side-panel-compact");
      await applyTheme(workspace, { theme: entry.id, mode: "system", accent: "theme", density: "compact" });
      const workspaceCompact = await measure(workspace, WORKSPACE_CONTROLS);
      assertSane("workspace/compact eva-restrained", workspaceCompact);
      check("workspace/compact eva-restrained — density applied", () => {
        assert.equal(workspaceCompact.density, "compact");
      });
      await screenshot(workspace, "eva-restrained-workspace-compact");
      await applyThemeViaSettingsUi(settings, { theme: entry.id, mode: "system", accent: "theme", density: "compact" });
      const settingsCompact = await measure(settings, SETTINGS_CONTROLS);
      assertSane("settings/compact eva-restrained", settingsCompact);
      check("settings/compact eva-restrained — density applied", () => {
        assert.equal(settingsCompact.density, "compact");
      });
      await screenshot(settings, "eva-restrained-settings-compact");
    }
  }


  /* ----------------------------------------------------------------- Tier 5 */
  /*
    Product dark fidelity.

    "The body is dark" is not dark mode. This tier walks every rendered element
    on all three surfaces and composites each painted background over the
    theme's own canvas, so a light card, a light nested cell, a light sticky
    cockpit, a light form control or a light hairline is caught wherever it
    hides — including inside <details> that are shut at rest.

    The rule is a semantic signature rather than a table of expected pixels:
    on a dark canvas nothing may paint a light ground EXCEPT the design's own
    accent fill and its tab marker, both of which are light on purpose in the
    real products these themes follow.
  */
  console.log("Tier 5: product dark fidelity across three surfaces");

  const PRODUCT_DARK = ["chatgpt-native", "google-native", "claude-native", "microsoft-fluent", "apple-utility"];

  /* WCAG relative luminance and contrast, plus alpha compositing, evaluated in
     the page so the values are the ones the compositor actually uses. */
  const COLOUR_HELPERS = `
    const parse = (c) => {
      const m = /rgba?\\(([^)]+)\\)/.exec(c || "");
      if (!m) return null;
      const p = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const over = (fg, bg) => fg.a >= 1 ? fg : ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1
    });
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const L = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const ratio = (x, y) => { const a = L(x), b = L(y); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
    const hex = (s) => {
      s = (s || "").trim();
      if (s === "transparent" || s === "") return null;
      if (s.startsWith("#")) {
        const h = s.length === 4 ? s.slice(1).split("").map((c) => c + c).join("") : s.slice(1);
        return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16), a: 1 };
      }
      return parse(s);
    };
  `;

  const darkProbe = (page) => page.evaluate(`(() => {
    ${COLOUR_HELPERS}
    const cs = getComputedStyle(document.documentElement);
    const tok = (n) => cs.getPropertyValue(n).trim();
    const ground = hex(tok("--aipm-bg")) || parse(getComputedStyle(document.body).backgroundColor);
    /* Intentionally light: the accent fill and the tab colour marker. Both are
       light in the real products, and both are recorded so nothing else can
       quietly claim the same exemption. */
    const allowed = ["--aipm-accent", "--aipm-marker", "--aipm-focus", "--aipm-text",
      "--aipm-status-neutral"]
      .map(tok).map(hex).filter(Boolean)
      .map((c) => c.r + "," + c.g + "," + c.b);

    const sig = (n) => {
      const cl = String(n.className?.baseVal ?? n.className ?? "").trim().split(/\\s+/).filter(Boolean).slice(0,3).join(".");
      return n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") + (cl ? "." + cl : "");
    };

    const leaks = [];
    const nodes = [document.body, ...document.querySelectorAll("body *")];
    for (const n of nodes) {
      if (n.closest && n.closest(".aipm-theme-decoration")) continue;
      const st = getComputedStyle(n);
      if (st.display === "none") continue;
      const own = parse(st.backgroundColor);
      if (own && own.a > 0) {
        const key = Math.round(own.r) + "," + Math.round(own.g) + "," + Math.round(own.b);
        if (!allowed.includes(key)) {
          const flat = over(own, ground);
          if (L(flat) > 0.36) {
            leaks.push({ kind: "surface", sig: sig(n), value: st.backgroundColor, lum: +L(flat).toFixed(3) });
          }
        }
      }
      /* Per side: a zero-width border computes to currentColor and paints
         nothing, so only a side that is actually drawn can leak. */
      for (const side of ["Top", "Bottom", "Left", "Right"]) {
        if ((parseFloat(st["border" + side + "Width"]) || 0) <= 0) continue;
        if (st["border" + side + "Style"] === "none" || st["border" + side + "Style"] === "hidden") continue;
        const bc = parse(st["border" + side + "Color"]);
        if (!bc || bc.a === 0) continue;
        const key = Math.round(bc.r) + "," + Math.round(bc.g) + "," + Math.round(bc.b);
        if (allowed.includes(key)) continue;
        if (L(over(bc, ground)) > 0.55) {
          leaks.push({ kind: "border", sig: sig(n) + "/" + side.toLowerCase(),
            value: st["border" + side + "Color"], lum: +L(over(bc, ground)).toFixed(3) });
        }
      }
    }

    /* Form controls are called out separately: a native widget that keeps its
       light user-agent appearance is the classic half-dark failure. */
    const controls = [];
    for (const n of document.querySelectorAll("input, select, textarea, button")) {
      const st = getComputedStyle(n);
      if (st.display === "none") continue;
      const own = parse(st.backgroundColor);
      const key = own ? Math.round(own.r) + "," + Math.round(own.g) + "," + Math.round(own.b) : "";
      const flat = own && own.a > 0 ? over(own, ground) : ground;
      const alpha = +st.opacity;
      /* opacity composites the element, ink and ground together, over whatever
         is behind it — so the contrast the user sees is between the faded ink
         and the faded ground, not between the declared colours. */
      const inkOn = over(parse(st.color) || { r: 0, g: 0, b: 0, a: 1 }, flat);
      const seenInk = over({ ...inkOn, a: alpha }, ground);
      const seenGround = over({ ...flat, a: alpha }, ground);
      controls.push({
        sig: sig(n),
        light: !allowed.includes(key) && L(flat) > 0.36,
        disabled: n.disabled === true,
        opacity: alpha,
        contrast: +ratio(inkOn, flat).toFixed(2),
        seenContrast: +ratio(seenInk, seenGround).toFixed(2)
      });
    }

    /* Status chip palette. Read from tokens rather than by mutating a badge, so
       nothing in the page's Run presentation is disturbed by measuring it. */
    const surface = hex(tok("--aipm-surface")) || ground;
    const states = {};
    for (const role of ["ready", "running", "paused", "needs", "stopped", "completed"]) {
      const bgRaw = getComputedStyle(document.body).getPropertyValue("--state-" + role + "-bg").trim();
      const fgRaw = getComputedStyle(document.body).getPropertyValue("--state-" + role + "-fg").trim();
      const bg = hex(bgRaw);
      const chipGround = bg ? over(bg, surface) : surface;
      const fg = hex(fgRaw);
      states[role] = fg ? {
        bg: bgRaw, fg: fgRaw,
        contrast: +ratio(over(fg, chipGround), chipGround).toFixed(2),
        rgb: [Math.round(fg.r), Math.round(fg.g), Math.round(fg.b)],
        groundLum: +L(chipGround).toFixed(3)
      } : null;
    }

    const bodyStyle = getComputedStyle(document.body);
    const textC = +ratio(over(parse(bodyStyle.color), ground), ground).toFixed(2);
    const mutedHex = hex(tok("--aipm-muted"));
    const mutedC = mutedHex ? +ratio(over(mutedHex, over(surface, ground)), over(surface, ground)).toFixed(2) : null;
    const dangerHex = hex(tok("--aipm-danger"));
    const dangerC = dangerHex ? +ratio(over(dangerHex, over(surface, ground)), over(surface, ground)).toFixed(2) : null;

    return {
      colorScheme: cs.colorScheme,
      ground: tok("--aipm-bg"),
      signature: [tok("--aipm-bg"), tok("--aipm-surface"), tok("--aipm-surface-raised"),
        tok("--aipm-border"), bodyStyle.borderRadius, bodyStyle.boxShadow,
        getComputedStyle(document.body).getPropertyValue("--state-running-bg").trim()].join("|"),
      leaks, controls, states, textC, mutedC, dangerC
    };
  })()`);

  const darkSignatures = new Map();
  for (const id of PRODUCT_DARK) {
    for (const [name, page, controlSel] of [
      ["side-panel", sidePanel, SIDE_CONTROLS],
      ["workspace", workspace, WORKSPACE_CONTROLS],
      ["settings", settings, SETTINGS_CONTROLS]
    ]) {
      const appearance = { theme: id, mode: "dark", accent: "theme", density: "comfortable" };
      if (name === "settings") await applyThemeViaSettingsUi(settings, appearance);
      else await applyTheme(page, appearance);
      /* Collapsed disclosure is where half-finished dark modes survive review,
         so everything is opened before the surface is measured. */
      await page.evaluate(() => { for (const d of document.querySelectorAll("details")) d.open = true; });

      const probe = await darkProbe(page);
      const label = `${id}/${name} dark`;

      check(`${label} — declares a dark colour scheme`, () => {
        assert.equal(probe.colorScheme, "dark");
      });
      check(`${label} — no light surface or hairline survives`, () => {
        assert.deepEqual(probe.leaks, [],
          `${probe.leaks.length} light leak(s): ` +
          JSON.stringify(probe.leaks.slice(0, 6)));
      });
      check(`${label} — every form control is dark`, () => {
        const light = probe.controls.filter((c) => c.light);
        assert.deepEqual(light.map((c) => c.sig), [],
          `${light.length} control(s) kept a light ground`);
      });
      check(`${label} — control text stays legible`, () => {
        const weak = probe.controls.filter((c) => !c.disabled && c.contrast < 4.5);
        assert.deepEqual(weak.map((c) => `${c.sig}:${c.contrast}`), []);
      });
      /* WCAG exempts disabled controls, but a control the user cannot see at
         all is not a disabled control, it is a missing one. Dark grounds make
         a brand's light-tuned disabled opacity disappear, so the perceived
         contrast is measured rather than the declared colours. */
      check(`${label} — disabled controls stay perceivable`, () => {
        const faded = probe.controls.filter((c) => c.disabled && c.seenContrast < 2.5);
        assert.deepEqual(faded.map((c) => `${c.sig}:${c.seenContrast}:${c.opacity}`), []);
      });
      check(`${label} — body text and muted text meet AA`, () => {
        assert.ok(probe.textC >= 7, `body text contrast ${probe.textC}`);
        assert.ok(probe.mutedC >= 4.5, `muted text contrast ${probe.mutedC}`);
        assert.ok(probe.dangerC >= 4.5, `danger text contrast ${probe.dangerC}`);
      });
      /* Status meaning is carried by the same six roles in every theme and in
         both modes. Dark may change the luminance; it may not change which
         role is red, nor let a role become unreadable. */
      check(`${label} — status roles stay distinct, legible and correctly signed`, () => {
        const s = probe.states;
        for (const role of ["ready", "running", "paused", "needs", "stopped", "completed"]) {
          assert.ok(s[role], `${role} has no dark palette`);
          assert.ok(s[role].groundLum < 0.36, `${role} chip ground is light: ${s[role].bg}`);
          assert.ok(s[role].contrast >= 4.5, `${role} chip contrast ${s[role].contrast}`);
        }
        const [sr, sg, sb] = s.stopped.rgb;
        assert.ok(sr > sg + 40 && sr > sb + 40, `stopped must stay red-dominant, got ${s.stopped.fg}`);
        const distinct = new Set(["ready", "running", "paused", "needs", "stopped", "completed"]
          .map((r) => s[r].rgb.join(",")));
        assert.equal(distinct.size, 6, "two status roles resolved to the same colour");
      });

      darkSignatures.set(`${id}/${name}`, probe.signature);
      await screenshot(page, `${id}-${name}-dark`);
    }
  }

  check("the product dark modes remain distinct designs", () => {
    for (const surface of ["side-panel", "workspace", "settings"]) {
      const seen = PRODUCT_DARK.map((id) => darkSignatures.get(`${id}/${surface}`));
      assert.equal(new Set(seen).size, PRODUCT_DARK.length,
        `${surface}: ${PRODUCT_DARK.length} product dark modes collapsed to ${new Set(seen).size} design(s)`);
    }
  });

  /* Narrow Side Panel widths, in dark, for every product theme. */
  for (const id of PRODUCT_DARK) {
    await applyTheme(sidePanel, { theme: id, mode: "dark", accent: "theme", density: "comfortable" });
    for (const width of WIDTHS) {
      await sidePanel.setViewportSize({ width, height: 900 });
      assertSane(`side-panel/${width} ${id}/dark`, await measure(sidePanel, SIDE_CONTROLS), { expectMode: "dark" });
    }
  }
  await sidePanel.setViewportSize({ width: 360, height: 900 });

  /* An accent the user chose must stay readable on every product dark canvas. */
  for (const id of PRODUCT_DARK) {
    for (const accent of ["amber", "violet", "green"]) {
      await applyTheme(sidePanel, { theme: id, mode: "dark", accent, density: "comfortable" });
      const probe = await darkProbe(sidePanel);
      check(`side-panel ${id}/dark/${accent} — accent stays dark-safe and legible`, () => {
        assert.deepEqual(probe.leaks, [], JSON.stringify(probe.leaks.slice(0, 4)));
        assert.ok(probe.textC >= 7, `body text contrast ${probe.textC}`);
      });
    }
  }

  /*
    System mode.

    "system" is resolved from the host preference in theme.js rather than in
    CSS, so this drives the real signal: the host preference is emulated and
    the surface is loaded under it, which is exactly what a user with a dark
    desktop sees when they open the panel.

    The live-switch path — the OS flipping while the surface is already open —
    is deliberately NOT asserted here. Chromium's Emulation.setEmulatedMedia
    changes what the media query reports without dispatching `change` on an
    existing MediaQueryList (verified separately: a plain listener registered
    in the page also receives nothing), so a check written against it would
    pass whatever the product did. Asserting it would be theatre.
  */
  for (const id of PRODUCT_DARK) {
    await applyTheme(sidePanel, { theme: id, mode: "system", accent: "theme", density: "comfortable" });
    for (const [scheme, expected] of [["dark", "dark"], ["light", "light"]]) {
      await sidePanel.emulateMedia({ colorScheme: scheme });
      await sidePanel.reload();
      await sidePanel.waitForFunction(
        (want) => document.documentElement.dataset.aipmTheme === want.theme &&
          document.documentElement.dataset.aipmMode === want.mode,
        { theme: id, mode: expected }, { timeout: 5_000 }).catch(() => {});
      const resolved = await sidePanel.evaluate(() => ({
        mode: document.documentElement.dataset.aipmMode,
        background: getComputedStyle(document.body).backgroundColor
      }));
      check(`side-panel ${id}/system — a ${scheme} host resolves to ${expected}`, () => {
        assert.equal(resolved.mode, expected);
        if (expected === "dark") {
          assert.equal(resolved.background, PRODUCT_DARK_BACKGROUNDS[id],
            "system dark must paint the reviewed dark canvas, not merely set an attribute");
        }
      });
    }
  }
  await sidePanel.emulateMedia({ colorScheme: "light" });
  await sidePanel.reload();
  await sidePanel.waitForFunction(
    () => Boolean(document.documentElement.dataset.aipmTheme), null, { timeout: 5_000 });

  /* ----------------------------------------------------------------- Tier 4 */
  console.log("Tier 4: bounded switch stress across the whole catalogue");
  const before = await sidePanel.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all).filter((k) => !k.startsWith("aipm.settings")).sort();
  });
  for (const id of THEME_IDS) {
    await applyTheme(sidePanel, { theme: id, mode: "system", accent: "theme", density: "comfortable" });
    const state = await sidePanel.evaluate(() => {
      const roots = [...document.querySelectorAll(".aipm-theme-decoration")];
      const visible = roots.filter((n) => {
        const box = n.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && getComputedStyle(n).display !== "none";
      });
      const focusable = roots.flatMap((n) =>
        [...n.querySelectorAll("a, button, input, select, textarea, [tabindex]")]);
      return {
        active: document.documentElement.dataset.aipmTheme,
        roots: roots.length,
        visibleRoots: visible.length,
        tiles: document.querySelectorAll(".aipm-hex-tile").length,
        focusable: focusable.length,
        ariaHidden: roots.every((n) => n.getAttribute("aria-hidden") === "true"),
        pointerEvents: roots.map((n) => getComputedStyle(n).pointerEvents),
        exceptions: globalThis.__themeErrors ?? 0
      };
    });
    const decorated = id === "eva-command";
    check(`switch to ${id} — single active theme, ornament exactly as declared`, () => {
      assert.equal(state.active, id);
      assert.equal(state.exceptions, 0);
      assert.ok(state.roots <= 1, `${state.roots} ornament roots`);
      assert.equal(state.visibleRoots, decorated ? 1 : 0,
        `${id}: expected ${decorated ? 1 : 0} visible ornament, saw ${state.visibleRoots}`);
      assert.equal(state.tiles, decorated ? 23 : 0, `${id}: tile count`);
      assert.equal(state.focusable, 0, "the ornament must contain nothing focusable");
      if (state.roots > 0) {
        assert.equal(state.ariaHidden, true, "the ornament must be aria-hidden");
        assert.deepEqual(state.pointerEvents, ["none"], "the ornament must not take pointer input");
      }
    });
  }
  const after = await sidePanel.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all).filter((k) => !k.startsWith("aipm.settings")).sort();
  });
  check("switching themes writes no key other than settings", () => {
    assert.deepEqual(after, before);
  });

  const consoleErrors = [];
  for (const page of [sidePanel, workspace, settings]) {
    page.on("pageerror", (error) => consoleErrors.push(String(error)));
  }
  await applyTheme(sidePanel, { theme: "default", mode: "system", accent: "theme", density: "comfortable" });
  check("no page error during theme work", () => {
    assert.deepEqual(consoleErrors, []);
  });

  const durationMs = Date.now() - startedAt;
  if (failures > 0) {
    console.error(`\nTheme render FAIL: ${failures} check(s) failed; durationMs=${durationMs}`);
    process.exitCode = 1;
  } else {
    console.log(`\nTheme render PASS: ${THEME_IDS.length} themes x 3 surfaces, ` +
      `${RESPONSIVE_SUBSET.length} themes x ${WIDTHS.length} widths, ` +
      `both-stance modes, compact density, `+
      `${PRODUCT_DARK.length} product dark modes x 3 surfaces x ${WIDTHS.length} widths x 4 accents, `+
      `switch stress; durationMs=${durationMs}`);
  }
} finally {
  await context?.close();
  fs.rmSync(profilePath, { recursive: true, force: true });
}
