// CE-published extension point for transactional email. EE/Cloud may register a
// provider-API driver (Resend/Postmark, bounce handling); CE uses the default
// SMTP driver, or a no-op when SMTP is unconfigured. Defined here (not in
// apps/server) so EE can implement it without importing CE's application layer.
//
// Email is NOT an authorization path: it is best-effort. Membership/permissions
// are granted by FGA (the trusted path); an invite's authoritative artifact is its
// link/token, with email a convenience. A failed/disabled send never breaks
// authorization integrity (contrast: search reindex, which MUST be reliable).
export interface EmailMessage {
  to: string
  subject: string
  html: string
  text: string
}

export interface EmailDriver {
  send(msg: EmailMessage): Promise<void>
}

let _driver: EmailDriver | null = null

export function registerEmailDriver(driver: EmailDriver): void {
  _driver = driver
}

export function getEmailDriver(fallback: EmailDriver): EmailDriver {
  return _driver ?? fallback
}
