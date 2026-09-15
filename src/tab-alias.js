export const TAB_ALIAS_MAX_LENGTH = 40;
export const TAB_GROUP_MAX_LENGTH = 40;
export const TAB_PRESENTATION_STORAGE_KEY = "aipm.tabAliases.v1";
export const TAB_COLOR_PRESETS = Object.freeze([
  "default",
  "blue",
  "green",
  "yellow",
  "orange",
  "red",
  "purple"
]);

function normalizePresentationText(value, maxLength) {
  const compact = String(value ?? "").replace(/\s+/gu, " ").trim();
  return Array.from(compact).slice(0, maxLength).join("");
}

export function normalizeTabAlias(value) {
  return normalizePresentationText(value, TAB_ALIAS_MAX_LENGTH);
}

export function normalizeTabGroup(value) {
  return normalizePresentationText(value, TAB_GROUP_MAX_LENGTH);
}

export function normalizeTabColor(value) {
  return TAB_COLOR_PRESETS.includes(value) ? value : "default";
}

export function normalizeTabPresentation(value) {
  /* v1 stored the alias directly as a string. Accepting it here keeps existing
     browser-session data readable without creating a second source of truth. */
  const source = typeof value === "string"
    ? { alias: value }
    : (value && typeof value === "object" && !Array.isArray(value) ? value : {});
  return {
    alias: normalizeTabAlias(source.alias),
    color: normalizeTabColor(source.color),
    group: normalizeTabGroup(source.group)
  };
}

function hasPresentationValue(value) {
  return Boolean(value.alias || value.group || value.color !== "default");
}

export function normalizeTabPresentationMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [key, rawPresentation] of Object.entries(value)) {
    const tabId = Number.parseInt(key, 10);
    if (!Number.isInteger(tabId) || tabId < 0 || String(tabId) !== key) continue;
    const presentation = normalizeTabPresentation(rawPresentation);
    if (hasPresentationValue(presentation)) result[key] = presentation;
  }
  return result;
}

export function tabPresentationFor(map, tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return normalizeTabPresentation(null);
  return normalizeTabPresentation(map?.[String(tabId)]);
}

export function withTabPresentation(map, tabId, patch) {
  const next = normalizeTabPresentationMap(map);
  if (!Number.isInteger(tabId) || tabId < 0) return next;
  const key = String(tabId);
  const current = tabPresentationFor(next, tabId);
  const source = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  const presentation = normalizeTabPresentation({ ...current, ...source });
  if (hasPresentationValue(presentation)) next[key] = presentation;
  else delete next[key];
  return next;
}

export function normalizeTabAliasMap(value) {
  const result = {};
  for (const [key, presentation] of Object.entries(normalizeTabPresentationMap(value))) {
    const alias = presentation.alias;
    if (alias) result[key] = alias;
  }
  return result;
}

export function tabAliasFor(map, tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return "";
  return tabPresentationFor(map, tabId).alias;
}

export function withTabAlias(map, tabId, value) {
  return withTabPresentation(map, tabId, { alias: value });
}

export function formatTabAliasLabel(baseLabel, alias) {
  const base = String(baseLabel ?? "");
  const normalizedAlias = normalizeTabAlias(alias);
  return normalizedAlias ? `${normalizedAlias} · ${base}` : base;
}
