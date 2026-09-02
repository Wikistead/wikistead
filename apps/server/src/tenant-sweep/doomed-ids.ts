import type { Sql } from 'postgres'
import type { DoomedIds } from './manifest-keys.js'

// ADR-252 §1 / #810: the glue between an operator's keep-list and the `DoomedIds` every collection
// function in this directory (`manifest-keys.ts`, `manifest-fga.ts`) consumes. "A keep-list is a
// decision an operator makes, not a shape the code guesses at" — this function does not decide WHICH
// spaces survive, only computes what follows once that decision is given.
//
// `pageIds` includes TRASHED pages (no `deleted_at IS NULL` filter): a trashed page's row, its
// tuples and its storage keys still exist until the hourly sweep physically removes them, and
// ADR-252's acceptance ("no rows, no tuples, no documents, no objects") does not carve out an
// exception for pages already in trash — reset is meant to leave nothing, not "nothing the trash
// sweep hadn't gotten to yet".
export async function computeDoomedIds(sql: Sql, tenantId: string, keepSpaceIds: readonly string[]): Promise<DoomedIds> {
  const spaces = await sql<{ id: string }[]>`
    SELECT id FROM spaces WHERE tenant_id = ${tenantId} AND id <> ALL(${keepSpaceIds})`
  const pages = await sql<{ id: string }[]>`
    SELECT id FROM pages WHERE tenant_id = ${tenantId}`
  return { spaceIds: spaces.map((r) => r.id), pageIds: pages.map((r) => r.id) }
}
