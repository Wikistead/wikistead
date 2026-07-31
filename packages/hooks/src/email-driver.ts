// CE-published extension point for transactional email. EE/Cloud may register a
// provider-API driver (Resend/Postmark, bounce handling); CE uses the default
// SMTP driver, or a no-op when SMTP is unconfigured. Defined here (not in
// apps/server) so EE can implement it without importing CE's application layer.
//
// Email is NOT an authorization path: it is best-effort. Membership/permissions
// are granted by FGA (the trusted path); an invite's authoritative artifact is its
// link/token, with email a convenience. A failed/disabled send never breaks
// authorization integrity (contrast: search reindex, which MUST be reliable).
export interface EmailMessage {
  to: string
  subject: string
  html: string
  text: string
  // #547 S3: optional transport headers (List-Unsubscribe / List-Unsubscribe-Post, RFC 8058). A driver
  // that cannot set headers may ignore them — they are a deliverability courtesy, never authorization.
  headers?: Record<string, string>
}

export interface EmailDriver {
  send(msg: EmailMessage): Promise<void>
}

let _driver: EmailDriver | null = null

export function registerEmailDriver(driver: EmailDriver): void {
  _driver = driver
}

export function getEmailDriver(fallback: EmailDriver): EmailDriver {
  return _driver ?? fallback
}

// #547 / ADR-196 §7: the TENANT-AWARE form of the seam. registerEmailDriver is a boot-time global —
// an EE registration through it would capture every tenant on the instance, so "the plan picks the
// transport" needs a per-tenant answer. A resolver sees {tenantId, plan} and returns a driver for
// THAT tenant, or null to decline; resolution order is resolver → registered global → the caller's
// fallback (CE SMTP/no-op). Every send site — the request path (invites) and the outbox drain alike —
// must resolve through resolveTenantEmailDriver, or a managed-sender tenant silently falls back to
// the CE default on that path.
export interface EmailDriverContext {
  tenantId: string
  plan: string
}

export type EmailDriverResolver = (ctx: EmailDriverContext) => EmailDriver | null

let _resolver: EmailDriverResolver | null = null

export function registerEmailDriverResolver(resolver: EmailDriverResolver): void {
  _resolver = resolver
}

export function resolveTenantEmailDriver(ctx: EmailDriverContext, fallback: EmailDriver): EmailDriver {
  return _resolver?.(ctx) ?? _driver ?? fallback
}
