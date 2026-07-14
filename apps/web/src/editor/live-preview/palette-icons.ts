// #357: inline SVG icons for the slash palette. The palette is rendered in the CM tooltip layer as raw DOM
// (not React), so lucide React components can't be used — icons are trusted, self-contained inline SVG strings
// (no external fetch; CSP-safe, the #351 SocialIcon precedent). `currentColor` + a 16px box so each icon follows
// the row's theme (light/dark) and aligns with the label. Paths are lucide (ISC).
//
// #357 EVERY shipped palette command has an EXPLICIT icon here — the `palette-icons.test` fails if any
// registry/built-in command id would fall through to FALLBACK (a generic square). The fallback is reserved for
// a future, not-yet-mapped id (a new macro shipped without an icon still lines up rather than breaking layout),
// never for a command we ship today. Icon choices follow the app's existing visual language: the callout types
// reuse the SAME glyphs as the callout panel (callout-icons.css), and "insert template" reuses FileStack (the
// TemplatePickerDialog / TemplatesPage icon).

const svg = (paths: string) =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

// ── structural / built-in ────────────────────────────────────────────────────
const HEADING = svg('<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M17 10v8"/><path d="M17 14h4"/>');
const LIST = svg('<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>');
const LIST_ORDERED = svg('<line x1="10" x2="21" y1="6" y2="6"/><line x1="10" x2="21" y1="12" y2="12"/><line x1="10" x2="21" y1="18" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>');
const CHECK_SQUARE = svg('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>');
const CIRCLE_CHECK = svg('<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'); // #290 todo-ring: a progress ring, distinct from /todo
const QUOTE = svg('<path d="M10 11H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v6c0 3-1 4-4 5"/><path d="M20 11h-4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v6c0 3-1 4-4 5"/>');
const CODE = svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>');
const TABLE = svg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/>');
const DIVIDER = svg('<line x1="4" x2="20" y1="12" y2="12"/>');
const LINK = svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'); // URL link = a plain chain
const IMAGE = svg('<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>');
const FILE_SYMLINK = svg('<path d="m10 18 3-3-3-3"/><path d="M4 11V4a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2h-6"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>'); // page-link (internal): a page + a link arrow, vs the plain URL chain
const FILE_STACK = svg('<path d="M21 7h-3a2 2 0 0 1-2-2V2"/><path d="M21 6v6.5c0 .8-.7 1.5-1.5 1.5h-7c-.8 0-1.5-.7-1.5-1.5v-9c0-.8.7-1.5 1.5-1.5H17Z"/><path d="M7 8v8.8c0 .3.2.6.4.8.2.2.5.4.8.4H15"/><path d="M3 12v8.8c0 .3.2.6.4.8.2.2.5.4.8.4H11"/>'); // insert-template: matches TemplatePickerDialog / TemplatesPage
const LIST_TREE = svg('<path d="M21 12h-8"/><path d="M21 6H8"/><path d="M21 18h-8"/><path d="M3 6v4c0 1.1.9 2 2 2h3"/><path d="M3 10v6c0 1.1.9 2 2 2h3"/>'); // children: a hierarchy/tree
const TAG = svg('<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>'); // tagged / page-tags: a tag

// ── callout types: the SAME glyphs the callout panel paints (callout-icons.css) ──
const CALLOUT_NOTE = svg('<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>'); // pencil
const CALLOUT_INFO = svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>');
const CALLOUT_TIP = svg('<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>'); // lightbulb
const CALLOUT_WARNING = svg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'); // triangle-alert
const CALLOUT_DANGER = svg('<path d="M12 16h.01"/><path d="M12 8v4"/><path d="M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688A2 2 0 0 1 15.312 22H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z"/>'); // octagon-alert

// ── layout / diagram / embed macros ──────────────────────────────────────────
const COLUMNS = svg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>');
const TABS = svg('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 8h20"/><path d="M6 4v4"/><path d="M10 4v4"/>'); // app-window: a panel with top tabs (not the old briefcase)
// #357 list-collapse (rows + a collapse chevron), NOT square-chevron-down — the boxed chevron read too
// close to the todo SquareCheck. ListCollapse's list rows make "a collapsible list" unambiguous.
const DETAILS = svg('<path d="m3 10 2.5-2.5L3 5"/><path d="m3 19 2.5-2.5L3 14"/><path d="M10 6h11"/><path d="M10 12h11"/><path d="M10 18h11"/>');
const WORKFLOW = svg('<circle cx="12" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M12 7v4"/><path d="M12 11 6 17"/><path d="m12 11 6 6"/>'); // mermaid: connected nodes
const NETWORK = svg('<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>'); // plantuml: UML boxes
const DRAW = svg('<path d="m12 19 7-7 3 3-7 7-3-3z"/><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18z"/><path d="m2 2 7.586 7.586"/><circle cx="11" cy="11" r="2"/>'); // excalidraw: pen
const FILE_INPUT = svg('<path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M2 15h10"/><path d="m9 18 3-3-3-3"/><path d="M14.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4"/>'); // embed-page: content flowing into a page (transclude)
const GLOBE = svg('<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'); // embed-external: the web

const FALLBACK = svg('<rect width="16" height="16" x="4" y="4" rx="2"/>'); // future/unmapped ids ONLY (see the coverage test)

const ICONS: Record<string, string> = {
  // built-in structural
  h1: HEADING, h2: HEADING, h3: HEADING,
  ul: LIST, ol: LIST_ORDERED,
  todo: CHECK_SQUARE, "todo-ring": CIRCLE_CHECK,
  quote: QUOTE, code: CODE, table: TABLE, divider: DIVIDER,
  link: LINK, image: IMAGE, "page-link": FILE_SYMLINK, "insert-template": FILE_STACK,
  "page-tags": TAG,
  // callout types (macro:<type>) — the panel's own glyphs
  "macro:note": CALLOUT_NOTE, "macro:info": CALLOUT_INFO, "macro:tip": CALLOUT_TIP,
  "macro:warning": CALLOUT_WARNING, "macro:danger": CALLOUT_DANGER,
  // layout / diagram / embed macros
  "macro:columns": COLUMNS, "macro:tabs": TABS, "macro:details": DETAILS,
  "macro:mermaid": WORKFLOW, "macro:plantuml": NETWORK, "macro:excalidraw": DRAW,
  "macro:embed-page": FILE_INPUT, "macro:embed-external": GLOBE,
  "macro:tagged": TAG, "macro:children": LIST_TREE,
};

// The icon SVG string for a palette command id (built-in or `macro:<name>`); a generic block glyph otherwise.
export function paletteIcon(id: string): string {
  return ICONS[id] ?? FALLBACK;
}

// #357 does this id have an EXPLICIT icon (not the fallback)? The coverage test asserts every shipped
// command id does, so a new command/macro can't silently ship as a generic square.
export function hasExplicitPaletteIcon(id: string): boolean {
  return id in ICONS;
}
