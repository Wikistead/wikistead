// #650 / ADR-226 §5: the two SECURITY notices recovery codes owe their owner — "a set was minted for
// your account" and "one of your codes was used, and your second factors are gone".
//
// WHY THESE ARE NOT THE 'mention' SHAPE, point by point, because every difference here is a decision:
//
//   No unsubscribe. A mention is something the product thought you would like to know; this is the
//   only way a member finds out that somebody else emptied their account's factors. RFC 8058 asks for
//   the header on bulk mail, and these are transactional — a `List-Unsubscribe` on them would offer to
//   turn off the alarm.
//
//   No fold key. `outbox.ts`'s sibling query matches on the fold key ALONE (no tenant, no member), so a
//   key that is not globally unique folds two people's notices into one message. Two mints deserve two
//   notices anyway: the second one is the interesting one.
//
//   No base URL requirement. The mention builder skips when none is configured rather than improvise a
//   link; these carry NO link, so there is nothing to improvise and nothing to withhold. A security
//   notice that declines to send because the deployment has not set a URL is a notice that is missing
//   exactly when the deployment is least well tended.
//
//   No page gate, no FGA re-check. There is no resource here — the subject is the recipient's own
//   account, and the only authority needed is that the row names them.
//
// The class carries the meaning, rather than a payload on the row: `email_outbox` has room for a
// notification id and a fold key and nothing else, so a single 'security' class would have had to encode
// which notice this is into one of two fields that already mean something else.
import { brandName, esc, renderBrandedHtml, renderBrandedText } from './layout.js'
import { registerEmailBuilder, type EmailBuildResult, type EmailBranding, type EmailOutboxRow } from './outbox.js'

/** Branded chrome when there is a base URL for the logo, plain prose when there is not. */
function render(branding: EmailBranding, baseUrl: string | null, args: { body: string; html: string; footer: string }) {
  return {
    text: renderBrandedText({ branding, body: args.body, footer: args.footer }),
    html: baseUrl
      ? renderBrandedHtml({ branding, baseUrl, body: args.html, footer: args.footer })
      : `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px">`
        + `<p style="margin:0 0 16px"><strong>${esc(brandName(branding))}</strong></p>${args.html}`
        + `<p style="font-size:12px;color:#666;margin-top:20px">${esc(args.footer)}</p></div>`,
  }
}

// The footer is advice, not a link: the recipient of a "this was not me" message must not be trained to
// click their way back in from an email, which is the shape every credential-phishing message wears.
const FOOTER = 'If this was not you, sign in and re-mint your recovery codes, then tell an administrator.'

export async function buildRecoveryMintedEmail(
  rows: EmailOutboxRow[], ctx: { tenantId: string; baseUrl: string | null; branding: EmailBranding },
): Promise<EmailBuildResult> {
  if (rows.length === 0) return { kind: 'skip', reason: 'no rows' }
  const name = brandName(ctx.branding)
  return {
    kind: 'send',
    message: {
      subject: `[${name}] Recovery codes were created for your account`,
      ...render(ctx.branding, ctx.baseUrl, {
        body: 'A new set of recovery codes was created for your account. Any earlier set has stopped working.\n\n'
          + 'Keep the codes somewhere you can reach without your phone. Each one works once, and using one '
          + 'removes every second factor from your account.',
        html: '<p>A new set of recovery codes was created for your account. Any earlier set has stopped working.</p>'
          + '<p>Keep the codes somewhere you can reach without your phone. Each one works once, and using one '
          + 'removes every second factor from your account.</p>',
        footer: FOOTER,
      }),
    },
  }
}

export async function buildRecoveryUsedEmail(
  rows: EmailOutboxRow[], ctx: { tenantId: string; baseUrl: string | null; branding: EmailBranding },
): Promise<EmailBuildResult> {
  if (rows.length === 0) return { kind: 'skip', reason: 'no rows' }
  const name = brandName(ctx.branding)
  return {
    kind: 'send',
    message: {
      // The subject says what HAPPENED, not what the feature is called. Somebody scanning a phone's
      // lock screen has to be able to tell in one line whether to worry.
      subject: `[${name}] A recovery code was used on your account`,
      ...render(ctx.branding, ctx.baseUrl, {
        body: 'A recovery code was used to get back into your account. Every second factor has been removed, '
          + 'the rest of that set of codes no longer works, and every session was signed out.\n\n'
          + 'If this was you, enrol a new authenticator and create a fresh set of codes.',
        html: '<p>A recovery code was used to get back into your account. Every second factor has been removed, '
          + 'the rest of that set of codes no longer works, and every session was signed out.</p>'
          + '<p>If this was you, enrol a new authenticator and create a fresh set of codes.</p>',
        footer: FOOTER,
      }),
    },
  }
}

export const RECOVERY_MINTED_CLASS = 'recovery_codes_minted'
export const RECOVERY_USED_CLASS = 'recovery_codes_used'

registerEmailBuilder(RECOVERY_MINTED_CLASS, buildRecoveryMintedEmail)
registerEmailBuilder(RECOVERY_USED_CLASS, buildRecoveryUsedEmail)
