/**
 * #681: did the server fail, or did it answer about the reader?
 *
 * The sign-in path deliberately separates 401 from 5xx — `auth-local.ts` explains at length that a
 * dependency being broken is NOT a fact about this person's credentials, so it is thrown rather than
 * answered as an authentication failure. Without that, everyone retypes a correct password during an
 * outage and the operator sees no errors at all.
 *
 * ⚠️ Every screen around that door then threw the distinction away in a `!res.ok` branch. This is the
 * one place that decides, so the four of them cannot drift apart again.
 *
 * A null response means the request never completed (network, DNS, the tab going offline) — which is
 * also not a fact about the reader.
 */
export function isServerFault(res: Response | null | undefined): boolean {
  return !res || res.status >= 500
}

/**
 * The same question, asked where the Response is already gone.
 *
 * A react-query `queryFn` rejects, and the component sees only an Error — so a fetch that reached a
 * 404 and a fetch that never completed arrive in the same shape. Carrying the status on the error
 * keeps the answer readable, and #886 is why it matters: a public space whose tree request hit
 * a restarting deployment was told the space does not exist.
 */
export class HttpStatusError extends Error {
  readonly status: number
  constructor(status: number) {
    super(String(status))
    this.name = 'HttpStatusError'
    this.status = status
  }
}

/**
 * ⚠️ An error with NO status is the server's fault by the same reasoning as a null Response above:
 * the request never completed, so nothing was said about the reader.
 */
export function isServerFaultError(err: unknown): boolean {
  return !(err instanceof HttpStatusError) || err.status >= 500
}

/**
 * The three answers a failed load has, in one place so a surface cannot pick two of them.
 *
 * ⚠️ Reading this out of source position is what made the first #886 pin vacuous: a string
 * that says `isServerFaultError` is not the same as a branch that runs it. The verdict is a value so
 * a test can hand it the real inputs.
 */
export type LoadVerdict = 'ok' | 'unavailable' | 'notfound'

export function loadVerdict(isError: boolean, err: unknown): LoadVerdict {
  if (!isError) return 'ok'
  return isServerFaultError(err) ? 'unavailable' : 'notfound'
}
