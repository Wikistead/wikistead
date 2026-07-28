// #536 review 7: what the merged picker DOES when Add is clicked, as a value.
//
// The group bug lived inside the click handler: a principal string was assembled inline, it was
// well-formed, and nothing could test it short of driving the whole component — which this repo has no
// harness for (component-testing would be a new dependency, i.e. a license-gated decision). So the
// decision is separated from its execution: this resolves a picker state to the ACTION the handler will
// take, and the handler only executes it. The four combinations (user/group × built-in/custom) become
// plain values a test can hold.
//
// The group rule is structural here: a group action carries the NAME, never a principal. The FGA id is a
// tenant-salted hash only the server can derive (`groupGrantee`); the one time this file's caller built
// `group:<name>#member` itself, the write succeeded, the toast said so, and nobody gained anything.

export type GrantTarget =
  | { kind: "user"; principal: string }
  | { kind: "group"; groupName: string };

export type GrantAction =
  | { path: "grant"; capability: string; target: GrantTarget }
  | { path: "assign"; roleId: string; target: GrantTarget }
  | { path: "none" };

export function resolveGrantDispatch(args: {
  pick: string; // "builtin:<capability>" | "role:<roleId>" — the merged picker's value
  mode: "user" | "group";
  picked: { grantee: string } | null; // member mode: the chosen member, principal ALREADY formed upstream
  groupName: string; // group mode: the raw name the server derives the id from
}): GrantAction {
  const target: GrantTarget | null =
    args.mode === "group"
      ? (args.groupName ? { kind: "group", groupName: args.groupName } : null)
      : (args.picked ? { kind: "user", principal: args.picked.grantee } : null);
  if (!target) return { path: "none" };

  if (args.pick.startsWith("role:")) {
    const roleId = args.pick.slice("role:".length);
    return roleId ? { path: "assign", roleId, target } : { path: "none" };
  }
  if (args.pick.startsWith("builtin:")) {
    const capability = args.pick.slice("builtin:".length);
    return capability ? { path: "grant", capability, target } : { path: "none" };
  }
  // an unrecognised value grants nothing rather than guessing a mechanism
  return { path: "none" };
}
