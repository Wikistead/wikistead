import * as Y from "yjs";

// #92 / ADR-093: the ephemeral Yjs binding for an Excalidraw scene (modal-scoped; flushed to the
// single Y.Text fence on close — NO permanent second CRDT). This module is the CORE reconcile logic:
// scene elements live in a Y.Map keyed by element id, and merges are RESOLVED BY VERSION (Excalidraw's
// own rule — each element carries a monotonically increasing `version`; the higher version wins, ties
// broken by the larger `versionNonce`). This gives deterministic, order-independent convergence for
// concurrent editors WITHOUT a bespoke CRDT per shape (Yjs LWW on the map key + version tiebreak).
//
// PURE of the network + React: takes a Y.Doc + element arrays, so it is unit-testable in isolation
// (the transport = an ephemeral Hocuspocus room, and the <Excalidraw> onChange/updateScene wiring, layer
// on top in a follow-up). Deletions are represented by Excalidraw's own `isDeleted` flag on the element
// (kept in the map so the tombstone propagates), never by removing the key — so a delete on one client
// is not resurrected by a stale insert on another.

/* eslint-disable @typescript-eslint/no-explicit-any */ // Excalidraw element JSON is external/dynamic.
export type ExElement = { id: string; version?: number; versionNonce?: number; isDeleted?: boolean; [k: string]: any };

const ELEMENTS = "elements"; // the Y.Map field on the ephemeral doc

export function elementsMap(doc: Y.Doc): Y.Map<ExElement> {
  return doc.getMap<ExElement>(ELEMENTS);
}

// Should `incoming` replace `existing`? Excalidraw's reconciliation: higher version wins; equal version
// → higher versionNonce wins (stable, symmetric tiebreak); no existing → yes.
export function shouldReplace(existing: ExElement | undefined, incoming: ExElement): boolean {
  if (!existing) return true;
  const ev = existing.version ?? 0;
  const iv = incoming.version ?? 0;
  if (iv !== ev) return iv > ev;
  return (incoming.versionNonce ?? 0) > (existing.versionNonce ?? 0);
}

// A detached snapshot of an element. CRITICAL (#92): Excalidraw MUTATES its elements IN PLACE (a
// freedraw stroke grows its `points` array and bumps `version` on the SAME object). If we stored the
// live reference in the Y.Map, `map.get(id)` would return that very object, so on the next write
// existing===incoming and the version comparison always ties → nothing after the first write ever
// syncs (the peer sees only the stroke's start point). Storing a CLONE decouples the map's copy from
// the live object, so a grown element (higher version) is detected and re-written.
function snapshot(el: ExElement): ExElement {
  return structuredClone(el);
}

// Write local elements into the shared map, but ONLY those that are newer than what's there (so we
// don't clobber a concurrent peer's higher-version edit, and don't churn the doc with no-op writes).
// Stored as a snapshot (see above) so in-place Excalidraw mutations still propagate. One Yjs
// transaction (atomic). Returns the number of elements actually written.
export function writeLocalElements(doc: Y.Doc, elements: readonly ExElement[]): number {
  const map = elementsMap(doc);
  let written = 0;
  doc.transact(() => {
    for (const el of elements) {
      if (!el?.id) continue;
      if (shouldReplace(map.get(el.id), el)) {
        map.set(el.id, snapshot(el));
        written++;
      }
    }
  });
  return written;
}

// Read the merged scene elements from the shared map. Deleted elements (isDeleted) are dropped from the
// returned scene (Excalidraw hides them) but their tombstone stays in the map. Order is by the element's
// own fractional index if present, else insertion order of the map.
export function readSceneElements(doc: Y.Doc): ExElement[] {
  const out: ExElement[] = [];
  for (const el of elementsMap(doc).values()) {
    if (!el?.isDeleted) out.push(el);
  }
  out.sort((a, b) => {
    const ai = a.index, bi = b.index;
    if (typeof ai === "string" && typeof bi === "string") return ai < bi ? -1 : ai > bi ? 1 : 0;
    return 0; // no fractional index → keep stable (Excalidraw re-derives z-order from the array)
  });
  return out;
}

// ALL elements in the map INCLUDING isDeleted tombstones — for feeding Excalidraw's updateScene, which
// needs the deleted elements (isDeleted:true) present to reconcile a remote deletion (readSceneElements
// drops them for the clean fence flush, but the live scene needs them to converge).
export function allElements(doc: Y.Doc): ExElement[] {
  return [...elementsMap(doc).values()];
}

// Merge two element arrays by the version rule (used to prove convergence + seed/flush). Order-
// independent: merge(a,b) and merge(b,a) yield the same element set.
export function reconcile(a: readonly ExElement[], b: readonly ExElement[]): ExElement[] {
  const by = new Map<string, ExElement>();
  for (const el of [...a, ...b]) {
    if (!el?.id) continue;
    if (shouldReplace(by.get(el.id), el)) by.set(el.id, el);
  }
  return [...by.values()];
}
