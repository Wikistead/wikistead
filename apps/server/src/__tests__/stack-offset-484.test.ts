// #484 slice 2 (pin gap #2): "the pin needs a test that two offsets don't collide." The three
// worktrees (a/b/c) run their suites against per-session isolated stacks selected by WKS_STACK_OFFSET.
// Isolation is only real if no two offsets — and no test stack vs the dev stack — ever share a host
// port. This is a PURE test of the port derivation (no containers), so it fails the moment a base or
// stride change reintroduces an overlap, before anyone debugs a phantom flake.
import { describe, it, expect } from 'vitest'
// repo-root script (same module server-test-up.mjs / the e2e scripts consume) — a plain .mjs with no
// types, so import it untyped rather than adding a .d.ts for a test-only infra helper.
// @ts-expect-error — untyped JS helper
import { serverTestPorts, e2ePorts, DEV_PORTS } from '../../../../scripts/stack-offset.mjs'

const OFFSETS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
// only the host-port fields (drop offset/project and any string fields)
const portsOf = (m: Record<string, unknown>): number[] =>
  Object.entries(m)
    .filter(([k, v]) => k !== 'offset' && typeof v === 'number')
    .map(([, v]) => v as number)

describe('#484 stack isolation — port maps never collide', () => {
  it('e2e offset 0 reproduces the shipped literals (byte-for-byte default)', () => {
    expect(e2ePorts(0)).toMatchObject({
      project: 'wikistead-e2e',
      pg: 5433, valkey: 6380, fgaHttp: 8090, fgaGrpc: 8091, meili: 7701, s3: 9002, smtp: 1026, mailpit: 8026,
      server: 4010, collab: 4110, web: 5180, webReal: 5181, issuer: 4444,
    })
  })

  it('server-test offset 0 reproduces the shipped literals', () => {
    expect(serverTestPorts(0)).toMatchObject({
      project: 'wikistead-server-test',
      pg: 5434, valkey: 6381, fgaHttp: 8092, fgaGrpc: 8093, meili: 7702, s3: 9003, smtp: 1027, mailpit: 8027,
    })
  })

  it('within each family, no two offsets share a port', () => {
    for (const fam of [serverTestPorts, e2ePorts]) {
      const all = OFFSETS.flatMap((o) => portsOf(fam(o)))
      expect(new Set(all).size, `${fam.name}: duplicate port across offsets`).toBe(all.length)
    }
  })

  it('an e2e stack never collides with a server-test stack (any offsets)', () => {
    for (const eo of OFFSETS) {
      const e = new Set(portsOf(e2ePorts(eo)))
      for (const so of OFFSETS) {
        const overlap = portsOf(serverTestPorts(so)).filter((p) => e.has(p))
        expect(overlap, `e2e#${eo} ∩ server-test#${so}`).toEqual([])
      }
    }
  })

  it('no test stack (any offset) lands on a dev host port', () => {
    const dev = new Set(Object.values(DEV_PORTS))
    for (const fam of [serverTestPorts, e2ePorts]) {
      for (const o of OFFSETS) {
        const overlap = portsOf(fam(o)).filter((p) => dev.has(p))
        expect(overlap, `${fam.name}#${o} ∩ dev`).toEqual([])
      }
    }
  })

  it('every isolated e2e offset gets its own compose project (separate volumes → separate FGA store)', () => {
    const names = OFFSETS.map((o) => e2ePorts(o).project)
    expect(new Set(names).size).toBe(names.length)
  })
})
