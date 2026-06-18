// Dev setup: create an OpenFGA store and write the authorization model from model.fga.
// Prints OPENFGA_STORE_ID=... and OPENFGA_MODEL_ID=... to stdout for .env update.
//
// Production: inject OPENFGA_STORE_ID and OPENFGA_MODEL_ID via an init job and
// Secret/ConfigMap. Do not run this script manually in production.
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OpenFgaClient } from '@openfga/sdk'
import { transformer } from '@openfga/syntax-transformer'

const dir = dirname(fileURLToPath(import.meta.url))

;(async () => {
  const apiUrl = process.env.OPENFGA_API_URL ?? 'http://localhost:8080'

  // Create store (or reuse existing one with the same name).
  const storeName = 'wikistead'
  // Dummy ULID: the client requires a valid ULID format even for store-listing calls.
  const fgaAnon = new OpenFgaClient({ apiUrl, storeId: '01H5M3YCPQ3ZHWT1J8RYATM4WN' })
  const { stores } = await (fgaAnon as any).api.listStores()
  const existing = (stores as any[] | undefined)?.find((s) => s.name === storeName)

  let storeId: string
  if (existing) {
    storeId = existing.id
    console.error(`reusing existing store: ${storeId}`)
  } else {
    const { id } = await (fgaAnon as any).api.createStore({ name: storeName })
    storeId = id
    console.error(`created store: ${storeId}`)
  }

  // Apply the authorization model (DSL → JSON).
  const dsl = await readFile(join(dir, 'model.fga'), 'utf8')
  const model = transformer.transformDSLToJSONObject(dsl)

  const fga = new OpenFgaClient({ apiUrl, storeId })
  const { authorization_model_id } = await fga.writeAuthorizationModel(model as any)
  console.error(`wrote model: ${authorization_model_id}`)

  // Output to stdout so callers can pipe: pnpm fga:bootstrap >> .env
  console.log(`OPENFGA_STORE_ID=${storeId}`)
  console.log(`OPENFGA_MODEL_ID=${authorization_model_id}`)
})().catch((err) => { console.error(err); process.exit(1) })
