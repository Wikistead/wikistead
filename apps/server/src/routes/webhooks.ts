import { createHmac, randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Sql } from 'postgres'
import type { OpenFgaClient } from '@openfga/sdk'
import { resolveEntitlements } from '@wikistead/entitlements'
import { pool } from '../db/pool.js'
import type { TenantDb } from '../db/index.js'
import { encryptSecret, decryptSecret } from '../auth/secret-crypto.js'
import { guardedFetch } from '../safe-fetch.js'

// #228 / ADR-108: outbound webhooks. A subscription is admin-managed (RLS) and gated by the `webhooks`
// entitlement at CREATION. Events are enqueued IN the operation's tx (enqueueWebhookOutbox — like the audit
// outbox, NOT the fire-and-forget emit bus), so a commit-then-crash still delivers. A cross-tenant worker
// drains the outbox, signs each delivery with HMAC, and uses the PINNED SSRF-safe client (guardedFetch
// re-resolve+re-screen per delivery, no redirect follow — a 3xx is a FAILURE). N consecutive failures
// auto-disable a hook. Payload is THIN (ids/type/actor/timestamp — never title/content), and events about a
// PRIVATE or UNPUBLISHED-DRAFT page are never delivered (instance-level existence-hiding, comment 1000).

const MAX_ATTEMPTS = 6            // drop + auto-disable after this many failed deliveries of a row
const AUTO_DISABLE_FAILURES = 10  // consecutive per-hook failures → active=false
const BACKOFF_BASE_S = 30         // exponential backoff base (30s, 60s, 120s, …)

export interface WebhookRow { id: string; url: string; event_filter: string[] | null; active: boolean; failure_count: number; created_at: Date }
export interface WebhookOutboxRow { id: string; tenant_id: string; event_type: string; payload: Record<string, unknown>; attempts: number }

// ── model (admin CRUD) ──────────────────────────────────────────────────────

// Create a webhook. Entitlement-gated (issuance only). The secret is generated server-side, ENCRYPTED at
// rest, and returned exactly ONCE (never again). URL is validated as http(s); the SSRF screen is applied at
// DELIVERY (a URL can resolve to a blocked IP only at send time — DNS can change).
export async function createWebhook(
  db: TenantDb,
  args: { tenantId: string; plan: string; userId: string; url: string; eventFilter?: string[] | null },
): Promise<{ id: string; secret: string }> {
  if (!resolveEntitlements(args.plan).webhooks) throw Object.assign(new Error('webhooks not available on this plan'), { statusCode: 402 })
  let u: URL
  try { u = new URL(args.url) } catch { throw Object.assign(new Error('invalid url'), { statusCode: 400 }) }
  // https-only, UNIFORM with delivery. The SSRF-safe delivery client (guardedFetch → resolveGuarded) is
  // https-only, so accepting an http:// URL at creation would produce a hook that can NEVER deliver (it
  // fails every send and auto-disables) — a silently-dead config. Reject http here so creation and delivery
  // agree. A self-host http / internal-egress path is a deliberate SSRF-surface expansion → future ADR, not
  // a create-time opt-in (#228 review 1).
  if (u.protocol !== 'https:') throw Object.assign(new Error('url must be https'), { statusCode: 400 })
  const secret = randomBytes(24).toString('base64url')
  const filter = args.eventFilter && args.eventFilter.length ? args.eventFilter : null
  const [row] = await db.sql<{ id: string }[]>`
    INSERT INTO webhooks (tenant_id, url, secret_enc, event_filter, created_by)
    VALUES (${args.tenantId}, ${args.url}, ${encryptSecret(secret)}, ${filter as unknown as string[] | null}, ${`user:${args.userId}`})
    RETURNING id`
  return { id: row!.id, secret } // secret returned ONCE (write-once)
}

export async function listWebhooks(db: TenantDb): Promise<WebhookRow[]> {
  return db.sql<WebhookRow[]>`SELECT id, url, event_filter, active, failure_count, created_at FROM webhooks ORDER BY created_at DESC`
}

export async function deleteWebhook(db: TenantDb, id: string): Promise<boolean> {
  const res = await db.sql`DELETE FROM webhooks WHERE id = ${id}`
  return res.count > 0
}

// ── in-tx enqueue (reliability core) ────────────────────────────────────────

// Enqueue a webhook event IN the operation's tx (mirrors enqueueAudit). Thin payload only. The private/
// draft existence-hiding filter is applied at DRAIN (it needs the current FGA state, and the row is cheap).
export async function enqueueWebhookOutbox(sql: Sql, args: { tenantId: string; eventType: string; payload: Record<string, unknown> }): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO webhook_outbox (tenant_id, event_type, payload)
    VALUES (${args.tenantId}, ${args.eventType}, ${args.payload as unknown as string})
    RETURNING id`
  return row!.id
}

// ── delivery worker ─────────────────────────────────────────────────────────

// #228 comment 1000: an event about a PRIVATE or UNPUBLISHED-DRAFT page must NOT be delivered (its pageId/
// actor would leak the existence the 404-uniform surface hides). Disposition is TRI-state so the drain can
// tell a hard-suppress (private → drop now, security) apart from a transient not-yet-linked page (retry)
// 'suppress' — a `private` marker is present: drop immediately, never deliver (existence-hiding).
// 'deliver' — has a `page#space` tuple (published / space-linked) and no private marker.
// 'not-ready' — neither: a `page.published` whose page#space FGA write hasn't landed yet (it is written
// AFTER the publish tx commits, so the outbox row can briefly out-race it — #228 review
// 2), OR a genuine draft event. Retry with backoff; drop after MAX_ATTEMPTS. Never
// delivers while unlinked, so a real draft's existence stays hidden either way.
// Non-page events are always 'deliver'. Fails CLOSED to 'suppress' on any FGA error.
type EventDisposition = 'suppress' | 'deliver' | 'not-ready'
async function pageEventDisposition(fga: OpenFgaClient, payload: Record<string, unknown>): Promise<EventDisposition> {
  const pageId = typeof payload.pageId === 'string' ? payload.pageId : (payload.resource as { type?: string; id?: string } | undefined)?.id
  if (!pageId) return 'deliver' // not a page event → no instance-level exclusion
  try {
    const { tuples } = await fga.read({ object: `page:${pageId}` })
    const rel = (tuples ?? []).map((t) => t.key)
    const linked = rel.some((k) => k?.relation === 'space') // page#space → published/space-linked (not a draft)
    // #228 review 3: suppress on ANY `private` marker, not just `private@user:*`. The model writes private
    // as the pair [user:*, share_link:*] (model.fga), so this is equivalent in the happy path — but if a
    // write-path bug ever left a lone `share_link:*` private tuple, keying on user:* alone would leak the
    // existence this hides. Relation-only is strictly more defensive (fail toward suppression).
    const priv = rel.some((k) => k?.relation === 'private')
    if (priv) return 'suppress'
    return linked ? 'deliver' : 'not-ready'
  } catch { return 'suppress' } // fail closed
}

const signBody = (secret: string, ts: string, body: string) => `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`

// Drain a batch of due outbox rows and deliver each to every matching, active hook of its tenant. Claims
// via FOR UPDATE SKIP LOCKED (disjoint across workers), sets app.tenant_id per row (RLS reads its hooks).
// A failure reschedules with exponential backoff and bumps the hook's failure_count (auto-disable at N);
// a 2xx clears it. A 3xx/4xx/5xx (guardedFetch never follows redirects) is a FAILURE. Returns rows handled.
export async function drainWebhookOutbox(fga: OpenFgaClient, opts: { batch?: number } = {}): Promise<number> {
  const batch = opts.batch ?? 20
  const send = guardedFetch({ maxBytes: 8 * 1024, timeoutMs: 10_000 })
  return pool.begin(async (tx) => {
    const rows = await tx<WebhookOutboxRow[]>`
      SELECT id, tenant_id, event_type, payload, attempts FROM webhook_outbox
      WHERE claimed_at IS NULL AND next_attempt_at <= now()
      ORDER BY next_attempt_at LIMIT ${batch} FOR UPDATE SKIP LOCKED`
    for (const row of rows) {
      // Instance-level existence-hiding (tri-state). A private page → drop now (never deliver). A page whose
      // page#space link hasn't landed yet (publish writes it just after the tx) → RETRY, don't permanently
      // drop a legitimate page.published (#228 review 2); dropped only once attempts are exhausted, and it
      // never delivers while unlinked so a genuine draft stays hidden.
      const disp = await pageEventDisposition(fga, row.payload)
      if (disp === 'suppress') { await tx`DELETE FROM webhook_outbox WHERE id = ${row.id}`; continue }
      if (disp === 'not-ready') {
        if (row.attempts + 1 >= MAX_ATTEMPTS) { await tx`DELETE FROM webhook_outbox WHERE id = ${row.id}` }
        else {
          const backoff = BACKOFF_BASE_S * Math.pow(2, row.attempts)
          await tx`UPDATE webhook_outbox SET attempts = attempts + 1, next_attempt_at = now() + (${backoff} || ' seconds')::interval WHERE id = ${row.id}`
        }
        continue
      }
      await tx`SELECT set_config('app.tenant_id', ${row.tenant_id}, true)`
      const hooks = await tx<{ id: string; url: string; secret_enc: string; event_filter: string[] | null }[]>`
        SELECT id, url, secret_enc, event_filter FROM webhooks WHERE active = TRUE`
      const body = JSON.stringify({ id: row.id, type: row.event_type, ...row.payload })
      const ts = String(Math.floor(Date.now() / 1000))
      let allOk = true
      for (const h of hooks) {
        if (h.event_filter && !h.event_filter.includes(row.event_type)) continue // filtered out
        let ok = false
        try {
          const res = await send(h.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wikistead-signature': signBody(decryptSecret(h.secret_enc), ts, body), 'x-wikistead-timestamp': ts }, body })
          ok = res.status >= 200 && res.status < 300 // 3xx/4xx/5xx = failure (no redirect follow)
        } catch { ok = false }
        if (ok) {
          await tx`UPDATE webhooks SET failure_count = 0 WHERE id = ${h.id}`
        } else {
          allOk = false
          await tx`UPDATE webhooks SET failure_count = failure_count + 1, active = (failure_count + 1 < ${AUTO_DISABLE_FAILURES}) WHERE id = ${h.id}`
        }
      }
      if (allOk || row.attempts + 1 >= MAX_ATTEMPTS) {
        await tx`DELETE FROM webhook_outbox WHERE id = ${row.id}` // delivered (or exhausted → dropped)
      } else {
        const backoff = BACKOFF_BASE_S * Math.pow(2, row.attempts)
        await tx`UPDATE webhook_outbox SET attempts = attempts + 1, next_attempt_at = now() + (${backoff} || ' seconds')::interval WHERE id = ${row.id}`
      }
    }
    return rows.length
  }) as Promise<number>
}

// Poll-loop worker (mirrors startAuditDrainWorker). A per-instance in-flight guard prevents overlap; FOR
// UPDATE SKIP LOCKED handles across instances. Returns a stop for graceful shutdown.
export function startWebhookDrainWorker(fga: OpenFgaClient, intervalMs = 5000): () => void {
  let running = false
  let stopped = false
  const tick = async () => {
    if (running || stopped) return
    running = true
    try { while ((await drainWebhookOutbox(fga)) > 0 && !stopped) { /* keep draining */ } }
    catch (err) { console.error('[webhooks:drain]', err) }
    finally { running = false }
  }
  const timer = setInterval(() => void tick(), intervalMs)
  return () => { stopped = true; clearInterval(timer) }
}

// ── Fastify plugin (admin CRUD) ─────────────────────────────────────────────

export async function webhooksPlugin(app: FastifyInstance) {
  // All admin-gated: issuing/curating a webhook is a tenant-admin act (egress config).
  // NOT folded into the shared `requireTenantAdmin` (#383) on purpose: this gate returns 'forbidden',
  // not 'admin only' — the shared helper would change the error shape. Keep it local unless the API
  // contract is deliberately unified.
  const requireAdmin = async (req: { user: { sub: string }; tenant: { id: string } }) => {
    const { allowed } = await app.fga.check({ user: `user:${req.user.sub}`, relation: 'admin', object: `tenant:${req.tenant.id}` })
    if (!allowed) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  }

  app.post<{ Body: { url?: string; eventFilter?: string[] | null } }>('/webhooks', async (req, reply) => {
    await requireAdmin(req)
    if (!req.body?.url) return reply.code(400).send({ error: 'url required' })
    const created = await createWebhook(req.db, { tenantId: req.tenant.id, plan: req.tenant.plan, userId: req.user.sub, url: req.body.url, eventFilter: req.body.eventFilter ?? null })
    return reply.code(201).send(created) // { id, secret } — secret shown ONCE
  })

  app.get('/webhooks', async (req, reply) => {
    await requireAdmin(req)
    return reply.send(await listWebhooks(req.db)) // no secret in the list
  })

  app.delete<{ Params: { id: string } }>('/webhooks/:id', async (req, reply) => {
    await requireAdmin(req)
    const ok = await deleteWebhook(req.db, req.params.id)
    if (!ok) return reply.code(404).send({ error: 'not found' })
    return reply.code(204).send()
  })
}
