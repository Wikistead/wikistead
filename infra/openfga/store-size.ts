// #825: how many tuples this stack's permission store holds, printed for a caller to read.
//
// OpenFGA has no endpoint that answers "how big are you", so the only place to ask is its own
// database — the same tables `reset-test-store.ts` reclaims from, and with the same caveat: they
// belong to OpenFGA, not to us, so a version that renames them must make this go QUIET rather than
// take a test run down with it. A caller that gets no number leaves the store alone.
//
// A TypeScript entry point rather than a line inside the .mjs that calls it, because the `postgres`
// client resolves from a tsx-run module and not from bare node at the workspace root — the same
// reason every other infra script that talks to this database is a tsx one.
import postgres from 'postgres'

function openfgaDbUrl(adminUrl: string): string {
  const u = new URL(adminUrl)
  u.pathname = '/openfga'
  return u.toString()
}

async function main(): Promise<void> {
  const adminUrl = process.env.DATABASE_ADMIN_URL
  if (!adminUrl) {
    console.error('[store-size] DATABASE_ADMIN_URL is not set')
    process.exit(2)
  }
  const sql = postgres(openfgaDbUrl(adminUrl), { max: 1, onnotice: () => {} })
  try {
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM tuple`
    // stdout is the answer, so a caller can `capture()` it; everything else goes to stderr.
    console.log(`TUPLES=${row?.n ?? 0}`)
  } finally {
    await sql.end()
  }
}

void main()
