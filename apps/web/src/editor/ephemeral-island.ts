import * as Y from "yjs";

// #502 / ADR-184 slice 2: the ephemeral shared Y.Text that backs a CO-OCCUPIED text-body island (two or
// more peers editing the SAME macro body at once). It reuses the `:x:` ephemeral-room stack (collab.ts
// connectEphemeral) — non-persistent, edit-gated — exactly like Excalidraw's live co-edit, but for TEXT.
// The canonical single Y.Text is untouched: this shared body is a TEMPORARY second surface flushed back on
// close (the sanctioned " CRDT → flush" pattern, ADR-184 §1; NOT a permanent CRDT).
//
// THE SHARP EDGE (why this is NOT a copy of excalidraw-collab.ts): a Y.Text is an APPEND type, not an
// idempotent Y.Map + version-LWW (excalidraw-collab.ts:shouldReplace). Two peers each seeding the body from
// the fence text would produce "hellohello" — the text DOUBLES. So seeding is single-writer + guarded
// 1. ELECTION — only the lowest clientID currently co-occupying is eligible to seed (shouldSeed). The
// non-elected peers bind to the shared body and wait for the seeded text to sync in.
// 2. GUARD — the ephemeral doc's own `meta` map carries a `seeded` flag; a late joiner (arriving AFTER
// the seed has synced) binds to the already-seeded body and never re-seeds, and the flag is set in the
// SAME transaction as the insert so a peer syncing mid-seed never observes a body-without-guard.
// Together: exactly one insert ever runs. PRECONDITION (enforced by the slice-2b transport, not here): seed
// only AFTER the ephemeral provider's initial sync has completed, so the guard/body a late joiner reads is
// the seeder's — the election alone cannot beat a still-syncing join race, the post-sync guard closes it.
//
// This module is PURE of the network + React (it takes a Y.Doc), so the election + seed-once logic is
// unit-testable in isolation; the transport (connectEphemeral) and the island editor binding (yCollab) layer
// on top in slice 2b.

const META = "meta"; // the ephemeral doc's own metadata Y.Map (NOT the shared body)
const SEEDED = "seeded"; // guard flag: the body has been seeded from the fence once
const BODY = "body"; // the shared island body Y.Text (both peers' inner editors bind to THIS via yCollab)

// The shared body text of the ephemeral doc.
export function ephemeralBody(doc: Y.Doc): Y.Text {
  return doc.getText(BODY);
}

// Whether the shared body has already been seeded from the fence text (the guard flag).
export function isSeeded(doc: Y.Doc): boolean {
  return !!doc.getMap(META).get(SEEDED);
}

// Elect the single seeder among the co-occupants: the lowest clientID present. Only that peer is eligible
// to seed the append-type body (so two racing seeders cannot double the text). An empty roster elects no
// one — seeding waits until co-occupancy is actually observed.
export function shouldSeed(myClientID: number, presentClientIDs: readonly number[]): boolean {
  if (!presentClientIDs.length) return false;
  return myClientID === Math.min(...presentClientIDs);
}

// Seed the shared body from the fence text ONCE. No-op (returns false) if already seeded (a late joiner) or
// if this peer is not the elected seeder. When it does seed, the body insert and the `seeded` guard are set
// in ONE transaction (a peer syncing mid-seed never sees an unguarded seeded body). Defensive: it only ever
// inserts into an EMPTY body, so even a logic slip cannot append onto existing shared text and double it.
export function seedEphemeralBodyOnce(
  doc: Y.Doc,
  myClientID: number,
  presentClientIDs: readonly number[],
  fenceText: string,
): boolean {
  const meta = doc.getMap(META);
  if (meta.get(SEEDED)) return false; // already seeded — bind, never re-seed
  if (!shouldSeed(myClientID, presentClientIDs)) return false; // not the elected seeder
  let seeded = false;
  doc.transact(() => {
    const body = doc.getText(BODY);
    if (body.length === 0) body.insert(0, fenceText); // only ever seed an EMPTY body (never append/double)
    meta.set(SEEDED, true);
    seeded = true;
  });
  return seeded;
}
