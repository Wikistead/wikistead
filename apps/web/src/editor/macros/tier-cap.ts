import type { MacroTier, MacroLevel, StandardLayer } from "./registry";

// Tenant macro level-cap demote logic (#93 / ADR-073) — PURE (no CM/DOM), the editor-side friendly
// counterpart to the server publish fortress (markdownExceedsLevelCap). Operates only on the
// MacroTier contract + the cap layer, so it is unit-testable without the editor runtime.
//
// Standard-layer ordering (most portable → least). The cap names the ceiling layer a tenant may use.
const LAYER_RANK: Record<StandardLayer, number> = { commonmark: 0, gfm: 1, directive: 2 };

// The demote target for a level cap: the LOWEST level within the cap that can represent the source
// (Open formats — most portable, matching the host's normal auto-demote), clamped by the cap. If
// NO level within the cap can represent it losslessly, the HIGHEST level within the cap — ADR-073's
// default is NORMALIZE (accept a lossy demote), not reject. null when the tier has no level within
// the cap (the caller leaves the source unchanged).
export function targetCapLevel(tier: MacroTier, source: string, cap: StandardLayer): MacroLevel | null {
  const withinCap = tier.levels.filter((l) => LAYER_RANK[l.layer] <= LAYER_RANK[cap]);
  if (withinCap.length === 0) return null;
  const representable = withinCap.filter((l) => tier.canRepresentAt(source, l)); // levels: lowest → highest
  return representable[0] ?? withinCap[withinCap.length - 1]!;
}

// Normalize the source to within the cap, returning the (possibly rewritten) source — a no-op when
// the tier has no level within the cap. The HOST calls this on persist/render; the server fortress
// (#93 publishPage) remains the authoritative bastion against a bypassing client.
export function demoteToCapLevel(tier: MacroTier, source: string, cap: StandardLayer): string {
  const target = targetCapLevel(tier, source, cap);
  return target ? tier.toLevel(source, target) : source;
}
