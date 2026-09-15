import assert from "node:assert/strict";
import test from "node:test";
import { installSidePanelHarness } from "./helpers/sidepanel-harness.mjs";

test("production panel keeps title and active state separate from selected-tab authority", async () => {
  const h = await installSidePanelHarness({ storageSeed: { "aipm.selectedTab.v1": 1 } });
  try {
    let title = "同じ会話タイトル";
    let activeId = 2;
    let secondWindow = 1;
    const status = id => ({ provider: "chatgpt", contentVersion: "0.4.0", pageReady: true,
      conversationKey: `chatgpt:c:private-id-${id}`, run: null });
    h.setListTabsResponder(() => ({ ok: true, serviceWorkerVersion: "0.4.0", tabs: [1, 2].map(tabId => ({
      tabId, windowId: tabId === 1 ? 1 : secondWindow, active: tabId === activeId,
      displayTitle: title, status: status(tabId)
    })) }));
    await h.click("refreshTabs");
    assert.equal(h.el("targetTab").value, "1");
    const labels = () => h.el("targetTab").children.map(o => o.textContent);
    assert.match(labels()[0], /同じ会話タイトル · 操作対象/);
    assert.match(labels()[1], /同じ会話タイトル · 表示中/);
    assert.equal(labels().join().includes("private-id"), false);
    assert.match(h.el("targetTechnicalInfo").textContent, /タブID: 1\n会話 private-/);
    assert.equal(h.el("targetCard").dataset.targetState, "selected");
    title = "Changed title must not become authority";
    activeId = 1;
    await h.click("refreshTabs");
    assert.equal(h.el("targetTab").value, "1");
    assert.equal(h.el("targetCard").dataset.targetState, "selected-displayed");
    activeId = 2;
    secondWindow = 2;
    await h.click("refreshTabs");
    assert.equal(labels().join().includes("表示中"), false);
    h.setWindowResponder(() => Promise.reject(new Error("window unavailable")));
    await h.click("refreshTabs");
    assert.equal(labels().join().includes("表示中"), false);
    assert.equal(h.el("targetTab").value, "1");
    assert.equal(JSON.stringify([...h.storage]).includes(title), false);
    assert.equal(JSON.stringify(h.messages).includes(title), false);
    assert.equal(h.messages.filter(m => m.type === "AIPM_RELAY_TO_CHATGPT").every(m => m.targetTabId === 1), true);
    h.el("quickPrompt").value = "Explicit selected target only";
    h.el("quickRepeat").value = "1";
    await h.input("quickPrompt");
    await h.click("start");
    const starts = h.messages.filter(m => m.payload?.type === "AIPM_START");
    assert.equal(starts.length, 1);
    assert.equal(starts[0].targetTabId, 1);
    assert.equal(JSON.stringify(starts[0]).includes(title), false);
  } finally { h.restoreGlobals(); }
});
