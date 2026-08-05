// #624 (the client half): the permissions dialog must not turn typed text into a subject id.
//
// It did. `pickedGrant?.grantee ?? (sub.trim() ? \`user:${sub.trim()}\` : null)` sent whatever was in the
// box as a principal, and a sub is not something a person knows — it is minted by a connection
// (`wc<conn8>_<external>`) or by this product (`wlocal_<uuid>`). What that produced, measured in dev:
// four `role_assignments` rows for a principal with no members row, `origin='manual'`, the newest from
// that morning; the roster then displayed the raw hex, which somebody could copy off their own screen
// and paste straight back in — which is how the page rows were made.
//
// The server does not yet refuse these (that half is measured and reported on the ticket: the guard is
// correct and 125 existing tests grant to non-member subs, so it is not a one-line change). Until it
// does, this is the affordance that creates them, and removing it is worth having on its own.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(import.meta.dirname, "./PermissionsDialog.tsx"), "utf8");

describe("#624: a principal comes from a chosen candidate, never from the text box", () => {
  it("no path builds `user:` out of the input's value", () => {
    // Written against the SHAPE, not the two old lines: the failure is "the INPUT's text became an id",
    // and it can come back under a different variable name. Building `user:` from a CANDIDATE's sub is
    // fine and still happens (`user:${c.sub}`) — that sub came from the server. What must not appear is
    // one built from a state variable the box writes into.
    const inputs = [...SRC.matchAll(/const \[(\w+), set\w+\] = useState\(""\)/g)].map((m) => m[1]!);
    expect(inputs.length, 'the scan found the text inputs (a broken pattern must not pass vacuously)')
      .toBeGreaterThan(0);
    for (const name of inputs) {
      const built = new RegExp('`user:\\$\\{' + name + '[.\\w()]*\\}`');
      expect(built.test(SRC), `the dialog builds a principal out of the ${name} box`).toBe(false);
    }
  });

  it("both add paths still work — the candidate is what they send", () => {
    // The other half of the statement: removing the fallback must not have removed the feature. Both
    // handlers read the picked candidate, and both bail when there is none rather than sending null.
    expect(SRC, "the grant path").toContain("const grantee = pickedGrant?.grantee ?? null");
    expect(SRC, "the restriction path").toContain("const principal = pickedRestrict?.grantee ?? null");
    expect(SRC.match(/if \(!grantee\) return;/), "a missing choice is a no-op, not a null request").toBeTruthy();
    expect(SRC.match(/if \(!principal\) return;/)).toBeTruthy();
  });

  it("the role-assignment path takes the candidate too", () => {
    // `resolveGrantDispatch` receives the picked candidate or null — it used to receive a synthesised
    // principal, so a role could be assigned to a typed string exactly as a built-in grant could.
    expect(SRC).toMatch(/picked: pickedGrant \? \{ grantee: pickedGrant\.grantee \} : null/);
  });

  it("GROUP names are still typed — this narrows users, not groups", () => {
    // #578 OQ4: naming a directory group nobody carries yet is deliberate, because a group's identity is
    // a NAME a human knows. A change that removed both would have retired a feature while fixing a bug.
    expect(SRC, "the group path still sends a typed name").toMatch(/grant\.mutate\(\{ groupName, relation \}/);
  });
});
