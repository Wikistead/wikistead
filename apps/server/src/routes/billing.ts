import type { FastifyInstance } from 'fastify'
import { requireTenantAdmin } from '@wikistead/authz' // #383
import type { OpenFgaClient } from '@openfga/sdk'
import Stripe from 'stripe'
import { pool } from '../db/pool.js'
import { withTenantTx } from '../db/with-tenant.js'
import { isManagedDeployment, resolveEntitlements } from '@wikistead/entitlements'
import { currentPeriodStart, getUsage } from '../usage.js' // #231 slice 1: read the counters back
import { emit } from '@wikistead/events'
import { isDowngrade } from '../plan.js'
import { isKnownLang } from '../locale.js'

// `||` not `??`: an explicitly-empty STRIPE_SECRET_KEY (CE/dev/test .env) must
// fall back to the placeholder — `new Stripe('')` throws at module load and would
// crash boot for every deployment that doesn't use Stripe.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder', {
  apiVersion: '2026-05-27.dahlia',
})

// ── Webhook event processing ──────────────────────────────────────────────

// price ID → internal plan name, from env (one price per self-serve/invoiced tier).
// Read per call so tests/config can set it without a module reload. Enterprise is
// contact-sales (invoiced); its price still maps here so a manual subscription
// resolves to the right plan.
function priceToPlan(): Record<string, string> {
  const m: Record<string, string> = {}
  if (process.env.STRIPE_PRICE_PRO) m[process.env.STRIPE_PRICE_PRO] = 'pro'
  // Cloud top tier is "team" (ADR-015; "enterprise" = the self-host edition).
  if (process.env.STRIPE_PRICE_TEAM) m[process.env.STRIPE_PRICE_TEAM] = 'team'
  return m
}

// Maps Stripe subscription status + price ID → internal plan name.
function determinePlan(subscription: Stripe.Subscription): string {
  if (subscription.status === 'canceled') return 'free'
  const priceId = subscription.items.data[0]?.price?.id ?? ''
  return priceToPlan()[priceId] ?? 'free'
}

// Link a tenant to its Stripe customer/subscription when Checkout completes. This
// is a backup to the checkout endpoint (which links the customer up-front to avoid
// the subscription.created-before-link race); the UPDATE is idempotent.
async function linkCheckout(session: Stripe.Checkout.Session): Promise<void> {
  const tenantId = session.client_reference_id
  if (!tenantId) return
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null
  if (!customerId) return
  const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id ?? null
  await pool`UPDATE tenants SET stripe_customer_id = ${customerId}, stripe_subscription_id = ${subId} WHERE id = ${tenantId}`
}

// Process a verified Stripe event. Billing-critical, so:
//   - idempotent: plan_events.stripe_event_id UNIQUE; a duplicate is a no-op.
//   - ATOMIC: the idempotency marker (plan_events) and the plan change (tenants)
//     commit in ONE transaction — never "marked processed but plan not updated".
//   - the caller returns 2xx only after this resolves, so Stripe's retries are
//     safe (a failed event is retried; a succeeded one is deduped).
// Uses pool directly (not TenantDb): we resolve the tenant from stripe_customer_id
// before we know which tenant this is, and tenants has no RLS.
export async function processWebhookEvent(event: Stripe.Event): Promise<void> {
  if (event.type === 'checkout.session.completed') {
    await linkCheckout(event.data.object as Stripe.Checkout.Session)
    return
  }
  const HANDLED = new Set([
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
  ])
  if (!HANDLED.has(event.type)) return

  const subscription = event.data.object as Stripe.Subscription
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer.id

  const [tenant] = await pool<{ id: string; plan: string }[]>`
    SELECT id, plan FROM tenants WHERE stripe_customer_id = ${customerId}
  `
  if (!tenant) return  // Stripe customer not linked to any tenant; ignore

  const newPlan = determinePlan(subscription)

  // Idempotency + atomicity in one tx: insert the marker AND apply the plan change
  // together. ON CONFLICT DO NOTHING → a duplicate inserts 0 rows → skip the update.
  const downgrade = isDowngrade(tenant.plan, newPlan)
  const applied = await pool.begin(async (tx) => {
    const ins = await tx`
      INSERT INTO plan_events (tenant_id, event_type, stripe_event_id, old_plan, new_plan)
      VALUES (${tenant.id}, ${event.type}, ${event.id}, ${tenant.plan}, ${newPlan})
      ON CONFLICT (stripe_event_id) DO NOTHING
    `
    if (ins.count === 0) return false
    if (downgrade) {
      // Grace (#131 / ADR-064): keep the OLD plan effective; record the pending target. The
      // reconciling batch commits it once grace elapses. Don't cut entitlements instantly.
      await tx`UPDATE tenants SET pending_plan = ${newPlan}, pending_plan_at = now() WHERE id = ${tenant.id}`
    } else {
      // Upgrade (or same/higher): apply immediately AND cancel any pending downgrade — more
      // entitlement is always safe, and a re-upgrade during grace voids the pending downgrade.
      await tx`UPDATE tenants SET plan = ${newPlan}, pending_plan = NULL, pending_plan_at = NULL WHERE id = ${tenant.id}`
      // Reactivate members frozen by a prior downgrade (ADR-064: re-upgrade restores access; the cap
      // is re-enforced only if a future downgrade commits while over the new cap). #478: ONLY those —
      // filtering on the reason. A reason='scim' row is a member the IdP deprovisioned, which billing
      // has no business reviving: un-freezing it re-opens auto-enrolment for someone who is no longer
      // a member, and leaves SCIM thinking they are active while their FGA grants stay deleted
      // (reactivateScimUser returns early on an already-cleared deactivated_at).
      // #478: `members` is FORCE-RLS'd on app.tenant_id and this webhook runs on the BARE pool, so the
      // un-freeze silently matched ZERO rows — ADR-064's promise that a re-upgrade restores access has
      // never actually fired (same shape as #428's last_used_at). Set the tenant context for the
      // statement; the explicit tenant_id predicate stays as belt-and-braces.
      await tx`SELECT set_config('app.tenant_id', ${tenant.id}, true)`
      await tx`UPDATE members SET deactivated_at = NULL, deactivation_reason = NULL
               WHERE tenant_id = ${tenant.id} AND deactivation_reason = 'downgrade_freeze'`
    }
    return true
  })
  // A deferred downgrade has not changed the effective plan yet — emit only on an applied change.
  if (applied && !downgrade) emit({ type: 'tenant.plan_changed', tenantId: tenant.id, oldPlan: tenant.plan, newPlan })
}

// ── Fastify plugin ────────────────────────────────────────────────────────

// ── Outgoing Stripe calls (checkout / portal) — Phase 5g-2 ──────────────────
// Services take the Stripe client (injected) so tests can drive a fake without a
// real key. tenant#admin gated. Only self-serve plans (Pro) are checkout-able;
// Team is contact-sales (no self-serve price).
const SELF_SERVE_PRICE: Record<string, string | undefined> = { get pro() { return process.env.STRIPE_PRICE_PRO } }

export async function createCheckoutSession(
  stripe: Stripe,
  fga: OpenFgaClient,
  args: { tenantId: string; userId: string; plan: string; baseUrl: string },
): Promise<{ url: string }> {
  await requireTenantAdmin(fga, args.userId, args.tenantId)
  const priceId = SELF_SERVE_PRICE[args.plan]
  if (!priceId) throw Object.assign(new Error('unknown or non-self-serve plan'), { statusCode: 400 })

  // Ensure the tenant has a Stripe customer, linking it UP FRONT (before any
  // subscription webhook can arrive) so the webhook always resolves the tenant.
  const [t] = await pool<{ stripe_customer_id: string | null; slug: string }[]>`
    SELECT stripe_customer_id, slug FROM tenants WHERE id = ${args.tenantId}
  `
  if (!t) throw Object.assign(new Error('tenant not found'), { statusCode: 404 })
  let customerId = t.stripe_customer_id
  if (!customerId) {
    // #1096: Stripe's own receipt/dunning emails otherwise default to English. The workspace
    // default only — NEVER the requesting admin's own session locale: this customer is billed to
    // the whole tenant, which multiple people (in different languages) may read (ADR-260 §3.1
    // covers the per-member case; this is deliberately the tenant-only half of that resolution).
    // tenant_settings is RLS-scoped (FORCE ROW LEVEL SECURITY) — `withTenantTx`, not a bare `pool`
    // query, which would see zero rows (no `app.tenant_id` in this connection's session) and never
    // actually surface the workspace default. A brand-new tenant has no tenant_settings row yet
    // (#1126), which this correctly reads as "no default" rather than failing the checkout over it.
    const [settings] = await withTenantTx(args.tenantId, (sql) =>
      sql<{ default_lang: string | null }[]>`SELECT default_lang FROM tenant_settings LIMIT 1`)
    const lang = isKnownLang(settings?.default_lang) ? settings.default_lang : 'en'
    const customer = await stripe.customers.create({
      name: t.slug, metadata: { tenantId: args.tenantId }, preferred_locales: [lang],
    })
    customerId = customer.id
    await pool`UPDATE tenants SET stripe_customer_id = ${customerId} WHERE id = ${args.tenantId}`
  }
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${args.baseUrl}/admin/billing?status=success`,
    cancel_url: `${args.baseUrl}/admin/billing?status=cancel`,
    client_reference_id: args.tenantId,
  })
  if (!session.url) throw Object.assign(new Error('checkout session has no url'), { statusCode: 502 })
  return { url: session.url }
}

export async function createPortalSession(
  stripe: Stripe,
  fga: OpenFgaClient,
  args: { tenantId: string; userId: string; baseUrl: string },
): Promise<{ url: string }> {
  await requireTenantAdmin(fga, args.userId, args.tenantId)
  const [t] = await pool<{ stripe_customer_id: string | null }[]>`
    SELECT stripe_customer_id FROM tenants WHERE id = ${args.tenantId}
  `
  if (!t?.stripe_customer_id) throw Object.assign(new Error('no billing customer yet'), { statusCode: 409 })
  const session = await stripe.billingPortal.sessions.create({
    customer: t.stripe_customer_id,
    return_url: `${args.baseUrl}/admin/billing`,
  })
  return { url: session.url }
}

export async function billingPlugin(app: FastifyInstance) {
  // #1186: the webhook's raw-body parser MUST be scoped to its own nested `app.register()` —
  // registering it directly on `app` (this function's own top level) put it in the SAME
  // encapsulation as `/billing/checkout` and `/billing/portal` below, so they silently inherited a
  // raw STRING body instead of a parsed object. `req.body?.plan` was therefore always `undefined`,
  // and checkout always 400'd with "unknown or non-self-serve plan" regardless of what was posted —
  // caught by a route-level test (`billing.test.ts`), since every prior test called
  // `createCheckoutSession` directly and never exercised the route's own body parsing.
  await app.register(async (webhookApp) => {
    // Stripe webhook requires the raw request body for signature verification. Scoped to THIS
    // nested plugin only — `/billing/checkout` and `/billing/portal` stay on the default JSON parser.
    webhookApp.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (_req, body, done) => done(null, body as string),
    )

    // POST /webhooks/stripe
    // Security boundary: signature verification must NOT be skipped or stubbed.
    // A missing or invalid signature means the event could be forged (e.g. fake
    // plan upgrades). If STRIPE_WEBHOOK_SECRET is unset, return 503 rather than
    // accepting unsigned events.
    webhookApp.post<{ Body: string }>('/webhooks/stripe', async (req, reply) => {
      const secret = process.env.STRIPE_WEBHOOK_SECRET
      if (!secret) return reply.code(503).send({ error: 'webhook not configured' })

      const sig = req.headers['stripe-signature'] as string
      let event: Stripe.Event
      try {
        event = stripe.webhooks.constructEvent(req.body, sig, secret)
      } catch {
        return reply.code(400).send({ error: 'webhook signature invalid' })
      }

      await processWebhookEvent(event)
      return reply.code(200).send({ received: true })
    })
  })

  // GET /entitlements
  // Returns the resolved entitlement flags for the current tenant's plan.
  // Useful for the frontend to show/hide upgrade prompts without hardcoding
  // plan logic in the client.
  // #864: `selfHosted` rides along and is NOT a lever — on a self-hosted install every lever is
  // UNLIMITED and so is a top-plan Cloud tenant, so no entitlement value distinguishes them. It comes
  // from the registration the edition performs at composition time, and the screens that read it use
  // it to offer OPERATOR help (a setup guide belongs in front of whoever runs the server).
  app.get('/entitlements', async (req) => {
    return { ...resolveEntitlements(req.tenant.plan), selfHosted: !isManagedDeployment() }
  })

  // GET /billing/usage — #231 slice 1: SHOW what has been metered this period, next to the allowance the
  // plan already carries. Deliberately read-only and number-free: no price, no cap constant, no soft-cap
  // enforcement — those are #127's rulings, and writing them before the ruling would mean rebuilding them.
  // What was missing was simply a way to SEE the counters (`recordUsage` has been landing rows for a while
  // with nothing reading them back). `Infinity` allowances become `null` on the wire — "unlimited" — since
  // JSON has no Infinity and a serialiser would otherwise turn it into the lie that is `null` meaning zero.
  app.get('/billing/usage', async (req, reply) => {
    // tenant#admin: usage is billing information, and the tenant boundary is the RLS-scoped `req.db`.
    try {
      await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    } catch {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const period = currentPeriodStart()
    const ent = resolveEntitlements(req.tenant.plan)
    const allowance = (v: number) => (Number.isFinite(v) ? v : null) // null = unlimited
    return {
      periodStart: period,
      plan: req.tenant.plan,
      resources: [
        { resource: 'ai.tokens', used: await getUsage(req.db, 'ai.tokens', period), allowance: allowance(ent.aiTokenAllowance) },
      ],
    }
  })

  // GET /billing/status — current plan + whether self-serve billing is active.
  // billingEnabled is false on self-host/CE (no Stripe key) → the UI shows the
  // "self-hosted, all features included" state instead of upgrade/manage controls.
  app.get('/billing/status', async (req) => ({
    plan: req.tenant.plan,
    billingEnabled: !!process.env.STRIPE_SECRET_KEY,
  }))

  const baseUrl = (req: { protocol: string; headers: Record<string, unknown> }) => `${req.protocol}://${req.headers.host}`

  // POST /billing/checkout — start a self-serve subscription (tenant#admin).
  app.post<{ Body: { plan: string } }>('/billing/checkout', async (req, reply) => {
    const result = await createCheckoutSession(stripe, app.fga, {
      tenantId: req.tenant.id, userId: req.user.sub, plan: req.body?.plan ?? '', baseUrl: baseUrl(req),
    })
    return reply.send(result)
  })

  // POST /billing/portal — manage/cancel via the Stripe Customer Portal (tenant#admin).
  app.post('/billing/portal', async (req, reply) => {
    const result = await createPortalSession(stripe, app.fga, {
      tenantId: req.tenant.id, userId: req.user.sub, baseUrl: baseUrl(req),
    })
    return reply.send(result)
  })
}
