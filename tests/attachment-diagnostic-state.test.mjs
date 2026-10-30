import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const source = fs.readFileSync(new URL("../src/content-core.js", import.meta.url), "utf8");

function diagnosticHarness() {
  const stored = {};
  const context = vm.createContext({
    crypto: webcrypto,
    chrome: { storage: { local: {
      async get(key) { return { [key]: stored[key] }; },
      async set(values) { Object.assign(stored, values); }
    } } }
  });
  vm.runInContext(source, context, { filename: "content-core.js" });
  return { context, entries: () => stored["aipm.diagnostics.v1"] ?? [] };
}

test("settlement export retains every bounded composer state, including minimal residue", async () => {
  const { context, entries } = diagnosticHarness();
  for (const state of ["empty", "minimal", "exact", "other", "unknown"]) {
    await context.appendDiagnostic("paste_attachment_settlement", { composerTextState: state });
    assert.equal(entries().at(-1).composerTextState, state);
  }
});

test("settlement export retains readiness metadata without accepting input or attachment content", async () => {
  const { context, entries } = diagnosticHarness();
  const privateValue = "PRIVATE_CONTENT_NOT_FOR_DIAGNOSTICS";
  await context.appendDiagnostic("paste_attachment_settlement", {
    composerTextState: "minimal", lastState: "attachment-pending",
    sendActionable: false, logicalAttachmentCount: 1, userEpochChanged: false,
    prompt: privateValue, filename: privateValue, textContent: privateValue,
    attachmentContent: privateValue, html: privateValue, url: privateValue
  });
  const entry = entries()[0];
  assert.equal(entry.composerTextState, "minimal");
  assert.equal(entry.lastState, "attachment-pending");
  assert.equal(entry.sendActionable, false);
  assert.equal(entry.logicalAttachmentCount, 1);
  assert.equal(JSON.stringify(entry).includes(privateValue), false);
  assert.deepEqual(Object.keys(entry).sort(), ["at", "type", "composerTextState", "lastState",
    "sendActionable", "logicalAttachmentCount", "userEpochChanged"].sort());
});

test("settlement export drops arbitrary composer-state strings", async () => {
  const { context, entries } = diagnosticHarness();
  await context.appendDiagnostic("paste_attachment_settlement", { composerTextState: "private text" });
  assert.equal(Object.hasOwn(entries()[0], "composerTextState"), false);
});
