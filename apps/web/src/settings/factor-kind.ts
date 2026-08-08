import type { TFunction } from "i18next";

/**
 * What a second factor is CALLED, given its kind (#653 / #673).
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
