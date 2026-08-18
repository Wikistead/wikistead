// #712 / ADR-227 §4 + §8 — the Obsidian dialect, measured on a vault rather than on the adapter's
// own vocabulary.
//
// The fixture is a REAL vault layout (the ticket's acceptance: " round-trip
// ——"): notes at the root and in folders, an attachment folder, a
// `.canvas` file, a Dataview block, `%%comments%%`, and the four wikilink shapes a vault actually
// contains. It is zipped in memory and pushed through the SHIPPED path — `importArchive`, the same
// function the route calls — so what is measured is the import a user gets, not a unit's idea of it.
//
// The degradation assertions are the point of this ticket. A migration tool that silently drops
// things is the failure mode the ADR names, so each unrepresentable shape must appear in the report
// BY NAME, and that is asserted rather than assumed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/tenant-db.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { importArchive } from '../import/index.js'
import { rewriteWikilinks, detectVaultDegradations, canvasDegradations, noteNameOf } from '../import/obsidian.js'
import { LogicalSearchDriver } from '../search/index.js'
import { LogicalStorageDriver } from '../storage/index.js'
import { privateTenant } from './helpers/private-tenant.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)

// ── the vault ────────────────────────────────────────────────────────────────
// Written the way Obsidian writes one: bare `.md` at the root, a folder for a section, an
// `attachments/` directory, and links that point across all of it.
const VAULT: Record<string, Uint8Array> = {
  'Home.md': strToU8([
    '---',
    'tags: [index, vault]',
    '---',
    '',
    '# Home',
    '',
    'Start at [[Meeting notes]] or the [[Projects/Roadmap|roadmap]].',
    'A section link: [[Meeting notes#Decisions]].',
    'An embedded picture: ![[diagram.png]]',
    'An embedded NOTE: ![[Meeting notes]]',
    'A link to something that left the vault: [[Deleted note]].',
    '',
    '```dataview',
    'LIST FROM #index',
    '```',
    '',
    '%%a private aside%%',
    '',
  ].join('\n')),
  'Meeting notes.md': strToU8('# Meeting notes\n\n## Decisions\n\nWe chose Postgres.\n'),
  'Projects/Roadmap.md': strToU8('# Roadmap\n\nBack to [[Home]].\n'),
  'attachments/diagram.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]),
  'Board.canvas': strToU8('{"nodes":[],"edges":[]}'),
}

let db: TenantDb
let dispose: () => Promise<void>
let TENANT: string
let SPACE: string
const USER = 'dev-user'

beforeAll(async () => {
  const t = await privateTenant(admin, 'obs712')
  TENANT = t.id
  dispose = t.dispose
  db = await acquireTenantDb({ id: TENANT, slug: t.slug, plan: 'free', isolation: 'logical' } as never)
  const [space] = await db.sql<{ id: string }[]>`
    INSERT INTO spaces (id, tenant_id, name)
    VALUES (gen_random_uuid()::text, ${TENANT}, 'Vault target') RETURNING id`
  SPACE = space!.id
  // The tenant slug is fixed, so a run that died before afterAll leaves its pages behind — and the
  // body assertions below would then read the PREVIOUS import's text and fail in a way that looks
  // like a rewriting bug (measured: exactly that, for one confusing round). Start from an empty space.
  await admin`DELETE FROM pages WHERE tenant_id = ${TENANT}`
  await writeTuples(fgaClient, [
    { user: `user:${USER}`, relation: 'editor_member', object: `space:${SPACE}` },
    { user: `user:${USER}`, relation: 'manager', object: `space:${SPACE}` },
  ])
}, 120_000)

afterAll(async () => {
  await deleteTuples(fgaClient, [
    { user: `user:${USER}`, relation: 'editor_member', object: `space:${SPACE}` },
    { user: `user:${USER}`, relation: 'manager', object: `space:${SPACE}` },
  ]).catch(() => {})
  await db?.release()
  await dispose?.()
  await admin.end()
  await pool.end()
})

async function importVault() {
  return importArchive(
    { db, fga: fgaClient, storage: new LogicalStorageDriver(), driver: new LogicalSearchDriver() },
    zipSync(VAULT),
    { tenantId: TENANT, spaceId: SPACE, userId: USER, plan: 'free' },
  )
}

describe('#712: an Obsidian vault imports through the shipped path', () => {
  it('creates a page per note, resolves wikilinks, and names everything it could not represent', async () => {
    const report = await importVault()

    // Three notes; the .canvas is not a page and the attachment is not a page.
    expect(report.pagesCreated, 'one page per note').toBe(3)

    const rows = await db.sql<{ title: string; ydoc: Buffer }[]>`
      SELECT title, ydoc FROM pages WHERE tenant_id = ${TENANT} ORDER BY title`
    const bodyOf = async (title: string) => {
      const Y = await import('yjs')
      const row = rows.find((r) => r.title === title)
      expect(row, `page "${title}" exists`).toBeTruthy()
      const doc = new Y.Doc()
      Y.applyUpdate(doc, new Uint8Array(row!.ydoc))
      return doc.getText('content').toString()
    }
    const home = await bodyOf('Home')
    const idOf = async (title: string) => {
      const [r] = await db.sql<{ id: string }[]>`SELECT id FROM pages WHERE tenant_id = ${TENANT} AND title = ${title}`
      return r!.id
    }

    // [[Meeting notes]] and [[Projects/Roadmap|roadmap]] resolve to the pages that were created.
    expect(home, 'plain wikilink resolved').toContain(`[Meeting notes](/p/${await idOf('Meeting notes')})`)
    expect(home, 'labelled wikilink keeps its label').toContain(`[roadmap](/p/${await idOf('Roadmap')})`)

    // The heading anchor is dropped — and SAID so, which is the half that makes it acceptable.
    expect(home, 'the anchor is not carried into a link we cannot guarantee').not.toContain('#Decisions')
    expect(report.degraded.map((d) => d.what), 'the dropped anchor is reported')
      .toContain('wikilink heading anchor dropped')

    // ![[diagram.png]] became the attachment; ![[Meeting notes]] became a link + a degradation.
    expect(home, 'file embed became the attachment').toMatch(/!\[diagram\.png\]\(wks-attachment:[^)]+\)/)
    expect(report.degraded.map((d) => d.what), 'note embed degraded to a link, and said so')
      .toContain('note embed became a link')

    // A link out of the vault is left alone and counted — never rewritten to a guess.
    expect(home, 'the unresolvable link keeps its text').toContain('[[Deleted note]]')
    expect(report.deadCrossLinks, 'and it is counted').toBeGreaterThan(0)

    // Frontmatter passes through untouched: Obsidian's tags ARE this product's tags (ADR-145).
    expect(home, 'tags survive as the product reads them').toContain('tags: [index, vault]')

    // The shapes with no representation are each named.
    const what = report.degraded.map((d) => d.what)
    expect(what, 'dataview').toContain('Dataview query kept as source')
    expect(what, 'obsidian comment').toContain('Obsidian comment (%%…%%) kept as text')
    expect(what, 'canvas').toContain('Canvas file not imported')

    // Nothing is published by import (ADR-132 §5's draft-first rule still holds through the adapter).
    expect(report.published).toBe(0)
  }, 180_000)
})

// ── the pure transforms, at the edges the integration test cannot reach cheaply ──
describe('#712: the dialect rules, as functions', () => {
  const resolve = {
    hrefByName: new Map([['note', '/p/n1'], ['other', '/p/n2']]),
    embedByName: new Map([['pic.png', '![pic.png](wks-attachment:a1)']]),
  }
  const node = { title: 'T' }

  it('an embed of a FILE inlines the attachment; an embed of a NOTE becomes a link and is reported', () => {
    const file = rewriteWikilinks('![[pic.png]]', node, resolve)
    expect(file.markdown).toBe('![pic.png](wks-attachment:a1)')
    expect(file.degraded).toEqual([])

    const note = rewriteWikilinks('![[Note]]', node, resolve)
    expect(note.markdown).toBe('[Note](/p/n1)')
    expect(note.degraded[0]?.what).toBe('note embed became a link')
  })

  it('matching is case-insensitive, the way the vault itself resolves', () => {
    expect(rewriteWikilinks('[[NOTE]]', node, resolve).markdown).toBe('[NOTE](/p/n1)')
  })

  it('an unresolvable embed is left verbatim and counted, not turned into a broken image', () => {
    const r = rewriteWikilinks('![[missing.png]]', node, resolve)
    expect(r.markdown).toBe('![[missing.png]]')
    expect(r.deadLinks).toBe(1)
  })

  it('a note name is the basename, so folder depth does not change what [[…]] refers to', () => {
    expect(noteNameOf('Projects/Roadmap')).toBe('Roadmap')
    expect(noteNameOf('Roadmap')).toBe('Roadmap')
  })

  it('detectVaultDegradations reports dataview and comments, and stays quiet on ordinary prose', () => {
    expect(detectVaultDegradations({ title: 'T', markdown: 'just text\n' })).toEqual([])
    const noisy = detectVaultDegradations({ title: 'T', markdown: '```dataview\nLIST\n```\n%%x%%\n' })
    expect(noisy.map((d) => d.what)).toEqual(['Dataview query kept as source', 'Obsidian comment (%%…%%) kept as text'])
  })

  it('canvasDegradations names each .canvas file and ignores everything else', () => {
    expect(canvasDegradations(['a.canvas', 'b.md', 'c.CANVAS']).map((d) => d.node)).toEqual(['a.canvas', 'c.CANVAS'])
  })
})

// ── #712/the silences and the mislabelled reports ────────────────────────────────
//
// The independent verification's second family: things that were LOST and said nothing, and things
// that were reported under the wrong name. A report that names the wrong loss is worse than one that
// names none, because the reader stops looking.
describe('#712H: a vault callout becomes this product\'s callout', () => {
  it('converts the type and the title, and reports only what genuinely has no equivalent', async () => {
    const { convertVaultCallouts } = await import('../import/obsidian.js')
    const warn = convertVaultCallouts('> [!warning] Careful\n> mind the gap\n', { title: 'N' })
    expect(warn.markdown, 'the product\'s own notation').toContain(':::warning[Careful]')
    expect(warn.markdown, 'the body survives').toContain('mind the gap')
    expect(warn.markdown, 'and no foreign notation is left on screen').not.toContain('[!warning]')
    expect(warn.degraded, 'a type with an equivalent is not a degrade').toEqual([])

    // A type this product does not have folds onto `note` — and SAYS so.
    const bug = convertVaultCallouts('> [!bug] Known issue\n> it crashes\n', { title: 'N' })
    expect(bug.markdown).toContain(':::danger[Known issue]')

    const quote = convertVaultCallouts('> [!question] Why\n> because\n', { title: 'N' })
    expect(quote.markdown).toContain(':::note[Why]')
    expect(quote.degraded.map((d) => d.what).join(' '), 'the lost distinction is named').toMatch(/question/)

    // A collapsed callout opens here, which the reader should be told.
    const folded = convertVaultCallouts('> [!note]- Hidden\n> body\n', { title: 'N' })
    expect(folded.degraded.map((d) => d.what).join(' ')).toMatch(/collaps/i)

    // An ordinary quote is left completely alone.
    const plain = convertVaultCallouts('> just a quote\n', { title: 'N' })
    expect(plain.markdown).toBe('> just a quote\n')
    expect(plain.degraded).toEqual([])
  })
})

describe('#712the report names what was actually lost', () => {
  it('calls a block reference a block reference, and keeps the fragment in the detail', async () => {
    const { rewriteWikilinks } = await import('../import/obsidian.js')
    const hrefByName = new Map([['runbook', '/p/abc']])
    const embedByName = new Map<string, string>()

    const blockRef = rewriteWikilinks('see [[Runbook#^decision1]]', { title: 'N' }, { hrefByName, embedByName })
    expect(blockRef.degraded[0]?.what, 'not "heading anchor"').toMatch(/block reference/)
    expect(blockRef.degraded[0]?.detail, 'and the reader can see which one').toContain('#^decision1')

    const heading = rewriteWikilinks('see [[Runbook#Rollback]]', { title: 'N' }, { hrefByName, embedByName })
    expect(heading.degraded[0]?.what).toMatch(/heading anchor/)

    // An EMBED of a section: the note is reported, and so is the section that was the point of it.
    const embed = rewriteWikilinks('![[Runbook#Rollback]]', { title: 'N' }, { hrefByName, embedByName })
    expect(embed.degraded[0]?.detail, 'the dropped section appears in the detail').toContain('#Rollback')
  })

  it('reports a dropped image size, an inline Dataview expression and a stray block id', async () => {
    const { rewriteWikilinks, detectVaultDegradations } = await import('../import/obsidian.js')
    const sized = rewriteWikilinks('![[pic.png|300]]', { title: 'N' }, {
      hrefByName: new Map(), embedByName: new Map([['pic.png', '![pic.png](wks-attachment:1)']]),
    })
    expect(sized.markdown, 'the picture still arrives').toContain('wks-attachment:1')
    expect(sized.degraded.map((d) => d.what).join(' '), 'the sizing is not silently dropped').toMatch(/size|caption/)

    const shapes = detectVaultDegradations({ title: 'N', markdown: 'total `=this.file.size` bytes\n\nA paragraph. ^blk9\n' })
    const said = shapes.map((d) => d.what).join(' | ')
    expect(said, 'the inline Dataview form is reported like the fenced one').toMatch(/inline Dataview/)
    expect(said, 'and the block id residue is named').toMatch(/block identifier/)
  })
})

describe('#712G/H: the last of the silences', () => {
  it('turns an Excalidraw note into a drawing, and reports the one it cannot read', async () => {
    const { convertExcalidrawNote, isExcalidrawNote } = await import('../import/obsidian.js')
    expect(isExcalidrawNote('Sketch.excalidraw.md')).toBe(true)
    expect(isExcalidrawNote('Notes.md')).toBe(false)

    const scene = '{"elements":[],"appState":{}}'
    const parsed = convertExcalidrawNote(
      `# Excalidraw Data\n\n## Drawing\n\`\`\`json\n${scene}\n\`\`\`\n`, { title: 'Sketch' })
    expect(parsed.markdown, 'the product renders it as a drawing').toContain('```excalidraw')
    expect(parsed.markdown, 'and the scene is the note\'s own').toContain('"elements"')
    expect(parsed.degraded, 'a drawing that arrives is not a degrade').toEqual([])

    // The plugin's compressed variant cannot be read here — reported, not left as an unexplained blob.
    const compressed = convertExcalidrawNote('## Drawing\n```compressed-json\nN4Ig…\n```\n', { title: 'Sketch' })
    expect(compressed.degraded.map((d) => d.what).join(' ')).toMatch(/compressed/)
    expect(compressed.markdown, 'the source is kept rather than thrown away').toContain('compressed-json')
  })

  it('reports raw HTML blocks a Notion export leaves in the Markdown', async () => {
    const { detectVaultDegradations } = await import('../import/obsidian.js')
    const said = detectVaultDegradations({
      title: 'N', markdown: '<aside>note to self</aside>\n\n<details><summary>more</summary>body</details>\n',
    }).map((d) => `${d.what} ${d.detail ?? ''}`).join(' | ')
    expect(said, 'the reader is told the markup is showing').toMatch(/raw HTML/)
    expect(said).toMatch(/aside/)
  })
})
