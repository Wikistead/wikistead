// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { mountSourceEditor } from "./source-editor";

// A minimal awareness stub — enough for yCollab's remote-selections plugin to attach without a live
// provider. The convergence under test is TEXT sync (yCollab's ySync ↔ the shared Y.Text), which does not
// depend on awareness state; the stub reports no remote peers. (y-protocols' Awareness is only a transitive
// dep here, so we don't import it — the stub keeps the test dependency-free.)
function awarenessStub(doc: Y.Doc): unknown {
  const states = new Map<number, Record<string, unknown>>();
  return {
    doc,
    clientID: doc.clientID,
    states,
    meta: new Map(),
    getStates: () => states,
    getLocalState: () => ({}),
    setLocalState: () => {},
    setLocalStateField: () => {},
    on: () => {},
    off: () => {},
    destroy: () => {},
  };
}

// #502 / ADR-184 slice 2b: the shared-ephemeral-doc binding of the island source editor. When two peers
// co-occupy an island, each editor live-binds (yCollab) to a shared EPHEMERAL Y.Text (never the canonical
// one). These pins verify the co-edit mechanism end-to-end at the EDITOR level: two editors bound to two
// synced ephemeral docs converge, and — critically — the ABSENT-collab path stays byte-identical (a lone
// editor keeps its private doc, so the shipped single-editor behaviour cannot regress).

// Two Y.Docs relaying updates to each other, like the ephemeral room's server. (Real synced Yjs — the
// convergence is deterministic; on("update") is synchronous.)
function pairedDocs() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on("update", (u: Uint8Array) => Y.applyUpdate(b, u));
  b.on("update", (u: Uint8Array) => Y.applyUpdate(a, u));
  return { a, b };
}

describe("mountSourceEditor collab binding (#502 slice 2b)", () => {
  it("initialises from the shared body and CONVERGES a remote edit into the peer's editor", () => {
    const { a: docA, b: docB } = pairedDocs();
    const textA = docA.getText("body");
    const textB = docB.getText("body");
    textA.insert(0, "seed"); // the single seeded body (slice 2a) — syncs to docB before the editors mount

    const parentA = document.createElement("div");
    const parentB = document.createElement("div");
    document.body.append(parentA, parentB);
    const A = mountSourceEditor({
      parent: parentA, doc: "IGNORED", dark: false, testid: "src-a",
      collab: { text: textA, awareness: awarenessStub(docA) }, onInput: () => {}, onCommit: () => {},
    });
    const B = mountSourceEditor({
      parent: parentB, doc: "IGNORED", dark: false, testid: "src-b",
      collab: { text: textB, awareness: awarenessStub(docB) }, onInput: () => {}, onCommit: () => {},
    });

    // Both editors take their initial content from the SHARED body, not the passed `doc`.
    expect(A.getValue()).toBe("seed");
    expect(B.getValue()).toBe("seed");

    // Type in A (a CM transaction) → yCollab writes to textA → relays to textB → B's yCollab updates B's doc.
    A.view.dispatch({ changes: { from: 4, insert: " more" } });
    expect(textA.toString()).toBe("seed more"); // A's edit reached the shared Y.Text
    expect(B.getValue()).toBe("seed more"); // ...and converged into B's editor — real co-edit

    A.destroy();
    B.destroy();
  });

  it("ABSENT collab: keeps the private doc from `doc` (single-editor path byte-identical)", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const A = mountSourceEditor({
      parent, doc: "local text", dark: false, testid: "src-lone", onInput: () => {}, onCommit: () => {},
    });
    // No shared binding → the editor holds its own doc from `doc`, exactly as before this slice.
    expect(A.getValue()).toBe("local text");
    A.view.dispatch({ changes: { from: 10, insert: "!" } });
    expect(A.getValue()).toBe("local text!"); // a plain local edit; nothing shared, nothing to converge
    A.destroy();
  });
});
