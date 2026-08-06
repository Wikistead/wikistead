import { ApiError } from "../data/apiClient";

/**
 * Why a factor removal did not happen (#673 ②).
 *
 * One `catch` used to answer "that key did not confirm it" to four different situations — including the
 * two where the key was never asked at all (a challenge route that 404s, a browser that cannot do
 * WebAuthn). A reader who is told their key failed goes and fetches a different key; the fix for a
 * dead route is to try again later, and the fix for a cancel is nothing at all. Same sentence, three
 * unrelated next moves.
 *
 * A pure function rather than a chain of `if`s inside the handler, because the interesting cases are
 * DOM exceptions a browser throws and a component test cannot easily provoke. Here they are values.
 */
export type RemovalFailure =
  /** the person dismissed the browser's prompt — not an error, and nothing to report as one */
  | "cancelled"
  /** the last admin factor under a live policy (#652's floor); the server said so */
  | "lastAdmin"
  /** the assertion was made and the server refused it: this key is not the one */
  | "key"
  /** anything else: the route, the network, a browser with no WebAuthn. NOT the key's fault. */
  | "other";

export function classifyRemovalFailure(e: unknown): RemovalFailure {
  // The server's own vocabulary first — it is the only source that knows about the floor.
  if (e instanceof ApiError) {
    if (e.code === "last_admin_factor") return "lastAdmin";
    // `passkey_invalid` is the ONE answer that means the key was tried and rejected. A 404 on the
    // challenge, a 500, a network failure — none of those are statements about the key.
    return e.code === "passkey_invalid" ? "key" : "other";
  }
  // WebAuthn reports a dismissed prompt as NotAllowedError, and an aborted one as AbortError. The name
  // is matched rather than `instanceof DOMException`, because SimpleWebAuthn wraps and re-throws (the
  // wrapper carries the name; the prototype does not survive).
  const name = typeof e === "object" && e !== null && "name" in e ? String((e as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "AbortError") return "cancelled";
  return "other";
}
