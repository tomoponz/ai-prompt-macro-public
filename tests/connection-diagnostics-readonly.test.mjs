import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/connection-diagnostics-ui.js", import.meta.url), "utf8");

test("connection diagnostics UI stays passive and does not trigger tab discovery", () => {
  assert.match(source, /aipm:connection-diagnostic/);
  assert.doesNotMatch(source, /chrome\.runtime\.sendMessage/);
  assert.doesNotMatch(source, /AIPM_LIST_CHATGPT_TABS/);
  assert.doesNotMatch(source, /MutationObserver/);
});

test("passive diagnostics clear on target refresh and explicit healthy status events", () => {
  assert.match(source, /targetTab\.addEventListener\("change"/);
  assert.match(source, /refreshTabs\?\.addEventListener\("click"/);
  assert.match(source, /aipm:connection-diagnostic-success/);
  assert.match(source, /relay-succeeded/);
});
