# Runbook: a tenant is locked out of its own IdP (break-glass)

Recovery for #105 / ADR-060. Use this when a tenant configured its **own** OIDC IdP
(`tenant_oidc`, enabled) and that IdP later **broke** (issuer down, cert/secret expired,
client deleted at the IdP). Symptom: **every** member of that one tenant fails to log in,
and the fix (the admin OIDC settings page) itself needs a login → no in-app recovery.

This is an **operator** action, not a tenant self-service path. There is deliberately no
HTTP recovery endpoint (that would be an unauthenticated backdoor). It needs operator DB
credentials (`DATABASE_ADMIN_URL`, the admin role — bypasses RLS, no tenant session).

## What it does / does not do
- **Does**: sets `tenant_oidc.enabled = false` for the named tenant. Login then falls back
  to the platform IdP (Cloud) or "no OIDC" (CE), so members can get back in.
- **Does NOT**: clear the config (issuer/client/secret are **preserved** — the admin
  re-enables after fixing the IdP), mint any session, or grant/seat anyone. OpenFGA stays
  the authz truth; this only removes the broken login gate.

## Procedure
```sh
# Run where DATABASE_ADMIN_URL points at the tenant's database (admin role).
pnpm --filter @wikistead/server tenant:oidc-disable <tenantSlug> --by=<operator-name>
```
- `--by` records who performed the recovery in the audit event / log; defaults to the OS
  user if omitted.
- **Idempotent**: re-running when already disabled (or when the tenant has no OIDC config)
  is a safe no-op and emits no further audit event.

## PASS / evidence
- Output: `disabled tenant OIDC for "<slug>" — platform/none login restored.`
- Audit line in the operator's logs: `[break-glass] tenant.oidc_recovered tenant=<id>
  slug=<slug> operator=<who> at=<iso8601>` (a `tenant.oidc_recovered` domain event also
  fires for any EE audit subscriber).
- Verify a member of that tenant can now log in via the fallback path.

## After recovery
The tenant admin, now able to log in, fixes the IdP and re-enables OIDC from
**/admin/oidc** (enabling re-runs the discovery `validateIssuer` check, so a still-broken
issuer is rejected before it can lock anyone out again).
