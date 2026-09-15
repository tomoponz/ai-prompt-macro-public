import test from "node:test";
import assert from "node:assert/strict";

import { createReadOnlyBackpressure } from "../src/read-only-backpressure.js";

test("R3: expired periodic hangs preserve a bounded slot for fresh user authority", async () => {
  let clock = 0;
  let periodicCalls = 0;
  let freshCalls = 0;
  const never = () => new Promise(() => {});
  const gate = createReadOnlyBackpressure({
    now: () => clock,
    maxOutstandingPerKey: 2,
    maxObservationOutstandingPerKey: 1,
    maxUnderlyingLifetimeMs: 10
  });

  void gate.run("tab-1", () => {
    periodicCalls += 1;
    return never();
  }, { fingerprint: "periodic", admissionClass: "observation" }).catch(() => {});
  await Promise.resolve();
  assert.equal(periodicCalls, 1);

  clock = 10;
  assert.equal(gate.state("tab-1").state, "saturated");

  void gate.run("tab-1", () => {
    periodicCalls += 1;
    return never();
  }, { fingerprint: "periodic-2", admissionClass: "observation" }).catch(() => {});
  await Promise.resolve();
  assert.equal(periodicCalls, 1, "periodic expiry must not consume the slot reserved for user authority");

  const fresh = await gate.run("tab-1", () => {
    freshCalls += 1;
    return Promise.resolve("fresh-authority");
  }, { fingerprint: "fresh", admissionClass: "fresh-authority" });

  assert.equal(fresh, "fresh-authority");
  assert.equal(freshCalls, 1);
  assert.equal(gate.outstandingCount("tab-1"), 1, "the uncancellable periodic orphan remains hard bounded");

  for (let index = 0; index < 20; index += 1) {
    clock += 10;
    void gate.run("tab-1", () => {
      periodicCalls += 1;
      return never();
    }, { fingerprint: `periodic-${index + 3}`, admissionClass: "observation" }).catch(() => {});
  }
  await Promise.resolve();
  assert.equal(periodicCalls, 1, "repeated expiry must not accumulate orphan contacts");
  assert.equal(gate.outstandingCount("tab-1"), 1);
});
