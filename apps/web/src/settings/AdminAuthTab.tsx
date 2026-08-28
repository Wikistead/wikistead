import { useTranslation } from "react-i18next";
import { AdminEnrollmentSection } from "./AdminEnrollmentSection";
import { AdminSignInMethodsSection } from "./AdminSignInMethodsSection";
import { useLoginMethods } from "../data/queries";
import { SettingsPane } from "./SettingsShell"; // #735: the pane draws the frame AND the heading
import { NoticeBand } from "../ui/NoticeBand";

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
  // The description names the tab's two questions and nothing narrower. It used to read "configure
  // your organization's identity provider (OIDC)", written when OIDC was the only way in; the list
  // below now also carries SAML, password sign-in and platform login, so a method-specific sentence
  // sat above methods it did not describe. Advice that belongs to ONE method belongs in that
  // method's row (the connection editor carries the test-before-enabling line).
  return (
    <SettingsPane width="form" testId="admin-auth" title={t("adminAuth.title")} description={t("adminAuth.body")}>
      {/* True of every row, not just OIDC: turning a method off can take away someone's way in, and
          the session you are holding survives the change so a mistake is recoverable. */}
      <NoticeBand kind="danger" title={t("adminAuth.warningTitle")} testId="sign-in-warning" className="mb-5">
        {t("adminAuth.warning")}
      </NoticeBand>

      <AdminSignInMethodsSection />

      {/* #101 / ADR-034: auto-enrolment policy for successful logins — a different question (who
          becomes a member), so it stays its own section below the list. */}
      {canManageStance && <AdminEnrollmentSection />}
    </SettingsPane>
  );
}
