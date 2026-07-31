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

export async function writeTuples(fga: OpenFgaClient, tuples: TupleInput[]): Promise<void> {
  const writes: TupleKey[] = tuples.map((t) => ({
    user: t.user,
    relation: t.relation,
    object: t.object,
    ...(t.condition ? { condition: t.condition } : {}),
  }))
  await fga.write({ writes })
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
  await fga.write({ deletes })
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

// OpenFGA rejects writes above max_tuples_per_write (default 100) — batch deletes/writes that can
// exceed it go through this.
export const FGA_WRITE_CHUNK = 100

// Read all tuples whose object matches the given string, then delete them.
// Used when deleting a space or page to remove all FGA grants in one sweep
// (including any share_link tuples), preventing ghost authorization.
export async function deleteObjectTuples(fga: OpenFgaClient, object: string): Promise<void> {
  const keys: TupleKeyWithoutCondition[] = await readObjectTuples(fga, object)
  for (let i = 0; i < keys.length; i += FGA_WRITE_CHUNK) {
    await fga.write({ deletes: keys.slice(i, i + FGA_WRITE_CHUNK) })
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
): Promise<{ user: string; relation: string; object: string }[]> {
  const out: { user: string; relation: string; object: string }[] = []
  let continuationToken: string | undefined
  do {
    const res = await fga.read({ user, object: typePrefix }, { ...(continuationToken ? { continuationToken } : {}) })
    for (const t of res.tuples ?? []) {
      const k = t.key
      if (k?.user && k.relation && k.object) out.push({ user: k.user, relation: k.relation, object: k.object })
    }
    continuationToken = res.continuation_token || undefined
  } while (continuationToken)
  return out
}
