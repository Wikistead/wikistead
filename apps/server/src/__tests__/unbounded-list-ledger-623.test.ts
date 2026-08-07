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
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

// THE BLIND SPOT SLICE 12 RECORDED, now closed. Two changes that had to land together.
//
// Slice 12 measured it and said so out loud: the scan was same-file, so a route whose rows come from an
// IMPORTED function was read as having no query at all. Re-measured here before changing anything
// 61 GET routes delegate to an imported symbol, and 17 of them read rows through it.
//
// The same report warned that narrowing the window and following imports must land in ONE commit,
// because each one alone makes the instrument worse. Measured, both directions
//
// window narrowed alone 89 routes seen (down from 95) — six routes leave the scan entirely,
// because their SQL was in a file they import
// imports followed alone a route keeps its neighbour's `limit`, so the same false greens survive
// both 104 routes seen, 52 unbounded (up from 36)
//
// ⚠️ Following imports NAIVELY — pasting the helper's body onto the route's — introduces a false green,
// and it caught a live one: `GET /me/factors` read as bounded because `secondFactorStance` contains
// `SELECT second_factor_kinds FROM tenant_login_prefs LIMIT 1`. That LIMIT belongs to a settings lookup
// in another file; the list of factors has no bound at all. Borrowing across a file boundary is the same
// mistake slice 12 fixed inside one file, made larger.
//
// So an imported helper is never concatenated. It is evaluated on its own, and it may only answer for a
// route that has NO query of its own — see `routeBounded`.
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
  // ⚠️ Was a 'debt' line reading "one row per thing the person did; grows for ever". Measured, and
  // that was never true: the query buckets by CALENDAR DAY inside a twelve-month window, so the
  // response is at most a year of days however much the person did, and the account getting older
  // does not make it longer. The scan cannot see either half — `withoutSubqueries` strips the
  // derived tables they live in — so the claim is stated here and CHECKED in activity-window-623.
  'account.ts:/me/activity': { kind: 'bounded', why: 'GROUP BY calendar day inside a twelve-month window: at most ~367 rows, and a busy day is one row. Pinned by activity-window-623, because the scan strips the derived tables the window and the grouping live in.' },
  'members.ts:/admin/analytics': { kind: 'debt', why: '#623 B: a row per day per page; grows with the tenant and with time.' },
  'members.ts:/members/invites': { kind: 'debt', why: '#623 A: one row per pending invitation (#638 boxed the UI, not the payload).' },
  'notifications.ts:/notifications/unread-count': { kind: 'bounded', why: 'the count stops at UNREAD_BADGE_CAP + 1 — the number the bell already refuses to print past (it renders 99+). The LIMIT lives in a derived table, which withoutSubqueries strips before looking for a bound, so this line states what the scan cannot see rather than the scan being loosened to see it.' },
  'pins.ts:/pins': { kind: 'debt', why: '#623 B: one row per pin; nothing prunes them.' },
  'spaces.ts:/spaces/:spaceId/access': { kind: 'debt', why: '#623 B: principal × space; the roster the permissions dialog reads.' },
  'spaces.ts:/spaces/:spaceId/analytics': { kind: 'debt', why: '#623 B: a row per day per page, same shape as the tenant roll-up.' },

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

  // ── surfaced by slice 12's SECOND instrument fix: a bound marker that belonged to a scalar subquery,
  // or to a lower-case variable. Five routes, each read by hand. `GET /spaces` was one of them and
  // has no line: it got the bound instead (slice 12b), which is what a ledger line is supposed to
  // turn into.
  'spaces.ts:/spaces/:spaceId/delete-mode': { kind: 'bounded', why: 'one delete-mode setting for one space — a settings record. Its only LIMIT takes the tenant default as a scalar.' },
  'auth-local.ts:/auth/invite-kind': { kind: 'bounded', why: 'one invitation, addressed by the hash of the token in the link — a row, not a list.' },
  'public.ts:/public/attachments/:id/inline': { kind: 'bounded', why: 'one attachment by id — a row, not a list. The download twin was already here; this one was not.' },

  // ── the two trees: ADR-220. Both were invisible to this scan until slice 12 — see NOT_REALLY_BOUNDED.
  'pages.ts:/spaces/:spaceId/pages': { kind: 'debt', why: '#623 ADR-220: the whole space, one row per page, plus a per-page confirm.' },
  'public.ts:/public/spaces/:spaceId/pages': { kind: 'debt', why: '#623 ADR-220: 200 children per node to depth 6 — each step bounded, the product is not.' },

  // ── VISIBLE FOR THE FIRST TIME, now that the scan follows an import. Seventeen routes, each read by
  // hand: a regex can tell you a route reads rows, not whether the response can grow.
  //
  // `email-unsubscribe.ts:/email/unsubscribe` LEFT the ledger in the same change and is not replaced
  // by a line here: with the window cut at the next registration it has no query at all, so it is no
  // longer a list route to correct. Its old line described a neighbour's SQL.

  // the audit chains: both read every entry, and both must, because a hash chain is verified from its
  // start. Bounding these is a design (checkpoints), not a LIMIT — which is exactly what a debt line is.
  'audit.ts:/audit/verify': { kind: 'debt', why: '#623: recomputes the chain over EVERY audit row in the tenant. The verdict needs the whole chain, so the bound has to be a checkpoint design, not a page.' },
  'audit.ts:/admin/transparency': { kind: 'debt', why: '#623: returns every transparency entry IN THE RESPONSE — the growing-page shape, not just a growing read.' },
  'audit.ts:/admin/transparency/verify': { kind: 'debt', why: '#623: reads the whole transparency chain to verify it; same checkpoint question as /audit/verify.' },

  // admin rosters: each grows with how the tenant is configured rather than with how it is used, which
  // makes them slower to notice and no less unbounded.
  'admin-connections.ts:/admin/connections': { kind: 'debt', why: '#623: one row per login connection, ORDER BY sort — the admin twin of /auth/login-options.' },
  'admin-login-methods.ts:/admin/sso-exemptions': { kind: 'debt', why: '#623: one row per exempted member; an exemption is never pruned.' },
  'admin-login-methods.ts:/admin/login-methods/impact': { kind: 'debt', why: '#623: membersUnsatisfiedBy walks EVERY member to count who a stance would sign out.' },
  'custom-domains.ts:/admin/custom-domains': { kind: 'debt', why: '#623: one row per custom domain on the tenant.' },
  'roles.ts:/pages/:pageId/assignable-roles': { kind: 'debt', why: '#623: every resource-scoped role — the page twin of /spaces/:spaceId/assignable-roles, and the same table.' },
  // the clearest case of the blind spot in the whole product: the handler is ONE line that calls an
  // imported function, so to a same-file scan the route contained no query whatsoever.
  'pages.ts:/pages/:pageId/restrict': { kind: 'debt', why: '#623: one row per restricted principal on the page — the subtract-side twin of /pages/:pageId/access.' },

  // bounded, and NOT by a LIMIT — which is why each needs a line rather than a keyword.
  'billing.ts:/billing/usage': { kind: 'bounded', why: 'getUsage is SUM(amount) — one number per resource, and the resource list is a constant in the handler. The read scans, the response cannot grow.' },
  'export.ts:/export': { kind: 'bounded', why: 'buildTenantExport accumulates into a byte budget and throws ExportTooLargeError past MAX_EXPORT_BYTES (413). A refusal, not a truncation — the caller is told, rather than handed a silently short archive.' },
  'export.ts:/spaces/:spaceId/export': { kind: 'bounded', why: 'the same MAX_EXPORT_BYTES budget as the tenant export, over one space.' },
  'export.ts:/pages/:pageId/export.html': { kind: 'bounded', why: 'one page rendered to HTML — the same byte budget bounds its embedded images.' },
  'pages.ts:/spaces/:spaceId/info': { kind: 'bounded', why: 'getSpaceInfo selects one space by id and one settings row — a record, not a list.' },
  'pages.ts:/pages/:pageId/transclude/:refId': { kind: 'bounded', why: 'one transcluded fragment by id — the authenticated twin of the public route above.' },
  'public-shell.ts:/pub/:pageId': { kind: 'bounded', why: 'loadPublicPage selects one published page by id — a row, not a list.' },
  'public-shell.ts:/robots.txt': { kind: 'bounded', why: 'reads one tenant_settings flag to decide whether the public surface exists at all.' },
}

/**
 * A scalar or derived subquery, removed before the bound is looked for.
 *
 * #623 slice 12 (/, re-measured here): `listSpaces` reads
 * `(SELECT delete_mode FROM tenant_settings LIMIT 1)` as one column of a query over every space in the
 * tenant. That `LIMIT 1` takes one SCALAR and holds back no rows at all — and it made `GET /spaces`
 * read as bounded while it returned **253 rows in one response** on the dev tenant, on the path the
 * sidebar takes at startup. A token cannot see which statement a keyword belongs to, so the keyword is
 * removed from the ones it cannot belong to.
 *
 * The direction of the error matters. A route whose only bound genuinely lives inside a derived table
 * (`FROM (SELECT … LIMIT 50) t`) now reads as unbounded and lands in the ledger, where a person reads
 * it. The opposite mistake is the one this slice exists to stop: silently green.
 */
function withoutSubqueries(sql: string): string {
  let out = '', i = 0
  while (i < sql.length) {
    if (sql[i] === '(' && /^\(\s*SELECT\b/i.test(sql.slice(i, i + 20))) {
      let depth = 0, j = i
      for (; j < sql.length; j++) {
        if (sql[j] === '(') depth++
        else if (sql[j] === ')') { depth--; if (depth === 0) break }
      }
      out += ' '; i = j + 1
    } else { out += sql[i]; i++ }
  }
  return out
}

/**
 * A handler that reads rows and never says how many. The markers a bound leaves behind.
 *
 * `firstN` used to be in here and never belonged: it is the page tree's PARTIAL FIRST PAINT (#541 —
 * the first N rows in DFS order, drawn while the full response is still in flight), and the same
 * handler goes on to return the entire space. It bought the member tree a green line in this ledger
 * for ten slices while being, by its own ADR's description, not a bound. Removed.
 *
 * `limit` (lower case) went the same way in slice 12. The suite at the bottom of this file learned in
 * slice 3 that `const limit = …` satisfies a case-insensitive search while the query it was meant to
 * bound has none, and made itself case-sensitive; this half had not caught up. Measured: it was the
 * only thing holding `GET /spaces/:spaceId/share-links` green, whose window runs to the end of the file
 * and picks up a `limit` belonging to a DELETE handler two routes later.
 *
 * `cursor` STAYS, and not for symmetry: `/search` is keyset-paged through Meilisearch and has no SQL at
 * all, so `LIMIT` is not a word it will ever contain. Dropping `cursor` would have put the one route in
 * the product that already does paging properly into the ledger — measured before deciding.
 */
const BOUNDED_MARKER = /\bLIMIT\b|\bcursor\b/
const isBounded = (body: string): boolean => BOUNDED_MARKER.test(withoutSubqueries(body))

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
/** Where `import { x } from './y.js'` actually points, or null for a package. */
function resolveImport(fromAbs: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(fromAbs), spec).replace(/\.js$/, '')
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) if (existsSync(candidate)) return candidate
  return null
}

/** Local name → the file it was imported from. `import type` is skipped: a type carries no query. */
function importMap(abs: string, src: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const m of src.matchAll(/import\s+(?!type\b)(?:[\w*\s{},]*?)\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const target = resolveImport(abs, m[2]!)
    if (!target) continue
    for (const raw of m[1]!.split(',')) {
      if (/^\s*type\s/.test(raw)) continue
      const name = raw.trim().split(/\s+as\s+/).pop()!.trim()
      if (name) map.set(name, target)
    }
  }
  return map
}

/** A named declaration's text, cut at the next top-level one. */
function declBody(src: string, name: string): string {
  const decl = new RegExp(`^(?:export )?(?:async )?(?:function ${name}\\b|const ${name}\\s*[:=])`, 'm')
  const found = decl.exec(src)
  if (!found) return ''
  const rest = src.slice(found.index)
  const stop = /\n(?:export |(?:async )?function |const |class )/.exec(rest.slice(1))
  return stop ? rest.slice(0, stop.index + 1) : rest
}

function routesIn(file: string): { key: string; body: string; helpers: { name: string; bounded: boolean }[] }[] {
  const abs = resolve(ROUTES, file)
  const src = readFileSync(abs, 'utf8')
  const imports = importMap(abs, src)
  const out: { key: string; body: string; helpers: { name: string; bounded: boolean }[] }[] = []
  // each `app.get(...)` registration, cut at the next registration of ANY method.
  //
  // It used to be cut at the next `app.get`, and that let a route read the SQL of every POST/DELETE
  // sitting between it and the next GET. Measured: `GET /spaces/:spaceId/share-links` was green solely
  // on a `limit` belonging to a DELETE handler two routes later, and `GET /email/unsubscribe` looked
  // list-shaped while having no query at all.
  const re = /app\.get(?:<[^>]*>)?\(\s*(['"`])([^'"`]+)\1/g
  const anyRe = /app\.(?:get|post|put|patch|delete|head|options)(?:<[^>]*>)?\(\s*(['"`])([^'"`]+)\1/g
  let m: RegExpExecArray | null
  const starts: { at: number; path: string }[] = []
  while ((m = re.exec(src)) !== null) starts.push({ at: m.index, path: m[2]! })
  const registrations: number[] = []
  while ((m = anyRe.exec(src)) !== null) registrations.push(m.index)
  for (const r of starts) {
    const end = registrations.find((at) => at > r.at) ?? src.length
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
    // …and the helpers it delegates to in ANOTHER file, kept SEPARATE. Concatenating them is what made
    // `/me/factors` read as bounded on a settings lookup's `LIMIT 1` — see the header. Each is judged on
    // its own text, and what the route may conclude from them is in `routeBounded`.
    const helpers: { name: string; bounded: boolean }[] = []
    for (const name of new Set([...body.matchAll(/\b([a-z][A-Za-z0-9_]*)\s*\(/g)].map((mm) => mm[1]!))) {
      const target = imports.get(name)
      if (!target) continue
      const hb = declBody(readFileSync(target, 'utf8'), name)
      if (hb && LIST_SHAPED.test(hb)) helpers.push({ name, bounded: isBounded(hb) })
    }
    out.push({ key: `${file}:${r.path}`, body, helpers })
  }
  return out
}

/**
 * Whether a route's response is bounded.
 *
 * Three cases, and the middle one is the whole point of keeping helpers separate:
 *
 *   the route's own window is bounded            → bounded. Unchanged; this is what the scan always did.
 *   the route has NO query of its own            → its rows come from the helpers it imports, so it is
 *                                                  bounded only if EVERY list-shaped one of them is.
 *   the route has a query AND imports helpers    → unbounded. A helper cannot vouch for a statement it
 *                                                  does not contain, and this is the direction the file
 *                                                  errs in deliberately: land in the ledger, not silently
 *                                                  green.
 */
function routeBounded(r: { body: string; helpers: { bounded: boolean }[] }): boolean {
  if (isBounded(r.body)) return true
  if (LIST_SHAPED.test(r.body)) return false
  return r.helpers.length > 0 && r.helpers.every((h) => h.bounded)
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

function listShapedRoutes(): { key: string; body: string; helpers: { name: string; bounded: boolean }[] }[] {
  return readdirSync(ROUTES)
    .filter((f) => f.endsWith('.ts'))
    .flatMap((f) => routesIn(f))
    // …or reads its rows through a helper in another file, which is the whole point of this slice: a
    // route with two lines and an import was not list-shaped to this scan at all.
    .filter((r) => LIST_SHAPED.test(r.body) || r.helpers.length > 0)
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
      if (routeBounded(r) && !NOT_REALLY_BOUNDED[r.key]) continue
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
      .filter((r) => routeBounded(r) && !NOT_REALLY_BOUNDED[r.key] && LEDGER[r.key])
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
      const counted = !routeBounded(r!) || Boolean(NOT_REALLY_BOUNDED[key])
      expect(counted, `${key}: counted as bounded, so bounding it would change nothing here`).toBe(true)
      expect(LEDGER[key], `${key}: …and it is owed a bound, out loud`).toBeDefined()
    }
  })

  it('a route whose rows come from an IMPORTED helper is measured, not skipped', () => {
    // The blind spot slice 12 recorded, asserted rather than described. `/audit/verify` is two lines and
    // a call: `verifyTenantAuditChain` lives in `audit/outbox.ts` and reads the whole chain. Before this
    // change the route had no query the scan could see and could not fail this file at all.
    const byKey = new Map(listShapedRoutes().map((r) => [r.key, r]))
    const r = byKey.get('audit.ts:/audit/verify')
    expect(r, 'the scan does not reach a route that delegates across a file boundary').toBeDefined()
    expect(r!.helpers.map((h) => h.name), 'the imported helper is the one that reads the rows')
      .toContain('verifyTenantAuditChain')
    expect(routeBounded(r!), 'a helper that reads the whole chain cannot make the route bounded').toBe(false)
  })

  it('an imported helper cannot lend its bound to a route that queries for itself', () => {
    // The false green this slice had to avoid. `/me/factors` imports `secondFactorStance`, whose body
    // contains `LIMIT 1` for a settings row; the factor list it returns has no bound at all. Pasting the
    // helper's text onto the route's made it read as bounded — measured, on the way to writing this.
    const byKey = new Map(listShapedRoutes().map((r) => [r.key, r]))
    const r = byKey.get('second-factor.ts:/me/factors')
    expect(r, 'the factors route left the scan').toBeDefined()
    expect(r!.helpers.some((h) => h.bounded), 'the borrowable LIMIT is still there to be borrowed').toBe(true)
    expect(routeBounded(r!), 'a LIMIT belonging to a settings lookup in another file is not this list’s bound')
      .toBe(false)
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
    // Already bounded before this ticket touched it — the A/B classification in was made from the
    // presence of a LIMIT in the ROUTE body, and this one lives in the helper. Listed so it stays that
    // way rather than because it was changed.
    { file: 'routes/pages.ts', fn: 'getRelatedPages' },
    { file: 'routes/pages.ts', fn: 'getBacklinks' },             // slice 6
    // #623: the page history. Listed here and not only in the walk pin, because the walk cannot see
    // this: `hasMore`/`slice` cap the RESPONSE in JS, so deleting the SQL LIMIT leaves every behavioural
    // assertion green while the query goes back to reading the whole history. Measured — that break was
    // green until this line existed.
    { file: 'routes/revisions.ts', fn: 'listRevisions' },
    // #623: the unread badge. Its cap is inside a derived table, which the ledger scan strips before
    // looking for a bound — so the ledger keeps a line saying why the route may read as unbounded, and
    // THIS is where the bound is actually held.
    { file: 'routes/notifications.ts', fn: 'unreadCount' },
    // #623: BOTH share-link list routes read through this one query, which is why one slice removed
    // two ledger lines. If it is ever split in two, the twin that keeps this name stays measured here
    // and the new one has to earn its own line.
    { file: 'routes/share-links.ts', fn: 'listShareLinks' },
    // #623: the tenant's group names, serving BOTH /admin/groups and /spaces/:spaceId/groups. It has to
    // be here rather than left to the sweep for two reasons at once: `slice` caps the response in JS, so
    // deleting the SQL bound is invisible from outside, AND the word `cursor` in the handler satisfies
    // BOUNDED_MARKER on its own. Measured — with neither of those understood, the break stayed green in
    // both places.
    { file: 'routes/spaces.ts', fn: 'listGroupNames' },
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
