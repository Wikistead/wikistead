// Inserts dev DB rows (spaces + pages) for local E2E use.
// FGA tuples are handled separately by infra/openfga/seed.ts.
// Run with: pnpm --filter @kb/server db:seed
import postgres from 'postgres'

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
    console.log('seeded: tenant_dev / demo_space / demo (page)')
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
    console.log('seeded: tenant_acme / acme_space / acme_page')
  })

  await sql.end()
})().catch((err) => { console.error(err); process.exit(1) })
