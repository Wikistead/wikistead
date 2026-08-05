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
import { describe, it, expect, afterEach } from 'vitest'
import { assertStackTarget } from '../../../../scripts/assert-stack-target.mjs'
// The port maps come from the module the guard itself reads, so this measures the real numbers
// rather than a copy. Untyped on purpose, like the sibling #484 pin: the module is plain JS because
// docker compose and the setup scripts execute it directly.
// @ts-expect-error - plain-JS helper shared with the compose scripts
import { e2ePorts, serverTestPorts } from '../../../../scripts/stack-offset.mjs'

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
