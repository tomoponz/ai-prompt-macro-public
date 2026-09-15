export function chooseInitialTargetId(rememberedTabId, tabs) {
  if (Number.isInteger(rememberedTabId)) return rememberedTabId;
  const available = Array.isArray(tabs) ? tabs : [];
  return available.find((item) => item?.active === true)?.tabId
    ?? available.find((item) => Number.isInteger(item?.tabId))?.tabId
    ?? null;
}

export function retainTargetOnRefresh(selectedTabId) {
  return Number.isInteger(selectedTabId) ? selectedTabId : null;
}

export function isCurrentTargetRequest(requestedTabId, requestedEpoch, selectedTabId, currentEpoch) {
  return requestedTabId === selectedTabId && requestedEpoch === currentEpoch;
}

export function canDispatchTargetIntent(
  requestedTabId,
  requestedEpoch,
  selectedTabId,
  currentEpoch,
  pendingSwitches,
  targetUiReady = true
) {
  return isCurrentTargetRequest(requestedTabId, requestedEpoch, selectedTabId, currentEpoch) &&
    pendingSwitches === 0 && targetUiReady === true;
}

export function targetHealth(selectedTabId, tabs, serviceWorkerVersion) {
  if (!Number.isInteger(selectedTabId)) return { ready: false, reason: "target-not-selected", item: null };
  const available = Array.isArray(tabs) ? tabs : [];
  const item = available.find((candidate) => candidate?.tabId === selectedTabId) ?? null;
  if (!item) return { ready: false, reason: "target-unreachable", item: null };
  if (item.status?.discoveryError) return { ready: false, reason: item.status.discoveryError, item };
  if (!serviceWorkerVersion || item.status?.contentVersion !== serviceWorkerVersion) {
    return { ready: false, reason: "version-mismatch", item };
  }
  if (item.status?.provider !== "chatgpt") return { ready: false, reason: "provider-mismatch", item };
  return { ready: true, reason: null, item };
}
