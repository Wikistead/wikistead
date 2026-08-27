#!/usr/bin/env node
// #755 (A's / recommendation): what the OTHER three surfaces cost.
//
// The measurement that closed decision ② asked only about `link-status`, and the answer there was
// "tens of milliseconds" — the width became a screenful. A's note said plainly that the other three
// are not bound by that: the title dictionary, the sidebar tree and search stage 2 each ask at their
// OWN width, and whether ADR-243 is worth building is decided by those, not by link-status.
//
// ⚠️ A SCRIPT, not a test. Wall-clock depends on the machine, and a number that depends on the
// machine is not an assertion. It changes no model and no product code.
//
// ⚠️ WIDTH MEANS SOMETHING DIFFERENT ON EACH SURFACE, so each row says which:
//   title dictionary  ids confirmed in one fill (cap 2000, sliced 200, ONE lane — #541 gave up
//                     throughput on purpose so interactive checks interleave)
//   whole-space TREE every row in the space, one pass at four lanes. ⚠️ CORRECTED 2026-08-23: an
//                     earlier revision of this file called this "the sidebar tree, no cap and no
//                     budget, the surface the first paint waits on". THE MEMBER SIDEBAR NO LONGER
//                     TAKES THIS PATH — #623 / ADR-220 §6.3 moved it branch-by-branch
//                     (`useLazyPageTree`, BRANCH_PAGE_LIMIT 100 / max 500) and retired both the
//                     whole-space read and #541's `?first=40`. The one remaining caller of
//                     `listPages` is the GUEST share-link shell, which is the harder case:
//                     ADR-028's instant revoke means a share_link subject is excluded from the
//                     tree-confirm cache ON PURPOSE (`cacheable` in pages.ts), so every open pays
//                     the full width cold. Measured below at member AND guest subjects.
//   sidebar spaces    spaces on the page — and FIVE filterAuthorized passes run per page, in
//                     parallel, because the row carries a capability (#710)
//   search stage 2    candidates Meilisearch handed over for the authoritative confirm
//
// ⚠️ CONDITIONS BELONG BESIDE THE NUMBERS. This ticket carries four different "per id" figures
// (17 / 5-6 / 70 / 5.3-6.5 ms), all from different store states, and three times somebody quoted one
// as if it were comparable. The run prints its tuple count. Only RATIOS travel.
// ── WHAT IT MEASURED, 2026-08-22, so the next reader has the shape without re-running ──────────────
//
// Store rotated immediately before (18 tuples, 2,140 with the fixture). Second run taken: the first
// overlapped the previous run's cleanup and every row came out roughly twice as slow, which is its
// own lesson about quoting a single run.
//
//   title dictionary   2,000 ids   9,747 ms   4.87 ms/id     ← the width #534 names
//   sidebar tree          60 spaces   43 ms   0.14 ms/check  ← five parallel passes, cheapest of all
//   search stage 2       200 cands   974 ms   4.87 ms/id
//
// The per-id cost is the same on all three; only the WIDTH differs, and only the dictionary's width
// is large. The sidebar is cheap because a space relation has neither the union nor the recursion
// `page#view` carries.
//
// ⚠️ AND ONE THING THE CODE SAYS THAT THE MEASUREMENT DOES NOT. `pages.ts` explains the drop from
// four lanes to one with "an idle box still completes a full 2000-id confirm in ~1-2s". On an idle
// box, rotated store, it took 9.7 seconds. The confirm's budget is 2,000 ms, so the run stops early
// and the dictionary returns `degraded: true`. ⚠️ HOW early is NOT measured here: the budget is
// checked BETWEEN slices of 200, so the stop lands on a slice boundary, and dividing the budget by a
// per-id average does not give the answer (an earlier note here said "roughly 400" that way). That is not
// broken — a partial dictionary is under-disclosure and the links fill in on the next fetch — but the
// sentence the lane count was chosen on describes something else.
//
import postgres from 'postgres'
import { fgaClient, writeTuples, deleteTuples, filterAuthorized } from '@wikistead/authz'

const TENANT = 'tenant_dev'
const STAMP = Date.now()
const USER = 'user:dev-user'
const GUEST = `share_link:ms755-link-${STAMP}`

const sql = postgres(process.env.DATABASE_ADMIN_URL)
const tuples = []
const spaces = []
const pages = []
const ms = async (fn) => { const t = process.hrtime.bigint(); const v = await fn(); return [Number(process.hrtime.bigint() - t) / 1e6, v] }

const countTuples = async () => {
  let n = 0, tok
  do {
    const r = await fgaClient.read({}, { pageSize: 100, continuationToken: tok })
    n += (r.tuples ?? []).length
    tok = r.continuation_token || r.continuationToken
  } while (tok && n < 100_000)
  return n
}

try {
  console.log(`store: ${await countTuples()} tuple(s) before this run`)

  // ── one space with many pages: the dictionary's and search's width ──────────────────────────────
  const space = `ms755-${STAMP}`
  await sql`INSERT INTO spaces (id, tenant_id, name) VALUES (${space}, ${TENANT}, 'measure surfaces 755')`
  spaces.push(space)
  tuples.push({ user: `tenant:${TENANT}`, relation: 'tenant', object: `space:${space}` },
              { user: USER, relation: 'manager', object: `space:${space}` },
              // A space-scoped share link, the one principal the tree-confirm cache excludes by design.
              // `space#viewer` accepts [share_link] (model.fga) — checked in the direct type list, not
              // inferred from the relation existing.
              { user: GUEST, relation: 'viewer', object: `space:${space}` })
  const PAGE_N = 2000
  for (let i = 0; i < PAGE_N; i++) {
    const id = `${space}-p${i}`
    pages.push(id)
    tuples.push({ user: `space:${space}`, relation: 'space', object: `page:${id}` })
  }
  // Insert the page rows in one statement per 500 so the fixture does not dominate the run.
  for (let i = 0; i < pages.length; i += 500) {
    const chunk = pages.slice(i, i + 500)
    await sql`INSERT INTO pages ${sql(chunk.map((id) => ({ id, tenant_id: TENANT, space_id: space, title: id })), 'id', 'tenant_id', 'space_id', 'title')}`
  }
  for (let i = 0; i < tuples.length; i += 100) await writeTuples(fgaClient, tuples.slice(i, i + 100))

  // ── many spaces: the sidebar's width ────────────────────────────────────────────────────────────
  const SPACE_N = 60
  const sidebarSpaces = []
  for (let i = 0; i < SPACE_N; i++) {
    const id = `ms755s-${STAMP}-${i}`
    sidebarSpaces.push(id); spaces.push(id)
    await sql`INSERT INTO spaces (id, tenant_id, name) VALUES (${id}, ${TENANT}, ${id})`
    tuples.push({ user: `tenant:${TENANT}`, relation: 'tenant', object: `space:${id}` },
                { user: USER, relation: 'manager', object: `space:${id}` })
  }
  const tail = tuples.slice(tuples.length - SPACE_N * 2)
  for (let i = 0; i < tail.length; i += 100) await writeTuples(fgaClient, tail.slice(i, i + 100))

  console.log(`store: ${await countTuples()} tuple(s) after the fixture\n`)

  // ── title dictionary: the confirm pass, at the widths it actually uses ───────────────────────────
  // One lane and 200-id slices, exactly as `confirmInSlices` runs it (pages.ts SLICE=200, lanes=1).
  console.log('title dictionary — confirm pass, 200-id slices, ONE lane (the shape #541 chose)')
  for (const width of [200, 500, 1000, 2000]) {
    const ids = pages.slice(0, width)
    const [t] = await ms(async () => {
      for (let i = 0; i < ids.length; i += 200) await filterAuthorized(fgaClient, USER, 'view', ids.slice(i, i + 200), undefined, 'page', 1)
    })
    console.log(`  ${String(width).padStart(4)} ids  ${t.toFixed(0).padStart(6)} ms  ${(t / width).toFixed(2)} ms/id`)
  }

  // ── sidebar tree: FIVE passes per page of spaces, in parallel (#710) ─────────────────────────────
  console.log('\nsidebar tree — 5 capability passes per page of spaces, in parallel (enrichSpaceRows)')
  for (const width of [10, 30, 60]) {
    const ids = sidebarSpaces.slice(0, width)
    const [t] = await ms(() => Promise.all(
      ['view', 'edit', 'manage', 'moderate', 'manageAccess'].map((rel) =>
        filterAuthorized(fgaClient, USER, rel, ids, undefined, 'space'))))
    console.log(`  ${String(width).padStart(4)} spaces ${t.toFixed(0).padStart(6)} ms  ${(t / width).toFixed(2)} ms/space  (${(t / (width * 5)).toFixed(2)} ms per check)`)
  }

  // ── the whole-space TREE (`listPages`): every row in the space, one pass, four lanes ────────────
  // ⚠️ The row above measures `enrichSpaceRows` — the SPACE list. `listPages` is a different question:
  // `filterAuthorized(… 'view', every row in the space …, 'page', 4)`.
  //
  // ⚠️ WHO ACTUALLY PAYS THIS, verified in the shipped tree rather than assumed. `listPages` has ONE
  // caller left (`GET /spaces/:id/pages`), and the member sidebar stopped calling it: Sidebar.tsx uses
  // `useLazyPageTree`, and #623 / ADR-220 §6.3 says in so many words that this retires the whole-space
  // read and #541's `?first=40`. What is left on the route is the guest share-link shell
  // (routes.tsx `refreshPages`), which sends no `?first=`.
  //
  // ⚠️ AND THE CAP DOES NOT BOUND THE WORK. `GUEST_TREE_CAP` (500) is applied by the route to the
  // RESULT — `pages.slice(0, GUEST_TREE_CAP)` AFTER `listPages` has already confirmed every row. So a
  // guest opening a link to an N-page space pays N checks to be shown at most 500 rows. The same file
  // already solves this shape for backlinks (QUERY_DISPLAY_N 200 over QUERY_OVER_FETCH 600): bound the
  // candidates by a CONSTANT so the work is bounded, and keep "the top N VIEWABLE" rather than
  // degrading to "the viewable subset of the top N".
  console.log('\nwhole-space TREE — every row, one pass, FOUR lanes (listPages, member subject)')
  for (const width of [50, 200, 500, 1000]) {
    const ids = pages.slice(0, width)
    const [t] = await ms(() => filterAuthorized(fgaClient, USER, 'view', ids, undefined, 'page', 4))
    console.log(`  ${String(width).padStart(4)} rows  ${t.toFixed(0).padStart(6)} ms  ${(t / width).toFixed(2)} ms/row`)
  }

  // ⚠️ And the same widths at ONE lane, so the four-lane figure above can be read as a ratio rather
  // than as an absolute — this ticket carries five per-check numbers from five store states, and only
  // ratios survive that.
  console.log('\nthe same tree widths at ONE lane (for the ratio, not for the clock)')
  for (const width of [200, 1000]) {
    const ids = pages.slice(0, width)
    const [t] = await ms(() => filterAuthorized(fgaClient, USER, 'view', ids, undefined, 'page', 1))
    console.log(`  ${String(width).padStart(4)} rows  ${t.toFixed(0).padStart(6)} ms  ${(t / width).toFixed(2)} ms/row`)
  }

  // ── the SAME whole-space read, at the GUEST subject — the caller that is actually left ──────────
  // ⚠️ Two differences from the member row, and both make the guest the worse case:
  //   1. NO CACHE. `cacheable` in pages.ts excludes `share_link:` subjects, because a revoke is one
  //      tuple delete and ADR-028 promises it is instant. Every open pays the full width cold.
  //   2. A CONDITION. The route always sends `context = { current_time }` for a guest, so each check
  //      carries the `non_expired` evaluation the member's does not.
  // If the guest row is NOT slower per id, say so — the point of measuring is that it might not be.
  console.log('\nthe same whole-space read at a GUEST subject (share_link + current_time, no cache)')
  for (const width of [50, 200, 500, 1000]) {
    const ids = pages.slice(0, width)
    const ctx = { current_time: new Date().toISOString() }
    const [t, allowed] = await ms(() => filterAuthorized(fgaClient, GUEST, 'view', ids, ctx, 'page', 4))
    // ⚠️ Print how many came back ALLOWED. An all-deny run measures the cheap side ("no" is cheaper
    // than "yes" — ADR-243 §6.0) and would understate the cost while looking like a valid number.
    console.log(`  ${String(width).padStart(4)} rows  ${t.toFixed(0).padStart(6)} ms  ${(t / width).toFixed(2)} ms/row  (${allowed.size ?? [...allowed].length}/${width} allowed)`)
  }

  // ── search stage 2: one authoritative confirm over the candidate set ─────────────────────────────
  console.log('\nsearch stage 2 — one filterAuthorized over the candidates Meilisearch handed over')
  for (const width of [20, 50, 100, 200]) {
    const ids = pages.slice(0, width)
    const [t] = await ms(() => filterAuthorized(fgaClient, USER, 'view', ids))
    console.log(`  ${String(width).padStart(4)} candidates ${t.toFixed(0).padStart(6)} ms  ${(t / width).toFixed(2)} ms/id`)
  }

  // ── and the same width asked of a page nobody can reach, for the yes/no split ────────────────────
  console.log('\nthe same question about ids that do not exist (the "no" side)')
  for (const width of [200, 2000]) {
    const ids = Array.from({ length: width }, (_, i) => `ms755-absent-${STAMP}-${i}`)
    const [t] = await ms(async () => {
      for (let i = 0; i < ids.length; i += 200) await filterAuthorized(fgaClient, USER, 'view', ids.slice(i, i + 200), undefined, 'page', 1)
    })
    console.log(`  ${String(width).padStart(4)} absent ids ${t.toFixed(0).padStart(6)} ms  ${(t / width).toFixed(2)} ms/id`)
  }
} finally {
  for (let i = 0; i < tuples.length; i += 100) await deleteTuples(fgaClient, tuples.slice(i, i + 100)).catch(() => {})
  if (pages.length) await sql`DELETE FROM pages WHERE id = ANY(${pages})`.catch(() => {})
  if (spaces.length) await sql`DELETE FROM spaces WHERE id = ANY(${spaces})`.catch(() => {})
  await sql.end()
}
