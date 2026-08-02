import { useTranslation } from "react-i18next";
import { AdminEnrollmentSection } from "./AdminEnrollmentSection";
import { AdminSignInMethodsSection } from "./AdminSignInMethodsSection";

// The tenant's ways in (tenant#admin). #589 / ADR-195 addendum reduced this tab to two questions:
// HOW someone signs in (one list of sign-in methods, each row edited in place) and WHO becomes a
// member when they do (the enrolment policy below it).
//
// What used to be here and is not any more: a status card that repeated what each row already says,
// and a single-OIDC form that always wrote the FIRST connection — so a second connection could not
// be edited at all, and editing the first never said which one it was writing.
export function AdminAuthTab() {
  const { t } = useTranslation();
  return (
    <div className="max-w-[560px] p-6" data-testid="admin-auth">
      <h2 className="mt-0">{t("adminAuth.title")}</h2>
      <p className="mt-0 text-sm text-fg-dim">{t("adminAuth.body")}</p>
      {/* Enabling a broken IdP breaks every new login, so a row's editor offers "Test connection"
          and the server re-validates discovery on save (enabling a bad issuer is refused). The
          client secret is write-only — blank keeps the stored one. */}
      <div className="mb-5 rounded-lg border border-l-[3px] border-[color-mix(in_srgb,var(--danger)_40%,var(--border))] border-l-[var(--danger)] px-3 py-2.5 text-xs text-fg-dim" data-testid="oidc-warning">{t("adminAuth.warning")}</div>

      <AdminSignInMethodsSection />

      {/* #101 / ADR-034: auto-enrolment policy for successful logins — a different question (who
          becomes a member), so it stays its own section below the list. */}
      <AdminEnrollmentSection />
    </div>
  );
}
