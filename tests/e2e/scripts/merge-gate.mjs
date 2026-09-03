// #891: the "authentication and sharing entry" subset — chosen because every recurring e2e-red
// ticket (#839 guest tree, #867 invite, #889 checkbox) turned out to live in this handful of specs.
// Unlike the full 368-spec suite (which wedges OpenFGA around test 488 — #891), this set
// completes reliably in a few minutes and is small enough to run on every merge.
//
// This is NOT "all green" — a spec here can carry test.skip(true, "#NNN: isolated — ...") for a KNOWN,
// individually-ticketed red (#891 ruling §2: isolate one at a time, never a blanket skip). This
// script's job is to run the set, print how many tests are isolated right now (so a quiet skip count
// can't be mistaken for "nothing is broken"), and fail the gate on anything ELSE that's red.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const e2eDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const specsDir = join(e2eDir, "specs");

// #890 admin-roles-420.spec.ts and space-role-comment-485.spec.ts are NOT in this list — the
// destructive-write fix that made them use createScratchSpace/createScratchGroup instead of mutating
// the shared demo_space is therefore not re-verified on every merge, only the fixture-guard mechanism
// they exercise (which every run wires via playwright.config.ts regardless of which specs run). They
// are small enough to dodge the #926 wedge (~488 specs in) on their own, so they get their own targeted
// run instead of waiting on that: `pnpm --filter @wikistead/e2e e2e:fixture-guard-890`. Fold them into
// GATE_SPECS (or give them a dedicated CI step) once someone measures the combined runtime is still
// cheap enough for every merge.
export const GATE_SPECS = [
  // guest-*
  "guest-edit-macros-374.spec.ts",
  "guest-publish.spec.ts",
  "guest-search-449.spec.ts",
  "guest-sidebar-245.spec.ts",
  "guest-task-toggle-317.spec.ts",
  "guest-title-band-318.spec.ts",
  "guest-tree-error-500.spec.ts",
  "guest-vim-ex-448.spec.ts",
  // invite*
  "invite-handoff-638.spec.ts",
  "invite.spec.ts",
  // *login* (substring, not prefix — local-login-568 is part of the family too)
  "local-login-568.spec.ts",
  "login-screen-261.spec.ts",
  "login.spec.ts",
  // share*
  "share-password-233.spec.ts",
  "share.spec.ts",
  // signup
  "signup.spec.ts",
  // #891 ruling §1: 4 specs added back in — the actual repeat-offender count was 6, not 3,
  // and these 4 were outside the original guest/invite/login/share/signup sets.
  "macro-presence-badge.spec.ts",
  "presence-geometry-453.spec.ts",
  "space-home-364.spec.ts",
  "brand-lockup-442.spec.ts",
  // #1078 (from #1077's independent review): the sidebar's follow-up fetch for §4 placeholders went
  // unwired for three weeks and nothing caught it — the only e2e coverage for that path was outside
  // this gate and e2e does not run in CI at all. Cheap (~15s) and the sole automated defence against
  // that regression class recurring silently.
  "lazy-tree-623.spec.ts",
];

function countIsolated() {
  let count = 0;
  const refs = [];
  for (const spec of GATE_SPECS) {
    const text = readFileSync(join(specsDir, spec), "utf8");
    const matches = text.matchAll(/test\.skip\(true,\s*"(#\d+):/g);
    for (const m of matches) {
      count++;
      refs.push(`${spec}: ${m[1]}`);
    }
  }
  return { count, refs };
}

const { count, refs } = countIsolated();

const result = spawnSync("pnpm", ["e2e", ...GATE_SPECS], { cwd: e2eDir, stdio: "inherit" });

console.log(`\n#891 merge gate — ${GATE_SPECS.length} specs, ${count} test(s) isolated:`);
for (const ref of refs) console.log(`  - ${ref}`);
if (count === 0) console.log("  (none)");

process.exit(result.status ?? 1);
