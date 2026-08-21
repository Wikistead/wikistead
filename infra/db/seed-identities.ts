// #852: who the seed owns, written once.
//
// Two scripts need this list and both had their own copy. `prune-test-tenants.ts` kept the tenant ids
// (to know which tenants survive a prune) and `seed.ts` kept a list of SUB PREFIXES that test suites
// were known to mint — `gate-%`, `pf-out-%`, `inv-%`, `seat-%` — so it could delete their leftovers.
//
// A prefix list is the wrong shape for that job, and it failed the way prefix lists fail: a suite that
// mints `dg-w1-<stamp>` (the digest-email fixtures) was never in it, so its rows survived every prune
// and every seed. They are not idle — a member row is a SEAT, so two of them changed the answer of a
// seat-cap assertion in an unrelated file, which read as the product refusing a legitimate invitation.
//
// The derivation needs no list: the seed writes exactly these member rows, so in a tenant the prune
// keeps, everything else was made by a test.
export const SEEDED_MEMBERS = [
  { tenantId: 'tenant_dev', sub: 'dev-user' },
  { tenantId: 'tenant_acme', sub: 'acme-admin' },
] as const

/** The tenants a prune keeps: the ones the seed owns. */
export const SEEDED_TENANTS = [...new Set(SEEDED_MEMBERS.map((m) => m.tenantId))]
