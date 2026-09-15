/*
  Appearance application for the three surfaces.

  Scope boundary
  --------------
  This module writes four presentation attributes onto the document element and
  keeps local presentation-only stylesheets attached to the owning extension
  document. It sends no runtime message, reads no Run state, holds no lease, and
  knows nothing about targets, documents, conversations or Send. The only
  storage key it touches is the settings key, and only to read it.

  That boundary is what makes the theme non-authoritative: the worst outcome of
  a corrupt, missing or hostile appearance value is a page that looks wrong.
  Start, Resume, Stop, target selection and every safety decision are computed
  from durable Run facts elsewhere and never consult these attributes.

  Two catalogue rules are enforced here rather than in CSS, because CSS cannot
  express them:

    stance  a design that supports only one luminance is PINNED to it. Handing a
            light-only design a dark palette would misrepresent it and produce
            contrast it was never checked at, so `data-aipm-mode` is written as
            the stance the theme actually has.

    accent  a design whose accent carries its identity renders its own accent.
            The user's stored preference is never rewritten — it is simply not
            applied while such a theme is active, and returns unchanged the
            moment a customizable theme is selected.

  Applying a theme also brings the document's decorative ornament into line. The
  ornament is presentation only and carries no data; see themes/decoration.js
  for the single-root, non-focusable, removed-on-switch guarantees.
*/

import {
  loadSettings,
  normalizeSettings,
  SETTINGS_STORAGE_KEY
} from "./settings-store.js";
import { effectiveAccent, normalizeThemeId, resolveThemeMode } from "./themes/registry.js";
import { syncThemeDecoration } from "./themes/decoration.js";

const DARK_QUERY = "(prefers-color-scheme: dark)";
const MANUAL_UX_STYLESHEET = new URL("./themes/manual-ux.css", import.meta.url).href;
const MANUAL_UX_MARKER = "aipmManualUx";
const EVA_RESTRAINED_STYLESHEET = new URL("./themes/eva-restrained.css", import.meta.url).href;
const EVA_RESTRAINED_MARKER = "aipmEvaRestrained";

function ensurePresentationStylesheet(doc) {
  const head = doc?.head;
  if (!head || typeof doc.createElement !== "function") return null;

  const existing = head.querySelector?.(`link[data-${MANUAL_UX_MARKER.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}]`);
  if (existing) return existing;

  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = MANUAL_UX_STYLESHEET;
  link.dataset[MANUAL_UX_MARKER] = "true";
  head.append(link);
  return link;
}

/*
  The dedicated restrained EVA layer is separate from the reviewed manual UX
  corrections. Keeping the established manual loader intact preserves its
  extension-local contract; calling this second loader afterwards gives EVA
  Restrained deterministic precedence without affecting any other theme.
*/
function ensureEvaRestrainedStylesheet(doc) {
  const head = doc?.head;
  if (!head || typeof doc.createElement !== "function") return null;

  const existing = head.querySelector?.(`link[data-${EVA_RESTRAINED_MARKER.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}]`);
  if (existing) return existing;

  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = EVA_RESTRAINED_STYLESHEET;
  link.dataset[EVA_RESTRAINED_MARKER] = "true";
  head.append(link);
  return link;
}

/*
  Applies one appearance object to a root element.

  `mode: "system"` is resolved here rather than in CSS so that every surface
  agrees on the resolution, and so the stylesheets only ever have to branch on a
  concrete light/dark attribute.
*/
export function applyAppearance(root, appearance, prefersDark = false) {
  if (!root?.dataset) return null;
  ensurePresentationStylesheet(root.ownerDocument ?? null);
  ensureEvaRestrainedStylesheet(root.ownerDocument ?? null);
  /* Normalizing the whole settings shape rather than the fragment means a
     partial or malformed object still yields a complete, bounded appearance. */
  const safe = normalizeSettings({ appearance }).appearance;
  const theme = normalizeThemeId(safe.theme);
  root.dataset.aipmTheme = theme;
  root.dataset.aipmAccent = effectiveAccent(theme, safe.accent);
  root.dataset.aipmDensity = safe.density;
  root.dataset.aipmMode = resolveThemeMode(theme, safe.mode, prefersDark === true);
  /* Ornament follows the theme. Guarded so a detached root (or a test double)
     simply skips it rather than throwing. */
  syncThemeDecoration(root.ownerDocument ?? null, theme);
  return safe;
}

/*
  Applies the stored appearance and keeps it in sync.

  Sync has two sources, both presentation only:
    - the settings key changing (the user edited Settings in another surface),
    - the host light/dark preference changing while `mode` is "system".

  Failure is silent by design. A surface that cannot read its theme must still
  render and stay fully operable, so this never throws and never blocks the
  caller's own initialization.
*/
export async function startAppearanceSync({
  root = globalThis.document?.documentElement ?? null,
  media = globalThis.matchMedia?.(DARK_QUERY) ?? null,
  storage = globalThis.chrome?.storage ?? null
} = {}) {
  if (!root?.dataset) return null;

  let current = normalizeSettings(null).appearance;

  const paint = () => applyAppearance(root, current, media?.matches === true);

  try {
    const result = await loadSettings();
    current = result.settings.appearance;
  } catch {
    /* Keep the normalized defaults. A theme is never worth failing a surface. */
  }
  paint();

  storage?.onChanged?.addListener?.((changes, areaName) => {
    if (areaName !== "local" || !Object.hasOwn(changes ?? {}, SETTINGS_STORAGE_KEY)) return;
    current = normalizeSettings(changes[SETTINGS_STORAGE_KEY]?.newValue).appearance;
    paint();
  });

  media?.addEventListener?.("change", paint);

  return current;
}
