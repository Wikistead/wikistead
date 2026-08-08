// #686 B: a code the server refused is told apart from everything else that can go wrong.
//
// The account panel has said "that code did not match" since #657. The two sign-in surfaces — the door
// asking for a code, and the enrolment confirm during sign-in — collapsed every non-5xx failure into
// "That did not work. Try again." Somebody who mistyped six digits was told nothing, and retyped the
// same six digits.
//
// It is the third time this shape has been fixed: #673 split a removal's failures, #681 split a server
// fault from a wrong password. Each was fixed on the surface it was reported on.
//
// ⚠️ Classified by the server's CODE, never its prose. #578 replaced an error sentence and silently
// broke four places that matched on the words. And anything the server does not name that way keeps the
// generic sentence: "your code is wrong" said about a rate limit is a new wrong answer, not a fix.
//
// ⚠️ The 5xx split from #681 is non-regression here — a broken dependency must not be reported as a
// wrong code, which is exactly what this file's own fix could reintroduce by widening too far.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const STEP = readFileSync(resolve(import.meta.dirname, "FactorStep.tsx"), "utf8");
const PANEL = readFileSync(resolve(import.meta.dirname, "../settings/SecondFactorPanel.tsx"), "utf8");

describe("#686 族 B: the sign-in surfaces say which failure it was", () => {
  it("the classifier reads a code, not a sentence", () => {
    expect(STEP, "the wrong-code case is not distinguished at all").toContain('"badCode"');
    expect(STEP, "the refusal is identified by the server's code").toContain("factor_code_invalid");
    // Matching on prose is how #578 broke four call sites at once when a message was reworded.
    expect(STEP, "the classifier matches on the server's English")
      .not.toMatch(/message\s*[=.]==?\s*["'`]/);
  });

  it("both code-submitting surfaces use it — the door and the enrolment confirm", () => {
    // Two `await classify(` calls, because those are the two places a person types six digits. The
    // passkey ceremony's failures deliberately do NOT use it: that catch also fires when the reader
    // presses Escape on the browser prompt, and "your code was wrong" about a cancelled ceremony is
    // the same species of lie this file exists to remove.
    expect((STEP.match(/await classify\(/g) ?? []).length,
      "one of the two code surfaces still collapses its failures").toBe(2);
    expect(STEP, "the passkey ceremony's catch was swept in with them")
      .toContain('setFailed("code"); setBusy(false);');
  });

  it("the accurate sentence is the one already shipped, not a third spelling", () => {
    // #653 ③ and #673 both landed because this surface kept growing new ways to say one thing.
    expect(STEP, "a second wording for a wrong code was invented").toContain("account.factorCodeWrong");
  });

  it("#681 non-regression: a server fault is still not a wrong code", () => {
    expect(STEP, "the 5xx branch was lost while splitting the code case").toContain("auth.temporarilyUnavailable");
    expect(STEP).toContain("isServerFault");
    // …and the account panel, which was OUTSIDE #681's sweep, now draws the same line. It told somebody
    // their six digits were wrong while the dependency behind the confirm was broken.
    expect((PANEL.match(/auth\.temporarilyUnavailable/g) ?? []).length,
      "the account panel still blames the reader for an outage").toBe(2);
  });
});
