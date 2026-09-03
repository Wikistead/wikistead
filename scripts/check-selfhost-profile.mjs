#!/usr/bin/env node
// #726 / ADR-233: the `apps` profile has to be able to serve the product.
//
// What this guards is not style. Before #726 the profile was two services with `env_file: [.env]`,
// and three files told a self-hoster to run it. What they got was: no UI (there was no web service),
// no API either (the dev `.env` points every dependency at `localhost`, which inside a container is
// the container), and — if they hand-fixed the URLs — an AUTHENTICATION BYPASS, because `env_file`
// overrides the image's `ENV NODE_ENV=production` and `app.ts` accepts the literal bearer
// `dev-token` whenever NODE_ENV is not production.
//
// Each of those is one deleted line away from coming back, and none of them fails a build: the
// stack simply does not work, in a place nobody runs on every commit. So the shape is asserted here,
// cheaply, and the release job boots the thing for real (traversal + dev-token + /pub shell).
//
// Deliberately NOT a YAML-shaped assertion of the whole file: this checks the handful of properties
// whose absence is a shipped defect, and says why each one is here.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []

// Ask COMPOSE, not the file. `extends:`, profiles and variable substitution all mean the text and
// the effective configuration are different documents — and it is the effective one that boots.
let config
try {
  config = JSON.parse(
    execFileSync('docker', ['compose', '--profile', 'apps', 'config', '--format', 'json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SITE_HOST: process.env.SITE_HOST ?? 'dev.localhost' },
    }),
  )
} catch (err) {
  // No docker in this environment (a CE contributor, a sandboxed CI lane) — say so and pass. A
  // check that cannot run must not be reported as one that ran: `skipped` is not `green`.
  console.log(`check-selfhost-profile SKIPPED — \`docker compose config\` is unavailable here (${String(err.message).split('\n')[0]})`)
  process.exit(0)
}

const services = config.services ?? {}
const inApps = (name) => (services[name]?.profiles ?? []).includes('apps')

// ── The product is all there ─────────────────────────────────────────────────────────────────
for (const name of ['web', 'server', 'collab', 'proxy']) {
  if (!services[name]) problems.push(`the \`apps\` profile has no \`${name}\` service — this is the profile three files tell a self-hoster to run`)
  else if (!inApps(name)) problems.push(`\`${name}\` exists but is not in the \`apps\` profile, so \`--profile apps\` does not start it`)
}

// ── The dev bypass stays closed ──────────────────────────────────────────────────────────────
// `environment:` wins over `env_file:`, which is the only reason this can be pinned at all.
for (const name of ['server', 'collab']) {
  const env = services[name]?.environment ?? {}
  if (env.NODE_ENV !== 'production') {
    problems.push(
      `\`${name}\` does not pin NODE_ENV=production. The .env this profile also loads says \`development\`, ` +
      'and the server accepts the literal bearer `dev-token` whenever NODE_ENV is not production — a self-host ' +
      'profile running an authentication bypass is the defect #726 exists to close.',
    )
  }
}

// ── Nothing host-shaped is left for a container to resolve ───────────────────────────────────
// `localhost` inside a container is the container. This is why the API did not start at all.
for (const [name, svc] of Object.entries(services)) {
  if (!inApps(name)) continue
  for (const [k, v] of Object.entries(svc.environment ?? {})) {
    if (typeof v === 'string' && /(^|\/\/|@)localhost([:/]|$)/.test(v)) {
      problems.push(`${name}.${k} points at localhost (${v}) — inside a container that is the container itself, not the service`)
    }
  }
}

// ── The authorization store is the persistent one ────────────────────────────────────────────
// Under NODE_ENV=production the server ASSERTS this and refuses to boot on `memory` (#338/ADR-128),
// so a profile that claims one engine while the service runs another is a stack that either does not
// start or starts trusting a lie. Measured: pinning NODE_ENV surfaced exactly this (#726).
const declared = services.server?.environment?.OPENFGA_DATASTORE_ENGINE
const actual = services.openfga?.environment?.OPENFGA_DATASTORE_ENGINE
if (!declared) problems.push('server does not state OPENFGA_DATASTORE_ENGINE — under NODE_ENV=production it refuses to boot without it')
else if (actual && declared !== actual) {
  problems.push(`server says OPENFGA_DATASTORE_ENGINE=${declared} but the openfga service runs ${actual} — one of them is wrong and the server asserts this at boot`)
}

// ── One origin ───────────────────────────────────────────────────────────────────────────────
// The SPA calls a RELATIVE /api and nginx's SPA fallback answers that with 200 + index.html, so a
// published app port is not a convenience — it is an invitation to the two-origin failure (ADR-016).
for (const name of ['web', 'server', 'collab']) {
  const ports = services[name]?.ports ?? []
  if (ports.length) {
    problems.push(
      `\`${name}\` publishes ${ports.length} port(s) in the apps profile. Everything is reached through the proxy: ` +
      'a second reachable origin is how the SPA ends up calling itself and receiving index.html for /api.',
    )
  }
}
if (!(services.proxy?.ports ?? []).length) problems.push('`proxy` publishes no port — nothing would be reachable at all')

// ── The public shell is handed over ──────────────────────────────────────────────────────────
// Without it /pub answers 404 for every published page, and the traversal alone does not catch that
// (its probe only asserts the answer did not come from the SPA — a JSON 404 passes).
const shell = services.server?.environment?.PUBLIC_SHELL_INDEX
if (!shell) {
  problems.push('server has no PUBLIC_SHELL_INDEX — the route table sends /pub to the server, and with the shell off every published page 404s')
} else if (!(services.server?.volumes ?? []).some((v) => (v.target ?? v).toString().startsWith(shell.replace(/\/[^/]*$/, '')))) {
  problems.push(`server sets PUBLIC_SHELL_INDEX=${shell} but mounts nothing there — the server refuses to boot when it is set and unreadable`)
}

// ── The first `up` cannot lose the S3 race, and a lost race heals itself (#1081 / #1082) ─────
// Measured on a fresh clone: the server reached bucket-ensure before the S3 gateway listened,
// died unhandled, and STAYED dead — the UI came up over an API that did not exist.
if (!services.seaweedfs?.healthcheck) {
  problems.push('seaweedfs has no healthcheck — the server races its S3 gateway on a first `up` and dies at bucket-ensure (#1082)')
}
for (const name of ['server', 'collab']) {
  if (services[name] && services[name].restart !== 'unless-stopped') {
    problems.push(`\`${name}\` has no restart policy — one boot-time fatal leaves the stack half-dead forever (#1082)`)
  }
}
const swDep = services.server?.depends_on?.seaweedfs
if (swDep?.condition !== 'service_healthy') {
  problems.push('server does not wait for a HEALTHY seaweedfs — the healthcheck exists to gate exactly this start (#1082)')
}
// ── The S3 identity is the .env identity (#1081) ─────────────────────────────────────────────
// The guide says "set real S3 keys"; the store must actually accept them. The command writes its
// identity file from the same variables at container start — a static fixture file here means the
// server signs with keys the store has never heard of, and the first upload 403s.
const swText = JSON.stringify(services.seaweedfs?.command ?? '') + JSON.stringify(services.seaweedfs?.entrypoint ?? '')
if (!swText.includes('S3K') || swText.includes('/etc/seaweedfs/s3.json')) {
  problems.push('seaweedfs does not derive its S3 identity from .env (S3_ACCESS_KEY/S3_SECRET_KEY) — the keys the guide tells a reader to change would not be the keys the store accepts (#1081)')
}
if (!('S3K' in (services.seaweedfs?.environment ?? {}))) {
  problems.push('seaweedfs.environment carries no S3K — the identity template has nothing to interpolate (#1081)')
}

// ── The guide's command is the command ───────────────────────────────────────────────────────
// #696 a printed command that had never been run. These three files carry the claim.
const CMD = 'docker compose --profile apps up -d --build'
for (const f of ['docs/self-hosting.md', 'README.md', 'CONTRIBUTING.md']) {
  const text = readFileSync(join(root, f), 'utf8')
  if (!text.includes(CMD)) problems.push(`${f} no longer prints \`${CMD}\` — if the command changed, this check has to change with it`)
}

// ── …and the guide's ORDER works on a clone that has never built ─────────────────────────────
// #726 the guides say `pnpm install` then `pnpm dev:up`, and on a fresh clone that fails —
// `db:seed` imports `@wikistead/authz`, whose `dist/` is gitignored and which no `prepare` script
// builds. The fix is that `dev:setup` builds the packages itself, so the guides stay two commands.
//
// Checked HERE by asserting the step EXISTS and runs BEFORE the early exit. A check that only asked
// "does the guide mention build" would go green on a guide that grew a line, which is the outcome
// this fix deliberately avoided; and one that ignored the ordering would go green on the version of
// this fix that returned before building (measured while writing it).
{
  const setup = readFileSync(join(root, 'scripts/dev-setup.mjs'), 'utf8')
  // Quote-agnostic: the source spells this with double quotes, and matching one style is how a check
  // reports its own formatting preference as a product defect (measured — this fired on the fix).
  const build = setup.search(/["']build["'],\s*["']--filter=\.\/packages\/\*["']/)
  const earlyExit = setup.indexOf('process.exit(0)')
  if (build < 0) {
    problems.push('scripts/dev-setup.mjs no longer builds the workspace packages — a fresh clone dies in db:seed with a missing @wikistead/authz/dist (#726)')
  } else if (earlyExit >= 0 && build > earlyExit) {
    problems.push('scripts/dev-setup.mjs builds the packages AFTER its early exit — a fresh clone against an existing FGA store returns with nothing built')
  }
}

if (problems.length) {
  console.error('check-selfhost-profile: the `apps` profile could not serve the product (#726 / ADR-233):')
  for (const p of problems) console.error('  ' + p)
  process.exit(1)
}
console.log(
  `check-selfhost-profile OK — web/server/collab/proxy in the apps profile, NODE_ENV pinned, ` +
  `no host-shaped URLs, one published origin, /pub shell mounted.`,
)
