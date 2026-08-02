// #510: the structural guard for the #504 destructive-operation policy — "a delete-class action is
// red at rest and confirmed before it runs". #504 fixed 26 sites by hand; nothing stopped the next
// unguarded delete button from rotting the policy (the #432/#444/#453 "fix one instance, stay green"
// class). This analyzer walks the web source and flags any DESTRUCTIVE INVOCATION that is neither
// (a) lexically inside a confirm context (an `onConfirm={...}` handler, or a `run:`/`onDelete:`-style
// closure that a ConfirmDialog executes), nor (b) allowlisted with a reason.
//
// Honest scope: this is a HEURISTIC, not a proof. It catches the common shapes — a mutation hook named
// destructively whose `.mutate(...)` runs outside any confirm context, or a destructively-named API
// helper invoked directly from a handler. A creatively-renamed mutation slips through; the point is to
// stop the unguarded MAJORITY, with the allowlist (reason required) as the manual valve. Detection is
// pure string/offset work on the source text — no AST dependency, no grep (Bash grep false-negatives
// on this repo are a known trap).

// The destructive vocabulary. A hook `useDeleteX()`, a binding `const del = useRemoveY()`, or an API
// helper `revokeInvite(...)` all match through their NAME.
// `destroy` is deliberately absent: the only destroy() calls in the web source are CodeMirror/view
// lifecycle teardowns, not user-facing destructive operations.
const DESTRUCTIVE_VERB = /^(delete|remove|revoke|purge|erase|unassign|trash)/i;

// A file that INVOKES destructive actions outside a confirm context must justify each one here.
// Key: `<file basename>:<identifier>`. The reason is part of the record — an entry without a real
// "reversible in one step" style justification should not be added.
export const ALLOWLIST: Record<string, string> = {
  // Pre-#504 sites the guard surfaced that were OUTSIDE the audit's 26 (recorded here honestly and
  // listed on the ticket for a ruling — the guard's job is stopping NEW unguarded deletes):
  "Sidebar.tsx:deletePin": "unpin is re-pinnable in one step; outside the #504 audit scope (surfaced by #510)",
  "AdminEnrollmentSection.tsx:removeDomain": "an enroll domain is re-addable in one step; outside the #504 audit scope (surfaced by #510)",
  // #504 review exception candidates — red at rest, no confirm (reversible in one step):
  // #514 slice 4 moved role assignment off the Roles tab: the tenant one now lives beside the members.
  // #579 folded that form into the member table, so the same sanctioned exception now lives on the
  // row (MembersPage) and in the group section — one surface became two, the reason is unchanged.
  "MembersPage.tsx:unassignRole": "un-assignment is re-assignable in one step (#504 exception)",
  "TenantGroupRoles.tsx:unassign": "un-assignment is re-assignable in one step (#504 exception)",
  "AccountPage.tsx:removeAvatar": "re-uploading restores the avatar (#504 exception)",
  "WatchListPage.tsx:unwatch": "re-watching is one click on the page (#504 exception)",
  "PermissionsDialog.tsx:revoke": "a page grant is re-grantable in one step (#504 exception)",
  "SpaceMembersTab.tsx:revoke": "a space grant is re-grantable in one step (#504 exception)",
  // dash-ok: these strings are the guard's own rationale, read in test output, never on a screen
  "SpaceMembersTab.tsx:revokeCapsForRow": "pure helper — computes which caps a row's revoke covers, deletes nothing itself (#553)",
  "SpaceMembersTab.tsx:unassignRole": "a space role assignment is re-assignable in one step (#485/#504 exception)",
  "PermissionsDialog.tsx:unassignRole": "a page role assignment is re-assignable in one step, the same as the capability grant beside it (#582/#504 exception)",
  // dash-ok: the guard's own rationale, read in test output
  "AdminEmbedsTab.tsx:remove": "the removal is STAGED until Save — undoable in place (#504 exception)",
  "SpaceSettingsPage.tsx:removeIcon": "re-uploading restores the space icon (#504 exception)",
  "TenantBrandingTab.tsx:removeLogo": "re-uploading restores the tenant logo (#504 exception)",
};

// Confirm-context openers: a destructive call whose offset falls inside one of these expressions is
// executed BY a confirmation, not by the raw trigger.
//  - onConfirm={ ... }      the ConfirmDialog's confirm handler
//  - run: ( ... ) => ...    the deferred-action pattern (MembersPage: the dialog runs `confirming.run`)
const CONTEXT_OPENERS = [/onConfirm=\{/g, /\brun:\s*\(/g];

// Find the offset ranges of confirm contexts by balanced-delimiter scanning from each opener.
export function confirmContextRanges(src: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (const opener of CONTEXT_OPENERS) {
    opener.lastIndex = 0;
    for (let m = opener.exec(src); m; m = opener.exec(src)) {
      const start = m.index + m[0].length - 1; // the opening { or (
      const open = src[start]!;
      const close = open === "{" ? "}" : ")";
      let depth = 0;
      let i = start;
      for (; i < src.length; i++) {
        const ch = src[i];
        if (ch === open) depth++;
        else if (ch === close) {
          depth--;
          if (depth === 0) break;
        }
      }
      // for `run: (` the closure BODY follows the arrow — extend the range to the end of the
      // statement-ish chunk (the next `}` at the same brace baseline is close enough for a lexical
      // guard; run-closures in this codebase are single expressions ending before `})`).
      let to = i;
      if (open === "(") {
        const arrow = src.indexOf("=>", to);
        if (arrow !== -1 && arrow - to < 8) {
          // walk the arrow body: a braced block or a single expression up to the enclosing `})`
          let j = arrow + 2;
          while (j < src.length && /\s/.test(src[j]!)) j++;
          if (src[j] === "{") {
            let d = 0;
            for (; j < src.length; j++) {
              if (src[j] === "{") d++;
              else if (src[j] === "}") { d--; if (d === 0) break; }
            }
            to = j;
          } else {
            // expression body: end at the first unbalanced `}` or `,` at depth 0
            let d = 0;
            for (; j < src.length; j++) {
              const ch = src[j];
              if (ch === "(" || ch === "{" || ch === "[") d++;
              else if (ch === ")" || ch === "}" || ch === "]") { if (d === 0) break; d--; }
              else if (ch === "," && d === 0) break;
            }
            to = j;
          }
        }
      }
      out.push({ from: m.index, to });
    }
  }
  return out;
}

export interface Violation { identifier: string; offset: number }

// Blank out comments IN PLACE (same length, offsets preserved) so a destructive verb in prose —
// "// delete needs manage" — never reads as an invocation.
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, pre) => pre + " ".repeat(m.length - pre.length));
}

// Analyze ONE file's source. Returns destructive invocations that are outside every confirm context
// and not allowlisted for this file.
export function analyzeDestructive(basename: string, rawSrc: string, allowlist: Record<string, string> = ALLOWLIST): Violation[] {
  const src = stripComments(rawSrc);
  const contexts = confirmContextRanges(src);
  const inContext = (off: number) => contexts.some((c) => off >= c.from && off <= c.to);
  const seen = new Map<string, number>(); // identifier → first offending offset

  // Shape 1: a destructively-named mutation binding whose `.mutate(` runs outside a confirm context.
  //   const del = useDeleteAttachment(...) … del.mutate(id)
  const bindings = new Map<string, string>(); // varName → hookName
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*use(\w+)\s*\(/g)) {
    if (DESTRUCTIVE_VERB.test(m[2]!)) bindings.set(m[1]!, m[2]!);
  }
  for (const [varName] of bindings) {
    for (const call of src.matchAll(new RegExp(`\\b${varName}\\.(mutate|mutateAsync)\\s*\\(`, "g"))) {
      if (!inContext(call.index!)) seen.set(varName, seen.get(varName) ?? call.index!);
    }
  }

  // Shape 2: a destructively-named function invoked directly (API helpers like removeMember(token,…)
  // or local handlers). Definitions, imports and type positions are skipped by requiring a call `(`
  // and excluding declaration keywords just before the name.
  for (const call of src.matchAll(/\b([a-z]\w*)\s*\(/g)) {
    const name = call[1]!;
    if (!DESTRUCTIVE_VERB.test(name)) continue;
    if (bindings.has(name)) continue; // shape-1 handles the binding form
    const before = src.slice(Math.max(0, call.index! - 24), call.index!);
    if (/(function|const|let|var|import|use[A-Z]\w*)\s*$/.test(before)) continue; // a definition/hook, not a call
    if (/\.\s*$/.test(before)) continue; // method form (covered by shape 1 / not our vocabulary)
    if (!inContext(call.index!)) seen.set(name, seen.get(name) ?? call.index!);
  }

  return [...seen.entries()]
    .filter(([name]) => !(`${basename}:${name}` in allowlist))
    .map(([identifier, offset]) => ({ identifier, offset }));
}

// Files whose ONLY destructive sites are the pre-#504 legacy entries above: the red-at-rest check
// does not apply until the user rules on them (they are outside the audited 26 — see the ticket).
export const LEGACY_FILES = new Set(["Sidebar.tsx", "AdminEnrollmentSection.tsx"]);

// A file with destructive sites must also paint at least one danger trigger — the #504 "red at rest"
// half of the policy. File-granular on purpose (per-trigger attribution is beyond a lexical guard).
const DANGER_MARKERS = [/variant="danger(Ghost)?"/, /variant=\{?"destructive"\}?/, /text-destructive/, /variant="destructive"/];
export function hasDangerTrigger(src: string): boolean {
  return DANGER_MARKERS.some((m) => m.test(src));
}
