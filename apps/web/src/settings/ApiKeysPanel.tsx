import { useEffect, useState } from "react";
import { ListRow, ListBox } from "../ui/list-rows";
import { SpaceIcon } from "../ui/SpaceIcon";
import type { TFunction } from "i18next";
import { expiryChoices, defaultExpiry } from "./key-expiry-choices";
import { RESOURCE_TYPE_OPTIONS, derivedScope, touchesAdmin, adminDefaultExpiry, type Matrix } from "./api-key-permissions";
import { useTranslation } from "react-i18next";
import { Copy, Trash2, ChevronRight } from "lucide-react"; // #544: an icon component, never a text glyph
import { useCreateApiKey, useCreateNarrowedApiKey, useRevokeApiKey, useAdminRevokeApiKey, useSpaces, type ApiScope, type ApiKeySummary, type ApiKeyCreated } from "../data/queries";
import { Button, IconButton } from "../ui/Button";
import { FormRow } from "../ui/FormRow";
import { filterSpaceOptions, hiddenCount } from "./space-filter";
import { ConfirmDialog } from "../ui/dialogs"; // #504: revoking a key is irreversible — confirm first
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { notify } from "../ui/toast";
import { OneTimeSecret } from "../ui/OneTimeSecret";
import { relTime } from "../ui/relative-time";

// #637: the verbs a narrowed key may carry. The EE route table is the authority and the server checks
// against it; this mirrors it for the picker, and the pin below asserts the two agree rather than
// trusting that somebody remembered to update both.

// #461: when a key was last authenticated with — the signal that tells you which keys are dead
// weight and safe to revoke. The server has always returned lastUsedAt (and #428 made the write
// actually land under RLS); only the list never showed it. Relative, with the exact time on hover;
// "never used" is a distinct state, not a blank.
function LastUsed({ at }: { at: string | null }) {
  const { t, i18n } = useTranslation();
  if (!at) {
    return <span className="flex-none text-xs text-fg-dim" data-testid="api-key-last-used" data-used="never">{t("adminApi.neverUsed")}</span>;
  }
  const { rel, abs } = relTime(at, i18n.language);
  return (
    <time className="flex-none text-xs text-fg-dim" dateTime={at} data-tip={`${t("adminApi.lastUsed")}: ${abs}`} data-testid="api-key-last-used" data-used="yes">
      {t("adminApi.lastUsedRel", { rel })}
    </time>
  );
}

// #462: the key list and the create form, shared by the two surfaces that show them — the admin
// console (every key in the tenant) and a member's own settings (their keys). Same affordances, two
// audiences; the difference is only which list is handed in and whether issuing is allowed here.
// `canIssue` hides the form when the tenant has restricted issuing to admins — the SERVER refuses
// regardless, this only avoids offering something that will be turned down.
/**
 * #658: the short mark on a confined key's row, and the long form in its tooltip.
 *
 * `count` and `named` differ when the reader cannot view every space the key reaches. The label counts,
 * the tooltip names what it may — saying "2 spaces" is the fact an inventory needs, and "which two" is a
 * different question that this reader has not been granted.
 */
function confinementLabel(k: ApiKeySummary, t: TFunction): string {
  const parts: string[] = [];
  if (k.spaces) parts.push(t("adminApi.confinedSpaces", { count: k.spaces.count }));
  if (k.capabilities) parts.push(t("adminApi.confinedCaps", { count: k.capabilities.length }));
  // #667: a v2 key counts its resource types the same way. The two never appear together — the issuing
  // route refuses a key carrying both vocabularies.
  if (k.permissions) parts.push(t("adminApi.confinedTypes", { count: Object.keys(k.permissions).length }));
  return parts.join(" · ");
}

function confinementTip(k: ApiKeySummary, t: TFunction): string {
  const lines: string[] = [];
  if (k.spaces) {
    const named = k.spaces.named.map((s) => s.name);
    const hidden = k.spaces.count - named.length;
    lines.push([...named, hidden > 0 ? t("adminApi.confinedHidden", { count: hidden }) : null].filter(Boolean).join(", "));
  }
  // #662: the LIST had the same defect as the form, under a different invented namespace
  // `adminApi.cap_*` exists in neither locale either, and `defaultValue: c` painted the wire verb. Both
  // now read the one vocabulary that exists. Found by the scan, not by looking: the form was the
  // reported symptom and this line renders the same capabilities two panels down.
  if (k.capabilities) lines.push(k.capabilities.map((c) => t(`adminRoles.cap.${c}`)).join(", "));
  // #667: type and action, because "pages" alone does not say whether the integration can write.
  if (k.permissions) {
    lines.push(Object.entries(k.permissions)
      .map(([type, action]) => `${t(`adminApi.type.${type}`)}: ${t(`adminApi.scope_${action}`)}`).join(", "));
  }
  return lines.join(" · ");
}

export function ApiKeysPanel({
  keys, canIssue, maxScope, maxAgeDays, emptyText, admin = false,
}: {
  keys: ApiKeySummary[];
  canIssue: boolean;
  maxScope: ApiScope;
  // #628 / ADR-215 §1: the tenant's ceiling on key lifetime, or null for none.
  maxAgeDays?: number | null;
  emptyText?: string;
  // #495 / ADR-182: the ADMIN console passes admin — it shows the OWNER of each key and revokes via
  // the admin-gated route (kill any member's key). The member self-view leaves it false (owner-only).
  admin?: boolean;
}) {
  const { t } = useTranslation();
  const create = useCreateApiKey();
  const revokeOwn = useRevokeApiKey();
  const revokeAdmin = useAdminRevokeApiKey();
  const revoke = admin ? revokeAdmin : revokeOwn;
  const [name, setName] = useState("");
  const [scope, setScope] = useState<ApiScope>("read");
  // #628: how long the key should live. = no expiry, which the server refuses when the tenant has a
  // ceiling — the choice is offered rather than pre-decided, so somebody who wants a permanent key on a
  // tenant that forbids them is told, instead of quietly getting a short one.
  // Starts on the longest lifetime the tenant permits, which is always a value that EXISTS in the list.
  // A Select whose value matches no option renders as a bare chevron with no width (#603).
  const [expiry, setExpiry] = useState<string>(() => defaultExpiry(maxAgeDays));
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  // #637 / ADR-216: narrowing. Off by default and opened deliberately — an unnarrowed key is the common
  // case and the one the form should stay simple for. Spaces are a FLAT list: ADR-215 declined per-page
  // narrowing precisely because a page picker means handling a tree, and a space picker does not.
  const narrowedCreate = useCreateNarrowedApiKey();
  const spacesQ = useSpaces();
  const [spaceFilter, setSpaceFilter] = useState("");
  const [narrowing, setNarrowing] = useState(false);
  const [pickedSpaces, setPickedSpaces] = useState<string[]>([]);
  // Derived, not stored: a stale filtered copy is how a picker starts disagreeing with its source.
  const allSpaces = spacesQ.data ?? [];
  const shownSpaces = filterSpaceOptions(allSpaces, spaceFilter, pickedSpaces);
  const hidden = hiddenCount(allSpaces, shownSpaces);
  // #667 / ADR-221 §1: the resource-type matrix replaces the six borrowed role verbs AND the scope
  // Select. The reader picks once; `scope` falls out of what they picked (§5), and the METHOD CEILING
  // stays a separate mechanism in the server so an all-read key cannot write even when the route map is
  // wrong. Keys issued before this keep their verbs and their old rule — §3 freezes them rather than
  // remapping, because no mapping exists that does not widen.
  const [matrix, setMatrix] = useState<Matrix>({});
  const matrixPicked = Object.keys(matrix).length > 0;
  // #504: a revoked key never authenticates again (the member issues a new one) — confirm, by name.
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(null);

  // Under a read cap, write isn't offerable.
  const scopeOptions = (maxScope === "read" ? (["read"] as ApiScope[]) : (["read", "write"] as ApiScope[]))
    .map((s) => ({ value: s, label: t(`adminApi.scope_${s}`) }));
  // #667 §5: with a matrix the scope is DERIVED, not asked — one control, not two. Without one (an
  // unnarrowed key, or a CE deployment with no overlay) the old Select is still the only choice there
  // is, which is what requirement 2 ruled.
  const effScope: ApiScope = maxScope === "read" ? "read"
    : matrixPicked ? derivedScope(matrix) : scope;
  // #628 the choices are DERIVED from the ceiling, not a fixed ladder filtered by it. Filtering
  // left a 3-day policy with nothing to offer, so the form refused what the API would have granted
  // see `key-expiry-choices`.
  const expiryOptions = expiryChoices(maxAgeDays).map((c) => ({
    value: c.value,
    label: c.days === null ? t("adminApi.expiryNever") : t("adminApi.expiryDays", { count: c.days }),
  }));
  // The ceiling arrives from a query, so the first render has none and the choices change under the
  // control. If what is selected stops existing, fall back to the default rather than leaving a Select
  // pointing at nothing — that is the blank-chevron state again, just reached a moment later.
  useEffect(() => {
    if (!expiryOptions.some((o) => o.value === expiry)) setExpiry(defaultExpiry(maxAgeDays));
  }, [maxAgeDays]);
  // #667 / ADR-221 §10: choosing an administrative type moves the DEFAULT lifetime down the ladder the
  // tenant already offers. A default and not a cap — "never" stays selectable, because the ceiling
  // belongs to the tenant (#628) and a second one visible only to some type combinations would make the
  // form refuse what the API grants. It follows the selection while the reader has not overridden it.
  const adminPicked = touchesAdmin(matrix);
  const [expiryTouched, setExpiryTouched] = useState(false);
  useEffect(() => {
    if (expiryTouched) return;
    setExpiry(adminPicked ? adminDefaultExpiry(expiryChoices(maxAgeDays)) : defaultExpiry(maxAgeDays));
  }, [adminPicked, maxAgeDays, expiryTouched]);

  const onCreate = () => {
    if (!name.trim()) return;
    const done = (k: ApiKeyCreated | null) => {
      if (!k) return;
      setCreated(k); setName(""); setExpiry(defaultExpiry(maxAgeDays));
      setPickedSpaces([]); setMatrix({}); setNarrowing(false); setExpiryTouched(false);
      notify.success(t("toast.saved"));
    };
    const base = { name: name.trim(), scope: effScope, expiresInDays: expiry === "" ? null : Number(expiry) };
    // #637: the narrowed route is a DIFFERENT one, because narrowing is EE. On a deployment without the
    // overlay it is simply not there, and a 404 is the honest answer — better than a form that appears to
    // confine a key and hands back one that reaches everything.
    if (narrowing && (pickedSpaces.length > 0 || matrixPicked)) {
      narrowedCreate.mutate({
        ...base,
        ...(pickedSpaces.length > 0 ? { spaces: pickedSpaces } : {}),
        // #667: the matrix, never the old verbs. The server refuses a key carrying both
        // (`mixed_permission_model`) — a row read by one rule with the other half sitting there looking
        // like it meant something is a ledger that lies.
        ...(matrixPicked ? { permissions: matrix } : {}),
      }, { onSuccess: done, onError: () => notify.error(t("toast.actionFailed")) });
      return;
    }
    create.mutate(base, { onSuccess: done, onError: () => notify.error(t("toast.actionFailed")) });
  };
  const toggle = (list: string[], set: (v: string[]) => void, id: string) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <>
      {canIssue && (
        <>
          <label className="mb-1.5 mt-[18px] block text-sm text-fg-dim">{t("adminApi.createTitle")}</label>
          {/* #535: the row carries the scale, so no control here states its own. */}
          <FormRow>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("adminApi.namePlaceholder")} aria-label={t("adminApi.name")} data-testid="api-key-name" />
            {/* #667 §5: two controls became one. With a matrix picked the scope is derived and the
                Select goes away rather than sitting there showing a value nobody chose — the
                the ruling named. It returns the moment the matrix is empty again. */}
            {!matrixPicked && (
              <Select value={effScope} onChange={(v) => setScope(v as ApiScope)} ariaLabel={t("adminApi.scope")} testId="api-key-scope" options={scopeOptions} />
            )}
            <Select value={expiry} onChange={(v) => { setExpiryTouched(true); setExpiry(v); }} ariaLabel={t("adminApi.expiry")} testId="api-key-expiry" options={expiryOptions} />
            <Button variant="primary" disabled={!name.trim() || create.isPending || narrowedCreate.isPending} onClick={onCreate} data-testid="api-key-create">{t("adminApi.create")}</Button>
          </FormRow>
          {/* #637 / ADR-216: what the key may REACH, beside how long it lives and whether it may write.
              Collapsed by default: most keys are not narrowed, and a form that asks every question at once
              makes the common case harder to answer. */}
          {/* #659 (user ruling): ONE name, in both states. It used to say "narrow what it reaches" closed
              and "close" open — a control that renames itself asks the reader to learn two words for one
              thing, and the second described the ACTION rather than what is behind it. The old name also
              covered half of what is inside: the panel holds spaces AND capabilities, and a capability is
              not a destination.
              With the words the same either way, the CHEVRON is the only thing left saying which way this
              goes — the same `lucide` chevron the overflow menu and the group-roles mark use, rotated
              rather than swapped for a second icon. */}
          <Button variant="ghost" size="sm" className="mt-1" data-testid="api-key-narrow-toggle"
            aria-expanded={narrowing} aria-controls="api-key-narrow-panel"
            onClick={() => setNarrowing((v) => !v)}>
            <ChevronRight size={14} aria-hidden
              className={`transition-transform duration-150 ${narrowing ? "rotate-90" : ""}`} />
            {t("adminApi.narrowShow")}
          </Button>
          {narrowing && (
            <div id="api-key-narrow-panel" className="mt-2 flex flex-col gap-2 rounded-md border border-border p-3" data-testid="api-key-narrow">
              <p className="text-xs text-fg-dim">{t("adminApi.narrowHint")}</p>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-fg-dim">{t("adminApi.narrowSpaces")}</span>
                {/* #661: a tenant's spaces are not few — `GET /spaces` has no bound and this form was
                    built after #623 swept the other fourteen lists, so it inherited none of that work.
                    The filter is the shared `Input`; the list stays checkboxes because this is a
                    MULTI-select, which the member typeahead (#617, one pick) does not model. */}
                <Input value={spaceFilter} onChange={(e) => setSpaceFilter(e.target.value)}
                  placeholder={t("adminApi.spaceFilter")} aria-label={t("adminApi.spaceFilter")}
                  data-testid="api-key-space-filter" />
                <ListBox className="flex flex-col gap-1" data-testid="api-key-space-list">
                  {shownSpaces.map((sp) => (
                    <label key={sp.id} className="flex items-center gap-2 text-sm" data-testid="api-key-space-option">
                      <input type="checkbox" checked={pickedSpaces.includes(sp.id)}
                        onChange={() => toggle(pickedSpaces, setPickedSpaces, sp.id)}
                        data-testid={`api-key-space-${sp.id}`} />
                      {/* #661 the same component the switcher and the sidebar draw a space with,
                          at the size the switcher's list uses. Drawing it here by hand would be a second
                          rendering of the same thing, and one of the two would go stale — which is the
                          whole reason SpaceIcon exists. The data was already on the wire (`/spaces`
                          carries `iconImageUrl`); nothing was fetched to make this appear. */}
                      <SpaceIcon id={sp.id} name={sp.name} image={sp.iconImageUrl} size={18} />
                      <span className="min-w-0 truncate">{sp.name}</span>
                    </label>
                  ))}
                </ListBox>
                {/* A narrowed list must not read as a short one. Without this, "3 spaces" looks like the
                    whole tenant and a key gets issued against a roster the reader thinks is complete. */}
                {hidden > 0 && (
                  <span className="text-xs text-fg-dim" data-testid="api-key-space-hidden">
                    {t("adminApi.spaceFilterHidden", { count: hidden })}
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-fg-dim">{t("adminApi.narrowCaps")}</span>
                {/* #667 / ADR-221 §1: resource type × read/write, which is the shape a GitHub fine-grained
                    PAT and a Stripe restricted key both take, and the shape the ruling asked for. It
                    replaced six borrowed role verbs that could not name a resource at all — "read pages
                    but never the member roster" was unsayable.

                    Three radios per row rather than a checkbox and a second control: `none` is a real
                    state and the default, and a two-control row would let somebody pick `write` while
                    leaving the type unticked. The server declares the same vocabulary and refuses
                    anything else (`unknown_type` / `unknown_action` / `unreachable_permission`), so this
                    list going stale is a refusal rather than a silent acceptance. */}
                {/* #667 ①: ONE grid for all twenty-one rows, so the columns line up by
                    construction. They used to be twenty-one flex rows, and the three types with no
                    `write` cell (search, recent, audit) let their two radios slide 69px right — a
                    reader running an eye down the list caught on those three. A spacer of the same
                    width would have to guess it, in two languages; a shared grid track cannot be wrong.
                    The row keeps its element (and its testid) via `contents`, so its cells are the
                    grid's children and every column is measured across the whole table. */}
                <div
                  className="grid grid-cols-[minmax(0,1fr)_max-content_max-content_max-content] items-center gap-x-3 gap-y-1 text-sm"
                  data-testid="api-key-perm-list"
                >
                  {RESOURCE_TYPE_OPTIONS.map((o) => (
                    <div key={o.id} className="contents" data-testid="api-key-perm-row">
                      <span className="min-w-0 truncate">{t(`adminApi.type.${o.id}`)}</span>
                      {(["none", "read", "write"] as const).map((a) => {
                        // a type no route requires `write` on is a cell the server refuses — offering it
                        // would be the #642 defect in a new place: a choice that reaches nothing. The
                        // COLUMN still exists though: an empty cell says "there is no write here" as
                        // plainly as an absent one, and keeps the two to its left where the eye expects.
                        if (a === "write" && !o.writable) return <span key={a} aria-hidden="true" />;
                        const on = a === "none" ? matrix[o.id] === undefined : matrix[o.id] === a;
                        return (
                          <label key={a} className="flex flex-none items-center gap-1 text-xs text-fg-dim">
                            <input type="radio" name={`api-key-perm-${o.id}`} checked={on}
                              onChange={() => setMatrix((m) => {
                                const next = { ...m };
                                if (a === "none") delete next[o.id]; else next[o.id] = a;
                                return next;
                              })}
                              data-testid={`api-key-perm-${o.id}-${a}`} />
                            <span>{t(`adminApi.action_${a}`)}</span>
                          </label>
                        );
                      })}
                    </div>
                  ))}
                </div>
                {/* #667 §5: the scope Select is gone while a matrix is picked, so this is where the
                    reader learns what it became. Saying it rather than leaving them to work out that one
                    write cell makes the whole key a write key. */}
                {matrixPicked && (
                  <span className="text-xs text-fg-dim" data-testid="api-key-derived-scope">
                    {t("adminApi.derivedScope", { scope: t(`adminApi.scope_${derivedScope(matrix)}`) })}
                  </span>
                )}
                {/* §10: an administrative type shortens the default lifetime. Said out loud, because a
                    default that moves under somebody without explanation reads as a bug. */}
                {adminPicked && !expiryTouched && (
                  <span className="text-xs text-fg-dim" data-testid="api-key-admin-expiry-note">
                    {t("adminApi.adminExpiryNote")}
                  </span>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* #638: the box this invented is now shared — the invite and password-setup links were the two
          that had neither the warning nor the copy button, and they are the ones that strand people. */}
      {created && <OneTimeSecret value={created.plaintext} testId="api-key-plaintext" />}

      <ListBox className="mt-5" data-testid="api-key-list">
        {keys.map((k) => (
          <ListRow key={k.id} data-testid="api-key-item">
            <span className="min-w-[48px] flex-none rounded-full border border-border px-2 py-px text-center text-[11px] uppercase tracking-[0.03em] text-fg-dim data-[scope=write]:border-[var(--accent)] data-[scope=write]:text-[var(--accent)]" data-scope={k.scope}>{t(`adminApi.scope_${k.scope}`)}</span>
            <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">{k.name}</span>
            {/* #495: the admin view names WHO owns the key (name, or the sub when the name is null) */}
            {admin && <span className="flex-none max-w-[9rem] truncate text-xs text-fg-dim" data-testid="api-key-owner" data-tip={k.ownerName ?? k.ownerUserId}>{k.ownerName ?? k.ownerUserId}</span>}
            {/* #658: a confined key says so, in one mark rather than a row of chips — #579/#603 ruled
                that these rows do not grow taller, and a list of spaces and verbs would do exactly that.
                The detail lives in the tooltip. An unconfined key carries nothing at all: most keys are
                unconfined, and marking them would make the exception look ordinary. */}
            {(k.spaces || k.capabilities || k.permissions) && (
              <span
                className="flex-none rounded-full border border-border px-2 py-px text-[11px] text-fg-dim"
                data-testid="api-key-confinement"
                data-tip={confinementTip(k, t)}
              >{confinementLabel(k, t)}</span>
            )}
            {/* #667 / ADR-221 §3: a key issued under the old model keeps behaving exactly as it did
                the mapping onto resource types cannot exist without widening, so v1 keys are frozen
                rather than remapped. Marked so somebody taking inventory can see WHICH keys still read
                by the old rule, and re-issue when they choose to. Never automatic: silently upgrading a
                credential handed to an outside service is what §3 exists to prevent. */}
            {k.permissionModel === 1 && (k.capabilities || k.spaces) && (
              <span className="flex-none rounded-full border border-border px-2 py-px text-[11px] text-fg-dim"
                data-testid="api-key-legacy-model" data-tip={t("adminApi.legacyModelTip")}>
                {t("adminApi.legacyModel")}
              </span>
            )}
            <code className="flex-none font-mono text-xs text-fg-dim">{k.keyPrefix}…</code>
            <LastUsed at={k.lastUsedAt} />
            {/* #504: red at rest (hover-only red is against the policy) + confirm before the kill. */}
            <IconButton aria-label={t("adminApi.revoke")} data-testid="api-key-revoke" variant="danger"
              onClick={() => setRevoking({ id: k.id, name: k.name })}>
              <Trash2 size={14} />
            </IconButton>
          </ListRow>
        ))}
        {keys.length === 0 && <p className="text-xs text-fg-dim">{emptyText ?? t("adminApi.empty")}</p>}
      </ListBox>
      {/* #504: the revoke confirm — names the key, danger tone. */}
      <ConfirmDialog
        open={revoking !== null}
        message={revoking ? t("adminApi.revokeConfirm", { name: revoking.name }) : ""}
        confirmTestId="api-key-revoke-confirm"
        confirmLabel={t("adminApi.revoke")}
        onClose={() => setRevoking(null)}
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking.id, { onSuccess: () => notify.success(t("toast.linkRevoked")), onError: () => notify.error(t("toast.actionFailed")) });
          setRevoking(null);
        }}
      />
    </>
  );
}
