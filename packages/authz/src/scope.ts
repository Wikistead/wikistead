import { AsyncLocalStorage } from 'node:async_hooks'

// #637 / ADR-216 §1: a per-request authorization restriction that reaches the primitives.
//
// Some restrictions cannot be answered at the request boundary. "This key may only reach space S" is
// one: reading a page and searching are the same route whatever space the page is in, so the answer has
// to travel to `check` / `filterAuthorized` / `checkRelation` — and those take a subject, a capability
// and a resource, not a request. There are 143 call sites. Threading an optional argument through them
// makes every forgotten call site fail OPEN, which is the wrong direction for the one mechanism whose
// entire job is to withhold.
//
// So the restriction is ambient, and the safety comes from a different place: a process may DECLARE that
// every authorization call in it happens inside a scope, and in a process that has declared it, a call
// with no scope THROWS. Forgetting is then a crash in the first request that exercises the path, not a
// silent widening discovered by whoever finds the data.
//
// `enterWith` is not used, and the reason matters more than the choice. It is not that it leaks across a
// keep-alive connection; it is that it DOES NOT PROPAGATE out of an async hook at all — measured on a
// real server, against real sockets. A reader who believes the reason is leakage will conclude that
// fixing the leak makes it usable, and write a pin that passes without measuring anything.
//
// One thing this mechanism is NOT: a completeness guarantee. Eleven raw FGA calls and one raw
// `listObjects` do not go through the primitives at all, so an ambient AND cannot reach them.
// Completeness rides the route allow-list — the set of routes a narrowed key is permitted to enter,
// which starts empty and grows one measured route at a time. The AND at the primitives is the SECOND
// layer. Stated in that order deliberately: the other order invites adding a route and trusting the
// primitives to catch what it does.

/** What a scope carries. `restriction: null` means "not restricted" — said, not merely absent. */
export interface AuthzScope {
  restriction: { spaces: ReadonlySet<string> } | null // mutable: filled in by authentication (see openAuthzScope)
  /** How to learn which space a page belongs to, when a restriction needs it. */
  spaceOfPage?: (pageId: string) => Promise<string | null>
  /**
   * #667 / ADR-221 §9: the API key this request arrived on, when it arrived on one.
   *
   * The audit ledger records WHO acted, and forty-nine call sites build that from the member's sub —
   * so every action a key took was filed as though its owner did it by hand, and after an incident
   * nothing separated the two. Correcting forty-nine sites is a list that grows a fiftieth, so the
   * substitution happens once, where the row is written (`enqueueAudit`), and this is how that one
   * place learns which requests are a key's.
   *
   * It rides the authz scope rather than a second ambient because the scope is already opened around
   * every request and filled by the same authentication step. A second mechanism would be a second
   * thing to forget.
   */
  apiKeyId?: string
}

/**
 * The scope for work that is not on behalf of a request: interval sweeps, outbox drains, detached
 * fills. They are unrestricted — and they say so, rather than arriving with no scope and being
 * indistinguishable from a request path where somebody forgot.
 */
export const SYSTEM_SCOPE: AuthzScope = Object.freeze({ restriction: null })

const storage = new AsyncLocalStorage<AuthzScope>()
let required = false

/** Run `fn` with `scope` in effect for everything it awaits. */
export function runInAuthzScope<T>(scope: AuthzScope, fn: () => T): T {
  return storage.run(scope, fn)
}

/**
 * Open an empty scope around the rest of a request, for the caller to fill in later.
 *
 * The request path cannot hand the restriction in at the moment the scope opens: working out what a
 * credential is confined to means reading the database, and the scope has to be in effect before that
 * read — and before everything after it. So the outermost hook opens an EMPTY container with a callback
 * (`done` is invoked from inside the storage context, which is how the rest of the chain inherits it),
 * and authentication writes into that container once it knows.
 *
 * A container that nobody fills is `restriction: null`, which is "unrestricted" — correct, because a
 * request with no narrowed credential is exactly that.
 */
export function openAuthzScope(run: () => void): void {
  storage.run({ restriction: null }, run)
}

/**
 * Record what the current request is confined to. Throws outside a scope: the caller is authentication,
 * which by construction runs inside the container opened above, so being outside one means the hook
 * order changed and the restriction would have been dropped on the floor.
 */
export function setAuthzRestriction(restriction: AuthzScope['restriction'], spaceOfPage?: AuthzScope['spaceOfPage']): void {
  const scope = storage.getStore()
  if (!scope) throw new Error('setAuthzRestriction outside an authorization scope — the outermost hook must open one first')
  scope.restriction = restriction
  if (spaceOfPage) scope.spaceOfPage = spaceOfPage
}

/**
 * #667 / ADR-221 §9: record that this request arrived on an API key.
 *
 * Called once, by authentication, beside `setAuthzRestriction` — the same step that already knows what
 * the credential is. Everything downstream reads it through `currentAuthzScope()`; nothing has to be
 * threaded through a call chain, which is what kept the audit actor wrong across forty-nine sites.
 */
export function setAuthzApiKey(keyId: string): void {
  const scope = storage.getStore()
  if (!scope) throw new Error('setAuthzApiKey outside an authorization scope — the outermost hook must open one first')
  scope.apiKeyId = keyId
}

/** The scope in effect, or null outside one. Callers that MUST have one use `requireAuthzScope`. */
export function currentAuthzScope(): AuthzScope | null {
  return storage.getStore() ?? null
}

/**
 * Declare that this process runs every authorization call inside a scope.
 *
 * Called from the serving entrypoint — `main.ts`, not `buildApp()`. A test harness and the collab
 * process both build an app; neither serves the request path this rule is about, and a declaration
 * inside `buildApp` would make them throw for a rule that does not apply to them.
 */
export function requireAuthzScope(): void {
  required = true
}

/** Test-only: undo the declaration so one suite's process-wide choice cannot leak into another. */
export function resetAuthzScopeRequirement(): void {
  required = false
}

/**
 * The scope an authorization primitive should use.
 *
 * In a process that has declared the requirement, being outside a scope is a programming error and
 * throws. In one that has not — collab, the CLI, a unit test — it answers "unrestricted", which is what
 * those processes have always done.
 */
export function authzScopeForCheck(): AuthzScope {
  const scope = storage.getStore()
  if (scope) return scope
  if (required) {
    throw new Error(
      'authz call outside an authorization scope: this process declared requireAuthzScope(), so every ' +
      'check must run inside runInAuthzScope() — wrap the entry point rather than removing the declaration',
    )
  }
  return SYSTEM_SCOPE
}
