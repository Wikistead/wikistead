import { describe, it, expect } from "vitest";
import { isServerFault } from "./serverFault";

// #681: the sign-in screen said "that email and password do not work" while the server was answering
// 500. The reporter lost minutes suspecting their own password.
//
// The server draws this line ON PURPOSE — `auth-local.ts` explains at length that a broken dependency
// is not a fact about anyone's credentials, so it is thrown rather than answered as an authentication
// failure. Without that, an outage sends every reader to the password-reset flow and the operator sees
// no errors at all. ⚠️ Four screens around that door then threw the distinction away in a `!res.ok`
// branch, so the cost the server paid vanished on the last step.
//
// This pins the one predicate they now share. The wiring itself is checked in the e2e that stubs a 500,
// because what matters there is the SENTENCE a reader sees.
const res = (status: number) => ({ status } as Response);

describe("#681: a server fault is not a fact about the reader", () => {
  it("5xx is the server's problem, not the password's", () => {
    expect(isServerFault(res(500))).toBe(true);
    expect(isServerFault(res(502))).toBe(true);
    expect(isServerFault(res(503))).toBe(true);
  });

  it("a request that never completed is not a fact about the reader either", () => {
    // A dropped connection, DNS, the tab going offline. The screens call this with `null` from a
    // `.catch(() => null)`, and answering "wrong password" there is the same lie.
    expect(isServerFault(null)).toBe(true);
    expect(isServerFault(undefined)).toBe(true);
  });

  it("⚠️ a refusal ABOUT the reader stays about the reader", () => {
    // The green path, and the one that stops "always unavailable" from passing everything above. A 401
    // really is a statement about these credentials, and a 400 about this request.
    expect(isServerFault(res(401))).toBe(false);
    expect(isServerFault(res(403))).toBe(false);
    expect(isServerFault(res(400))).toBe(false);
    expect(isServerFault(res(409))).toBe(false);
    expect(isServerFault(res(429)), "rate limiting is an answer about this caller").toBe(false);
  });

  it("a success is not a fault", () => {
    expect(isServerFault(res(200))).toBe(false);
    expect(isServerFault(res(204))).toBe(false);
  });
});
