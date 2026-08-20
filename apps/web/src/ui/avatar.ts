// Shared avatar primitives (#3 user · #4 space · #8 collab cursor). All three render
// the SAME identity affordance: a picture if one exists, else a deterministic
// initials chip whose colour is derived from a stable string (the user's sub, the
// space id, the cursor's identity). Deterministic = the same identity always gets the
// same colour across reloads and across peers, with no server round-trip.

// FNV-1a — a tiny, stable, well-distributed string hash. We only need determinism and
// spread, not cryptographic strength. `>>> 0` keeps it an unsigned 32-bit int.
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Deterministic, readable background colour for an initials avatar. HSL with a fixed
// saturation/lightness guarantees enough contrast for white text at any hue, and the
// hue space is continuous so distinct identities rarely collide visually.
export function colorFromString(seed: string): string {
  const hue = hashString(seed || "?") % 360;
  return `hsl(${hue} 58% 45%)`;
}

// #440the same colour as a HEX string. WebGL renderers (sigma, in the local graph) parse
// colours themselves and do not understand `hsl()` — a space-separated one least of all — so a node
// handed the CSS form silently fell back to the default paint while the DOM legend swatch beside it,
// which the browser resolved, showed the real colour. One seed, two renderers, two answers. Both
// sides now take this, so they cannot disagree.
export function colorHexFromString(seed: string): string {
  const hue = hashString(seed || "?") % 360;
  return hslToHex(hue, 58, 45);
}

// Minimal HSL→#rrggbb (fixed S/L above, so this only has to be correct, not general).
function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lN - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const hex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// 1–2 letter monogram from a display name. Two words → first letter of the first and
// last (e.g. "Ada Lovelace" → "AL"); one word → its first 1–2 chars. CJK/emoji names
// have no word boundaries, so a single leading character reads best. Falls back to "?"
// so an empty/whitespace name never produces a blank chip. Upper-cased for Latin.
export function initials(name: string): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "?";
  const graphemes = Array.from(trimmed);
  // #288: any non-ASCII glyph (CJK / emoji) → a SINGLE glyph. A half-width digit + full-width CJK pair
  // (e.g. from a CJK page title starting "246 …") has an unstable width, so the chip stretches and wraps
  // differently per size / per call site. Pick ONE glyph: a leading LETTER (ASCII or CJK) is meaningful
  // on its own; a leading digit/symbol is not, so skip to the first non-ASCII glyph (the meaningful
  // CJK/emoji) — a digit-prefixed CJK name yields its first CJK glyph.
  if (graphemes.some((g) => /[^\x00-\x7F]/.test(g))) {
    const first = graphemes[0]!;
    if (/\p{L}/u.test(first)) return first;
    return graphemes.find((g) => /[^\x00-\x7F]/.test(g)) ?? first;
  }
  // Pure ASCII/Latin: two words → first letter of the first + last; one word → its first 1–2 chars.
  const words = trimmed.split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}
