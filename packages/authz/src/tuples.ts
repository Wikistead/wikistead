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
