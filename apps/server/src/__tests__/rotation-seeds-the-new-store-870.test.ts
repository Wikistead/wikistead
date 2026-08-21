// #870: a rotation leaves the new permission store SEEDED, not just modelled.
//
// What went wrong, measured. `pnpm test` rotates the store when it is over #825's threshold: retire the
// fat one, bootstrap an empty one, write its ids to `.env.server-test.local`, then re-run the seeds. The
// caller loads that same file into its OWN process first (it has to — the offset lives there) and hands
// its `process.env` to every child, so after the bootstrap each child still carried
// `OPENFGA_STORE_ID` = the store the rotation had just retired. A real environment variable beats
// `--env-file` — that is the mechanism #484 relies on to keep a session on its own stack — so the
// freshly written file could not win the argument. The seed reported success against a store nobody
// would read again, and the new one was left with a model and no tuples.
//
// The tuple that goes missing is `user:dev-user member tenant:tenant_dev`, which the per-request
// membership seam (#471 / ADR-176) asks about for every principal. A store without it fails every
// authenticated request in three different voices:
//
//   401 unauthorized                      the API, from the seam itself
//   space creation is restricted          the create path — `space_creator` unions `tenant#member`
//   forbidden: not a member of this tenant collab's own gate, which re-implements the same rule
//
// None of them says "your test stack is unseeded", and the last one is the worst to read: it refuses
// the people it should admit, so it looks like an authorization change that went too far. Three
// sessions read it as a regression in whatever had just landed, four times in one day.
//
// ⚠️ These pins drive the SHIPPED rotation with a recording runner rather than a real stack. The
// alternative — rotating for real inside the suite — is the thing #825's own comment forbids: it takes
// the model id out from under the packages sharing this stack. The behaviour was verified once by hand
// against the real stack, both ways: before the fix the new store answered `allowed:false` for the seed
// tuple, after it `allowed:true`, from the same forced rotation.
import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
// @ts-expect-error — plain .mjs, deliberately not a TS module (#621 convention)
import { rotateStore, postBootstrapEnv, seedTuples, seedPresence, unseededMessage } from '../../../../scripts/server-test-store.mjs'

const RETIRED = { OPENFGA_STORE_ID: 'store_retired', OPENFGA_MODEL_ID: 'model_retired' }
const NEW = { storeId: 'store_new', modelId: 'model_new' }

type Step = { cmd: string; env: NodeJS.ProcessEnv }

/** Runs the real `rotateStore`, recording what each step would have been handed. */
function record(env: NodeJS.ProcessEnv = { ...RETIRED, PATH: '/usr/bin' }) {
  const steps: Step[] = []
  const written: { path: string; body: string }[] = []
  const runner = {
    run: (cmd: string, childEnv: NodeJS.ProcessEnv) => { steps.push({ cmd, env: childEnv }) },
    capture: (cmd: string, childEnv: NodeJS.ProcessEnv) => {
      steps.push({ cmd, env: childEnv })
      return `created store: ${NEW.storeId}\nOPENFGA_STORE_ID=${NEW.storeId}\nOPENFGA_MODEL_ID=${NEW.modelId}\n`
    },
    write: (path: string, body: string) => { written.push({ path, body }) },
  }
  const out = rotateStore({
    repo: '/repo',
    ports: { offset: 2, pg: 5634, valkey: 6581, fgaHttp: 8292, meili: 7902, s3: 9203, smtp: 1227, mailpit: 8227 },
    env,
    localEnvPath: '/repo/.env.server-test.local',
    runner,
  })
  return { steps, written, out }
}

const after = (steps: Step[]) => steps.slice(steps.findIndex((s) => s.cmd.includes('bootstrap.ts')) + 1)

describe('#870 a rotation seeds the store it just created', () => {
  it('every step after the bootstrap is told the NEW store, not the retired one', () => {
    const { steps } = record()
    const later = after(steps)
    expect(later.length, 'the seeds and the prune run after the bootstrap').toBeGreaterThanOrEqual(3)
    for (const step of later) {
      expect(step.env.OPENFGA_STORE_ID, `${step.cmd} was handed the retired store`).toBe(NEW.storeId)
      expect(step.env.OPENFGA_MODEL_ID, `${step.cmd} was handed the retired model`).toBe(NEW.modelId)
    }
  })

  it('the FGA seed in particular — the step whose absence empties the new store', () => {
    const seed = record().steps.find((s) => s.cmd.includes('openfga/seed.ts'))
    expect(seed, 'the rotation still seeds the permission store').toBeDefined()
    expect(seed!.env.OPENFGA_STORE_ID).toBe(NEW.storeId)
  })

  // The retirement happens BEFORE the new store exists, so it is the only step that legitimately
  // carries the old id — pinned so a fix that overrides everything uniformly is not mistaken for this.
  it('the retirement still runs against the store it is retiring', () => {
    const { steps } = record()
    const reset = steps.find((s) => s.cmd.includes('reset-test-store.ts'))
    expect(reset, 'the fat store is still retired first').toBeDefined()
    expect(reset!.env.OPENFGA_STORE_ID).toBe(RETIRED.OPENFGA_STORE_ID)
  })

  it('the new ids are written to the local env file as well', () => {
    const { written, out } = record()
    expect(out).toEqual(NEW)
    expect(written).toHaveLength(1)
    expect(written[0].body).toContain(`OPENFGA_STORE_ID=${NEW.storeId}`)
    expect(written[0].body).toContain(`OPENFGA_MODEL_ID=${NEW.modelId}`)
  })

  // The rule on its own, so the reason survives a refactor of the sequence above.
  it('a stale pin in the incoming environment is overridden, not merged around', () => {
    expect(postBootstrapEnv(RETIRED, NEW)).toMatchObject({
      OPENFGA_STORE_ID: NEW.storeId,
      OPENFGA_MODEL_ID: NEW.modelId,
    })
    // and an environment that carried no pin at all still names the new store
    expect(postBootstrapEnv({ PATH: '/usr/bin' }, NEW).OPENFGA_STORE_ID).toBe(NEW.storeId)
  })
})

// The safety valve. The rotation above is fixed, but a store can be emptied by other means, and the
// cost of finding out mid-suite is what this ticket measured. So the run asks first — of the tuples,
// because no single symptom covers the three voices an unseeded store speaks in.
describe('#870 the run refuses to start against an unseeded store', () => {
  const ENV = { OPENFGA_API_URL: 'http://fga', OPENFGA_STORE_ID: 'store_1', OPENFGA_MODEL_ID: 'model_1' }
  const TUPLES = [{ user: 'user:dev-user', relation: 'member', object: 'tenant:tenant_dev' }]
  const answering = (answers: Record<string, unknown>[]) => {
    const calls: Record<string, unknown>[] = []
    let i = 0
    const fetchImpl = async (_url: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body))
      return { json: async () => answers[Math.min(i++, answers.length - 1)] }
    }
    return { fetchImpl, calls }
  }

  it('a store that holds the seed passes', async () => {
    const { fetchImpl } = answering([{ allowed: true }])
    expect(await seedPresence({ env: ENV, tuples: TUPLES, fetchImpl })).toEqual({ verdict: 'present' })
  })

  it('a store that answers "no" is MISSING, and the message names the one command that fixes it', async () => {
    const { fetchImpl } = answering([{ allowed: false }])
    const presence = await seedPresence({ env: ENV, tuples: TUPLES, fetchImpl })
    expect(presence.verdict).toBe('missing')
    const said = unseededMessage(presence.missing, 2)
    expect(said).toContain('user:dev-user member tenant:tenant_dev')
    expect(said).toContain('WKS_STACK_OFFSET=2 pnpm setup:server-test')
    // …and it names all three voices, because a session that only knows one of them reads the other
    // two as a bug in whatever they just changed.
    expect(said).toContain('401')
    expect(said).toContain('space creation is restricted')
    expect(said).toContain('not a member of this tenant')
  })

  // ⚠️ Three answers, never two. A store whose newest model is a stub — the suite writes models of its
  // own — answers a check with `validation_error`, which is a different problem with a different fix.
  // Reading it as "unseeded" sends a session to re-seed a store that is not empty.
  it('a store that will not answer is UNKNOWN, not missing', async () => {
    const { fetchImpl } = answering([{ code: 'validation_error', message: "invalid relation: type 'tenant' not found" }])
    const presence = await seedPresence({ env: ENV, tuples: TUPLES, fetchImpl })
    expect(presence.verdict).toBe('unknown')
    expect(presence.why).toContain('validation_error')

    const thrown = { fetchImpl: async () => { throw new Error('ECONNREFUSED') } }
    expect((await seedPresence({ env: ENV, tuples: TUPLES, ...thrown })).verdict).toBe('unknown')
    // and a tree with no isolated stack at all is not a failure either
    expect((await seedPresence({ env: {}, tuples: TUPLES, fetchImpl })).verdict).toBe('unknown')
  })

  // ⚠️ The probe PINS the model id. Without it OpenFGA answers against whatever model is newest, and
  // the suite writes models of its own — an unpinned probe calls a healthy stack broken. Measured: the
  // first diagnostic recipe for this defect was unpinned, and it misled two sessions.
  it('the probe pins the model id', async () => {
    const { fetchImpl, calls } = answering([{ allowed: true }])
    await seedPresence({ env: ENV, tuples: TUPLES, fetchImpl })
    expect(calls[0].authorization_model_id).toBe('model_1')
  })

  // The expected set is read from the seed, not restated here: a copy would drift the first time
  // somebody added a tuple, and go quietly green about the one they added.
  it('what to look for comes from the seed script itself', () => {
    const found = seedTuples(resolve(import.meta.dirname, '../../../..')) as { user: string; relation: string; object: string }[]
    expect(found, 'the seed still declares its tuples in a shape this can read').toBeTruthy()
    expect(found).toContainEqual({ user: 'user:dev-user', relation: 'member', object: 'tenant:tenant_dev' })
    expect(found.length, 'the whole first block, not one hand-picked line').toBeGreaterThan(3)
    expect(seedTuples('/nowhere'), 'an unreadable seed is not an empty seed').toBeNull()
  })
})
