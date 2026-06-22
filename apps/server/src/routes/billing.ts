import type { FastifyInstance } from 'fastify'
import Stripe from 'stripe'
import { pool } from '../db/pool.js'
import { resolveEntitlements } from '@wikistead/entitlements'
import { emit } from '@wikistead/events'

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
  const applied = await pool.begin(async (tx) => {
    const ins = await tx`
      INSERT INTO plan_events (tenant_id, event_type, stripe_event_id, old_plan, new_plan)
      VALUES (${tenant.id}, ${event.type}, ${event.id}, ${tenant.plan}, ${newPlan})
      ON CONFLICT (stripe_event_id) DO NOTHING
    `
    if (ins.count === 0) return false
    await tx`UPDATE tenants SET plan = ${newPlan} WHERE id = ${tenant.id}`
    return true
  })
  if (applied) emit({ type: 'tenant.plan_changed', tenantId: tenant.id, oldPlan: tenant.plan, newPlan })
}

// ── Fastify plugin ────────────────────────────────────────────────────────

export async function billingPlugin(app: FastifyInstance) {
  // Stripe webhook requires the raw request body for signature verification.
  // Register a string content type parser scoped to this plugin so the body
  // is preserved before JSON parsing — this does not affect other routes.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => done(null, body as string),
  )

  // POST /webhooks/stripe
  // Security boundary: signature verification must NOT be skipped or stubbed.
  // A missing or invalid signature means the event could be forged (e.g. fake
  // plan upgrades). If STRIPE_WEBHOOK_SECRET is unset, return 503 rather than
  // accepting unsigned events.
  app.post<{ Body: string }>('/webhooks/stripe', async (req, reply) => {
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

  // GET /entitlements
  // Returns the resolved entitlement flags for the current tenant's plan.
  // Useful for the frontend to show/hide upgrade prompts without hardcoding
  // plan logic in the client.
  app.get('/entitlements', async (req) => {
    return resolveEntitlements(req.tenant.plan)
  })

  // Stubs for outgoing Stripe calls (implemented in guest/billing UI phase).
  // POST /billing/checkout  → create Stripe Checkout session        [phase: billing-ui]
  // POST /billing/portal    → create Stripe Customer Portal session [phase: billing-ui]
}
