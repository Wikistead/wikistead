// #673 ②: four situations shared one sentence, and two of them never involved the key.
//
// The report was written by somebody whose dev server was a build behind: `POST …/remove-challenge`
// answered 404, and the screen said "that key did not confirm it". The key had not been asked for. Two
// wrong conclusions are available from that sentence — the key is broken, or the account is — and
// neither leads to "wait, and try again".
//
// Measured on the classifier rather than through the panel, because the interesting inputs are what a
// BROWSER throws (a dismissed WebAuthn prompt), which a component test cannot provoke and a browser
// test cannot easily provoke on purpose. As values they are ordinary.
import { describe, it, expect } from "vitest";
import { classifyRemovalFailure } from "./factor-removal-failure";
import { apiErrorFrom } from "../data/apiClient";

/** Built the way the client builds one, so the `code` reaches the classifier by the real route. */
const apiError = (status: number, code?: string) =>
  apiErrorFrom(status, "/me/factors/x", code ? { code, message: "no" } : { message: "no" });

describe("#673: why the removal did not happen", () => {
  it("a dismissed prompt is a cancellation, not a failure", () => {
    // What Chromium throws when somebody closes the WebAuthn sheet. Reported as an error, it tells a
    // person who deliberately backed out that something is wrong with their key.
    expect(classifyRemovalFailure(Object.assign(new Error("The operation either timed out or was not allowed"), { name: "NotAllowedError" }))).toBe("cancelled");
    expect(classifyRemovalFailure(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe("cancelled");
  });

  it("only the server's own `passkey_invalid` blames the key", () => {
    expect(classifyRemovalFailure(apiError(400, "passkey_invalid"))).toBe("key");
  });

  it("a missing route, a server fault and a network failure are none of the key's business", () => {
    // The reported case first: the exact shape that produced the wrong sentence.
    expect(classifyRemovalFailure(apiError(404, "not_found")), "the challenge route was not there").toBe("other");
    expect(classifyRemovalFailure(apiError(500)), "the server fell over").toBe("other");
    expect(classifyRemovalFailure(new TypeError("Failed to fetch")), "the network went away").toBe("other");
    // A browser with no WebAuthn at all: SimpleWebAuthn throws a plain Error, and the honest answer is
    // "not the key" rather than a fifth sentence nobody can act on differently.
    expect(classifyRemovalFailure(new Error("WebAuthn is not supported in this browser"))).toBe("other");
  });

  it("the floor keeps its own answer", () => {
    // #652's guard refuses the last admin factor while the policy is on, and the code they typed was
    // right. It survived the split because its next move is different again: turn the policy off.
    expect(classifyRemovalFailure(apiError(409, "last_admin_factor"))).toBe("lastAdmin");
  });

  it("the four answers are actually distinct", () => {
    // The control. A classifier that returned "other" for everything would satisfy three cases above
    // and collapse the vocabulary right back to one sentence.
    const seen = new Set([
      classifyRemovalFailure(Object.assign(new Error(""), { name: "NotAllowedError" })),
      classifyRemovalFailure(apiError(400, "passkey_invalid")),
      classifyRemovalFailure(apiError(409, "last_admin_factor")),
      classifyRemovalFailure(apiError(404)),
    ]);
    expect(seen.size, `four situations, four answers :: ${[...seen].join(",")}`).toBe(4);
  });
});
