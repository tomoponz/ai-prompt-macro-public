import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createReadOnlyBackpressure } from "../src/read-only-backpressure.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("ten concurrent refreshes share one underlying read-only contact", async () => {
  const gate = createReadOnlyBackpressure();
  const contact = deferred();
  let calls = 0;
  let outstanding = 0;
  let maxOutstanding = 0;
  const factory = () => {
    calls += 1;
    outstanding += 1;
    maxOutstanding = Math.max(maxOutstanding, outstanding);
    return contact.promise.finally(() => { outstanding -= 1; });
  };

  const requests = Array.from({ length: 10 }, () => gate.run("tab-1", factory, {
    fingerprint: "status"
  }));
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(maxOutstanding, 1);
  assert.equal(gate.join("tab-1"), requests[0]);

  contact.resolve({ ok: true });
  const results = await Promise.all(requests);
  assert.equal(results.length, 10);
  assert.equal(outstanding, 0);
  assert.equal(gate.state("tab-1").state, "idle");
});

test("timeout keeps admission closed until the uncancellable underlying contact settles", async () => {
  let clock = 0;
  const gate = createReadOnlyBackpressure({ now: () => clock });
  const contact = deferred();
  let calls = 0;
  const first = gate.run("tab-2", () => {
    calls += 1;
    return contact.promise;
  }, {
    timeoutMs: 5,
    fingerprint: "identity",
    timeoutErrorFactory: () => Object.assign(new Error("identity timeout"), { code: "IDENTITY_TIMEOUT" })
  });

  await assert.rejects(first, (error) => error?.code === "IDENTITY_TIMEOUT");
  assert.equal(gate.state("tab-2").state, "in-flight");
  await assert.rejects(
    gate.run("tab-2", () => { calls += 1; }, { fingerprint: "fresh-authority" }),
    (error) => error?.code === "READ_ONLY_CONTACT_BUSY"
  );
  assert.equal(calls, 1);

  contact.resolve({ ok: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(gate.state("tab-2").state, "backoff");
  clock = 1_200;
  assert.equal(gate.state("tab-2").state, "idle");
});

test("one bounded recovery episode may continue through its own backoff without admitting another episode", async () => {
  let clock = 0;
  const gate = createReadOnlyBackpressure({ now: () => clock });
  let calls = 0;
  const timeout = () => {
    calls += 1;
    throw Object.assign(new Error("identity timeout"), { code: "IDENTITY_TIMEOUT" });
  };
  const options = {
    fingerprint: "send-preflight:episode-1",
    admissionClass: "fresh-authority",
    continueRecoveryEpisode: true,
    shouldBackoff: (error) => error?.code === "IDENTITY_TIMEOUT"
  };

  await assert.rejects(gate.run("tab-episode", timeout, options), /identity timeout/);
  assert.equal(gate.state("tab-episode", {
    admissionClass: "fresh-authority",
    fingerprint: options.fingerprint
  }).sameFingerprint, true);
  await assert.rejects(
    gate.run("tab-episode", timeout, {
      ...options,
      fingerprint: "send-preflight:episode-2"
    }),
    (error) => error?.code === "READ_ONLY_BACKOFF"
  );

  const recovered = await gate.run("tab-episode", () => {
    calls += 1;
    return "match";
  }, options);
  assert.equal(recovered, "match");
  assert.equal(calls, 2);
  assert.equal(clock, 0, "same-episode continuation does not convert backoff into wall-clock authority");
});

test("never-settling contacts remain hard-bounded across 100 expiry cycles and recover after settlement", async () => {
  let clock = 0;
  const gate = createReadOnlyBackpressure({ now: () => clock });
  const firstContact = deferred();
  const secondContact = deferred();
  const recoveredContact = deferred();
  let calls = 0;
  let outstanding = 0;
  let maxOutstanding = 0;
  const contacts = [firstContact, secondContact, recoveredContact];
  const factory = () => {
    const contact = contacts[calls];
    calls += 1;
    outstanding += 1;
    maxOutstanding = Math.max(maxOutstanding, outstanding);
    return contact.promise.finally(() => { outstanding -= 1; });
  };

  const first = gate.run("tab-never", factory, { fingerprint: "status" });
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(gate.state("tab-never").state, "in-flight");
  clock = 6_000;
  assert.equal(gate.state("tab-never").state, "idle", "absolute lifetime must release admission");
  await assert.rejects(first, (error) => error?.code === "READ_ONLY_CONTACT_EXPIRED");

  const second = gate.run("tab-never", factory, { fingerprint: "status" });
  await Promise.resolve();
  assert.equal(calls, 2);
  clock = 12_000;
  assert.equal(gate.state("tab-never").state, "saturated");
  await assert.rejects(second, (error) => error?.code === "READ_ONLY_CONTACT_EXPIRED");

  for (let cycle = 2; cycle < 100; cycle += 1) {
    clock += 6_000;
    await assert.rejects(
      gate.run("tab-never", factory, { fingerprint: cycle % 2 === 0 ? "status" : "other-status" }),
      (error) => error?.code === "READ_ONLY_CONTACT_BUSY"
    );
  }
  assert.equal(calls, 2, "quarantine expiry must not linearly create orphan contacts");
  assert.equal(maxOutstanding, 2);
  assert.equal(gate.outstandingCount("tab-never"), 2);

  firstContact.resolve("late-stale-result");
  await firstContact.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(gate.outstandingCount("tab-never"), 1);

  const recovered = gate.run("tab-never", factory, { fingerprint: "status" });
  await Promise.resolve();
  assert.equal(gate.state("tab-never").state, "in-flight");
  secondContact.reject(new Error("late-stale-rejection"));
  await Promise.allSettled([secondContact.promise]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(gate.state("tab-never").state, "in-flight", "late rejection cannot retire the current generation");
  recoveredContact.resolve("healthy-result");
  assert.equal(await recovered, "healthy-result");
  assert.equal(gate.state("tab-never").state, "idle");
  assert.equal(outstanding, 0, "the test must settle every simulated underlying contact");
  assert.equal(gate.outstandingCount("tab-never"), 0);
  assert.equal(calls, 3);
});

test("outstanding limits are isolated per tab while same fingerprints coalesce and different ones refuse", async () => {
  const gate = createReadOnlyBackpressure();
  const tabA = deferred();
  const tabB = deferred();
  let callsA = 0;
  let callsB = 0;
  const firstA = gate.run("tab-a", () => { callsA += 1; return tabA.promise; }, { fingerprint: "status" });
  const sharedA = gate.run("tab-a", () => { callsA += 1; return tabA.promise; }, { fingerprint: "status" });
  const firstB = gate.run("tab-b", () => { callsB += 1; return tabB.promise; }, { fingerprint: "status" });
  await Promise.resolve();
  await assert.rejects(
    gate.run("tab-a", () => Promise.resolve(), { fingerprint: "identity" }),
    (error) => error?.code === "READ_ONLY_CONTACT_BUSY"
  );
  assert.equal(callsA, 1);
  assert.equal(callsB, 1);
  tabA.resolve("a");
  tabB.resolve("b");
  assert.deepEqual(await Promise.all([firstA, sharedA, firstB]), ["a", "a", "b"]);
  assert.equal(gate.outstandingCount("tab-a"), 0);
  assert.equal(gate.outstandingCount("tab-b"), 0);
});

test("periodic requests are dropped during bounded exponential backoff and recover afterward", async () => {
  let clock = 0;
  const gate = createReadOnlyBackpressure({ now: () => clock });
  let calls = 0;
  const fail = () => {
    calls += 1;
    const error = new Error("timed out");
    error.code = "STATUS_TIMEOUT";
    throw error;
  };

  await assert.rejects(gate.run("tab-3", fail, {
    fingerprint: "status",
    shouldBackoff: (error) => error?.code === "STATUS_TIMEOUT"
  }));
  assert.equal(gate.state("tab-3").state, "backoff");
  for (let index = 0; index < 10; index += 1) {
    await assert.rejects(
      gate.run("tab-3", fail, { fingerprint: "status" }),
      (error) => error?.code === "READ_ONLY_BACKOFF"
    );
  }
  assert.equal(calls, 1);

  clock = 1_200;
  await assert.rejects(gate.run("tab-3", fail, {
    fingerprint: "status",
    shouldBackoff: (error) => error?.code === "STATUS_TIMEOUT"
  }));
  assert.equal(gate.state("tab-3").retryAfterMs, 2_400);
  clock = 3_600;
  const recovered = await gate.run("tab-3", () => {
    calls += 1;
    return { ok: true };
  }, { fingerprint: "status" });
  assert.deepEqual(recovered, { ok: true });
  assert.equal(calls, 3);
});

test("repeated 600ms stalls do not create a growing request backlog", async () => {
  const gate = createReadOnlyBackpressure();
  let calls = 0;
  let outstanding = 0;
  let maxOutstanding = 0;

  for (let round = 0; round < 3; round += 1) {
    const contact = deferred();
    const requests = Array.from({ length: 10 }, () => gate.run("tab-4", () => {
      calls += 1;
      outstanding += 1;
      maxOutstanding = Math.max(maxOutstanding, outstanding);
      return contact.promise.finally(() => { outstanding -= 1; });
    }, { fingerprint: "status" }));
    await Promise.resolve();
    assert.equal(outstanding, 1);
    setTimeout(() => contact.resolve(round), 600);
    await Promise.all(requests);
  }

  assert.equal(calls, 3);
  assert.equal(maxOutstanding, 1);
  assert.equal(outstanding, 0);
});

test("owned attempt retains one late settlement without changing public timeout behavior", async () => {
  let clock = 0;
  const contact = deferred();
  const gate = createReadOnlyBackpressure({
    now: () => clock,
    maxUnderlyingLifetimeMs: 100
  });
  const handle = gate.startOwned("owned-tab", () => contact.promise, {
    timeoutMs: 5,
    fingerprint: "readiness:episode-1",
    admissionClass: "fresh-authority",
    timeoutErrorFactory: () => Object.assign(new Error("timeout"), { code: "IDENTITY_TIMEOUT" })
  });

  await assert.rejects(handle.publicPromise, (error) => error?.code === "IDENTITY_TIMEOUT");
  assert.equal(gate.outstandingCount("owned-tab"), 1);
  assert.equal(typeof handle.ownerToken, "symbol");
  assert.equal(handle.settlement(), null);

  clock = 80;
  contact.resolve("late-identity-result");
  const settlement = await handle.settlementPromise;
  assert.equal(settlement.outcome, "fulfilled");
  assert.equal(settlement.value, "late-identity-result");
  assert.equal(settlement.settledAtMs, 80);
  assert.equal(handle.isSettlementEligible(settlement, {
    key: "owned-tab",
    fingerprint: "readiness:episode-1",
    admissionClass: "fresh-authority",
    deadlineMs: 90
  }), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(gate.outstandingCount("owned-tab"), 0);
});

test("owned settlement uses strict deadline and authority-expiry boundaries", async () => {
  let clock = 0;
  const gate = createReadOnlyBackpressure({ now: () => clock, maxUnderlyingLifetimeMs: 100 });

  for (const [offset, expected] of [[-1, true], [0, false], [1, false]]) {
    clock = 0;
    const key = `deadline-tab-${offset}`;
    const fingerprint = `run-read:deadline-${offset}`;
    const contact = deferred();
    const handle = gate.startOwned(key, () => contact.promise, {
      fingerprint,
      admissionClass: "fresh-authority"
    });
    clock = 50 + offset;
    contact.resolve(`deadline-${offset}`);
    const settlement = await handle.settlementPromise;
    assert.equal(handle.isSettlementEligible(settlement, {
      key,
      fingerprint,
      admissionClass: "fresh-authority",
      deadlineMs: 50
    }), expected, `recovery deadline ${offset >= 0 ? "+" : ""}${offset}ms eligibility`);
  }

  for (const [offset, expected] of [[-1, true], [0, false], [1, false]]) {
    clock = 200;
    const key = `expiry-tab-${offset}`;
    const fingerprint = `run-read:expiry-${offset}`;
    const contact = deferred();
    const handle = gate.startOwned(key, () => contact.promise, {
      fingerprint,
      admissionClass: "fresh-authority"
    });
    clock = 300 + offset;
    contact.resolve(`expiry-${offset}`);
    const settlement = await handle.settlementPromise;
    assert.equal(handle.isSettlementEligible(settlement, {
      key,
      fingerprint,
      admissionClass: "fresh-authority",
      deadlineMs: 400
    }), expected, `attempt expiry ${offset >= 0 ? "+" : ""}${offset}ms eligibility`);
  }
});

test("owned attempt is exclusive and superseded old results cannot win out of order", async () => {
  let clock = 0;
  const gate = createReadOnlyBackpressure({
    now: () => clock,
    maxUnderlyingLifetimeMs: 100,
    maxOutstandingPerKey: 2
  });
  const oldContact = deferred();
  const newContact = deferred();
  const options = {
    timeoutMs: 5,
    fingerprint: "send-preflight:episode",
    admissionClass: "fresh-authority"
  };
  const oldHandle = gate.startOwned("ordered-tab", () => oldContact.promise, options);
  assert.throws(
    () => gate.startOwned("ordered-tab", () => Promise.resolve("shared"), options),
    (error) => error?.code === "READ_ONLY_CONTACT_BUSY",
    "an owned handle is never lent to another caller"
  );
  await assert.rejects(oldHandle.publicPromise);

  clock = 100;
  oldHandle.expireIfDue();
  assert.equal(oldHandle.isSuperseded(), true);
  const newHandle = gate.startOwned("ordered-tab", () => newContact.promise, options);
  await assert.rejects(newHandle.publicPromise);
  assert.throws(
    () => gate.startOwned("ordered-tab", () => Promise.resolve("third"), options),
    (error) => error?.code === "READ_ONLY_CONTACT_BUSY",
    "two uncancellable contacts preserve the hard ceiling"
  );

  clock = 150;
  newContact.resolve("new-match");
  const newSettlement = await newHandle.settlementPromise;
  assert.equal(newHandle.isSettlementEligible(newSettlement, {
    key: "ordered-tab",
    fingerprint: options.fingerprint,
    admissionClass: options.admissionClass,
    deadlineMs: 180
  }), true);

  clock = 160;
  oldContact.resolve("old-mismatch");
  const oldSettlement = await oldHandle.settlementPromise;
  assert.equal(oldHandle.isSettlementEligible(oldSettlement, {
    key: "ordered-tab",
    fingerprint: options.fingerprint,
    admissionClass: options.admissionClass,
    deadlineMs: 180
  }), false, "a demoted old result has no authority even when it settles later");
});

test("production sources keep periodic observation separate from fresh mutation authority", () => {
  const background = fs.readFileSync(new URL("../src/background.js", import.meta.url), "utf8");
  const controller = fs.readFileSync(new URL("../src/content-controller.js", import.meta.url), "utf8");
  const runner = fs.readFileSync(new URL("../src/content-runner.js", import.meta.url), "utf8");
  const sidepanel = fs.readFileSync(new URL("../src/sidepanel.js", import.meta.url), "utf8");

  assert.match(sidepanel, /statusRefreshByTab\.state\(requestedTabId\)\.state !== "idle"/);
  assert.match(sidepanel, /setInterval\(\(\) => refreshStatus\(\{ periodic: true \}\), 1200\)/);
  assert.match(background, /freshAuthority: payload\.type !== "AIPM_GET_STATUS"/);
  assert.match(background, /readOnlyObservation: !freshAuthority/);
  assert.match(controller, /readOnlyObservation: message\.readOnlyObservation === true/);
  assert.match(background, /periodicOnly \? runObservationByTab : runAuthorityObservationByTab/);
  assert.match(background, /observationGate\.run\(tabId, readRun/);
  assert.doesNotMatch(
    background,
    /runObservationByTab\.run\(tabId, \(\) => serializeRunState\(tabId, readRun\)/,
    "an uncancellable observation must not wedge the durable Run mutation queue"
  );
  assert.match(background, /return serializeRunState\(tabId, readRun\);/);
  assert.match(runner, /readOnlyObservation: true,[\s\S]*authorityBoundary: "readiness"/);
  assert.match(runner, /const latest = await getActiveRun\(\{[\s\S]*authorityBoundary[\s\S]*\}\);/);
  assert.match(runner, /const authoritative = await getActiveRun\(\{[\s\S]*authorityBoundary: "run-read"[\s\S]*\}\);/);
  assert.match(runner, /renewLeaseHeartbeat\(lease, run\.runId, heartbeat\)/);
  assert.match(background, /documentIdentityByTab\.run\(tabId, executeProbe/);
  assert.match(background, /continueRecoveryEpisode: true/);
  assert.doesNotMatch(background, /withTimeout\(executeProbe/,
    "fresh document authority must use the same bounded backpressure gate");
});
