/*
  Read-only status observation: busy is not failure.

  Discovery is a periodic READ-ONLY observation whose only consumer is the Side
  Panel's availability hint. It is allowed exactly one outstanding contact per
  tab, so two overlapping observers make the second one lose the gate with
  READ_ONLY_CONTACT_BUSY. That code means "this observation never ran", not "this
  tab is unhealthy" — but discovery used to report it as `status-timeout`, which
  erased a still-valid availability hint and made the Side Panel refuse Start
  with 「固定した対象タブの接続を安全に確認できません」 while the tab was fine.

  Every test here is paired: an availability case that must now succeed, and the
  authority case that must still fail closed. The point of the change is that
  availability improved and authority did not move, so both halves are asserted.
*/

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import {
  EXTENSION_VERSION,
  installBackgroundHarness,
  flushAsync
} from "./helpers/background-harness.mjs";
import { targetHealth } from "../src/target-selection.js";

const harness = await installBackgroundHarness();
const source = fs.readFileSync(new URL("../src/background.js", import.meta.url), "utf8");

let nextTabId = 55_000;
function chatGptTab() {
  nextTabId += 1;
  harness.setTabs([{ id: nextTabId, windowId: 1, active: true, url: "https://chatgpt.com/c/abc" }]);
  return nextTabId;
}

const listTabs = () => harness.invoke({ type: "AIPM_LIST_CHATGPT_TABS" });
const itemFor = async (tabId) => (await listTabs()).tabs?.find((entry) => entry.tabId === tabId) ?? null;

/*
  Holds the one allowed read-only contact open, the way it overlaps in production.

  Two observations with the SAME fingerprint coalesce into one contact rather than
  colliding, so the collision has to be built the way it actually occurs: the Side
  Panel's periodic status relay carries the Run's recovery bounds, which gives it a
  different fingerprint from periodic discovery's default. Different fingerprint on
  an in-flight contact is exactly what yields READ_ONLY_CONTACT_BUSY.
*/
function occupyStatusContact(tabId) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  harness.setStatusResponder(tabId, async () => {
    await gate;
    return harness.defaultStatus(tabId);
  });
  const inFlight = harness.relay({
    type: "AIPM_GET_STATUS",
    /* "safe" IS the default profile, so it would produce discovery's own
       fingerprint and coalesce instead of colliding. A Run configured for
       completion recovery is what actually overlaps discovery in production. */
    readOnlyRecovery: { mode: "completion", identityAttempts: 10, readiness: "long", statusRecovery: "persistent" }
  }, tabId);
  return { release: () => release(), inFlight };
}

/* Waits on real state — the contact having actually started — never on a delay. */
async function untilContactStarted(tabId) {
  const started = () => harness.tabMessages.some(
    (entry) => entry.tabId === tabId && entry.payload?.type === "AIPM_GET_STATUS");
  while (!started()) await flushAsync();
}

/* ------------------------------------------------------ confirmed baseline */

test("an idle observation of a healthy tab is confirmed, not pending", async () => {
  const tabId = chatGptTab();
  const item = await itemFor(tabId);
  assert.ok(item, "the tab must be discovered");
  assert.equal(item.status.discoveryError, null);
  assert.equal(item.status.statusPending, false);
  assert.equal(item.status.contentVersion, EXTENSION_VERSION);
  assert.equal(item.status.provider, "chatgpt");
  assert.equal(targetHealth(tabId, [item], EXTENSION_VERSION).ready, true);
});

/* ------------------------------------------------- busy is not a failure */

test("a busy observation repeats the last confirmed status instead of inventing a timeout", async () => {
  const tabId = chatGptTab();
  /* One confirmed observation first: retention only ever repeats something that
     was actually observed. */
  assert.equal((await itemFor(tabId)).status.discoveryError, null);

  const held = occupyStatusContact(tabId);
  await untilContactStarted(tabId);
  const duringContact = await itemFor(tabId);
  held.release();
  await held.inFlight;

  assert.ok(duringContact, "the tab must still be offered while a re-observation is in flight");
  assert.equal(duringContact.status.discoveryError, null,
    "a contact that never ran is not evidence that the tab failed");
  assert.equal(duringContact.status.statusPending, true, "the repeat must be marked pending");
  assert.equal(duringContact.status.contentVersion, EXTENSION_VERSION);
  assert.equal(targetHealth(tabId, [duringContact], EXTENSION_VERSION).ready, true,
    "the Side Panel must keep offering a target it confirmed moments ago");
});

test("a busy observation with nothing confirmed yet still fails closed", async () => {
  const tabId = chatGptTab();
  /* No successful observation has ever been recorded for this tab. */
  const held = occupyStatusContact(tabId);
  await untilContactStarted(tabId);
  const duringContact = await itemFor(tabId);
  held.release();
  await held.inFlight;

  assert.equal(duringContact.status.discoveryError, "status-timeout",
    "an unconfirmed tab must not become available just because a contact is busy");
  assert.equal(duringContact.status.statusPending, false);
  assert.equal(targetHealth(tabId, [duringContact], EXTENSION_VERSION).ready, false);
});

/* --------------------------------------------- genuine failures unchanged */

test("a genuine status failure still fails closed even after a confirmation", async () => {
  const tabId = chatGptTab();
  assert.equal((await itemFor(tabId)).status.discoveryError, null);

  /* Not a gate refusal: the tab itself rejects the observation. */
  harness.setStatusResponder(tabId, async () => { throw new Error("disconnected"); });
  harness.setContentProbe(tabId, null);
  const failed = await itemFor(tabId);

  assert.notEqual(failed?.status?.discoveryError ?? "absent", null,
    "a real failure must still produce a discovery error");
  assert.notEqual(failed?.status?.statusPending, true,
    "a real failure must never be dressed up as a pending re-observation");
  if (failed) assert.equal(targetHealth(tabId, [failed], EXTENSION_VERSION).ready, false);
});

test("only READ_ONLY_CONTACT_BUSY is treated as a pending observation", () => {
  /* BACKOFF follows a real timeout and EXPIRED means the contact outlived its
     bound; neither is mere concurrency, so neither may retain. */
  const start = source.indexOf("async function discoverChatGptTab(tab)");
  const end = source.indexOf("\n}", source.indexOf("recallConfirmedTabStatus(tab.id)", start));
  const body = source.slice(start, end);
  assert.match(body, /direct\.error\?\.code === "READ_ONLY_CONTACT_BUSY"/);
  assert.doesNotMatch(body, /READ_ONLY_BACKOFF/);
  assert.doesNotMatch(body, /READ_ONLY_CONTACT_EXPIRED/);
  assert.doesNotMatch(body, /READ_ONLY_TIMEOUT/);
});

/* ------------------------------------- retention cannot outlive its subject */

test("a document lifecycle change drops the retained hint", async () => {
  const tabId = chatGptTab();
  assert.equal((await itemFor(tabId)).status.discoveryError, null);

  /* A navigation or reload invalidates document authority. */
  await harness.triggerTabLoading(tabId);

  const held = occupyStatusContact(tabId);
  await untilContactStarted(tabId);
  const duringContact = await itemFor(tabId);
  held.release();
  await held.inFlight;

  assert.equal(duringContact.status.discoveryError, "status-timeout",
    "a hint describing the previous document must not survive the navigation");
  assert.equal(targetHealth(tabId, [duringContact], EXTENSION_VERSION).ready, false);
});

test("closing the tab drops the retained hint", async () => {
  const tabId = chatGptTab();
  assert.equal((await itemFor(tabId)).status.discoveryError, null);
  await harness.triggerTabRemoved(tabId);

  harness.setTabs([{ id: tabId, windowId: 1, active: true, url: "https://chatgpt.com/c/abc" }]);
  const held = occupyStatusContact(tabId);
  await untilContactStarted(tabId);
  const duringContact = await itemFor(tabId);
  held.release();
  await held.inFlight;

  assert.equal(duringContact.status.discoveryError, "status-timeout");
});

test("retention is bounded by age as well as by lifecycle", () => {
  assert.match(source, /const CONFIRMED_STATUS_RETENTION_MS = 5_000;/);
  const start = source.indexOf("function recallConfirmedTabStatus(tabId)");
  const body = source.slice(start, source.indexOf("\n}", start));
  assert.match(body, /Date\.now\(\) - entry\.at > CONFIRMED_STATUS_RETENTION_MS/);
  assert.match(body, /confirmedStatusByTab\.delete\(tabId\)/,
    "an expired hint must be dropped, not merely ignored");
});

test("version mismatch and navigation keep their own distinct discovery errors", async () => {
  const tabId = chatGptTab();
  harness.setStatusResponder(tabId, async () => ({
    ...harness.defaultStatus(tabId), contentVersion: "0.0.1-old"
  }));
  const mismatched = await itemFor(tabId);
  assert.equal(mismatched.status.discoveryError, "version-mismatch");
  assert.notEqual(mismatched.status.statusPending, true);
  assert.equal(targetHealth(tabId, [mismatched], EXTENSION_VERSION).ready, false);
});

/* --------------------------------------------------- authority is unmoved */

test("the retained hint is presentation only and is never read at a mutation boundary", () => {
  /* The retention is consumed in exactly one place, inside discovery. */
  const reads = [...source.matchAll(/recallConfirmedTabStatus\(/g)].length;
  assert.equal(reads, 2, "one definition and exactly one call site");
  const callIndex = source.indexOf("recallConfirmedTabStatus(tab.id)");
  const discoveryStart = source.indexOf("async function discoverChatGptTab(tab)");
  const discoveryEnd = source.indexOf("\nasync function ", discoveryStart + 10);
  assert.ok(callIndex > discoveryStart && callIndex < discoveryEnd,
    "the only read must be inside discovery");

  /* And the mutation boundary still establishes its own authority. */
  const relayStart = source.indexOf("async function relayToChatGpt(payload");
  const relayBody = source.slice(relayStart, source.indexOf("\nasync function ", relayStart + 10));
  assert.doesNotMatch(relayBody, /confirmedStatusByTab|recallConfirmedTabStatus/);
  assert.match(relayBody, /freshAuthority: payload\.type !== "AIPM_GET_STATUS"/);
  assert.match(relayBody, /reconfirmCurrentTopDocument\(/);
  assert.match(relayBody, /expectedConversationKey: connection\.response\.conversationKey/);
  assert.match(relayBody, /expectedDocumentInstanceId: connection\.response\.instanceId/);
});

test("a fresh-authority observation never reuses a periodic snapshot", () => {
  const start = source.indexOf("async function requestTabStatus(");
  const body = source.slice(start, source.indexOf("\n}", source.indexOf("return {", start)));
  assert.match(body, /freshAuthority && statusContactByTab\.state\(tabId\)\.state === "in-flight"/);
  assert.match(body, /await statusContactByTab\.waitForRelease\(tabId\)/);
  assert.doesNotMatch(body, /recallConfirmedTabStatus/);
});

test("a control message still fails closed when the document moved under a pending hint", async () => {
  const tabId = chatGptTab();
  assert.equal((await itemFor(tabId)).status.discoveryError, null);

  /* Availability may say "still fine"; authority must not. The delivered payload
     carries the freshly observed identity, so the content fence can reject. */
  harness.setStatusResponder(tabId, async () => ({
    ...harness.defaultStatus(tabId), instanceId: "instance-after-navigation"
  }));
  harness.setCommandResponder(tabId, () => ({ ok: false, error: "操作対象のdocumentが接続確認後に変わりました。" }));
  harness.setDocument(tabId, { documentId: `document-${tabId}`, documentInstanceId: "instance-after-navigation" });

  const response = await harness.relay({ type: "AIPM_PAUSE", expectedRunId: "run-that-is-gone" }, tabId);
  assert.equal(response.ok, false, "a stale control intent must not be delivered");
});
