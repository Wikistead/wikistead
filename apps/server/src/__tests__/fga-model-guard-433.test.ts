// #433: the FGA model-drift startup guard. Anti-tests: (1) the healed pin (ensure-test-model
// runs at the suite head) passes, (2) a model of a DIFFERENT shape in the same store is
// detected as drift (the silent-false-red case becomes an explicit config error), (3) a
// dead/unknown model id fails with the recovery message (store-recreated case), (4) missing
// pins fail explicitly, (5) production and the escape hatch skip without touching the
// network (bogus API URL proves no fetch). Real OpenFGA (isolated server-test stack).
import { describe, it, expect } from 'vitest'
import { OpenFgaClient } from '@openfga/sdk'
import { assertFgaModelFresh } from '../openfga-guard.js'

const BASE = {
  NODE_ENV: 'test',
  OPENFGA_API_URL: process.env.OPENFGA_API_URL,
  OPENFGA_STORE_ID: process.env.OPENFGA_STORE_ID,
  OPENFGA_MODEL_ID: process.env.OPENFGA_MODEL_ID,
} as NodeJS.ProcessEnv

const fast = { tries: 1, delayMs: 0 }

describe('assertFgaModelFresh (#433 drift guard)', () => {
  it('passes with the suite-healed pin (model.fga matches)', async () => {
    await expect(assertFgaModelFresh(BASE, fast)).resolves.toBeUndefined()
  })

  it('detects a different-shape model as DRIFT', async () => {
    // #876: the foreign model goes into a store of this test's own, not the shared one.
    //
    // It used to be written here, with a comment saying "immutable + additive — nothing else sees it
    // unless pinned". The second half is false, and the first half is why: models are additive, so the
    // last one written is the store's NEWEST, and every reader that does not pin an id gets that one.
    // Measured, on the shared stack:
    //
    //   after this test:  newest model = ['user']
    //   next ensure-test-model:  "pinned model … is STALE (model.fga moved) — rewriting"
    //
    // model.fga had not moved. The heal wrote a duplicate model, re-pinned the env file, and reported
    // a drift that did not happen — every server-suite run, which is how a real drift report becomes
    // one more line nobody reads. A hand-run `check` against the store answers
    // `validation_error: type 'tenant' not found`, which two sessions read as a broken stack (#870).
    //
    // The assertion does not need the shared store: what is under test is whether a pinned model
    // matches this checkout's model.fga, and a model in a throwaway store is just as foreign.
    const admin = new OpenFgaClient({ apiUrl: BASE.OPENFGA_API_URL! })
    const { id: storeId } = await admin.createStore({ name: `fga-model-guard-433-${Date.now().toString(36)}` })
    try {
      const scratch = new OpenFgaClient({ apiUrl: BASE.OPENFGA_API_URL!, storeId })
      const { authorization_model_id } = await scratch.writeAuthorizationModel({
        schema_version: '1.1',
        type_definitions: [{ type: 'user' }],
      } as never)
      await expect(
        assertFgaModelFresh({ ...BASE, OPENFGA_STORE_ID: storeId, OPENFGA_MODEL_ID: authorization_model_id }, fast),
      ).rejects.toThrow(/does not match this checkout's infra\/openfga\/model\.fga/)
    } finally {
      await new OpenFgaClient({ apiUrl: BASE.OPENFGA_API_URL!, storeId }).deleteStore().catch(() => {})
    }
  })

  // #876: and the shared store's newest model is still the real one when this file is done — the
  // property that makes an unpinned reader (an operator's curl, `model-drift`'s own newest-model read)
  // see a working store rather than one with a single type.
  it('leaves the shared store\'s newest model intact', async () => {
    const fga = new OpenFgaClient({ apiUrl: BASE.OPENFGA_API_URL!, storeId: BASE.OPENFGA_STORE_ID! })
    const { authorization_models } = await fga.readAuthorizationModels({ pageSize: 1 })
    const types = (authorization_models?.[0]?.type_definitions ?? []).map((t) => t.type)
    expect(types, 'the newest model in the shared store is a stub — an unpinned reader sees a broken store').toContain('tenant')
  })

  it('fails with the recovery message when the pinned model id is unreadable (store recreated)', async () => {
    await expect(
      assertFgaModelFresh({ ...BASE, OPENFGA_MODEL_ID: '01H5M3YCPQ3ZHWT1J8RYATM4WN' }, fast),
    ).rejects.toThrow(/could not be read from store .* Recover:/s)
  })

  it('fails explicitly when the pins are missing', async () => {
    await expect(
      assertFgaModelFresh({ ...BASE, OPENFGA_MODEL_ID: undefined }, fast),
    ).rejects.toThrow(/OPENFGA_STORE_ID \/ OPENFGA_MODEL_ID missing/)
  })

  it('skips in production and under the escape hatch — no network touched (bogus API URL)', async () => {
    const offline = { ...BASE, OPENFGA_API_URL: 'http://127.0.0.1:1' }
    await expect(
      assertFgaModelFresh({ ...offline, NODE_ENV: 'production' }, fast),
    ).resolves.toBeUndefined()
    await expect(
      assertFgaModelFresh({ ...offline, WIKISTEAD_SKIP_FGA_MODEL_GUARD: '1' }, fast),
    ).resolves.toBeUndefined()
  })
})
