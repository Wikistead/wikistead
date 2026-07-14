// Inserts dev DB rows (spaces + pages) for local E2E use.
// FGA tuples are handled separately by infra/openfga/seed.ts.
// Run with: pnpm --filter @wikistead/server db:seed
import postgres from 'postgres'
import { encryptSecret } from '../../apps/server/src/auth/secret-crypto.js'

;(async () => {
  const sql = postgres(process.env.DATABASE_ADMIN_URL!)

  // Space and page IDs must match the FGA tuples in infra/openfga/seed.ts
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', 'tenant_dev', true)`
    await tx`
      INSERT INTO spaces (id, tenant_id, name)
      VALUES ('demo_space', 'tenant_dev', 'Demo Space')
      ON CONFLICT (tenant_id, id) DO NOTHING
    `
    await tx`
      INSERT INTO pages (id, tenant_id, space_id, title, noindex)
      VALUES ('demo', 'tenant_dev', 'demo_space', 'Demo Page', false)
      ON CONFLICT (tenant_id, id) DO NOTHING
    `
    // Seed the admin member row to match the FGA seed (dev-user is tenant#admin).
    // Keeps the members table consistent with FGA so the tenant is NOT member-less
    // (the first-admin bootstrap must not fire for an already-admined tenant).
    await tx`
      INSERT INTO members (tenant_id, sub, email, display_name, role)
      VALUES ('tenant_dev', 'dev-user', 'dev@example.com', 'Dev User', 'admin')
      ON CONFLICT (tenant_id, sub) DO NOTHING
    `
    console.log('seeded: tenant_dev / demo_space / demo (page) / admin member')

    // Dev OIDC config (placeholder issuer; real IdP is configured per deployment).
    // client_secret is stored ENCRYPTED via the same helper the app uses.
    const clientSecret = process.env.OIDC_CLIENT_SECRET
    await tx`
      INSERT INTO tenant_oidc (tenant_id, issuer, client_id, client_secret_enc, redirect_uri)
      VALUES ('tenant_dev', ${process.env.OIDC_ISSUER!}, ${process.env.OIDC_CLIENT_ID!},
              ${clientSecret ? encryptSecret(clientSecret) : null}, ${process.env.OIDC_REDIRECT_URI!})
      ON CONFLICT (tenant_id) DO UPDATE SET
        issuer = EXCLUDED.issuer, client_id = EXCLUDED.client_id,
        client_secret_enc = EXCLUDED.client_secret_enc, redirect_uri = EXCLUDED.redirect_uri, updated_at = now()
    `
    console.log('seeded: tenant_dev / tenant_oidc')

    // #390: env-linked, RESET-RESISTANT dev config — like tenant_oidc above, these survive a
    // `docker compose down -v` because the seed re-applies them from env on the next `db:seed`. Each is
    // applied ONLY when its env var is set, so a plain dev without them keeps the schema defaults (no custom
    // domain, enroll_policy = 'invite_only'). Idempotent (ON CONFLICT), so re-running never conflicts.
    const customDomain = process.env.DEV_CUSTOM_DOMAIN
    if (customDomain) {
      // Mirror a VERIFIED custom domain: host→tenant resolution reads tenants.custom_domain, and the
      // verification-registry row is what the domains UI shows. Real deployments only reach 'verified' via the
      // DNS-TXT challenge (#123 / ADR-065); the dev seed shortcuts it for local host-routing.
      await tx`UPDATE tenants SET custom_domain = ${customDomain} WHERE id = 'tenant_dev'`
      await tx`
        INSERT INTO custom_domains (tenant_id, domain, verification_token, status, verified_at)
        VALUES ('tenant_dev', ${customDomain}, 'dev-seed-token', 'verified', now())
        ON CONFLICT (tenant_id, domain) DO UPDATE SET status = 'verified', verified_at = now()
      `
      console.log(`seeded: tenant_dev / custom_domain = ${customDomain} (verified)`)
    }

    // OIDC auto-enrollment policy (open | domain | groups | invite_only) + the groups allow-list. Lets a dev
    // exercise auto-enroll locally without re-configuring it after every reset.
    const enrollPolicy = process.env.DEV_ENROLL_POLICY
    if (enrollPolicy) {
      const groups = (process.env.DEV_ENROLL_ALLOWED_GROUPS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      await tx`
        INSERT INTO tenant_settings (tenant_id, enroll_policy, enroll_allowed_groups)
        VALUES ('tenant_dev', ${enrollPolicy}, ${groups})
        ON CONFLICT (tenant_id) DO UPDATE SET
          enroll_policy = EXCLUDED.enroll_policy, enroll_allowed_groups = EXCLUDED.enroll_allowed_groups
      `
      console.log(`seeded: tenant_dev / enroll_policy = ${enrollPolicy} (groups: ${groups.join(',') || 'none'})`)
    }

    // A VERIFIED enrol-domain for the `domain` enroll_policy. In prod only the real DNS owner can verify
    // (verified_at is set ONLY by the DNS-TXT challenge, #101 / ADR-034); the dev seed shortcuts it.
    const enrollDomain = process.env.DEV_ENROLL_DOMAIN
    if (enrollDomain) {
      await tx`
        INSERT INTO enroll_domains (tenant_id, domain, verification_token, verified_at)
        VALUES ('tenant_dev', ${enrollDomain}, 'dev-seed-token', now())
        ON CONFLICT (tenant_id, domain) DO UPDATE SET verified_at = now()
      `
      console.log(`seeded: tenant_dev / enroll_domain = ${enrollDomain} (verified)`)
    }
  })

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', 'tenant_acme', true)`
    await tx`
      INSERT INTO spaces (id, tenant_id, name)
      VALUES ('acme_space', 'tenant_acme', 'Acme Space')
      ON CONFLICT (tenant_id, id) DO NOTHING
    `
    await tx`
      INSERT INTO pages (id, tenant_id, space_id, title, noindex)
      VALUES ('acme_page', 'tenant_acme', 'acme_space', 'Acme Page', false)
      ON CONFLICT (tenant_id, id) DO NOTHING
    `
    await tx`
      INSERT INTO members (tenant_id, sub, email, display_name, role)
      VALUES ('tenant_acme', 'acme-admin', 'admin@acme.test', 'Acme Admin', 'admin')
      ON CONFLICT (tenant_id, sub) DO NOTHING
    `
    console.log('seeded: tenant_acme / acme_space / acme_page / admin member')
  })

  await sql.end()
})().catch((err) => { console.error(err); process.exit(1) })
