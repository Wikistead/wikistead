// #1008 / ADR-260 §3.3 §3.3a §7 item 4: the mail catalogue. Every reader-facing sentence any
// EmailMessage builder composes lives here, keyed on the resolved `Lang` (§3.1's three-step chain).
//
// ⚠️ §3.3a, literally: a catalogue entry is TEXT — "no catalogue entry carries markup, and no new
// sanitiser is added". So an entry is never an HTML fragment: where a mail wants a bold title or a
// link, the BUILDER writes the `<strong>` / `<a href>` around a text entry and escapes whatever it
// interpolates with `esc` from `./layout.js`. That keeps ONE escape boundary (the caller's) rather
// than a second one hidden inside a template here, and it is why the link labels below
// (`openThePage`, `inviteAcceptLabel`, `resetLinkLabel`, `stopEmailsLabel`) are entries of their own
// rather than anchors.
import type { Lang } from '../locale.js'

function byLang<Args extends unknown[]>(
  en: (...args: Args) => string,
  ja: (...args: Args) => string,
): (lang: Lang, ...args: Args) => string {
  return (lang, ...args) => (lang === 'ja' ? ja(...args) : en(...args))
}

// English separates two sentences on one line with a space; Japanese does not. Used where a text
// part is composed here out of the same entries the HTML part sets in separate paragraphs — one
// wording, two shapes, so the two cannot drift apart.
const joinSentences = (lang: Lang, ...parts: string[]): string => parts.join(lang === 'ja' ? '' : ' ')

// Shared by every class that carries an unsubscribe link (digest, mention).
export const stopEmails = byLang(
  (url: string) => `Stop these emails: ${url}`,
  (url: string) => `このメールの配信を停止する: ${url}`,
)
/** The same words as the anchor TEXT; the builder writes the anchor around it. */
export const stopEmailsLabel = byLang(() => 'Stop these emails', () => 'このメールの配信を停止する')

// layout.ts's shared shell footer. One entry: both parts say the same words, and the HTML part is
// the one that wraps it in a <p>.
export const poweredBy = byLang(
  (product: string) => `Powered by ${product}`,
  (product: string) => `${product} が提供しています`,
)

// digest.ts — the rollup's "Updated" fallback (an event_type this build has no label for), the
// subject, and the per-row link label.
export const updatedFallback = byLang(() => 'Updated', () => '更新されました')
export const digestSubject = byLang(
  (n: number) => `Your digest: ${n} update${n === 1 ? '' : 's'}`,
  (n: number) => `ダイジェスト: ${n} 件の更新`,
)
export const openLabel = byLang(() => 'open', () => '開く')

// mention-builder.ts
export const andMore = byLang(
  (n: number) => ` (and ${n} more)`,
  (n: number) => `（他 ${n} 件）`,
)
export const untitledPage = byLang(() => 'a page', () => '無題のページ')
export const mentionSubject = byLang(
  (title: string, more: string) => `You were mentioned in "${title}"${more}`,
  (title: string, more: string) => `「${title}」であなたがメンションされました${more}`,
)
/**
 * The mail's one sentence. `title` arrives raw in the text part, and as the builder's own escaped
 * `<strong>…</strong>` in the HTML part — the entry stays text either way (§3.3a).
 */
export const mentionSentence = byLang(
  (title: string, more: string) => `You were mentioned in "${title}"${more}.`,
  (title: string, more: string) => `「${title}」であなたがメンションされました${more}。`,
)
export const openThePage = byLang(() => 'Open the page', () => 'ページを開く')
export const mentionBodyText = (lang: Lang, title: string, more: string, link: string): string =>
  `${mentionSentence(lang, title, more)}\n\n${openThePage(lang)}:\n${link}`

// security-builder.ts — recovery codes minted / used, and their shared footer. The bodies are TEXT
// with a blank line between paragraphs; the builder turns that into <p> elements for the HTML part,
// so the two parts cannot say different things.
export const recoveryFooter = byLang(
  () => 'If this was not you, sign in and re-mint your recovery codes, then tell an administrator.',
  () => '心当たりがない場合は、サインインしてリカバリーコードを再発行し、管理者に連絡してください。',
)
export const recoveryMintedSubject = byLang(
  () => 'Recovery codes were created for your account',
  () => 'アカウントのリカバリーコードが作成されました',
)
export const recoveryMintedBody = byLang(
  () =>
    'A new set of recovery codes was created for your account. Any earlier set has stopped working.\n\n'
    + 'Keep the codes somewhere you can reach without your phone. Each one works once, and using one '
    + 'removes every second factor from your account.',
  () =>
    'アカウントの新しいリカバリーコードが作成されました。以前のコードはすべて使えなくなりました。\n\n'
    + 'コードはスマートフォンが無くても取り出せる場所に保管してください。各コードは1回限り使用でき、'
    + '1つでも使用するとアカウントの第2要素はすべて解除されます。',
)
export const recoveryUsedSubject = byLang(
  () => 'A recovery code was used on your account',
  () => 'アカウントでリカバリーコードが使用されました',
)
export const recoveryUsedBody = byLang(
  () =>
    'A recovery code was used to get back into your account. Every second factor has been removed, '
    + 'the rest of that set of codes no longer works, and every session was signed out.\n\n'
    + 'If this was you, enrol a new authenticator and create a fresh set of codes.',
  () =>
    'リカバリーコードを使ってアカウントに再度サインインされました。第2要素はすべて解除され、'
    + '同じセットの残りのコードも使えなくなり、すべてのセッションがサインアウトされました。\n\n'
    + '心当たりがある場合は、新しい認証アプリを登録し、新しいリカバリーコードを作成してください。',
)

// routes/email-unsubscribe.ts
export const unsubKindMention = byLang(() => 'mention email', () => 'メンション通知メール')
export const unsubKindDigest = byLang(() => 'digest email', () => 'ダイジェストメール')
export const unsubTitle = byLang(
  (brand: string) => `Unsubscribe from ${brand}`,
  (brand: string) => `${brand} の配信停止`,
)
export const unsubHeading = byLang(
  (kind: string) => `Stop receiving ${kind}?`,
  (kind: string) => `${kind}の配信を停止しますか？`,
)
export const unsubBody = byLang(
  (kind: string, brand: string) =>
    `This turns off ${kind} from ${brand} for your account. You can turn it back on any time in your account settings.`,
  (kind: string, brand: string) =>
    `${brand} からの${kind}がオフになります。アカウント設定からいつでも再度オンにできます。`,
)
export const unsubscribeButton = byLang(() => 'Unsubscribe', () => '配信停止')
export const unsubscribedTitle = byLang(() => 'Unsubscribed', () => '配信停止しました')
export const unsubscribedBody = byLang(
  () => 'Unsubscribed. You can re-enable this email in your account settings.',
  () => '配信を停止しました。アカウント設定からいつでも再度有効にできます。',
)

// routes/auth-local.ts — the password reset request mail. The text part composes the same entries
// the HTML part sets in three paragraphs.
export const resetSubject = byLang(
  (product: string) => `Reset your ${product} password`,
  (product: string) => `${product} のパスワード再設定`,
)
export const resetIntro = byLang(
  () => 'Someone asked to reset the password for this address.',
  () => 'このアドレスのパスワード再設定が要求されました。',
)
export const resetOpenWithinHour = byLang(
  () => 'Open this link within the hour:',
  () => '1時間以内に次のリンクを開いてください:',
)
export const resetLinkLabel = byLang(() => 'Choose a new password', () => '新しいパスワードを設定する')
export const resetLinkHint = byLang(
  () => '(the link works for one hour)',
  () => '（リンクの有効期限は1時間です）',
)
export const resetIgnore = byLang(
  () => 'If it was not you, you can ignore this — nothing has changed.',
  () => '心当たりがない場合はこのメールを無視してください。何も変更されていません。',
)
export const resetBodyText = (lang: Lang, link: string): string =>
  `${joinSentences(lang, resetIntro(lang), resetOpenWithinHour(lang))}\n\n${link}\n\n${resetIgnore(lang)}`

// routes/members.ts — the invitation mail (create and reissue share these).
export const inviteSubject = byLang(
  (slug: string, product: string) => `You're invited to ${slug} on ${product}`,
  (slug: string, product: string) => `${product} の ${slug} に招待されました`,
)
export const inviteSentence = byLang(
  (slug: string, product: string) => `You've been invited to join ${slug} on ${product}.`,
  (slug: string, product: string) => `${product} の ${slug} に招待されました。`,
)
export const inviteOpenToAccept = byLang(
  () => 'Open this link to accept:',
  () => '次のリンクを開いて参加してください:',
)
export const inviteAcceptLabel = byLang(() => 'Accept your invitation', () => '招待を承諾する')
export const inviteBodyText = (lang: Lang, slug: string, product: string, url: string): string =>
  `${joinSentences(lang, inviteSentence(lang, slug, product), inviteOpenToAccept(lang))}\n\n${url}`
