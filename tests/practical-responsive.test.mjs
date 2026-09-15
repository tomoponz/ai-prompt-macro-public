import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
const css = read("../src/sidepanel.css");
const browserFixture = read("./browser-fixture-e2e.mjs");

test("RSP1: the Side Panel allows a real 320px viewport and reflows controls at the narrow breakpoint", () => {
  assert.match(css, /body\s*\{[^}]*min-width:\s*0;/s);
  const narrow = css.slice(css.indexOf("@media (max-width: 380px)"));
  assert.match(css, /\.actions\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/s);
  assert.match(narrow, /\.run-summary\s*\{[^}]*flex-wrap:\s*wrap;/s);
  assert.match(narrow, /\.run-progress-value\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
});

test("RSP2: intermediate 381-480px controls retain touch-friendly height", () => {
  assert.match(css, /@media \(min-width: 381px\) and \(max-width: 480px\)/);
  assert.match(css, /@media \(min-width: 381px\)[\s\S]*?\.actions button\s*\{[^}]*min-height:\s*40px;/);
});

test("RSP3: real browser fixture audits every required width", () => {
  assert.match(browserFixture, /\[320, 360, 400, 480, 720\]/);
  for (const width of [320, 360, 400, 480, 720]) {
    assert.ok(browserFixture.includes(String(width)), `${width}px must be audited`);
  }
});
