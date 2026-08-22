// #893 / ADR-011: a licence scan that read nothing must not say everything is permissive.
//
// This gate is the legal precondition of the dual licensing, and it had six ways to exit 0 having
// judged no package at all. `pnpm` missing from PATH, a corrupt store, an unreadable lockfile and an
// over-large output all threw; the catch turned the throw into an empty string, the empty string was
// read as "there are no dependencies", and the build went green. A well-formed `{}`, and a tree of
// nothing but our own packages, reached the same success line by a different road.
//
// The shape is #719's — a walk that finds nothing is not a pass — wearing the most expensive hat in
// the tree, because the sentence it printed was a statement about what may be distributed.
//
// ⚠️ These drive the SHIPPED script as a process, with the environment bent one way at a time. Six
// separate bends rather than one: each of the six doors is closed by different code, and a single
// bend would prove only that the door it happened to open is shut (measured — one bend passed while
// three doors were still open).
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'

const REPO = join(import.meta.dirname, '../../../..')
const GATE = join(REPO, 'scripts/check-licenses.mjs')

/** Run the shipped gate, optionally with a bent PATH, and report both streams. */
function runGate(env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [GATE], {
    cwd: REPO,
    encoding: 'utf8',
    // ⚠️ BOTH streams. The gate reports its refusals on stderr and its success on stdout, so a helper
    // that captured only stdout would read every refusal as an empty success — the defect this file
    // is about, reproduced in the measuring instrument.
    env: { ...process.env, ...env },
  })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/**
 * A directory holding a fake `pnpm` that prints exactly what a test wants, put first on PATH.
 *
 * ⚠️ Two of the six doors cannot be reached by breaking the environment: `pnpm` answering with a
 * well-formed `{}`, and a tree of nothing but our own packages. Both parse and both iterate cleanly,
 * so only the tool's OUTPUT distinguishes them — measured, after a first version of this file drove
 * four doors and left those two open while reporting green.
 */
function withFakePnpm(stdout: string): { PATH: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'license-gate-893-'))
  const shim = join(dir, 'pnpm')
  writeFileSync(shim, `#!/bin/sh\ncat <<'JSON'\n${stdout}\nJSON\n`)
  chmodSync(shim, 0o755)
  return { PATH: `${dir}${delimiter}${process.env.PATH}`, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('#893 the licence gate says how many dependencies it judged', () => {
  it('passes on this repository, and names the count', () => {
    const { code, out } = runGate()
    expect(code, out).toBe(0)
    // Not "OK": the number is the evidence. A run that prints OK without one is the defect.
    const n = /(\d+) production dependencies judged/.exec(out)
    expect(n, `the success line must carry the count — got: ${out.trim()}`).toBeTruthy()
    expect(Number(n![1]), 'this repository has production dependencies').toBeGreaterThan(100)
    console.error(`#893: the gate judged ${n![1]} production dependencies`)
  })

  it('⚠️ refuses when the tool is not there, instead of reporting no dependencies', () => {
    // The costliest door: on a machine without `pnpm` the old gate printed "no production
    // dependencies to scan" and passed. A release could be cut from a run that checked nothing.
    const { code, out } = runGate({ PATH: '/nonexistent' })
    expect(code, out).toBe(1)
    expect(out).toMatch(/could not read the dependency licenses|answered with nothing/)
    // And it must say WHY. `stdio` used to send stderr to `ignore`, so the operator could not tell a
    // clean tree from broken tooling.
    expect(out, 'the refusal names ADR-011, so the reader knows what is at stake').toMatch(/ADR-011/)
  })

  it('⚠️ refuses a well-formed EMPTY answer, which parses and iterates cleanly', () => {
    // The door a reader would not think to look for: `{}` is valid JSON, the loop over it completes
    // without error, and the old code fell straight through to "all production dependencies are
    // permissive" on the strength of having examined none.
    const { PATH, cleanup } = withFakePnpm('{}')
    try {
      const { code, out } = runGate({ PATH })
      expect(code, out).toBe(1)
      expect(out).toMatch(/judged 0 dependencies/)
      expect(out).not.toMatch(/all production dependencies are permissive/)
    } finally { cleanup() }
  })

  it('⚠️ and refuses when every package listed is one of ours', () => {
    // Our own workspace packages are skipped by design — they are private and not a distribution
    // concern. But skipped is not judged: a run that skipped everything has asked nobody the question.
    const onlyOurs = JSON.stringify({ MIT: [{ name: '@wikistead/server', versions: ['0.0.0'] }, { name: 'wikistead', versions: ['0.0.0'] }] })
    const { PATH, cleanup } = withFakePnpm(onlyOurs)
    try {
      const { code, out } = runGate({ PATH })
      expect(code, out).toBe(1)
      expect(out).toMatch(/judged 0 dependencies/)
      // The refusal distinguishes the two, so an operator can tell "nothing came back" from
      // "everything that came back was ours".
      expect(out).toMatch(/2 package\(s\) skipped as our own/)
    } finally { cleanup() }
  })

  it('a real package in the fake answer is judged, so the shim itself is not the reason it fails', () => {
    // ⚠️ The green path for the two cases above: without this, a shim that produced garbage would make
    // them pass for the wrong reason, and the pin would be measuring its own scaffolding.
    const oneReal = JSON.stringify({ MIT: [{ name: 'left-pad', versions: ['1.3.0'] }] })
    const { PATH, cleanup } = withFakePnpm(oneReal)
    try {
      const { code, out } = runGate({ PATH })
      expect(code, out).toBe(0)
      expect(out).toMatch(/1 production dependencies judged/)
    } finally { cleanup() }
  })

  it('and its refusal never claims the dependencies were permissive', () => {
    const { code, out } = runGate({ PATH: '/nonexistent' })
    expect(code).toBe(1)
    // The old message did exactly this, in the "no dependencies" wording. The point of the ticket is
    // that silence about a scan is not a verdict about a tree.
    expect(out).not.toMatch(/all production dependencies are permissive/)
  })
})
