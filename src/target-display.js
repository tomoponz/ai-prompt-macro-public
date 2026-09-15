// Ephemeral presentation only. These values must never authorize a Run or be persisted.
export const TARGET_TITLE_MAX_LENGTH = 150;

export function normalizeTargetTitle(value) {
  if (typeof value !== "string") return "";
  const clean = value.replace(/\s/gu, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/ +/g, " ").trim();
  return Array.from(clean).slice(0, TARGET_TITLE_MAX_LENGTH).join("");
}

export function targetDisplayName(item) {
  const title = normalizeTargetTitle(item?.displayTitle);
  if (title) return title;
  if (String(item?.status?.conversationKey).startsWith("chatgpt:new:")) return "新しいチャット";
  return Number.isInteger(item?.tabId) ? `ChatGPTタブ #${item.tabId}` : "ChatGPTタブ";
}

export function targetDisplayState(item, selectedTabId, panelWindowId) {
  const selected = Number.isInteger(selectedTabId) && item?.tabId === selectedTabId;
  const displayed = Number.isInteger(panelWindowId) && panelWindowId >= 0 &&
    item?.windowId === panelWindowId && item?.active === true;
  return {
    selected,
    displayed,
    label: [selected ? "操作対象" : "", displayed ? "表示中" : ""].filter(Boolean).join(" · "),
    accent: selected ? (displayed ? "selected-displayed" : "selected") : (displayed ? "displayed" : "neutral")
  };
}
