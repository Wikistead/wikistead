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
  // ── A group (the ticket's own list): the page grows with the tenant ────────────────────────────
  'members.ts': { kind: 'debt', why: '#623 A: every member, every invite. The motivating case.' },
  'spaces.ts': { kind: 'debt', why: '#623 A: pages per space, spaces per tenant, the space roster.' },
  'pages.ts': { kind: 'debt', why: '#623 A: attachments, trash, related/backlinks, per-page grants.' },
  'api-keys.ts': { kind: 'debt', why: '#623 A: one row per key; grows with integrations.' },
  'notifications.ts': { kind: 'debt', why: '#623 A/B: watches and the feed both grow without limit.' },
  'webhooks.ts': { kind: 'debt', why: '#623 A: one row per subscription.' },
  'templates.ts': { kind: 'debt', why: '#623 A: one row per template.' },
  'orphan-drafts.ts': { kind: 'debt', why: '#623 A: grows with abandoned drafts; nothing prunes it.' },
  'admin-connections.ts': { kind: 'debt', why: '#623 A: connections and custom domains per tenant.' },
  'custom-domains.ts': { kind: 'debt', why: '#623 A: one row per domain.' },
  'roles.ts': { kind: 'debt', why: '#623 B: assignments grow as principal × resource — the fastest of all.' },
  'share-links.ts': { kind: 'debt', why: '#623 B: one row per link; a busy page accumulates them.' },
  'pins.ts': { kind: 'debt', why: '#623 B: one row per pin.' },
  'revisions.ts': { kind: 'debt', why: '#623 B: one row per published version of a page.' },
  'comments.ts': { kind: 'debt', why: '#623 B: the comment list is bounded, the patrol list is not.' },
  'attachments.ts': { kind: 'debt', why: '#623 A: one row per attachment.' },
  'account.ts': { kind: 'debt', why: '#623 B: the identity/session lists grow with the person.' },
  'admin-surfaces.ts': { kind: 'bounded', why: 'one entry per admin surface — a fixed registry, not data.' },
  'branding.ts': { kind: 'bounded', why: 'one branding row per tenant — a settings record, not a list.' },
  'abuse-config.ts': { kind: 'bounded', why: 'one abuse-filter row per tenant — a settings record, not a list.' },
  'billing.ts': { kind: 'bounded', why: 'one subscription per tenant; the plan table is a constant.' },
  'public.ts': { kind: 'debt', why: '#623: bounded by listObjects at 1000 — a DIFFERENT ceiling, same slice.' },
  'public-shell.ts': { kind: 'bounded', why: 'renders one page shell for one request — never a collection.' },
  'export.ts': { kind: 'debt', why: '#623 B: an export walks a whole space by design; the bound is a stream.' },
  'ai.ts': { kind: 'bounded', why: 'one completion per request — the model bounds it, not a query.' },
  'mcp.ts': { kind: 'debt', why: '#623 B: tool listings are fixed, resource listings are not.' },
  'audit.ts': { kind: 'bounded', why: 'already bounded — kept here only because the scan sees a list shape.' },
  'search.ts': { kind: 'bounded', why: 'already bounded by the search driver.' },
  'admin-login-methods.ts': { kind: 'bounded', why: 'already bounded; the exemption list is small by design.' },
  'auth.ts': { kind: 'internal', why: 'sign-in flow, not a list surface.' },
  'auth-local.ts': { kind: 'internal', why: 'sign-in flow, not a list surface.' },
  'mcp-oauth-authorize.ts': { kind: 'internal', why: 'OAuth flow, not a list surface.' },
  'mcp-oauth-flow.ts': { kind: 'internal', why: 'OAuth flow, not a list surface.' },
  'mcp-oauth-metadata.ts': { kind: 'internal', why: 'a fixed metadata document.' },
  'mcp-oauth-register.ts': { kind: 'internal', why: 'OAuth flow, not a list surface.' },
  'mcp-oauth-token.ts': { kind: 'internal', why: 'OAuth flow, not a list surface.' },
  'email-unsubscribe.ts': { kind: 'internal', why: 'one unsubscribe link resolves to one member — no listing.' },
}

/** A handler that reads rows and never says how many. The two markers a bound leaves behind. */
const BOUNDED = /\bLIMIT\b|\blimit\b|\bfirstN\b|\bcursor\b/

function listShapedGetFiles(): string[] {
  return readdirSync(ROUTES)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => {
      const src = readFileSync(resolve(ROUTES, f), 'utf8')
      // a GET route that runs a query returning rows — the shape a growing page is drawn from
      return /app\.get</.test(src) && /db\.sql<|sql<|\.sql`/.test(src)
    })
}

describe('#623: no list route grows without saying so', () => {
  it('the scan finds route files (a broken pattern must not pass vacuously)', () => {
    const files = listShapedGetFiles()
    expect(files.length, 'the routes directory was read').toBeGreaterThan(10)
    expect(files, 'the motivating case is in scope').toContain('members.ts')
  })

  it('every list-shaped GET route is either bounded or in the ledger with a reason', () => {
    const missing: string[] = []
    for (const f of listShapedGetFiles()) {
      const src = readFileSync(resolve(ROUTES, f), 'utf8')
      if (BOUNDED.test(src)) continue
      if (!LEDGER[f]) missing.push(f)
    }
    expect(
      missing,
      `these route files return a list with no bound and no ledger entry (#623). Add the bound, or add a ` +
      `line to LEDGER saying why it may grow: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('the ledger has no stale lines — every entry names a real route file', () => {
    // The other direction, and the one that lets the ledger shrink honestly: a line for a file that no
    // longer exists (or was renamed) is a reason nobody can check.
    const files = new Set(readdirSync(ROUTES).filter((f) => f.endsWith('.ts')))
    const orphans = Object.keys(LEDGER).filter((f) => !files.has(f))
    expect(orphans, `ledger lines for routes that do not exist: ${orphans.join(', ')}`).toEqual([])
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
    const all = readdirSync(ROUTES).filter((f) => f.endsWith('.ts')).length
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
