import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useRoles, useCreateRole, useUpdateRole, useDeleteRole,
  useTenantRoleDefaults, useSetTenantRoleDefaults,
} from "../data/queries";
import { closureOf, nounCapability, tenantTierCaps, TENANT_TIER_CAPS } from "./role-nouns";
import { RoleTip } from "../ui/RoleTip"; // #586 the role NAME raises the "what it can do" window
import { useSession } from "../session/SessionProvider";
import { Button, IconButton } from "../ui/Button";
import { ConfirmDialog } from "../ui/dialogs"; // #504: deleting a role is irreversible — confirm first
import { Input } from "../ui/Input";
import { RadioGroup } from "../ui/RadioGroup";
import { notify } from "../ui/toast";
import { Pencil, SlidersHorizontal, X } from "lucide-react"; // #544: icon components, not text glyphs (font fallback squashed them)
import { SETTINGS_WIDTHS } from "./SettingsShell"; // #735: the column width is a named step, not a number

// #420 / ADR-164 increment 5: the custom-role manager (tenant-admin console). Definitions =
// named bundles of the atomic capabilities; assignments expand to fixed FGA tuples server-side.
// The UI is convenience only — the server enforces tenant-admin + the customRoles entitlement on
// every write (a non-entitled plan sees the built-ins and gets the 403 upsell on create).
const CAPABILITIES = ["view", "comment", "edit", "publish", "delete", "share", "settings", "moderate"] as const;
// #445 / ADR-171: the TENANT-scope vocabulary (tenant actions; mutually exclusive with the above).
// #496 / ADR-181: `issueApiKeys` (the api_key_issue relation) joins the tenant vocabulary, so it shows
// up BOTH in the built-in member toggle below and in the custom tenant-role editor — the ADR's "one
// screen configures issuance". The old /admin/api two-choice policy selector is gone with the enum.
// #604 / ADR-208 (ruling B): the tenant vocabulary opens. `manageConnections` is the first verb carved
// out of `admin` — a tenant role can carry it, so running the sign-in methods stops meaning "be handed
// the tenant". The list is the grant vocabulary; what each verb CONFERS is measured, never written here.
const TENANT_CAPABILITIES = ["createSpaces", "issueApiKeys", "manageConnections", "manageRoles", "viewAudit"] as const;

// #536 gave every row a scope badge because the sections it sat in were not readable as sections.
// #581 fixes the sections instead and drops the badge here: where POSITION carries the information,
// repeating it on every row is noise the user asked us to remove. The badge is still available
// `scope` is optional now — for a surface that mixes scopes in one list (a search result, a member
// row's chips), where position says nothing. "BUILT-IN" always stays: no position implies it.
function RoleBadges({ scope, builtIn = false }: { scope?: "resource" | "tenant"; builtIn?: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      {scope && (
        <span className="rounded bg-panel-2 px-1 text-[10px] uppercase tracking-wide text-fg-dim" data-testid="role-scope-badge">
          {t(scope === "tenant" ? "adminRoles.scopeTenant" : "adminRoles.scopeResource")}
        </span>
      )}
      {builtIn && <span className="rounded border border-border px-1 text-[10px] uppercase tracking-wide text-fg-dim" data-testid="role-builtin-badge">{t("adminRoles.builtIn")}</span>}
    </>
  );
}

// #420 `disabled` renders the SAME control read-only, so a built-in role is shown as the very
// checkbox grid you would use to build a custom one — the vocabulary and layout match instead of the
// old "cap · cap · cap" text, and what a role can do reads the same way everywhere.
// #445 `lockLast` keeps a role from losing its LAST capability — the sole checked box renders
// disabled (with a title explaining why), mirroring the server's non-empty validation (`role-save`'s
// existing constraint) instead of letting the toggle round-trip to a 400.
// #586 / ADR-203 (user ruling): the boxes SHOW subsumption instead of a sentence explaining it.
//
// The complaint: "checking these boxes, you could conclude commenting is not allowed" — because a role
// with `moderate` grants comment through the model and the grid said nothing, so a note had to. Ticking
// a superior capability now draws the ones it carries as CHECKED and not operable, with the reason
// beside them.
//
// Display only. The saved set stays exactly what the administrator picked, for two reasons the ruling
// names: writing the implied ones would erase the record of what was INTENDED ("moderate, and nothing
// else"), and subsumption CHANGES — #553 severed `edit ⇒ comment` this week, and after such a change
// there would be no telling an auto-written `comment` from a deliberate one.
//
// The source of subsumption is the measured table (`BUILTIN_EFFECTIVE_CAPS`), which a server test keeps
// equal to what a real OpenFGA store answers. A second hand-written table here is exactly the drift
// #485 and #536 were caused by.
function CapabilityPicker({ value, onChange, idPrefix, list, disabled = false, lockLast = false }: { value: string[]; onChange?: (caps: string[]) => void; idPrefix: string; list: readonly string[]; disabled?: boolean; lockLast?: boolean }) {
  const { t } = useTranslation();
  const lastLocked = lockLast && value.length === 1;
  const implied = new Map<string, string>();
  for (const held of value) {
    // #586 review ②: through the shared closure, so this grid and the tooltips cannot answer the same
    // question differently.
    for (const c of closureOf([held])) {
      if (c !== held && !value.includes(c)) implied.set(c, held);
    }
  }
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {list.map((c) => {
        const itemLocked = lastLocked && value.includes(c);
        const impliedBy = implied.get(c);
        const itemDisabled = disabled || itemLocked || impliedBy !== undefined;
        return (
          <label key={c} className={`flex items-center gap-1.5 text-sm${disabled || impliedBy ? " text-fg-dim" : ""}`}
            data-testid={impliedBy ? `${idPrefix}-implied-${c}` : undefined}
            data-tip={itemLocked ? t("adminRoles.lastCap") : impliedBy ? t("adminRoles.impliedBy", { cap: t(`adminRoles.cap.${impliedBy}`) }) : undefined}>
            <input
              type="checkbox"
              data-testid={`${idPrefix}-cap-${c}`}
              checked={value.includes(c) || impliedBy !== undefined}
              disabled={itemDisabled}
              onChange={itemDisabled ? undefined : (e) => onChange?.(e.target.checked ? [...value, c] : value.filter((x) => x !== c))}
              readOnly={itemDisabled}
            />
            <span>{t(`adminRoles.cap.${c}`)}</span>
            {impliedBy && <span className="text-xs text-fg-dim">{t("adminRoles.impliedBy", { cap: t(`adminRoles.cap.${impliedBy}`) })}</span>}
          </label>
        );
      })}
    </div>
  );
}

// #580: the scope is CHOSEN, and it is the first thing on the form.
//
// #536 removed a scope <Select> nobody could find and derived the scope from the boxes instead
// which fixed the hidden control and created a new problem the user then hit: you cannot tell which
// kind of role you are making until you have already ticked something, and both vocabularies sit in
// one undifferentiated grid until then. The answer is not to bring back the hidden Select: the choice
// is made visible, as two segments, with a default, so the form always says what it is building.
//
// The capability list then follows the segment, which is what makes a mixed role UNBUILDABLE rather
// than merely refused at save — the mixed-state hint has nothing left to warn about. The server's
// exclusivity check stays exactly where it was (two layers; the UI is convenience, ADR-171 §445).
function RoleEditor({ onSave, onCancel, pending }: {
  onSave: (v: { name: string; capabilities: string[]; scope: "resource" | "tenant" }) => void;
  onCancel?: () => void;
  pending: boolean;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"resource" | "tenant">("resource");
  const [caps, setCaps] = useState<string[]>([]);
  const list = scope === "tenant" ? TENANT_CAPABILITIES : CAPABILITIES;
  // switching scope drops what was ticked: keeping it would rebuild the mixed role this removes, and
  // a capability from the other vocabulary is not "the same choice" in the new scope.
  const pickScope = (next: "resource" | "tenant") => { setScope(next); setCaps([]); };
  // #580 review 2: "the form says what it is building" only holds if the form is ON SCREEN.
  // /admin/roles is a long page, so the trigger sits near the bottom edge and the form opened BELOW
  // it — measured at top=759 on a 720px viewport, i.e. the segments were off screen at the moment
  // they were supposed to be doing their job. Opening scrolls the form into view.
  const formRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { formRef.current?.scrollIntoView({ block: "center" }); }, []);
  return (
    <div ref={formRef} className="flex flex-col gap-2 rounded-md border border-border p-3">
      <Input inputSize="sm" className="max-w-xs" value={name} placeholder={t("adminRoles.namePlaceholder")}
        aria-label={t("adminRoles.nameLabel")} data-testid="role-name-input" onChange={(e) => setName(e.target.value)} />
      <div className="flex flex-col gap-1">
        <span className="text-xs text-fg-dim">{t("adminRoles.scopeQuestion")}</span>
        {/* #587: the DS segmented radiogroup, not a hand-rolled one. #580 built this by hand and had to
            add roving tabindex and arrow keys by hand too, one review later; the component has
            carried both since #389. The wrapper keeps the container test-id the #580 pins use. */}
        <span data-testid="role-scope-segments" className="w-fit">
          <RadioGroup
            variant="segmented"
            value={scope}
            onChange={(v) => pickScope(v as "resource" | "tenant")}
            ariaLabel={t("adminRoles.scopeQuestion")}
            testId="role-scope"
            options={[
              { value: "resource", label: t("adminRoles.scopeResource") },
              { value: "tenant", label: t("adminRoles.scopeTenant") },
            ]}
          />
        </span>
      </div>
      <CapabilityPicker value={caps} onChange={setCaps} idPrefix="role" list={list} />
      <div className="flex gap-2">
        <Button variant="primary" size="sm" data-testid="role-save" disabled={pending || !name.trim() || caps.length === 0}
          onClick={() => onSave({ name: name.trim(), capabilities: caps, scope })}>{t("common.save")}</Button>
        {onCancel && <Button variant="default" size="sm" onClick={onCancel}>{t("common.cancel")}</Button>}
      </div>
    </div>
  );
}

// #586 (review rejection): . Measured
// built-in rows were 17px and custom rows 32px, because only the custom ones carry IconButtons and the
// row had no box of its own — so nearly-double-height rows alternated down one list. The standing
// ruling is that built-in and custom are ONE kind of thing wearing the same row (#536 / #582); a
// difference in AFFORDANCES is fine, a difference in the CONTAINER is not.
//
// One class, used by every row header. A new kind of row (a group row, say) is regular by using it,
// rather than by somebody remembering to match a number. No filler icons on the built-in side — the
// box is what is shared, not the contents.
const ROLE_ROW_HEAD = "flex min-h-8 items-center gap-2";

export function AdminRolesTab() {
  const { t } = useTranslation();
  const roles = useRoles();
  const createRole = useCreateRole();
  const updateRole = useUpdateRole();
  const deleteRole = useDeleteRole();
  const [creating, setCreating] = useState(false);
  // #445 the full edit form is gone — capabilities toggle INLINE (per-op commit) and only the
  // NAME keeps a small affordance (pencil → inline input).
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // #504: deleting a role is irreversible (its assignments go with it) — red trigger + confirm.
  const [deletingRole, setDeletingRole] = useState<{ id: string; name: string } | null>(null);

  // #445: default tenant-role presets (CE).
  const { tenantId } = useSession();
  const defaults = useTenantRoleDefaults();
  const setDefaults = useSetTenantRoleDefaults();
  // #586 (2026-08-04): the member tier's row is a NAME now, and what it confers is this tenant's live
  // policy rather than a constant — the same source #582 ① gave the pickers, so the row and the picker
  // cannot disagree about what a member can do here.
  const memberTierCaps = tenantTierCaps(defaults.data?.member).member;
  // #586 (same reject): the tenant defaults are a POLICY, and every switch shown for them has to reach
  // the endpoint. The vocabulary a custom tenant role may carry is longer than what this policy stores,
  // and rendering the long one here is what let three boxes be clicked into a success toast that saved
  // nothing. One list, derived from the payload's own keys, so a new default cannot be drawn before it
  // can be written.
  const MEMBER_DEFAULT_CAPS = ["createSpaces", "issueApiKeys"] as const;

  // #497 / ADR-183 §3: the tenant default role — a tenant-scope custom role conferred on any member
  // no mapping matches (applied at their next login). Only tenant-scope roles are eligible.
  const tenantRoles = (roles.data?.custom ?? []).filter((r) => r.scope === "tenant");

  const onError = (e: unknown) => {
    const status = (e as { status?: number })?.status;
    notify.error(status === 403 ? t("adminRoles.notEntitled") : status === 409 ? t("adminRoles.conflict") : t("toast.actionFailed"));
  };

  // #536 ④: one renderer for a custom-role row, used by BOTH scope sections (the row itself is
  // scope-agnostic; only which section it sits in changed).
  const [capsOpenId, setCapsOpenId] = useState<string | null>(null); // #586 ②: which row shows its editing grid
  const renderCustomRole = (r: { id: string; name: string; capabilities: string[]; scope: string }) => {
    const commitRename = () => {
      if (renamingId !== r.id) return; // Enter already committed; the trailing blur is a no-op
      const v = renameValue.trim();
      setRenamingId(null);
      if (!v || v === r.name) return;
      updateRole.mutate({ id: r.id, name: v, capabilities: r.capabilities }, {
        onSuccess: () => notify.success(t("toast.saved")),
        onError,
      });
    };
    return (
      <div key={r.id} className="flex flex-col gap-1" data-testid="custom-role-row">
        <div className={`${ROLE_ROW_HEAD} text-sm`}>
          {renamingId === r.id ? (
            <Input inputSize="sm" className="max-w-xs" value={renameValue} autoFocus
              aria-label={t("adminRoles.nameLabel")} data-testid="role-rename-input"
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                else if (e.key === "Escape") setRenamingId(null);
              }} />
          ) : (
            <>
              {/* #586 ②: the NAME is what you hover — the same floating "what this role can do"
                  window every other surface raises, via the same component. */}
              <RoleTip origin="role" scope={r.scope === "tenant" ? "tenant" : "space"} roleCapabilities={r.capabilities} testId={`role-tip-${r.name}`}>
                <span className="font-medium">{r.name}</span>
              </RoleTip>
              <RoleBadges />
              <IconButton aria-label={t("adminRoles.rename")} data-tip={t("adminRoles.rename")} data-testid="role-rename"
                onClick={() => { setRenamingId(r.id); setRenameValue(r.name); }}><Pencil size={14} /></IconButton>
              <IconButton aria-label={t("adminRoles.editCaps")} data-tip={t("adminRoles.editCaps")} data-testid="role-edit-caps"
                onClick={() => setCapsOpenId(capsOpenId === r.id ? null : r.id)}><SlidersHorizontal size={14} /></IconButton>
            </>
          )}
          <span className="flex-1" />
          {/* #504: red at rest + confirm-before-delete (irreversible — assignments die with it) */}
          <IconButton aria-label={t("adminRoles.delete")} data-testid="role-delete" variant="danger"
            onClick={() => setDeletingRole({ id: r.id, name: r.name })}><X size={14} /></IconButton>
        </div>
        {/* #586 ②: the grid is an EDITING surface, so it shows when editing — at rest the list is
            names, and the name's hover window says what each confers ("
            Per-op semantics inside are unchanged. */}
        {capsOpenId === r.id && (
          <CapabilityPicker
            value={r.capabilities}
            idPrefix="custom"
            list={r.scope === "tenant" ? TENANT_CAPABILITIES : CAPABILITIES}
            disabled={updateRole.isPending}
            lockLast
            onChange={(caps) => {
              if (caps.length === 0) return; // belt + braces under lockLast — never PUT an empty bundle
              updateRole.mutate({ id: r.id, name: r.name, capabilities: caps }, {
                onSuccess: () => notify.success(t("toast.saved")),
                onError,
              });
            }}
          />
        )}
      </div>
    );
  };

  return (
    <div data-settings-pane="wide" className={SETTINGS_WIDTHS.wide} data-testid="admin-roles">
      <h2 className="mt-0">{t("adminRoles.title")}</h2>

      {/* #536 (user re-ruling) + ④: ONE set of roles, presented in TWO scope sections
          "Tenant" above, "Space / Page" below (the ruling: tenant roles and resource roles mixed in one
          flat list read as a jumble; the dividing axis is SCOPE, not built-in/custom). Within each
          section the order is built-in → custom (DOM-pinned). What each row keeps:
          - #445 / #469: every role reads the SAME way — bold name + a CapabilityPicker; built-ins
            are the read-only version of the very control custom roles edit with.
          - `member` is the one editable built-in cell: its boxes ARE the tenant defaults
            (tenant#space_creator wildcard / api_key_issue, #496) through the unchanged endpoint, and
            stay disabled until the defaults have ARRIVED (an authz control must not guess its state).
          - Custom rows: live per-op capability toggles (#445), pencil rename, #504 red delete. */}
      <div className="mb-2 flex flex-col gap-4" data-testid="roles-list">
        {/* #581: the two groups are SURFACES, not a pair of small grey labels above a continuous run of
            rows. A card each — border, panel background, its own heading bar — so the boundary is
            visible before you read anything, which is what lets the per-row scope badge go away. */}
        <section className="rounded-md border border-border bg-panel">  {/* list-box-ok: a SECTION frame, not a row — #581 made each scope its own surface deliberately */}
          <h3 className="m-0 border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wide text-fg-dim" data-testid="roles-section-tenant">{t("adminRoles.sectionTenant")}</h3>
          {/* #539 / #521 / #503: the same 26rem box + inner scroll, because this list grows with the
              tenant's roles and this is the fourth list to hit that. The page keeps its own scroll. */}
          <div className="flex max-h-[26rem] flex-col gap-2 overflow-y-auto p-3" data-testid="roles-list-tenant">
          <div className="flex flex-col gap-1" data-testid="builtin-role-member">
            <div className={ROLE_ROW_HEAD}>
              {/* #586 (review rejection, 2026-08-04): " member UI ".
                  This row kept an editable grid because its boxes were really the TENANT DEFAULTS wearing
                  a role row's clothes — and that made the one thing a tenant cannot redefine look like
                  the one thing it can. A built-in role carries no editing surface anywhere; the defaults
                  moved to their own section below, where they are what they are. */}
              <RoleTip origin="role" scope="tenant" roleCapabilities={memberTierCaps} testId="role-tip-member">
                <span className="text-sm font-medium">member</span>
              </RoleTip>
              <RoleBadges builtIn />
            </div>
          </div>
          <div className="flex flex-col gap-1" data-testid="builtin-role-admin">
            <div className={ROLE_ROW_HEAD}>
              {/* #586 ①: this row hard-coded two capabilities while the store answers true for
                  five — #604 carved verbs out of `admin` as `… or admin`, and a hand-written value
                  missed every one of them. The measured tier table is the display source now, shown the
                  way every other role shows itself: hover the name. */}
              <RoleTip origin="role" scope="tenant" roleCapabilities={TENANT_TIER_CAPS.admin} testId="role-tip-admin">
                <span className="text-sm font-medium">admin</span>
              </RoleTip>
              <RoleBadges builtIn />
            </div>
          </div>
          {(roles.data?.custom ?? []).filter((r) => r.scope === "tenant").map(renderCustomRole)}
          </div>
        </section>
        <section className="rounded-md border border-border bg-panel">  {/* list-box-ok: a SECTION frame, not a row — the resource-scope surface, same as above */}
          <h3 className="m-0 border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wide text-fg-dim" data-testid="roles-section-resource">{t("adminRoles.sectionResource")}</h3>
          <div className="flex max-h-[26rem] flex-col gap-2 overflow-y-auto p-3" data-testid="roles-list-resource">
          {(roles.data?.builtIn ?? []).map((r) => (
            <div key={r.name} className="flex flex-col gap-1" data-testid={`builtin-role-${r.name}`}>
              <div className={ROLE_ROW_HEAD}>
                {/* #586 ②: at rest a role is its NAME, and hovering it raises the measured "what
                    it can do" window — the same component every other surface uses. The read-only grid
                    that stood here drew the measured closure correctly since the last bounce, but a
                    9-column lattice per row is the shape the ruling rejected. */}
                <RoleTip origin="role" scope="space" builtinCapability={nounCapability(r.name)} testId={`role-tip-${r.name}`}>
                  <span className="text-sm font-medium">{r.name}</span>
                </RoleTip>
                <RoleBadges builtIn />
              </div>
            </div>
          ))}
          {(roles.data?.custom ?? []).filter((r) => r.scope !== "tenant").map(renderCustomRole)}
          </div>
        </section>
        {(roles.data?.custom.length ?? 0) === 0 && <p className="m-0 text-xs text-fg-dim">{t("adminRoles.customEmpty")}</p>}
      </div>
      {creating ? (
        <RoleEditor pending={createRole.isPending}
          onCancel={() => setCreating(false)}
          onSave={(v) => createRole.mutate(v, {
            onSuccess: () => { notify.success(t("toast.saved")); setCreating(false); },
            onError,
          })} />
      ) : (
        <Button variant="default" size="sm" data-testid="role-create" onClick={() => setCreating(true)}>{t("adminRoles.create")}</Button>
      )}

      {/* #586 (review rejection, 2026-08-04): the tenant defaults, as themselves. They used to be the
          `member` row's checkboxes, which said two untrue things at once — that a built-in role can be
          edited (it cannot; that is what a custom role is for), and that the row's vocabulary was the
          policy's (it was longer, and the extra boxes were clickable and saved nothing). Here they are
          a POLICY about every member, in their own section, showing only what this endpoint stores. */}
      <section className="mt-8 rounded-md border border-border bg-panel" data-testid="member-defaults">
        <h3 className="m-0 border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wide text-fg-dim">{t("adminRoles.memberDefaultsTitle")}</h3>
        <div className="p-3">
          <p className="mt-0 mb-2 text-sm text-fg-dim">{t("adminRoles.memberDefaultsBody")}</p>
          <CapabilityPicker
            value={[
              ...((defaults.data?.member.createSpaces ?? true) ? ["createSpaces"] : []),
              // #496: default OFF — provisioning seeds no member tuple, so issuance starts admin-only.
              ...((defaults.data?.member.issueApiKeys ?? false) ? ["issueApiKeys"] : []),
            ]}
            idPrefix="member-defaults"
            list={MEMBER_DEFAULT_CAPS}
            // an authz control must not guess its state: disabled until the defaults have ARRIVED
            disabled={!defaults.data || setDefaults.isPending}
            onChange={(caps) => setDefaults.mutate({ memberCreateSpaces: caps.includes("createSpaces"), memberIssueApiKeys: caps.includes("issueApiKeys") }, {
              onSuccess: () => notify.success(t("toast.saved")),
              onError,
            })}
          />
        </div>
      </section>

      {/* #514 / ADR-188 slice 4: this tab DEFINES roles; it no longer grants them. A resource role is
          assigned where the resource is (a space's Members tab, #485) and a tenant role where the
          principal is (the Members page) — assignment living next to the definitions is what made
          "define" and "grant" read as one screen. Authorization is untouched by the move: every
          assign/unassign still goes through requireAssignmentAuthority on the server. */}
      {/* #578 / ADR-201 slice 5: the tenant DEFAULT ROLE is gone. It conferred a tenant-scope custom
          role on members no mapping matched — and the tenant vocabulary is createSpaces and
          issueApiKeys, both of which already have an every-member toggle on this screen. Two controls,
          one meaning. Existing settings were converted to those toggles rather than dropped. */}
      {/* #497 / ADR-183 → RETIRED by #578 / ADR-201 (slice 7). The group→role MAPPING section stood
          here. It was the second way to reach a result the grant path already produces: one assignment
          on `group:<id>#member`. Groups now take a role the same way a person does — in tenant settings
          for a tenant role, on a space's Members tab for a space one — and the picker there accepts a
          group nobody carries yet, which was the only thing this section could do that it could not.
          Existing mappings were converted to ordinary assignments (migrations 098 and 103), carrying the
          group NAME onto the assignment so the listing still resolves it. */}
      {/* #504: the role-delete confirm — names the role, danger tone. */}
      <ConfirmDialog
        open={deletingRole !== null}
        message={deletingRole ? t("adminRoles.deleteConfirm", { name: deletingRole.name }) : ""}
        confirmTestId="role-delete-confirm"
        onClose={() => setDeletingRole(null)}
        onConfirm={() => {
          if (!deletingRole) return;
          deleteRole.mutate(deletingRole.id, { onSuccess: () => notify.success(t("toast.saved")), onError });
          setDeletingRole(null);
        }}
      />
    </div>
  );
}
