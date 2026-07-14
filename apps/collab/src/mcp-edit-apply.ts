// #369 / ADR-144: pure body-edit semantics for the MCP `edit_body` tool. Given the CURRENT canonical text
// (the Y.Text string) and an edit operation, compute the SINGLE offset-invariant Y.Text transaction
// (one delete range + one insert) that realises it — so the caller applies it as one real CRDT op and remote
// carets re-anchor / concurrent edits merge (the single-Y.Text invariant, the project design notes / ADR-025).
//
// v1 operations (user-approved granularity — NO full-body replace):
//   - append:          add a block at the END of the document.
//   - replace_section: replace one heading's section (the heading line through just before the next heading of
//                      the SAME-OR-HIGHER level, or EOF) with new markdown. The caller supplies the whole new
//                      section (including its heading line if it wants to keep one).
//
// This module is PURE (no Yjs, no I/O) so it is unit-testable and identical whether the edit is applied to a
// resident live doc or a headless openDirectConnection load. The collab handler turns the returned {from,
// deleteCount, insert} into `ytext.delete(from, deleteCount); ytext.insert(from, insert)` in one transaction.

export type EditOp =
  | { op: 'append'; content: string }
  | { op: 'replace_section'; heading: string; content: string }

// The wire payload the HTTP API publishes on `wks:mcpedit:<docName>` (JSON). It carries the CONTENT body, so
// it is a bigger trust surface than flush/restore (which carry only a trigger) — hence tenant + resolved
// principal + a size cap travel WITH it, and the collab pod re-checks `edit` on `user` before applying
// (two-sided authz, ADR-144 §3). `sizeCap` is the API-declared max content length (defense-in-depth).
export interface McpEditRequest {
  reqId: string
  tenant: string
  user: string // "user:<sub>" — the principal to re-authorize on the pod side
  op: EditOp
  sizeCap: number
}

// Parse + validate the wire payload. Throws EditApplyError on any malformed field (the handler maps that to a
// rejected ack — never applies a half-understood request to the canonical doc). Enforces the size cap here so
// an oversized body is refused before it touches the Y.Text.
export function parseMcpEditRequest(raw: string): McpEditRequest {
  let j: unknown
  try { j = JSON.parse(raw) } catch { throw new EditApplyError('malformed request') }
  if (!j || typeof j !== 'object') throw new EditApplyError('malformed request')
  const o = j as Record<string, unknown>
  const reqId = o.reqId, tenant = o.tenant, user = o.user, opName = o.op, content = o.content, sizeCap = o.sizeCap
  if (typeof reqId !== 'string' || !reqId) throw new EditApplyError('missing reqId')
  if (typeof tenant !== 'string' || !tenant) throw new EditApplyError('missing tenant')
  if (typeof user !== 'string' || !user.startsWith('user:')) throw new EditApplyError('missing user')
  if (typeof content !== 'string') throw new EditApplyError('missing content')
  if (typeof sizeCap !== 'number' || sizeCap <= 0) throw new EditApplyError('missing sizeCap')
  if (content.length > sizeCap) throw new EditApplyError('content exceeds size limit')
  let op: EditOp
  if (opName === 'append') op = { op: 'append', content }
  else if (opName === 'replace_section') {
    if (typeof o.heading !== 'string' || !o.heading.trim()) throw new EditApplyError('heading is required for replace_section')
    op = { op: 'replace_section', heading: o.heading, content }
  } else throw new EditApplyError('unknown op')
  return { reqId, tenant, user, op, sizeCap }
}

export interface EditPlan {
  from: number // offset where the edit starts
  deleteCount: number // characters to delete at `from` (0 for a pure insert)
  insert: string // text to insert at `from`
}

// A tool-visible failure (e.g. section not found). The collab handler maps this to a rejected ack; the HTTP
// tool surfaces it as an MCP tool error. Never leaks internals.
export class EditApplyError extends Error {}

// An ATX heading line: leading #'s (1-6) + space + text. We match on the LINE (Markdown headings are
// line-anchored). Setext headings (=== / ---) are not targeted by replace_section in v1 (rare; append still
// works, and a caller can replace_section on an ATX heading). Fenced-code lines that look like headings are
// NOT excluded in v1 — a pragmatic limit noted for the caller; append is always safe.
interface HeadingHit { index: number; level: number; text: string }

function scanHeadings(text: string): HeadingHit[] {
  const hits: HeadingHit[] = []
  let offset = 0
  for (const line of text.split('\n')) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (m) hits.push({ index: offset, level: m[1]!.length, text: m[2]!.trim() })
    offset += line.length + 1 // + '\n'
  }
  return hits
}

// Normalise a heading for matching: trim, collapse inner whitespace, case-insensitive. So `replace_section` can
// target "Getting Started" whether the caller passes that, "getting started", or "  Getting  Started ".
const normHeading = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

export function planBodyEdit(current: string, op: EditOp): EditPlan {
  if (op.op === 'append') {
    const content = op.content
    if (!content.trim()) throw new EditApplyError('content is empty')
    // Append at EOF; separate from existing content by a blank line. If the doc is empty, no leading newlines.
    const trimmedEnd = current.replace(/\s+$/, '')
    const insert = trimmedEnd.length === 0 ? content : `\n\n${content}`
    return { from: trimmedEnd.length, deleteCount: current.length - trimmedEnd.length, insert }
  }
  // replace_section
  const target = normHeading(op.heading)
  if (!target) throw new EditApplyError('heading is required')
  if (!op.content.trim()) throw new EditApplyError('content is empty')
  const headings = scanHeadings(current)
  const startIdx = headings.findIndex((h) => normHeading(h.text) === target)
  if (startIdx === -1) throw new EditApplyError(`section not found: ${op.heading}`)
  const start = headings[startIdx]!
  // The section ends at the next heading of the SAME OR HIGHER level (i.e. level <= this one); a deeper
  // sub-heading is PART of this section. If none follows, the section runs to EOF.
  const end = headings.slice(startIdx + 1).find((h) => h.level <= start.level)
  const from = start.index
  const to = end ? end.index : current.length
  // Normalise the replacement to end with exactly one newline before the next section (unless it runs to EOF),
  // so replacing a middle section never fuses into the following heading.
  let insert = op.content.replace(/\s+$/, '')
  if (end) insert += '\n\n'
  return { from, deleteCount: to - from, insert }
}
