import { OpenFgaClient } from '@openfga/sdk'
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api'

// #987 / ADR-270 §3.2 / §4: every OpenFGA round-trip in this tree goes through `fgaClient` below (the
// server re-exports it and the collab process imports it), so THIS is the one place a span can cover
// all of them. The set names the SDK methods on the REQUEST path; the store/model management calls
// (`createStore`, `writeAuthorizationModel`, …) also leave the process but only at boot and setup,
// and are left out on purpose. A property not in the set is handed back untouched. With no
// OpenTelemetry SDK registered (every deployment that has not set OTEL_EXPORTER_OTLP_ENDPOINT) the
// API's tracer is a no-op proxy and the wrapper costs a closure.
//
// The span carries the METHOD only. ADR-270 §3.4 keeps tenant / user / object identifiers off every
// metric label, and the two reasons (one deployment's operator reading another tenant's traffic;
// unbounded cardinality) apply to a span attribute just as well — so `object`, `user` and the tuple
// bodies are never copied onto it.
const FGA_NETWORK_METHODS = new Set(['check', 'batchCheck', 'read', 'write', 'listObjects', 'listUsers', 'expand', 'readChanges'])

function traced<F extends (...args: never[]) => unknown>(method: string, fn: F): F {
  return ((...args: never[]) =>
    trace.getTracer('authz').startActiveSpan(`fga.${method}`, { kind: SpanKind.CLIENT, attributes: { 'fga.method': method } }, async (span) => {
      try {
        return await fn(...args)
      } catch (e) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) })
        throw e
      } finally {
        span.end()
      }
    })) as unknown as F
}

export function makeFga(): OpenFgaClient {
  return new OpenFgaClient({
    apiUrl: process.env.OPENFGA_API_URL ?? 'http://localhost:8080',
    storeId: process.env.OPENFGA_STORE_ID!,
    authorizationModelId: process.env.OPENFGA_MODEL_ID,
  })
}

// ADR-253 §3.7: `fgaClient` used to be built from `process.env` at MODULE LOAD — before boot
// resolution (ADR-253 §3.1-§3.6) has run, so nothing it decides could reach a value read before the
// boot code ran. The identifier and its call-site shape stay exactly as they were (§3.7's own
// argument: the name appears 3,552+ times, nearly all in tests, and turning it into a `getFga()`
// call would be a 3,400-line change to prove a point about call syntax) — only construction moves
// from eager to lazy, behind a Proxy that resolves the real client on first access instead of at
// import time.
let bound: { client: OpenFgaClient; modelId: string | undefined } | null = null

/**
 * ADR-253 §3.8: boot resolution calls this once, with the store/model it adopted. Whatever called
 * `fgaClient` or `fgaModelId()` before boot supplied it (there should be no such caller — every
 * caller is on a request path, §3.7's own reasoning) falls back to environment construction below,
 * exactly as `makeFga()` always has.
 */
export function supplyResolvedFga(client: OpenFgaClient, modelId: string | undefined): void {
  bound = { client, modelId }
}

// Test-only: let a suite return to the environment-constructed default between cases.
export function resetResolvedFgaForTests(): void {
  bound = null
}

function currentBinding(): { client: OpenFgaClient; modelId: string | undefined } {
  // Memoized, not reconstructed on every access: a fresh OpenFgaClient instance each call would
  // mean vi.spyOn(fgaClient, 'write') installs its mock on an instance nothing reads again.
  if (!bound) bound = { client: makeFga(), modelId: process.env.OPENFGA_MODEL_ID }
  return bound
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

// Singleton for use in server and collab. Lazy: resolves to whatever `supplyResolvedFga` last set,
// or the environment-constructed default otherwise. A full Proxy (not just `get`) so `vi.spyOn` and
// direct property assignment keep working exactly as they did against the eager singleton — those
// reflect onto the OWN client instance `currentBinding()` returns, which is memoized rather than
// rebuilt, so a mock installed on it stays installed for every later access in the same process.
export const fgaClient: Fga = new Proxy({} as Fga, {
  get(_target, prop, _receiver) {
    const client = currentBinding().client
    const value = Reflect.get(client, prop, client)
    if (typeof value !== 'function') return value
    const bound = value.bind(client)
    // #987: a NEW wrapper per access, deliberately — memoising it here would pin the wrapper to the
    // client instance a `vi.spyOn(fgaClient, 'check')` in a test later replaces the method on.
    return typeof prop === 'string' && FGA_NETWORK_METHODS.has(prop) ? traced(prop, bound) : bound
  },
  set(_target, prop, value) {
    return Reflect.set(currentBinding().client, prop, value)
  },
  has(_target, prop) {
    return Reflect.has(currentBinding().client, prop)
  },
  deleteProperty(_target, prop) {
    return Reflect.deleteProperty(currentBinding().client, prop)
  },
  defineProperty(_target, prop, descriptor) {
    return Reflect.defineProperty(currentBinding().client, prop, descriptor)
  },
  getOwnPropertyDescriptor(_target, prop) {
    const desc = Reflect.getOwnPropertyDescriptor(currentBinding().client, prop)
    // Proxy invariant: a non-configurable result must match the target's own descriptor for that
    // key, and the target here is the empty object passed to `new Proxy` — always configurable.
    if (desc) desc.configurable = true
    return desc
  },
  getPrototypeOf(_target) {
    // #109/#785-family test doubles build a stand-in via `Object.create(Object.getPrototypeOf(fgaClient))`
    // to keep every real method while overriding one — without this trap that reads the EMPTY target's
    // prototype (plain `Object.prototype`), losing every SDK method and failing with "fga.check is not
    // a function" the moment the double is used, which measured true the day this trap was missing.
    return Reflect.getPrototypeOf(currentBinding().client)
  },
  ownKeys(_target) {
    return Reflect.ownKeys(currentBinding().client)
  },
}) as Fga

// #500: the SDK client applies authorizationModelId to check() but NOT to server-side batchCheck;
// batchCheck callers must pass it explicitly. One source of truth — ADR-253 §3.5: reads what boot
// resolution adopted, falling back to the environment when nothing has resolved (a caller outside
// any boot, ADR-253 §3.7a).
export const fgaModelId = (): string | undefined => currentBinding().modelId
