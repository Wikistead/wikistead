// #578 bounce ③: one add-flow — pick who, then pick what — wherever a role is conferred.
//
// The bounce asked for the tenant screen to add roles "the same way" the space screen does. The part
// that can be shared without contradicting an earlier ruling is the FLOW itself: grantee type → find
// the grantee → choose the role → add. The space screen offers both types; the tenant screen offers
// groups here (people get their roles on their own row, which #579 ruled and pinned: "the member row
// is the only place a tenant role is given or taken"). `types` is what makes the difference visible in
// one line instead of in two screens' worth of markup.
//
// This owns no state and knows no endpoints: the caller keeps the query, the picked candidate, the
// typed group name and the role, and decides what "add" means. That is what lets the same form drive
// two different mechanisms underneath (a space grant vs a tenant role assignment) without either
// screen growing a copy of the other's logic.
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import { FormRow } from "../ui/FormRow";
import { Select } from "../ui/Select";
import { MemberSearchInput, type MemberCandidate } from "../ui/MemberSearchInput";
import { GroupPicker } from "./GroupPicker";

export interface GranteeRoleFormProps {
  /** Which grantee types this surface offers. A single entry hides the type control entirely. */
  types: readonly ("user" | "group")[];
  type: "user" | "group";
  onTypeChange: (t: "user" | "group") => void;
  /** user half */
  query: string;
  onQueryChange: (q: string) => void;
  picked: { grantee: string; label: string } | null;
  onPick: (c: MemberCandidate | null) => void;
  candidates: readonly MemberCandidate[];
  /** group half */
  groupName: string;
  onGroupNameChange: (n: string) => void;
  knownGroups: readonly string[];
  /** what can be conferred here, already merged (built-ins and custom roles are one list — #536) */
  roleOptions: readonly { value: string; label: string }[];
  role: string;
  onRoleChange: (v: string) => void;
  onAdd: () => void;
  pending?: boolean;
  /** `${testId}-type|-input|-group|-role|-add` */
  testId: string;
  /** The role Select's id, when a surface already had one worth keeping (the space screen's
   *  `space-grant-capability` predates this component and is what its specs click). */
  roleTestId?: string;
}

export function GranteeRoleForm(p: GranteeRoleFormProps) {
  const { t } = useTranslation();
  const ready = p.type === "group" ? p.groupName.trim() !== "" : p.picked !== null;
  return (
    <FormRow className="mb-6">
      {p.types.length > 1 && (
        <Select
          value={p.type}
          onChange={(v) => p.onTypeChange(v as "user" | "group")}
          ariaLabel={t("spaceMembers.granteeType")}
          testId={`${p.testId}-type`}
          options={p.types.map((v) => ({ value: v, label: v === "user" ? t("spaceMembers.typeUser") : t("spaceMembers.typeGroup") }))}
        />
      )}
      {p.type === "group" ? (
        <GroupPicker
          value={p.groupName}
          onChange={p.onGroupNameChange}
          known={p.knownGroups}
          testId={`${p.testId}-group`}
          ariaLabel={t("spaceMembers.typeGroup")}
        />
      ) : (
        <MemberSearchInput
          query={p.query}
          onQueryChange={p.onQueryChange}
          picked={p.picked}
          onPick={p.onPick}
          candidates={[...p.candidates]}
          // #578 bounce ③: this form takes a member OR a group — the type beside it switches which —
          // and the field used to say "Search members…" while the group half said "or type a group
          // name", an "or" left over from the stacked select that is gone. Both halves name the same
          // act now, so the screen says what it accepts instead of making somebody find the switch.
          placeholder={t("common.granteeSearch")}
          ariaLabel={t("common.granteeSearch")}
          inputTestId={`${p.testId}-input`}
          listTestId={`${p.testId}-candidates`}
          itemTestId={`${p.testId}-candidate`}
        />
      )}
      {/* #536 / ADR-188 §6: built-in roles and custom roles are ONE list. They stay two mechanisms
          underneath, which is an implementation fact and was never a reason to make someone choose
          which of two controls to use. The caller encodes the kind in the value so its handler
          dispatches without guessing. */}
      <Select
        value={p.role}
        onChange={p.onRoleChange}
        ariaLabel={t("spaceMembers.capability")}
        testId={p.roleTestId ?? `${p.testId}-role`}
        options={[...p.roleOptions]}
      />
      <Button variant="primary" disabled={!ready || p.pending} onClick={p.onAdd} data-testid={`${p.testId}-add`}>
        {t("spaceMembers.add")}
      </Button>
    </FormRow>
  );
}
