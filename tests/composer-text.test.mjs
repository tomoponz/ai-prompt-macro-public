import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

function loadMatcher() {
  const source = fs.readFileSync(new URL("../src/content-core.js", import.meta.url), "utf8");
  const store = new Map();
  const context = vm.createContext({
    crypto: webcrypto,
    console,
    sessionStorage: {
      getItem(key) { return store.get(key) ?? null; },
      setItem(key, value) { store.set(key, String(value)); }
    }
  });
  vm.runInContext(source, context, { filename: "content-core.js" });
  return {
    normalize: context.normalizeComposerComparableText,
    matches: context.composerTextMatchesExpected,
    effectivelyEmpty: context.composerIsEffectivelyEmpty
  };
}

const { normalize, matches, effectivelyEmpty } = loadMatcher();

test("PDT1-PDT3: production effective-empty semantics admit only bounded structural residue", () => {
  for (const residue of ["", "\n", "\n\n", "\r\n", "\u00a0", "\u200b", "\u200c\n\u2060\ufeff"]) {
    assert.equal(effectivelyEmpty(residue), true, JSON.stringify(residue));
  }
  for (const draft of [
    " ",
    "   ",
    "\t",
    "a",
    "hello",
    "ユーザーの下書き",
    "\nvisible",
    "\u200bvisible",
    "\u00a0visible",
    "\n".repeat(17)
  ]) {
    assert.equal(effectivelyEmpty(draft), false, JSON.stringify(draft));
  }
});

test("composer comparison normalizes line endings and permits only DOM-side NBSP substitution", () => {
  assert.equal(normalize("A\r\nB\u00a0C"), "A\nB\u00a0C");
  assert.equal(matches("A\nB C", "A\r\nB\u00a0C"), true);
  assert.equal(matches("A\nB\u00a0C", "A\r\nB C"), false);
  assert.equal(matches("A  B", "A\u00a0B"), false);
});

test("composer comparison preserves every expected and actual blank line", () => {
  assert.equal(matches("A\nB\nC", "A\n\nB\n\nC"), false);
  assert.equal(matches("A\n\nB", "A\n\n\nB"), false);
  assert.equal(matches("A\n\nB", "A\nB"), false);
  assert.equal(matches("A\n\nB", "A\n\nB"), true);
});

test("composer comparison rejects changed non-whitespace content", () => {
  assert.equal(matches("git status\nmainを編集しない", "git status\nmainを直接編集する"), false);
});

test("composer comparison rejects any collapse of alignment-style prose spacing", () => {
  const expected = [
    "User Value        30",
    "Differentiation   20",
    "Reliability       15",
    "Implementation    10",
    "Maintenance       10",
    "Privacy/Safety    10",
    "Store readiness    5"
  ].join("\n");
  const actual = [
    "User Value 30",
    "Differentiation 20",
    "Reliability 15",
    "Implementation 10",
    "Maintenance 10",
    "Privacy/Safety 10",
    "Store readiness 5"
  ].join("\n");
  assert.equal(matches(expected, actual), false);
});

test("composer comparison does not relax ordinary double spaces or move alignment gaps", () => {
  assert.equal(matches("A  B", "A B"), false);
  assert.equal(matches("Alpha   Beta Gamma", "Alpha Beta   Gamma"), false);
});

test("composer comparison preserves indentation and whitespace-sensitive code", () => {
  assert.equal(matches("```py\n  x = 1\n```", "```py\n x = 1\n```"), false);
  assert.equal(matches("```py\nx = \"A   B\"\n```", "```py\nx = \"A B\"\n```"), false);
  assert.equal(matches("`A   B`", "`A B`"), false);
  assert.equal(matches("x = 1   # note", "x = 1 # note"), false);
});

test("composer comparison preserves leading, trailing, multiline and Unicode plain text", () => {
  const expected = "  日本語 😀\n\n    indented\n末尾  ";
  assert.equal(matches(expected, expected), true);
  assert.equal(matches(expected, expected.trim()), false);
  assert.equal(matches(expected, " 日本語 😀\n\n    indented\n末尾  "), false);
  assert.equal(matches(expected, "  日本語 😀\n    indented\n末尾  "), false);
  assert.equal(matches(expected, "  日本語 😀\n\n    indented\n末尾 "), false);
});
