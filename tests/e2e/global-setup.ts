import postgres from "postgres";
import { seedFixtures, E2E } from "./fixtures";
import { startE2eIssuer } from "./oidc-issuer";

// Runs once before the suite. Seeds security fixtures, and stands up a real
// minimal OIDC issuer so login.spec can drive the genuine browser login flow
// through the same-origin proxy. The issuer issues sub "dev-user" (already a
// tenant#member via fga:seed), and tenant_dev's OIDC config is pointed at it.
// The issuer is unref'd and dies with the Playwright process (no teardown needed).
const CLIENT_ID = "e2e-client";
const REDIRECT = "http://dev.localhost:5180/auth/callback";

export default async function globalSetup() {
  await seedFixtures();

  // Fixed port so the (separate) API process can reference the issuer via static
  // env (PLATFORM_OIDC_ISSUER); it serves both tenant_oidc (login.spec) and the
  // platform IdP (signup.spec).
  const issuer = await startE2eIssuer({ clientId: CLIENT_ID, sub: "dev-user", port: 4444 });

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
    await sql`
      INSERT INTO tenant_oidc (tenant_id, issuer, client_id, client_secret_enc, scopes, redirect_uri)
      VALUES (${E2E.tenant}, ${issuer.url}, ${CLIENT_ID}, NULL, 'openid email profile', ${REDIRECT})
      ON CONFLICT (tenant_id) DO UPDATE SET
        issuer = EXCLUDED.issuer, client_id = EXCLUDED.client_id, client_secret_enc = NULL,
        scopes = EXCLUDED.scopes, redirect_uri = EXCLUDED.redirect_uri, enabled = true, updated_at = now()`;
  } finally {
    await sql.end();
  }
}
