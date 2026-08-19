// #747: the ELEMENT-BY-ELEMENT record of what an import keeps, converts, and cannot carry.
//
// The documentation promised a table and had none, and the obvious way to write one is by hand —
// which is the way that is true on the day it is written and quietly false from the next adapter
// change onward. So the table is MEASURED: every row here is pushed through the shipped import path
// (`importArchive`, the function the route calls) and the resulting page body and fidelity report
// become the row's answer. What is authored is only the QUESTION — a name for the construct and the
// snippet a source tool actually writes. What happens to it is never authored.
//
// One case is one page in one archive: the smallest unit that still travels the whole path, and the
// same shape #712 used when it measured 95 elements by hand. Cases that need a neighbour (a
// link target, an attached file) declare it in `support`, which is shared by the whole source.
//
// SCOPE, stated so the table cannot be read as more than it is: this covers the constructs where
// something INTERESTING happens — a conversion, a loss, a report. Ordinary Markdown (headings,
// emphasis, lists, tables, code fences, quotes, links, footnotes) travels unchanged through all
// three sources and is not enumerated here; #712 measured that separately across 95 elements
// and the three adapter suites pin it. A row per unchanged construct would be a hundred rows saying
// "nothing happened", and the reader who needs this table needs the other hundred.

/** One construct, as the source tool writes it. The answer is measured, never written here. */
export interface FidelityCase {
  /** stable join key: the documentation pages carry their own wording against this id */
  id: string
  /** the construct's name, in English — the documentation's own locale wording joins on `id` */
  element: string
  /** the snippet, exactly as the exporting tool emits it */
  input: string
  /** extra files this one case needs inside the archive (bytes are declared as latin-1 text) */
  extra?: Record<string, string>
  /** where the snippet lands, when the construct IS the file rather than something inside one */
  path?: string
  /**
   * The name the fidelity report files this case's degradations under, when it is not the page's
   * own title. A `.canvas` is reported under the file name and a Notion database under the database
   * name, because neither of those is the page the reader was reading.
   */
  node?: string
  /** false when the construct produces no page at all — the answer is the report, and that is a row */
  producesPage?: false
}

export interface FidelitySource {
  id: 'obsidian' | 'notion' | 'confluence'
  /** the product being migrated FROM, as its own vendor spells it */
  name: string
  /** files every case needs: link targets, an attachment, whatever makes the archive that dialect */
  support: Record<string, string>
  /** where a case's snippet lands in the archive */
  pathFor: (c: FidelityCase) => string
  cases: FidelityCase[]
}

// ── Obsidian ─────────────────────────────────────────────────────────────────
// A vault is bare `.md` files plus an attachment folder; `prepareImport` falls through to this
// dialect when nothing else claims the archive and there is no manifest.
const OBSIDIAN: FidelitySource = {
  id: 'obsidian',
  name: 'Obsidian',
  support: {
    // The link target every wikilink case points at, and one attachment to embed.
    'Runbook.md': '# Runbook\n\n## Rollback\n\nStop the writer first.\n',
    'attachments/diagram.png': '\x89PNG\r\n\x1a\n\x01\x02\x03\x04',
  },
  pathFor: (c) => `${c.id}.md`,
  cases: [
    { id: 'wikilink', element: 'Wikilink', input: 'See [[Runbook]].' },
    { id: 'wikilink-label', element: 'Wikilink with a label', input: 'See [[Runbook|the runbook]].' },
    { id: 'wikilink-path', element: 'Wikilink written as a path', input: 'See [[Runbook]] from a folder.' },
    { id: 'wikilink-heading', element: 'Wikilink to a heading', input: 'See [[Runbook#Rollback]].' },
    { id: 'wikilink-block', element: 'Wikilink to a block reference', input: 'See [[Runbook#^decision1]].' },
    { id: 'wikilink-dead', element: 'Wikilink to a note that is not in the export', input: 'See [[Deleted note]].' },
    // #728 / ADR-242 §3. A vault can write this, and so does every Docmost export — which lands on
    // this dialect, because nothing else claims an archive with no manifest. The link is not rewritten
    // (that is what the Docmost dialect is for); the row exists so the table says so out loud.
    { id: 'page-link-as-path', element: 'Link to another page written as a file path', input: 'See [the runbook](Runbook.md).' },
    { id: 'embed-image', element: 'Embedded image', input: 'Here it is: ![[diagram.png]]' },
    { id: 'embed-image-size', element: 'Embedded image with a display size', input: 'Here it is: ![[diagram.png|300]]' },
    { id: 'embed-note', element: 'Embedded note', input: 'Here it is: ![[Runbook]]' },
    { id: 'callout', element: 'Callout', input: '> [!warning] Careful\n> The writer must stop first.\n' },
    { id: 'callout-mapped', element: 'Callout of a type this product does not have', input: '> [!question] Why\n> Because.\n' },
    { id: 'callout-collapsed', element: 'Collapsed callout', input: '> [!note]- Hidden\n> Shown anyway.\n' },
    { id: 'dataview', element: 'Dataview query', input: '```dataview\nLIST FROM #index\n```\n' },
    { id: 'dataview-inline', element: 'Inline Dataview expression', input: 'Due `=this.due` today.\n' },
    { id: 'comment', element: 'Comment', input: 'Visible. %%and a private aside%%\n' },
    { id: 'block-id', element: 'Block identifier', input: 'We chose Postgres. ^decision1\n' },
    { id: 'frontmatter-tags', element: 'Frontmatter tags', input: '---\ntags: [index, vault]\n---\n\nBody.\n' },
    {
      id: 'canvas',
      element: 'Canvas file',
      input: '{"nodes":[],"edges":[]}',
      path: 'Board.canvas',
      node: 'Board.canvas',
      producesPage: false,
    },
    {
      id: 'excalidraw',
      element: 'Excalidraw drawing',
      input: '## Drawing\n\n```json\n{"type":"excalidraw","elements":[],"appState":{}}\n```\n',
      path: 'Sketch.excalidraw.md',
      node: 'Sketch.excalidraw',
    },
    {
      id: 'excalidraw-unreadable',
      element: 'Excalidraw drawing this product cannot read',
      input: '## Drawing\n\n```json\n{not json at all\n```\n',
      path: 'Torn.excalidraw.md',
      node: 'Torn.excalidraw',
    },
    {
      id: 'excalidraw-compressed',
      element: 'Excalidraw drawing saved in the compressed format',
      input: '## Drawing\n\n```compressed-json\nN4IgLg\n```\n',
      path: 'Packed.excalidraw.md',
      node: 'Packed.excalidraw',
    },
  ],
}

// ── Notion ───────────────────────────────────────────────────────────────────
// Notion names every export file `Title <32 hex>`; that suffix is what its own links point at, so it
// is both the dialect's fingerprint and the key link resolution runs on.
const N_HEX = '2a2b3c4d5e6f70819293a4b5c6d7e8f9'
const NOTION: FidelitySource = {
  id: 'notion',
  name: 'Notion',
  support: {
    [`Runbook ${N_HEX}.md`]: '# Runbook\n\nStop the writer first.\n',
    [`Runbook ${N_HEX}/diagram.png`]: '\x89PNG\r\n\x1a\n\x01\x02\x03\x04',
  },
  pathFor: (c) => `${c.id} ${hexFor(c.id)}.md`,
  cases: [
    {
      // The construct here is the FILE NAME, so the case names the file and the measured page title
      // is the answer: Notion's 32-hex suffix is what a reader most wants to know the fate of.
      id: 'title-hex',
      element: 'Page title with its id suffix',
      input: 'Just a page.\n',
      path: `Getting started ${hexFor('title-hex')}.md`,
      node: 'Getting started',
    },
    { id: 'internal-link', element: 'Link to another exported page', input: `Read the [Runbook](Runbook%20${N_HEX}.md).\n` },
    { id: 'image', element: 'Image stored beside the page', input: `![diagram](Runbook%20${N_HEX}/diagram.png)\n` },
    { id: 'dead-link', element: 'Link to a page that is not in the export', input: 'Read the [Archive](Archive%20ffffffffffffffffffffffffffffffff.md).\n' },
    { id: 'raw-html', element: 'Callout and toggle blocks', input: '<aside>A callout Notion wrote as HTML.</aside>\n\n<details><summary>More</summary>Body.</details>\n' },
    {
      id: 'database',
      element: 'Database',
      input: 'Name,Status\nShip it,Doing\nWrite docs,Todo\n',
      path: `Tasks ${'b1'.repeat(16)}_all.csv`,
      node: 'Tasks',
    },
  ],
}

// ── Confluence ───────────────────────────────────────────────────────────────
// The HTML export, and only that: ADR-227 ruling 2 keeps the XML backup and the REST API out of
// scope, so the archive shape here is the one the product actually reads.
const CONFLUENCE: FidelitySource = {
  id: 'confluence',
  name: 'Confluence',
  support: {
    'index.html': '<html><body><div id="main-content"><p>Space index.</p></div></body></html>',
    'Runbook.html': '<html><body><div id="main-content"><h1>Runbook</h1><p>Stop the writer first.</p></div></body></html>',
    'attachments/diagram.png': '\x89PNG\r\n\x1a\n\x01\x02\x03\x04',
  },
  pathFor: (c) => `${c.id}.html`,
  cases: [
    { id: 'code-macro', element: 'Code macro', input: page('<div class="code panel"><pre class="brush: bash">npm run build</pre></div>') },
    { id: 'info-macro', element: 'Info macro', input: page('<div class="confluence-information-macro confluence-information-macro-information"><p>Worth knowing.</p></div>') },
    { id: 'warning-macro', element: 'Warning macro', input: page('<div class="confluence-information-macro confluence-information-macro-warning"><p>Be careful.</p></div>') },
    { id: 'toc-macro', element: 'Table of contents macro', input: page('<div data-macro-name="toc"></div>') },
    { id: 'unknown-macro', element: 'Macro this product has no equivalent for', input: page('<div data-macro-name="jira"><p>ENG-1</p></div>') },
    { id: 'storage-format', element: 'Storage-format markup left in the export', input: page('<ac:structured-macro ac:name="jira"><ac:parameter>ENG-1</ac:parameter></ac:structured-macro>') },
    { id: 'task-list', element: 'Task list', input: page('<ul class="inline-task-list"><li class="checked">Shipped</li><li>Not yet</li></ul>') },
    { id: 'strike', element: 'Struck-through text', input: page('<p>The old plan is <s>still on</s> cancelled.</p>') },
    { id: 'page-link', element: 'Link to another exported page', input: page('<p>Read the <a href="Runbook.html">Runbook</a>.</p>') },
    { id: 'dead-page-link', element: 'Link to a page that is not in the export', input: page('<p>Read the <a href="Archive.html">Archive</a>.</p>') },
    { id: 'image', element: 'Attached image', input: page('<p><img src="attachments/diagram.png" alt="diagram"></p>') },
    { id: 'file-link', element: 'Link to an attached file', input: page('<p>The <a href="attachments/paper.pdf">paper</a>.</p>') },
    { id: 'emoji', element: 'Emoji', input: page('<p>Ship it <img class="emoticon" src="https://old.example/images/icons/emoticons/smile.png" alt="smile"></p>') },
    // #712 ④ split this row in two. A mapped emoticon becomes the character and loses nothing;
    // one outside the table keeps the older fallback (its name, and a report). Both need a case, or the
    // table shows only the happy half and the discovery walk loses its only example of that report.
    { id: 'emoji-unmapped', element: 'Emoji with no Unicode equivalent', input: page('<p>Nice <img class="emoticon" src="https://old.example/images/icons/emoticons/party-parrot.png" alt="party-parrot"></p>') },
    { id: 'merged-cells', element: 'Table with merged cells', input: page('<table><tr><td colspan="2">One and two</td><td>Three</td></tr></table>') },
  ],
}

function page(body: string): string {
  return `<html><body><div id="main-content">${body}</div></body></html>`
}

/** A per-case 32-hex id: Notion's own file naming, and what its links resolve against. */
function hexFor(id: string): string {
  let h = ''
  for (let i = 0; i < id.length; i++) h += id.charCodeAt(i).toString(16).padStart(2, '0')
  return (h + '0'.repeat(32)).slice(0, 32)
}

export const FIDELITY_SOURCES: readonly FidelitySource[] = [OBSIDIAN, NOTION, CONFLUENCE]
