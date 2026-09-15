import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const coreSource = fs.readFileSync(new URL("../../src/content-core.js", import.meta.url), "utf8");
const sessionStore = new Map();
const context = vm.createContext({
  console,
  crypto: webcrypto,
  sessionStorage: {
    getItem(key) { return sessionStore.get(key) ?? null; },
    setItem(key, value) { sessionStore.set(key, String(value)); }
  }
});
vm.runInContext(coreSource, context, { filename: "content-core.js" });

// Runner-only unit harnesses inject this exact production helper instead of
// maintaining a second effective-empty implementation.
export function productionComposerIsEffectivelyEmpty(text) {
  return context.composerIsEffectivelyEmpty(text);
}
