// #575 / ADR-200 slice B: the one layout every notification mail wears.
//
// Before this, mail was the only surface with no branding at all — a tenant that had set its name and
// logo still received messages from an unnamed product. The tenant layer already existed
// (`getTenantBranding`); what mail lacked was a place to put it.
//
// Three rules the ADR fixed, each of which had bitten something already:
//
//   - ESCAPE the display name. It is stored with a trim and a length cap and nothing else, so it can
//     hold `<script>`. React renders it as text, so the app is fine — but the unsubscribe page is a raw
//     HTML template on the SAME ORIGIN as the session cookie (ADR-016), which makes an unescaped name
//     there a stored XSS against the session surface. One `esc`, used everywhere, and no new sanitiser.
//   - The logo URL needs the `/api` prefix. `/branding/logo` alone hits the SPA's index.html and every
//     mail shows a broken image. The BUNDLED product logo is an SPA asset and takes no prefix — the two
//     path shapes are genuinely different, which is why this is written down rather than assumed.
//   - The unentitled tenant falls back to the bundled product logo rather than to nothing: a message
//     whose sender cannot be identified is worse than one wearing the product's own mark. That bundled
//     mark is a PNG with the light background baked in, NOT the SVG the app uses: Gmail draws nothing
//     at all for an SVG <img>, and this fallback exists precisely for the deployments that have not
//     uploaded a logo — CE's default, dev, and every unentitled tenant. An SVG here serves none of them.
import type { EmailBranding } from './outbox.js'

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** What this workspace is called in a mail: the tenant's display name, else the product's. */
export const brandName = (b: EmailBranding): string => b.displayName?.trim() || b.productName

/** Absolute logo URL. Tenant logo (API path), else the bundled product mark (SPA asset). */
export const brandLogoUrl = (b: EmailBranding, baseUrl: string): string =>
  b.logoUrl ? `${baseUrl}/api${b.logoUrl}` : `${baseUrl}/icon-email.png`

/**
 * Wrap a message body in the shared shell: the mark, the name, the content, then the footer.
 *
 * `footer` carries the unsubscribe link the caller minted — this does not mint one, because the token's
 * ACTION differs per class and getting that wrong is the one silent bug in this area: a digest mail
 * carrying an `immediate` token unsubscribes the reader from MENTIONS when they click "stop the
 * digest".
 */
export function renderBrandedHtml(args: {
  branding: EmailBranding; baseUrl: string; body: string; footer: string;
}): string {
  const name = esc(brandName(args.branding));
  const logo = esc(brandLogoUrl(args.branding, args.baseUrl));
  // #430: the free plan shows the product line; a white-label tenant does not. Same rule as the public
  // reader — mail does not get its own.
  const poweredBy = args.branding.whitelabel
    ? ''
    : `<p style="font-size:11px;color:#999;margin-top:16px">Powered by ${esc(args.branding.productName)}</p>`;
  return [
    `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px">`,
    `<p style="margin:0 0 16px"><img src="${logo}" alt="${name}" height="24" style="height:24px;vertical-align:middle"> <strong style="vertical-align:middle">${name}</strong></p>`,
    args.body,
    `<p style="font-size:12px;color:#666;margin-top:20px">${args.footer}</p>`,
    poweredBy,
    `</div>`,
  ].join('');
}

/** The plain-text twin. Kept because a text part is not optional for deliverability. */
export function renderBrandedText(args: { branding: EmailBranding; body: string; footer: string }): string {
  const tail = args.branding.whitelabel ? '' : `\n\nPowered by ${args.branding.productName}`;
  return `${brandName(args.branding)}\n\n${args.body}\n\n${args.footer}${tail}\n`;
}
