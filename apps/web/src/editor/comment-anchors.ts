import * as Y from "yjs";

// Inline comment anchors reference a RANGE in the page Y.Text via Yjs
// RelativePosition — the same edit-following mechanism as remote carets (ADR-008).
// We persist the ENCODED relative position (opaque bytes, base64 for transport);
// the server stores it without ever interpreting it (Y-agnostic). On render we
// resolve it back to an absolute [from, to) against the LIVE doc — which follows
// edits automatically, and collapses (→ null) when the anchored text is deleted,
// so the thread becomes "orphaned" rather than mispositioned.
export interface EncodedAnchor {
  start: string;
  end: string;
}

const b64encode = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const b64decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Create an anchor for the half-open range [from, to) on the given Y.Text.
// assoc: start sticks to the following char (+1), end to the preceding char (-1),
// so text typed at the edges grows/leaves the range intuitively and text typed
// strictly before it shifts the whole range.
export function createAnchor(ytext: Y.Text, from: number, to: number): EncodedAnchor {
  const start = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, from, 1));
  const end = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, to, -1));
  return { start: b64encode(start), end: b64encode(end) };
}

// Resolve an anchor to its current absolute range, or null if it can no longer be
// placed as a non-empty range (the anchored text was deleted → orphaned thread).
export function resolveAnchor(doc: Y.Doc, anchor: EncodedAnchor): { from: number; to: number } | null {
  const absStart = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(b64decode(anchor.start)), doc);
  const absEnd = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(b64decode(anchor.end)), doc);
  if (!absStart || !absEnd) return null;
  const from = Math.min(absStart.index, absEnd.index);
  const to = Math.max(absStart.index, absEnd.index);
  if (to <= from) return null; // collapsed → the anchored text is gone (orphan)
  return { from, to };
}
