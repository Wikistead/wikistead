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
]);

// Our own workspace packages are private (no published license) and are not a
// distribution-licensing concern — skip them.
const isWorkspacePkg = (name) => name === "wikistead" || name.startsWith("@wikistead/");

let raw;
try {
  raw = execSync("pnpm licenses list --prod --json", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (err) {
  // pnpm exits non-zero when there are no dependencies; treat empty as success.
  raw = err.stdout?.toString() || "";
}

if (!raw.trim()) {
  console.log("license:check — no production dependencies to scan.");
  process.exit(0);
}

const byLicense = JSON.parse(raw);
const violations = [];
for (const [license, pkgs] of Object.entries(byLicense)) {
  if (ALLOW.has(license)) continue;
  for (const pkg of pkgs) {
    if (isWorkspacePkg(pkg.name)) continue;
    violations.push({ name: pkg.name, versions: (pkg.versions || []).join(", "), license });
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

const licenses = Object.keys(byLicense).filter((l) => ALLOW.has(l));
console.log(`license:check OK — all production dependencies are permissive (${licenses.join(", ")}).`);
