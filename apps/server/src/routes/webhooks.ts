import { runInAuthzScope, SYSTEM_SCOPE } from '@wikistead/authz'
import { createHmac, randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Sql } from 'postgres'
import type { OpenFgaClient } from '@openfga/sdk'
import { resolveEntitlements } from '@wikistead/entitlements'
import { pool } from '../db/pool.js'
import { claimOutboxBatch } from '../db/outbox-lease.js' // #432
import type { TenantDb } from '../db/index.js'
import { withTenantTx } from '../db/index.js' // #382
import { encryptSecret, decryptSecret } from '../auth/secret-crypto.js'
import { guardedFetch } from '../safe-fetch.js'
import { pageEventDisposition } from '../page-disposition.js'
import { egressVerdict } from '../webhooks/egress.js' // #862: what each type may carry out of the tenant
import { currentActorKeyId } from '@wikistead/events'
import type { DomainEvent } from '@wikistead/events'

// #228 / ADR-108: outbound webhooks. A subscription is admin-managed (RLS) and gated by the `webhooks`
// entitlement at CREATION. Events are enqueued IN the operation's tx (enqueueWebhookOutbox — like the audit
// outbox, NOT the fire-and-forget emit bus), so a commit-then-crash still delivers. A cross-tenant worker
// drains the outbox, signs each delivery with HMAC, and uses the PINNED SSRF-safe client (guardedFetch:
// re-resolve+re-screen per delivery, no redirect follow — a 3xx is a FAILURE). N consecutive failures
// auto-disable a hook. Payload is THIN (ids/type/actor/timestamp — never title/content), and events about a
// PRIVATE or UNPUBLISHED-DRAFT page are never delivered (instance-level existence-hiding, comment 1000).

const MAX_ATTEMPTS = 6            // drop + auto-disable after this many failed deliveries of a row
const AUTO_DISABLE_FAILURES = 10  // consecutive per-hook failures → active=false
const BACKOFF_BASE_S = 30         // exponential backoff base (30s, 60s, 120s, …)

export interface WebhookRow { id: string; url: string; event_filter: string[] | null; active: boolean; failure_count: number; created_at: Date }
export interface WebhookOutboxRow { id: string; tenant_id: string; event_type: string; payload: Record<string, unknown>; attempts: number; settled_disposition: 'deliver' | 'suppress' | null }

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
  // a create-time opt-in (#228 review point 1).
  if (u.protocol !== 'https:') throw Object.assign(new Error('url must be https'), { statusCode: 400 })
  const secret = randomBytes(24).toString('base64url')
  const filter = args.eventFilter && args.eventFilter.length ? args.eventFilter : null
  const [row] = await db.sql<{ id: string }[]>`
    INSERT INTO webhooks (tenant_id, url, secret_enc, event_filter, created_by)
    VALUES (${args.tenantId}, ${args.url}, ${encryptSecret(secret)}, ${filter as unknown as string[] | null}, ${`user:${args.userId}`})
    RETURNING id`
  return { id: row!.id, secret } // secret returned ONCE (write-once)
}

// #623 (ruling): one row per subscription, and nothing capped it. A cursor rather than an offset
// (rows are added while somebody reads), with `id` as the tiebreaker — `created_at` is not unique when
// several subscriptions are created by one script.
export const WEBHOOKS_PAGE_LIMIT = 50

export interface WebhookPage { webhooks: WebhookRow[]; nextCursor: string | null }

export async function listWebhooks(
  db: TenantDb, opts: { limit?: number; cursor?: string } = {},
): Promise<WebhookPage> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? WEBHOOKS_PAGE_LIMIT))
  const at = opts.cursor?.indexOf('|') ?? -1
  const after = opts.cursor && at > 0 ? { at: opts.cursor.slice(0, at), id: opts.cursor.slice(at + 1) } : null
  // #623: the cursor travels as an epoch NUMERIC, never as an ISO string. `created_at` is a
  // timestamptz(6) and `toISOString()` stops at milliseconds, so a cursor built from one names an
  // earlier instant than the row it came from. On this DESC walk that does not duplicate — it SKIPS:
  // every row between the truncated instant and the true one is on the wrong side of `<` and appears
  // on no page at all. A webhook that silently vanishes from its own list is worse than one listed
  // twice. Same spelling as `/spaces` and `/members`; two spellings is how one of them stays wrong.
  const rows = await db.sql<(WebhookRow & { cursor_at: string })[]>`
    SELECT id, url, event_filter, active, failure_count, created_at,
           extract(epoch from created_at)::text AS cursor_at
      FROM webhooks
    WHERE TRUE ${after ? db.sql`AND (created_at, id) < (to_timestamp(${after.at}::numeric), ${after.id})` : db.sql``}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit + 1}`
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]
  return {
    webhooks: page.map(({ cursor_at: _drop, ...w }) => w),
    nextCursor: hasMore && last ? `${last.cursor_at}|${last.id}` : null,
  }
}

export async function deleteWebhook(db: TenantDb, id: string): Promise<boolean> {
  const res = await db.sql`DELETE FROM webhooks WHERE id = ${id}`
  return res.count > 0
}

// ── in-tx enqueue (reliability core) ────────────────────────────────────────

// Enqueue a webhook event IN the operation's tx (mirrors enqueueAudit). Thin payload only. The private/
// draft existence-hiding filter is applied at DRAIN (it needs the current FGA state, and the row is cheap).
//
// ⚠️ #862 / ADR-108 addendum §H: the egress verdict is applied HERE, at the write, and this is the only
// place it is applied. There are three roads to a durable row — the bridge, and the two call sites that
// enqueue inside their own transaction — and the two transactional ones are precisely the pair that
// egressed for a year without anybody reviewing what they carried. A check on the bridge would have
// missed them again. It also has to happen before the INSERT rather than at the drain: the outbox is
// durable, so a row holding a field nobody may receive is the same disclosure one step later, waiting
// for whoever reads the table next.
//
// Returns the row id, or `null` when the verdict is `drop` and no row was written.
export async function enqueueWebhookOutbox(
  sql: Sql,
  args: { tenantId: string; eventType: DomainEvent['type']; payload: Record<string, unknown>; settled?: 'deliver' | 'suppress' },
): Promise<string | null> {
  // `eventType` is the union rather than `string` on purpose: an unruled type is then a compile error
  // at the call site, not a row that quietly ships whatever it was handed.
  const verdict = egressVerdict(args.eventType)
  if (verdict.kind === 'drop') return null
  // ⚠️ Two fields no caller should have to remember, stamped here for the same reason the verdict is
  // applied here: three roads reach this row and only one of them comes through the bus. `occurredAt`
  // was missing from the two in-transaction payloads and the CLI one, and `actorKeyId` from
  // `page.published` — so an API-key publish delivered no key while the same event through the bridge
  // did (finding 4). Their rows named both, which made the reference say what the wire did not.
  const stamped: Record<string, unknown> = { ...args.payload }
  if (!('occurredAt' in stamped)) stamped.occurredAt = new Date().toISOString()
  if ('actorId' in stamped && !('actorKeyId' in stamped)) {
    const keyId = currentActorKeyId()
    if (keyId) stamped.actorKeyId = keyId
  }
  // The row names what may leave; anything else the event grows is dropped rather than forwarded.
  // `in` rather than a default: an optional field that is absent stays absent, it does not become null.
  const payload: Record<string, unknown> = {}
  for (const field of verdict.fields) if (field in stamped) payload[field] = stamped[field]
  // ADR-108 addendum §G: a `settled` disposition is one taken before the act destroyed what answers
  // it. `suppress` still writes a row rather than skipping the INSERT, so a suppressed event and a
  // never-enqueued one stay distinguishable while the row is alive — the drain deletes it on sight.
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO webhook_outbox (tenant_id, event_type, payload, settled_disposition)
    VALUES (${args.tenantId}, ${args.eventType}, ${payload as unknown as string}, ${args.settled ?? null})
    RETURNING id`
  return row!.id
}

// ── delivery worker ─────────────────────────────────────────────────────────

// #228 comment 1000: the tri-state page disposition moved to ../page-disposition.ts (#547 shares it
// with the email drain — ONE definition of what may leave the fortress). Semantics unchanged.

const signBody = (secret: string, ts: string, body: string) => `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`

// Drain a batch of due outbox rows and deliver each to every matching, active hook of its tenant.
//
// #385: the LEASE pattern, identical to the audit/search outboxes (the repo's established reliability
// shape): a SHORT claim UPDATE (`claimed_at = now()`, FOR UPDATE SKIP LOCKED — disjoint across workers,
// stale claims re-claimed after 2 minutes) — then ALL external HTTP happens OUTSIDE any transaction (the
// old shape held a pooled connection + row locks across every 10s-timeout delivery round-trip), and
// bookkeeping (hook failure counts, outbox delete/reschedule) commits in a second short tx per row.
// A failure reschedules with exponential backoff (releasing the claim, so the backoff — not the stale
// window — decides the retry time) and bumps the hook's failure_count (auto-disable at N); a 2xx clears
// it. A 3xx/4xx/5xx (guardedFetch never follows redirects) is a FAILURE. A crash mid-row leaves the
// claim to age out and the row retries (reliable, never best-effort). Returns rows handled.
export async function drainWebhookOutbox(fga: OpenFgaClient, opts: { batch?: number } = {}): Promise<number> {
  const send = guardedFetch({ maxBytes: 8 * 1024, timeoutMs: 10_000 })
  // Phase 1 — CLAIM (short statement, no long tx). #432: the claim/stale-window live in the shared
  // lease primitive; this site only adds its backoff gate (next_attempt_at decides due-ness/order).
  const rows = await claimOutboxBatch<WebhookOutboxRow>({
    table: 'webhook_outbox',
    returning: ['id', 'tenant_id', 'event_type', 'payload', 'attempts', 'settled_disposition'],
    batch: opts.batch ?? 20,
    orderBy: 'next_attempt_at',
    extraDue: pool`AND next_attempt_at <= now()`,
  })
  // Reschedule with backoff (or drop once exhausted), RELEASING the claim so next_attempt_at — not the
  // 2-minute stale window — controls when the row runs again.
  const retryOrDrop = async (row: WebhookOutboxRow) => {
    if (row.attempts + 1 >= MAX_ATTEMPTS) { await pool`DELETE FROM webhook_outbox WHERE id = ${row.id}`; return }
    const backoff = BACKOFF_BASE_S * Math.pow(2, row.attempts)
    await pool`UPDATE webhook_outbox SET attempts = attempts + 1, claimed_at = NULL, next_attempt_at = now() + (${backoff} || ' seconds')::interval WHERE id = ${row.id}`
  }
  let handled = 0
  for (const row of rows) {
    try {
      // Instance-level existence-hiding (tri-state). A private page → drop now (never deliver). A page whose
      // page#space link hasn't landed yet (publish writes it just after the tx) → RETRY, don't permanently
      // drop a legitimate page.published (#228 review point 2); dropped only once attempts are exhausted, and it
      // never delivers while unlinked so a genuine draft stays hidden.
      // ⚠️ #862 / ADR-108 addendum §G: three types are about an act that destroys what this question
      // reads — the purge deletes the page's tuples, privatising writes the marker that hides it. For
      // those the answer was taken at the act and settled on the row; re-asking here would find the
      // aftermath and refuse, which is why none of the three had ever been delivered. Every other row
      // is asked exactly as before, at delivery, because for those the later answer is the safer one.
      const disp = row.settled_disposition ?? (await pageEventDisposition(fga, row.payload))
      if (disp === 'suppress') { await pool`DELETE FROM webhook_outbox WHERE id = ${row.id}`; handled++; continue }
      if (disp === 'not-ready') { await retryOrDrop(row); handled++; continue }
      // Tenant-scoped hook read — a SHORT tx (set_config is tx-local; RLS scopes the SELECT), closed
      // before any delivery starts.
      const hooks = await withTenantTx(row.tenant_id, async (tx) => {
        return tx<{ id: string; url: string; secret_enc: string; event_filter: string[] | null }[]>`
          SELECT id, url, secret_enc, event_filter FROM webhooks WHERE active = TRUE`
      })
      const body = JSON.stringify({ id: row.id, type: row.event_type, ...row.payload })
      const ts = String(Math.floor(Date.now() / 1000))
      // Phase 2 — DELIVER, outside any transaction (the whole point of the lease).
      const results: { id: string; ok: boolean }[] = []
      for (const h of hooks) {
        if (h.event_filter && !h.event_filter.includes(row.event_type)) continue // filtered out
        let ok = false
        try {
          const res = await send(h.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wikistead-signature': signBody(decryptSecret(h.secret_enc), ts, body), 'x-wikistead-timestamp': ts }, body })
          ok = res.status >= 200 && res.status < 300 // 3xx/4xx/5xx = failure (no redirect follow)
        } catch { ok = false }
        results.push({ id: h.id, ok })
      }
      const allOk = results.every((r) => r.ok)
      // Phase 3 — BOOKKEEPING (ONE short tx): failure counters AND the outbox row's fate commit
      // atomically (webhook_outbox has no RLS, so it can share the scoped tx) — a crash can't leave a
      // bumped failure_count with an un-advanced row (which would double-count on the retry).
      await withTenantTx(row.tenant_id, async (tx) => {
        for (const r of results) {
          if (r.ok) await tx`UPDATE webhooks SET failure_count = 0 WHERE id = ${r.id}`
          else await tx`UPDATE webhooks SET failure_count = failure_count + 1, active = (failure_count + 1 < ${AUTO_DISABLE_FAILURES}) WHERE id = ${r.id}`
        }
        if (allOk || row.attempts + 1 >= MAX_ATTEMPTS) {
          await tx`DELETE FROM webhook_outbox WHERE id = ${row.id}` // delivered (or exhausted → dropped)
        } else {
          const backoff = BACKOFF_BASE_S * Math.pow(2, row.attempts)
          await tx`UPDATE webhook_outbox SET attempts = attempts + 1, claimed_at = NULL, next_attempt_at = now() + (${backoff} || ' seconds')::interval WHERE id = ${row.id}`
        }
      })
      handled++
    } catch {
      // Crash mid-row: leave the row claimed — the claim ages past the stale window and it is retried
      // with its attempts count unchanged (a crash is not a delivery failure; same as the search drain).
    }
  }
  return handled
}

// Poll-loop worker (mirrors startAuditDrainWorker). A per-instance in-flight guard prevents overlap; FOR
// UPDATE SKIP LOCKED handles across instances. Returns a stop() for graceful shutdown.
export function startWebhookDrainWorker(fga: OpenFgaClient, intervalMs = 5000): () => void {
  let running = false
  let stopped = false
  const tick = async () => {
    if (running || stopped) return
    running = true
    // #637 / ADR-216 §2: not on behalf of a request, and it SAYS so. An explicit unrestricted scope,
    // rather than arriving with none — which in a process that declared the requirement is a crash, and
    // in one that has not is indistinguishable from a request path where somebody forgot.
    try { await runInAuthzScope(SYSTEM_SCOPE, async () => { while ((await drainWebhookOutbox(fga)) > 0 && !stopped) { /* keep draining */ } }) }
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

  app.get<{ Querystring: { limit?: string; cursor?: string } }>('/webhooks', async (req, reply) => {
    await requireAdmin(req)
    const raw = Number.parseInt(req.query?.limit ?? '', 10)
    // no secret in the list
    return reply.send(await listWebhooks(req.db, { limit: Number.isFinite(raw) ? raw : undefined, cursor: req.query?.cursor }))
  })

  app.delete<{ Params: { id: string } }>('/webhooks/:id', async (req, reply) => {
    await requireAdmin(req)
    const ok = await deleteWebhook(req.db, req.params.id)
    if (!ok) return reply.code(404).send({ error: 'not found' })
    return reply.code(204).send()
  })
}
