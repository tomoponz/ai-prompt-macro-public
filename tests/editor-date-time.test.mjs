import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { fromDateTimeLocal, toDateTimeLocal } from "../src/editor-date-time.js";

test("editor date conversion preserves empty and invalid input handling", () => {
  for (const value of ["", "not-a-date", undefined, Number.NaN]) {
    assert.equal(toDateTimeLocal(value), "");
    assert.equal(fromDateTimeLocal(value), "");
  }
  assert.equal(fromDateTimeLocal(null), "");
  assert.equal(fromDateTimeLocal(0), "");
});

const cases = [
  ["UTC", [
    ["2026-01-15T00:05:43.987Z", "2026-01-15T00:05", "2026-01-15T00:05:00.000Z"],
    ["2026-07-15T23:50:00.000Z", "2026-07-15T23:50", "2026-07-15T23:50:00.000Z"]
  ]],
  ["Asia/Tokyo", [
    ["2026-01-15T00:05:43.987Z", "2026-01-15T09:05", "2026-01-15T00:05:00.000Z"],
    ["2026-07-15T23:50:00.000Z", "2026-07-16T08:50", "2026-07-15T23:50:00.000Z"]
  ]],
  ["America/New_York", [
    ["2026-01-15T00:05:43.987Z", "2026-01-14T19:05", "2026-01-15T00:05:00.000Z"],
    ["2026-07-15T23:50:00.000Z", "2026-07-15T19:50", "2026-07-15T23:50:00.000Z"],
    ["2026-03-08T07:30:00.000Z", "2026-03-08T03:30", "2026-03-08T07:30:00.000Z"],
    ["2026-11-01T05:30:00.000Z", "2026-11-01T01:30", "2026-11-01T05:30:00.000Z"]
  ]]
];

for (const [timezone, examples] of cases) {
  test(`editor date conversion preserves local time and minute precision in ${timezone}`, () => {
    // A fresh process isolates the host timezone while importing the real module.
    // Expected strings are fixtures, not a second implementation of conversion.
    const moduleUrl = new URL("../src/editor-date-time.js", import.meta.url).href;
    execFileSync(process.execPath, ["--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import { fromDateTimeLocal, toDateTimeLocal } from ${JSON.stringify(moduleUrl)};
      for (const [iso, local, saved] of ${JSON.stringify(examples)}) {
        assert.equal(toDateTimeLocal(iso), local);
        assert.equal(fromDateTimeLocal(local), saved);
      }
      if (process.env.TZ === "America/New_York") {
        assert.equal(fromDateTimeLocal("2026-03-08T02:30"), "2026-03-08T07:30:00.000Z");
        assert.equal(toDateTimeLocal("2026-11-01T06:30:00.000Z"), "2026-11-01T01:30");
      }
    `], { env: { ...process.env, TZ: timezone }, encoding: "utf8" });
  });
}
