import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { syncThemeDecoration } from "../src/themes/decoration.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const tokens = fs.readFileSync(path.join(root, "src", "ui-tokens.css"), "utf8");
const themeJs = fs.readFileSync(path.join(root, "src", "theme.js"), "utf8");
const fixes = fs.readFileSync(path.join(root, "src", "themes", "manual-ux.css"), "utf8");
const sidePanelHtml = fs.readFileSync(path.join(root, "src", "sidepanel.html"), "utf8");
const workspaceHtml = fs.readFileSync(path.join(root, "src", "workspace.html"), "utf8");
const optionsHtml = fs.readFileSync(path.join(root, "src", "options.html"), "utf8");

function layoutDocument() {
  const children = [];
  const doc = {
    documentElement: {},
    body: {
      children,
      prepend(node) { children.unshift(node); },
      querySelectorAll(selector) {
        assert.equal(selector, ".aipm-theme-decoration");
        return children.filter((node) => node.className === "aipm-theme-decoration");
      }
    },
    createElement(tag) {
      const node = {
        tag,
        className: "",
        attributes: {},
        childNodes: [],
        style: new Map(),
        setAttribute(key, value) { this.attributes[key] = value; },
        append(child) { this.childNodes.push(child); },
        remove() {
          const index = children.indexOf(this);
          if (index >= 0) children.splice(index, 1);
        }
      };
      node.style.setProperty = (key, value) => node.style.set(key, value);
      return node;
    }
  };
  return { doc, children };
}

test("manual UX corrections are extension-local and do not use CSS import", () => {
  assert.doesNotMatch(tokens, /@import/i);
  assert.doesNotMatch(tokens, /url\(/i);
  assert.match(themeJs, /new URL\("\.\/themes\/manual-ux\.css", import\.meta\.url\)\.href/);
  assert.match(themeJs, /link\.rel = "stylesheet"/);
  assert.match(themeJs, /link\.dataset\[MANUAL_UX_MARKER\] = "true"/);
});

test("EVA production correction restores body scrolling", () => {
  assert.match(
    fixes,
    /:root\[data-aipm-theme="eva-command"\]\s+body\s*\{[^}]*overflow:\s*visible\s*!important\s*;/s,
  );
  assert.doesNotMatch(fixes, /overflow-y:\s*hidden/i);
});

test("EVA edge field stays fixed, clipped and free of per-tile CSS hacks", () => {
  const field = fixes.match(
    /:root\[data-aipm-theme="eva-command"\]\s+\.aipm-theme-decoration\s*\{([^}]*)\}/s,
  );
  assert.ok(field, "EVA decoration correction must exist");
  assert.match(field[1], /position:\s*fixed\s*!important\s*;/);
  assert.match(field[1], /overflow:\s*hidden\s*;/);
  assert.doesNotMatch(fixes, /\.aipm-hex-tile:nth-child\(/,
    "tile geometry belongs in the ornament model, not scattered CSS overrides");
});

test("EVA narrow Side Panel closes the hex spacing without changing other surfaces", () => {
  assert.match(sidePanelHtml, /<body class="aipm-sidepanel-surface">/);
  assert.doesNotMatch(workspaceHtml, /aipm-sidepanel-surface/);
  assert.doesNotMatch(optionsHtml, /aipm-sidepanel-surface/);
  assert.match(
    fixes,
    /@media \(max-width: 410px\)[\s\S]*body\.aipm-sidepanel-surface\s+\.aipm-hex-tile\s*\{[^}]*--hex-size:\s*53px\s*;/,
  );
  assert.match(
    fixes,
    /@media \(max-width: 410px\)[\s\S]*:root\[data-aipm-theme="eva-command"\]\s+\.aipm-hex-tile\s*\{[^}]*--hex-size:\s*50px\s*;/,
    "the existing narrow fallback remains unchanged for Workspace and Settings",
  );
});

test("EVA layout-capable document gets the complete 23-tile natural edge frame", () => {
  const { doc, children } = layoutDocument();
  syncThemeDecoration(doc, "eva-command");
  const field = children.find((node) => node.className === "aipm-theme-decoration");
  assert.ok(field);
  assert.equal(field.childNodes.length, 23, "full UI Lab edge frame must render 23 tiles");

  const positions = field.childNodes.map((tile) => ({
    x: tile.style.get("--hx"),
    y: tile.style.get("--hy")
  }));
  assert.ok(positions.some(({ x, y }) => x.startsWith("-") || y.startsWith("-")),
    "top-left bank should crop naturally against an edge");
  assert.ok(positions.some(({ x }) => x.includes("100%")),
    "right/bottom motifs should remain attached to the viewport edge");
  assert.ok(positions.some(({ y }) => y.includes("100%")),
    "bottom rail should be viewport-relative rather than hard-coded to one mock height");
});

test("Swiss sticky Run Cockpit is opaque without restoring generic card chrome", () => {
  const swiss = fixes.match(
    /:root\[data-aipm-theme="swiss-information"\]\s+\.run-card\s*\{([^}]*)\}/s,
  );
  assert.ok(swiss, "Swiss run-card correction must exist");
  assert.match(swiss[1], /background:\s*var\(--aipm-bg\)\s*!important\s*;/);
  assert.doesNotMatch(swiss[1], /border-radius|box-shadow|border\s*:/);
});

test("manual UX correction stays presentation-only", () => {
  const executableCss = fixes.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(
    executableCss,
    /chrome\.|storage|runtime|send|lease|document[_-]?id|conversation[_-]?id/i,
  );
});
