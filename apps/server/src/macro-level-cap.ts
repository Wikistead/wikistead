import type { MacroLevelCap } from '@wikistead/entitlements'

// Server-side macro LEVEL-CAP enforcement (#93 / ADR-073). The ADR makes the SERVER the fortress:
// persist-time normalize-or-reject, so a crafted client that bypasses the editor palette still
// can't persist content above the tenant's cap. The editor's auto-demote is the friendly path
// (frontend); this is the bastion — it REJECTS a publish whose Markdown uses constructs above the
// cap (with cap='directive', the default for all current plans, it is inert → no behavior change).
//
// SOUND SUBSET: a `:::name` opener is unambiguously the 'directive' standard layer, so any cap
// below 'directive' forbids it. The finer gfm-vs-commonmark distinction (e.g. pipe tables under a
// 'commonmark' cap) is deferred — detecting it without false rejects needs the macro tier model
// (editor registry); the directive check is sound (no false positives) and covers the main lever.
export function markdownExceedsLevelCap(md: string, cap: MacroLevelCap): boolean {
  if (cap === 'directive') return false // top layer — nothing exceeds it
  return /^:::[A-Za-z]/m.test(md) // a ::: container/block directive opener → directive layer
}
