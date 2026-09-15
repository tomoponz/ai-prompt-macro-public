import assert from "node:assert/strict";
import test from "node:test";
import { installBackgroundHarness, makeRun } from "./helpers/background-harness.mjs";

const h = await installBackgroundHarness();
test("production discovery returns normalized titles without persisting them or changing Run authority", async () => {
  const title = "PRIVATE_TITLE_SENTINEL";
  h.setTabs([{ id: 701, windowId: 1, active: true, url: "https://chatgpt.com/c/a", title: `\u202e${title}\n test` }]);
  h.putRun(701, makeRun({ boundTabId: 701 }));
  const before = structuredClone(h.storedRun(701));
  const response = await h.invoke({ type: "AIPM_LIST_CHATGPT_TABS" });
  assert.equal(response.ok, true);
  assert.equal(response.tabs[0].displayTitle, `${title} test`);
  assert.equal(JSON.stringify(response.tabs[0].status).includes(title), false);
  assert.equal(JSON.stringify(h.storageData).includes(title), false);
  assert.equal(JSON.stringify(h.sessionStorageData).includes(title), false);
  assert.deepEqual(h.storedRun(701), before);
  assert.equal(h.commandsDelivered(701).length, 0);
});

test("missing or throwing titles never break discovery and other-origin titles are not returned", async () => {
  const broken = { id: 702, windowId: 1, url: "https://chatgpt.com/" };
  Object.defineProperty(broken, "title", { get() { throw new Error("private title failure"); } });
  h.setTabs([broken, { id: 703, windowId: 1, url: "https://example.com/", title: "UNRELATED_PRIVATE_TITLE" }]);
  h.setContentProbe(703, { origin: "https://example.com", corePresent: false, controllerReady: false });
  const response = await h.invoke({ type: "AIPM_LIST_CHATGPT_TABS" });
  assert.equal(response.ok, true);
  assert.equal(response.tabs.find(t => t.tabId === 702).displayTitle, "");
  assert.equal(JSON.stringify(response).includes("UNRELATED_PRIVATE_TITLE"), false);
  assert.equal(JSON.stringify(h.storageData).includes("private title failure"), false);
});

test("a pending ChatGPT navigation cannot expose the previous origin's title", async () => {
  h.setTabs([{ id: 704, windowId: 1, active: true, url: "https://example.com/",
    pendingUrl: "https://chatgpt.com/", title: "PREVIOUS_ORIGIN_PRIVATE_TITLE" }]);
  const response = await h.invoke({ type: "AIPM_LIST_CHATGPT_TABS" });
  assert.equal(response.ok, true);
  assert.equal(response.tabs[0].displayTitle, "");
  assert.equal(JSON.stringify(response).includes("PREVIOUS_ORIGIN_PRIVATE_TITLE"), false);
});
