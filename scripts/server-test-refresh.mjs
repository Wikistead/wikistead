// #825: give a test run a permission store it can answer from, or say why it did nothing.
//
// `setup:server-test` rotates the store once. Every run after that piles onto the new one, so the
// stack a session set up in the morning is not the stack it is testing against by lunchtime —
// measured at 4.4x the per-check cost after two full runs, and 17x (with two thirds of a 50-wide
// batch coming back as `deadline_exceeded`) on the stack #825 was filed from. That failure arrives
// as a standing red in whichever suite happens to batch authorization checks, from a diff that
// touched neither it nor them.
//
// So `pnpm test` asks this first. It is a NO-OP unless three things are true, and it says which one
// stopped it rather than failing: this tree has a bootstrapped isolated stack, that stack is up, and
// its store is over the threshold. A machine with no stack at all (a fresh clone, the public CI
// before its setup step) prints one line and exits 0.
//
// ⚠️ Not wired into the per-package test scripts, deliberately. `pnpm test` fans out to three
// packages that share one stack, and rotating the store from a sibling's entry point would take the
// model id out from under a suite already running (`authorization_model_not_found` — the failure
// #789 spent a day reading as a product bug). Here it runs once, before anything starts.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serverTestPorts, serverTestComposeEnv } from './stack-offset.mjs'
import { countTuples, rotateStore, refreshVerdict, REFRESH_THRESHOLD } from './server-test-store.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL = join(repo, '.env.server-test.local')

async function main() {
  const hasLocalEnv = existsSync(LOCAL)
  if (hasLocalEnv) {
    // Same order the suites use: the local pin FIRST (it carries this session's offset), then the
    // base file — `loadEnvFile` never overrides a variable that is already set, so first wins.
    for (const f of ['.env.server-test.local', '.env.server-test']) {
      const p = join(repo, f)
      if (existsSync(p)) process.loadEnvFile(p)
    }
  }
  const marker = process.env.WIKISTEAD_TEST_STACK
  const ports = serverTestPorts()
  // The offset URLs as REAL environment variables: they beat any `--env-file` the child steps name,
  // which is what keeps a session at offset >= 1 off the shared stack (#484).
  const env = {
    ...process.env,
    ...serverTestComposeEnv(ports),
    DATABASE_URL: `postgres://app:app@localhost:${ports.pg}/app`,
    DATABASE_ADMIN_URL: `postgres://postgres:postgres@localhost:${ports.pg}/app`,
    VALKEY_URL: `redis://localhost:${ports.valkey}`,
    OPENFGA_API_URL: `http://localhost:${ports.fgaHttp}`,
    MEILI_HOST: `http://localhost:${ports.meili}`,
    S3_ENDPOINT: `http://localhost:${ports.s3}`,
    SMTP_PORT: String(ports.smtp),
    MAILPIT_API_URL: `http://localhost:${ports.mailpit}/api/v1`,
  }
  // Counting spawns a child, so it is only asked once the cheap refusals are out of the way.
  const tuples = hasLocalEnv && marker === 'server-test' ? countTuples({ repo, env }) : null
  switch (refreshVerdict({ hasLocalEnv, marker, tuples })) {
    case 'no-stack':
      return console.log('[store-refresh] no .env.server-test.local — no isolated stack in this tree, nothing to refresh')
    case 'not-mine':
      return console.log('[store-refresh] the stack marker is not "server-test" — refusing to touch anything (#269)')
    case 'unknown':
      // The stack is down, or OpenFGA's own schema moved. Either way this is a convenience, not a
      // gate: the run that follows will fail on its own terms, with a better message than this one.
      return console.log('[store-refresh] could not read the permission store — leaving it alone')
    case 'keep':
      return console.log(`[store-refresh] ${tuples} tuple(s), under the ${REFRESH_THRESHOLD} threshold — keeping this store`)
    default:
      console.log(`[store-refresh] ${tuples} tuple(s), over the ${REFRESH_THRESHOLD} threshold — rotating (offset ${ports.offset})`)
      rotateStore({ repo, ports, env, localEnvPath: LOCAL })
  }
}

await main()
