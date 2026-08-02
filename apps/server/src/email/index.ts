// Transactional email drivers (P1.3). The app talks only to EmailDriver
// (@wikistead/hooks); EE/Cloud can register a provider-API driver. CE uses SMTP
// (nodemailer) when configured, else a no-op.
//
// degrade (decided): SMTP is OPTIONAL. With no SMTP, email is disabled but invites
// still work — their authoritative artifact is the link/token (DB + FGA), with
// email a convenience. So a no-op send never breaks anything. We announce the mode
// ONCE at startup (not a warn per send) so an intentional no-SMTP self-host isn't
// spammed.
import nodemailer from 'nodemailer'
import type { EmailDriver, EmailMessage } from '@wikistead/hooks'
import { productName } from '../product-name.js'

class SmtpEmailDriver implements EmailDriver {
  private readonly transporter: nodemailer.Transporter
  private readonly from: string
  constructor(cfg: { host: string; port: number; secure: boolean; user?: string; pass?: string; from: string }) {
    this.transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      ...(cfg.user ? { auth: { user: cfg.user, pass: cfg.pass ?? '' } } : {}),
    })
    this.from = cfg.from
  }
  async send(msg: EmailMessage): Promise<void> {
    await this.transporter.sendMail({ from: this.from, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text, ...(msg.headers ? { headers: msg.headers } : {}) })
  }
}

// No SMTP configured: email is disabled. send() is a no-op (never throws); callers
// rely on the invite link, not on delivery.
class NoopEmailDriver implements EmailDriver {
  async send(_msg: EmailMessage): Promise<void> {
    /* intentionally does nothing — see degrade note above */
  }
}

// Resolve the default driver from env. `announce` is called ONCE (at startup) with
// the chosen mode, so there is no per-send logging noise.
export function resolveEmailDriver(announce?: (msg: string) => void): EmailDriver {
  const host = process.env.SMTP_HOST
  if (!host) {
    announce?.('email: SMTP not configured — email disabled (invites work via copy-link)')
    return new NoopEmailDriver()
  }
  announce?.(`email: SMTP enabled via ${host}:${process.env.SMTP_PORT ?? '587'}`)
  return new SmtpEmailDriver({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || undefined,
    pass: process.env.SMTP_PASS || undefined,
    // #575 slice A: the name a recipient reads in their inbox list, before opening anything. It
    // follows the deployment's product name; the address part stays a deployment concern (EMAIL_FROM).
    from: process.env.EMAIL_FROM ?? `${productName()} <noreply@wikistead.local>`,
  })
}

export { SmtpEmailDriver, NoopEmailDriver }
