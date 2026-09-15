import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTargetTitle, targetDisplayName, targetDisplayState } from "../src/target-display.js";
import { formatTabAliasLabel } from "../src/tab-alias.js";

test("titles accept strings only, remove Unicode controls and collapse whitespace", () => {
  for (const value of [undefined, null, 42, {}, [], "", " \t\n "]) assert.equal(normalizeTargetTitle(value), "");
  assert.equal(normalizeTargetTitle(" \t公開\n準備\u202e\u0000\u200b "), "公開 準備");
  assert.equal(normalizeTargetTitle("公開 \u200b \t準備"), "公開 準備");
  assert.equal(normalizeTargetTitle("😀".repeat(180)), "😀".repeat(150));
});

test("alias precedes title; untitled New Chat and unidentified tabs have readable fallbacks", () => {
  const item = { tabId: 7, displayTitle: "公開準備", status: { conversationKey: "chatgpt:c:secret-id" } };
  assert.equal(formatTabAliasLabel(targetDisplayName(item), "作業"), "作業 · 公開準備");
  assert.equal(formatTabAliasLabel(targetDisplayName(item), ""), "公開準備");
  assert.equal(targetDisplayName({ ...item, displayTitle: "" }), "ChatGPTタブ #7");
  assert.equal(targetDisplayName({ tabId: 7, status: { conversationKey: "chatgpt:new:project:test:doc" } }), "新しいチャット");
  assert.equal(targetDisplayName(item).includes("secret-id"), false);
});

test("selected and displayed are separate states, scoped to the panel window", () => {
  const tab = { tabId: 1, windowId: 3, active: true };
  assert.equal(targetDisplayState(tab, 1, 3).label, "操作対象 · 表示中");
  assert.equal(targetDisplayState(tab, 1, 4).accent, "selected");
  assert.equal(targetDisplayState(tab, 2, 3).accent, "displayed");
  assert.equal(targetDisplayState(tab, 2, 4).accent, "neutral");
  for (const unknown of [null, undefined, -1, "3"]) assert.equal(targetDisplayState(tab, 1, unknown).displayed, false);
});
