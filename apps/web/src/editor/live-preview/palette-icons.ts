// #357: inline SVG icons for the slash palette. The palette is rendered in the CM tooltip layer as raw DOM
// (not React), so lucide React components can't be used — icons are trusted, self-contained inline SVG strings
// (no external fetch; CSP-safe, the #351 SocialIcon precedent). `currentColor` + a 16px box so each icon follows
// the row's theme (light/dark) and aligns with the label. Paths are lucide (ISC). One central map keyed by the
// palette command id (built-ins AND `macro:<name>`); an unmapped id falls back to a generic block glyph, so the
// layout never breaks and a new macro without an icon still lines up.

const svg = (paths: string) =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

// lucide path sets (verified structurally). Grouped by the palette command id.
const HEADING = svg('<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M17 10v8"/><path d="M17 14h4"/>');
const LIST = svg('<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>');
const LIST_ORDERED = svg('<line x1="10" x2="21" y1="6" y2="6"/><line x1="10" x2="21" y1="12" y2="12"/><line x1="10" x2="21" y1="18" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>');
const CHECK_SQUARE = svg('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>');
const QUOTE = svg('<path d="M10 11H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v6c0 3-1 4-4 5"/><path d="M20 11h-4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v6c0 3-1 4-4 5"/>');
const CODE = svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>');
const TABLE = svg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/>');
const DIVIDER = svg('<line x1="4" x2="20" y1="12" y2="12"/>');
const LINK = svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>');
const IMAGE = svg('<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>');
const PAGE_LINK = svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h3"/>');
const TEMPLATE = svg('<rect width="18" height="7" x="3" y="3" rx="1"/><rect width="9" height="7" x="3" y="14" rx="1"/><rect width="5" height="7" x="16" y="14" rx="1"/>');
const CALLOUT = svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>');
const COLUMNS = svg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>');
const TABS = svg('<path d="M3 8h4l2-3h6l2 3h4"/><rect width="18" height="12" x="3" y="8" rx="2"/>');
const DIAGRAM = svg('<circle cx="12" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M12 7v4"/><path d="M12 11 6 17"/><path d="m12 11 6 6"/>');
const DRAW = svg('<path d="m12 19 7-7 3 3-7 7-3-3z"/><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18z"/><path d="m2 2 7.586 7.586"/><circle cx="11" cy="11" r="2"/>');
const EMBED = svg('<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>');
const BACKLINKS = svg('<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 0 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/>');
const QUERY = svg('<path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>');
const HIGHLIGHT = svg('<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>');
const FALLBACK = svg('<rect width="16" height="16" x="4" y="4" rx="2"/>');

const ICONS: Record<string, string> = {
  h1: HEADING, h2: HEADING, h3: HEADING,
  ul: LIST, ol: LIST_ORDERED,
  todo: CHECK_SQUARE, "todo-ring": CHECK_SQUARE,
  quote: QUOTE, code: CODE, table: TABLE, divider: DIVIDER,
  link: LINK, image: IMAGE, "page-link": PAGE_LINK, "insert-template": TEMPLATE, highlight: HIGHLIGHT,
  // macro:<name> / macro:<lang>
  "macro:callout": CALLOUT, "macro:columns": COLUMNS, "macro:tabs": TABS, "macro:details": TABS,
  "macro:mermaid": DIAGRAM, "macro:plantuml": DIAGRAM, "macro:excalidraw": DRAW,
  "macro:embed-page": PAGE_LINK, "macro:embed-external": EMBED, "macro:embed": EMBED,
  "macro:backlinks": BACKLINKS, "macro:query": QUERY, "macro:todo": CHECK_SQUARE, "macro:table": TABLE,
};

// The icon SVG string for a palette command id (built-in or `macro:<name>`); a generic block glyph otherwise.
export function paletteIcon(id: string): string {
  return ICONS[id] ?? FALLBACK;
}
