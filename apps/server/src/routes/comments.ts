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
import { principalForPage } from './pages.js'

interface ThreadRow {
  id: string; page_id: string; kind: string; anchor_start: Buffer | null; anchor_end: Buffer | null
  quoted_text: string | null; status: string; created_by: string; created_at: Date
  resolved_by: string | null; resolved_at: Date | null
}
interface CommentRow { id: string; thread_id: string; body: string; author_sub: string; created_at: Date; edited_at: Date | null }

const b64 = (b: Buffer | null) => (b ? b.toString('base64') : null)

// The comment actor: a member (user:<sub>) or a guest (share_link:<id>, page-bound). `subject`
// is the FGA principal; `authorId` is what we store as the comment author — a member's BARE
// sub (unchanged) or a `guest:<id>` LABEL that can never collide with or impersonate a member.
interface CommentActor { subject: string; authorId: string; context?: { current_time: string } }

// FGA gate on the page behind a comment/thread. Returns the resolved actor on success, or
// null (and sends the response) when denied → callers `const a = await requirePage(...); if
// (!a) return`. Members AND comment-capable guests both flow through here; a guest's token is
// bound to this exact page (principalForPage throws 403 otherwise → space-link guests, whose
// token resource is a space, never reach the comment write path).
async function requirePage(req: FastifyRequest, reply: FastifyReply, pageId: string, cap: Capability): Promise<CommentActor | null> {
  let p: { subject: string; createdBy: string; context?: { current_time: string } }
  try {
    p = principalForPage(req, pageId)
  } catch (e) {
    await reply.code((e as { statusCode?: number }).statusCode ?? 401).send({ error: 'forbidden' })
    return null
  }
  const ref = { type: 'page', id: pageId } as const
  // View is the floor for EVERY comment op: someone who can't view the page must learn nothing
  // (existence, comments) → uniform 404. Only AFTER view passes does a write op 403 for lacking
  // comment — so 403 never leaks a page to someone who can't see it (no-leak discipline).
  if (!(await check(req.server.fga, p.subject, 'view', ref, p.context))) {
    await reply.code(404).send({ error: 'not found' })
    return null
  }
  if (cap === 'comment' && !(await check(req.server.fga, p.subject, 'comment', ref, p.context))) {
    await reply.code(403).send({ error: 'forbidden' })
    return null
  }
  // Member → bare sub (unchanged storage format); guest → "guest:<shareLinkId>" label.
  const authorId = req.user ? req.user.sub : p.createdBy
  return { subject: p.subject, authorId, context: p.context }
}

async function isTenantAdmin(req: FastifyRequest): Promise<boolean> {
  const { allowed } = await req.server.fga.check({ user: `user:${req.user.sub}`, relation: 'admin', object: `tenant:${req.tenant.id}` })
  return !!allowed
}

interface MentionTarget { sub: string; displayName: string | null; email: string | null }

// @mention candidates = tenant members WHO CAN VIEW THIS PAGE. The page-view filter
// is the key no-leak guard: mentioning a member who can't view the page would leak
// the page's existence/title to them via the notification — so they are excluded
// from BOTH autocomplete and notification (same discipline as search/tree). Tenant
// scope (RLS on members) already prevents cross-tenant mentions.
async function mentionableViewers(req: FastifyRequest, pageId: string): Promise<MentionTarget[]> {
  const members = await req.db.sql<{ sub: string; display_name: string | null; email: string | null }[]>`
    SELECT sub, display_name, email FROM members`
  if (members.length === 0) return []
  const { responses } = await req.server.fga.batchCheck(
    members.map((m) => ({ user: `user:${m.sub}`, relation: 'view', object: `page:${pageId}` })),
  )
  const canView = new Set(responses.filter((r) => r.allowed).map((r) => r._request.user))
  return members
    .filter((m) => canView.has(`user:${m.sub}`))
    .map((m) => ({ sub: m.sub, displayName: m.display_name, email: m.email }))
}

// Best-effort @mention notification. The client sends the resolved subs; the server
// re-validates each against mentionableViewers (member + page-view) so a forged sub
// can neither be notified nor leak the page. Email is best-effort (P1.3): the
// comment is already saved, so a failed/disabled send changes nothing.
async function notifyMentions(req: FastifyRequest, pageId: string, mentions: string[] | undefined): Promise<void> {
  if (!req.user) return // guests do not @mention (the mentionable directory is member-only)
  if (!mentions?.length) return
  const allowed = await mentionableViewers(req, pageId)
  const wanted = new Set(mentions)
  const targets = allowed.filter((t) => wanted.has(t.sub) && t.email && t.sub !== req.user.sub)
  if (targets.length === 0) return
  const scheme = process.env.NODE_ENV === 'production' ? 'https' : 'http'
  const link = `${scheme}://${req.headers.host}/p/${pageId}`
  await Promise.all(
    targets.map((t) =>
      req.server.email
        .send({
          to: t.email!,
          subject: `You were mentioned in ${req.tenant.slug} on wikistead`,
          text: `You were mentioned in a comment. Open the page:\n\n${link}`,
          html: `<p>You were mentioned in a comment on <strong>${req.tenant.slug}</strong>.</p><p><a href="${link}">Open the page</a></p>`,
        })
        .catch((err) => req.log.warn({ err }, 'mention email failed — comment still saved')),
    ),
  )
}

// Resolve a thread's page (RLS-scoped) — the authz anchor for thread/comment ops.
async function threadPage(req: FastifyRequest, threadId: string): Promise<{ pageId: string } | null> {
  const [row] = await req.db.sql<[{ page_id: string }?]>`SELECT page_id FROM comment_threads WHERE id = ${threadId}`
  return row ? { pageId: row.page_id } : null
}

export async function commentsPlugin(app: FastifyInstance) {
  // List threads (+ non-deleted comments) for a page. page#view required → a user
  // who can't view the page gets a uniform 404, never comment bodies.
  app.get<{ Params: { pageId: string } }>('/pages/:pageId/comments', { config: { guest: 'view' } }, async (req, reply) => {
    const actor = await requirePage(req, reply, req.params.pageId, 'view')
    if (!actor) return
    // #100 UX: tell the client which comments THIS principal may modify (author, or a tenant admin) so
    // it shows delete/edit only there — a guest no longer sees a delete button on a member's comment
    // (the server already 403s it; this stops the "clickable but forbidden" affordance). Same authz as
    // the delete/edit routes: isAuthor || isAdmin (guests are never tenant admins).
    const isAdmin = req.user ? await isTenantAdmin(req) : false
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
        comments: (byThread.get(t.id) ?? []).map((c) => ({ id: c.id, body: c.body, authorSub: c.author_sub, createdAt: c.created_at, editedAt: c.edited_at, canModify: c.author_sub === actor.authorId || isAdmin })),
      })),
    }
  })

  // @mention autocomplete directory: members who can VIEW this page, exposed as
  // ONLY { sub, displayName } (no email/role/createdAt — not needed to mention, and
  // listing those would over-share). page#comment required (only commenters mention).
  app.get<{ Params: { pageId: string } }>('/pages/:pageId/mentionable', async (req, reply) => {
    if (!(await requirePage(req, reply, req.params.pageId, 'comment'))) return
    const targets = await mentionableViewers(req, req.params.pageId)
    return { members: targets.map((t) => ({ sub: t.sub, displayName: t.displayName })) }
  })

  // Start a thread (page or inline) with its first comment. page#comment required.
  app.post<{ Params: { pageId: string }; Body: { body?: string; kind?: string; anchorStart?: string; anchorEnd?: string; quotedText?: string; mentions?: string[] } }>(
    '/pages/:pageId/comments',
    { config: { guest: 'view' } },
    async (req, reply) => {
      const actor = await requirePage(req, reply, req.params.pageId, 'comment')
      if (!actor) return
      const body = req.body?.body?.trim()
      if (!body) return reply.code(400).send({ error: 'empty comment' })
      const kind = req.body?.kind === 'inline' ? 'inline' : 'page'
      const anchorStart = req.body?.anchorStart ? Buffer.from(req.body.anchorStart, 'base64') : null
      const anchorEnd = req.body?.anchorEnd ? Buffer.from(req.body.anchorEnd, 'base64') : null

      const thread = await req.db.tx(async (tx) => {
        const [t] = await tx<[{ id: string }]>`
          INSERT INTO comment_threads (tenant_id, page_id, kind, anchor_start, anchor_end, quoted_text, created_by)
          VALUES (${req.tenant.id}, ${req.params.pageId}, ${kind}, ${anchorStart}, ${anchorEnd}, ${req.body?.quotedText ?? null}, ${actor.authorId})
          RETURNING id`
        await tx`INSERT INTO comments (tenant_id, thread_id, body, author_sub) VALUES (${req.tenant.id}, ${t.id}, ${body}, ${actor.authorId})`
        return t
      })
      emit({ type: 'comment.created', tenantId: req.tenant.id, actorId: actor.authorId, pageId: req.params.pageId, threadId: thread.id })
      await notifyMentions(req, req.params.pageId, req.body?.mentions)
      return reply.code(201).send({ threadId: thread.id })
    },
  )

  // Reply to a thread. page#comment on the thread's page required.
  app.post<{ Params: { threadId: string }; Body: { body?: string; mentions?: string[] } }>('/comments/threads/:threadId/comments', { config: { guest: 'view' } }, async (req, reply) => {
    const t = await threadPage(req, req.params.threadId)
    if (!t) return reply.code(404).send({ error: 'not found' })
    const actor = await requirePage(req, reply, t.pageId, 'comment')
    if (!actor) return
    const body = req.body?.body?.trim()
    if (!body) return reply.code(400).send({ error: 'empty comment' })
    const [c] = await req.db.sql<[{ id: string }]>`
      INSERT INTO comments (tenant_id, thread_id, body, author_sub) VALUES (${req.tenant.id}, ${req.params.threadId}, ${body}, ${actor.authorId}) RETURNING id`
    emit({ type: 'comment.created', tenantId: req.tenant.id, actorId: actor.authorId, pageId: t.pageId, threadId: req.params.threadId })
    await notifyMentions(req, t.pageId, req.body?.mentions)
    return reply.code(201).send({ commentId: c.id })
  })

  // Edit own comment (author only — even an admin doesn't rewrite others' words). #100: gate the
  // WHOLE op server-side, members AND guests. Resolve the comment's page, require view (no-leak 404),
  // resolve the principal (member sub OR guest share-link label), and compare against the stored
  // author via that principal — never `req.user.sub` directly (a guest has no req.user, which both
  // crashed and bypassed the ownership check).
  app.patch<{ Params: { commentId: string }; Body: { body?: string } }>('/comments/:commentId', { config: { guest: 'view' } }, async (req, reply) => {
    const [row] = await req.db.sql<[{ author_sub: string; thread_id: string }?]>`
      SELECT author_sub, thread_id FROM comments WHERE id = ${req.params.commentId} AND deleted_at IS NULL`
    if (!row) return reply.code(404).send({ error: 'not found' })
    const page = await threadPage(req, row.thread_id)
    if (!page) return reply.code(404).send({ error: 'not found' })
    const actor = await requirePage(req, reply, page.pageId, 'view') // view floor + principal; sends on denial
    if (!actor) return
    if (row.author_sub !== actor.authorId) return reply.code(403).send({ error: 'not the author' })
    const body = req.body?.body?.trim()
    if (!body) return reply.code(400).send({ error: 'empty comment' })
    await req.db.sql`UPDATE comments SET body = ${body}, edited_at = now() WHERE id = ${req.params.commentId}`
    return { ok: true }
  })

  // Delete a comment (soft). #100 authz: the AUTHOR (member or guest, matched via the resolved
  // principal) OR a tenant admin. A viewing-only guest / non-author gets 403; someone who can't even
  // view the page gets a uniform 404 (no-leak). The delete route is the fortress — hiding the UI
  // button is not enough (the bounce: a share-link guest could DELETE another user's comment because
  // this route did `req.user.sub` with no page authz).
  app.delete<{ Params: { commentId: string } }>('/comments/:commentId', { config: { guest: 'view' } }, async (req, reply) => {
    const [row] = await req.db.sql<[{ author_sub: string; thread_id: string }?]>`
      SELECT author_sub, thread_id FROM comments WHERE id = ${req.params.commentId} AND deleted_at IS NULL`
    if (!row) return reply.code(404).send({ error: 'not found' })
    const page = await threadPage(req, row.thread_id)
    if (!page) return reply.code(404).send({ error: 'not found' })
    const actor = await requirePage(req, reply, page.pageId, 'view') // view floor + principal; sends on denial
    if (!actor) return
    const isAuthor = row.author_sub === actor.authorId
    const isAdmin = req.user ? await isTenantAdmin(req) : false // guests are never tenant admins
    if (!isAuthor && !isAdmin) return reply.code(403).send({ error: 'forbidden' })
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
