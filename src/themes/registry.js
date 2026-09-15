/*
  Canonical theme catalogue.

  Scope boundary
  --------------
  This module is pure data plus total pure functions. It performs no I/O, sends
  no message, and reads no Run state. Nothing here participates in an authority
  decision: a corrupted or unknown theme value can change how the product LOOKS
  and nothing else. Start, Resume, Stop, target selection and every safety
  decision are computed from durable Run facts elsewhere.

  Provenance
  ----------
  `origin` records where each design came from so the catalogue stays auditable.
  Twenty-one entries are ported from UI Lab design studies;
  `default`, `eva-restrained`, and the measured current Claude product style
  originate in this repository.

  Axes
  ----
  `stance`        which luminances the design actually supports. A single-stance
                  design is NOT given a fabricated opposite palette. Product
                  styles that now have independently reviewed real-world dark
                  references declare `both` and resolve through the Mode axis.
  `accentPolicy`  "customizable" — the user accent may repaint the accent role.
                  "fixed"        — the accent is load-bearing to the design's
                                   identity. The stored preference is kept and
                                   simply not applied while such a theme is
                                   active, so switching back restores it.
  `decoration`    a presentation-only ornament key, or null.

  Accent never writes a `--aipm-status-*` token in any theme, which is the
  mechanical reason taste cannot change what a status means.
*/

export const THEME_GROUPS = Object.freeze([
  Object.freeze({ id: "standard", label: "標準" }),
  Object.freeze({ id: "product", label: "UIスタイル" }),
  Object.freeze({ id: "operator", label: "オペレーター / 技術" }),
  Object.freeze({ id: "editorial", label: "エディトリアル / 実用" }),
  Object.freeze({ id: "eva", label: "コマンド" })
]);

const theme = (id, displayName, group, origin, stance, accentPolicy, decoration = null) =>
  Object.freeze({ id, displayName, group, origin, stance, accentPolicy, decoration });

export const THEMES = Object.freeze([
  /* ---------------------------------------------------------- standard */
  theme("default", "標準", "standard", "production", "both", "customizable"),
  theme("clean-premium", "上質なシンプル", "standard", "ui-lab:clean", "both", "customizable"),

  /* ---------------------------------------------------------- UI style */
  // IDs remain legacy compatibility identifiers for stored settings and CSS.
  // Display labels are brand-neutral; no affiliation or endorsement is implied.
  theme("chatgpt-native", "ニュートラル", "product", "ui-lab:chatgpt-native", "both", "customizable"),
  theme("google-native", "すっきり実用", "product", "ui-lab:google-native", "both", "customizable"),
  theme("claude-native", "温かみのある紙面", "product", "production:claude-current", "both", "customizable"),
  theme("microsoft-fluent", "やわらかなガラス", "product", "ui-lab:fluent", "both", "customizable"),
  theme("apple-utility", "ミニマル", "product", "ui-lab:apple-utility", "both", "customizable"),
  theme("linear-saas", "ダーク業務UI", "product", "ui-lab:linear-saas", "dark", "customizable"),

  /* ------------------------------------------------ operator / technical */
  theme("terminal", "ターミナル", "operator", "ui-lab:terminal", "dark", "fixed"),
  theme("modern-terminal", "モダンターミナル", "operator", "ui-lab:modern-terminal", "dark", "fixed"),
  theme("mission-control", "管制室", "operator", "ui-lab:mission-control", "dark", "fixed"),
  theme("operator-dense", "高密度コンソール", "operator", "ui-lab:operator-dense", "dark", "customizable"),
  theme("industrial-control", "産業機器", "operator", "ui-lab:industrial", "light", "fixed"),
  theme("mecha", "メカ", "operator", "ui-lab:mecha", "dark", "fixed"),
  theme("neo-tech", "近未来", "operator", "ui-lab:neo", "dark", "fixed"),

  /* --------------------------------------------- editorial / utility */
  theme("swiss-information", "スイス式情報整理", "editorial", "ui-lab:swiss", "light", "fixed"),
  theme("technical-manual", "技術マニュアル", "editorial", "ui-lab:technical-manual", "light", "customizable"),
  theme("brutalist-utility", "無骨な実用", "editorial", "ui-lab:brutalist", "light", "fixed"),
  theme("monochrome-engineering", "モノクロ設計", "editorial", "ui-lab:mono-eng", "light", "fixed"),
  theme("scientific-instrument", "科学計測器", "editorial", "ui-lab:instrument", "light", "customizable"),
  theme("calm-productivity", "落ち着いた作業環境", "editorial", "ui-lab:calm", "light", "customizable"),
  theme("japanese-systems", "日本語業務システム", "editorial", "ui-lab:jp-systems", "light", "customizable"),

  /* --------------------------------------------------------------- EVA */
  theme("eva-command", "コマンド / 司令室", "eva", "ui-lab:eva", "both", "fixed", "hex-field"),
  theme("eva-restrained", "コマンド / 控えめ", "eva", "production:eva", "both", "customizable")
]);

export const THEME_IDS = Object.freeze(THEMES.map((entry) => entry.id));

export const DEFAULT_THEME_ID = "default";

/*
  Legacy stored values.

  The accepted Production build shipped `theme: "eva"` meaning the restrained
  charcoal/ochre design. The catalogue also contains a faithful port of the UI
  Lab EVA / Command, which is a DIFFERENT design. A stored "eva" must therefore
  resolve to `eva-restrained`, never to `eva-command`, or an existing user's
  panel would silently change appearance.
*/
export const LEGACY_THEME_ALIASES = Object.freeze({
  eva: "eva-restrained"
});

const THEME_BY_ID = new Map(THEMES.map((entry) => [entry.id, entry]));

/* Total: any input at all yields a known catalogue id. */
export function normalizeThemeId(value) {
  if (typeof value !== "string") return DEFAULT_THEME_ID;
  if (THEME_BY_ID.has(value)) return value;
  const alias = Object.hasOwn(LEGACY_THEME_ALIASES, value) ? LEGACY_THEME_ALIASES[value] : null;
  return alias && THEME_BY_ID.has(alias) ? alias : DEFAULT_THEME_ID;
}

export function themeById(id) {
  return THEME_BY_ID.get(normalizeThemeId(id)) ?? THEME_BY_ID.get(DEFAULT_THEME_ID);
}

/* Resolves the luminance a theme will actually render at. */
export function resolveThemeMode(id, requestedMode, prefersDark = false) {
  const entry = themeById(id);
  if (entry.stance !== "both") return entry.stance;
  if (requestedMode === "light" || requestedMode === "dark") return requestedMode;
  return prefersDark === true ? "dark" : "light";
}

/* True when the theme lets the user accent repaint its accent role. */
export function themeAllowsAccent(id) {
  return themeById(id).accentPolicy === "customizable";
}

/* The accent actually applied for a theme. */
export function effectiveAccent(id, storedAccent) {
  return themeAllowsAccent(id) ? storedAccent : "theme";
}

export function themesByGroup() {
  return THEME_GROUPS.map((group) => Object.freeze({
    ...group,
    themes: THEMES.filter((entry) => entry.group === group.id)
  }));
}
