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
 */
export async function reconcilePendingScimRemovalsIfRegistered(
  deps: { db: TenantDb; fga: OpenFgaClient; valkey?: IORedis },
  tenant: { id: string; plan: string },
): Promise<void> {
  if (hook) await hook(deps, tenant)
}
