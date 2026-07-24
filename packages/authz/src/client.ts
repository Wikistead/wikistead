import { OpenFgaClient } from '@openfga/sdk'

export function makeFga(): OpenFgaClient {
  return new OpenFgaClient({
    apiUrl: process.env.OPENFGA_API_URL ?? 'http://localhost:8080',
    storeId: process.env.OPENFGA_STORE_ID!,
    authorizationModelId: process.env.OPENFGA_MODEL_ID,
  })
}

// #500 follow-up: @openfga/sdk 0.8.1 changed check()/read() to return `PromiseResult<T> = Promise<CallResult<T>>`
// where `CallResult<T> = T & { $response: AxiosResponse<T> }`. That intersection is heavy enough that TS bails
// to `any` when it has to infer an INLINE `.then()` / array-callback parameter through it (`await` sidesteps
// the inference), so the exact same FGA helper types cleanly in one test file and silently degrades to `any`
// in another — a latent trap that surfaced as a wall of TS7006 `implicitly any` errors across the FGA test
// helpers. Nothing in the repo ever reads `$response`. We add clean call signatures (response minus the dead
// `$response`) as the FIRST members of an intersection with the original client: overload resolution picks the
// clean signature so callbacks infer the real response type, while the trailing `& OpenFgaClient` keeps the
// value assignable wherever an `OpenFgaClient` is expected. One source fix pins every current AND future call
// site instead of annotating each callback (and leaving the same-shaped, currently-green ones fragile).
type CleanCall<F> = F extends (...args: infer A) => Promise<infer R>
  ? (...args: A) => Promise<R extends { $response: unknown } ? Omit<R, '$response'> : R>
  : F
type Fga = {
  check: CleanCall<OpenFgaClient['check']>
  read: CleanCall<OpenFgaClient['read']>
} & OpenFgaClient

// Singleton for use in server and collab. Both read the same env vars.
export const fgaClient: Fga = makeFga()

// #500: the SDK client applies authorizationModelId to check() but NOT to server-side batchCheck;
// batchCheck callers must pass it explicitly. One source of truth.
export const fgaModelId = (): string | undefined => process.env.OPENFGA_MODEL_ID
