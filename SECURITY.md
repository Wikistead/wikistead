# Security Policy

Thanks for helping keep Wikistead and its users safe. Wikistead is a multi-tenant
collaborative knowledge base whose core promise is a strict authorization boundary
(anonymous share-link guests, per-tenant isolation, OpenFGA-enforced access), so we
take security reports seriously.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.** Public disclosure before a fix is available puts
self-hosters and their data at risk.

Instead, report privately through **GitHub's private vulnerability reporting**:

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Fill in the advisory form with the details below.

This opens a private channel visible only to the maintainers. If you cannot use
GitHub's private reporting for any reason, open a minimal public issue that says only
"I would like to report a security issue privately" (with **no** technical detail) and
we will follow up with a private channel.

### What to include

A good report lets us reproduce and fix quickly:

- The type of issue (e.g. cross-tenant access, share-link/guest capability escalation,
  authorization bypass, XSS/sanitization, SSRF, secret exposure, denial of service).
- The affected component and version/commit (`git rev-parse HEAD`) and your deployment
  shape (self-hosted, dev, which middleware).
- Step-by-step reproduction, proof-of-concept, or the request/response involved.
- The impact you believe it has (what a malicious actor could read, write, or break),
  and any suggested remediation.

Please report only against **your own** tenant/instance or a local dev instance — do
not access, modify, or exfiltrate data that is not yours while investigating.

## Scope

In scope: this repository, the **Community Edition** (`AGPL-3.0-only`). The Enterprise
Edition lives in a separate repository and is covered by its own policy.

Examples of what we especially care about, given the product's invariants:

- **Cross-tenant isolation** — any path that lets one tenant read or affect another.
- **Guest / share-link boundary** — a share-link guest gaining capabilities beyond the
  single resource and capability the token was minted for, or bypassing expiry/revocation.
- **Authorization bypass** — reading, editing, or managing a page/space/attachment/template
  without the required OpenFGA relation; existence oracles that leak private resources.
- **Sanitization / injection** — stored or reflected XSS via editor content, macros, or
  embeds; SSRF via embed/render resolution.
- **Secret or credential exposure**, and integrity of the search/authorization sync paths.

Out of scope (generally): findings that require a malicious operator/admin of the instance
itself, best-practice suggestions without a concrete exploit, volumetric DoS against your
own deployment, and vulnerabilities in third-party dependencies (report those upstream —
but do tell us if we ship a vulnerable version so we can update the pin).

## Supported versions

Wikistead is pre-1.0 and evolving quickly. Security fixes are made against the **latest
release and `main`**. If no tagged release exists yet, `main` is the supported line. We do
not backport fixes to older commits before 1.0.

## Disclosure process

- We aim to **acknowledge** a report promptly and keep you updated as we investigate.
- We practice **coordinated disclosure**: we will work with you on a fix and a disclosure
  timeline, and we ask that you give us a reasonable window to release a fix before any
  public write-up.
- With your consent, we are happy to **credit** you for the report once a fix ships.

These are best-effort commitments for a young project, not a contractual SLA.
