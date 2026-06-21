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

// Maps Stripe subscription status + price ID → internal plan name.
// TODO(phase: billing): read price → plan mapping from DB or env config
// rather than hardcoding here.
function determinePlan(subscription: Stripe.Subscription): string {
  if (subscription.status === 'canceled') return 'free'
  const priceId = subscription.items.data[0]?.price?.id ?? ''
  const map: Record<string, string> = {
    [process.env.STRIPE_PRICE_PRO ?? '__unset__']: 'pro',
  }
  return map[priceId] ?? 'free'
}

// Process a verified Stripe event.
// Uses pool directly (not TenantDb) because we need to look up the tenant
// from stripe_customer_id before we know which tenant this is.
// tenants table has no RLS, so pool queries it without app.tenant_id.
export async function processWebhookEvent(event: Stripe.Event): Promise<void> {
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

  // Idempotency: ON CONFLICT DO NOTHING means duplicate events are silently
  // skipped. count === 0 → already processed, skip the plan update too.
  const result = await pool`
    INSERT INTO plan_events (tenant_id, event_type, stripe_event_id, old_plan, new_plan)
    VALUES (${tenant.id}, ${event.type}, ${event.id}, ${tenant.plan}, ${newPlan})
    ON CONFLICT (stripe_event_id) DO NOTHING
  `
  if (result.count === 0) return

  await pool`UPDATE tenants SET plan = ${newPlan} WHERE id = ${tenant.id}`
  emit({ type: 'tenant.plan_changed', tenantId: tenant.id, oldPlan: tenant.plan, newPlan })
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
