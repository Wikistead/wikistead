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
import { verifyPackage, type MacroManifest, type SignedPackage, type TrustTier, type VerifyDeps, type VerifyResult } from "./macro-package-verify";

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
// #450 / ADR-177 rev2 (user ruling 2026-07-27): the vocabulary is exactly what the host actually brokers.
// `net.fetch` and `storage.local` were listed as FUTURE sandbox surfaces with no implementation and no
// consumer, and a capability nobody can be granted is not a promise — it is a hole waiting for someone to
// read the list as a menu. The four below are the seams that exist: the ADR-024 `{theme}` host-API, the
// sub-render the host performs on a macro's behalf, the host-resolved dynamic list, and the design tokens.
// Widening this set is an ADR decision, not a code-review one.
export const ALLOWED_CAPABILITIES: ReadonlySet<string> = new Set([
  "theme", // ADR-024: the narrow host-API a macro receives
  "render-markdown", // the host renders nested markdown for the macro (it never imports the renderer)
  "host-list", // the host resolves a dynamic list (tagged/children); see the fidelity rule below
  "design-tokens", // read the token vocabulary rather than hard-coding colour/spacing
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

// ── The one entry point CI should call (review condition A, in code) ────────────────────────
// Condition A said: CI must verify the signature + content hash and then run the static checks on THE
// SAME BYTES, so a submitter cannot get one payload verified and a different one inspected. That was
// written as an instruction to a CI pipeline that does not exist yet — a promise in a comment, which is
// exactly the shape of gap that gets skipped when the pipeline is finally written under time pressure.
// This function makes the ordering unskippable: it takes the SIGNED PACKAGE (not a manifest and a
// separately-supplied blob), verifies it, and then validates `pkg.manifest` and `pkg.content` — the very
// object it just verified. There is no parameter through which different bytes could enter.
export type VetResult =
  | { readonly ok: true; readonly tier: TrustTier }
  | { readonly ok: false; readonly stage: "verify"; readonly reason: Extract<VerifyResult, { ok: false }>["reason"] }
  | { readonly ok: false; readonly stage: "policy"; readonly errors: readonly string[] };

export function vetSubmission(pkg: SignedPackage, meta: RegistryEntryMeta, deps: VerifyDeps): VetResult {
  // Trust FIRST. Running policy checks on unverified bytes would report "looks fine" about content that
  // is not the content the author signed.
  const verified = verifyPackage(pkg, deps);
  if (!verified.ok) return { ok: false, stage: "verify", reason: verified.reason };
  const policy = validateMacroSubmission(pkg.manifest, meta, pkg.content);
  if (!policy.ok) return { ok: false, stage: "policy", errors: policy.errors };
  return { ok: true, tier: verified.tier };
}

// ── Registry index (index.json) ──────────────────────────────────────────────
// The static registry's index.json (ADR-136 §1): the read-only view the discovery site renders and the in-app
// marketplace (#182) reads. It is DERIVED from the accepted, signed submissions — the site/app never re-decide
// trust (that is the signature at install). Building it is pure + deterministic so CI and tests agree.

// One accepted, signed submission version (already validateMacroSubmission-passed AND verifyPackage-verified in
// CI). `signatureKeyId` derives the tier at install (never claimed here); revoked versions are filtered out.
export interface AcceptedVersion {
  readonly manifest: MacroManifest;
  readonly meta: RegistryEntryMeta;
  readonly signatureKeyId: string;
  readonly publishedAt: string; // ISO; the CI stamps it (deterministic input, not read from a clock here)
}

export interface RegistryIndexVersion {
  readonly version: string;
  readonly license: string;
  readonly capabilities: readonly string[];
  readonly contentHash: string;
  readonly signatureKeyId: string;
  readonly publishedAt: string;
}
export interface RegistryIndexEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly homepage?: string;
  readonly latest: string; // the highest non-revoked semver
  readonly versions: readonly RegistryIndexVersion[]; // newest-first
}
export interface RegistryIndex {
  readonly formatVersion: 1;
  readonly macros: readonly RegistryIndexEntry[];
}

// Compare two semver CORE versions (pre-release/build ignored for ordering here — v1 keeps it simple; a
// pre-release policy is a later slice). Returns >0 if a is newer.
function semverCmp(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0]!.split(".").map(Number);
  const pb = b.split(/[-+]/)[0]!.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

// Build the registry index from the accepted versions. Groups by macro id, drops `revokedVersions`
// (`${id}@${version}`), sorts each macro's versions newest-first, sets `latest` to the highest surviving version,
// and drops a macro with no surviving version. Discovery fields (name/description/homepage) come from the LATEST
// version's meta. Deterministic (stable id sort) so CI output is reproducible. Pure — no clock, no I/O.
export function buildRegistryIndex(accepted: readonly AcceptedVersion[], revokedVersions: ReadonlySet<string> = new Set()): RegistryIndex {
  const byId = new Map<string, AcceptedVersion[]>();
  for (const a of accepted) {
    if (revokedVersions.has(`${a.manifest.id}@${a.manifest.version}`)) continue;
    (byId.get(a.manifest.id) ?? byId.set(a.manifest.id, []).get(a.manifest.id)!).push(a);
  }
  const macros: RegistryIndexEntry[] = [];
  for (const [id, versions] of [...byId.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    versions.sort((x, y) => semverCmp(y.manifest.version, x.manifest.version)); // newest-first
    const latest = versions[0]!;
    macros.push({
      id,
      name: latest.meta.name,
      description: latest.meta.description,
      ...(latest.meta.homepage ? { homepage: latest.meta.homepage } : {}),
      latest: latest.manifest.version,
      versions: versions.map((v) => ({
        version: v.manifest.version, license: v.manifest.license, capabilities: v.manifest.capabilities,
        contentHash: v.manifest.contentHash, signatureKeyId: v.signatureKeyId, publishedAt: v.publishedAt,
      })),
    });
  }
  return { formatVersion: 1, macros };
}

// ── Discovery site (static HTML) ─────────────────────────────────────────────
// ADR-136 §3: the site is a READ-ONLY view of the index — it holds no distribution or write authority,
// and it never offers a one-click install (install is always the in-app admin flow, ADR-076's consent +
// audit path). So the generator is a pure index → HTML string function that the registry repo's static
// build calls; it does no I/O and reaches nothing.
//
// EVERY interpolated value is escaped, and the homepage is re-validated HERE rather than trusted from
// the index. validateMacroSubmission already rejects a non-http(s) homepage at submission, but the site
// renders whatever index.json says, and index.json is a file in a repo — a bad edit, an older entry
// written before the check existed, or a hand-patched index must not become `href="javascript:..."`.
// Two layers, because this one runs on the machine of everyone browsing the registry.
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function renderEntry(e: RegistryIndexEntry): string {
  const latest = e.versions.find((v) => v.version === e.latest) ?? e.versions[0];
  const href = safeHref(e.homepage);
  const caps = latest?.capabilities ?? [];
  return [
    `<article class="macro" id="${escapeHtml(e.id)}">`,
    `<h2>${escapeHtml(e.name)} <span class="id">${escapeHtml(e.id)}</span></h2>`,
    `<p class="description">${escapeHtml(e.description)}</p>`,
    // License is displayed prominently on purpose: v1 is community tier only, and accepts any
    // OSI license (including copyleft), so the licence a user takes on must be visible before install.
    `<p class="meta">v${escapeHtml(e.latest)} · license <strong>${escapeHtml(latest?.license ?? "unknown")}</strong></p>`,
    // Capabilities before install, per ADR-136 §3 — the consent surface, shown even when empty.
    `<p class="capabilities">capabilities: ${caps.length ? caps.map((c) => `<code>${escapeHtml(c)}</code>`).join(", ") : "<em>none</em>"}</p>`,
    href ? `<p class="homepage"><a href="${escapeHtml(href)}" rel="noopener noreferrer nofollow">${escapeHtml(href)}</a></p>` : "",
    `<p class="install">Install from your workspace admin console using the id <code>${escapeHtml(e.id)}</code>.</p>`,
    `<details><summary>${e.versions.length} version(s)</summary><ul>`,
    ...e.versions.map((v) => `<li><code>${escapeHtml(v.version)}</code>, ${escapeHtml(v.publishedAt)}, sha <code>${escapeHtml(v.contentHash)}</code>, key <code>${escapeHtml(v.signatureKeyId)}</code></li>`),
    `</ul></details>`,
    `</article>`,
  ].filter(Boolean).join("\n");
}

/** The discovery site's index page: a deterministic, self-contained HTML string (no scripts, no assets). */
export function renderRegistrySiteHtml(index: RegistryIndex, opts: { title?: string } = {}): string {
  const title = escapeHtml(opts.title ?? "Wikistead macro registry");
  const body = index.macros.length
    ? index.macros.map(renderEntry).join("\n")
    : "<p>No macros published yet.</p>";
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title></head>`,
    `<body><h1>${title}</h1>`,
    // Say what the site is NOT, so "install" is never assumed to happen here (ADR-136 §3).
    "<p>Community macros are author-signed and installed from your workspace admin console. This site only lists what the registry contains; it distributes nothing and installs nothing.</p>",
    body,
    "</body></html>",
  ].join("\n");
}
