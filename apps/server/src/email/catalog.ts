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
//
// #1160 / #713-S6: `byLang` took exactly two arms (en, ja) until this ticket. Widened to
// `Record<Lang, ...>` — the same forcing-function shape `EVENT_TYPE_LABELS`/`PERSONAL_SPACE_PHRASING`/
// `LANG_DESC` already use elsewhere — so a language added to `LANGS` is a compile error here until
// every entry gets a translation, rather than silently falling through to English the way the old
// `lang === 'ja' ? ja : en` binary did for every language between #713-S1 and this ticket.
//
// ⚠️ ADR-228's non-negotiable condition — "a machine-translated string must carry a mark on repo that
// says so" — applies here too, in spirit: every `de`/`fr`/`es`/`it`/`nl`/`pt-BR`/`ru`/`uk`/`zh-Hans`/`ko`
// entry below is LLM-translated, unreviewed by a human speaker of that language, same as the ten
// languages `apps/web/src/i18n/machine-translated.json` marks for the web UI's own locale JSON. That
// manifest's own mechanism (a JSON file walking `apps/web/src/i18n/locales/*.json`) does not reach this
// file — it is scoped to locale JSON, and this is TypeScript source holding a different asset (mail
// prose, not UI copy) — so this comment is this file's own mark until/unless a shared mechanism is
// built. Do not remove this note for a language without it actually having been proofed by a human
// speaker, the same discipline the JSON manifest documents for itself.
import type { Lang } from '../locale.js'

function byLang<Args extends unknown[]>(
  fns: Record<Lang, (...args: Args) => string>,
): (lang: Lang, ...args: Args) => string {
  return (lang, ...args) => fns[lang](...args)
}

// English/German/French/Spanish/Italian/Dutch/Portuguese/Russian/Ukrainian separate two sentences on
// one line with a space; Japanese, Simplified Chinese and Korean do not (Korean sentences end with a
// full-width-adjacent period and no following space is conventional in short notice copy). Used where
// a text part is composed here out of the same entries the HTML part sets in separate paragraphs — one
// wording, two shapes, so the two cannot drift apart.
const NO_SPACE_JOIN = new Set<Lang>(['ja', 'zh-Hans', 'ko'])
const joinSentences = (lang: Lang, ...parts: string[]): string => parts.join(NO_SPACE_JOIN.has(lang) ? '' : ' ')

// Shared by every class that carries an unsubscribe link (digest, mention).
export const stopEmails = byLang<[string]>({
  en: (url) => `Stop these emails: ${url}`,
  ja: (url) => `このメールの配信を停止する: ${url}`,
  de: (url) => `Diese E-Mails abbestellen: ${url}`,
  fr: (url) => `Se désabonner de ces e-mails : ${url}`,
  es: (url) => `Cancelar estos correos: ${url}`,
  it: (url) => `Annulla queste email: ${url}`,
  nl: (url) => `Deze e-mails stopzetten: ${url}`,
  'pt-BR': (url) => `Cancelar estes e-mails: ${url}`,
  ru: (url) => `Отписаться от этих писем: ${url}`,
  uk: (url) => `Відписатися від цих листів: ${url}`,
  'zh-Hans': (url) => `退订此类邮件：${url}`,
  ko: (url) => `이 메일 수신 중지: ${url}`,
})
/** The same words as the anchor TEXT; the builder writes the anchor around it. */
export const stopEmailsLabel = byLang<[]>({
  en: () => 'Stop these emails',
  ja: () => 'このメールの配信を停止する',
  de: () => 'Diese E-Mails abbestellen',
  fr: () => 'Se désabonner de ces e-mails',
  es: () => 'Cancelar estos correos',
  it: () => 'Annulla queste email',
  nl: () => 'Deze e-mails stopzetten',
  'pt-BR': () => 'Cancelar estes e-mails',
  ru: () => 'Отписаться от этих писем',
  uk: () => 'Відписатися від цих листів',
  'zh-Hans': () => '退订此类邮件',
  ko: () => '이 메일 수신 중지',
})

// layout.ts's shared shell footer. One entry: both parts say the same words, and the HTML part is
// the one that wraps it in a <p>.
export const poweredBy = byLang<[string]>({
  en: (product) => `Powered by ${product}`,
  ja: (product) => `${product} が提供しています`,
  de: (product) => `Bereitgestellt von ${product}`,
  fr: (product) => `Propulsé par ${product}`,
  es: (product) => `Con la tecnología de ${product}`,
  it: (product) => `Offerto da ${product}`,
  nl: (product) => `Mogelijk gemaakt door ${product}`,
  'pt-BR': (product) => `Desenvolvido por ${product}`,
  ru: (product) => `Работает на ${product}`,
  uk: (product) => `Працює на ${product}`,
  'zh-Hans': (product) => `由 ${product} 提供支持`,
  ko: (product) => `${product} 제공`,
})

// digest.ts — the rollup's "Updated" fallback (an event_type this build has no label for), the
// subject, and the per-row link label.
export const updatedFallback = byLang<[]>({
  en: () => 'Updated',
  ja: () => '更新されました',
  de: () => 'Aktualisiert',
  fr: () => 'Mis à jour',
  es: () => 'Actualizado',
  it: () => 'Aggiornato',
  nl: () => 'Bijgewerkt',
  'pt-BR': () => 'Atualizado',
  ru: () => 'Обновлено',
  uk: () => 'Оновлено',
  'zh-Hans': () => '已更新',
  ko: () => '업데이트됨',
})
export const digestSubject = byLang<[number]>({
  en: (n) => `Your digest: ${n} update${n === 1 ? '' : 's'}`,
  ja: (n) => `ダイジェスト: ${n} 件の更新`,
  de: (n) => `Ihre Zusammenfassung: ${n} Aktualisierung${n === 1 ? '' : 'en'}`,
  fr: (n) => `Votre résumé : ${n} mise${n === 1 ? '' : 's'} à jour`,
  es: (n) => `Tu resumen: ${n} actualización${n === 1 ? '' : 'es'}`,
  it: (n) => `Il tuo riepilogo: ${n} aggiornamento${n === 1 ? '' : 'i'}`,
  nl: (n) => `Je overzicht: ${n} update${n === 1 ? '' : 's'}`,
  'pt-BR': (n) => `Seu resumo: ${n} atualização${n === 1 ? '' : 'ões'}`,
  ru: (n) => `Ваша сводка: обновлений — ${n}`,
  uk: (n) => `Ваш дайджест: оновлень — ${n}`,
  'zh-Hans': (n) => `摘要：${n} 条更新`,
  ko: (n) => `다이제스트: 업데이트 ${n}건`,
})
export const openLabel = byLang<[]>({
  en: () => 'open',
  ja: () => '開く',
  de: () => 'öffnen',
  fr: () => 'ouvrir',
  es: () => 'abrir',
  it: () => 'apri',
  nl: () => 'openen',
  'pt-BR': () => 'abrir',
  ru: () => 'открыть',
  uk: () => 'відкрити',
  'zh-Hans': () => '打开',
  ko: () => '열기',
})

// mention-builder.ts
export const andMore = byLang<[number]>({
  en: (n) => ` (and ${n} more)`,
  ja: (n) => `（他 ${n} 件）`,
  de: (n) => ` (und ${n} weitere)`,
  fr: (n) => ` (et ${n} de plus)`,
  es: (n) => ` (y ${n} más)`,
  it: (n) => ` (e altri ${n})`,
  nl: (n) => ` (en nog ${n})`,
  'pt-BR': (n) => ` (e mais ${n})`,
  ru: (n) => ` (и ещё ${n})`,
  uk: (n) => ` (і ще ${n})`,
  'zh-Hans': (n) => `（另外 ${n} 条）`,
  ko: (n) => ` (외 ${n}건)`,
})
export const untitledPage = byLang<[]>({
  en: () => 'a page',
  ja: () => '無題のページ',
  de: () => 'eine Seite',
  fr: () => 'une page',
  es: () => 'una página',
  it: () => 'una pagina',
  nl: () => 'een pagina',
  'pt-BR': () => 'uma página',
  ru: () => 'страница',
  uk: () => 'сторінка',
  'zh-Hans': () => '一个页面',
  ko: () => '페이지',
})
export const mentionSubject = byLang<[string, string]>({
  en: (title, more) => `You were mentioned in "${title}"${more}`,
  ja: (title, more) => `「${title}」であなたがメンションされました${more}`,
  de: (title, more) => `Du wurdest in „${title}“ erwähnt${more}`,
  fr: (title, more) => `Vous avez été mentionné(e) dans « ${title} »${more}`,
  es: (title, more) => `Te mencionaron en «${title}»${more}`,
  it: (title, more) => `Sei stato menzionato in "${title}"${more}`,
  nl: (title, more) => `Je bent genoemd in "${title}"${more}`,
  'pt-BR': (title, more) => `Você foi mencionado em "${title}"${more}`,
  ru: (title, more) => `Вас упомянули в «${title}»${more}`,
  uk: (title, more) => `Вас згадали в «${title}»${more}`,
  'zh-Hans': (title, more) => `有人在《${title}》中提到了你${more}`,
  ko: (title, more) => `"${title}"에서 회원님이 언급되었습니다${more}`,
})
/**
 * The mail's one sentence. `title` arrives raw in the text part, and as the builder's own escaped
 * `<strong>…</strong>` in the HTML part — the entry stays text either way (§3.3a).
 */
export const mentionSentence = byLang<[string, string]>({
  en: (title, more) => `You were mentioned in "${title}"${more}.`,
  ja: (title, more) => `「${title}」であなたがメンションされました${more}。`,
  de: (title, more) => `Du wurdest in „${title}“ erwähnt${more}.`,
  fr: (title, more) => `Vous avez été mentionné(e) dans « ${title} »${more}.`,
  es: (title, more) => `Te mencionaron en «${title}»${more}.`,
  it: (title, more) => `Sei stato menzionato in "${title}"${more}.`,
  nl: (title, more) => `Je bent genoemd in "${title}"${more}.`,
  'pt-BR': (title, more) => `Você foi mencionado em "${title}"${more}.`,
  ru: (title, more) => `Вас упомянули в «${title}»${more}.`,
  uk: (title, more) => `Вас згадали в «${title}»${more}.`,
  'zh-Hans': (title, more) => `有人在《${title}》中提到了你${more}。`,
  ko: (title, more) => `"${title}"에서 회원님이 언급되었습니다${more}.`,
})
export const openThePage = byLang<[]>({
  en: () => 'Open the page',
  ja: () => 'ページを開く',
  de: () => 'Seite öffnen',
  fr: () => 'Ouvrir la page',
  es: () => 'Abrir la página',
  it: () => 'Apri la pagina',
  nl: () => 'Open de pagina',
  'pt-BR': () => 'Abrir a página',
  ru: () => 'Открыть страницу',
  uk: () => 'Відкрити сторінку',
  'zh-Hans': () => '打开页面',
  ko: () => '페이지 열기',
})
export const mentionBodyText = (lang: Lang, title: string, more: string, link: string): string =>
  `${mentionSentence(lang, title, more)}\n\n${openThePage(lang)}:\n${link}`

// security-builder.ts — recovery codes minted / used, and their shared footer. The bodies are TEXT
// with a blank line between paragraphs; the builder turns that into <p> elements for the HTML part,
// so the two parts cannot say different things.
export const recoveryFooter = byLang<[]>({
  en: () => 'If this was not you, sign in and re-mint your recovery codes, then tell an administrator.',
  ja: () => '心当たりがない場合は、サインインしてリカバリーコードを再発行し、管理者に連絡してください。',
  de: () => 'Wenn Sie das nicht waren, melden Sie sich an, erzeugen Sie neue Wiederherstellungscodes und benachrichtigen Sie eine Administratorin oder einen Administrator.',
  fr: () => "Si ce n'était pas vous, connectez-vous, régénérez vos codes de récupération, puis prévenez un administrateur.",
  es: () => 'Si no fuiste tú, inicia sesión, genera nuevos códigos de recuperación y avisa a un administrador.',
  it: () => 'Se non sei stato tu, accedi, rigenera i codici di recupero e avvisa un amministratore.',
  nl: () => 'Als jij dit niet was, log dan in, genereer nieuwe herstelcodes en meld het bij een beheerder.',
  'pt-BR': () => 'Se não foi você, entre na sua conta, gere novos códigos de recuperação e avise um administrador.',
  ru: () => 'Если это были не вы, войдите в систему, создайте новые коды восстановления и сообщите администратору.',
  uk: () => 'Якщо це були не ви, увійдіть, створіть нові коди відновлення й повідомте адміністратора.',
  'zh-Hans': () => '如果这不是你本人的操作，请登录后重新生成恢复码，并告知管理员。',
  ko: () => '본인이 아니라면 로그인하여 복구 코드를 재발급하고 관리자에게 알려주세요.',
})
export const recoveryMintedSubject = byLang<[]>({
  en: () => 'Recovery codes were created for your account',
  ja: () => 'アカウントのリカバリーコードが作成されました',
  de: () => 'Für Ihr Konto wurden Wiederherstellungscodes erstellt',
  fr: () => 'Des codes de récupération ont été créés pour votre compte',
  es: () => 'Se crearon códigos de recuperación para tu cuenta',
  it: () => 'Sono stati creati codici di recupero per il tuo account',
  nl: () => 'Er zijn herstelcodes aangemaakt voor je account',
  'pt-BR': () => 'Códigos de recuperação foram criados para sua conta',
  ru: () => 'Для вашей учётной записи созданы коды восстановления',
  uk: () => 'Для вашого облікового запису створено коди відновлення',
  'zh-Hans': () => '你的账户已生成新的恢复码',
  ko: () => '계정에 대한 복구 코드가 생성되었습니다',
})
export const recoveryMintedBody = byLang<[]>({
  en: () =>
    'A new set of recovery codes was created for your account. Any earlier set has stopped working.\n\n'
    + 'Keep the codes somewhere you can reach without your phone. Each one works once, and using one '
    + 'removes every second factor from your account.',
  ja: () =>
    'アカウントの新しいリカバリーコードが作成されました。以前のコードはすべて使えなくなりました。\n\n'
    + 'コードはスマートフォンが無くても取り出せる場所に保管してください。各コードは1回限り使用でき、'
    + '1つでも使用するとアカウントの第2要素はすべて解除されます。',
  de: () =>
    'Für Ihr Konto wurde ein neuer Satz Wiederherstellungscodes erstellt. Alle vorherigen Codes funktionieren nicht mehr.\n\n'
    + 'Bewahren Sie die Codes an einem Ort auf, den Sie auch ohne Ihr Telefon erreichen. Jeder Code funktioniert nur einmal, '
    + 'und die Verwendung eines Codes entfernt jeden zweiten Faktor aus Ihrem Konto.',
  fr: () =>
    "Une nouvelle série de codes de récupération a été créée pour votre compte. L'ancienne série ne fonctionne plus.\n\n"
    + "Conservez les codes dans un endroit accessible même sans votre téléphone. Chaque code ne fonctionne qu'une fois, "
    + 'et son utilisation supprime tous les seconds facteurs de votre compte.',
  es: () =>
    'Se creó un nuevo conjunto de códigos de recuperación para tu cuenta. El conjunto anterior dejó de funcionar.\n\n'
    + 'Guarda los códigos en un lugar al que puedas acceder sin tu teléfono. Cada uno funciona una sola vez, y usar '
    + 'uno elimina todos los segundos factores de tu cuenta.',
  it: () =>
    'È stato creato un nuovo set di codici di recupero per il tuo account. Il set precedente ha smesso di funzionare.\n\n'
    + "Conserva i codici in un posto raggiungibile anche senza il telefono. Ogni codice funziona una sola volta e l'uso "
    + 'di uno di essi rimuove ogni secondo fattore dal tuo account.',
  nl: () =>
    'Er is een nieuwe set herstelcodes voor je account aangemaakt. Elke eerdere set werkt niet meer.\n\n'
    + 'Bewaar de codes op een plek die je ook zonder je telefoon kunt bereiken. Elke code werkt één keer, en het '
    + 'gebruik van een code verwijdert elke tweede factor van je account.',
  'pt-BR': () =>
    'Um novo conjunto de códigos de recuperação foi criado para sua conta. Qualquer conjunto anterior parou de funcionar.\n\n'
    + 'Guarde os códigos em um lugar acessível mesmo sem o seu celular. Cada código funciona uma única vez, e usar '
    + 'um deles remove todos os segundos fatores da sua conta.',
  ru: () =>
    'Для вашей учётной записи создан новый набор кодов восстановления. Все прежние коды перестали действовать.\n\n'
    + 'Храните коды там, где сможете найти их и без телефона. Каждый код работает один раз, и его использование '
    + 'удаляет все вторые факторы из вашей учётной записи.',
  uk: () =>
    'Для вашого облікового запису створено новий набір кодів відновлення. Усі попередні коди більше не діють.\n\n'
    + 'Зберігайте коди там, де зможете знайти їх і без телефону. Кожен код працює один раз, і його використання '
    + 'вилучає всі другі фактори з вашого облікового запису.',
  'zh-Hans': () =>
    '系统已为你的账户生成一组新的恢复码，此前的恢复码已全部失效。\n\n'
    + '请将这些恢复码保存在没有手机也能取用的地方。每个恢复码仅可使用一次，使用后你账户的第二身份验证方式将全部被移除。',
  ko: () =>
    '계정에 대한 새 복구 코드 세트가 생성되었습니다. 이전 코드 세트는 더 이상 작동하지 않습니다.\n\n'
    + '휴대폰 없이도 확인할 수 있는 곳에 코드를 보관하세요. 각 코드는 한 번만 사용할 수 있으며, 하나를 사용하면 '
    + '계정의 모든 2단계 인증 수단이 해제됩니다.',
})
export const recoveryUsedSubject = byLang<[]>({
  en: () => 'A recovery code was used on your account',
  ja: () => 'アカウントでリカバリーコードが使用されました',
  de: () => 'Für Ihr Konto wurde ein Wiederherstellungscode verwendet',
  fr: () => 'Un code de récupération a été utilisé sur votre compte',
  es: () => 'Se utilizó un código de recuperación en tu cuenta',
  it: () => 'È stato usato un codice di recupero sul tuo account',
  nl: () => 'Er is een herstelcode gebruikt op je account',
  'pt-BR': () => 'Um código de recuperação foi usado na sua conta',
  ru: () => 'В вашей учётной записи использован код восстановления',
  uk: () => 'У вашому обліковому записі використано код відновлення',
  'zh-Hans': () => '你的账户使用了一个恢复码',
  ko: () => '계정에서 복구 코드가 사용되었습니다',
})
export const recoveryUsedBody = byLang<[]>({
  en: () =>
    'A recovery code was used to get back into your account. Every second factor has been removed, '
    + 'the rest of that set of codes no longer works, and every session was signed out.\n\n'
    + 'If this was you, enrol a new authenticator and create a fresh set of codes.',
  ja: () =>
    'リカバリーコードを使ってアカウントに再度サインインされました。第2要素はすべて解除され、'
    + '同じセットの残りのコードも使えなくなり、すべてのセッションがサインアウトされました。\n\n'
    + '心当たりがある場合は、新しい認証アプリを登録し、新しいリカバリーコードを作成してください。',
  de: () =>
    'Ein Wiederherstellungscode wurde verwendet, um wieder Zugriff auf Ihr Konto zu erhalten. Jeder zweite Faktor wurde entfernt, '
    + 'die restlichen Codes dieses Satzes funktionieren nicht mehr, und alle Sitzungen wurden abgemeldet.\n\n'
    + 'Wenn Sie das waren, richten Sie einen neuen Authenticator ein und erstellen Sie einen neuen Satz Codes.',
  fr: () =>
    'Un code de récupération a été utilisé pour retrouver l\'accès à votre compte. Tous les seconds facteurs ont été supprimés, '
    + 'le reste de cette série de codes ne fonctionne plus, et toutes les sessions ont été déconnectées.\n\n'
    + "Si c'était vous, inscrivez un nouvel authentificateur et créez une nouvelle série de codes.",
  es: () =>
    'Se usó un código de recuperación para volver a entrar en tu cuenta. Se eliminaron todos los segundos factores, '
    + 'el resto de ese conjunto de códigos dejó de funcionar y se cerraron todas las sesiones.\n\n'
    + 'Si fuiste tú, registra un nuevo autenticador y crea un nuevo conjunto de códigos.',
  it: () =>
    "È stato usato un codice di recupero per rientrare nel tuo account. Ogni secondo fattore è stato rimosso, "
    + 'il resto di quel set di codici non funziona più e tutte le sessioni sono state disconnesse.\n\n'
    + "Se sei stato tu, registra un nuovo autenticatore e crea un nuovo set di codici.",
  nl: () =>
    'Er is een herstelcode gebruikt om weer toegang tot je account te krijgen. Elke tweede factor is verwijderd, '
    + 'de rest van die set codes werkt niet meer, en alle sessies zijn uitgelogd.\n\n'
    + 'Als jij dit was, registreer dan een nieuwe authenticator en maak een nieuwe set codes aan.',
  'pt-BR': () =>
    'Um código de recuperação foi usado para acessar novamente sua conta. Todos os segundos fatores foram removidos, '
    + 'o restante desse conjunto de códigos não funciona mais, e todas as sessões foram desconectadas.\n\n'
    + 'Se foi você, cadastre um novo autenticador e crie um novo conjunto de códigos.',
  ru: () =>
    'Код восстановления был использован для входа в вашу учётную запись. Все вторые факторы удалены, '
    + 'остальные коды из этого набора больше не действуют, и все сеансы были завершены.\n\n'
    + 'Если это были вы, настройте новое устройство аутентификации и создайте новый набор кодов.',
  uk: () =>
    'Код відновлення було використано для входу у ваш обліковий запис. Усі другі фактори вилучено, '
    + 'решта кодів із цього набору більше не діють, і всі сеанси завершено.\n\n'
    + 'Якщо це були ви, налаштуйте новий пристрій автентифікації та створіть новий набір кодів.',
  'zh-Hans': () =>
    '系统检测到有人使用恢复码重新登录了你的账户。所有第二身份验证方式已被移除，'
    + '该组恢复码的其余部分也已失效，并且所有会话均已注销。\n\n'
    + '如果这是你本人的操作，请注册新的身份验证器并生成一组新的恢复码。',
  ko: () =>
    '복구 코드를 사용하여 계정에 다시 로그인했습니다. 모든 2단계 인증 수단이 해제되었고, '
    + '같은 세트의 나머지 코드도 더 이상 사용할 수 없으며, 모든 세션이 로그아웃되었습니다.\n\n'
    + '본인이 맞다면 새 인증 앱을 등록하고 새 복구 코드 세트를 생성하세요.',
})

// scim-offboarding-builder.ts — #1051 / ADR-275 rev3 §4, ruling ⑤/B5: the copy discloses NO state.
// The recipient set includes people the directory just told to leave, so the words must not say
// which floor, who is pending, or how many administrators remain — only that something needs an
// administrator's attention, and the two SHIPPED tools ⑥/B8 named for acting on it.
export const scimOffboardingDeferredSubject = byLang<[]>({
  en: () => 'A directory change needs an administrator',
  ja: () => 'ディレクトリの変更に管理者の対応が必要です',
  de: () => 'Eine Verzeichnisänderung erfordert eine Administratorin oder einen Administrator',
  fr: () => 'Une modification de l\'annuaire nécessite un administrateur',
  es: () => 'Un cambio en el directorio requiere un administrador',
  it: () => 'Una modifica alla directory richiede un amministratore',
  nl: () => 'Een directorywijziging vereist een beheerder',
  'pt-BR': () => 'Uma alteração no diretório precisa de um administrador',
  ru: () => 'Изменение в каталоге требует внимания администратора',
  uk: () => 'Зміна в каталозі потребує уваги адміністратора',
  'zh-Hans': () => '目录变更需要管理员处理',
  ko: () => '디렉터리 변경에 관리자 조치가 필요합니다',
})
export const scimOffboardingDeferredBody = byLang<[]>({
  en: () =>
    'A change made through your identity provider could not be completed. Please contact an '
    + 'administrator of this workspace.\n\n'
    + 'If you operate this server, run `pnpm tenant:login-methods` or `pnpm tenant:local-admin` '
    + 'to restore access.',
  ja: () =>
    'IDプロバイダー経由の変更が完了しませんでした。このワークスペースの管理者にご連絡ください。\n\n'
    + 'サーバの運用担当者の方は、`pnpm tenant:login-methods` または `pnpm tenant:local-admin` '
    + 'でアクセスを復旧できます。',
  de: () =>
    'Eine über Ihren Identitätsanbieter vorgenommene Änderung konnte nicht abgeschlossen werden. Bitte wenden Sie sich an '
    + 'eine Administratorin oder einen Administrator dieses Arbeitsbereichs.\n\n'
    + 'Wenn Sie diesen Server betreiben, führen Sie `pnpm tenant:login-methods` oder `pnpm tenant:local-admin` aus, '
    + 'um den Zugriff wiederherzustellen.',
  fr: () =>
    "Une modification effectuée via votre fournisseur d'identité n'a pas pu être terminée. Veuillez contacter un "
    + 'administrateur de cet espace de travail.\n\n'
    + 'Si vous exploitez ce serveur, exécutez `pnpm tenant:login-methods` ou `pnpm tenant:local-admin` '
    + "pour rétablir l'accès.",
  es: () =>
    'No se pudo completar un cambio realizado a través de tu proveedor de identidad. Ponte en contacto con un '
    + 'administrador de este espacio de trabajo.\n\n'
    + 'Si operas este servidor, ejecuta `pnpm tenant:login-methods` o `pnpm tenant:local-admin` '
    + 'para restaurar el acceso.',
  it: () =>
    'Non è stato possibile completare una modifica effettuata tramite il tuo provider di identità. Contatta un '
    + 'amministratore di questo spazio di lavoro.\n\n'
    + 'Se gestisci questo server, esegui `pnpm tenant:login-methods` o `pnpm tenant:local-admin` '
    + "per ripristinare l'accesso.",
  nl: () =>
    'Een wijziging via je identiteitsprovider kon niet worden voltooid. Neem contact op met een '
    + 'beheerder van deze werkruimte.\n\n'
    + 'Als je deze server beheert, voer dan `pnpm tenant:login-methods` of `pnpm tenant:local-admin` uit '
    + 'om de toegang te herstellen.',
  'pt-BR': () =>
    'Não foi possível concluir uma alteração feita pelo seu provedor de identidade. Entre em contato com um '
    + 'administrador deste workspace.\n\n'
    + 'Se você opera este servidor, execute `pnpm tenant:login-methods` ou `pnpm tenant:local-admin` '
    + 'para restaurar o acesso.',
  ru: () =>
    'Не удалось завершить изменение, внесённое через вашего провайдера идентификации. Обратитесь к '
    + 'администратору этого рабочего пространства.\n\n'
    + 'Если вы управляете этим сервером, выполните `pnpm tenant:login-methods` или `pnpm tenant:local-admin`, '
    + 'чтобы восстановить доступ.',
  uk: () =>
    'Не вдалося завершити зміну, внесену через вашого провайдера ідентифікації. Зверніться до '
    + 'адміністратора цього робочого простору.\n\n'
    + 'Якщо ви керуєте цим сервером, виконайте `pnpm tenant:login-methods` або `pnpm tenant:local-admin`, '
    + 'щоб відновити доступ.',
  'zh-Hans': () =>
    '通过你的身份提供方发起的变更未能完成，请联系此工作区的管理员处理。\n\n'
    + '如果你是该服务器的运维人员，可运行 `pnpm tenant:login-methods` 或 `pnpm tenant:local-admin` 以恢复访问。',
  ko: () =>
    'ID 공급자를 통한 변경 작업을 완료하지 못했습니다. 이 워크스페이스의 관리자에게 문의해 주세요.\n\n'
    + '이 서버를 운영 중이라면 `pnpm tenant:login-methods` 또는 `pnpm tenant:local-admin` 명령으로 '
    + '접근 권한을 복구할 수 있습니다.',
})

// routes/email-unsubscribe.ts
export const unsubKindMention = byLang<[]>({
  en: () => 'mention email',
  ja: () => 'メンション通知メール',
  de: () => 'Erwähnungs-E-Mail',
  fr: () => 'e-mail de mention',
  es: () => 'correo de mención',
  it: () => 'email di menzione',
  nl: () => 'vermeldingsmail',
  'pt-BR': () => 'e-mail de menção',
  ru: () => 'письмо об упоминании',
  uk: () => 'лист про згадку',
  'zh-Hans': () => '提及通知邮件',
  ko: () => '멘션 알림 메일',
})
export const unsubKindDigest = byLang<[]>({
  en: () => 'digest email',
  ja: () => 'ダイジェストメール',
  de: () => 'Zusammenfassungs-E-Mail',
  fr: () => 'e-mail de résumé',
  es: () => 'correo de resumen',
  it: () => 'email di riepilogo',
  nl: () => 'overzichtsmail',
  'pt-BR': () => 'e-mail de resumo',
  ru: () => 'сводное письмо',
  uk: () => 'дайджест-лист',
  'zh-Hans': () => '摘要邮件',
  ko: () => '다이제스트 메일',
})
export const unsubTitle = byLang<[string]>({
  en: (brand) => `Unsubscribe from ${brand}`,
  ja: (brand) => `${brand} の配信停止`,
  de: (brand) => `Von ${brand} abmelden`,
  fr: (brand) => `Se désabonner de ${brand}`,
  es: (brand) => `Cancelar suscripción a ${brand}`,
  it: (brand) => `Annulla iscrizione a ${brand}`,
  nl: (brand) => `Afmelden bij ${brand}`,
  'pt-BR': (brand) => `Cancelar inscrição em ${brand}`,
  ru: (brand) => `Отписаться от ${brand}`,
  uk: (brand) => `Відписатися від ${brand}`,
  'zh-Hans': (brand) => `退订 ${brand}`,
  ko: (brand) => `${brand} 수신 취소`,
})
export const unsubHeading = byLang<[string]>({
  en: (kind) => `Stop receiving ${kind}?`,
  ja: (kind) => `${kind}の配信を停止しますか？`,
  de: (kind) => `${kind} nicht mehr erhalten?`,
  fr: (kind) => `Ne plus recevoir de ${kind} ?`,
  es: (kind) => `¿Dejar de recibir ${kind}?`,
  it: (kind) => `Non ricevere più ${kind}?`,
  nl: (kind) => `Geen ${kind} meer ontvangen?`,
  'pt-BR': (kind) => `Parar de receber ${kind}?`,
  ru: (kind) => `Больше не получать «${kind}»?`,
  uk: (kind) => `Більше не отримувати «${kind}»?`,
  'zh-Hans': (kind) => `不再接收${kind}？`,
  ko: (kind) => `${kind} 수신을 중지할까요?`,
})
export const unsubBody = byLang<[string, string]>({
  en: (kind, brand) =>
    `This turns off ${kind} from ${brand} for your account. You can turn it back on any time in your account settings.`,
  ja: (kind, brand) =>
    `${brand} からの${kind}がオフになります。アカウント設定からいつでも再度オンにできます。`,
  de: (kind, brand) =>
    `Damit schalten Sie ${kind} von ${brand} für Ihr Konto aus. Sie können sie jederzeit in Ihren Kontoeinstellungen wieder einschalten.`,
  fr: (kind, brand) =>
    `Cela désactive le ${kind} de ${brand} pour votre compte. Vous pouvez le réactiver à tout moment dans les paramètres de votre compte.`,
  es: (kind, brand) =>
    `Esto desactiva el ${kind} de ${brand} para tu cuenta. Puedes volver a activarlo en cualquier momento desde la configuración de tu cuenta.`,
  it: (kind, brand) =>
    `Questo disattiva ${kind} da ${brand} per il tuo account. Puoi riattivarlo in qualsiasi momento dalle impostazioni del tuo account.`,
  nl: (kind, brand) =>
    `Hiermee schakel je ${kind} van ${brand} uit voor je account. Je kunt dit op elk moment weer aanzetten in je accountinstellingen.`,
  'pt-BR': (kind, brand) =>
    `Isso desativa ${kind} de ${brand} para sua conta. Você pode reativar a qualquer momento nas configurações da sua conta.`,
  ru: (kind, brand) =>
    `Это отключит «${kind}» от ${brand} для вашей учётной записи. Вы можете снова включить их в любой момент в настройках учётной записи.`,
  uk: (kind, brand) =>
    `Це вимкне «${kind}» від ${brand} для вашого облікового запису. Ви можете знову увімкнути їх будь-коли в налаштуваннях облікового запису.`,
  'zh-Hans': (kind, brand) =>
    `此操作将关闭你账户来自 ${brand} 的${kind}。你可以随时在账户设置中重新开启。`,
  ko: (kind, brand) =>
    `이 작업으로 계정에서 ${brand}의 ${kind} 수신이 꺼집니다. 계정 설정에서 언제든지 다시 켤 수 있습니다.`,
})
export const unsubscribeButton = byLang<[]>({
  en: () => 'Unsubscribe',
  ja: () => '配信停止',
  de: () => 'Abbestellen',
  fr: () => 'Se désabonner',
  es: () => 'Cancelar suscripción',
  it: () => 'Annulla iscrizione',
  nl: () => 'Afmelden',
  'pt-BR': () => 'Cancelar inscrição',
  ru: () => 'Отписаться',
  uk: () => 'Відписатися',
  'zh-Hans': () => '退订',
  ko: () => '수신 취소',
})
export const unsubscribedTitle = byLang<[]>({
  en: () => 'Unsubscribed',
  ja: () => '配信停止しました',
  de: () => 'Abgemeldet',
  fr: () => 'Désabonné',
  es: () => 'Suscripción cancelada',
  it: () => 'Iscrizione annullata',
  nl: () => 'Afgemeld',
  'pt-BR': () => 'Inscrição cancelada',
  ru: () => 'Отписка выполнена',
  uk: () => 'Відписку виконано',
  'zh-Hans': () => '已退订',
  ko: () => '수신 취소됨',
})
export const unsubscribedBody = byLang<[]>({
  en: () => 'Unsubscribed. You can re-enable this email in your account settings.',
  ja: () => '配信を停止しました。アカウント設定からいつでも再度有効にできます。',
  de: () => 'Abgemeldet. Sie können diese E-Mail in Ihren Kontoeinstellungen wieder aktivieren.',
  fr: () => 'Désabonné. Vous pouvez réactiver cet e-mail dans les paramètres de votre compte.',
  es: () => 'Suscripción cancelada. Puedes volver a activar este correo en la configuración de tu cuenta.',
  it: () => "Iscrizione annullata. Puoi riattivare questa email dalle impostazioni del tuo account.",
  nl: () => 'Afgemeld. Je kunt deze e-mail weer inschakelen in je accountinstellingen.',
  'pt-BR': () => 'Inscrição cancelada. Você pode reativar este e-mail nas configurações da sua conta.',
  ru: () => 'Отписка выполнена. Вы можете снова включить это письмо в настройках учётной записи.',
  uk: () => 'Відписку виконано. Ви можете знову увімкнути цей лист у налаштуваннях облікового запису.',
  'zh-Hans': () => '已退订。你可以随时在账户设置中重新启用此邮件。',
  ko: () => '수신이 취소되었습니다. 계정 설정에서 언제든지 다시 활성화할 수 있습니다.',
})

// routes/auth-local.ts — the password reset request mail. The text part composes the same entries
// the HTML part sets in three paragraphs.
export const resetSubject = byLang<[string]>({
  en: (product) => `Reset your ${product} password`,
  ja: (product) => `${product} のパスワード再設定`,
  de: (product) => `Setzen Sie Ihr ${product}-Passwort zurück`,
  fr: (product) => `Réinitialisez votre mot de passe ${product}`,
  es: (product) => `Restablece tu contraseña de ${product}`,
  it: (product) => `Reimposta la tua password di ${product}`,
  nl: (product) => `Stel je ${product}-wachtwoord opnieuw in`,
  'pt-BR': (product) => `Redefina sua senha do ${product}`,
  ru: (product) => `Сброс пароля в ${product}`,
  uk: (product) => `Скидання пароля в ${product}`,
  'zh-Hans': (product) => `重置你的 ${product} 密码`,
  ko: (product) => `${product} 비밀번호 재설정`,
})
export const resetIntro = byLang<[]>({
  en: () => 'Someone asked to reset the password for this address.',
  ja: () => 'このアドレスのパスワード再設定が要求されました。',
  de: () => 'Jemand hat gebeten, das Passwort für diese Adresse zurückzusetzen.',
  fr: () => "Quelqu'un a demandé la réinitialisation du mot de passe de cette adresse.",
  es: () => 'Alguien solicitó restablecer la contraseña de esta dirección.',
  it: () => 'Qualcuno ha richiesto la reimpostazione della password per questo indirizzo.',
  nl: () => 'Iemand heeft gevraagd om het wachtwoord voor dit adres opnieuw in te stellen.',
  'pt-BR': () => 'Alguém solicitou a redefinição da senha para este endereço.',
  ru: () => 'Кто-то запросил сброс пароля для этого адреса.',
  uk: () => 'Хтось запросив скидання пароля для цієї адреси.',
  'zh-Hans': () => '有人请求重置此邮箱地址的密码。',
  ko: () => '이 주소의 비밀번호 재설정이 요청되었습니다.',
})
export const resetOpenWithinHour = byLang<[]>({
  en: () => 'Open this link within the hour:',
  ja: () => '1時間以内に次のリンクを開いてください:',
  de: () => 'Öffnen Sie diesen Link innerhalb einer Stunde:',
  fr: () => "Ouvrez ce lien dans l'heure qui suit :",
  es: () => 'Abre este enlace dentro de la próxima hora:',
  it: () => "Apri questo link entro un'ora:",
  nl: () => 'Open deze link binnen het uur:',
  'pt-BR': () => 'Abra este link dentro de uma hora:',
  ru: () => 'Откройте эту ссылку в течение часа:',
  uk: () => 'Відкрийте це посилання протягом години:',
  'zh-Hans': () => '请在一小时内打开以下链接：',
  ko: () => '1시간 이내에 아래 링크를 열어주세요:',
})
export const resetLinkLabel = byLang<[]>({
  en: () => 'Choose a new password',
  ja: () => '新しいパスワードを設定する',
  de: () => 'Neues Passwort wählen',
  fr: () => 'Choisir un nouveau mot de passe',
  es: () => 'Elegir una nueva contraseña',
  it: () => 'Scegli una nuova password',
  nl: () => 'Kies een nieuw wachtwoord',
  'pt-BR': () => 'Escolher uma nova senha',
  ru: () => 'Выбрать новый пароль',
  uk: () => 'Вибрати новий пароль',
  'zh-Hans': () => '设置新密码',
  ko: () => '새 비밀번호 설정',
})
export const resetLinkHint = byLang<[]>({
  en: () => '(the link works for one hour)',
  ja: () => '（リンクの有効期限は1時間です）',
  de: () => '(der Link ist eine Stunde lang gültig)',
  fr: () => "(le lien est valable une heure)",
  es: () => '(el enlace es válido durante una hora)',
  it: () => "(il link è valido per un'ora)",
  nl: () => '(de link is een uur geldig)',
  'pt-BR': () => '(o link é válido por uma hora)',
  ru: () => '(ссылка действует один час)',
  uk: () => '(посилання дійсне протягом години)',
  'zh-Hans': () => '（链接有效期为一小时）',
  ko: () => '(링크는 1시간 동안 유효합니다)',
})
export const resetIgnore = byLang<[]>({
  en: () => 'If it was not you, you can ignore this — nothing has changed.',
  ja: () => '心当たりがない場合は、このメールを無視してください。パスワードは変更されません。',
  de: () => 'Wenn Sie das nicht waren, können Sie diese E-Mail ignorieren — es hat sich nichts geändert.',
  fr: () => "Si ce n'était pas vous, vous pouvez ignorer ce message — rien n'a changé.",
  es: () => 'Si no fuiste tú, puedes ignorar esto: no ha cambiado nada.',
  it: () => 'Se non sei stato tu, puoi ignorare questo messaggio: non è cambiato nulla.',
  nl: () => 'Als jij dit niet was, kun je dit negeren — er is niets veranderd.',
  'pt-BR': () => 'Se não foi você, pode ignorar esta mensagem — nada foi alterado.',
  ru: () => 'Если это были не вы, просто проигнорируйте это письмо — ничего не изменилось.',
  uk: () => 'Якщо це були не ви, просто проігноруйте цей лист — нічого не змінилося.',
  'zh-Hans': () => '如果这不是你本人的操作，可以忽略此邮件——你的密码不会发生任何变化。',
  ko: () => '본인이 아니라면 이 메일을 무시하셔도 됩니다. 아무것도 변경되지 않습니다.',
})
export const resetBodyText = (lang: Lang, link: string): string =>
  `${joinSentences(lang, resetIntro(lang), resetOpenWithinHour(lang))}\n\n${link}\n\n${resetIgnore(lang)}`

// routes/members.ts — the invitation mail (create and reissue share these).
export const inviteSubject = byLang<[string, string]>({
  en: (slug, product) => `You're invited to ${slug} on ${product}`,
  ja: (slug, product) => `${product} の ${slug} に招待されました`,
  de: (slug, product) => `Sie sind zu ${slug} auf ${product} eingeladen`,
  fr: (slug, product) => `Vous êtes invité(e) à ${slug} sur ${product}`,
  es: (slug, product) => `Estás invitado a ${slug} en ${product}`,
  it: (slug, product) => `Sei stato invitato a ${slug} su ${product}`,
  nl: (slug, product) => `Je bent uitgenodigd voor ${slug} op ${product}`,
  'pt-BR': (slug, product) => `Você foi convidado para ${slug} no ${product}`,
  ru: (slug, product) => `Вас пригласили в ${slug} на ${product}`,
  uk: (slug, product) => `Вас запросили до ${slug} на ${product}`,
  'zh-Hans': (slug, product) => `你已被邀请加入 ${product} 上的 ${slug}`,
  ko: (slug, product) => `${product}의 ${slug}에 초대되었습니다`,
})
export const inviteSentence = byLang<[string, string]>({
  en: (slug, product) => `You've been invited to join ${slug} on ${product}.`,
  ja: (slug, product) => `${product} の ${slug} に招待されました。`,
  de: (slug, product) => `Sie wurden eingeladen, ${slug} auf ${product} beizutreten.`,
  fr: (slug, product) => `Vous avez été invité(e) à rejoindre ${slug} sur ${product}.`,
  es: (slug, product) => `Te han invitado a unirte a ${slug} en ${product}.`,
  it: (slug, product) => `Sei stato invitato a unirti a ${slug} su ${product}.`,
  nl: (slug, product) => `Je bent uitgenodigd om lid te worden van ${slug} op ${product}.`,
  'pt-BR': (slug, product) => `Você foi convidado a participar de ${slug} no ${product}.`,
  ru: (slug, product) => `Вас пригласили присоединиться к ${slug} на ${product}.`,
  uk: (slug, product) => `Вас запросили приєднатися до ${slug} на ${product}.`,
  'zh-Hans': (slug, product) => `你已被邀请加入 ${product} 上的 ${slug}。`,
  ko: (slug, product) => `${product}의 ${slug}에 참여하도록 초대되었습니다.`,
})
export const inviteOpenToAccept = byLang<[]>({
  en: () => 'Open this link to accept:',
  ja: () => '次のリンクを開いて参加してください:',
  de: () => 'Öffnen Sie diesen Link, um anzunehmen:',
  fr: () => 'Ouvrez ce lien pour accepter :',
  es: () => 'Abre este enlace para aceptar:',
  it: () => 'Apri questo link per accettare:',
  nl: () => 'Open deze link om te accepteren:',
  'pt-BR': () => 'Abra este link para aceitar:',
  ru: () => 'Откройте эту ссылку, чтобы принять приглашение:',
  uk: () => 'Відкрийте це посилання, щоб прийняти запрошення:',
  'zh-Hans': () => '请打开以下链接以接受邀请：',
  ko: () => '아래 링크를 열어 초대를 수락하세요:',
})
export const inviteAcceptLabel = byLang<[]>({
  en: () => 'Accept your invitation',
  ja: () => '招待を承諾する',
  de: () => 'Einladung annehmen',
  fr: () => "Accepter l'invitation",
  es: () => 'Aceptar tu invitación',
  it: () => 'Accetta il tuo invito',
  nl: () => 'Uitnodiging accepteren',
  'pt-BR': () => 'Aceitar seu convite',
  ru: () => 'Принять приглашение',
  uk: () => 'Прийняти запрошення',
  'zh-Hans': () => '接受邀请',
  ko: () => '초대 수락',
})
export const inviteBodyText = (lang: Lang, slug: string, product: string, url: string): string =>
  `${joinSentences(lang, inviteSentence(lang, slug, product), inviteOpenToAccept(lang))}\n\n${url}`
