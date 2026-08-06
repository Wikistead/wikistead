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

/**
 * Why a passkey ENROLMENT did not happen (#653 ③).
 *
 * Kept beside its removal counterpart because the vocabulary is the same one — a browser's DOM
 * exceptions and the server's codes — and splitting it across two files is how the same knowledge ends
 * up spelt two ways. The OUTCOMES differ, which is why this is a second function and not a flag: an
 * enrolment can be refused for being a duplicate of a key already held, and a removal cannot.
 *
 * "Unsupported" is absent on purpose: it is answered BEFORE anything starts, so that a browser which
 * cannot run the ceremony is never issued a challenge, which would cost a slot against the cap.
 */
export type EnrolmentFailure =
  /** the person dismissed the browser's prompt */
  | "cancelled"
  /** this authenticator already holds a credential for this account — it is in the list already */
  | "already"
  /** the cap; the server said so */
  | "limit"
  /** anything else */
  | "other";

export function classifyEnrolmentFailure(e: unknown): EnrolmentFailure {
  if (e instanceof ApiError) return e.code === "factor_limit_reached" ? "limit" : "other";
  // SimpleWebAuthn's own code for `excludeCredentials` matching. It is checked before the DOM names
  // because the library reports it as an InvalidStateError underneath, which says nothing on its own.
  if (typeof e === "object" && e !== null && "code" in e
    && (e as { code: unknown }).code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") return "already";
  // Matched on the NAME rather than `instanceof DOMException`: SimpleWebAuthn wraps and re-throws, and
  // the wrapper carries the name while the prototype does not survive.
  const name = typeof e === "object" && e !== null && "name" in e ? String((e as { name: unknown }).name) : "";
  return name === "NotAllowedError" || name === "AbortError" ? "cancelled" : "other";
}
