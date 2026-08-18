import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, X } from "lucide-react";
import {
  useAdminConnections, useCreateConnection, useUpdateConnection, useDeleteConnection, useReorderConnections,
  useLoginMethods, useUpdatePlatformLogin, useUpdateLocalLogin, useTenantSaml, useUpdateTenantSaml, useTestTenantOidc,
  useUpdateSsoRequired, useUpdateSecondFactorRequired, useUpdateSecondFactorStance, useStanceImpact,
  useSsoExemptions, useGrantSsoExemption, useRevokeSsoExemption,
  useTenantMemberCandidates, useTenantMemberNames, type FactorStance,
  type AdminConnectionDTO, type LoginMethodState,
} from "../data/queries";
import { ApiError } from "../data/apiClient";
import { Button, IconButton } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import { memberLabel } from "../ui/principal-label"; // #578
import { useProductName } from "../app/product-name"; // #575: the product name is interpolated, never written in copy
import { ConfirmDialog } from "../ui/dialogs";
import { notify } from "../ui/toast";
import { MemberSearchInput } from "../ui/MemberSearchInput"; // #617 ①: the one pick-a-member surface (#416 / ADR-161)
import { AdminSamlSection, samlSectionState } from "./AdminSamlSection";
import { methodBadge } from "./login-method-badge";

// #589 / ADR-195 addendum: ONE list of sign-in methods. A row is one way in — each OIDC connection,
// SAML, and platform login — and every row is edited IN PLACE. What this replaces
//
// - a "Login methods" status card that repeated the state each row already carries,
// - a legacy single-OIDC form that always wrote `ORDER BY sort, id LIMIT 1`, so the SECOND
// connection could not be edited at all and the FIRST was edited without saying so,
// - flags (groups claim, group trust — and bootstrap eligibility, until #616 retired the
// mechanism it gated) that only creation could set.
//
// In-row expansion rather than a side panel, deliberately: this list exists because editing lived in
// two places, and a panel would be the third. `enabled` (what the tenant chose) and `effective` (what
// actually answers a login) are different facts and get different badges — a connection whose secret
// cannot be decrypted is enabled and not effective, and saying only one of them hides that.

// A blank editor form for a connection row.
interface Draft {
  issuer: string; clientId: string; clientSecret: string; scopes: string
  groupsClaim: string; label: string; trustGroups: boolean
}
const draftOf = (c: AdminConnectionDTO): Draft => ({
  issuer: c.issuer, clientId: c.clientId, clientSecret: "",
  scopes: c.scopes ?? "", groupsClaim: c.groupsClaim ?? "", label: c.label ?? "",
  // review F6: the two trust flags are part of the DRAFT, not immediate switches. An editor where
  // some controls apply on Save and others apply on touch has a Cancel button that silently means
  // "cancel some of it" — and these two are the ones an admin is most likely to toggle while
  // deciding.
  trustGroups: c.trustGroups,
});

// The row's name: the brand for a preset, else the admin's label, else the issuer's host.
export function connectionName(c: Pick<AdminConnectionDTO, "preset" | "label" | "issuer">): string {
  if (c.preset === "google") return "Google";
  if (c.preset === "microsoft") return "Microsoft";
  // defensive: the server refuses non-URL issuers at write (S4 review F1), but a render helper must
  // never white-screen the settings page over one bad row
  try { return c.label || new URL(c.issuer).host; } catch { return c.label || c.issuer; }
}

// #589 bounce: every method is a row, so every row is built from ONE class. The reject was that they
// and three hand-written class strings is how that happens. `data-method-row` marks them so a pin can
// walk the list instead of naming the methods it knows about: a fifth method is measured by existing.
// #679 / ADR-222 §1: the kind-stances, in the order they are offered. `off` is not among them — it is
// the switch above, not a kind. One list, so the picker and the refusal lines below it cannot come to
// offer different sets (#672).
const STANCE_CHOICES = ["any", "passkey", "totp"] as const;
const STANCE_LABEL: Record<(typeof STANCE_CHOICES)[number], string> = {
  any: "adminAuth.stanceAny",
  passkey: "adminAuth.stancePasskey",
  totp: "adminAuth.stanceTotp",
};

/**
 * #683: what each stance confirmation SAYS, as one entry per direction.
 *
 * The heading used to be the switch's name, fixed, while only the body followed the direction — so
 * turning two-factor OFF opened a dialog headed "Require two-factor authentication" above a body ending
 * "Stop requiring two-factor authentication?". A heading is the first line read, and #674 put a
 * confirmation on the OFF direction precisely because it lowers the tenant's security; a heading that
 * reads as raising it undoes the confirmation before the body is reached.
 *
 * Kept as a table so that a heading cannot exist without the body it belongs to. Two ternaries reading
 * the same flag is exactly the shape that drifted: one of them was written without the flag, and
 * nothing about the code said the two answers had to agree. Adding a third stance means adding a row
 * here, and a row with a missing half does not compile.
 */
export const STANCE_COPY: Record<"factor" | "sso", Record<"on" | "off", { title: string; message: string }>> = {
  factor: {
    on: { title: "adminAuth.secondFactorEnableTitle", message: "adminAuth.secondFactorEnableConfirm" },
    off: { title: "adminAuth.secondFactorDisableTitle", message: "adminAuth.secondFactorDisableConfirm" },
  },
  sso: {
    on: { title: "adminAuth.ssoRequiredEnableTitle", message: "adminAuth.ssoRequiredEnableConfirm" },
    off: { title: "adminAuth.ssoRequiredDisableTitle", message: "adminAuth.ssoRequiredDisableConfirm" },
  },
};

/**
 * EVERY confirmation on this screen that carries a heading, and where its heading comes from.
 *
 * #683 (review rejection): the first fix put the two stance switches in `STANCE_COPY` and left the
 * kind picker's confirmation out — it still headed itself with the SWITCH'S LABEL ("Require two-factor
 * authentication") above a body asking whether to change which factors count. The requirement was
 * already on; nothing was being required. And the pin walked `STANCE_COPY`, so the one dialog outside
 * that table was the one dialog it could not see. This ticket's own acceptance note had said not to
 * write a pin that enumerates, "because a third stance will arrive" — and one had.
 *
 * So the table is now about CONFIRMATIONS rather than about stances, and the sweep is anchored to the
 * FILE: every `<ConfirmDialog` in it must be accounted for here or listed below with a reason. A fourth
 * dialog cannot be silently outside it, which is the failure this entry exists to close.
 *
 * `message` is the sentence the heading has to agree with. For the pickers that is the closing question
 * (`stanceConfirmTail`); the count and the passkey warning that precede it are context, not the ask.
 */
export const CONFIRM_COPY: Record<string, { title: string; message: string }> = {
  "factor/on": STANCE_COPY.factor.on,
  "factor/off": STANCE_COPY.factor.off,
  "sso/on": STANCE_COPY.sso.on,
  "sso/off": STANCE_COPY.sso.off,
  kinds: { title: "adminAuth.stanceKindsTitle", message: "adminAuth.stanceConfirmTail" },
};

/**
 * Confirmations here that carry NO heading, and why that is not the #683 defect.
 *
 * A heading can only contradict a body if there is one, so these are outside the family rather than
 * exceptions to it. Named so the count below is exact: "some dialogs have no title" is the sentence a
 * missing fifth would hide behind.
 */
export const HEADLESS_CONFIRMS = ["sso-exemption-revoke-confirm"] as const;

const METHOD_ROW = "flex flex-col gap-1.5 rounded-md border border-border bg-panel px-3 py-2 text-sm";
const METHOD_ROW_HEAD = "flex items-center gap-2";

export function AdminSignInMethodsSection() {
  const { t } = useTranslation();
  // #733: the ONE redirect URI the login flow actually uses. Derived from the current origin exactly
  // as the server derives it per request (`${protocol}://${host}/auth/callback`), which is also why a
  // stored value would be wrong: a workspace that moves to a custom domain keeps working here and
  // would not with a value frozen at configuration time.
  const productName = useProductName();
  const oidcRedirectUri = `${window.location.origin.replace(/\/$/, "")}/auth/callback`;
  const connections = useAdminConnections();
  const create = useCreateConnection();
  const update = useUpdateConnection();
  const remove = useDeleteConnection();
  const reorder = useReorderConnections();
  const methods = useLoginMethods();
  // #604-B: the READ of this screen opened to `manage_connections`; the stance / platform /
  // password selections and the SSO exemptions stayed on the admin tier. The server names that line
  // (`canManageStance`) so the screen shows a connection manager the state of every method — which is
  // what makes their own connections legible — without offering switches that would 403, and without
  // firing the admin-tier reads at all. A server that does not send the field (older build) answers
  // as before. Undefined-safe on purpose: `!== false`, not `?? true` on a possibly-missing query.
  const canManageStance = methods.data?.canManageStance !== false;
  const platform = useUpdatePlatformLogin();
  const localLogin = useUpdateLocalLogin();
  const saml = useTenantSaml(canManageStance);
  const updateSaml = useUpdateTenantSaml();
  const test = useTestTenantOidc();

  const ssoRequired = useUpdateSsoRequired();
  const secondFactorRequired = useUpdateSecondFactorRequired();
  const secondFactorStance = useUpdateSecondFactorStance();
  // #679: which kinds is a SECOND question, asked only once something is required. Nested under the
  // switch rather than a fifth value inside it: "off" is not a kind, and a picker that carried it would
  // make turning the requirement off look like choosing a flavour of having it.
  const [pickingStance, setPickingStance] = useState<FactorStance | null>(null);
  const exemptions = useSsoExemptions(canManageStance);
  const grantExemption = useGrantSsoExemption();
  const revokeExemption = useRevokeSsoExemption();
  const [exemptQuery, setExemptQuery] = useState("");
  const exemptCandidates = useTenantMemberCandidates(exemptQuery, canManageStance);
  // #617 ②(a): a sub is a 70-character hex string, not a name. The exemption rows and the revoke
  // confirmation both showed it raw — #523 / ADR-190 canonicalised display names precisely so that
  // people surfaces stop doing this. One resolver, used by both, falling back to the sub only when the
  // member genuinely has no name yet (the same rule MemberSearchInput's rows follow).
  const memberNames = useTenantMemberNames(canManageStance);
  // #578: `|| sub` printed the 70-character hex when the member had no resolvable name. Same answer as
  // the space and page surfaces now — one wording, shared, so these four cannot drift apart again.
  const nameOf = (sub: string): string => memberLabel(sub, memberNames.get(sub), t("spaceMembers.unknownMember"));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; error: string | null } | null>(null);
  const [adding, setAdding] = useState(false);
  const [preset, setPreset] = useState("");
  const [form, setForm] = useState({ issuer: "", clientId: "", clientSecret: "", label: "", entraTenantId: "", groupsClaim: "" });
  const [flags, setFlags] = useState({ trustGroups: false });
  const [deleting, setDeleting] = useState<AdminConnectionDTO | null>(null);
  // #504: revoking an exemption removes somebody's break-glass — confirm first, like every removal here
  const [revokingExemption, setRevokingExemption] = useState<string | null>(null);
  // #674: a STANCE change asks first — in both directions, and for both stances.
  //
  // #652 shipped the question on the ON direction only, reasoning from the sign-out it causes. That
  // reasoning was one-sided: turning the requirement OFF lowers the bar for the whole tenant and
  // cannot be undone for whoever signs in meanwhile, which is exactly what #504 says to confirm. The
  // SSO stance beside it asked in neither direction, and it decides which doors exist at all.
  //
  // Confirming is not refusing: the escape route stays open (a tenant whose last enrolled admin left
  // can still lift the requirement — `canEnable` gates only the ON direction).
  const [confirming, setConfirming] = useState<{ stance: "factor" | "sso"; to: boolean } | null>(null);

  const rows = connections.data ?? [];
  // #652 the write-time refusals the server can still raise even when the row looked writable
  // (the last enrolled admin cleared their factor between the read and the click). Reported with the
  // sentence that names the fix, not a generic failure.
  //
  // #672 (review rejection/): ONE mapping, read both by the toast below and by the reason
  // printed under the picker, because they are the same sentence said at two moments. The screen used
  // to answer `admin_factor_required` with the ON/OFF switch's wording whatever had been asked for, so
  // an admin who already held a factor was told to enrol one and never learnt the real requirement
  // two passkeys. The server names each floor now; anything unmapped stays the generic failure rather
  // than borrowing a neighbour's sentence.
  //
  // #685: the passkey floor arrives as a NUMBER (`stanceFloors`, straight from the server's `floorFor`)
  // and the sentence interpolates it. It used to be spelled out in both locales, so the ruling sat in
  // three places at once and moving the floor meant finding all of them.
  //
  // Deliberately WITHOUT a client-side default. A `?? 2` here would read as belt-and-braces and would
  // in fact be a fourth copy of the ruling — the exact thing this ticket exists to remove — and it
  // would keep printing the old figure long after the constant moved. That the server sends it is a
  // guarded fact (`stance-floor-685`), not a hope.
  const floors = methods.data?.secondFactorRequired?.stanceFloors;
  const refusalText = (code: string | undefined): string | null =>
    code === "admin_factor_required" ? t("adminAuth.secondFactorNoAdmin")
    : code === "admin_passkey_floor" ? t("adminAuth.passkeyFloorUnmet", { count: floors?.passkey })
    : code === "admin_totp_floor" ? t("adminAuth.totpFloorUnmet")
    : code === "passkey_needs_second_member" ? t("adminAuth.passkeyNeedsSecondMember")
    : code === "stance_unreachable" ? t("adminAuth.stanceUnreachable")
    : code === "mfa_policy_not_entitled" ? t("adminAuth.method_unentitled")
    : null;
  const stanceError = (e: unknown) => {
    notify.error(refusalText(e instanceof ApiError ? e.code : undefined) ?? t("adminAuth.methodsSaveFailed"));
  };
  const saveStance = (kinds: FactorStance) => secondFactorStance.mutate(kinds, {
    onSuccess: () => notify.success(t("toast.saved")),
    onError: stanceError,
  });
  const saveFactorPolicy = (on: boolean) => secondFactorRequired.mutate(on, {
    onSuccess: () => notify.success(t("toast.saved")),
    onError: stanceError,
  });
  const saveSsoStance = (on: boolean) => ssoRequired.mutate(on, {
    onSuccess: () => notify.success(t("toast.saved")),
    onError: (e) => {
      const code = e instanceof ApiError ? e.code : undefined;
      notify.error(
        code === "own_idp_required" ? t("adminAuth.ssoNeedsIdp")
        : code === "sso_exemption_required" ? t("adminAuth.ssoNeedsExemption")
        : t("adminAuth.methodsSaveFailed"),
      );
    },
  });
  /** What the question says, per stance and direction. Four sentences, none of them "are you sure". */
  // #683: the HEADING follows the direction too.
  //
  // It used to be the switch's NAME, fixed — so turning two-factor OFF opened a dialog headed "Require
  // two-factor authentication" above a body ending "Stop requiring two-factor authentication?". The
  // heading is the first thing read in a dialog, and #674 put a confirmation on the OFF direction
  // precisely because it lowers the tenant's security; a heading that reads as raising it undoes that
  // in one line.
  //
  // Heading and body are looked up TOGETHER, as one entry chosen by the direction, so they cannot come
  // from different questions. Two ternaries reading the same flag is what drifted: one of them was
  // written without it. Spelled out rather than built from a stem — `t(`${stem}${way}Title`)` hides the
  // keys from #645's orphan sweep, which would then read all four as dead.
  const stanceQuestion = (c: { stance: "factor" | "sso"; to: boolean }) => {
    const said = CONFIRM_COPY[`${c.stance}/${c.to ? "on" : "off"}`]!;
    return { title: t(said.title), message: t(said.message) };
  };
  const m = methods.data?.methods;
  const onError = (e: unknown) => {
    // the server names the refusal by CODE — never sniff English message text. review F7: an
    // unreachable issuer is the failure an admin hits most while editing a connection, and the
    // legacy form said so; "Something went wrong" would send them looking anywhere but at the
    // issuer they just typed.
    const code = (e as { code?: string })?.code;
    notify.error(
      code === "login_lockout" ? t("adminConnections.lockoutRefused")
      : code === "oidc_unreachable" ? t("adminAuth.saveFailed")
      : code === "connection_limit_reached" ? t("adminConnections.limitReached", { count: methods.data?.oidcConnectionCap })
      : t("toast.actionFailed"),
    );
  };
  const move = (idx: number, dir: -1 | 1) => {
    const ids = rows.map((r) => r.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j]!, ids[idx]!];
    reorder.mutate(ids, { onError });
  };
  const openEditor = (c: AdminConnectionDTO) => {
    if (expanded === c.id) { setExpanded(null); return; }
    setExpanded(c.id); setDraft(draftOf(c)); setTestResult(null);
  };
  const saveRow = (c: AdminConnectionDTO) => {
    if (!draft) return;
    update.mutate(
      {
        id: c.id,
        // A preset connection owns its issuer and refuses a label (the brand is not an admin string
        // that reaches the anonymous login screen) — the editor does not offer either field, so it
        // must not send them. For a preset-less row the label is sent even when EMPTY: the server
        // reads as "clear it", and omitting it would make a cleared label silently keep the old
        // one (a field the admin can set but never unset).
        ...(c.preset ? {} : { issuer: draft.issuer, label: draft.label }),
        clientId: draft.clientId,
        ...(draft.clientSecret ? { clientSecret: draft.clientSecret } : {}),
        scopes: draft.scopes,
        groupsClaim: draft.groupsClaim.trim() || null,
        trustGroups: draft.trustGroups,
      },
      {
        onSuccess: () => { notify.success(t("toast.saved")); setDraft({ ...draft, clientSecret: "" }); },
        onError,
      },
    );
  };
  const onTest = (issuer: string) => {
    setTestResult(null);
    test.mutate(issuer.trim(), {
      onSuccess: (r) => setTestResult(r),
      onError: () => setTestResult({ ok: false, error: t("adminAuth.testFail") }),
    });
  };
  const submitNew = () => {
    const base =
      preset === "google" ? { preset, clientId: form.clientId, clientSecret: form.clientSecret || undefined }
      : preset === "microsoft" ? { preset, clientId: form.clientId, clientSecret: form.clientSecret || undefined, entraTenantId: form.entraTenantId }
      : { issuer: form.issuer, clientId: form.clientId, clientSecret: form.clientSecret || undefined, label: form.label || undefined };
    // ADR-197 §2 rev2 / §6: the two TRUST flags are explicit and default off. They are editable on the
    // row now (#589), but a connection still starts without either.
    // #615: the claim name travels with the flags — blank stays null so the server's default (`groups`)
    // keeps deciding, exactly as it did when this could only be set after the fact.
    create.mutate({ ...base, trustGroups: flags.trustGroups, groupsClaim: form.groupsClaim.trim() || null }, {
      onSuccess: () => { setAdding(false); setForm({ issuer: "", clientId: "", clientSecret: "", label: "", entraTenantId: "", groupsClaim: "" }); notify.success(t("adminConnections.created")); },
      onError,
    });
  };
  const onTogglePlatform = (on: boolean) => {
    platform.mutate(on, {
      onSuccess: () => notify.success(t("toast.saved")),
      onError: (e) => {
        const code = e instanceof ApiError ? e.code : undefined;
        notify.error(code === "own_idp_required" ? t("adminAuth.platformOwnIdpRequired") : t("adminAuth.methodsSaveFailed"));
      },
    });
  };

  // Two badges, because they are two facts — and the first one must not borrow the second's word.
  // The SELECTION badge says what the tenant chose (`Selected` / `Not selected`), never "Active"
  // a connection whose secret cannot be decrypted is selected and NOT active, and calling that
  // "Active" in green is the lie the two badges exist to prevent. The second badge appears only when
  // something CONTRADICTS the selection — deployment policy, the plan, or a configuration that
  // cannot answer a login — and green is reserved for a row that is genuinely working.
  //
  // `method` is the aggregate state for the METHOD; for a row it can only be trusted about
  // method-wide facts (policy, entitlement). Whether THIS row is off is the row's own `enabled`.
  // #605 (review rejection, 2026-08-05): ONE reason, not three. The stance badge was rendered by the row
  // itself, so this function could not know a reason was already on screen and added its own: a
  // blocked local row said "SSO " and and side by side
  // the same fact three times, in the width the description needed. ADR-195 §1 asks for two facts (the
  // selection is preserved; here is why it does not bite), so the reason comes in here and the row
  // renders nothing beside it. #589 removed this exact doubling once; the stance brought it back.
  const stateBadges = (
    enabled: boolean,
    method?: LoginMethodState & { entitled?: boolean },
    working?: boolean,
    /** a reason the ROW knows and this function cannot derive (today: the SSO stance) */
    rowReason?: { label: string; testId: string },
  ) => {
    const badge = method ? methodBadge(method) : undefined;
    const blocked = enabled && badge && (badge === "byPolicy" || badge === "unentitled") ? badge : null;
    const reason = rowReason ?? (blocked ? { label: t(`adminAuth.method_${blocked}`), testId: "sign-in-method-blocked" } : null);
    // "selected but nothing is working" — only claimable when the method-wide answer is knowable
    // and NO more specific reason applies (a reason already says this, better).
    const notWorking = enabled && !reason && working === false;
    return (
      <span className="flex flex-none items-center gap-2">
        {/* #605 (review rejection, 2026-08-05): "SSO". Both facts were
            the same 11px grey, so the row read as ON with a footnote. The REASON is the headline — it gets
            a bordered warning badge — and the selection state steps back to a plain label when a reason is
            present. The row itself is NOT dimmed (the ruling is explicit): the setting is still there, it
            just does not bite right now. */}
        <span
          className={enabled && working !== false && !reason ? "text-xs text-[#2da44e]" : "text-xs text-fg-dim"}
          data-testid="sign-in-method-state"
        >
          {t(enabled ? "signInMethods.selectionOn" : "signInMethods.selectionOff")}
        </span>
        {reason && (
          <span
            className="rounded border border-[var(--callout-warning)] bg-panel-2 px-1.5 py-px text-xs font-medium text-[var(--callout-warning)]"
            data-testid={reason.testId}
          >
            {reason.label}
          </span>
        )}
        {notWorking && (
          <span className="text-xs text-fg-dim" data-testid="sign-in-method-blocked">{t("signInMethods.notWorking")}</span>
        )}
      </span>
    );
  };

  const samlState = samlSectionState(saml);
  // review F1 / ADR-195 §1: "the deployment has not configured it" and "the deployment's policy
  // excludes it" are different answers. The first has nothing to show; the second has something and
  // is refusing it, and dropping THAT row is the silent disappearance §1 forbids — so the row stays
  // and its badge says why, with the toggle withheld (there is nothing a tenant can decide).
  const showPlatform = !!m && m["platform-oidc"].configured;

  return (
    <div data-testid="sign-in-methods">
      <h3 className="mt-0 text-sm font-medium">{t("signInMethods.title")}</h3>
      <p className="mt-0 mb-3 text-xs text-fg-dim">{t("signInMethods.body")}</p>

      <div className="flex flex-col gap-1.5" data-testid="sign-in-methods-list">
        {rows.map((c, i) => (
          <div key={c.id} className={METHOD_ROW} data-method-row data-testid={`admin-connection-${c.id}`}>
            <div className={METHOD_ROW_HEAD}>
              <IconButton aria-label={t("signInMethods.edit")} data-testid={`admin-connection-edit-${c.id}`} onClick={() => openEditor(c)}>
                {expanded === c.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </IconButton>
              {/* A long issuer used to wrap under the row's buttons. It is one line, clipped: the
                  full value is in the editor a click away. */}
              <div className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="flex-none font-medium">{connectionName(c)}</span>
                {/* #605: `data-clip` marks a deliberate one-liner. A VALUE (an issuer URL) may be
                    clipped — the whole of it is in the editor a click away — and the pin that walks
                    these rows for cut-off text uses this mark to tell that apart from a sentence
                    somebody let run out of room. */}
                <span className="min-w-0 truncate text-xs text-fg-dim" data-clip="value" data-testid={`admin-connection-issuer-${c.id}`}>
                  {c.preset ? t("adminConnections.presetBadge", { preset: c.preset }) : c.issuer}
                </span>
              </div>
              {/* review F3: the aggregate's `selected` is the FIRST row's enabled flag, so it cannot
                  speak for this row. Pass only what is method-wide — the ceiling and the plan — and
                  let the row's own switch answer "is this one on". */}
              {stateBadges(c.enabled, m && { ...m["tenant-oidc"], selected: c.enabled })}
              {/* Order IS the login screen's order, so it only means something with more than one row. */}
              {rows.length > 1 && (
                <>
                  <IconButton aria-label={t("adminConnections.moveUp")} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></IconButton>
                  <IconButton aria-label={t("adminConnections.moveDown")} disabled={i === rows.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></IconButton>
                </>
              )}
              {/* #504: red at rest + confirm — a deleted connection's minted identities never reconnect */}
              <IconButton aria-label={t("adminConnections.delete")} variant="danger" data-testid={`admin-connection-delete-${c.id}`}
                onClick={() => setDeleting(c)}><X size={14} /></IconButton>
              {/* #589 bounce ①: the method's on/off sits at the END of the head line — the same place on
                  every row. It used to hang under the row in a stack of two switches, which is why
                  turning a connection on looked like a different act from turning password sign-in on. */}
              <Switch checked={c.enabled} ariaLabel={t("adminConnections.enabled")} testId={`admin-connection-enabled-${c.id}`}
                onChange={(on: boolean) => update.mutate({ id: c.id, enabled: on }, { onError })} />
            </div>
            {/* #592 / ADR-204: MCP access, per connection — in the row, not on a screen of its own. The
                server is the wall (a member of a switched-off connection is refused at the MCP entry
                even holding a valid token); this is the place to say so. A connection that does not
                namespace its subs cannot be recognised there, so its switch is unavailable with the
                reason next to it rather than settable and inert. */}
            <label className="flex w-fit items-center gap-2 text-xs text-fg-dim">
              <Switch checked={c.mcpEnabled} disabled={!c.mcpEnforceable} ariaLabel={t("adminConnections.mcpEnabled")}
                testId={`admin-connection-mcp-${c.id}`}
                onChange={(on: boolean) => update.mutate({ id: c.id, mcpEnabled: on }, { onError })} />
              {t("adminConnections.mcpEnabled")}
              {!c.mcpEnforceable && <span data-testid={`admin-connection-mcp-note-${c.id}`}>{t("adminConnections.mcpUnavailable")}</span>}
            </label>

            {expanded === c.id && draft && (
              <div className="mt-1 flex flex-col gap-2 border-t border-border pt-2" data-testid={`admin-connection-editor-${c.id}`}>
                {/* A preset owns its issuer and refuses a label — offering either would be a field the
                    server rejects. */}
                {!c.preset && (
                  <>
                    <label className="flex flex-col gap-1 text-xs text-fg-dim">
                      {t("adminAuth.issuer")}
                      <Input inputSize="sm" value={draft.issuer} data-testid="oidc-issuer"
                        onChange={(e) => setDraft({ ...draft, issuer: e.target.value })} />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-fg-dim">
                      {t("adminConnections.labelPlaceholder")}
                      <Input inputSize="sm" value={draft.label} data-testid="oidc-label"
                        onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
                    </label>
                  </>
                )}
                <label className="flex flex-col gap-1 text-xs text-fg-dim">
                  {t("adminAuth.clientId")}
                  <Input inputSize="sm" value={draft.clientId} data-testid="oidc-client-id"
                    onChange={(e) => setDraft({ ...draft, clientId: e.target.value })} />
                </label>
                <label className="flex flex-col gap-1 text-xs text-fg-dim">
                  {t("adminAuth.clientSecret")}
                  <Input inputSize="sm" type="password" value={draft.clientSecret} data-testid="oidc-client-secret"
                    placeholder={c.hasSecret ? t("adminAuth.clientSecretKeep") : ""}
                    onChange={(e) => setDraft({ ...draft, clientSecret: e.target.value })} />
                </label>
                <label className="flex flex-col gap-1 text-xs text-fg-dim">
                  {t("adminAuth.scopes")}
                  <Input inputSize="sm" value={draft.scopes} data-testid="oidc-scopes"
                    onChange={(e) => setDraft({ ...draft, scopes: e.target.value })} />
                </label>
                {/* #733: the redirect URI is SHOWN, not asked for. The login flow derives it from the
                    request, so the field this replaced wrote a column nothing reads — an administrator
                    who typed a different value was told nothing here and failed at the IdP. Same shape
                    as the SAML ACS hint and the SCIM endpoint (#723): derived from the origin,
                    select-all, copyable. */}
                <p className="flex flex-col gap-1 text-xs text-fg-dim">
                  {t("adminAuth.oidcRedirectHint", { product: productName })}
                  <code className="select-all" data-testid="oidc-redirect">{oidcRedirectUri}</code>
                </p>
                {/* #102 / ADR-055: the id_token claim that carries the user's groups (blank → 'groups'). */}
                <label className="flex flex-col gap-1 text-xs text-fg-dim">
                  {t("adminAuth.groupsClaim")}
                  <Input inputSize="sm" value={draft.groupsClaim} placeholder="groups" data-testid="oidc-groups-claim"
                    onChange={(e) => setDraft({ ...draft, groupsClaim: e.target.value })} />
                </label>
                {/* ADR-197 §6 / #554 S6: whether the connection's groups are trusted. Creation-only
                    until now, which left a connection permanently unable to sync groups — the flag an
                    admin most needs to change was the one they could not.
                    #616: this said "these two" and named a bootstrap flag as the second. That
                    mechanism is retired and its switch is gone; a comment that still counts it makes
                    the next reader look for a control that is not there. */}
                <label className="flex w-fit items-center gap-2 text-xs text-fg-dim">
                  <Switch checked={draft.trustGroups} ariaLabel={t("adminConnections.trustGroups")} testId={`admin-connection-trust-groups-${c.id}`}
                    onChange={(on: boolean) => setDraft({ ...draft, trustGroups: on })} />
                  {t("adminConnections.trustGroups")}
                </label>
                {testResult && (
                  <div className={testResult.ok ? "text-xs text-[#2da44e]" : "text-xs text-destructive"} data-testid="oidc-test-result">
                    {testResult.ok ? t("adminAuth.testOk") : (testResult.error ?? t("adminAuth.testFail"))}
                  </div>
                )}
                {/* This advice used to sit above the whole tab, from when OIDC was the only way in.
                    It is about an issuer, so it belongs next to the issuer: the server re-validates
                    discovery whenever an enabled row is saved, and refuses one it cannot reach. */}
                <p className="mt-0 mb-0 text-xs text-fg-dim" data-testid={`admin-connection-verify-${c.id}`}>
                  {t("adminConnections.verifyBeforeEnable")}
                </p>
                <div className="flex gap-2">
                  {/* The only connection-test path in the product (POST /admin/oidc/test): it validates
                      an issuer's discovery document, so it serves any row. */}
                  <Button variant="default" size="sm" data-testid="oidc-test" disabled={test.isPending || !(c.preset ? c.issuer : draft.issuer).trim()}
                    onClick={() => onTest(c.preset ? c.issuer : draft.issuer)}>
                    {test.isPending ? t("adminAuth.testing") : t("adminAuth.test")}
                  </Button>
                  <Button variant="primary" size="sm" data-testid="oidc-save" disabled={update.isPending} onClick={() => saveRow(c)}>
                    {t("common.save")}
                  </Button>
                  <Button variant="default" size="sm" onClick={() => setExpanded(null)}>{t("common.cancel")}</Button>
                </div>
              </div>
            )}
          </div>
        ))}

        {/* SAML is a way in like any other, so it is a row. CE has no SAML at all (the routes live in
            the EE package and answer 404) and gets NO row — a build that cannot offer a feature does
            not advertise it. An unentitled EE plan keeps its row, carrying the upgrade notice. */}
        {/* review F5: `samlSectionState` reads a NOT-YET-ANSWERED query as "form", so drawing on it
            flashed a SAML row on CE — the one build that must never show one. Wait for the answer. */}
        {canManageStance && !saml.isPending && samlState.kind !== "hidden" && (
          <div className={METHOD_ROW} data-method-row data-testid="sign-in-method-saml">
            <div className={METHOD_ROW_HEAD}>
              <IconButton aria-label={t("signInMethods.edit")} data-testid="sign-in-method-saml-edit" onClick={() => setExpanded(expanded === "saml" ? null : "saml")}>
                {expanded === "saml" ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </IconButton>
              {/* #589 bounce ③: the closed row carries the same information every other row does
                  what it is, and where it stands. It used to be a name and a badge, so a reader could
                  not tell a configured SAML from an untouched one without opening it. */}
              <div className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="flex-none font-medium">{t("adminAuth.methodSaml")}</span>
                <span className="min-w-0 truncate text-xs text-fg-dim" data-clip="value" data-testid="sign-in-method-saml-detail">
                  {samlState.kind === "form" && samlState.data?.ssoUrl ? samlState.data.ssoUrl : t("adminAuth.samlNotConfigured")}
                </span>
              </div>
              {/* review F4: an unentitled tenant's row must READ as unentitled without being opened
                  the upgrade notice lives in the expansion, and a row that says only "Not selected"
                  hides the reason (ADR-072: an entitlement loss on an admin surface is named). */}
              {samlState.kind === "locked"
                ? <span className="text-xs text-fg-dim" data-testid="sign-in-method-blocked">{t("adminAuth.method_unentitled")}</span>
                : stateBadges(samlState.kind === "form" && !!samlState.data?.enabled, m?.saml, m?.saml.effective)}
              {/* #589 bounce ①: SAML switches on from the ROW, like every other method. It used to be
                  reachable only by expanding and saving, so "turn this on" was a different act here
                  than three rows above. It stays unavailable until the IdP details exist — a method
                  that cannot work is not something to offer as a switch (the server refuses it too). */}
              {samlState.kind === "form" && (
                <Switch
                  checked={!!samlState.data?.enabled}
                  disabled={!samlState.data?.ssoUrl || updateSaml.isPending}
                  ariaLabel={t("adminAuth.methodSaml")}
                  testId="sign-in-method-saml-toggle"
                  onChange={(on: boolean) => updateSaml.mutate({ enabled: on } as never, {
                    onSuccess: () => notify.success(t("toast.saved")),
                    onError: () => notify.error(t("adminAuth.saveFailed")),
                  })}
                />
              )}
            </div>
            {expanded === "saml" && <AdminSamlSection />}
          </div>
        )}

        {/* #568 / ADR-198 §3: password sign-in — the fifth row ADR-195's addendum reserved a seat for.
            Nothing to configure, so the row is its switch and one line saying what it means. Turning
            it off is refused when it is the only way in (the server answers 409 login_lockout, the
            same rule every other method obeys). */}
        {m && m.local.inCeiling && (
          <div className={METHOD_ROW} data-method-row data-testid="sign-in-method-local">
            <div className={METHOD_ROW_HEAD}>
            <div className="min-w-0 flex-1">
              <div className="font-medium">{t("adminAuth.methodLocal")}</div>
              {/* #605 (review rejection): NOT truncated. This is the only row carrying a description, and
                  a single line for it inside a 512px row meant the sentence was cut at "…"
                  even with nothing else on the row — before the stance badges took a third of the
                  width away. A row may be two lines tall; a sentence that stops mid-word is not a
                  sentence. */}
              <div className="text-xs text-fg-dim">{t("adminAuth.localBody")}</div>
            </div>
            {/* ADR-195 §1: the selection is preserved and the row SAYS why it is off — through the
                shared badges, so the reason cannot be doubled by a second one rendered here. */}
            {stateBadges(m.local.selected, m.local, m.local.effective,
              m.local.blockedByStance ? { label: t("adminAuth.blockedByStance"), testId: "blocked-by-stance" } : undefined)}
            {/* #605 (review rejection): an accent-green track reads as "this is on and working" — the one thing
                the row must not say while the stance holds it shut. The track goes grey; the KNOB stays
                right, because ADR-195 §1's promise is that the selection is preserved, and the switch stays
                PRESSABLE (not disabled) so the setting can still be changed. */}
            <Switch checked={m.local.selected} testId="local-login-toggle" ariaLabel={t("adminAuth.methodLocal")}
              className={m.local.blockedByStance ? "data-[state=checked]:bg-[var(--panel-3)]" : undefined}
              disabled={!canManageStance}
              onChange={(on: boolean) => localLogin.mutate(on, {
                onSuccess: () => notify.success(t("toast.saved")),
                onError: (e) => {
                  const code = e instanceof ApiError ? e.code : undefined;
                  notify.error(code === "login_lockout" ? t("adminConnections.lockoutRefused") : t("adminAuth.methodsSaveFailed"));
                },
              })} />
            </div>
          </div>
        )}

        {/* Platform login: a row with nothing to configure — it is deployed or it is not. Absent when
            this deployment has no platform IdP, or the ceiling excludes it. */}
        {showPlatform && m && (
          <div className={METHOD_ROW} data-method-row data-testid="sign-in-method-platform">
            <div className={METHOD_ROW_HEAD}>
              <div className="min-w-0 flex-1 font-medium">{t("adminAuth.methodPlatformOidc")}</div>
              {stateBadges(m["platform-oidc"].selected, m["platform-oidc"], m["platform-oidc"].effective,
                m["platform-oidc"].blockedByStance ? { label: t("adminAuth.blockedByStance"), testId: "blocked-by-stance" } : undefined)}
              {m["platform-oidc"].inCeiling && (
                <Switch checked={m["platform-oidc"].selected} onChange={onTogglePlatform} testId="platform-login-toggle"
                  className={m["platform-oidc"].blockedByStance ? "data-[state=checked]:bg-[var(--panel-3)]" : undefined}
                  disabled={!canManageStance} ariaLabel={t("adminAuth.methodPlatformOidc")} />
              )}
            </div>
          </div>
        )}

        {/* #605 / ADR-210: the STANCE — one switch about ALL the other doors. Its copy says "this is
            about signing in" (§7: API keys, share links and SCIM are untouched, and a tenant who turns
            this on may well believe otherwise). selected-but-not-biting is the LAPSE and is shown
            (ADR-195 §1); the exemptions live inside the row because naming one is a PRECONDITION of
            turning the switch on (§R5-4). */}
        {m && (
          <div className={METHOD_ROW} data-method-row data-testid="sign-in-method-sso-required">
            <div className={METHOD_ROW_HEAD}>
              <div className="min-w-0 flex-1">
                <div className="font-medium">{t("adminAuth.ssoRequired")}</div>
                <div className="text-xs text-fg-dim">{t("adminAuth.ssoRequiredBody")}</div>
              </div>
              {methods.data?.ssoRequired?.selected && !methods.data.ssoRequired.biting && (
                <span className="rounded bg-panel-2 px-1.5 py-px text-[10px] uppercase tracking-wide text-[var(--warning,#b45309)]" data-testid="sso-required-lapsed" data-tip={t("adminAuth.ssoRequiredLapsedTip")}>{t("adminAuth.ssoRequiredLapsed")}</span>
              )}
              <Switch checked={!!methods.data?.ssoRequired?.selected} testId="sso-required-toggle" ariaLabel={t("adminAuth.ssoRequired")}
                disabled={!canManageStance}
                onChange={(on: boolean) => setConfirming({ stance: "sso", to: on })} />
            </div>
            {canManageStance && (
            <div className="flex flex-col gap-1 border-t border-border pt-1.5" data-testid="sso-exemptions">
              <div className="text-xs text-fg-dim">{t("adminAuth.ssoExemptionsLead")}</div>
              {(exemptions.data ?? []).map((x) => (
                <div key={x.memberSub} className="flex items-center gap-2 text-xs" data-testid="sso-exemption-row">
                  <span className="min-w-0 flex-1 truncate" data-clip="value" data-testid="sso-exemption-name">{nameOf(x.memberSub)}</span>
                  {!x.hasCredential && (
                    /* §5: the credential row is the only honest witness that a key exists — an
                       exemption without one cannot actually sign in yet, and the screen says so */
                    <span className="rounded bg-panel-2 px-1.5 py-px text-[10px] text-fg-dim" data-testid="sso-exemption-no-credential">{t("adminAuth.ssoExemptionNoCredential")}</span>
                  )}
                  <IconButton aria-label={t("adminAuth.ssoExemptionRevoke")} data-testid="sso-exemption-revoke" variant="danger"
                    onClick={() => setRevokingExemption(x.memberSub)}><X size={12} /></IconButton>
                </div>
              ))}
              {/* #617 ①: the shared member typeahead (#416 / ADR-161 — "one implementation for every
                  pick-a-member surface"). This screen had grown its own: candidates as up-to-5 buttons
                  along the right of the field, a shape nothing else in the product uses. Picking IS the
                  grant here (there is no second "add" step), so onPick fires the mutation. */}
              <div className="flex max-w-[320px] items-center gap-2">
                <MemberSearchInput
                  query={exemptQuery}
                  onQueryChange={setExemptQuery}
                  picked={null}
                  onPick={(c) => {
                    if (!c) return;
                    grantExemption.mutate(c.sub, {
                      onSuccess: () => { notify.success(t("toast.saved")); setExemptQuery(""); },
                      onError: () => notify.error(t("toast.actionFailed")),
                    });
                  }}
                  candidates={exemptCandidates.candidates.filter((c) => !(exemptions.data ?? []).some((x) => x.memberSub === c.sub))}
                  // #582's rule (pinned): a member-search field shows the SHARED sentence — a screen
                  // that writes its own is how one of the copies ends up wrong in the screen nobody
                  // opened. The exemption-specific wording stays where it is not duplicated copy: the
                  // accessible name, which says what THIS field does.
                  placeholder={t("common.memberSearch")}
                  ariaLabel={t("adminAuth.ssoExemptionSearch")}
                  inputTestId="sso-exemption-input"
                  listTestId="sso-exemption-list"
                  itemTestId="sso-exemption-add"
                  inputSize="sm"
                />
              </div>
            </div>
            )}
          </div>
        )}

        {/* #652 / ADR-219 §4: the SECOND-FACTOR stance, beside the SSO one because it is the same
            kind of fact — what this tenant demands of the people signing in. It has been writable over
            the API since slice 2 and had no switch, which is the whole of the reject: a policy nobody
            can turn on is a policy the product does not have.

            The two refusals are drawn APART on purpose. `entitled: false` is "your plan", `canEnable:
            false` is "no admin has enrolled a factor yet" — the second is the one an admin can fix in
            the next minute, and folding them into one grey switch would send them to a pricing page
            instead. Both are TEXT on the row, not only a tooltip: a disabled switch with a hover-only
            reason reads as broken (the desktop-first rule is about extras, not about why something is
            off). Turning it OFF is never blocked, so a tenant whose last enrolled admin left can still
            lift the requirement — `canEnable` gates the ON direction alone. */}
        {m && methods.data?.secondFactorRequired && (
          <div className={METHOD_ROW} data-method-row data-testid="sign-in-method-second-factor-required">
            <div className={METHOD_ROW_HEAD}>
              <div className="min-w-0 flex-1">
                <div className="font-medium">{t("adminAuth.secondFactorRequired")}</div>
                <div className="text-xs text-fg-dim">{t("adminAuth.secondFactorRequiredBody")}</div>
              </div>
              {!methods.data.secondFactorRequired.entitled ? (
                <span className="text-xs text-fg-dim" data-testid="second-factor-unentitled">{t("adminAuth.method_unentitled")}</span>
              ) : !methods.data.secondFactorRequired.canEnable && !methods.data.secondFactorRequired.selected ? (
                <span className="text-xs text-[var(--warning,#b45309)]" data-testid="second-factor-no-admin">{t("adminAuth.secondFactorNoAdmin")}</span>
              ) : null}
              <Switch checked={!!methods.data.secondFactorRequired.selected} testId="second-factor-required-toggle"
                ariaLabel={t("adminAuth.secondFactorRequired")}
                disabled={!canManageStance || !methods.data.secondFactorRequired.entitled
                  || (!methods.data.secondFactorRequired.selected && !methods.data.secondFactorRequired.canEnable)}
                onChange={(on: boolean) => setConfirming({ stance: "factor", to: on })} />
            </div>
            {/* #679 / ADR-222 §1: WHICH kinds, once something is required. The two are not
                interchangeable — a passkey resists phishing and dies when the host changes (#664), a
                code does neither — so a workspace that has decided to require one still has a decision
                to make. Hidden while nothing is required, because there is no question then. */}
            {methods.data.secondFactorRequired.selected && canManageStance && ((sf) => {
              // #672 (review rejection): an option the server would only ever 409 is not offered as
              // a choice — #606's "button that always fails" — and the reason is printed BESIDE the
              // picker, not hung on hover. The switch above already learnt that (#652): a
              // disabled control whose reason only appears on hover reads as broken, and the reader on
              // a touch screen never reads it at all.
              //
              // ⚠️ Which is why a refusal we cannot NAME does not grey anything out. A greyed option
              // with no sentence beside it is the state that rule exists to prevent, so an unrecognised
              // code (an older screen against a newer server) leaves the option selectable and lets the
              // 409 do the talking. Greying is convenience; `stanceRefusal` on the server is the half
              // that has to be right (#613 — never a gate that only hides).
              const refused = new Map(STANCE_CHOICES.flatMap((s) => {
                // The stance already in force is never refused to its own tenant: they are living in
                // it, and a picker that greyed out its current value would read as an error about the
                // past rather than about a choice.
                if (s === sf.stance) return [];
                const why = refusalText(sf.stanceRefusals?.[s] ?? undefined);
                return why ? [[s, why] as const] : [];
              }));
              return (
              <div className="flex flex-col gap-1 border-t border-border pt-1.5" data-testid="second-factor-kinds">
                <div className="text-xs text-fg-dim">{t("adminAuth.secondFactorKindsLead")}</div>
                <Select size="sm" value={sf.stance ?? "any"}
                  ariaLabel={t("adminAuth.secondFactorKindsLead")} testId="second-factor-kinds-select"
                  options={STANCE_CHOICES.map((s) => ({
                    value: s,
                    label: t(STANCE_LABEL[s]),
                    disabled: refused.has(s),
                  }))}
                  onChange={(v) => setPickingStance(v as FactorStance)} />
                {[...refused].map(([s, why]) => (
                  <div key={s} className="text-xs text-[var(--warning,#b45309)]" data-testid={`stance-refused-${s}`}>
                    {t("adminAuth.stanceRefused", { kind: t(STANCE_LABEL[s]), reason: why })}
                  </div>
                ))}
              </div>
              );
            })(methods.data.secondFactorRequired)}
          </div>
        )}

        {/* #589 bounce ②: adding a connection grows a ROW in the list, with the row's own padding — it
            used to be a card below the list with different spacing, so "add a sign-in method" looked
            like leaving the list rather than extending it. */}
        {adding && (
          <div className={METHOD_ROW} data-method-row data-testid="admin-connection-form">
            <label className="flex flex-col gap-1 text-xs text-fg-dim">
              {t("adminConnections.preset")}
              <Select size="sm" value={preset} ariaLabel={t("adminConnections.preset")} testId="admin-connection-preset"
                options={[
                  { value: "", label: t("adminConnections.presetNone") },
                  { value: "google", label: "Google" },
                  { value: "microsoft", label: "Microsoft" },
                ]}
                onChange={setPreset} />
            </label>
            {preset === "" && (
              <>
                <label className="flex flex-col gap-1 text-xs text-fg-dim">
                  {t("adminAuth.issuer")}
                  <Input inputSize="sm" placeholder={t("adminConnections.issuerPlaceholder")} value={form.issuer}
                    onChange={(e) => setForm({ ...form, issuer: e.target.value })} data-testid="admin-connection-issuer" />
                </label>
                <label className="flex flex-col gap-1 text-xs text-fg-dim">
                  {t("adminConnections.buttonLabel")}
                  <Input inputSize="sm" placeholder={t("adminConnections.labelPlaceholder")} value={form.label}
                    onChange={(e) => setForm({ ...form, label: e.target.value })} data-testid="admin-connection-label" />
                </label>
              </>
            )}
            {preset === "microsoft" && (
              <label className="flex flex-col gap-1 text-xs text-fg-dim">
                {t("adminConnections.entraTenantId")}
                <Input inputSize="sm" placeholder={t("adminConnections.entraPlaceholder")} value={form.entraTenantId}
                  onChange={(e) => setForm({ ...form, entraTenantId: e.target.value })} data-testid="admin-connection-entra" />
              </label>
            )}
            <label className="flex flex-col gap-1 text-xs text-fg-dim">
              {t("adminAuth.clientId")}
              <Input inputSize="sm" placeholder={t("adminConnections.clientIdPlaceholder")} value={form.clientId}
                onChange={(e) => setForm({ ...form, clientId: e.target.value })} data-testid="admin-connection-clientid" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-fg-dim">
              {t("adminAuth.clientSecret")}
              <Input inputSize="sm" type="password" placeholder={t("adminConnections.secretPlaceholder")} value={form.clientSecret}
                onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} />
            </label>
            {/* #733: shown, not asked for — see the note on the edit form above. */}
            <p className="flex flex-col gap-1 text-xs text-fg-dim">
              {t("adminAuth.oidcRedirectHint", { product: productName })}
              <code className="select-all" data-testid="admin-connection-redirect">{oidcRedirectUri}</code>
            </p>
            {/* #615: the groups CLAIM belongs with the trust switch beside it. Configuring the trust and
                then having to reopen the row to say WHICH claim carries the groups is the two-step this
                ticket removes — and the pair is what decides whether group sync works at all. Blank
                means `groups` (the placeholder says so); the default is unchanged. */}
            <label className="flex flex-col gap-1 text-xs text-fg-dim">
              {t("adminAuth.groupsClaim")}
              <Input inputSize="sm" placeholder={t("adminConnections.groupsClaimPlaceholder")} value={form.groupsClaim}
                data-testid="admin-connection-groups-claim"
                onChange={(e) => setForm({ ...form, groupsClaim: e.target.value })} />
            </label>
            <label className="flex items-start gap-2 text-xs text-fg-dim">
              <Switch checked={flags.trustGroups} ariaLabel={t("adminConnections.trustGroups")} testId="admin-connection-trust-groups"
                onChange={(on: boolean) => setFlags({ ...flags, trustGroups: on })} />
              <span>
                {t("adminConnections.trustGroups")}
                {/* what the switch DOES, in one line. Off by default stays the ADR-197 judgement — an
                    external IdP's group claim is not believed until somebody says so — and a switch
                    whose effect is invisible is why a connection sat there not syncing. */}
                <span className="block">{t("adminConnections.trustGroupsHint")}</span>
              </span>
            </label>
            <div className="flex gap-2">
              <Button variant="primary" size="sm" data-testid="admin-connection-save" disabled={create.isPending} onClick={submitNew}>
                {t("common.save")}
              </Button>
              <Button variant="default" size="sm" onClick={() => setAdding(false)}>{t("common.cancel")}</Button>
            </div>
          </div>
        )}

        {rows.length === 0 && !adding && !connections.isLoading && samlState.kind === "hidden" && !showPlatform && (
          <p className="text-sm text-fg-dim">{t("adminConnections.empty")}</p>
        )}
      </div>

      {!adding && (() => {
        // #623 ③: at the cap the button says WHY it will not work instead of offering a click that can
        // only 409 (#606's "button that always fails"). The number is the server's (`oidcConnectionCap`);
        // an older server that does not send it never disables — the POST still refuses, which is the
        // fortress. Counted against the OIDC rows only: SAML and platform are not creatable here.
        const cap = methods.data?.oidcConnectionCap;
        const atCap = cap !== undefined && rows.length >= cap;
        return (
          <>
            <Button variant="default" size="sm" className="mt-3" data-testid="admin-connection-add"
              disabled={atCap} onClick={() => setAdding(true)}>
              {t("adminConnections.add")}
            </Button>
            {atCap && (
              <p className="mt-1 text-xs text-fg-dim" data-testid="admin-connection-cap-note">
                {t("adminConnections.limitReached", { count: cap })}
              </p>
            )}
          </>
        );
      })()}

      <ConfirmDialog
        open={revokingExemption !== null}
        message={revokingExemption ? t("adminAuth.ssoExemptionRevokeConfirm", { sub: nameOf(revokingExemption) }) : ""}
        confirmTestId="sso-exemption-revoke-confirm"
        confirmLabel={t("common.confirm")}
        onClose={() => setRevokingExemption(null)}
        onConfirm={() => {
          if (revokingExemption) revokeExemption.mutate(revokingExemption, {
            onSuccess: () => notify.success(t("toast.saved")),
            onError: (e) => notify.error(e instanceof ApiError && e.code === "sso_exemption_required" ? t("adminAuth.ssoNeedsExemption") : t("toast.actionFailed")),
          });
          setRevokingExemption(null);
        }}
      />
      {/* Not "are you sure" theatre: each of the four sentences says what CHANGES — who gets signed
          out, who can get in afterwards, which doors close. The testid stays keyed to the stance
          rather than to the direction, so a spec cannot accidentally confirm the other one. */}
      <ConfirmDialog
        open={confirming !== null}
        title={confirming ? stanceQuestion(confirming).title : ""}
        message={confirming ? stanceQuestion(confirming).message : ""}
        confirmTestId={confirming?.stance === "sso" ? "sso-required-confirm" : "second-factor-required-confirm"}
        confirmLabel={t("common.confirm")}
        onClose={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming?.stance === "factor") saveFactorPolicy(confirming.to);
          else if (confirming) saveSsoStance(confirming.to);
          setConfirming(null);
        }}
      />
      {/* #679: narrowing signs people out immediately (ruling ④), so the question carries the NUMBER
          the one thing a tenant cannot work out for itself — and, for passkeys, the sentence ruling
          ②-3 asked for. `StanceConfirm` fetches while open; the dialog does not appear until it has an
          answer, because "N members" with N unknown is worse than a moment's wait. */}
      {pickingStance !== null && (
        <StanceConfirm stance={pickingStance} onClose={() => setPickingStance(null)}
          onConfirm={() => { saveStance(pickingStance); setPickingStance(null); }} />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={t("adminConnections.deleteTitle")}
        message={deleting ? t("adminConnections.deleteConfirm", { name: connectionName(deleting) }) : ""}
        confirmTestId="admin-connection-delete-confirm"
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id, { onSuccess: () => notify.success(t("adminConnections.deleted")), onError });
          setDeleting(null);
        }}
      />
    </div>
  );
}

/**
 * The question asked before a stance is written (#679 / ADR-222 §4).
 *
 * Its own component so the impact query is mounted only while the question is open: asking on every
 * render of the screen would poll a count nobody has asked for, and asking after the click would show a
 * dialog that changes its own sentence a moment later.
 */
function StanceConfirm(
  { stance, onClose, onConfirm }: { stance: FactorStance; onClose: () => void; onConfirm: () => void },
) {
  const { t } = useTranslation();
  const impact = useStanceImpact(stance);
  const n = impact.data?.signedOut ?? 0;
  return (
    <ConfirmDialog
      open
      // #683 this said "Require two-factor authentication" — the SWITCH's label — above a body
      // asking whether to change which kinds count, on a tenant where the requirement was already on.
      // A heading borrowed from a control answers to the control, not to the question being asked.
      title={t(CONFIRM_COPY.kinds.title)}
      message={[
        // Plural-aware, and count-first: the number is the reason this question exists.
        //
        // #672 (review rejection ②): at zero this read "0 members cannot satisfy this and will be
        // signed out now" — a sentence about people who do not exist, and in Japanese
        // pointing at nobody. One `{{count}}` string cannot say 0, 1 and N, and Japanese having no
        // plural is not a reason to skip the branch: `_zero` is a case, not a plural form. At zero the
        // sentence says so and stops, because there is no sign-out to describe.
        t("adminAuth.stanceConfirmSweep", { count: n }),
        // ruling ②-3: a passkey cannot be exported, and losing it means talking to the operator. Said
        // before the write, in the same standing as #664's domain-move warning.
        stance === "passkey" ? t("adminAuth.stancePasskeyWarning") : "",
        t("adminAuth.stanceConfirmTail"),
      ].filter(Boolean).join(" ")}
      confirmTestId="second-factor-kinds-confirm"
      confirmLabel={t("common.confirm")}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
}
