// Open-redirect guard for the post-login returnTo. Only same-origin RELATIVE
// paths are honored; anything that could leave the app's origin (absolute URLs,
// protocol-relative "//host", backslash tricks) falls back to "/". Without this,
// returnTo=https://evil.com would let an attacker bounce a victim through a real
// login into a phishing page.
export function safeReturnTo(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) return '/'
  // Must be a path on this origin: starts with a single "/", and is not
  // protocol-relative ("//") or a backslash-smuggled host ("/\\evil.com").
  if (!input.startsWith('/')) return '/'
  if (input.startsWith('//') || input.startsWith('/\\')) return '/'
  // Reject control chars / whitespace that could be used to smuggle a new URL.
  if (/[\x00-\x1f\x7f]/.test(input)) return '/'
  return input
}
