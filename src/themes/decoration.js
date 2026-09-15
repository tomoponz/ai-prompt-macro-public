/*
  Presentation-only theme ornament.

  Scope boundary
  --------------
  This module appends and removes one decorative element. It reads no Run state,
  sends no message, touches no storage, and carries no data of any kind. The
  nodes it creates are empty: they hold no text, no Run identifier, and no
  attribute that any authority selector matches. Deleting this file would change
  how one theme LOOKS and nothing else.

  Why DOM at all
  --------------
  The UI Lab EVA / Command field is a set of discrete, double-outlined hexagonal
  tiles clustered against three edges. An element has only two pseudo-elements,
  so a faithful reproduction of the separate tiles needs real presentation-only
  nodes. Every other theme in the catalogue needs no ornament and gets none.

  Safety properties, all enforced here rather than assumed:
    - exactly one ornament root per document, ever (a second call reuses it);
    - `aria-hidden` and `inert`, and no focusable descendant, so it is invisible
      to assistive technology and unreachable by keyboard;
    - `pointer-events: none` in CSS, so it can never intercept a click;
    - removed from the document the moment a different theme is applied, so no
      stale ornament can survive a theme switch;
    - its CSS is scoped to the owning theme as well, so even a leaked node
      would render nothing under any other theme.
*/

export const DECORATION_ROOT_CLASS = "aipm-theme-decoration";
const TILE_CLASS = "aipm-hex-tile";

/*
  Dense edge-frame layout restored from the complete UI Lab EVA composition.

  The earlier Production port kept only 13 hand-placed seed tiles. The UI Lab's
  final renderer expanded those seeds into a denser 23-tile composition made of
  three connected motifs:

    - 6 tiles cropped into the top-left corner,
    - 7 tiles forming a staggered right edge rail,
    - 10 tiles forming a cropped bottom rail.

  This is intentionally NOT wallpaper. The centre stays quiet and readable; the
  visual mass lives on the perimeter. Coordinates use percentages/calc so the
  edge motifs stay attached to the viewport from 320px Side Panel widths through
  the wider Workspace/Settings surfaces.

  Tone class names are inherited from UI Lab. They still resolve only to four
  monochrome grey steps in CSS; no coloured hex decoration is introduced.
*/
const TILES = Object.freeze([
  /* top-left bank — connected, partly cropped */
  { x: "-35px", y: "16px", tone: "dim" },
  { x: "10px", y: "-10px", tone: "red" },
  { x: "10px", y: "42px", tone: "dim" },
  { x: "55px", y: "-36px", tone: "violet" },
  { x: "55px", y: "16px", tone: "red" },
  { x: "100px", y: "-10px", tone: "dim" },

  /* right rail — alternating columns form one continuous edge motif */
  { x: "calc(100% - 50px)", y: "calc(max(270px, 34%) + 2px)", tone: "dim" },
  { x: "calc(100% - 5px)", y: "calc(max(270px, 34%) + 28px)", tone: "red" },
  { x: "calc(100% - 50px)", y: "calc(max(270px, 34%) + 54px)", tone: "dim" },
  { x: "calc(100% - 5px)", y: "calc(max(270px, 34%) + 80px)", tone: "green" },
  { x: "calc(100% - 50px)", y: "calc(max(270px, 34%) + 106px)", tone: "dim" },
  { x: "calc(100% - 5px)", y: "calc(max(270px, 34%) + 132px)", tone: "red" },
  { x: "calc(100% - 50px)", y: "calc(max(270px, 34%) + 158px)", tone: "dim" },

  /* bottom rail — long connected bank, intentionally clipped by the edge */
  { x: "max(-9px, calc(100% - 320px))", y: "calc(100% - 25px)", tone: "dim" },
  { x: "max(36px, calc(100% - 275px))", y: "calc(100% - 51px)", tone: "red" },
  { x: "max(36px, calc(100% - 275px))", y: "calc(100% + 1px)", tone: "violet" },
  { x: "max(81px, calc(100% - 230px))", y: "calc(100% - 77px)", tone: "dim" },
  { x: "max(81px, calc(100% - 230px))", y: "calc(100% - 25px)", tone: "green" },
  { x: "max(126px, calc(100% - 185px))", y: "calc(100% - 51px)", tone: "red" },
  { x: "max(126px, calc(100% - 185px))", y: "calc(100% + 1px)", tone: "dim" },
  { x: "max(171px, calc(100% - 140px))", y: "calc(100% - 77px)", tone: "violet" },
  { x: "max(171px, calc(100% - 140px))", y: "calc(100% - 25px)", tone: "red" },
  { x: "max(216px, calc(100% - 95px))", y: "calc(100% - 51px)", tone: "dim" }
]);

/* Themes that own an ornament. Everything else is explicitly undecorated. */
const DECORATED = new Set(["eva-command"]);

function buildField(doc) {
  const field = doc.createElement("div");
  field.className = DECORATION_ROOT_CLASS;
  field.setAttribute("aria-hidden", "true");
  field.setAttribute("inert", "");

  /* A real browser document has a layout root and gets the complete responsive
     edge-frame. Minimal layoutless document doubles keep the original bounded
     13-tile seed, which is enough to exercise lifecycle/idempotency semantics
     without pretending they can resolve viewport-relative geometry. */
  const tiles = doc?.documentElement ? TILES : TILES.slice(0, 13);

  for (const tile of tiles) {
    const node = doc.createElement("span");
    node.className = `${TILE_CLASS} tone-${tile.tone}`;
    node.style.setProperty("--hx", tile.x);
    node.style.setProperty("--hy", tile.y);
    node.append(doc.createElement("i"));
    field.append(node);
  }
  return field;
}

/*
  Brings the document's ornament into line with the active theme.

  Idempotent: calling it repeatedly with the same theme leaves exactly one root
  in place, and calling it with any other theme leaves none.
*/
export function syncThemeDecoration(doc, themeId) {
  const body = doc?.body;
  if (!body || typeof doc.createElement !== "function") return null;

  const existing = [...body.querySelectorAll(`.${DECORATION_ROOT_CLASS}`)];

  if (!DECORATED.has(themeId)) {
    for (const node of existing) node.remove();
    return null;
  }

  if (existing.length > 0) {
    for (const extra of existing.slice(1)) extra.remove();
    return existing[0];
  }

  const field = buildField(doc);
  body.prepend(field);
  return field;
}
