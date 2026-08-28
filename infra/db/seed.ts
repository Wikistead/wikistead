// Inserts dev DB rows (spaces + pages) for local E2E use.
// FGA tuples are handled separately by infra/openfga/seed.ts.
// Run with: pnpm --filter @wikistead/server db:seed
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { encryptSecret } from '../../apps/server/src/auth/secret-crypto.js'
// #590: the prefix derivation is the app's, imported rather than copied — a second copy of
// `wc<conn8>_` would drift from the one that mints real connections, and the drift would only show
// up as members appearing twice.
import { subjectPrefixFor } from '../../apps/server/src/routes/admin-connections.js'
// #621: refuse to seed another session's stack — see the guard for what went wrong without it.
import { assertStackTarget } from '../../scripts/assert-stack-target.mjs'

;(async () => {
  assertStackTarget(process.env.DATABASE_ADMIN_URL, 'db:seed')
  const sql = postgres(process.env.DATABASE_ADMIN_URL!)

  // Space and page IDs must match the FGA tuples in infra/openfga/seed.ts
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', 'tenant_dev', true)`
    // #482: sweep residue that a killed/interrupted test suite leaves on the SHARED server-test stack,
    // so the next run starts clean instead of inheriting another run's half-state. Every shape here is
    // a KNOWN leftover with a KNOWN owning suite (documented on #482): the residue is deleted, never a
    // real fixture (dev-user / demo page are re-seeded below, and only test-shaped rows are removed).
    //   - #852: throwaway members that suites mint (a member row is a SEAT, so they change the answer
    //     of every seat-cap assertion). This used to name four prefixes — `gate-`, `pf-out-`, `inv-`,
    //     `seat-` — and a fifth suite minting `dg-w1-<stamp>` was never added, so its rows survived
    //     every run until a seat assertion in an unrelated file went red. `prune-test-tenants.ts`
    //     collects them now BY DERIVATION (everything in a seeded tenant that the seed did not write),
    //     which needs no list and cannot miss the sixth.
    // #738: the fixture tenant's PLAN, when the stack asks for one.
    //
    // Nine specs invite a second member, and every Cloud plan below the top tier is one seat (#691's
    // ruling: Personal is a one-person plan). Once #720 made the resolver actually decide, those nine
    // started answering 402 seat_limit — two correct changes meeting in a fixture that was never
    // sized for them.
    //
    // The plan is SEEDED rather than flipped by the specs that need it. `db/registry.ts` caches a
    // tenant row for 30 seconds, so a spec that raises the plan in `beforeAll` may run against the
    // cached old value — and worse, a spec that lowers it back leaves the NEXT spec looking at the
    // raised one for up to 30 seconds. That failure depends only on execution ORDER, which is why
    // running a spec alone said it was fixed (#738, measured). Nothing mutates here, so the
    // cache has nothing to be stale about.
    //
    // Set per stack (`.env.e2e`), so the dev and server-test fixtures keep the plan they had.
    if (process.env.SEED_TENANT_PLAN) {
      await tx`UPDATE tenants SET plan = ${process.env.SEED_TENANT_PLAN} WHERE id = 'tenant_dev'`
      console.log(`seeded: tenant_dev / plan = ${process.env.SEED_TENANT_PLAN} (SEED_TENANT_PLAN)`)
    }
    //   - the tenant's abuse policy: a suite sets it and resets, but a kill mid-run leaves it armed,
    //     which turns every later publish in an unrelated test into a 422 (reset to permissive here)
    await tx`UPDATE tenant_settings SET abuse_banned_words = '{}', abuse_shrink_ratio = NULL,
             abuse_publish_rate_link_max = NULL, abuse_publish_rate_session_max = NULL WHERE tenant_id = 'tenant_dev'`
    //   - dev-user's editor persona (onboarding-289 restores it in afterEach; a kill leaves the last
    //     one, and a persona hiding the vim button then fails every vim spec on the next run)
    await tx`UPDATE members SET editor_chrome = NULL, editor_display_mode = NULL, editor_keymap = NULL
             WHERE tenant_id = 'tenant_dev' AND sub = 'dev-user'`
    //   - orphan test pages that outlive their suite and leak into title/dictionary/search assertions
    await tx`DELETE FROM pages WHERE tenant_id = 'tenant_dev' AND id <> 'demo'
             AND (title = 'Src' OR title LIKE 'Dict %' OR title LIKE 'PF %' OR title LIKE 'tplman%')`
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
    // #940: this predates ADR-157's home-page pointer (#364) — `demo_space` seeded a page but never
    // registered it as the space's home, so `HomeLanding`'s own documented fallback for a home-less
    // space (routes.tsx: land on `/spaces/<id>` instead of a page) fired for the product's most-used
    // fixture. That fallback is correct; the fixture was incomplete. Idempotent and safe to re-point
    // even if a test moved it: `demo` is the one page every other spec assumes still exists here.
    await tx`
      UPDATE spaces SET home_page_id = 'demo' WHERE tenant_id = 'tenant_dev' AND id = 'demo_space'
    `
    // Seed the admin member row to match the FGA seed (dev-user is tenant#admin).
    // Keeps the members table consistent with FGA so the tenant is NOT member-less
    // (the first-admin bootstrap must not fire for an already-admined tenant).
    await tx`
      INSERT INTO members (tenant_id, sub, email, display_name, role, groups)
      -- #578: the seeded member CARRIES a group. Every group feature (the completion list in the grant
      -- picker, the reverse lookup that turns a hashed id back into a name, the not-seen-yet
      -- distinction) reads the members.groups column, so with an empty directory none of them can be
      -- exercised at all: a test either skips or measures the empty case and reports nothing.
      VALUES ('tenant_dev', 'dev-user', 'dev@example.com', 'Dev User', 'admin', ARRAY['wiki Editors'])
      -- #940: display_name was DROPPED from this UPSERT's conflict clause, so a row already seeded
      -- with the wrong value (measured on the shared stack: 'dev-user', the sub itself, not 'Dev
      -- User') stayed wrong forever — the search candidate row that reads it then rendered the raw
      -- sub instead of falling through to memberLabel's "unknown" case OR showing the real name.
      -- Seeding is meant to be an idempotent baseline; every column it writes belongs on this line.
      ON CONFLICT (tenant_id, sub) DO UPDATE SET groups = EXCLUDED.groups, display_name = EXCLUDED.display_name
    `
    console.log('seeded: tenant_dev / demo_space / demo (page) / admin member')

    // Dev OIDC config (placeholder issuer; real IdP is configured per deployment).
    // client_secret is stored ENCRYPTED via the same helper the app uses.
    const clientSecret = process.env.OIDC_CLIENT_SECRET
    // #554 S1: tenant_oidc is N-capable (uuid PK, no tenant uniqueness) — seed idempotence goes
    // through the FIRST connection (sort, id), the same row every legacy read path picks.
    const [existingOidc] = await tx<{ id: string }[]>`
      SELECT id FROM tenant_oidc WHERE tenant_id = 'tenant_dev' ORDER BY sort, id LIMIT 1`
    if (existingOidc) {
      await tx`
        UPDATE tenant_oidc SET issuer = ${process.env.OIDC_ISSUER!}, client_id = ${process.env.OIDC_CLIENT_ID!},
          client_secret_enc = ${clientSecret ? encryptSecret(clientSecret) : null},
          redirect_uri = ${process.env.OIDC_REDIRECT_URI!}, updated_at = now()
        WHERE id = ${existingOidc.id}`
    } else {
      // #590: a FRESH dev connection gets a subject prefix, like every connection the admin screen
      // creates (ADR-197 §5). Without it the seed kept minting NULL rows, so "this connection predates
      // prefixes" was a permanent state of dev rather than a fact about old data.
      //
      // INSERT ONLY, deliberately. The UPDATE branch above must never learn to set it: the prefix is
      // what member subs are DERIVED from, so filling it in on a live connection gives every existing
      // member a different sub on their next sign-in — a second row for the same person, with their
      // FGA tuples, notifications, audit entries, API keys and authored pages all pointing at the sub
      // they no longer have.
      const connId = randomUUID()
      await tx`
        INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, client_secret_enc, redirect_uri, trust_groups, subject_prefix)
        VALUES (${connId}, 'tenant_dev', ${process.env.OIDC_ISSUER!}, ${process.env.OIDC_CLIENT_ID!},
                ${clientSecret ? encryptSecret(clientSecret) : null}, ${process.env.OIDC_REDIRECT_URI!}, true,
                ${subjectPrefixFor(connId)})`
      // #1000: a fresh connection mints a NAMESPACED sub (ADR-197 §5) for anything the IdP asserts, but
      // the seeded admin member above is the RAW sub 'dev-user' with no member_identities row bridging
      // the two — so a real OIDC round trip through this connection (login.spec.ts, invite.spec.ts) can
      // never resolve back to that member and always lands on the generic access-denied redirect. Real
      // deployments avoid this because a live member LINKS a new connection from account settings
      // (ADR-259 §3.3) before its prefix can shadow them; the seed never performs that step. Modeling
      // exactly that link keeps the prefixing feature itself untouched and only makes the fixture
      // internally consistent.
      await tx`
        INSERT INTO member_identities (tenant_id, connection_id, external_subject, member_sub)
        VALUES ('tenant_dev', ${connId}, 'dev-user', 'dev-user')
        ON CONFLICT (tenant_id, connection_id, external_subject) DO NOTHING`
    }
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
      // #576: this row cannot pass the liveness sweep — its token is a placeholder, so no TXT record
      // will ever match it and the sweep would demote it (correctly) once the grace window elapsed,
      // taking local host routing with it. Re-seeding therefore RE-ARMS the guard (counter zeroed,
      // anchor moved to now), which buys another grace window, and a dev who keeps the stack up longer
      // than that sets CUSTOM_DOMAIN_RECHECK_MS=0 to switch the sweep off. Both are dev-only crutches
      // for a dev-only shortcut: nothing here changes what a real deployment must prove.
      await tx`
        INSERT INTO custom_domains (tenant_id, domain, verification_token, status, verified_at, last_ok_at)
        VALUES ('tenant_dev', ${customDomain}, 'dev-seed-token', 'verified', now(), now())
        ON CONFLICT (tenant_id, domain) DO UPDATE SET status = 'verified', verified_at = now(),
          last_ok_at = now(), check_failures = 0, auto_demoted_at = NULL
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
