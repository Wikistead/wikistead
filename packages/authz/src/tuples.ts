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

// Read all tuples whose object matches the given string, then delete them.
// Used when deleting a space or page to remove all FGA grants in one sweep
// (including any share_link tuples), preventing ghost authorization.
export async function deleteObjectTuples(fga: OpenFgaClient, object: string): Promise<void> {
  const { tuples } = await fga.read({ object })
  const keys = (tuples ?? [])
    .map((t) => t.key)
    .filter((k): k is TupleKeyWithoutCondition => !!k?.user && !!k?.relation && !!k?.object)
  if (keys.length > 0) await fga.write({ deletes: keys })
}
