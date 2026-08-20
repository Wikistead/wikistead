import { promises as dns } from 'node:dns'

// The ONE DNS-TXT ownership-challenge primitive (#123 / ADR-065). Custom domains AND enrol domains (#101)
// prove ownership through THIS check — never a second, looser implementation (comment 712: everything
// goes through the same verification mechanism as #123, no other path may set verified, and a duplicate
// implementation with one looser side would be a hole). A tenant proves it
// owns `<domain>` by publishing the unguessable per-domain token as a TXT record at
// `_wikistead-challenge.<domain>`; only the real DNS owner can, so a non-owner can never verify a domain
// they don't control.
export const CHALLENGE_PREFIX = '_wikistead-challenge'

export type ResolveTxt = (name: string) => Promise<string[][]>

// Is the expected token published at the challenge TXT record for `domain`? Total: a DNS failure (no
// record, NXDOMAIN, timeout) resolves to `false` (not verified), never a throw. `resolveTxt` is injectable
// so tests never hit the network.
export async function txtChallengePresent(domain: string, expectedToken: string, resolveTxt: ResolveTxt = dns.resolveTxt): Promise<boolean> {
  const records = await resolveTxt(`${CHALLENGE_PREFIX}.${domain}`).catch(() => [] as string[][])
  // A TXT record can be chunked (255-byte segments) — join before comparing. Trim trailing whitespace.
  return records.some((chunks) => chunks.join('').trim() === expectedToken)
}
