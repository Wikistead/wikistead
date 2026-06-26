// Active guest disconnect on share-link revoke (#106 / ADR-028).
//
// Revocation authority is the FGA tuple delete in revokeShareLink — that is instant and is
// the source of truth (a revoked guest can never re-authorize). This module is LIVENESS only:
// it publishes a best-effort Valkey signal so the collab server can sever guests who are
// already connected on the revoked link, instead of letting them edit until their token TTL.
//
// Backstops if the signal is missed (Valkey down, collab not subscribed, pod restart): the
// guest token TTL eventually expires the session, and any reconnect is rejected by the collab
// onAuthenticate FGA re-check (the tuple is gone). So a dropped signal degrades latency, never
// correctness — mirroring the wks:restore / wks:flushreq best-effort channels.
import type IORedis from 'ioredis'
import { docName } from '@wikistead/types'

// One channel per document (one page = one share link = one Yjs room). Same shape as the
// existing wks:restore:/wks:flushreq: channels; the collab subscriber psubscribes wks:revoke:*.
// Keep this prefix in sync with apps/collab/src/index.ts (separate app, literal duplicated by
// the established cross-app channel convention).
export const REVOKE_CHANNEL_PREFIX = 'wks:revoke:'

export function revokeChannel(documentName: string): string {
  return `${REVOKE_CHANNEL_PREFIX}${documentName}`
}

// The payload carried on the revoke channel. The collab side closes only guest connections
// whose shareLinkId matches — never members, never guests on other links.
export interface RevokePayload {
  shareLinkId: string
}

// Publish the revoke signal for a (tenant, page, link). Returns the subscriber count
// (0 = no collab pod listening — fine, the TTL + reconnect FGA check are the backstop).
// Swallows Valkey errors: revocation already succeeded at the FGA layer, so a failed publish
// must never surface as a revoke failure.
export async function publishRevoke(
  valkey: IORedis,
  args: { tenantId: string; pageId: string; shareLinkId: string },
): Promise<number> {
  const channel = revokeChannel(docName(args.tenantId, args.pageId))
  const payload: RevokePayload = { shareLinkId: args.shareLinkId }
  try {
    return await valkey.publish(channel, JSON.stringify(payload))
  } catch {
    return 0 // Valkey unavailable → rely on TTL + reconnect rejection
  }
}
