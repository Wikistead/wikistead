// #310 / ADR-136: the community macro REGISTRY submission check — the format-of-truth the registry repo's CI
// runs on every PR, and (later) the in-app marketplace (#182) and the discovery site read. It sits ABOVE the
// ADR-076 package/trust primitives (macro-package-verify): the registry is a static git-backed channel whose
// integrity rests on ADR-076's signature + content-hash (NOT on server/registry trust). This module holds the
// pure, deterministic checks (no I/O) so the same logic runs in CI, the site generator, and tests.
//
// v1 = COMMUNITY tier only (no verified tier yet). So the license gate is NOT "permissive only"
// (ADR-011 governs what WE bundle; a channel-distributed, arms-length author package only DECLARES its license,
// ADR-076 §5 declare+consent) — it is "an OSI-approved license", surfaced prominently. The
// signature/byte-binding (review condition A) is the CALLER's responsibility: verify the ADR-076
// package FIRST (verifyPackage), THEN run these checks on THOSE EXACT verified bytes — never on unverified input.
import type { MacroManifest } from "./macro-package-verify";

// The discovery metadata a registry entry carries beyond the signed manifest (shown on the site; NOT part of the
// signed bytes — display only, so it can never grant capability or misrepresent the license the manifest binds).
export interface RegistryEntryMeta {
  readonly name: string;
  readonly description: string;
  readonly homepage?: string;
}

// The set of host-mediated capabilities a community macro may DISCLOSE (ADR-075 sandbox surface). A submission
// requesting anything outside this set is rejected in CI (an out-of-sandbox capability can never be install-time
// consented to). Kept small + explicit; extended only by an ADR that widens the sandbox.
export const ALLOWED_CAPABILITIES: ReadonlySet<string> = new Set([
  "theme", // the ADR-024 host-API (the only capability a first-party macro gets today)
  "net.fetch", // a sandboxed, host-brokered fetch (future sandbox surface — disclosed, consented)
  "storage.local", // per-macro sandboxed storage (future)
]);

// OSI-approved license ids accepted for the COMMUNITY tier. A curated allowlist (not every SPDX id) so a
// non-OSI / bespoke / "all rights reserved" license is rejected before merge. Widened by policy, not code review.
export const OSI_LICENSES: ReadonlySet<string> = new Set([
  "MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MPL-2.0",
  "GPL-2.0-only", "GPL-2.0-or-later", "GPL-3.0-only", "GPL-3.0-or-later",
  "LGPL-2.1-only", "LGPL-2.1-or-later", "LGPL-3.0-only", "LGPL-3.0-or-later",
  "AGPL-3.0-only", "AGPL-3.0-or-later", "EPL-2.0", "Unlicense", "Zlib",
]);

// Max signed content size for a community submission (bytes). A cheap DoS / abuse guard; the exact value is a
// policy knob, not a security boundary (the sandbox is).
export const MAX_MACRO_CONTENT_BYTES = 256 * 1024; // 256 KiB

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/; // registry id: a short kebab slug
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/; // semver 2.0 (core + optional pre/build)

export type SubmissionResult = { ok: true } | { ok: false; errors: string[] };

// Validate a registry submission's MANIFEST + discovery meta + content size. PURE — no signature check here (the
// caller runs verifyPackage first on the same bytes; this asserts the DECLARED metadata is well-formed and
// policy-compliant). Collects ALL errors (a submitter fixes them in one pass), never throws.
export function validateMacroSubmission(
  manifest: MacroManifest,
  meta: RegistryEntryMeta,
  content: string,
): SubmissionResult {
  const errors: string[] = [];
  if (!SLUG_RE.test(manifest.id)) errors.push(`invalid id "${manifest.id}" (expected a kebab slug)`);
  if (!SEMVER_RE.test(manifest.version)) errors.push(`invalid version "${manifest.version}" (expected semver)`);
  if (!manifest.license || !OSI_LICENSES.has(manifest.license)) {
    errors.push(`license "${manifest.license}" is not an OSI-approved id accepted for the community tier`);
  }
  if (!Array.isArray(manifest.capabilities)) {
    errors.push("capabilities must be an array");
  } else {
    for (const c of manifest.capabilities) if (!ALLOWED_CAPABILITIES.has(c)) errors.push(`capability "${c}" is outside the sandbox surface`);
  }
  // Byte length (not string length — multibyte content must count its real size against the cap).
  const size = new TextEncoder().encode(content).length;
  if (size > MAX_MACRO_CONTENT_BYTES) errors.push(`content is ${size} bytes, over the ${MAX_MACRO_CONTENT_BYTES}-byte cap`);
  if (!meta.name?.trim()) errors.push("name is required");
  if (!meta.description?.trim()) errors.push("description is required");
  // homepage is display metadata, but the site linkifies it — reject anything but an absolute http(s) URL so a
  // `javascript:` / `data:` homepage can never become a stored XSS in the discovery site's `<a href>`.
  if (meta.homepage != null) {
    let ok = false;
    try { const u = new URL(meta.homepage); ok = u.protocol === "https:" || u.protocol === "http:"; } catch { ok = false; }
    if (!ok) errors.push(`homepage must be an absolute http(s) URL`);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}
