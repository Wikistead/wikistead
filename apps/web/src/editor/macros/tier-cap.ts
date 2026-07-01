import type { MacroTier, MacroLevel, StandardLayer } from "./registry";

// Auto-demote a macro to its LOWEST representable standard layer (ADR-025 Open formats) — PURE (no
// CM/DOM), unit-testable without the editor runtime. Operates only on the MacroTier contract.
//
// NOTE (#93): a TENANT macro level-cap (plan-driven ceiling) was WITHDRAWN — gating basic editor
// features behind a plan violates Community First. The `cap` parameter is retained as a general
// ceiling (callers pass 'directive' = no ceiling → the plain lowest-representable auto-demote), but no
// tenant plan drives it anymore. Keep this logic; it is the ADR-025 auto-demote, NOT the removed cap.
//
// Standard-layer ordering (most portable → least). The cap names the highest layer that may be used.
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

// Cap-free auto-demote (#93): normalize to the lowest representable layer with NO tenant ceiling
// (ADR-025 Open formats). The editor's save path uses this — level-cap was withdrawn, so 'directive'
// (the top layer) is always the ceiling.
export function autoDemote(tier: MacroTier, source: string): string {
  return demoteToCapLevel(tier, source, "directive");
}
