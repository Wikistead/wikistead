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

  // Delete-then-write so this script is idempotent on re-run after restarts. PER TUPLE (#445):
  // FGA write batches are all-or-nothing — with a batched delete, ADDING a tuple to the seed made
  // the delete batch fail wholesale on the not-yet-existing newcomer (swallowed), and the write
  // batch then died on "already exists" for every old tuple. Per-tuple keeps re-runs green across
  // seed-set changes; dev-scale volume, so the extra round-trips are irrelevant.
  async function writeIdempotent(tuples: TupleKey[]) {
    for (const t of tuples) {
      const key: TupleKeyWithoutCondition = { user: t.user, relation: t.relation, object: t.object }
      try { await fga.write({ deletes: [key] }) } catch { /* tuple may not exist yet */ }
      await fga.write({ writes: [t] })
    }
  }

  // ── Tenant + space + page hierarchy ─────────────────────────────────────
  await writeIdempotent([
    { user: 'user:dev-user',      relation: 'admin',   object: 'tenant:tenant_dev'  },
    { user: 'user:dev-user',      relation: 'member',  object: 'tenant:tenant_dev'  },
    { user: 'user:*',             relation: 'space_creator', object: 'tenant:tenant_dev' }, // ADR-171: all-members-create default
    { user: 'tenant:tenant_dev',  relation: 'tenant',  object: 'space:demo_space'   },
    { user: 'user:dev-user',      relation: 'manager', object: 'space:demo_space'   },
    { user: 'space:demo_space',   relation: 'space',   object: 'page:demo'          },
    // #218 / ADR-103 addendum: a space-linked (published) page carries the `published` marker PAIR so its
    // published children inherit folder grants (`*_inherited = *_from_parent and published`). Keep the
    // space-linked ⟺ published invariant intact in the seed (publishPage/migration write these too).
    { user: 'user:*',             relation: 'published', object: 'page:demo'        },
    { user: 'share_link:*',       relation: 'published', object: 'page:demo'        },
  ])
  console.log('wrote: tenant + space + page hierarchy')

  // ── Non-expiring view share link ─────────────────────────────────────────
  // Tuple written WITHOUT condition → link never expires.
  // Revoke by deleting this tuple; enforced at next onAuthenticate call.
  await writeIdempotent([
    { user: 'share_link:demo_view_perm', relation: 'view_direct', object: 'page:demo' }, // #218: direct view grant → view_direct leaf
  ])
  console.log('wrote: non-expiring view share_link (demo_view_perm)')

  // ── Time-bounded edit share link (+1h) ───────────────────────────────────
  // Tuple written WITH non_expired condition → expires_at stored in tuple context.
  // OpenFGA evaluates current_time < expires_at at check time.
  const expiresAt = new Date(Date.now() + 3600_000).toISOString()
  await writeIdempotent([
    {
      user: 'share_link:demo_edit_temp', relation: 'edit_direct', object: 'page:demo', // #218: direct edit grant → edit_direct leaf
      condition: { name: 'non_expired', context: { expires_at: expiresAt } },
    },
  ])
  console.log(`wrote: time-bounded edit share_link (demo_edit_temp, expires ${expiresAt})`)

  // ── Acme tenant for cross-tenant isolation tests ─────────────────────────
  await writeIdempotent([
    { user: 'user:acme-admin',    relation: 'admin',   object: 'tenant:tenant_acme' },
    // #471 / ADR-176: admin and member are separate relations and provisioning writes BOTH; a seed
    // that grants only admin describes a tenant nobody can authenticate into.
    { user: 'user:acme-admin',    relation: 'member',  object: 'tenant:tenant_acme' },
    { user: 'user:*',             relation: 'space_creator', object: 'tenant:tenant_acme' }, // ADR-171
    { user: 'tenant:tenant_acme', relation: 'tenant',  object: 'space:acme_space'   },
    { user: 'user:acme-admin',    relation: 'manager', object: 'space:acme_space'   },
    { user: 'space:acme_space',   relation: 'space',   object: 'page:acme_page'     },
    { user: 'user:*',             relation: 'published', object: 'page:acme_page'   }, // #218 addendum: space-linked ⟺ published
    { user: 'share_link:*',       relation: 'published', object: 'page:acme_page'   },
  ])
  console.log('wrote: acme tenant + space + page (cross-tenant isolation tests)')
})().catch((err) => { console.error(err); process.exit(1) })
