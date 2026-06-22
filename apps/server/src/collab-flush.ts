// Publish flush (companion to the collab flush subscriber).
//
// publishPage publishes the LAST PERSISTED draft (pages.ydoc), which lags the live
// doc by the collab onStoreDocument debounce. Before publishing we ask the collab
// server to persist the live doc NOW (so the snapshot includes the just-typed edits)
// and wait for it to finish. Reuses the same Valkey pub/sub the restore signal uses —
// no new HTTP/auth surface on the collab join point.
//
// Mechanism: PUBLISH wks:flushreq:<docName> with a request id; the collab pod that
// holds the doc force-persists it and PUBLISHes wks:flushack:<reqId>. We await the
// ack with a timeout. PUBLISH returns the number of subscribers that received it: if
// 0 (no collab running — e.g. unit tests that hit the route without the collab
// process), there is nothing to flush, so we return immediately.
import type IORedis from 'ioredis'
import { randomUUID } from 'node:crypto'

// Ask collab to persist the live draft for `documentName` and wait until it has (or
// until timeout). Best-effort: on timeout / no-subscriber / valkey error we proceed —
// the published snapshot is then at worst the debounced state (no worse than before
// this flush existed). Never throws. Uses a dedicated short-lived subscriber per call
// that is always closed, so it never leaks a connection (matters for tests).
export async function flushDraft(valkey: IORedis, documentName: string, opts: { timeoutMs?: number } = {}): Promise<void> {
  const reqId = randomUUID()
  const ackChannel = `wks:flushack:${reqId}`
  const sub = valkey.duplicate()
  try {
    // Subscribe to the ack BEFORE publishing the request so we cannot miss a fast ack.
    await sub.subscribe(ackChannel)
    const received = await valkey.publish(`wks:flushreq:${documentName}`, reqId)
    if (received === 0) return // no collab listening → pages.ydoc already current
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, opts.timeoutMs ?? 1500)
      sub.on('message', () => { clearTimeout(timer); resolve() })
    })
  } catch {
    // valkey unavailable / subscribe failed — proceed with the persisted snapshot.
  } finally {
    sub.disconnect()
  }
}
