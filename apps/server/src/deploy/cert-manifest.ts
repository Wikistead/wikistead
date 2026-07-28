// #235 / ADR-065: turning a verified custom domain into the cert-manager objects that serve it.
//
// The rule this file exists to enforce is already written in custom-domains.ts — "a Certificate is only
// ever created for a `verified` row" — but it was written as a sentence. Issuing for an unverified host is
// how a tenant gets a certificate for a domain it does not own, so the rule belongs in a function that
// refuses, with a test that watches it refuse.
//
// No new dependency: the cluster already runs cert-manager with an HTTP-01 ClusterIssuer
// (deploy/k8s/base/ingress.yaml), so this emits manifests for the controller that is there rather than
// speaking ACME itself. The ticket's stated blocker — "an ACME client is a new dependency" — was written
// before that landed.
//
// Pure and offline: it renders objects from a row. Applying them, and the issuance cycle itself, remain
// the deploy phase's job (#148) — that part genuinely needs a cluster and a real domain.

export interface VerifiedDomainRow {
  readonly domain: string;
  readonly status: string;
  readonly tenantId: string;
}

export interface CertManifest {
  readonly apiVersion: string;
  readonly kind: string;
  readonly metadata: { name: string; namespace: string; labels: Record<string, string> };
  readonly spec: { secretName: string; dnsNames: string[]; issuerRef: { name: string; kind: string } };
}

// A Kubernetes object name: lowercase alphanumerics, '-' and '.', ≤253 chars. A domain already satisfies
// that shape after custom-domains.ts normalises it; this keeps the guarantee local rather than assumed.
const K8S_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

export const certNameFor = (domain: string): string => `custom-${domain}`;
export const secretNameFor = (domain: string): string => `tls-custom-${domain}`;

/**
 * The Certificate for a custom domain, or `null` when the row must not have one.
 *
 * Returns null — rather than throwing — for an unverified row because the caller's job is to render the
 * set of certificates that SHOULD exist, and a pending domain simply contributes none. A malformed domain
 * throws, because that is a programming error rather than a state.
 */
export function renderCustomDomainCertificate(
  row: VerifiedDomainRow,
  opts: { namespace: string; issuer: string; issuerKind?: string },
): CertManifest | null {
  if (row.status !== 'verified') return null; // ownership unproven → no certificate, ever
  const domain = row.domain.trim().toLowerCase();
  if (!domain || !K8S_NAME.test(domain) || domain.length > 253) {
    throw new Error(`refusing to render a certificate for a malformed domain: ${JSON.stringify(row.domain)}`);
  }
  return {
    apiVersion: 'cert-manager.io/v1',
    kind: 'Certificate',
    metadata: {
      name: certNameFor(domain),
      namespace: opts.namespace,
      // The tenant label is how a revoke finds what to delete without parsing names back apart.
      labels: { 'wikistead.io/tenant': row.tenantId, 'wikistead.io/custom-domain': domain },
    },
    spec: {
      secretName: secretNameFor(domain),
      dnsNames: [domain],
      issuerRef: { name: opts.issuer, kind: opts.issuerKind ?? 'ClusterIssuer' },
    },
  };
}

/** Every certificate that should exist for a tenant's rows — unverified rows contribute nothing. */
export function renderCustomDomainCertificates(
  rows: readonly VerifiedDomainRow[],
  opts: { namespace: string; issuer: string; issuerKind?: string },
): CertManifest[] {
  return rows.map((r) => renderCustomDomainCertificate(r, opts)).filter((c): c is CertManifest => c !== null);
}

/**
 * What to delete when a domain is revoked: the Certificate AND the Secret it wrote. Deleting only the
 * Certificate leaves the key material behind, which is both a stale secret and a resource that would be
 * re-adopted if the same domain were added by a DIFFERENT tenant later.
 */
export function certObjectsToDelete(domain: string, namespace: string): { kind: string; name: string; namespace: string }[] {
  const d = domain.trim().toLowerCase();
  return [
    { kind: 'Certificate', name: certNameFor(d), namespace },
    { kind: 'Secret', name: secretNameFor(d), namespace },
  ];
}
