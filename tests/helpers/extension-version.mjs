import fs from "node:fs";

// Current-release fixtures follow the shipped protocol version. Deliberate stale
// version fixtures remain explicit in their individual tests.
export const CURRENT_EXTENSION_VERSION = JSON.parse(
  fs.readFileSync(new URL("../../manifest.json", import.meta.url), "utf8")
).version;
