import type { OpenFgaClient, TupleKey, TupleKeyWithoutCondition } from '@openfga/sdk'

export interface TupleInput {
  user: string
  relation: string
  object: string
  // Omit for permanent (non-expiring) share links.
  // Provide for time-bounded links: context must include expires_at (ISO 8601).
  condition?: {
    name: string
    context: Record<string, unknown>
  }
}

// #578 (review rejection 2026-08-05): FGA's own validation text reached the admin's screen verbatim —
// "FGA API Validation Error: post write : Error cannot delete a tuple which does not exist: user:
// 'user:89e7…', relation: 'viewer', object: 'space:demo_space'". That is internal implementation, it
// names the model's relations rather than anything the reader chose, and Fastify forwards a thrown
// error's `statusCode` and `message` as the response. Every tuple write in the product goes through the
// two helpers below, so the boundary is here: the cause is still LOGGED in full (the original is kept
// as `cause`), and what leaves the process is a code a surface can translate.
//
// This is the shape #606 used for `already_member`: the server names the refusal, the client picks the
// sentence.
//
// CORRECTION (#622 review): the first version of this comment said "nothing in the tree branches on FGA's
// message text (checked)". That was wrong — SEVEN places did, and a shallow grep missed the ones that
// built the phrase in a variable. Four were converted with #578; three more (`syncPageParentTuple`,
// `trashPage`, `restorePage`) survived as UNREACHABLE branches, silently breaking the idempotent retries
// their comments promise. They read `isAlreadyConverged` now. Anything added later must do the same:
// replacing the prose here makes every substring match dead code, not a compile error.
function asDomainError(err: unknown, op: 'write' | 'delete'): unknown {
  const status = (err as { statusCode?: number })?.statusCode
  if (status !== 400) return err // not a validation refusal — a transport or auth failure stays itself
  const raw = String((err as Error)?.message ?? '')
  return Object.assign(new Error(`the permission store refused this ${op}`), {
    statusCode: 500, // the CALLER sent nothing invalid: a rejected tuple set is our bug, not their request
    code: 'authz_write_refused',
    // Several callers legitimately treat "delete a tuple that is gone" / "write one that is there" as
    // CONVERGENCE rather than failure (the share-link revoke sweep, the group-sync mirror). They used to
    // read FGA's sentence to tell that case apart; replacing the sentence would have broken them
    // silently, so the fact moves onto the error as a FLAG. `alreadyConverged` is the question they were
    // really asking, asked once here instead of by four substring matches.
    // Both wordings, deliberately. FGA's current message happens to end with "...already existed or the
    // tuple to be deleted did not exist", which is what this matched; its OPENING clause says "cannot
    // delete a tuple which does not exist". Matching only the trailing form would flip every idempotent
    // revoke and unset-public to a 500 on the day that clause changes — silent here, loud three layers up.
    alreadyConverged: /do(es)? not exist|did not exist|already exist/i.test(raw),
    cause: err,
  })
}

/** Did a tuple write fail only because the store was already in the requested state? (#578) */
export function isAlreadyConverged(err: unknown): boolean {
  return (err as { alreadyConverged?: boolean })?.alreadyConverged === true
}

export async function writeTuples(fga: OpenFgaClient, tuples: TupleInput[]): Promise<void> {
  const writes: TupleKey[] = tuples.map((t) => ({
    user: t.user,
    relation: t.relation,
    object: t.object,
    ...(t.condition ? { condition: t.condition } : {}),
  }))
  try {
    await fga.write({ writes })
  } catch (err) {
    throw asDomainError(err, 'write')
  }
}

export async function deleteTuples(
  fga: OpenFgaClient,
  tuples: Pick<TupleInput, 'user' | 'relation' | 'object'>[],
): Promise<void> {
  const deletes: TupleKeyWithoutCondition[] = tuples.map((t) => ({
    user: t.user,
    relation: t.relation,
    object: t.object,
  }))
  try {
    await fga.write({ deletes })
  } catch (err) {
    throw asDomainError(err, 'delete')
  }
}

// Enumerate EVERY tuple on one object, paginated to completion. OpenFGA's Read answers one page
// (default 50) and silently truncates unless continuation_token is followed — any object-scoped
// read that feeds a decision must use this, never a bare fga.read (#553 review A: the bare form
// dropped tuple 51+ on real-sized spaces).
export async function readObjectTuples(
  fga: OpenFgaClient,
  object: string,
): Promise<{ user: string; relation: string; object: string }[]> {
  const out: { user: string; relation: string; object: string }[] = []
  let continuationToken: string | undefined
  do {
    const res = await fga.read({ object }, { ...(continuationToken ? { continuationToken } : {}) })
    for (const t of res.tuples ?? []) {
      const k = t.key
      if (k?.user && k.relation && k.object) out.push({ user: k.user, relation: k.relation, object: k.object })
    }
    continuationToken = res.continuation_token || undefined
  } while (continuationToken)
  return out
}

/**
 * ONE page of an object's tuples, with the position to resume from (#623).
 *
 * `readObjectTuples` above walks every page and hands back the whole set, which is right for the
 * sweeps that delete an object's grants but wrong for a list a screen reads: a page with a thousand
 * principals on it sent a thousand rows.
 *
 * ⚠️ The caller almost always filters by relation AFTER this returns — an object carries grants,
 * restrictions, share links and markers together — so a page can carry ZERO rows the caller wants
 * while more exist further on. The loop condition must be `nextCursor`, never "the page came back
 * empty". That is the same trap the SQL lists have when authorization filtering runs after the query.
 */
export async function readObjectTuplesPage(
  fga: OpenFgaClient,
  object: string,
  opts: { cursor?: string; pageSize?: number } = {},
): Promise<{ tuples: { user: string; relation: string; object: string }[]; nextCursor: string | null }> {
  // The page size is asked for explicitly rather than left to the store's default. Two reasons: the
  // bound then belongs to this product instead of to a server setting nobody here controls, and a test
  // can make the pages small enough to actually cross a boundary — measured, with the default the
  // whole object came back in one read and the paging was never exercised.
  const res = await fga.read({ object }, {
    ...(opts.cursor ? { continuationToken: opts.cursor } : {}),
    ...(opts.pageSize ? { pageSize: opts.pageSize } : {}),
  })
  const tuples: { user: string; relation: string; object: string }[] = []
  for (const t of res.tuples ?? []) {
    const k = t.key
    if (k?.user && k.relation && k.object) tuples.push({ user: k.user, relation: k.relation, object: k.object })
  }
  return { tuples, nextCursor: res.continuation_token || null }
}

// OpenFGA rejects writes above max_tuples_per_write (default 100) — batch deletes/writes that can
// exceed it go through this.
export const FGA_WRITE_CHUNK = 100

// Read all tuples whose object matches the given string, then delete them.
// Used when deleting a space or page to remove all FGA grants in one sweep
// (including any share_link tuples), preventing ghost authorization.
export async function deleteObjectTuples(fga: OpenFgaClient, object: string): Promise<void> {
  const keys: TupleKeyWithoutCondition[] = await readObjectTuples(fga, object)
  for (let i = 0; i < keys.length; i += FGA_WRITE_CHUNK) {
    // #619: this write was the one that skipped the boundary above — a sweep races anything else
    // deleting the same object, and the loser used to answer with FGA's own sentence (relation names
    // and object ids). Same translation as its two siblings; the convergence flag rides along, so a
    // caller that considers "already gone" a success can still say so.
    try {
      await fga.write({ deletes: keys.slice(i, i + FGA_WRITE_CHUNK) })
    } catch (err) {
      throw asDomainError(err, 'delete')
    }
  }
}

// #396: enumerate every tuple a USER principal holds on a given object TYPE (`page:` / `space:` —
// OpenFGA's Read supports a user + type-prefix query), paginated to completion. This is the
// user-origin listing the member-removal sweep needs: no reverse index and no full-resource scan.
// NOTE (multi-tenant): the shared store spans tenants, so the CALLER must filter the returned
// objects to its own tenant's resources before deleting anything.
export async function readUserTuplesByType(
  fga: OpenFgaClient,
  user: string,
  typePrefix: `${string}:`,
  /**
   * #788: narrow the read to ONE relation, in the store, instead of reading everything and filtering
   * here. The set is identical either way — the caller's filter and this predicate are the same
   * question — but the wide read carries the whole type home first.
   *
   * Measured on a store with 41,257 `user:*` page tuples (published pages, mostly): the retention
   * sweep spent 43 seconds reading them all to find the ONE marked `trashed`. That cost grows with
   * how much a workspace has PUBLISHED, which has nothing to do with how much it has thrown away.
   */
  relation?: string,
): Promise<{ user: string; relation: string; object: string }[]> {
  const out: { user: string; relation: string; object: string }[] = []
  let continuationToken: string | undefined
  do {
    const res = await fga.read(
      { user, object: typePrefix, ...(relation ? { relation } : {}) },
      { ...(continuationToken ? { continuationToken } : {}) },
    )
    for (const t of res.tuples ?? []) {
      const k = t.key
      if (k?.user && k.relation && k.object) out.push({ user: k.user, relation: k.relation, object: k.object })
    }
    continuationToken = res.continuation_token || undefined
  } while (continuationToken)
  return out
}
