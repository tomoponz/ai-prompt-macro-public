/*
  Product-style dark mode gate.

  The product themes below are the catalogue entries whose dark mode
  is modelled on a specific real product (ChatGPT/Codex, Chrome dark, Edge and
  Windows dark, iPadOS Settings dark). This file guards the two things that made
  their first dark implementation only half-dark:

    1. the cascade. A palette declared on <body> shadows the one :root declares
       for every descendant, and no specificity or !important on :root can reach
       past it. Declaring the dark palette at :root while the light palette sat
       on <body> is why cards, nested cells, form controls and hairlines all
       stayed light while the html element alone went dark.

    2. the parts a palette cannot express: the status chip treatment, and the
       disabled state, both of which are tuned per design and per luminance.

  Rendering is proved separately, on the real surfaces, by tests/theme-render.mjs
  Tier 5. This file proves the source has no way to regress back.
*/

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { THEMES, resolveThemeMode } from "../src/themes/registry.js";

const componentCss = fs.readFileSync(new URL("../src/themes/manual-ux.css", import.meta.url), "utf8");
const tokenCss = fs.readFileSync(new URL("../src/themes/themes.css", import.meta.url), "utf8");
const fidelityCss = fs.readFileSync(new URL("../src/themes/fidelity.css", import.meta.url), "utf8");
const PRODUCT_DARK = ["chatgpt-native", "google-native", "claude-native", "microsoft-fluent", "apple-utility"];
const STATE_ROLES = ["ready", "running", "paused", "needs", "stopped", "completed"];

function block(source, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`:root\\[data-aipm-theme="${escaped}"\\]\\[data-aipm-mode="dark"\\]\\s*\\{([\\s\\S]*?)\\}`));
  return match?.[1] ?? "";
}

/* Every top-level rule in a stylesheet, comments stripped, as {selector, body}.
   Comment text is removed first so prose can never be mistaken for a selector
   or for a declaration. */
function rules(source) {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: match[1].trim().replace(/\s+/g, " "), body: match[2] });
  }
  return out;
}

const ALL_RULES = [
  ...rules(tokenCss).map((r) => ({ ...r, file: "themes.css" })),
  ...rules(fidelityCss).map((r) => ({ ...r, file: "fidelity.css" })),
  ...rules(componentCss).map((r) => ({ ...r, file: "manual-ux.css" }))
];

/* A colour literal as {r, g, b, a}. Alpha matters: a 22%-alpha orange fill over
   a near-black surface is a dark tint, and reading it as if it were opaque
   reports a light ground that no user ever sees. */
function parseColour(value) {
  const text = String(value).trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text);
  if (hex) {
    const short = hex[1].length <= 4;
    const h = short ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (!fn) return null;
  const parts = fn[1].split(/[,\s/]+/).filter(Boolean)
    .map((p) => p.endsWith("%") ? Number(p.slice(0, -1)) / 100 : Number(p));
  if (parts.length < 3 || parts.some(Number.isNaN)) return null;
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}

function channels(value) {
  const c = parseColour(value);
  return c ? [c.r, c.g, c.b] : null;
}

/* Source-order composite of a colour over an opaque ground. */
function flatten(value, ground = "#000000") {
  const fg = parseColour(value);
  if (!fg) return null;
  if (fg.a >= 1) return fg;
  const bg = parseColour(ground) ?? { r: 0, g: 0, b: 0, a: 1 };
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1
  };
}

/* WCAG relative luminance, after compositing. */
function luminance(value, ground = "#000000") {
  const c = flatten(value, ground);
  if (!c) return null;
  const lin = [c.r, c.g, c.b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(a, b, ground = "#000000") {
  const [x, y] = [luminance(a, ground), luminance(b, ground)];
  if (x === null || y === null) return null;
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/* Hue angle in degrees, or null when the colour is too close to grey for a hue
   to mean anything. Comparing hue rather than channel order keeps the check
   scale-invariant: a dark ink and a light ink of the same family have very
   different absolute channel gaps but the same angle. */
function hue(value) {
  const rgb = channels(value);
  if (!rgb) return null;
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta < 40) return null;
  const h = max === r ? ((g - b) / delta + 6) % 6
    : max === g ? (b - r) / delta + 2
      : (r - g) / delta + 4;
  return (h * 60) % 360;
}

/* Shortest distance around the colour wheel. */
function hueGap(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/* Declarations of one custom property, with the selector that carries them. */
function declarationsOf(property) {
  const found = [];
  for (const rule of ALL_RULES) {
    const match = rule.body.match(new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;]+)`));
    if (match) found.push({ ...rule, value: match[1].replace(/!important/, "").trim() });
  }
  return found;
}

/* The body block a theme uses for one mode. */
/* `:not([data-aipm-mode="dark"])` contains the dark attribute as a substring, so
   "is this selector scoped to dark" has to ignore anything inside a :not(). */
function isDarkScoped(selector) {
  return /(?<!:not\()\[data-aipm-mode="dark"\]/.test(selector);
}

function bodyBlock(theme, mode) {
  const wanted = mode === "dark"
    ? [`:root[data-aipm-theme="${theme}"][data-aipm-mode="dark"] body`]
    : [
      `:root[data-aipm-theme="${theme}"][data-aipm-mode="light"] body`,
      `:root[data-aipm-theme="${theme}"]:not([data-aipm-mode="dark"]) body`
    ];
  return ALL_RULES.find((r) => wanted.includes(r.selector)) ?? null;
}

/* ------------------------------------------------------------------ axes */

test("reviewed product styles support both light and dark modes", () => {
  for (const id of PRODUCT_DARK) {
    const entry = THEMES.find((theme) => theme.id === id);
    assert.ok(entry, `${id} must exist`);
    assert.equal(entry.stance, "both", `${id} must expose Mode`);
    assert.equal(entry.accentPolicy, "customizable", `${id} must keep the Accent axis`);
    assert.equal(resolveThemeMode(id, "dark", false), "dark");
    assert.equal(resolveThemeMode(id, "light", true), "light");
    assert.equal(resolveThemeMode(id, "system", true), "dark");
    assert.equal(resolveThemeMode(id, "system", false), "light");
  }
});

test("each product dark pattern has a formal independently tuned token palette", () => {
  const expectedBackgrounds = {
    "chatgpt-native": "#000000",
    "google-native": "#0f0f0f",
    "claude-native": "#151515",
    "microsoft-fluent": "#202020",
    "apple-utility": "#000000"
  };
  const seen = new Set();
  for (const [id, background] of Object.entries(expectedBackgrounds)) {
    const dark = block(tokenCss, id);
    assert.ok(dark, `${id} needs a themes.css dark token block`);
    assert.match(dark, new RegExp(`--aipm-bg:\\s*${background}`));
    for (const token of ["--aipm-surface", "--aipm-surface-raised", "--aipm-surface-sunken",
      "--aipm-text", "--aipm-muted", "--aipm-border", "--aipm-border-strong",
      "--aipm-status-running", "--aipm-status-stop", "--aipm-danger"]) {
      assert.ok(dark.includes(`${token}:`), `${id} dark palette needs ${token}`);
    }
    assert.match(dark, /color-scheme:\s*dark/, `${id} dark palette must declare a dark colour scheme`);
    /* Customizable themes must leave Accent to the independent Accent axis. */
    assert.doesNotMatch(dark, /--aipm-accent(?:-text|-soft)?:/);
    const surface = /--aipm-surface:\s*([^;]+)/.exec(dark)?.[1].trim();
    const raised = /--aipm-surface-raised:\s*([^;]+)/.exec(dark)?.[1].trim();
    seen.add(`${background}|${surface}|${raised}`);
  }
  assert.equal(seen.size, PRODUCT_DARK.length,
    "reviewed product dark modes must not collapse to one generic surface model");
});

test("each dark mode still resolves the anchors its real-world reference was matched to", () => {
  /*
     These dark languages were reviewed against specific products, and each
     review fixed a small number of values that identify it. Distinctness alone
     would not catch a drift that kept them apart while walking all of them
     away from their references, so the anchors are pinned by name. Where an
     anchor moved file during this branch it is asserted at its new home, never
     dropped.
  */
  const anchors = {
    /* Current ChatGPT dark is a black canvas with flat #212121 work surfaces. */
    "chatgpt-native": [
      [() => bodyBlock("chatgpt-native", "dark").body, /box-shadow:\s*none/, "flat canvas"],
      [() => block(tokenCss, "chatgpt-native"), /--aipm-bg:\s*#000000/, "black application canvas"],
      [() => block(tokenCss, "chatgpt-native"), /--aipm-surface:\s*#212121/, "secondary work surface"]
    ],
    /* Current Gemini dark layers #0f0f0f / #1f1f1f / #1e1f20. */
    "google-native": [
      [() => block(tokenCss, "google-native"), /--aipm-surface:\s*#1f1f1f/, "sidebar surface"],
      [() => block(tokenCss, "google-native"), /--aipm-surface-raised:\s*#1e1f20/, "settings section"],
      [() => componentCss, /google-native[^]*--aipm-accent:\s*#a8c7fa/, "Gemini dark accent"]
    ],
    /* Current Claude dark uses warm neutrals and functional blue. */
    "claude-native": [
      [() => block(tokenCss, "claude-native"), /--aipm-surface:\s*#1a1a19/, "warm panel"],
      [() => block(tokenCss, "claude-native"), /--aipm-surface-raised:\s*#20201f/, "warm raised surface"],
      [() => componentCss, /claude-native[^]*--aipm-accent:\s*#2a78d6/, "functional blue accent"]
    ],
    /* Windows / Edge dark neutrals with the cyan accent. */
    "microsoft-fluent": [
      [() => block(tokenCss, "microsoft-fluent"), /--aipm-surface:\s*#2b2b2b/, "layered panel"],
      [() => componentCss, /microsoft-fluent[^]*--aipm-accent:\s*#60cdff/, "Fluent cyan accent"]
    ],
    /* iPadOS Settings dark: black canvas, grouped panels, hairline separators. */
    "apple-utility": [
      [() => block(tokenCss, "apple-utility"), /--aipm-surface:\s*#1c1c1e/, "grouped panel"],
      [() => block(tokenCss, "apple-utility"), /--aipm-surface-raised:\s*#2c2c2e/, "secondary panel"],
      [() => bodyBlock("apple-utility", "dark").body, /--separator:\s*#38383a/, "grouped separator"]
    ]
  };
  for (const [id, checks] of Object.entries(anchors)) {
    for (const [source, pattern, what] of checks) {
      assert.match(source(), pattern, `${id} lost its ${what} anchor`);
    }
  }
});

/* ------------------------------------------------------- the cascade rule */

test("no product theme declares a palette on body that both modes can see", () => {
  /*
     THE regression test for this branch. A custom property declared on <body>
     wins over the same property declared on :root for the whole subtree, so a
     mode-blind body palette silently disables the dark palette. Every such
     declaration must therefore sit in a selector that names exactly one mode.
  */
  for (const id of PRODUCT_DARK) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bodyRules = ALL_RULES.filter((r) =>
      new RegExp(`\\[data-aipm-theme="${escaped}"\\]`).test(r.selector) &&
      /(^|\s)body(\s|$|,)/.test(r.selector));
    assert.ok(bodyRules.length > 0, `${id} must style body`);
    for (const rule of bodyRules) {
      if (!/(?:^|[;{\s])--/.test(rule.body)) continue;
      const scoped = rule.selector.includes('[data-aipm-mode="dark"]') ||
        rule.selector.includes(':not([data-aipm-mode="dark"])') ||
        rule.selector.includes('[data-aipm-mode="light"]');
      assert.ok(scoped,
        `${rule.file}: "${rule.selector}" declares custom properties on body without ` +
        "naming a mode, so its values would shadow the dark palette declared on :root");
    }
  }
});

test("the light body palette is intact and reaches light mode only", () => {
  for (const id of PRODUCT_DARK) {
    const light = bodyBlock(id, "light");
    assert.ok(light, `${id} must keep its light body palette`);
    /* Every product light palette remains complete after its fidelity review. */
    for (const token of ["--aipm-bg", "--aipm-surface", "--aipm-surface-raised",
      "--aipm-text", "--aipm-muted", "--aipm-border"]) {
      assert.ok(light.body.includes(`${token}:`), `${id} light body palette lost ${token}`);
    }
    /* Accent is allowed in the body only when that theme's fidelity layer owns
       it intentionally. ChatGPT, Google and Claude moved Accent to later
       explicit axis rules, because a body declaration would shadow every
       user-selected root value. */
    if (["chatgpt-native", "google-native", "claude-native"].includes(id)) {
      assert.doesNotMatch(light.body, /--aipm-accent:/);
    }
    else assert.ok(light.body.includes("--aipm-accent:"), `${id} light body palette lost --aipm-accent`);
    for (const role of STATE_ROLES) {
      assert.ok(light.body.includes(`--state-${role}-bg:`), `${id} light chips lost ${role}`);
    }
    const bg = /--aipm-bg:\s*([^;]+)/.exec(light.body)[1].trim();
    assert.ok(luminance(bg) > 0.7, `${id} light canvas must stay light, got ${bg}`);
  }
});

/* ------------------------------------------------------- status treatment */

test("every product dark mode has a full status chip palette", () => {
  for (const id of PRODUCT_DARK) {
    const dark = bodyBlock(id, "dark");
    assert.ok(dark, `${id} needs a dark body block for its chip palette`);
    for (const role of STATE_ROLES) {
      for (const part of ["bg", "fg", "line"]) {
        assert.ok(dark.body.includes(`--state-${role}-${part}:`),
          `${id} dark chips missing --state-${role}-${part}`);
      }
    }
  }
});

test("dark status chips stay dark-grounded, legible and correctly signed", () => {
  for (const id of PRODUCT_DARK) {
    const dark = bodyBlock(id, "dark").body;
    const surface = /--aipm-surface:\s*([^;]+)/.exec(block(tokenCss, id))[1].trim();
    const inks = new Map();
    for (const role of STATE_ROLES) {
      const bg = /:\s*([^;]+)/.exec(dark.split(`--state-${role}-bg`)[1])[1].trim();
      const fg = /:\s*([^;]+)/.exec(dark.split(`--state-${role}-fg`)[1])[1].trim();
      /* A chip ground is either the theme's own surface (transparent chips) or
         an explicitly dark tint. It is never a light fill on a dark canvas. */
      const ground = bg === "transparent" ? surface : bg;
      assert.ok(luminance(ground) < 0.25,
        `${id}/${role} chip ground is light: ${bg}`);
      const ratio = contrast(fg, ground);
      assert.ok(ratio >= 4.5,
        `${id}/${role} chip contrast ${ratio?.toFixed(2)} (${fg} on ${ground})`);
      inks.set(role, fg);
    }
    /* Meaning is not allowed to move between modes. Stop stays red-dominant,
       and no two roles may resolve to the same ink. */
    const [r, g, b] = channels(inks.get("stopped"));
    assert.ok(r > g + 40 && r > b + 40,
      `${id} stopped must stay red-dominant in dark, got ${inks.get("stopped")}`);
    assert.equal(new Set(inks.values()).size, STATE_ROLES.length,
      `${id}: two status roles share one dark ink`);
  }
});

test("dark status hue follows the light palette, so a status cannot change meaning", () => {
  /* Only luminance may flip between modes. A role that is amber in light must
     still be amber in dark; a role that reads neutral must stay neutral. Hue
     angle is compared rather than channel order because the same family has
     very different absolute channel gaps at the two ends of the luminance
     range. 30 degrees is wide enough for the desaturation that going
     light-on-dark requires, and narrow enough that no family reaches its
     neighbour; stop is additionally pinned red-dominant by the test above. */
  for (const id of PRODUCT_DARK) {
    const light = bodyBlock(id, "light").body;
    const dark = bodyBlock(id, "dark").body;
    for (const role of STATE_ROLES) {
      const lightFg = /:\s*([^;]+)/.exec(light.split(`--state-${role}-fg`)[1])[1].trim();
      const darkFg = /:\s*([^;]+)/.exec(dark.split(`--state-${role}-fg`)[1])[1].trim();
      const lightBg = /:\s*([^;]+)/.exec(light.split(`--state-${role}-bg`)[1])[1].trim();
      const darkBg = /:\s*([^;]+)/.exec(dark.split(`--state-${role}-bg`)[1])[1].trim();
      /* Current ChatGPT uses near-white ink on a chromatic dark status ground.
         The semantic hue therefore comes from whichever half of the pair is
         chromatic, rather than assuming foreground alone carries meaning. */
      const [lh, dh] = id === "chatgpt-native"
        ? [hue(lightFg) ?? hue(lightBg), hue(darkFg) ?? hue(darkBg)]
        : [hue(lightFg), hue(darkFg)];
      if (lh === null || dh === null) {
        assert.equal(lh, dh,
          `${id}/${role}: one mode reads neutral and the other chromatic ` +
          `(${lightFg} on ${lightBg} vs ${darkFg} on ${darkBg})`);
        continue;
      }
      assert.ok(hueGap(lh, dh) <= 30,
        `${id}/${role}: dark ${darkFg} on ${darkBg} (${dh.toFixed(0)} deg) left the family of ` +
        `light ${lightFg} on ${lightBg} (${lh.toFixed(0)} deg)`);
    }
  }
});

/* ------------------------------------------------------- component layer */

test("nothing scoped to a product dark mode paints a light ground", () => {
  /* Ink may be light in dark mode — that is what ink is. Grounds and drawn
     hairlines may not. */
  const GROUND = /(?:^|[;{\s])(background(?:-color)?|border(?:-[a-z]+)?-color|--state-[a-z]+-(?:bg|line)|--aipm-(?:bg|surface[a-z-]*|border[a-z-]*)):\s*([^;]+)/g;
  for (const id of PRODUCT_DARK) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    /* A translucent fill is judged over the surface it actually sits on rather
       than over black, so the check can neither excuse nor invent a leak. */
    const surface = /--aipm-surface:\s*([^;]+)/.exec(block(tokenCss, id))[1].trim();
    const darkRules = ALL_RULES.filter((r) =>
      new RegExp(`\\[data-aipm-theme="${escaped}"\\]`).test(r.selector) &&
      isDarkScoped(r.selector));
    assert.ok(darkRules.length > 0, `${id} must have dark-scoped rules`);
    for (const rule of darkRules) {
      for (const [, property, raw] of rule.body.matchAll(GROUND)) {
        for (const literal of raw.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)/g) ?? []) {
          const lum = luminance(literal, surface);
          if (lum === null) continue;
          assert.ok(lum < 0.36,
            `${rule.file}: "${rule.selector}" sets ${property}: ${literal} ` +
            `(${lum.toFixed(3)} over ${surface}) — a light ground in dark mode`);
        }
      }
    }
  }
});

test("product dark modes correct the disabled state their light values inherit", () => {
  /* Opacity fades ink and ground together toward the canvas, so a brand's
     light-tuned disabled opacity collapses on a dark ground. The dark layer
     must raise the floor; the light values must be left alone. */
  const disabled = ALL_RULES.filter((r) =>
    isDarkScoped(r.selector) &&
    r.selector.includes(":disabled") &&
    PRODUCT_DARK.every((id) => r.selector.includes(`[data-aipm-theme="${id}"]`)));
  assert.ok(disabled.length > 0, "product dark modes need a disabled correction");
  const floor = disabled
    .map((r) => /opacity:\s*([\d.]+)/.exec(r.body)?.[1])
    .filter(Boolean)
    .map(Number);
  assert.ok(floor.length > 0, "the disabled correction must set an opacity floor");
  for (const value of floor) {
    assert.ok(value >= 0.6, `dark disabled opacity ${value} is too faint to perceive`);
  }
  /* Danger keeps its own ink, so a disabled Stop is never signalled by fade alone. */
  assert.ok(
    disabled.some((r) => r.selector.includes("danger")) ||
    ALL_RULES.some((r) => isDarkScoped(r.selector) &&
      r.selector.includes("danger") && r.selector.includes(":disabled") &&
      r.body.includes("--aipm-status-stop")),
    "a disabled danger control must keep its status ink"
  );
  /* The light values the designs shipped are untouched. */
  for (const id of PRODUCT_DARK) {
    const lightDisabled = ALL_RULES.filter((r) =>
      r.selector.includes(`[data-aipm-theme="${id}"]`) &&
      r.selector.includes(":disabled") &&
      !isDarkScoped(r.selector));
    assert.ok(lightDisabled.some((r) => /opacity:\s*\.\d/.test(r.body)),
      `${id} must keep its own light disabled opacity`);
  }
});

test("the reviewed dark modes remain distinct designs, not one dark template", () => {
  const signatures = PRODUCT_DARK.map((id) => {
    const palette = block(tokenCss, id);
    const dark = bodyBlock(id, "dark").body;
    return JSON.stringify({
      canvas: /--aipm-bg:\s*([^;]+)/.exec(palette)[1].trim(),
      surface: /--aipm-surface:\s*([^;]+)/.exec(palette)[1].trim(),
      raised: /--aipm-surface-raised:\s*([^;]+)/.exec(palette)[1].trim(),
      border: /--aipm-border:\s*([^;]+)/.exec(palette)[1].trim(),
      elevation: /box-shadow:\s*([^;]+)/.exec(dark)?.[1].trim() ?? "",
      chipFill: /--state-running-bg:\s*([^;]+)/.exec(dark)[1].trim(),
      chipOutline: /--state-running-line:\s*([^;]+)/.exec(dark)[1].trim()
    });
  });
  assert.equal(new Set(signatures).size, PRODUCT_DARK.length,
    "two product dark modes share a surface model");
  /* Each axis has to do real work, not just the canvas colour. */
  for (const axis of ["canvas", "surface", "raised", "elevation", "chipFill"]) {
    const values = signatures.map((s) => JSON.parse(s)[axis]);
    assert.ok(new Set(values).size >= 3,
      `${axis} is nearly identical across product dark modes: ${values.join(" / ")}`);
  }
});

test("each theme's dark structure is shared with its light structure", () => {
  /* Geometry and type belong to the design, not to a luminance. If a mode block
     re-declared them the two modes could drift into different products. */
  for (const id of PRODUCT_DARK) {
    const shared = ALL_RULES.find((r) => r.selector === `:root[data-aipm-theme="${id}"] body`);
    assert.ok(shared, `${id} needs one mode-independent body structure block`);
    for (const property of ["border-radius", "font-family", "line-height"]) {
      assert.ok(shared.body.includes(`${property}:`),
        `${id} structure block must own ${property}`);
    }
    assert.equal(/(?:^|[;{\s])--/.test(shared.body), false,
      `${id} structure block must declare no palette`);
  }
});

test("product dark mode CSS stays presentation-only", () => {
  const executable = [tokenCss, componentCss, fidelityCss]
    .join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const forbidden of ["chrome.", "sendMessage", "AIPM_", "outbox", "lease",
    "executionSession", "conversationKey", "runId", "javascript:", "expression("]) {
    assert.equal(executable.includes(forbidden), false, `theme CSS must not reference ${forbidden}`);
  }
  /* Theme CSS may never load anything from the network. */
  assert.equal(/url\(\s*['"]?https?:/i.test(executable), false, "theme CSS must not fetch a remote asset");
  assert.equal(/@import/.test(executable), false, "theme CSS must not @import");
});

test("the dark palette has exactly one home per token", () => {
  /* Two copies of one palette is how the first attempt drifted: a duplicate in
     the last stylesheet hid the fact that the real one never reached the page. */
  for (const id of PRODUCT_DARK) {
    for (const token of ["--aipm-bg", "--aipm-surface", "--aipm-text", "--aipm-border"]) {
      const homes = declarationsOf(token).filter((r) =>
        r.selector === `:root[data-aipm-theme="${id}"][data-aipm-mode="dark"]`);
      assert.equal(homes.length, 1,
        `${id} declares ${token} for dark in ${homes.length} places: ` +
        homes.map((h) => h.file).join(", "));
      assert.equal(homes[0].file, "themes.css",
        `${id}'s dark ${token} belongs in themes.css, found in ${homes[0].file}`);
    }
  }
});
