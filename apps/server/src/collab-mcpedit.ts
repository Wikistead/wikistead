// #369 / ADR-144: server-side dispatch for the MCP `edit_body` tool (companion to the collab mcpedit
// subscriber). The HTTP API never touches the Y.Doc — it asks the collab tier to apply the edit as a Y.Text op
// on the canonical doc and waits for the result, reusing the same Valkey request/ack seam as flushDraft/restore
// (no new collab HTTP/auth surface).
//
// Mechanism: PUBLISH wks:mcpedit:<docName> with the request JSON (content + resolved principal + size cap); a
// collab pod (elected by a per-doc lock) applies the edit and PUBLISHes wks:mcpeditack:<reqId> with {ok,error}.
// We await the ack with a timeout. PUBLISH returns the subscriber count: 0 = NO collab pod running, so the edit
// cannot be applied safely (never a headless API-side write, ADR-144 §1) — we throw a RETRYABLE error.
import type IORedis from 'ioredis'
import { randomUUID } from 'node:crypto'

// A retryable failure: no collab pod is available to apply the edit right now (or the ack timed out). The MCP
// tool surfaces this so the client can retry — it is NOT a permission or validation error.
export class CollabUnavailableError extends Error {}

export interface McpEditDispatch {
  op: 'append' | 'replace_section'
  content: string
  heading?: string
  user: string // "user:<sub>" — re-authorized on the pod side (two-sided authz)
  tenant: string
  sizeCap: number
}

export interface McpEditResult { ok: boolean; error?: string }

// Ask a collab pod to apply the body edit and wait for its result. Throws CollabUnavailableError when no pod is
// listening or the ack times out (retryable). Returns {ok:false, error} for a pod-side refusal (authz / bad
// input) — the caller maps that to a tool error. Uses a dedicated short-lived subscriber per call, always closed.
export async function mcpEditDraft(
  valkey: IORedis,
  documentName: string,
  edit: McpEditDispatch,
  opts: { timeoutMs?: number } = {},
): Promise<McpEditResult> {
  const reqId = randomUUID()
  const ackChannel = `wks:mcpeditack:${reqId}`
  const sub = valkey.duplicate()
  try {
    // Subscribe to the ack BEFORE publishing so a fast ack cannot be missed.
    await sub.subscribe(ackChannel)
    const payload = JSON.stringify({
      reqId, tenant: edit.tenant, user: edit.user, op: edit.op, content: edit.content,
      ...(edit.op === 'replace_section' ? { heading: edit.heading } : {}), sizeCap: edit.sizeCap,
    })
    const received = await valkey.publish(`wks:mcpedit:${documentName}`, payload)
    if (received === 0) throw new CollabUnavailableError('no collab pod is available to apply the edit')
    return await new Promise<McpEditResult>((resolve, reject) => {
      // The timeout MUST exceed the pod-side per-doc lock TTL (MCP_EDIT_LOCK_TTL_MS = 8000 in apps/collab). The
      // elected applier holds the lock for the whole load→apply→store→ack, so it either acks within the lock's
      // lifetime or the lock expires (pod died) — waiting longer than the TTL means a timeout implies the apply
      // did NOT run to completion, so a client retry cannot double-apply a non-idempotent `append` against a
      // still-in-flight edit. (A pod crash in the narrow store→publish-ack gap is the residual at-least-once
      // window, documented in ADR-144; a retry there is safe-side rare.)
      const timer = setTimeout(() => reject(new CollabUnavailableError('timed out waiting for the collab edit ack')), opts.timeoutMs ?? 10_000)
      sub.on('message', (_ch, msg) => {
        clearTimeout(timer)
        try { resolve(JSON.parse(msg) as McpEditResult) } catch { resolve({ ok: false, error: 'malformed ack' }) }
      })
    })
  } finally {
    sub.disconnect()
  }
}
