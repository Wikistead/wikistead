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

  it('detects a different-shape model in the same store as DRIFT', async () => {
    // Write a minimal foreign model (immutable + additive — nothing else sees it unless pinned).
    const fga = new OpenFgaClient({
      apiUrl: BASE.OPENFGA_API_URL!,
      storeId: BASE.OPENFGA_STORE_ID!,
    })
    const { authorization_model_id } = await fga.writeAuthorizationModel({
      schema_version: '1.1',
      type_definitions: [{ type: 'user' }],
    } as never)
    await expect(
      assertFgaModelFresh({ ...BASE, OPENFGA_MODEL_ID: authorization_model_id }, fast),
    ).rejects.toThrow(/does not match this checkout's infra\/openfga\/model\.fga/)
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
