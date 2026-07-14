// #400: the /readyz dependency probe, extracted PURE (ping thunks in, booleans out) so the
// success / failure / timeout matrix is unit-testable without wiring real outages. Each ping is
// raced against a short timeout — a HANGING dependency (the worst k8s readiness failure mode:
// the probe itself times out and reports nothing) resolves to a deterministic false instead.
// The result carries booleans only; the caller logs the error detail (this feeds an
// unauthenticated endpoint, which must never echo internals).

export type ReadinessPings = Record<string, () => Promise<void>>
export interface ReadinessResult { ok: boolean; deps: Record<string, boolean> }

export const READINESS_TIMEOUT_MS = 1500

export async function checkReadiness(
  pings: ReadinessPings,
  onFail?: (dep: string, err: unknown) => void,
  timeoutMs = READINESS_TIMEOUT_MS,
): Promise<ReadinessResult> {
  const names = Object.keys(pings)
  const results = await Promise.all(
    names.map(async (name) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          pings[name]!(),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('readiness ping timeout')), timeoutMs) }),
        ])
        return true
      } catch (err) {
        onFail?.(name, err)
        return false
      } finally {
        clearTimeout(timer)
      }
    }),
  )
  const deps = Object.fromEntries(names.map((n, i) => [n, results[i]!]))
  return { ok: results.every(Boolean), deps }
}
