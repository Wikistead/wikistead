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
