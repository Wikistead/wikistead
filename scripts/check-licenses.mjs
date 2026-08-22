#!/usr/bin/env node
// Permissive-only dependency license gate (ADR-011 dual-licensing precondition).
//
// Why this exists: license-checker-rseidelsohn reads a flat node_modules and
// errors with "No packages found" under pnpm's symlinked store, so it silently
// passed without scanning anything. This uses pnpm's own (pnpm-aware) license
// resolver and FAILS the build on any non-allowlisted license.
import { execSync } from "node:child_process";

// Same allowlist as the previous (broken) license-checker invocation.
const ALLOW = new Set([
  "MIT",
  "MIT-0", // MIT No Attribution — OSI-approved, MORE permissive than MIT (same
           // no-attribution class as 0BSD / CC0-1.0 / Unlicense below). Not copyleft.
  "MIT OR X11",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "MPL-2.0",
  "BlueOak-1.0.0",
  "Python-2.0",
  // The zlib license — OSI-approved, FSF-free, permissive (BSD/MIT-class: no copyleft,
  // allows commercial/closed-source distribution and sale, attribution-on-source only).
  // Added 2026-06-25 for pako (MIT AND Zlib), pulled in by @excalidraw/excalidraw.
  "Zlib",
]);

// Our own workspace packages are private (no published license) and are not a
// distribution-licensing concern — skip them.
const isWorkspacePkg = (name) => name === "wikistead" || name.startsWith("@wikistead/");

// Per-package, per-VERSION verified overrides (ADR-011 — explicit allowlisting).
// Only for packages whose published METADATA is wrong/missing but whose bundled
// LICENSE file proves a permissive license. Keyed by exact name@version so a version
// bump forces re-verification (the metadata gap may be fixed, or the license may
// change). Each entry MUST cite the evidence.
const OVERRIDES = {
  // khroma's package.json omits the `license` field (→ pnpm reports "Unknown"), but
  // its bundled `license` file is verbatim "The MIT License (MIT)" (verified
  // 2026-06-25). Pulled in transitively by mermaid. MIT = permissive.
  "khroma@2.1.0": { license: "MIT", reason: "package.json omits license; bundled LICENSE file is verbatim MIT (verified 2026-06-25)" },
};

// Accept an SPDX license expression if it is permissive. A bare token must be in the
// allowlist. A compound expression is evaluated by SPDX precedence: an `OR` is allowed
// if ANY alternative is allowed (we elect the permissive option — e.g. dompurify's
// "(MPL-2.0 OR Apache-2.0)" elects Apache-2.0); an `AND` requires ALL operands. Parens
// are flattened (our expressions don't mix OR/AND under nesting).
function andAllowed(expr) {
  const parts = expr.split(/\bAND\b/i).map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((p) => ALLOW.has(p));
}
function exprAllowed(raw) {
  if (!raw) return false;
  if (ALLOW.has(raw)) return true; // exact (covers entries like "MIT OR X11")
  const s = raw.replace(/[()]/g, " ").trim();
  if (/\bOR\b/i.test(s)) return s.split(/\bOR\b/i).some((branch) => andAllowed(branch));
  return andAllowed(s);
}

// Effective license for a package: a verified override (any matching version) wins,
// otherwise the reported license string.
function effectiveLicense(name, versions, license) {
  for (const v of versions) {
    const o = OVERRIDES[`${name}@${v}`];
    if (o) return o.license;
  }
  return license;
}

// Scoped font-license exception (ADR-011): the SIL Open Font License (OFL-1.1) is
// permissive for the purpose of the code dual-licensing premise — it explicitly
// permits bundling the font with any software, including commercial/closed-source
// distribution and sale, and imposes NO license requirement on that software. It
// only governs the font files themselves. We therefore allow OFL-1.1, but ONLY for
// font packages (so it can never wave through an OFL-licensed *code* dependency).
// Self-hosted Plus Jakarta Sans (@fontsource/*) is the brand typeface — approved.
const FONT_LICENSE_ALLOW = new Set(["OFL-1.1"]);
const isFontPkg = (name) => name.startsWith("@fontsource/") || name.startsWith("@fontsource-variable/");

// #893: a run that read NOTHING must not report that everything is permissive.
//
// This gate is the legal precondition of ADR-011's dual licensing, and until now it had six ways to
// exit 0 having judged no package at all — the shape #719 names, wearing the most expensive hat in
// the tree. `pnpm` missing from PATH, a corrupt store, an unreadable lockfile and an over-large
// output all threw; the catch turned the throw into an empty string, the empty string was read as
// "there are no dependencies", and the build went green. `stdio` sent stderr to `ignore`, so the
// reason went with it. A valid but empty `{}`, or a tree of nothing but workspace packages, reached
// the success line by a different road.
//
// What replaces it: the run says HOW MANY packages it judged, and zero is a failure. The distinction
// that matters is not "empty or not" but "did the tool answer" — so the failure is reported with what
// the tool actually said, rather than as an absence.
let raw;
try {
  raw = execSync("pnpm licenses list --prod --json", {
    encoding: "utf8",
    // ⚠️ stderr is CAPTURED, not discarded: when this fails, the reason is the only thing that tells
    // an operator whether their tree is clean or their tooling is broken.
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (err) {
  const reason = (err.stderr?.toString() || err.message || "").trim();
  console.error("license:check FAILED — could not read the dependency licenses, so nothing was checked.");
  console.error(`  ${reason.split("\n")[0] || "pnpm licenses list did not answer"}`);
  console.error("\nADR-011's dual licensing rests on this scan. A run that cannot see the dependencies");
  console.error("is not a run that found them permissive — fix the tooling, then re-run.");
  process.exit(1);
}

if (!raw.trim()) {
  // The old code called this "no production dependencies" and passed. It cannot mean that here: this
  // repository HAS production dependencies, so an empty answer is a broken read wearing that costume.
  console.error("license:check FAILED — `pnpm licenses list` answered with nothing.");
  console.error("Nothing was scanned, so nothing was found permissive (ADR-011).");
  process.exit(1);
}

let byLicense;
try {
  byLicense = JSON.parse(raw);
} catch (err) {
  console.error(`license:check FAILED — the dependency list was not JSON (${err.message}).`);
  console.error("Nothing was scanned, so nothing was found permissive (ADR-011).");
  process.exit(1);
}
const violations = [];
// #893: judged, not listed. A package skipped as one of ours was never asked the question, so it
// cannot be part of the evidence that the answer was yes.
let judged = 0;
let skippedOwn = 0;
for (const [license, pkgs] of Object.entries(byLicense)) {
  for (const pkg of pkgs) {
    if (isWorkspacePkg(pkg.name)) { skippedOwn += 1; continue; }
    judged += 1;
    const versions = pkg.versions || [];
    const effective = effectiveLicense(pkg.name, versions, license);
    if (exprAllowed(effective)) continue;
    if (FONT_LICENSE_ALLOW.has(effective) && isFontPkg(pkg.name)) continue;
    violations.push({ name: pkg.name, versions: versions.join(", "), license });
  }
}

if (violations.length > 0) {
  console.error("license:check FAILED — non-permissive licenses found:");
  for (const v of violations) {
    console.error(`  ✗ ${v.name}@${v.versions} — ${v.license}`);
  }
  console.error(`\nAllowlist: ${[...ALLOW].join(", ")}`);
  console.error("Add a permissive replacement, or get explicit approval before allowlisting (ADR-011).");
  process.exit(1);
}

// ⚠️ The last two doors, and they are the ones a reader would not think to look for: `pnpm` can answer
// with a well-formed `{}`, and a tree could in principle be nothing but our own packages. Both parse,
// both iterate cleanly, and both used to reach the line below — which would then announce that every
// production dependency is permissive on the strength of having examined none.
//
// The threshold is deliberately ZERO rather than a floor near today's count (594). A floor would have
// to be maintained, and the failure it guards against is not "fewer than usual" — it is "none at all",
// which is what every broken read produces.
if (judged === 0) {
  console.error("license:check FAILED — the scan judged 0 dependencies.");
  console.error(`  ${Object.keys(byLicense).length} license group(s) read; ${skippedOwn} package(s) skipped as our own.`);
  console.error("\nADR-011's premise is that every production dependency was seen and found permissive.");
  console.error("A scan that saw none has not established that, whatever it printed.");
  process.exit(1);
}

const licenses = Object.keys(byLicense).filter((l) => ALLOW.has(l));
console.log(
  `license:check OK — ${judged} production dependencies judged, all permissive (${licenses.join(", ")}).`,
);
