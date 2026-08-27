// #433 → ADR-253 §8a: this file used to test `assertFgaModelFresh`, which read
// OPENFGA_STORE_ID/OPENFGA_MODEL_ID from the environment, required both, and skipped itself
// entirely in production. It now tests `resolveFgaForBoot`, which finds (or creates) the store and
// reconciles the model itself — every one of the six cases below is that same function's
// "Becomes:" per ADR-253 §8a. Real OpenFGA + real DB (isolated server-test stack).
import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { OpenFgaClient } from '@openfga/sdk'
import { pool } from '../db/pool.js'
import { resolveFgaForBoot } from '../openfga-guard.js'
import { writeWitness } from '../openfga-resolve.js'

const BASE = {
  NODE_ENV: 'test',
  OPENFGA_API_URL: process.env.OPENFGA_API_URL,
  OPENFGA_STORE_ID: process.env.OPENFGA_STORE_ID,
  OPENFGA_MODEL_ID: process.env.OPENFGA_MODEL_ID,
} as NodeJS.ProcessEnv

const fast = { tries: 1, delayMs: 0 }

function capture() {
  const lines: string[] = []
  return { lines, log: (line: string) => lines.push(line) }
}

const admin = new OpenFgaClient({ apiUrl: BASE.OPENFGA_API_URL! })
const scratchStores: string[] = []
afterAll(async () => {
  for (const storeId of scratchStores) {
    await new OpenFgaClient({ apiUrl: BASE.OPENFGA_API_URL!, storeId }).deleteStore().catch(() => {})
  }
})

// Every test starts from an unwitnessed deployment and states what it needs itself (an explicit id,
// or a pre-written witness) — the same discipline openfga-resolve-826.test.ts uses, and for the same
// reason: a leftover witness from one test silently changes which branch the next one takes.
afterEach(async () => {
  await pool`DELETE FROM openfga_store_binding`.catch(() => {})
})

async function scratchStoreWithForeignModel(): Promise<string> {
  const { id: storeId } = await admin.createStore({ name: `fga-model-guard-433-${Date.now().toString(36)}-${scratchStores.length}` })
  scratchStores.push(storeId)
  await new OpenFgaClient({ apiUrl: BASE.OPENFGA_API_URL!, storeId }).writeAuthorizationModel({
    schema_version: '1.1',
    type_definitions: [{ type: 'user' }],
  } as never)
  return storeId
}

describe('resolveFgaForBoot (#433 drift guard, ADR-253 §8a)', () => {
  it('its supplier changes even though its assertion survives: adopts the pinned, matching store — resolves, and the boot line names both as found', async () => {
    const { lines, log } = capture()
    await expect(resolveFgaForBoot(BASE, pool, { ...fast, log })).resolves.toBeUndefined()
    expect(lines[0]).toMatch(new RegExp(`store=${BASE.OPENFGA_STORE_ID} \\(given\\), model=.* \\(found\\)`))
  })

  it('resolution supplies what OPENFGA_STORE_ID no longer needs to name — found by name instead of given', async () => {
    const { lines, log } = capture()
    const { OPENFGA_STORE_ID, ...withoutExplicitId } = BASE
    await expect(resolveFgaForBoot(withoutExplicitId as NodeJS.ProcessEnv, pool, { ...fast, log })).resolves.toBeUndefined()
    expect(lines[0]).toMatch(new RegExp(`store=${OPENFGA_STORE_ID} \\(found\\), model=.* \\(found\\)`))
  })

  it('resolution supplies what the pin omits, and refuses when resolution itself cannot', async () => {
    // A witness naming a store this boot would NOT use (the real, live, differently-named-by-nothing
    // store still wins the name search) is exactly the case #433's old "missing pins" fell into by
    // accident — except now it is named precisely: a mismatch, not a silent recreate. The SDK
    // validates storeId as a ULID client-side before any network call, so the fabricated "gone"
    // witness must still be shaped like one — a fake id, not a malformed one.
    const goneStoreId = '01HZZZZZZZZZZZZZZZZZZZZZZZ'
    await writeWitness(pool, goneStoreId)
    const { OPENFGA_STORE_ID: _unused, ...withoutExplicitId } = BASE
    await expect(resolveFgaForBoot(withoutExplicitId as NodeJS.ProcessEnv, pool, fast)).rejects.toThrow(
      new RegExp(`bound to store ${goneStoreId}.*pointed at store`, 's'),
    )
  })

  it('the guard runs in production, with the escape hatch still measured as an escape hatch', async () => {
    // #433's old guard skipped itself entirely in production (no model verification ever ran there)
    // and skipped again under the escape hatch — both proven by an unreachable API URL never being
    // touched. ADR-253 removes the production skip: a boot in production that cannot reach OpenFGA at
    // all must now fail exactly like any other environment would. The escape hatch is narrower than
    // that — §3.8/§8③④ only ever let it skip the read-back-after-write check — so it must NOT also
    // paper over "OpenFGA is unreachable"; proven by asking it to, with a URL nothing answers.
    const offline = { ...BASE, OPENFGA_API_URL: 'http://127.0.0.1:1' }
    await expect(resolveFgaForBoot({ ...offline, NODE_ENV: 'production' }, pool, fast)).rejects.toThrow()
    await expect(resolveFgaForBoot({ ...offline, WIKISTEAD_SKIP_FGA_MODEL_GUARD: '1' }, pool, fast)).rejects.toThrow()
  })

  it('an OPENFGA_MODEL_ID naming something else than what was adopted: reported on the boot line, not refused', async () => {
    // ADR-253 §3.1 (ruled 2026-08-21): the pin never changes what is adopted. #433's old guard threw
    // FATAL here (store-recreated case) — the new one adopts the real newest model regardless and
    // states the mismatch, because enforcing a stale expectation is the thing that used to make a
    // routine store-recreate an outage.
    const bogusModelId = '01H5M3YCPQ3ZHWT1J8RYATM4WN'
    const { lines, log } = capture()
    await expect(
      resolveFgaForBoot({ ...BASE, OPENFGA_MODEL_ID: bogusModelId }, pool, { ...fast, log }),
    ).resolves.toBeUndefined()
    expect(lines[0]).toMatch(new RegExp(`\\(found\\) \\(OPENFGA_MODEL_ID expected ${bogusModelId}, not adopted\\)`))
  })

  it('the newest model differs from this checkout\'s DSL: written and adopted, and the boot line says so — no longer FATAL', async () => {
    // #876/#751: the foreign model goes into a scratch store, never the shared one — see
    // openfga-resolve-826.test.ts's fixture comment for why a throwaway store is just as foreign as a
    // hand-crafted one for what this test actually exercises.
    const storeId = await scratchStoreWithForeignModel()
    const { lines, log } = capture()
    await expect(
      resolveFgaForBoot({ ...BASE, OPENFGA_STORE_ID: storeId, OPENFGA_MODEL_ID: undefined }, pool, { ...fast, log }),
    ).resolves.toBeUndefined()
    expect(lines[0]).toMatch(new RegExp(`store=${storeId} \\(given\\), model=.* \\(written\\)`))
  })

  it('§8③④: the skip-flag logs itself — only when it actually skipped something', async () => {
    const wrote = await scratchStoreWithForeignModel()
    const skipped = capture()
    await resolveFgaForBoot(
      { ...BASE, OPENFGA_STORE_ID: wrote, OPENFGA_MODEL_ID: undefined, WIKISTEAD_SKIP_FGA_MODEL_GUARD: '1' },
      pool,
      { ...fast, log: skipped.log },
    )
    expect(skipped.lines[0], 'a write under the flag must say so').toMatch(/WIKISTEAD_SKIP_FGA_MODEL_GUARD=1: this write was NOT verified/)

    // Each call below binds a DIFFERENT explicit store — without clearing the witness in between, the
    // next call's explicit id would conflict with the one this test just bound (ADR-253 §3.4's
    // witness-mismatch refusal), which is a different scenario than the one under test here.
    await pool`DELETE FROM openfga_store_binding`
    const verified = capture()
    const alsoWrote = await scratchStoreWithForeignModel()
    await resolveFgaForBoot(
      { ...BASE, OPENFGA_STORE_ID: alsoWrote, OPENFGA_MODEL_ID: undefined },
      pool,
      { ...fast, log: verified.log },
    )
    expect(verified.lines[0], 'a write that was actually verified must not claim otherwise').not.toMatch(/NOT verified/)

    await pool`DELETE FROM openfga_store_binding`
    // BASE's model already matches (suite-healed) — nothing was written, so the flag has nothing to
    // skip and must say nothing about it even when set.
    const flaggedNoWrite = capture()
    await resolveFgaForBoot({ ...BASE, WIKISTEAD_SKIP_FGA_MODEL_GUARD: '1' }, pool, { ...fast, log: flaggedNoWrite.log })
    expect(flaggedNoWrite.lines[0], 'the flag is silent when there was nothing to skip').not.toMatch(/NOT verified/)
  })

  // #876: unaffected by the ADR-253 rewrite above — still reads the shared store directly, and still
  // exists to prove the drift scenarios above leave the shared store's real, working model alone.
  it('leaves the shared store\'s newest model intact', async () => {
    const fga = new OpenFgaClient({ apiUrl: BASE.OPENFGA_API_URL!, storeId: BASE.OPENFGA_STORE_ID! })
    const { authorization_models } = await fga.readAuthorizationModels({ pageSize: 1 })
    const types = (authorization_models?.[0]?.type_definitions ?? []).map((t) => t.type)
    expect(types, 'the newest model in the shared store is a stub — an unpinned reader sees a broken store').toContain('tenant')
  })
})
