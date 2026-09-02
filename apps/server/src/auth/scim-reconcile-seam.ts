// #1053 / ADR-275 rev3 §3 (fast-path hooks): a CE commit that changes a tenant's admin composition
// may resolve a pending SCIM removal early. Whether one exists to resolve, and how, is EE-only (only
// EE's SCIM writes a pending row) — so this is the same seam shape `audit/sink.ts` uses for the
// ledger: a module-local registration slot, `null` on a CE/self-host build with no SCIM, and a
// null-safe wrapper CE calls unconditionally. The correctness backstop is the hourly sweep (§3's own
// text): a missed or absent hook here degrades latency, never correctness.
import type { OpenFgaClient } from '@openfga/sdk'
import type IORedis from 'ioredis'
import type { TenantDb } from '../db/index.js'

export type ScimReconcileHook = (
  deps: { db: TenantDb; fga: OpenFgaClient; valkey?: IORedis },
  tenant: { id: string; plan: string },
) => Promise<void>

let hook: ScimReconcileHook | null = null

/** Called once by the EE composition root, like registerAuditSink beside it. Last registration wins. */
export function registerScimReconcileHook(h: ScimReconcileHook): void {
  hook = h
}

/**
 * Fast-path only: re-evaluate this tenant's pending SCIM removals now, in-process, using the SAME
 * `db`/`fga`/`valkey` the caller's own commit just used. A no-op on a CE build (no SCIM registered)
 * and for a tenant with nothing pending alike — both resolve instantly, so callers need not check
 * first. `valkey` is threaded through deliberately: the eventual write is `suspendMember`'s, and
 * WITHOUT it a fast-path-resolved removal deactivates but leaves the member's session alive — worse
 * than a missed hook site, because clearing the pending pair also removes the row the hourly sweep
 * would otherwise have found and finished the job for.
 *
 * #1053 differ-back (finding F.2, independent review): best-effort, on purpose. §3's own text says
 * this fast path is "a LATENCY optimization only, not a correctness requirement" — but the first cut
 * let a throw here (an FGA hiccup, a lost connection) propagate straight into the CALLER's own
 * response, turning an otherwise-successful promotion, invite acceptance, or reactivation into a 500
 * for a reason that has nothing to do with what the caller actually asked for. Caught and logged here,
 * once, so all five call sites get the same protection without repeating a try/catch at each one; the
 * hourly sweep is still there to finish the job this attempt could not.
 */
export async function reconcilePendingScimRemovalsIfRegistered(
  deps: { db: TenantDb; fga: OpenFgaClient; valkey?: IORedis },
  tenant: { id: string; plan: string },
): Promise<void> {
  if (!hook) return
  try {
    await hook(deps, tenant)
  } catch (e) {
    console.error(JSON.stringify({
      msg: 'scim reconcile: fast-path hook failed (best-effort — the hourly sweep is the correctness backstop)',
      tenantId: tenant.id, error: e instanceof Error ? e.message : String(e),
    }))
  }
}
