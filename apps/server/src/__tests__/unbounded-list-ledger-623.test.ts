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
  'spaces.ts:/spaces/:spaceId/comment-open': { kind: 'bounded', why: 'one flag for one space — a settings record.' },
  'spaces.ts:/spaces/:spaceId/page-creation-policy': { kind: 'bounded', why: 'one policy for one space — a settings record.' },

  // ── internal: not a list surface at all ───────────────────────────────────────────────────────
  'email-unsubscribe.ts:/email/unsubscribe': { kind: 'internal', why: 'one unsubscribe link resolves to one member — no listing.' },
}

/** A handler that reads rows and never says how many. The two markers a bound leaves behind. */
const BOUNDED = /\bLIMIT\b|\blimit\b|\bfirstN\b|\bcursor\b/

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
    for (const name of new Set([...body.matchAll(/\b([a-z][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]!))) {
      const at = src.indexOf(`export async function ${name}`)
      if (at < 0) continue
      const rest = src.slice(at)
      const stop = rest.indexOf('\nexport ', 1)
      body += stop > 0 ? rest.slice(0, stop) : rest
    }
    out.push({ key: `${file}:${r.path}`, body })
  }
  return out
}

/** Every GET route that reads rows — the shape a growing page is drawn from. */
function listShapedRoutes(): { key: string; body: string }[] {
  return readdirSync(ROUTES)
    .filter((f) => f.endsWith('.ts'))
    .flatMap((f) => routesIn(f))
    .filter((r) => /db\.sql<|sql<|\.sql`|listObjects|filterAuthorized/.test(r.body))
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
      if (BOUNDED.test(r.body)) continue
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
    const bounded = listShapedRoutes().filter((r) => BOUNDED.test(r.body) && LEDGER[r.key])
    expect(bounded.map((r) => r.key), 'these routes are bounded now — delete their ledger lines').toEqual([])
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
