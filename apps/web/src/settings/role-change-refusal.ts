import { ApiError } from "../data/apiClient";

/**
 * Which sentence a refused member write earns (#866 ②, review rejection 2026-08-27).
 *
 * The member screen answered every 409 except one with "cannot change the last admin". That sentence
 * is true of exactly one of them. #866 added a second guard underneath the floor — a demotion that
 * leaves administrators behind but leaves NOBODY who can sign in — and its 409 came out wearing the
 * floor's words, so the screen told an operator with two administrators that there was only one.
 *
 * ADR-251 §3.7 chose `demoting` as its own closing shape precisely so the two refusals could say
 * different things; collapsing the codes here is where that choice was being thrown away. A refusal
 * that reads like a bug is the one somebody removes in good faith.
 *
 * A pure function rather than a chain inside the handler: the interesting cases are server codes, and
 * as values they can be pinned without a DOM. Same shape as `classifyRemovalFailure` beside it.
 *
 * ⚠️ The fallback is the GENERIC failure, never the floor's sentence. A code this table has not met
 * yet is a code nobody has written words for — saying "the last admin" about it is a guess, and the
 * guess is what this ticket is fixing.
 */
export function roleChangeRefusalKey(e: unknown): string {
  if (!(e instanceof ApiError)) return "toast.actionFailed";
  switch (e.code) {
    // ADR-207: a group holds admin, but a group-conferred one can be lost by an IdP-side edit, so one
    // DIRECTLY granted administrator has to remain. Its own sentence since #603.
    case "last_direct_admin":
      return "members.lastDirectAdmin";
    // The floor: nobody else holds admin at all.
    case "last_admin":
      return "members.lastAdmin";
    // ADR-251 §3.7: administrators remain, but none of them could sign in afterwards. The recovery
    // for this one is a CREDENTIAL or another connection — not appointing another administrator,
    // which is what the floor's wording sends the reader off to do.
    case "login_lockout":
      return "members.lockoutRefused";
    // ADR-251 §3.2 / §3.8a: one way in would remain and the product cannot promise it works — OR
    // (§7-8: `floor: 'sso_exempt'`) this write would empty the SSO-exempt floor specifically. Two
    // different sentences behind the same code (#866 shipped the collapse, #963 had to un-ship it);
    // reading `floor` is what keeps this screen from repeating that.
    case "confirm_required":
      return e.floor === "sso_exempt" ? "members.exemptFloorConfirmRequired" : "members.confirmRequired";
    // A suspended member's role is not changed until they are back (members.ts).
    case "member_suspended":
      return "members.suspendedRoleChange";
    default:
      return "toast.actionFailed";
  }
}
