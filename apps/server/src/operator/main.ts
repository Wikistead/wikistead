// #434 / ADR-170: the operator-console entrypoint — its own process, its own (cluster-internal)
// Service, deployed ONLY by the Cloud overlay. The tenant app never imports this module; a tenant-
// host request cannot reach these routes even by bug, because the process isn't there.
//
// Fail-closed boot: every input is REQUIRED. Missing JWKS or an empty allowlist must stop the
// process, never fall through to an unauthenticated console.
import postgres from 'postgres'
import { buildOperatorApp, type OperatorJwks } from './app.js'

function required(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`${name} required (fail-closed: the operator console never starts half-configured)`)
    process.exit(1)
  }
  return v
}

const dbUrl = required('OPERATOR_DATABASE_URL') // the operator_ro DSN — NEVER the admin DSN (no BYPASSRLS in an HTTP workload)
const jwksRaw = required('OPERATOR_CONSOLE_JWKS') // pinned JWKS JSON — rotation is a redeploy, never a fetch
const subsRaw = required('OPERATOR_CONSOLE_SUBS') // comma-separated operator subject allowlist

let jwks: OperatorJwks
try {
  jwks = JSON.parse(jwksRaw) as OperatorJwks
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) throw new Error('no keys')
} catch {
  console.error('OPERATOR_CONSOLE_JWKS must be a JWKS JSON object with a non-empty "keys" array')
  process.exit(1)
}
const allowedSubs = subsRaw.split(',').map((s) => s.trim()).filter(Boolean)
if (allowedSubs.length === 0) {
  console.error('OPERATOR_CONSOLE_SUBS must contain at least one subject')
  process.exit(1)
}

const sql = postgres(dbUrl, { max: 2, onnotice: () => {} })
const app = buildOperatorApp({ sql, jwks, allowedSubs })

const port = Number(process.env.PORT ?? 4100)
app.listen({ port, host: '0.0.0.0' }).then(
  () => console.log(`operator console listening on :${port}`),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
