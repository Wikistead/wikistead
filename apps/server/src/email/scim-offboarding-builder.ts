// #1051 / ADR-275 rev3 §4 (owner ruling ③–⑥): the out-of-band notice for a SCIM deprovision
// #1050 deferred rather than executed — a directory change that needs an administrator's attention,
// and nobody reachable through the console badge alone (§4's own reasoning: the floors that trigger a
// deferral are exactly the moments the console is unreachable to the people who would need to see it).
//
// SECURITY class, same reasons security-builder.ts's recovery-code notices are: no unsubscribe (this
// is the only way most of the recipients ever learn a directory change is stuck — turning it off is
// not something to offer), no fold key (every recipient's own row — `outbox.ts`'s fold-key match has
// no tenant/member scoping, so a shared key would merge two different members' notices into one).
//
// Recipients: EVERY tenant member with an email on file, any role, active or already deactivated by
// something else — decided by the caller (`packages/ee-server/src/scim/provision.ts`), which is also
// what enforces "transition only" (never on a re-push) and "after the inline retry, not before" —
// this builder only turns whatever rows already exist into one message; it does not decide who gets a
// row or when.
import { brandName, esc, renderBrandedHtml, renderBrandedText } from './layout.js'
import { registerEmailBuilder, type EmailBuildResult, type EmailBranding, type EmailOutboxRow } from './outbox.js'
import type { Lang } from '../locale.js'
import { scimOffboardingDeferredSubject, scimOffboardingDeferredBody } from './catalog.js'

// #3.3a: the catalogue body is TEXT, paragraphs separated by a blank line — the same derivation
// security-builder.ts uses so the text and HTML parts cannot say different things.
const paragraphsHtml = (text: string): string =>
  text.split('\n\n').map((p) => `<p>${esc(p)}</p>`).join('')

function render(branding: EmailBranding, baseUrl: string | null, lang: Lang, body: string) {
  const html = paragraphsHtml(body)
  return {
    text: renderBrandedText({ branding, body, footer: '', lang }),
    html: baseUrl
      ? renderBrandedHtml({ branding, baseUrl, body: html, footer: '', lang })
      : `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px">`
        + `<p style="margin:0 0 16px"><strong>${esc(brandName(branding))}</strong></p>${html}</div>`,
  }
}

export async function buildScimOffboardingDeferredEmail(
  rows: EmailOutboxRow[], ctx: { tenantId: string; baseUrl: string | null; branding: EmailBranding; locale: Lang },
): Promise<EmailBuildResult> {
  if (rows.length === 0) return { kind: 'skip', reason: 'no rows' }
  const name = brandName(ctx.branding)
  return {
    kind: 'send',
    message: {
      subject: `[${name}] ${scimOffboardingDeferredSubject(ctx.locale)}`,
      ...render(ctx.branding, ctx.baseUrl, ctx.locale, scimOffboardingDeferredBody(ctx.locale)),
    },
  }
}

export const SCIM_OFFBOARDING_DEFERRED_CLASS = 'scim_offboarding_deferred'

registerEmailBuilder(SCIM_OFFBOARDING_DEFERRED_CLASS, buildScimOffboardingDeferredEmail)
