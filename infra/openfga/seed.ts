// Writes dev tuples for the PoC. Must be re-run after container restarts because
// the OpenFGA dev datastore is in-memory (OPENFGA_DATASTORE_ENGINE=memory).
//
// Requires OPENFGA_STORE_ID and OPENFGA_MODEL_ID to be set (run bootstrap.ts first).
import { OpenFgaClient } from '@openfga/sdk'
import type { TupleKey, TupleKeyWithoutCondition } from '@openfga/sdk'

;(async () => {
  const fga = new OpenFgaClient({
    apiUrl: process.env.OPENFGA_API_URL ?? 'http://localhost:8080',
    storeId: process.env.OPENFGA_STORE_ID!,
    authorizationModelId: process.env.OPENFGA_MODEL_ID,
  })

  // Delete-then-write so this script is idempotent on re-run after restarts.
  async function writeIdempotent(tuples: TupleKey[]) {
    const deletes: TupleKeyWithoutCondition[] = tuples.map(({ user, relation, object }) => ({
      user, relation, object,
    }))
    try { await fga.write({ deletes }) } catch { /* tuples may not exist yet */ }
    await fga.write({ writes: tuples })
  }

  // ── Tenant + space + page hierarchy ─────────────────────────────────────
  await writeIdempotent([
    { user: 'user:dev-user',      relation: 'admin',   object: 'tenant:tenant_dev'  },
    { user: 'user:dev-user',      relation: 'member',  object: 'tenant:tenant_dev'  },
    { user: 'tenant:tenant_dev',  relation: 'tenant',  object: 'space:demo_space'   },
    { user: 'user:dev-user',      relation: 'manager', object: 'space:demo_space'   },
    { user: 'space:demo_space',   relation: 'space',   object: 'page:demo'          },
  ])
  console.log('wrote: tenant + space + page hierarchy')

  // ── Non-expiring view share link ─────────────────────────────────────────
  // Tuple written WITHOUT condition → link never expires.
  // Revoke by deleting this tuple; enforced at next onAuthenticate call.
  await writeIdempotent([
    { user: 'share_link:demo_view_perm', relation: 'view', object: 'page:demo' },
  ])
  console.log('wrote: non-expiring view share_link (demo_view_perm)')

  // ── Time-bounded edit share link (+1h) ───────────────────────────────────
  // Tuple written WITH non_expired condition → expires_at stored in tuple context.
  // OpenFGA evaluates current_time < expires_at at check time.
  const expiresAt = new Date(Date.now() + 3600_000).toISOString()
  await writeIdempotent([
    {
      user: 'share_link:demo_edit_temp', relation: 'edit', object: 'page:demo',
      condition: { name: 'non_expired', context: { expires_at: expiresAt } },
    },
  ])
  console.log(`wrote: time-bounded edit share_link (demo_edit_temp, expires ${expiresAt})`)

  // ── Acme tenant for cross-tenant isolation tests ─────────────────────────
  await writeIdempotent([
    { user: 'user:acme-admin',    relation: 'admin',   object: 'tenant:tenant_acme' },
    { user: 'tenant:tenant_acme', relation: 'tenant',  object: 'space:acme_space'   },
    { user: 'user:acme-admin',    relation: 'manager', object: 'space:acme_space'   },
    { user: 'space:acme_space',   relation: 'space',   object: 'page:acme_page'     },
  ])
  console.log('wrote: acme tenant + space + page (cross-tenant isolation tests)')
})().catch((err) => { console.error(err); process.exit(1) })
