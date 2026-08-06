// #653 ③: three situations shared one sentence, and only one of them was about the key.
//
// "That key did not confirm it" was answered to a browser with no WebAuthn at all, to a prompt the
// reader dismissed, and to a key already enrolled on this account. The next moves are use a different
// browser, press the button again, and look at the list you already have — nothing in common, and the
// one sentence they shared points at hardware in every case.
//
// Measured on the classifier, like #673's, because the interesting inputs are what a BROWSER throws.
// SimpleWebAuthn wraps and re-throws them, so what arrives at the handler is a `WebAuthnError` carrying
// the original's name and its own code — which is why matching `instanceof DOMException` would see
// nothing. Here those are ordinary values.
import { describe, it, expect } from "vitest";
import { classifyEnrolmentFailure } from "./factor-removal-failure";
import { apiErrorFrom } from "../data/apiClient";

const apiError = (status: number, code?: string) =>
  apiErrorFrom(status, "/me/factors/passkey", code ? { code, message: "no" } : { message: "no" });

/** What SimpleWebAuthn hands the caller: its own code, and the underlying exception's name. */
const wrapped = (code: string, name: string) => Object.assign(new Error("wrapped"), { code, name });

describe("#653: why the passkey did not enrol", () => {
  it("a dismissed prompt is a cancellation, not a failure", () => {
    // Chrome reports both a dismissal and a timeout this way; neither is a statement about the key, and
    // neither is worth an error toast.
    expect(classifyEnrolmentFailure(Object.assign(new Error("not allowed"), { name: "NotAllowedError" })))
      .toBe("cancelled");
    expect(classifyEnrolmentFailure(Object.assign(new Error("aborted"), { name: "AbortError" })))
      .toBe("cancelled");
    // …and through the library's wrapper, which is how it actually arrives.
    expect(classifyEnrolmentFailure(wrapped("ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY", "NotAllowedError")))
      .toBe("cancelled");
  });

  it("a key already enrolled says so, rather than looking like a fault", () => {
    // `excludeCredentials` matched: the authenticator is refusing to make a SECOND credential for an
    // account it already has one for. The row is in the list on the same screen.
    expect(classifyEnrolmentFailure(wrapped("ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED", "InvalidStateError")))
      .toBe("already");
    // Checked BEFORE the name, because underneath it is an InvalidStateError — a name that would
    // otherwise fall through to "other" and be reported as the key's fault.
    expect(classifyEnrolmentFailure(Object.assign(new Error("x"), { name: "InvalidStateError" })))
      .toBe("other");
  });

  it("the cap comes from the server, by code and not by prose", () => {
    expect(classifyEnrolmentFailure(apiError(409, "factor_limit_reached"))).toBe("limit");
    // Any other server answer is NOT the cap: a 500 that disabled the add button and claimed the
    // account was full would be a lie the reader cannot check.
    expect(classifyEnrolmentFailure(apiError(500))).toBe("other");
    expect(classifyEnrolmentFailure(apiError(404, "factor_not_pending"))).toBe("other");
  });

  it("anything unrecognised stays unrecognised", () => {
    // The default must not be one of the specific answers. A classifier that guessed "cancelled" for
    // an unknown error would silently swallow real breakage into an info toast.
    expect(classifyEnrolmentFailure(new Error("network"))).toBe("other");
    expect(classifyEnrolmentFailure(null)).toBe("other");
    expect(classifyEnrolmentFailure("a string")).toBe("other");
  });
});
