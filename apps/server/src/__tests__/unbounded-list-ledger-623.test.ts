// #623: a list route with no bound makes a page that grows for ever.
//
// The ticket's sweep found 43 of them. This does NOT fix them — bounding each one is a design question
// (which cursor, and whether filtering moves to the server with it, because paging a client-side filter
// turns "search" into "search this page") and that is acceptance 1 and 2, still in Review.
//
// What it does is acceptance 3 and 4: **stop the debt growing, and record it out loud.** The scan finds
// GET handlers that return a list and asks whether the handler bounds it. Anything unbounded must be in
// the ledger below WITH A REASON. A new list route added tomorrow is not in the ledger, so it fails on
// the day it lands — which is the whole point of a discovery-shaped pin (#574's family): the 43 are not
// hand-copied into an assertion, they are the ledger's opening balance.
//
// THE LEDGER IS EXPECTED TO SHRINK. Every route bounded by the paging work deletes its line here. A
// line that stays is a decision somebody has to defend, not a fact that fades.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

// KNOWN BLIND SPOT, measured 2026-08-06 (slice 12) and NOT fixed here.
//
// This scan is same-file: a route's window covers its registration and the helpers declared beside it.
// 45 GET routes delegate to an IMPORTED function instead, and following those imports two levels deep
// finds 13 that read rows with no bound — including `/export` (a whole tenant), `/spaces/:id/export`,
// `/audit/verify` (the whole hash chain) and `/billing/usage`. None of them can fail this test today.
//
// It is recorded rather than fixed because each of the 13 needs its own line and its own reason, which
// is a judgement per route, not a regex; and because widening the scan is a change to the instrument
// that should land on its own rather than inside the page-tree slice. Reported on #623.
const ROUTES = resolve(import.meta.dirname, '../routes')

/**
 * Routes that return an unbounded list today, and why they are still allowed to.
 *
 * The reason is not decoration: it is what a reader needs to decide whether the line may stay. Three
 * kinds appear here, and they are deliberately not merged —
 *
 *   'debt'     — genuinely unbounded, grows with tenant data, waiting on #623's paging design;
 *   'bounded'  — the result cannot grow past a small constant for a structural reason, stated;
 *   'internal' — not a user-facing list (a health check, a fixed enumeration).
 *
 * A 'debt' line is a promise. A 'bounded' line is a claim about the data, and if it turns out to be
 * wrong the fix is a bound, not an edit to the reason.
 */
const LEDGER: Record<string, { kind: 'debt' | 'bounded' | 'internal'; why: string }> = {
  // ── debt: genuinely grows with a tenant's data, and #623 owes it a bound ───────────────────────
  'account.ts:/me/activity': { kind: 'debt', why: '#623 B: one row per thing the person did; grows for ever.' },
  'members.ts:/admin/analytics': { kind: 'debt', why: '#623 B: a row per day per page; grows with the tenant and with time.' },
  'members.ts:/members/invites': { kind: 'debt', why: '#623 A: one row per pending invitation (#638 boxed the UI, not the payload).' },
  'notifications.ts:/notifications/unread-count': { kind: 'debt', why: '#623 B: counts rows without a bound; a very old account pays for every one.' },
  'pins.ts:/pins': { kind: 'debt', why: '#623 B: one row per pin; nothing prunes them.' },
  'revisions.ts:/pages/:pageId/revisions': { kind: 'debt', why: '#623 B: one row per published version — a long-lived page has hundreds.' },
  'share-links.ts:/pages/:pageId/share-links': { kind: 'debt', why: '#623 B: one row per link; a busy page accumulates them.' },
  'spaces.ts:/spaces/:spaceId/access': { kind: 'debt', why: '#623 B: principal × space; the roster the permissions dialog reads.' },
  'spaces.ts:/spaces/:spaceId/analytics': { kind: 'debt', why: '#623 B: a row per day per page, same shape as the tenant roll-up.' },
  'spaces.ts:/spaces/:spaceId/groups': { kind: 'debt', why: '#623 A: one row per directory group; grows with the IdP, not with us.' },

  // ── bounded: the result cannot grow, and the reason is stated rather than assumed ──────────────
  'attachments.ts:/attachments/:id/download': { kind: 'bounded', why: 'one attachment by id — a row, not a list.' },
  'attachments.ts:/attachments/:id/inline': { kind: 'bounded', why: 'one attachment by id — a row, not a list.' },
  'revisions.ts:/pages/:pageId/revisions/:revId/content': { kind: 'bounded', why: 'one revision by id — a row, not a list.' },
  'templates.ts:/templates/:id': { kind: 'bounded', why: 'one template by id — a row, not a list.' },
  'spaces.ts:/spaces/:spaceId/icon-image': { kind: 'bounded', why: 'one image for one space — a settings record.' },
  'spaces.ts:/spaces/:spaceId/page-creation-policy': { kind: 'bounded', why: 'one policy for one space — a settings record.' },
  'second-factor.ts:/me/factors': { kind: 'bounded', why: 'MAX_FACTORS_PER_MEMBER refuses the enrolment past 10, so the list cannot grow (#657). A cap and not a page: paging authenticators would let somebody hold more than they can see.' },
  // …single-resource routes surfaced by the tighter window: each returns ONE record by id.
  'pages.ts:/pages/:pageId': { kind: 'bounded', why: 'one page by id — a row, not a list.' },
  'pages.ts:/pages/:pageId/published': { kind: 'bounded', why: 'one published page by id — a row, not a list.' },
  'pages.ts:/pages/:pageId/excerpt': { kind: 'bounded', why: 'one excerpt for one page — a row, not a list.' },
  'pages.ts:/pages/:pageId/comment-audience': { kind: 'bounded', why: 'one audience setting for one page — a settings record.' },
  'pages.ts:/pages/:pageId/member-candidates': { kind: 'bounded', why: 'searchMemberCandidates carries LIMIT 10 (spaces.ts) — the bound is real, it just lives in another file.' },
  // …the public single-resource routes, visible to this scan for the first time in slice 12.
  'public.ts:/public/pages/:pageId': { kind: 'bounded', why: 'one public page by id — a row, not a list.' },
  'public.ts:/public/attachments/:id/download': { kind: 'bounded', why: 'one attachment by id — a row, not a list.' },
  'public.ts:/public/pages/:pageId/transclude/:refId': { kind: 'bounded', why: 'one transcluded fragment by id — a row, not a list.' },

  // ── surfaced by slice 12's tighter helper window. Each of these read green only because the window
  // over-ran into a NEIGHBOURING helper that happened to contain a LIMIT — the bound belonged to
  // somebody else. They are not new routes and not new debt; they are debt that was being counted
  // as paid. Classified one at a time, by reading each handler.
  'comments.ts:/pages/:pageId/mentionable': { kind: 'debt', why: '#623 B: SELECT … FROM members with no bound, then an FGA batchCheck over EVERY member — the mention autocomplete pays for the whole roster.' },
  'pages.ts:/pages/:pageId/access': { kind: 'debt', why: '#623 B: principal × page, the roster the page permissions dialog reads — the /spaces/:spaceId/access shape.' },
  'roles.ts:/admin/roles': { kind: 'debt', why: '#623 B: one row per custom role; grows with tenant configuration, nothing prunes it.' },
  'roles.ts:/spaces/:spaceId/assignable-roles': { kind: 'debt', why: '#623 B: every resource-scoped role, same table as /admin/roles.' },
  'auth.ts:/auth/login-options': { kind: 'debt', why: '#623 A: one row per login connection; grows with IdP configuration, not with usage.' },

  // ── the two trees: ADR-220. Both were invisible to this scan until slice 12 — see NOT_REALLY_BOUNDED.
  'pages.ts:/spaces/:spaceId/pages': { kind: 'debt', why: '#623 ADR-220: the whole space, one row per page, plus a per-page confirm.' },
  'public.ts:/public/spaces/:spaceId/pages': { kind: 'debt', why: '#623 ADR-220: 200 children per node to depth 6 — each step bounded, the product is not.' },

  // ── internal: not a list surface at all ───────────────────────────────────────────────────────
  'email-unsubscribe.ts:/email/unsubscribe': { kind: 'internal', why: 'one unsubscribe link resolves to one member — no listing.' },
}

/**
 * A handler that reads rows and never says how many. The markers a bound leaves behind.
 *
 * `firstN` used to be in here and never belonged: it is the page tree's PARTIAL FIRST PAINT (#541 —
 * the first N rows in DFS order, drawn while the full response is still in flight), and the same
 * handler goes on to return the entire space. It bought the member tree a green line in this ledger
 * for ten slices while being, by its own ADR's description, not a bound. Removed.
 */
const BOUNDED = /\bLIMIT\b|\blimit\b|\bcursor\b/

/**
 * Routes where a bound MARKER is present and does not bound the RESPONSE.
 *
 * The scan is a token heuristic, which is what makes it a discovery pin rather than a hand-copied
 * list — but a token cannot see composition. `/public/spaces/:id/pages` does carry a `LIMIT 200`, in
 * the helper that fetches ONE node's children; the route then walks the tree to depth 6, so the
 * response is bounded by 200^6. Every step is bounded and the product is not.
 *
 * This escape hatch is deliberately narrow and deliberately noisy: a route named here still has to be
 * in the LEDGER with a reason (pinned below), so it cannot be used to make a route disappear — only to
 * move it from "silently green" to "owed a bound".
 */
const NOT_REALLY_BOUNDED: Record<string, string> = {
  'public.ts:/public/spaces/:spaceId/pages':
    'the LIMIT bounds ONE node’s children (200); the walk is depth 6, so the response is bounded by 200^6.',
}

/**
 * #623 slice 11: one entry per ROUTE, not per file.
 *
 * The ledger was keyed by file, and that had two consequences the acceptance criterion cared about.
 * Fourteen routes were given bounds across ten slices and not one line could be removed — `pages.ts`
 * hands out attachments, trash, related, backlinks and per-page grants, so its line stays until every
 * one of them is done. "The ledger shrinks a line at a time" was unmeasurable.
 *
 * The second consequence was worse and nobody had noticed: a file counted as bounded if the word LIMIT
 * appeared ANYWHERE in it. Measured before changing anything — adding a brand-new unbounded route to
 * `webhooks.ts`, which already has a bounded one, left this file green. A ledger that cannot see a new
 * unbounded list in a file it already covers is not covering that file.
 *
 * Route-level fixes both. It is the option this ticket's own report recommended; the alternative
 * (slice by file) contradicts the ordering ruling, which is to start with the surfaces that grow fastest.
 */
function routesIn(file: string): { key: string; body: string }[] {
  const src = readFileSync(resolve(ROUTES, file), 'utf8')
  const out: { key: string; body: string }[] = []
  // each `app.get(...)` registration, cut at the next one — the same window shape the "still bounded"
  // suite below uses, and the same reason: a route's bound lives in its own handler, not in its
  // neighbour's.
  const re = /app\.get(?:<[^>]*>)?\(\s*(['"`])([^'"`]+)\1/g
  let m: RegExpExecArray | null
  const starts: { at: number; path: string }[] = []
  while ((m = re.exec(src)) !== null) starts.push({ at: m.index, path: m[2]! })
  for (const [i, r] of starts.entries()) {
    const end = i + 1 < starts.length ? starts[i + 1]!.at : src.length
    let body = src.slice(r.at, end)
    // …plus the helpers it delegates to, IN THE SAME FILE. Several routes are two lines that call a
    // named function, and the bound lives there (`listWatchesResolved`, `listApiKeys`). A window that
    // stopped at the registration would report those as unbounded and teach the next reader to move
    // their LIMIT inline to satisfy a test.
    //
    // EXPORTED and not: the window used to look only for `export async function`, and that is why the
    // public space tree was not list-shaped to this scan at all — its SQL lives in `loadDirectChildren`
    // and `loadPublicSpaceRoots`, both module-private. Whether a helper is exported says nothing about
    // whether the route's rows come from it.
    for (const name of new Set([...body.matchAll(/\b([a-z][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]!))) {
      const decl = new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, 'm')
      const found = decl.exec(src)
      if (!found) continue
      const rest = src.slice(found.index)
      // stop at the next TOP-LEVEL declaration (column 0), not at the next `export` — a private helper
      // is followed by whatever comes next, exported or not.
      const stop = /\n(?:export |(?:async )?function |const |class )/.exec(rest.slice(1))
      body += stop ? rest.slice(0, stop.index + 1) : rest
    }
    out.push({ key: `${file}:${r.path}`, body })
  }
  return out
}

/**
 * Every GET route that reads rows — the shape a growing page is drawn from.
 *
 * The `tx` alternative is not a tidy-up. Routes that read inside `withTenantTx(id, (tx) => tx`…`)`
 * were not list-shaped to this scan at ALL, and that is the whole `/public/*` read surface: seven
 * routes, measured, including the public space tree this slice is about. The scan has been claiming
 * coverage of the least-authenticated surface in the product while never looking at it.
 */
const LIST_SHAPED = /db\.sql<|sql<|\.sql`|listObjects|filterAuthorized|\btx\s*(?:<[^>]*>)?\s*`/

function listShapedRoutes(): { key: string; body: string }[] {
  return readdirSync(ROUTES)
    .filter((f) => f.endsWith('.ts'))
    .flatMap((f) => routesIn(f))
    .filter((r) => LIST_SHAPED.test(r.body))
}

describe('#623: no list route grows without saying so', () => {
  it('the scan finds routes (a broken pattern must not pass vacuously)', () => {
    const routes = listShapedRoutes().map((r) => r.key)
    expect(routes.length, 'the routes directory was read, route by route').toBeGreaterThan(30)
    expect(routes, 'the motivating case is in scope').toContain('members.ts:/members')
  })

  it('every list-shaped GET route is either bounded or in the ledger with a reason', () => {
    const missing: string[] = []
    for (const r of listShapedRoutes()) {
      if (BOUNDED.test(r.body) && !NOT_REALLY_BOUNDED[r.key]) continue
      if (!LEDGER[r.key]) missing.push(r.key)
    }
    expect(
      missing,
      `these ROUTES return a list with no bound and no ledger entry (#623). Add the bound, or add a ` +
      `line to LEDGER saying why it may grow: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('the ledger has no stale lines — every entry names a real route file', () => {
    // The other direction, and the one that lets the ledger shrink honestly: a line for a file that no
    // longer exists (or was renamed) is a reason nobody can check.
    // …and now it can also see a line that is no longer NEEDED: a route that got its bound must lose
    // its line, which is the acceptance criterion this ticket could not measure while the key was a file.
    const live = new Set(listShapedRoutes().map((r) => r.key))
    const orphans = Object.keys(LEDGER).filter((k) => !live.has(k))
    expect(orphans, `ledger lines for routes that do not exist: ${orphans.join(', ')}`).toEqual([])
    const bounded = listShapedRoutes()
      .filter((r) => BOUNDED.test(r.body) && !NOT_REALLY_BOUNDED[r.key] && LEDGER[r.key])
    expect(bounded.map((r) => r.key), 'these routes are bounded now — delete their ledger lines').toEqual([])
  })

  it('the “not really bounded” hatch cannot hide a route', () => {
    // The hatch exists because a token cannot see composition (200 children × depth 6). What it must
    // never become is a way to make a route stop being counted. So each entry has to name a LIVE route,
    // and that route still has to be in the ledger with a reason — the hatch moves a route from
    // silently-green to owed-a-bound, and nowhere else.
    const live = new Set(listShapedRoutes().map((r) => r.key))
    for (const [key, why] of Object.entries(NOT_REALLY_BOUNDED)) {
      expect(live.has(key), `${key}: the hatch names a route the scan no longer finds`).toBe(true)
      expect(LEDGER[key], `${key}: a route whose bound does not bound must still be in the ledger`).toBeDefined()
      expect(why.length, `${key}: say WHY the marker does not bound the response`).toBeGreaterThan(20)
    }
  })

  it('both page trees are visible to this scan, and neither counts as bounded', () => {
    // ADR-220's premise, measured rather than asserted. Until slice 12 the member tree was green on the
    // word `firstN` (a partial first paint, not a bound) and the public tree was not list-shaped at all
    // (its SQL is in module-private helpers). An instrument that cannot see the two surfaces the slice
    // is about cannot show the slice worked.
    const byKey = new Map(listShapedRoutes().map((r) => [r.key, r]))
    for (const key of ['pages.ts:/spaces/:spaceId/pages', 'public.ts:/public/spaces/:spaceId/pages']) {
      const r = byKey.get(key)
      expect(r, `${key}: the scan does not see this route as list-shaped`).toBeDefined()
      const counted = !BOUNDED.test(r!.body) || Boolean(NOT_REALLY_BOUNDED[key])
      expect(counted, `${key}: counted as bounded, so bounding it would change nothing here`).toBe(true)
      expect(LEDGER[key], `${key}: …and it is owed a bound, out loud`).toBeDefined()
    }
  })

  it('every ledger line carries a reason a reader can act on', () => {
    for (const [file, entry] of Object.entries(LEDGER)) {
      expect(entry.why.length, `${file}: the reason is the point of the ledger`).toBeGreaterThan(20)
      // a 'debt' line is a promise, so it must name where the promise is tracked
      if (entry.kind === 'debt') {
        expect(entry.why, `${file}: a debt line names the ticket that will remove it`).toMatch(/#\d+/)
      }
    }
  })

  it('the ledger is smaller than the routes it covers — it is a record, not a rubber stamp', () => {
    // If every route file ended up in the ledger, the pin would assert nothing. Some routes ARE bounded
    // already, and that is what makes the ledger meaningful.
    const all = listShapedRoutes().length
    expect(Object.keys(LEDGER).length, 'some routes bound their lists without a ledger line').toBeLessThan(all)
  })
})

// #623 slices 1-3: the routes that have been bounded so far must STAY bounded. The ledger is keyed by
// file and cannot lose a line until every list in that file is done (reported on the ticket), so this is
// how the finished work is held: the specific queries, by name, with the shape that bounds them.
//
// Not a substitute for the ledger — that one catches a NEW unbounded list. This one catches a bounded
// list quietly losing its bound, which is the other direction and is what a refactor does.
describe('#623: the lists bounded so far still carry their bound', () => {
  const SRC_DIR = resolve(import.meta.dirname, '..')
  const DONE: { file: string; fn: string }[] = [
    { file: 'routes/pages.ts', fn: 'listSpacePagesOverview' },   // slice 1
    { file: 'routes/webhooks.ts', fn: 'listWebhooks' },          // slice 3
    { file: 'routes/templates.ts', fn: 'listTemplates' },        // slice 3
    { file: 'routes/api-keys.ts', fn: 'listApiKeys' },           // slice 4
    { file: 'routes/notifications.ts', fn: 'listWatchesResolved' },
    { file: 'routes/orphan-drafts.ts', fn: 'listOrphanDrafts' },
    { file: 'routes/spaces.ts', fn: 'listAdminSpaces' },
    { file: 'routes/pages.ts', fn: 'listSpaceTrash' },
    { file: 'routes/attachments.ts', fn: 'listAttachments' },    // slice 5
    // Already bounded before this ticket touched it — the A/B classification inwas made from the
    // presence of a LIMIT in the ROUTE body, and this one lives in the helper. Listed so it stays that
    // way rather than because it was changed.
    { file: 'routes/pages.ts', fn: 'getRelatedPages' },
    { file: 'routes/pages.ts', fn: 'getBacklinks' },             // slice 6
  ]

  it('each one still limits, and none of them paginates by OFFSET', () => {
    const missing: string[] = []
    for (const { file, fn } of DONE) {
      const src = readFileSync(resolve(SRC_DIR, file), 'utf8')
      const at = src.indexOf(`export async function ${fn}`)
      expect(at, `${fn} is gone from ${file} — if it was renamed, rename it here too`).toBeGreaterThan(-1)
      // the function body, approximated to the next top-level export
      const rest = src.slice(at)
      const end = rest.indexOf('\nexport ', 1)
      const body = end > 0 ? rest.slice(0, end) : rest
      // case-SENSITIVE: a `const limit = …` satisfies a case-insensitive search while the query it was
      // meant to bound has none — measured, removing the SQL LIMIT left this green
      if (!/\bLIMIT\b/.test(body)) missing.push(`${file}:${fn} lost its LIMIT`)
      if (/\bOFFSET\b/i.test(body)) missing.push(`${file}:${fn} paginates by OFFSET (rows shift under a reader)`)
    }
    expect(missing, missing.join('; ')).toEqual([])
  })

  it('the assignments list is bounded too (a route body, and the fastest-growing list in the ticket)', () => {
    const src = readFileSync(resolve(import.meta.dirname, '..', 'routes/roles.ts'), 'utf8')
    const at = src.indexOf("'/admin/roles/assignments'")
    expect(at, 'the assignments route moved').toBeGreaterThan(-1)
    const raw = src.slice(at, at + 6000)
    const next = raw.indexOf('\n  app.', 10)
    const body = raw.slice(0, next > 0 ? next : raw.length)
      .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/--.*$/, '')).join('\n')
    expect(body, 'the assignments query still limits').toMatch(/\bLIMIT\b/)
    expect(body, 'without an OFFSET').not.toMatch(/\bOFFSET\b/)
  })

  it('the public listing is bounded too, on BOTH of its branches', () => {
    // #623 slice 6. This one is worth two assertions rather than one: the route feeds `listPublicPages`
    // through two loaders, and the branch that matters is the fallback — the one that exists BECAUSE the
    // tenant is past OpenFGA's ceiling, and which used to answer with every published page it had.
    const src = readFileSync(resolve(import.meta.dirname, '..', 'routes/public.ts'), 'utf8')
    const at = src.indexOf('export function publicPageLoaders')
    expect(at, 'the public listing loaders moved — if renamed, rename them here too').toBeGreaterThan(-1)
    const rest = src.slice(at)
    const end = rest.indexOf('\nexport ', 1)
    const body = (end > 0 ? rest.slice(0, end) : rest)
      .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/--.*$/, '')).join('\n')
    expect(body.match(/\bLIMIT\b/g) ?? [], 'BOTH loaders limit — the fallback one especially').toHaveLength(2)
    expect(body, 'without an OFFSET').not.toMatch(/\bOFFSET\b/i)
    expect(body.match(/ORDER BY created_at DESC, id DESC/g) ?? [],
      'both ordered with a tiebreaker, or two pages created in the same import straddle the boundary')
      .toHaveLength(2)
  })

  it('the members list is bounded too (it is a route body, not a named function)', () => {
    const src = readFileSync(resolve(import.meta.dirname, '..', 'routes/members.ts'), 'utf8')
    const at = src.indexOf(`app.get<{ Querystring: { limit?: string; cursor?: string; q?: string } }>('/members'`)
    expect(at, 'the members route no longer takes a cursor').toBeGreaterThan(-1)
    // comments stripped and the window cut at the next route: the prose ABOVE the query says "never
    // OFFSET", and a search that reads its own explanation as the thing it forbids finds a defect in
    // every correct implementation
    const raw = src.slice(at, at + 9000)
    const nextRoute = raw.indexOf('\n  app.', 10)
    const body = raw.slice(0, nextRoute > 0 ? nextRoute : raw.length)
      .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/--.*$/, '')).join('\n')
    expect(body, 'and still limits').toMatch(/\bLIMIT\b/)
    expect(body, 'without an OFFSET').not.toMatch(/\bOFFSET\b/i)
    // the tiebreaker is the part that is easy to drop in a refactor and impossible to see afterwards
    expect(body, 'ordered with a tiebreaker, or two members sharing a timestamp straddle the boundary')
      .toMatch(/ORDER BY m\.created_at, m\.sub/)
  })
})
