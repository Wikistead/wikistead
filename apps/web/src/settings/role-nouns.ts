// #582 bounce (user, on the device): " 1 ".
//
// A built-in grant and a custom role are one thing to the person reading a permissions surface: somebody
// wearing a role. The space Members tab has said so since #445 — it renders the capability as the NOUN
// the role is called (view→viewer, manage→manager) beside custom role names, in one picker and one row
// shape. The page dialog moved half of that over in #582 §1 (custom roles in the picker) and left the
// other half behind, so its picker said (a translated verb) while its rows said "manage" (a raw
// wire value) and its role badges shouted "KAKUNIN-582".
//
// The nouns live here so both screens IMPORT the same table. Two hand-written copies is how the last
// three copy pins rotted (#553's GRANTABLE is the fix that worked).
//
// Translation, per the 2026-08-02 ruling: a ROLE NAME is a proper noun and is never translated or
// case-shifted — not the built-ins, not a tenant's own role. A CAPABILITY (what a role may do) IS
// translated, and that vocabulary belongs on the surface that EDITS a role definition, not on one that
// says who holds which role.
export type RoleNounKey = "view" | "comment" | "edit" | "moderate" | "manage";

export const CAP_NOUN: Record<RoleNounKey, string> = {
  view: "viewer",
  comment: "commenter",
  edit: "editor",
  moderate: "moderator",
  manage: "manager",
};

/** The noun for a wire capability; unknown values pass through unchanged (a role name is already one). */
export const capNoun = (c: string): string => CAP_NOUN[c as RoleNounKey] ?? c;
