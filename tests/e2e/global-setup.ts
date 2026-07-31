import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { seedFixtures, seedFgaFixtures, E2E } from "./fixtures";
import { startE2eIssuer } from "./oidc-issuer";
// @ts-expect-error — repo-root JS helper, no types
import { e2ePorts } from "../../scripts/stack-offset.mjs";

// #484 slice 2: derive the issuer port + redirect origin from this stack's offset (0 = the originals).
const P = e2ePorts();

// Runs once before the suite. Seeds security fixtures, and stands up a real
// minimal OIDC issuer so login.spec can drive the genuine browser login flow
// through the same-origin proxy. The issuer issues sub "dev-user" (already a
// tenant#member via fga:seed), and tenant_dev's OIDC config is pointed at it.
// The issuer is unref'd and dies with the Playwright process (no teardown needed).
const CLIENT_ID = "e2e-client";
const REDIRECT = `http://dev.localhost:${P.web}/auth/callback`;

export default async function globalSetup() {
  await seedFixtures();
  // #279: re-assert the shared demo/acme FGA tuples every run, so a run left broken by a spec that deleted
  // one (e.g. `space:demo_space#space@page:demo`) self-heals here instead of staying broken forever.
  await seedFgaFixtures();

  // Fixed port so the (separate) API process can reference the issuer via static
  // env (PLATFORM_OIDC_ISSUER); it serves both tenant_oidc (login.spec) and the
  // platform IdP (signup.spec).
  const issuer = await startE2eIssuer({ clientId: CLIENT_ID, sub: "dev-user", port: P.issuer });

  // Point tenant_dev's OIDC config at the issuer (public client — the issuer does
  // not check client auth). Admin pool bypasses RLS.
  const sql = postgres(E2E.pgAdmin);
  try {
    // Clean up tenants created by prior signup.spec runs (unique slugs accumulate).
    const stale = await sql<{ id: string }[]>`SELECT id FROM tenants WHERE slug LIKE 'e2esignup%'`;
    for (const t of stale) {
      await sql`DELETE FROM members WHERE tenant_id = ${t.id}`;
      await sql`DELETE FROM tenant_oidc WHERE tenant_id = ${t.id}`;
      await sql`DELETE FROM tenants WHERE id = ${t.id}`;
    }
    // Clean invite-test artifacts so each run grants membership fresh (invite.spec
    // mints invitees as sub "inv-<ts>" and creates invites in tenant_dev).
    await sql`DELETE FROM invites WHERE tenant_id = ${E2E.tenant}`;
    await sql`DELETE FROM members WHERE tenant_id = ${E2E.tenant} AND sub LIKE 'inv-%'`;
    // The shared dev member's editor chrome is a per-user PREFERENCE that onboarding-289 sets while
    // testing the personas; its afterEach restores it, but a killed or timed-out run leaves the last
    // persona applied — and a persona that hides the vim button makes every vim spec fail to find it,
    // in a way that reads as a product regression rather than leftover state. Reset it here, the same
    // self-healing idea as seedFgaFixtures(): the next run starts from the default chrome regardless
    // of how the previous one died. (The gate-* members onboarding-289 mints are throwaway.)
    await sql`
      UPDATE members SET editor_chrome = NULL, editor_display_mode = NULL, editor_keymap = NULL,
                         onboarding_completed_at = COALESCE(onboarding_completed_at, now())
      WHERE tenant_id = ${E2E.tenant} AND sub = 'dev-user'`;
    await sql`DELETE FROM members WHERE tenant_id = ${E2E.tenant} AND sub LIKE 'gate-%'`;
    // #554 S1: tenant_oidc is N-capable (uuid PK, no tenant uniqueness) — idempotence goes through
    // the FIRST connection (ORDER BY sort, id), the same row every legacy read path picks.
    const [oidcRow] = await sql<{ id: string }[]>`
      SELECT id FROM tenant_oidc WHERE tenant_id = ${E2E.tenant} ORDER BY sort, id LIMIT 1`;
    if (oidcRow) {
      await sql`
        UPDATE tenant_oidc SET issuer = ${issuer.url}, client_id = ${CLIENT_ID}, client_secret_enc = NULL,
          scopes = 'openid email profile', redirect_uri = ${REDIRECT}, enabled = true, updated_at = now()
        WHERE id = ${oidcRow.id}`;
    } else {
      await sql`
        INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, client_secret_enc, scopes, redirect_uri, bootstrap_eligible, trust_groups)
        VALUES (${randomUUID()}, ${E2E.tenant}, ${issuer.url}, ${CLIENT_ID}, NULL, 'openid email profile', ${REDIRECT}, true, true)`;
    }
  } finally {
    await sql.end();
  }
}
