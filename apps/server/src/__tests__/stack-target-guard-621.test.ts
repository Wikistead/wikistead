// #621: seeding or migrating ANOTHER session's stack.
//
// The offset (#484) moves every port so three worktrees can run the same suites at once, and the
// setup scripts inject the moved connection URLs — `--env-file` alone still names the ORIGINAL ports.
// So the obvious hand-typed command when a fixture looks stale,
// `npx tsx --env-file=.env.e2e infra/db/seed.ts`, writes to offset 0 no matter what offset the shell
// is in. It happened while investigating this ticket, and nothing objected: the seed reported success
// against a stack the session did not own.
//
// The scripts already carried comments warning about it. This is the guard those comments describe.
//
// #621 re-review: the first version of this file was a PURE-FUNCTION test — deleting the guard's calls
// in seed.ts and migrate.ts left it green, so the guard could have been unwired with nothing noticing.
// The second describe now runs both commands for real, and the third holds the shipped runner to
// importing no dev-only tooling (the first wiring attempt broke the CE image build).
import { describe, it, expect, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { promisify } from 'node:util'

// Loaded through a specifier tsc does not resolve, for the reason the third describe measures: the CE
// image compiles apps/server/src INCLUDING this directory, and the repo-root `scripts/` is not in its
// build context — a static import here breaks `docker build` exactly as the one in migrate.ts did
// (measured, both times). The port maps come from the module the guard itself reads, so this measures
// the real numbers rather than a copy; they are plain JS because docker compose and the setup scripts
// execute them directly.
const scriptsDir = new URL('../../../../scripts/', import.meta.url).href
const { assertStackTarget } = await import(`${scriptsDir}assert-stack-target.mjs`) as {
  assertStackTarget(url: string | undefined, what: string): void
}
const { e2ePorts, serverTestPorts } = await import(`${scriptsDir}stack-offset.mjs`) as {
  e2ePorts(offset: number): { pg: number }
  serverTestPorts(offset: number): { pg: number }
}

const saved = process.env.WKS_STACK_OFFSET
afterEach(() => { if (saved === undefined) delete process.env.WKS_STACK_OFFSET; else process.env.WKS_STACK_OFFSET = saved })

const urlFor = (port: number) => `postgres://postgres:postgres@localhost:${port}/app`

describe('#621: a command cannot write to a stack this session does not own', () => {
  it('refuses the base ports while an offset is set — the exact mistake that was made', () => {
    process.env.WKS_STACK_OFFSET = '3'
    expect(() => assertStackTarget(urlFor(e2ePorts(0).pg), 'db:seed')).toThrow(/another session's stack/)
    expect(() => assertStackTarget(urlFor(serverTestPorts(0).pg), 'migrate')).toThrow(/another session's stack/)
  })

  it('and any OTHER session\'s offset too, not just the base one', () => {
    process.env.WKS_STACK_OFFSET = '3'
    expect(() => assertStackTarget(urlFor(e2ePorts(1).pg), 'db:seed')).toThrow()
    expect(() => assertStackTarget(urlFor(serverTestPorts(2).pg), 'db:seed')).toThrow()
  })

  it('allows this offset\'s own stacks — both families', () => {
    process.env.WKS_STACK_OFFSET = '3'
    expect(() => assertStackTarget(urlFor(e2ePorts(3).pg), 'db:seed')).not.toThrow()
    expect(() => assertStackTarget(urlFor(serverTestPorts(3).pg), 'migrate')).not.toThrow()
  })

  it('is silent when no isolation was asked for (CI and a plain checkout are unchanged)', () => {
    delete process.env.WKS_STACK_OFFSET
    expect(() => assertStackTarget(urlFor(e2ePorts(0).pg), 'db:seed')).not.toThrow()
    expect(() => assertStackTarget(urlFor(5432), 'db:seed')).not.toThrow() // the dev stack
    // A url it cannot parse is left to the caller's own failure rather than turned into this one.
    expect(() => assertStackTarget('not-a-url', 'db:seed')).not.toThrow()
  })

  it('the message says what to run instead — a refusal with no way forward is a wall', () => {
    process.env.WKS_STACK_OFFSET = '2'
    expect(() => assertStackTarget(urlFor(5433), 'db:seed')).toThrow(/setup:e2e|setup:server-test/)
  })
})

const run = promisify(execFile)
const repo = resolve(import.meta.dirname, '../../../..')

// The commands themselves, with the exact mistake in the environment: an offset set, a connection URL
// naming the BASE stack. Neither is allowed to reach Postgres.
const wrongTarget = { WKS_STACK_OFFSET: '3', DATABASE_ADMIN_URL: 'postgres://postgres:postgres@localhost:5433/app' }
const refusalFrom = async (script: string): Promise<string> => {
  try {
    await run('npx', ['tsx', script], { cwd: repo, env: { ...process.env, ...wrongTarget }, timeout: 120_000 })
    return '' // it ran — which is the failure this test exists to catch
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string }
    return `${e.stderr ?? ''}${e.stdout ?? ''}`
  }
}

describe('#621: the guard is actually wired into the commands that write', () => {
  it('db:seed refuses before it connects', async () => {
    expect(await refusalFrom('infra/db/seed.ts'), 'the seed ran against the wrong stack').toMatch(/another session's stack/)
  }, 180_000)

  it('the migration runner refuses too', async () => {
    expect(await refusalFrom('apps/server/src/migrate.ts'), 'the migration ran against the wrong stack').toMatch(/another session's stack/)
  }, 180_000)
})

// Every static import in apps/server/src that RESOLVES into the repo-root `scripts/` directory. Resolved,
// not pattern-matched: `../scripts/` is apps/server/src/scripts, which ships with the app and is fine —
// only the repo-root one is outside the image's build context. Each is reported with whether the line
// above it suppresses the type error.
function rootScriptImports(): { file: string; line: string; suppressed: boolean }[] {
  const found: { file: string; line: string; suppressed: boolean }[] = []
  const rootScripts = join(repo, 'scripts') + '/'
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue }
      if (!entry.name.endsWith('.ts')) continue
      const lines = readFileSync(full, 'utf8').split('\n')
      lines.forEach((line, i) => {
        const m = /^\s*import\s[^\n]*from\s*['"](\.[^'"]*)['"]/.exec(line)
        if (!m) return
        if (!resolve(dir, m[1]!).startsWith(rootScripts)) return
        found.push({ file: full.slice(repo.length + 1), line: line.trim(), suppressed: /@ts-expect-error/.test(lines[i - 1] ?? '') })
      })
    }
  }
  walk(join(repo, 'apps/server/src'))
  return found
}

describe('#621: the shipped runner stays buildable', () => {
  // apps/server/Dockerfile's COPY list is CE-only on purpose and does NOT include the repo-root
  // `scripts/`, so an import that reaches it breaks `docker build` while every local check stays green
  // (measured: TS2307 in the image's own `tsc -b`). Whatever needs dev-only tooling loads it at runtime.
  it('nothing that SHIPS reaches the repo-root scripts/', () => {
    const shipped = rootScriptImports().filter((o) => !o.file.includes('__tests__'))
    expect(shipped, 'these are compiled into the image and the directory is not there').toEqual([])
  })

  it('and a test that reaches it says so, because the image compiles __tests__ too', () => {
    // The image's tsc -b covers this directory as well, so the first attempt at the guard merely traded
    // migrate.ts's error for one in this very file (measured). The two older test files that import the
    // root scripts get away with it ONLY because a `@ts-expect-error` sits above the line — an
    // unsuppressed one is a build break, so that is what this refuses.
    const unsuppressed = rootScriptImports().filter((o) => o.file.includes('__tests__') && !o.suppressed)
    expect(unsuppressed, 'an unsuppressed root-scripts import breaks the image build').toEqual([])
  })
})
