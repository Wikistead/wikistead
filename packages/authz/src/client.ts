import { OpenFgaClient } from '@openfga/sdk'

export function makeFga(): OpenFgaClient {
  return new OpenFgaClient({
    apiUrl: process.env.OPENFGA_API_URL ?? 'http://localhost:8080',
    storeId: process.env.OPENFGA_STORE_ID!,
    authorizationModelId: process.env.OPENFGA_MODEL_ID,
  })
}

// Singleton for use in server and collab. Both read the same env vars.
export const fgaClient = makeFga()
