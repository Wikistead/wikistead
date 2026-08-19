// Code-region → docs-page map + the linkage evaluator (#139 / ADR-080 doc↔code linkage).
//
// The map binds a designated code region (API / macros / editor features / settings /
// entitlement levers) to the docs page that documents it. The CI check
// (scripts/check-doc-links.mjs) computes the changed files of a PR and FLAGS any entry
// whose code region changed while its docs page did NOT — so a feature change and its
// doc change stay in the same change flow (they cannot be decoupled silently).
//
// `kind`:
//   'generated' — the docs page is AUTO-GENERATED in THIS repo (docs/generated/**). Its
//                 freshness is additionally guaranteed by `pnpm docs:check`; the map check
//                 still flags a code change that lands without the regenerated output.
//   'authored'  — the docs page is HAND-WRITTEN prose in the separate wikistead-docs SSG
//                 repo (ADR-080: the docs repo is NOT a submodule). The check runs in the
//                 combined CI checkout where both repos' changed files are visible.
//
// The evaluator is PURE (changedFiles + map → violations) so it is verifiable with
// synthetic inputs regardless of which repos are checked out; the script is the thin git
// adapter around it.

// Each entry: code globs (relative to the app repo) → the docs page that must move with them.
export const DOC_CODE_MAP = [
  {
    label: 'entitlement levers',
    kind: 'generated',
    code: ['packages/entitlements/src/index.ts', 'packages/entitlements/src/catalog.ts'],
    doc: 'docs/generated/plan-contents.md',
  },
  {
    label: 'domain events',
    kind: 'generated',
    code: ['packages/events/src/index.ts', 'packages/events/src/catalog.ts'],
    doc: 'docs/generated/webhook-events.md',
  },
  {
    label: 'account settings',
    kind: 'generated',
    code: ['apps/server/src/settings-catalog.ts'],
    doc: 'docs/generated/account-settings.md',
  },
  {
    // #734 / ADR-237 §2.2: the environment reference is generated from a walk of the code, so the
    // prose file and the generator have to move with the committed output. The walk itself already
    // fails on an undocumented variable — this row catches the other half, where somebody edits a
    // description and forgets to regenerate.
    label: 'environment reference',
    kind: 'generated',
    code: ['scripts/env-catalog.mjs', 'packages/ee-server/scripts/gen-env-reference-ee.ts'],
    doc: 'docs/generated/environment-variables.md',
  },
  {
    // #706: the docs/LP brand kit derives from the product tokens — a token change must ship the
    // regenerated kit in the same change (the asset copies are byte-checked by docs:check besides).
    label: 'brand kit',
    kind: 'generated',
    code: ['apps/web/src/styles/tokens.css'],
    doc: 'docs/generated/brand/tokens.css',
  },
  // Authored pages live in the wikistead-docs repo (paths are docs-repo-relative). Seeded
  // for the designated regions; the check binds them in the combined CI checkout.
  {
    label: 'editor macros',
    kind: 'authored',
    code: ['apps/web/src/editor/macros/**'],
    doc: 'wikistead-docs/src/content/docs/editor/macros.md',
  },
  {
    label: 'HTTP API routes',
    kind: 'authored',
    code: ['apps/server/src/routes/**'],
    doc: 'wikistead-docs/src/content/docs/api/reference.md',
  },
  {
    label: 'account settings',
    kind: 'authored',
    code: ['apps/web/src/settings/**'],
    doc: 'wikistead-docs/src/content/docs/settings/account.md',
  },
  // ── #729 / ADR-235: capabilities with nothing enumerable behind them ────────────────────────────
  //
  // These have no registry to walk (there is no table of "print behaviours"), so they are bound as
  // REGIONS instead: touch the code, move the page. Four of the six had zero mentions anywhere in
  // docs/ when #729 measured them.
  //
  // ⚠️ DORMANT until #704. `authored` violations are warnings while `DOCS_REPO` is CHANGE_ME, so
  // these bindings do not fail anything today. They are here so they arm themselves the day the docs
  // repository exists — NOT so the gap can be counted as closed. The armed half of this ticket is
  // the capability ledger above, which fails in this repository's own tests.
  {
    label: 'import dialects and the fidelity report',
    kind: 'authored',
    code: ['apps/server/src/import/**'],
    doc: 'wikistead-docs/src/content/docs/guides/import.md',
  },
  {
    label: 'export rules',
    kind: 'authored',
    code: ['apps/server/src/export/**'],
    doc: 'wikistead-docs/src/content/docs/guides/pages.md',
  },
  {
    // The signing and delivery both live in routes/webhooks.ts. That file is already inside the
    // routes/** region, but that region's page is the API reference — the thing a receiver needs
    // (how to verify x-wikistead-signature) belongs on the webhooks page, so it gets its own row
    // rather than being assumed covered by a binding that points somewhere else.
    label: 'webhook delivery and signing',
    kind: 'authored',
    code: ['apps/server/src/routes/webhooks.ts'],
    doc: 'wikistead-docs/src/content/docs/admin/webhooks.md',
  },
  {
    label: 'search semantics',
    kind: 'authored',
    code: ['apps/server/src/search/**'],
    doc: 'wikistead-docs/src/content/docs/guides/search.md',
  },
  {
    label: 'storage quota and attachment limits',
    kind: 'authored',
    code: ['apps/server/src/storage/**'],
    doc: 'wikistead-docs/src/content/docs/admin/billing.md',
  },
  {
    // ADR-191: print output has no route, so the route ledger cannot see it (ruling §4 — a
    // section on the pages guide, not a capability id of its own).
    label: 'print output',
    kind: 'authored',
    code: ['apps/web/src/pdf-frame.ts'],
    doc: 'wikistead-docs/src/content/docs/guides/pages.md',
  },
  {
    // #729 a dialog is a surface a user operates, and the route walk cannot see it — it has no
    // <Route path>. Bound as a region instead, and this is what that does and does not catch:
    //   CATCHES  a dialog changing while its page does not.
    //   MISSES   a brand-new dialog whose page never existed — nothing here knows it should.
    // Registration would catch both and was weighed (ruling §2): it puts a documentation
    // concern into every component, so the region binding wins until the miss actually bites.
    label: 'dialogs',
    kind: 'authored',
    code: ['apps/web/src/ui/dialogs.tsx', 'apps/web/src/**/*Dialog.tsx'],
    doc: 'wikistead-docs/src/content/docs/guides/pages.md',
  },
  {
    // #725 / ADR-236 §2. The import screen is a SETTINGS TAB, and the surface ledger holds
    // `/spaces/:spaceId/settings/*` as one wildcard row — so the discovery test does NOT catch a new
    // tab the way it catches a new top-level route or admin tab. That is the blind spot ADR-235 (#729)
    // describes; until it is closed generally, this screen's binding is written by hand, deliberately.
    //
    // What it catches: the screen changing while the guide that documents it does not. What it does
    // NOT catch: a NEW settings tab arriving with no page at all — nothing here can, which is why this
    // is stated rather than left to be assumed. Dormant besides until #704 arms the authored side
    // (DOCS_REPO), so it is not counted as a guard that is holding today.
    //
    // Distinct from #729's 'import dialects' row above, which binds the ENGINE (server/src/import/**)
    // to the same page: what an import DOES and what its screen shows are changed independently, and
    // a region that covers one does not notice the other moving.
    label: 'import screen',
    kind: 'authored',
    code: ['apps/web/src/settings/SpaceImportTab.tsx'],
    doc: 'wikistead-docs/src/content/docs/guides/import.md',
  },
]

// Minimal glob → RegExp (no dependency). Supports `**` (any path segments incl. `/`),
// `*` (any chars except `/`), and literal path separators. Anchored to the full path.
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          // `**/` → zero or more leading path segments
          i++
          re += '(?:.*/)?'
        } else {
          // trailing `**` → anything, including `/` (the rest of the path)
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
    } else if ('\\^$+?.()|[]{}'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp('^' + re + '$')
}

export function matchesAny(file, globs) {
  return globs.some((g) => globToRegExp(g).test(file))
}

// ── #697 / ADR-225 §4.2: the SURFACE LEDGER ─────────────────────────────────────────────────────
//
// The map above binds code REGIONS; it cannot see a surface born outside every region, and a new
// registry item inside a region only trips the check when its docs page exists to move. This ledger
// closes that from the other side: every surface the product actually REGISTERS — walked from the
// registries themselves by the discovery tests (`doc-coverage-697` in the server and web suites),
// never enumerated here — must have a row naming its docs page, or an explicit `none:<reason>`.
// A registered surface with no row is red ON THE DAY IT IS REGISTERED; a row whose surface is gone
// is red too (a stale ledger is how coverage claims rot — both directions, like #692's pins).
//
// Server HTTP routes are deliberately NOT a registry here: the api-inventory (#407) pin already
// walks the served route table and fails on any route neither documented in docs/api/openapi.yaml
// nor explicitly excluded — a second ledger over the same surface would be two competing exclusion
// lists (the dont-pin-another-ticket's-surface lesson). Settings / levers / events are item-level
// mechanical already (gen-docs walks their catalogs); their duty here is the meta-entry below.
//
// Docs pages are docs-repo-relative (`wikistead-docs/…`), the paths #703's scaffold creates. Their
// EXISTENCE is checked by the docs repo's own CI once it exists; this side pins the BINDING.
export const SURFACE_DOCS = {
  // Admin console tabs — keys of ADMIN_SURFACES (apps/server/src/routes/admin-surfaces.ts).
  'admin-surface': {
    members: 'wikistead-docs/src/content/docs/admin/members.md',
    spaces: 'wikistead-docs/src/content/docs/admin/spaces.md',
    branding: 'wikistead-docs/src/content/docs/admin/branding.md',
    auth: 'wikistead-docs/src/content/docs/admin/sign-in-methods.md',
    api: 'wikistead-docs/src/content/docs/admin/api-keys.md',
    webhooks: 'wikistead-docs/src/content/docs/admin/webhooks.md',
    audit: 'wikistead-docs/src/content/docs/admin/audit-log.md', // EE-badged page
    analytics: 'wikistead-docs/src/content/docs/admin/analytics.md', // EE-badged page
    roles: 'wikistead-docs/src/content/docs/admin/roles.md',
    embeds: 'wikistead-docs/src/content/docs/admin/embeds.md',
    public: 'wikistead-docs/src/content/docs/publishing/public-spaces.md',
    moderation: 'wikistead-docs/src/content/docs/admin/moderation.md',
    billing: 'wikistead-docs/src/content/docs/admin/billing.md',
    orphans: 'wikistead-docs/src/content/docs/admin/orphaned-drafts.md',
    scim: 'wikistead-docs/src/content/docs/admin/scim.md', // EE-badged page (#723 / ADR-232)
    domains: 'wikistead-docs/src/content/docs/admin/custom-domains.md', // #721 / ADR-230
  },
  // Editor macros — registered fence languages and directive names (the registry walk imports
  // apps/web/src/editor/macros and asks registeredFenceLangs / registeredDirectiveNames).
  macro: {
    'fence:mermaid': 'wikistead-docs/src/content/docs/editor/diagrams.md',
    'fence:plantuml': 'wikistead-docs/src/content/docs/editor/diagrams.md',
    'fence:excalidraw': 'wikistead-docs/src/content/docs/editor/drawings.md',
    'directive:note': 'wikistead-docs/src/content/docs/editor/callouts.md',
    'directive:info': 'wikistead-docs/src/content/docs/editor/callouts.md',
    'directive:tip': 'wikistead-docs/src/content/docs/editor/callouts.md',
    'directive:warning': 'wikistead-docs/src/content/docs/editor/callouts.md',
    'directive:danger': 'wikistead-docs/src/content/docs/editor/callouts.md',
    'directive:table': 'wikistead-docs/src/content/docs/editor/tables.md',
    'directive:columns': 'wikistead-docs/src/content/docs/editor/layout-macros.md',
    'directive:tabs': 'wikistead-docs/src/content/docs/editor/layout-macros.md',
    'directive:details': 'wikistead-docs/src/content/docs/editor/layout-macros.md',
    'directive:embed-page': 'wikistead-docs/src/content/docs/editor/embeds.md',
    'directive:embed-external': 'wikistead-docs/src/content/docs/editor/embeds.md',
    'directive:tagged': 'wikistead-docs/src/content/docs/editor/tags.md',
    'directive:children': 'wikistead-docs/src/content/docs/editor/page-lists.md',
    'directive:todo': 'wikistead-docs/src/content/docs/editor/tasks.md',
  },
  // The web app's screens — the <Route path> table in apps/web/src/app/routes.tsx (that one file
  // IS the router registry; there is no composition to miss). `none:` rows are redirects and the
  // catch-all — not screens a reader can be on.
  'web-route': {
    // #726 the home landing. Mostly it redirects (first visible space → its home page), so the
    // only state a reader can actually SIT on is "you are in no space yet" — which is a fact about
    // spaces, and belongs on the page that explains them.
    '/': 'wikistead-docs/src/content/docs/guides/spaces.md',
    '/p/:pageId': 'wikistead-docs/src/content/docs/guides/pages.md',
    '/spaces/:spaceId': 'wikistead-docs/src/content/docs/guides/spaces.md',
    '/pub/space/:spaceId': 'wikistead-docs/src/content/docs/publishing/public-spaces.md',
    '/pub/:pageId': 'wikistead-docs/src/content/docs/publishing/public-spaces.md',
    '/share/:linkId': 'wikistead-docs/src/content/docs/guides/share-links.md',
    '/invite': 'wikistead-docs/src/content/docs/admin/members.md',
    '/reset-password': 'wikistead-docs/src/content/docs/guides/sign-in.md',
    '/templates': 'wikistead-docs/src/content/docs/guides/templates.md',
    '/changes': 'wikistead-docs/src/content/docs/guides/recent-changes.md',
    '/watches': 'wikistead-docs/src/content/docs/guides/notifications.md',
    '/admin/*': 'wikistead-docs/src/content/docs/admin/index.md', // per-tab pages ride the admin-surface registry above
    '/settings/account/*': 'wikistead-docs/src/content/docs/settings/account.md',
    '/spaces/:spaceId/settings/*': 'wikistead-docs/src/content/docs/guides/space-settings.md',
    '/settings/members': 'none: redirect to /admin/members, not a screen',
    '/join': 'wikistead-docs/src/content/docs/guides/sign-in.md',
    '/join/workspace': 'wikistead-docs/src/content/docs/guides/sign-in.md',
    '/login': 'wikistead-docs/src/content/docs/guides/sign-in.md',
    '/login/recovery': 'wikistead-docs/src/content/docs/guides/sign-in.md',
    '*': 'none: catch-all redirect to the demo page, not a screen',
  },
  // #729 / ADR-235: CAPABILITIES — things the product can do that a user can observe, which are not
  // a screen, a macro or an admin tab. The importer was the worked example: three dialects shipped
  // and no guard asked for a word about them, because it is not a surface anybody registers.
  //
  // The ids come from the code (the MCP tool table, the importer's adapter table), never from a list
  // written here — a hand list has the same blind spot as the gap it is closing.
  //
  // Several ids share a page ON PURPOSE (ruling §3): eleven MCP tools do not become eleven
  // stubs. What the ledger requires is that every capability is ACCOUNTED FOR, not that it has a
  // page of its own.
  capability: {
    'mcp:list_spaces': 'wikistead-docs/src/content/docs/integrations/mcp.md',
    'mcp:list_pages': 'wikistead-docs/src/content/docs/integrations/mcp.md',
    'mcp:get_page': 'wikistead-docs/src/content/docs/integrations/mcp.md',
    'mcp:get_backlinks': 'wikistead-docs/src/content/docs/integrations/mcp.md',
    'mcp:search': 'wikistead-docs/src/content/docs/integrations/mcp.md',
    'mcp:get_syntax_reference': 'wikistead-docs/src/content/docs/integrations/mcp.md',
    'mcp:create_page': 'wikistead-docs/src/content/docs/integrations/mcp.md',
    'mcp:publish_page': 'wikistead-docs/src/content/docs/integrations/mcp.md',
    'mcp:edit_body': 'wikistead-docs/src/content/docs/integrations/mcp.md',
    'mcp:create_comment': 'wikistead-docs/src/content/docs/integrations/mcp.md',
    // The importer's dialects (IMPORT_ADAPTERS). One page covers what each one carries and what it
    // degrades — the thing #712 shipped three of without a word anywhere.
    'import:native': 'none: this product\'s own export, described by the export page it round-trips with',
    'import:obsidian': 'wikistead-docs/src/content/docs/guides/import.md',
    'import:notion': 'wikistead-docs/src/content/docs/guides/import.md',
    'import:confluence': 'wikistead-docs/src/content/docs/guides/import.md',
    // #734 / ADR-237 §2.1: the second factors. They were a TYPE and a database constraint, which no
    // walk can read, so a third kind could have shipped with nobody noticing the page said nothing
    // about it. The kinds and the recovery path are enumerated at run time now, and land on the
    // account page — the screen a member actually uses to enrol them.
    'factor:totp': 'wikistead-docs/src/content/docs/settings/account.md',
    'factor:passkey': 'wikistead-docs/src/content/docs/settings/account.md',
    'factor:recovery-code': 'wikistead-docs/src/content/docs/settings/account.md',
  },
}

/**
 * Evaluate the surface ledger against what the registries actually contain.
 * `discovered` is `{ [registry]: string[] }` — produced by the discovery tests, never by hand.
 * Violations, both directions:
 *   - a discovered surface with no ledger row (the "new feature, no docs" case);
 *   - a ledger row whose surface no longer exists (stale coverage claim);
 *   - an empty walk for a claimed registry (vacuity — a broken walk must not read as covered);
 *   - a registry the ledger does not know at all.
 */
export function evaluateSurfaceDocs(discovered, ledger = SURFACE_DOCS) {
  const violations = []
  for (const [registry, ids] of Object.entries(discovered)) {
    const rows = ledger[registry]
    if (!rows) {
      violations.push({ registry, id: null, why: 'registry has no ledger section at all' })
      continue
    }
    if (ids.length === 0) {
      violations.push({ registry, id: null, why: 'the registry walk came back empty — the walk broke (vacuity), this is not "all covered"' })
      continue
    }
    for (const id of ids) {
      if (!(id in rows)) violations.push({ registry, id, why: 'registered surface has no docs binding — add a row (a page, or none:<reason>)' })
    }
    for (const id of Object.keys(rows)) {
      if (!ids.includes(id)) violations.push({ registry, id, why: 'ledger row names a surface the registry no longer has — stale, remove or rename it' })
    }
  }
  return violations
}

// Evaluate the linkage against a set of changed files. Returns one violation per map
// entry whose code region changed but whose docs page did NOT — i.e. code and docs were
// decoupled in this change.
export function evaluateDocLinks(changedFiles, map = DOC_CODE_MAP) {
  const changed = new Set(changedFiles)
  const violations = []
  for (const entry of map) {
    const changedCode = changedFiles.filter((f) => matchesAny(f, entry.code))
    if (changedCode.length === 0) continue // region untouched → nothing to bind
    if (changed.has(entry.doc)) continue // doc moved with the code → ok
    violations.push({ label: entry.label, kind: entry.kind, doc: entry.doc, changedCode })
  }
  return violations
}
