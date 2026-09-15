const version = document.querySelector("#extensionVersion");
const reloadButton = document.querySelector("#reloadExtension");
const reloadMessage = document.querySelector("#reloadExtensionMessage");
let reloadCheckInFlight = false;

if (version) version.textContent = chrome.runtime.getManifest().version;

reloadButton?.addEventListener("click", async () => {
  if (reloadCheckInFlight) return;
  reloadCheckInFlight = true;
  try {
    let active = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: "AIPM_HAS_ACTIVE_RUNS" });
      if (response?.ok !== true || typeof response.active !== "boolean") {
        throw new Error("Active-run state was not confirmed");
      }
      active = response?.active === true;
    } catch {
      if (reloadMessage) {
        reloadMessage.textContent = "実行状態を確認できないため、安全のため拡張を再読み込みしません。ChatGPTタブを確認してから、もう一度試してください。";
      }
      return;
    }

    if (active) {
      if (reloadMessage) {
        reloadMessage.textContent = "いずれかのChatGPTタブで自動化が実行中または一時停止中です。Side Panelで停止してから、拡張を再読み込みしてください。";
      }
      return;
    }

    if (reloadMessage) {
      reloadMessage.textContent = "拡張を再読み込みします。完了後、ChatGPTタブもCtrl+Rしてください。";
    }
    chrome.runtime.reload();
  } finally {
    reloadCheckInFlight = false;
  }
});
