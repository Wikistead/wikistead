import { describe, it, expect } from 'vitest'
import { assertProductionFgaPersistent } from '../openfga-guard.js'

// ADR-035: in production the API must refuse to boot against an in-memory OpenFGA datastore
// (authz tuples vanish on restart → authz collapse). authz-critical → tested both ways.
describe('assertProductionFgaPersistent', () => {
  it('throws in production with the in-memory engine (unset defaults to memory)', () => {
    expect(() => assertProductionFgaPersistent({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(
      /forbidden in production/,
    )
  })

  it('throws in production with engine=memory and names the fix', () => {
    expect(() =>
      assertProductionFgaPersistent({ NODE_ENV: 'production', OPENFGA_DATASTORE_ENGINE: 'memory' } as NodeJS.ProcessEnv),
    ).toThrow(/OPENFGA_DATASTORE_ENGINE=postgres/)
  })

  it('does NOT throw in production with engine=postgres (case-insensitive)', () => {
    expect(() =>
      assertProductionFgaPersistent({ NODE_ENV: 'production', OPENFGA_DATASTORE_ENGINE: 'Postgres' } as NodeJS.ProcessEnv),
    ).not.toThrow()
  })

  it('does NOT throw outside production (dev/e2e with memory is fine)', () => {
    expect(() =>
      assertProductionFgaPersistent({ NODE_ENV: 'development', OPENFGA_DATASTORE_ENGINE: 'memory' } as NodeJS.ProcessEnv),
    ).not.toThrow()
    expect(() => assertProductionFgaPersistent({} as NodeJS.ProcessEnv)).not.toThrow()
  })
})
