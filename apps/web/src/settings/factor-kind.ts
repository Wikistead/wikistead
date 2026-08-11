import type { TFunction } from "i18next";

/**
 * What a second factor is CALLED, given its kind (#653/ #673).
 *
 * The list mixes kinds by design — a phone, a YubiKey and a laptop stand as rows next to each other —
 * but every sentence about a row was written when only authenticator apps existed, so four separate
 * places said "authenticator" whatever the row held:
 *
 *   the row's name when it has no label   a passkey enrolled without a name read "Authenticator app"
 *   the toast after adding                adding a passkey said "Authenticator added."
 *   the toast after removing              removing a passkey said "Authenticator removed."
 *
 * Fixing them one at a time is how this surface has repeatedly grown a second vocabulary: the noun
 * would then live in three sentences, and the next kind has to find all three. It lives here instead,
 * and the sentences interpolate it.
 *
 * An UNKNOWN kind gets a neutral noun rather than falling back to the authenticator app. Defaulting to
 * one of the real kinds is precisely the defect being fixed — it reads correctly today and starts
 * lying, silently, the day the server grows a third kind. "Security factor" is never wrong.
 */
export function factorKindName(kind: string | null | undefined, t: TFunction): string {
  switch (kind) {
    case "totp": return t("account.factorKindTotp");
    case "passkey": return t("account.factorKindPasskey");
    default: return t("account.factorKindOther");
  }
}

/**
 * The kinds a workspace accepts, written out for a reader (#686 A).
 *
 * Three sentences named a kind while the tenant's stance was already in hand one line away: the
 * interstitial's prompt said "set up an authenticator app" beside a button offering only a passkey, and
 * the account panel promised a passkey to a tenant that had stopped accepting them. A person told to do
 * something the workspace refuses has no way to comply — and on the interstitial they are not signed in,
 * so that sentence is the only instruction they have.
 *
 * Built from `factorKindName` rather than from its own words. Naming the kinds again here is how this
 * surface grew four spellings of "authenticator app" (#653, #673/); the nouns have one
 * home and every sentence interpolates them.
 *
 * An EMPTY or absent list reads as "everything", matching what the interstitial's `accepts()` already
 * does with an older server's response — a screen that named nothing would be worse than one that names
 * one kind too many.
 */
export const ALL_FACTOR_KINDS = ["passkey", "totp"] as const;

export function factorKindsPhrase(kinds: readonly string[] | null | undefined, t: TFunction): string {
  const named = (kinds?.length ? kinds : ALL_FACTOR_KINDS).filter((k) => k);
  const names = named.map((k) => factorKindName(k, t));
  // Two is the most this product has, but the join is written for N: the day a third kind lands, the
  // sentence should read rather than need finding.
  if (names.length <= 1) return names[0] ?? factorKindName(null, t);
  return names.slice(0, -1).join(t("account.factorKindListSep")) + t("account.factorKindOr") + names[names.length - 1];
}

/**
 * The kinds a stance accepts, as the screen sees it (#686 A ②).
 *
 * The server answers the same question per ROW (`counts`), deliberately, because it also needs the host
 * — a passkey made before a domain move is a row nobody can present. This is the coarser question the
 * SENTENCES ask: which kinds may be offered at all. It is not a second copy of the row rule, and it must
 * not be used to decide whether a row counts.
 *
 * `off` and an unknown value read as everything: a workspace that asks for nothing has no narrowing to
 * describe, and an older server that sends no stance should not shrink the sentence.
 */
export function acceptedFactorKinds(stance: string | null | undefined): readonly string[] {
  return stance === "passkey" || stance === "totp" ? [stance] : ALL_FACTOR_KINDS;
}

/**
 * Whether THIS browser can enrol and present a factor of the given kind (#686).
 *
 * The same asymmetry as the stance, one fact over: the sign-in interstitial hid its passkey button in a
 * browser without WebAuthn while the account panel kept offering "Add a passkey" — an entrance that
 * cannot be walked through. The two surfaces were reading DIFFERENT copies of the question (one asked,
 * one never did), which is the whole defect; now both read this one.
 *
 * Only the synchronous check, by ruling (#672 ③): the platform-authenticator probe answers about a
 * fingerprint reader, and a laptop without one still takes a USB key — an async "cannot" here would
 * turn a working setup into a refusal. Kinds that need nothing from the browser answer true, so a
 * third kind is offerable on day one and narrows itself only when it actually depends on an API.
 */
export function browserCanUseFactorKind(kind: string): boolean {
  if (kind === "passkey") return typeof window !== "undefined" && "PublicKeyCredential" in window;
  return true;
}
