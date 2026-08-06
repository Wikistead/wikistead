import type React from "react";
import { useTranslation } from "react-i18next";
import { AdminEnrollmentSection } from "./AdminEnrollmentSection";
import { AdminSignInMethodsSection } from "./AdminSignInMethodsSection";
import { useLoginMethods } from "../data/queries";

// The tenant's ways in (tenant#admin). #589 / ADR-195 addendum reduced this tab to two questions:
// HOW someone signs in (one list of sign-in methods, each row edited in place) and WHO becomes a
// member when they do (the enrolment policy below it).
//
// What used to be here and is not any more: a status card that repeated what each row already says,
// and a single-OIDC form that always wrote the FIRST connection — so a second connection could not
// be edited at all, and editing the first never said which one it was writing.
export function AdminAuthTab() {
  const { t } = useTranslation();
  // #604-B: this tab opens to `manage_connections` as well as to the tier. Enrolment answers
  // a DIFFERENT question — who becomes a member when they sign in — and its routes stayed
  // admin-gated, so a connection manager gets the sign-in list (their power) and not a section whose
  // every read would 403. The server names the line; the screen does not infer it.
  const canManageStance = useLoginMethods().data?.canManageStance !== false;
  return (
    <div className="max-w-[560px] p-6" data-testid="admin-auth">
      <h2 className="mt-0">{t("adminAuth.title")}</h2>
      {/* Names the tab's two questions and nothing narrower. It used to read "configure your
          organization's identity provider (OIDC)", written when OIDC was the only way in; the list
          below now also carries SAML, password sign-in and platform login, so a method-specific
          sentence sat above methods it did not describe. Advice that belongs to ONE method belongs
          in that method's row (the connection editor carries the test-before-enabling line). */}
      <p className="mt-0 text-sm text-fg-dim">{t("adminAuth.body")}</p>
      {/* True of every row, not just OIDC: turning a method off can take away someone's way in, and
          the session you are holding survives the change so a mistake is recoverable. */}
      {/* #632 the seventh box with this shape, and the one the original sweep missed — it spells
          its border `border-[color-mix(…)]` rather than `border-border`, so a grep for the other spelling
          never saw it. Same shared class as the other six now. */}
      <div
        className="wks-left-bar mb-5 rounded-lg border border-[color-mix(in_srgb,var(--danger)_40%,var(--border))] px-3 py-2.5 text-xs text-fg-dim"
        style={{ "--wks-left-bar-color": "var(--danger)", "--wks-left-bar-pad": "0.75rem" } as React.CSSProperties}
        data-testid="sign-in-warning"
      >{t("adminAuth.warning")}</div>

      <AdminSignInMethodsSection />

      {/* #101 / ADR-034: auto-enrolment policy for successful logins — a different question (who
          becomes a member), so it stays its own section below the list. */}
      {canManageStance && <AdminEnrollmentSection />}
    </div>
  );
}
