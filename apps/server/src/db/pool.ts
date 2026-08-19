import postgres from 'postgres'

// Runtime pool — connects as the restricted 'app' role (NOSUPERUSER, NOBYPASSRLS).
// RLS policies apply to every query on this pool. Never use DATABASE_ADMIN_URL here.
export const pool = postgres(process.env.DATABASE_URL!, {
  max: 20,
  idle_timeout: 30,
  connect_timeout: 10,
  onnotice: () => {},
})

// #773: ending this pool while a reserved connection is still on its way back DEADLOCKS, permanently.
// A tenant handle returns through a QUERY (`release()` resets app.tenant_id on the reserved connection
// before handing it back), and postgres.js `end()` waits for every connection to go idle — but a query
// issued after `end()` began never runs, so the release waits for the pool and the pool waits for the
// release. Measured: the runs that hung ended the pool with 7 acquired / 6 released; the green runs
// with 7 / 7. Nothing times out on its own — the hang is unbounded, and what surfaced was a test hook
// dying at 60s with no clue as to which segment waited.
//
// It is a race, not a leak: the release is normally in flight because `onResponse` releases AFTER the
// response was delivered, so a caller that shuts down the moment its last request returns can beat it.
// So `end()` first WAITS for the outstanding handles (they are milliseconds away), and only forces the
// close if they never come — and says so, because a handle that is never released is a different bug
// (a lost connection out of max: 20) that must not hide inside a shutdown that looks clean.
//
// The count lives with the RESERVE, not with each caller: a third acquire site written later would
// silently escape a per-caller counter, and the whole failure mode is invisible until a shutdown hangs.
// `reserveTracked` is the only way to take a connection out of this pool — a pin walks the tree for
// `.reserve()` elsewhere.
let reserved = 0

export function reservedCount(): number {
  return reserved
}

type Reserved = Awaited<ReturnType<typeof pool.reserve>>

export async function reserveTracked(): Promise<Reserved> {
  const handle = await pool.reserve()
  reserved++
  let released = false
  const giveBack = handle.release.bind(handle)
  // A double release must not under-count and let end() run while a handle is still out.
  ;(handle as { release: () => void }).release = () => {
    if (released) return
    released = true
    reserved--
    giveBack()
  }
  return handle
}

// Exported for the pin: the wait is the part with the behaviour, and the real pool cannot be ended
// twice to test it. Returns what is STILL outstanding, so the caller decides what to do about it.
export async function waitForReserved(busy: () => number, timeoutMs: number, tickMs = 25): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (busy() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, tickMs))
  return busy()
}

const gracefulEnd = pool.end.bind(pool)
;(pool as { end: typeof pool.end }).end = async (options?: { timeout?: number }) => {
  const left = await waitForReserved(reservedCount, Number(process.env.POOL_END_QUIESCE_MS ?? 10_000))
  if (left === 0) return gracefulEnd(options)
  // timeout: 0 terminates the connections and rejects what is queued on them, so the shutdown ends
  // instead of hanging — the report above is the point, not the forcing.
  console.warn(`pool.end: ${left} reserved connection(s) never returned — forcing the close (a tenant handle was acquired and never released)`)
  return gracefulEnd({ timeout: 0 })
}
