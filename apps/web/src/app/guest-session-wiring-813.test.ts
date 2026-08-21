// #813 / ADR-248 §3.5: the two faces reach the two places, and neither is a React value.
//
// `guest-session-813.test.ts` measures the session. This measures the WIRING, which is the half that
// decides whether any of it helps: a renewal that only reaches the socket leaves publish on a dead
// credential (the path the reported accident actually took), and a renewal that reaches the editor as
// state destroys the Y.Doc or rebuilds every CodeMirror view.
//
// It reads the route table because what is being checked is which identity is handed where, inside a
// module with a live query client, a socket and a CodeMirror surface behind it. Identity is legible in
// the source; it is not legible from a rendered tree.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(import.meta.dirname, "routes.tsx"), "utf8");

/** The one component that owns a guest session, as a string. */
function host(): string {
  const start = SRC.indexOf("function GuestSessionHost(");
  expect(start, "GuestSessionHost has been renamed — re-read this file before trusting it").toBeGreaterThan(0);
  return SRC.slice(start, SRC.indexOf("\nfunction ", start + 10));
}

describe("#813 the guest session is built once and never re-created", () => {
  it("lives in a ref, not in state", () => {
    const h = host();
    // ⚠️ `useState(makeGuestSession(...))` would look equivalent and is not: React calls the initialiser
    // argument on every render even when it discards the result, so the session would be constructed
    // repeatedly — and a lazy initialiser would still be a value the tree re-renders around.
    expect(h).toMatch(/sessionRef\s*=\s*useRef/);
    expect(h, "a session in state is a session the tree can replace").not.toMatch(/useState\(\s*makeGuestSession/);
  });

  it("⚠️ hands down two ref-held functions, never the token", () => {
    const h = host();
    expect(h).toMatch(/getTokenRef\s*=\s*useRef/);
    expect(h).toMatch(/apiBearerRef\s*=\s*useRef/);
    // The identities must come from the refs. An inline arrow at the call site is a NEW function every
    // render, and the collab effect compares by identity — its teardown destroys the Y.Doc, so this
    // would turn a five-minute problem into a per-render one.
    expect(h).toMatch(/getToken=\{getTokenRef\.current/);
    expect(h).toMatch(/apiBearer=\{apiBearerRef\.current/);
    expect(h, "an inline getter is a new identity per render").not.toMatch(/getToken=\{\(\)\s*=>/);
    expect(h, "an inline bearer is a new identity per render").not.toMatch(/apiBearer=\{\(\)\s*=>/);
  });

  it("and the token does not travel as a prop", () => {
    const h = host();
    // The mint's other fields are legitimate news (a link narrowed to `view` while somebody read).
    // The credential is not: everything that needs it asks the session at the moment it needs it.
    expect(h).toMatch(/token:\s*""/);
  });
});

describe("#813 the guest editor gets the right face in each hand", () => {
  /** The guest surface's `<Editor …>` tag. Requires a prop, so the prose about `<Editor>` is not counted. */
  function guestEditorTag(): string {
    const tag = [...SRC.matchAll(/<Editor\s+[^>]*docName=[^>]*>/g)].map((m) => m[0]).find((t) => t.includes("guestSurface"));
    expect(tag, "the guest Editor call site moved").toBeTruthy();
    return tag!;
  }

  it("the socket gets the async getter and the HTTP layer gets the per-request bearer", () => {
    const tag = guestEditorTag();
    expect(tag).toContain("token={getToken}");
    expect(tag).toContain("apiToken={token}");
    // ⚠️ Both, or neither helps. The socket alone leaves publish answering 401 on a live connection —
    // which is exactly what the demo saw and reported as "it said published".
  });

  it("neither is the mint's own token field", () => {
    // `minted.token` is empty by the time it reaches here; a call site that used it would be handing
    // the editor an empty string and every request would go out unauthenticated.
    const tag = guestEditorTag();
    expect(tag).not.toMatch(/token=\{minted\.token\}/);
    expect(tag).not.toMatch(/apiToken=\{minted\.token\}/);
  });
});
