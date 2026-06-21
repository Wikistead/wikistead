// Comments — page-level and inline (P4). Bodies + metadata live in Postgres
// (never in the page Y.Text). Authorization is derived from FGA per request:
//   - read  → page#view  (comment implies view; viewers see comments)
//   - write → page#comment (commenters/editors)
// Comments create NO FGA tuples (authz is page-derived), so there is no dual-write
// to roll back — the route is a plain DB mutation behind an FGA gate.
//
// TODO(phase: comments): guest (share-link) commenting — the core product is
// anonymous guest co-EDITING, so guests editing-but-not-commenting is slightly
// uneven. Deferred: it needs `comment` added to share_link in the FGA model; v1 is
// member-only.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { check } from '@wikistead/authz'
import { emit } from '@wikistead/events'
import type { Capability } from '@wikistead/types'

interface ThreadRow {
  id: string; page_id: string; kind: string; anchor_start: Buffer | null; anchor_end: Buffer | null
  quoted_text: string | null; status: string; created_by: string; created_at: Date
  resolved_by: string | null; resolved_at: Date | null
}
interface CommentRow { id: string; thread_id: string; body: string; author_sub: string; created_at: Date; edited_at: Date | null }

const b64 = (b: Buffer | null) => (b ? b.toString('base64') : null)

// FGA gate on the page behind a comment/thread. Returns false (and sends the
// response) when denied, so callers `if (!(await gate(...))) return`.
async function requirePage(req: FastifyRequest, reply: FastifyReply, pageId: string, cap: Capability): Promise<boolean> {
  const user = `user:${req.user.sub}`
  const ref = { type: 'page', id: pageId } as const
  // View is the floor for EVERY comment op: a user who can't view the page must
  // learn nothing about it (existence, comments) → uniform 404. Only AFTER view
  // passes does a write op fail with 403 for lacking comment capability — so 403
  // never leaks a page to someone who can't see it (no-leak discipline, as search/tree).
  if (!(await check(req.server.fga, user, 'view', ref))) {
    await reply.code(404).send({ error: 'not found' })
    return false
  }
  if (cap === 'comment' && !(await check(req.server.fga, user, 'comment', ref))) {
    await reply.code(403).send({ error: 'forbidden' })
    return false
  }
  return true
}

async function isTenantAdmin(req: FastifyRequest): Promise<boolean> {
  const { allowed } = await req.server.fga.check({ user: `user:${req.user.sub}`, relation: 'admin', object: `tenant:${req.tenant.id}` })
  return !!allowed
}

// Resolve a thread's page (RLS-scoped) — the authz anchor for thread/comment ops.
async function threadPage(req: FastifyRequest, threadId: string): Promise<{ pageId: string } | null> {
  const [row] = await req.db.sql<[{ page_id: string }?]>`SELECT page_id FROM comment_threads WHERE id = ${threadId}`
  return row ? { pageId: row.page_id } : null
}

export async function commentsPlugin(app: FastifyInstance) {
  // List threads (+ non-deleted comments) for a page. page#view required → a user
  // who can't view the page gets a uniform 404, never comment bodies.
  app.get<{ Params: { pageId: string } }>('/pages/:pageId/comments', async (req, reply) => {
    if (!(await requirePage(req, reply, req.params.pageId, 'view'))) return
    const threads = await req.db.sql<ThreadRow[]>`
      SELECT id, page_id, kind, anchor_start, anchor_end, quoted_text, status, created_by, created_at, resolved_by, resolved_at
      FROM comment_threads WHERE page_id = ${req.params.pageId} ORDER BY created_at`
    const rows = await req.db.sql<CommentRow[]>`
      SELECT id, thread_id, body, author_sub, created_at, edited_at
      FROM comments WHERE deleted_at IS NULL
        AND thread_id IN (SELECT id FROM comment_threads WHERE page_id = ${req.params.pageId})
      ORDER BY created_at`
    const byThread = new Map<string, CommentRow[]>()
    for (const c of rows) (byThread.get(c.thread_id) ?? byThread.set(c.thread_id, []).get(c.thread_id)!).push(c)
    return {
      threads: threads.map((t) => ({
        id: t.id, kind: t.kind, status: t.status, quotedText: t.quoted_text,
        anchorStart: b64(t.anchor_start), anchorEnd: b64(t.anchor_end),
        createdBy: t.created_by, createdAt: t.created_at, resolvedBy: t.resolved_by, resolvedAt: t.resolved_at,
        comments: (byThread.get(t.id) ?? []).map((c) => ({ id: c.id, body: c.body, authorSub: c.author_sub, createdAt: c.created_at, editedAt: c.edited_at })),
      })),
    }
  })

  // Start a thread (page or inline) with its first comment. page#comment required.
  app.post<{ Params: { pageId: string }; Body: { body?: string; kind?: string; anchorStart?: string; anchorEnd?: string; quotedText?: string } }>(
    '/pages/:pageId/comments',
    async (req, reply) => {
      if (!(await requirePage(req, reply, req.params.pageId, 'comment'))) return
      const body = req.body?.body?.trim()
      if (!body) return reply.code(400).send({ error: 'empty comment' })
      const kind = req.body?.kind === 'inline' ? 'inline' : 'page'
      const anchorStart = req.body?.anchorStart ? Buffer.from(req.body.anchorStart, 'base64') : null
      const anchorEnd = req.body?.anchorEnd ? Buffer.from(req.body.anchorEnd, 'base64') : null

      const thread = await req.db.tx(async (tx) => {
        const [t] = await tx<[{ id: string }]>`
          INSERT INTO comment_threads (tenant_id, page_id, kind, anchor_start, anchor_end, quoted_text, created_by)
          VALUES (${req.tenant.id}, ${req.params.pageId}, ${kind}, ${anchorStart}, ${anchorEnd}, ${req.body?.quotedText ?? null}, ${req.user.sub})
          RETURNING id`
        await tx`INSERT INTO comments (tenant_id, thread_id, body, author_sub) VALUES (${req.tenant.id}, ${t.id}, ${body}, ${req.user.sub})`
        return t
      })
      emit({ type: 'comment.created', tenantId: req.tenant.id, actorId: req.user.sub, pageId: req.params.pageId, threadId: thread.id })
      return reply.code(201).send({ threadId: thread.id })
    },
  )

  // Reply to a thread. page#comment on the thread's page required.
  app.post<{ Params: { threadId: string }; Body: { body?: string } }>('/comments/threads/:threadId/comments', async (req, reply) => {
    const t = await threadPage(req, req.params.threadId)
    if (!t) return reply.code(404).send({ error: 'not found' })
    if (!(await requirePage(req, reply, t.pageId, 'comment'))) return
    const body = req.body?.body?.trim()
    if (!body) return reply.code(400).send({ error: 'empty comment' })
    const [c] = await req.db.sql<[{ id: string }]>`
      INSERT INTO comments (tenant_id, thread_id, body, author_sub) VALUES (${req.tenant.id}, ${req.params.threadId}, ${body}, ${req.user.sub}) RETURNING id`
    emit({ type: 'comment.created', tenantId: req.tenant.id, actorId: req.user.sub, pageId: t.pageId, threadId: req.params.threadId })
    return reply.code(201).send({ commentId: c.id })
  })

  // Edit own comment (author only — even an admin doesn't rewrite others' words).
  app.patch<{ Params: { commentId: string }; Body: { body?: string } }>('/comments/:commentId', async (req, reply) => {
    const [row] = await req.db.sql<[{ author_sub: string; thread_id: string }?]>`
      SELECT author_sub, thread_id FROM comments WHERE id = ${req.params.commentId} AND deleted_at IS NULL`
    if (!row) return reply.code(404).send({ error: 'not found' })
    if (row.author_sub !== req.user.sub) return reply.code(403).send({ error: 'not the author' })
    const body = req.body?.body?.trim()
    if (!body) return reply.code(400).send({ error: 'empty comment' })
    await req.db.sql`UPDATE comments SET body = ${body}, edited_at = now() WHERE id = ${req.params.commentId}`
    return { ok: true }
  })

  // Delete a comment (soft). Author deletes own; a tenant admin can delete any.
  app.delete<{ Params: { commentId: string } }>('/comments/:commentId', async (req, reply) => {
    const [row] = await req.db.sql<[{ author_sub: string }?]>`
      SELECT author_sub FROM comments WHERE id = ${req.params.commentId} AND deleted_at IS NULL`
    if (!row) return reply.code(404).send({ error: 'not found' })
    if (row.author_sub !== req.user.sub && !(await isTenantAdmin(req))) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    await req.db.sql`UPDATE comments SET deleted_at = now() WHERE id = ${req.params.commentId}`
    return reply.code(204).send()
  })

  // Resolve / reopen a thread. Any commenter may (collaborative; reopen-able). The
  // actor is recorded in resolved_by so it stays auditable.
  for (const action of ['resolve', 'reopen'] as const) {
    app.post<{ Params: { threadId: string } }>(`/comments/threads/:threadId/${action}`, async (req, reply) => {
      const t = await threadPage(req, req.params.threadId)
      if (!t) return reply.code(404).send({ error: 'not found' })
      if (!(await requirePage(req, reply, t.pageId, 'comment'))) return
      if (action === 'resolve') {
        await req.db.sql`UPDATE comment_threads SET status = 'resolved', resolved_by = ${req.user.sub}, resolved_at = now() WHERE id = ${req.params.threadId}`
      } else {
        await req.db.sql`UPDATE comment_threads SET status = 'open', resolved_by = NULL, resolved_at = NULL WHERE id = ${req.params.threadId}`
      }
      return { ok: true }
    })
  }
}
