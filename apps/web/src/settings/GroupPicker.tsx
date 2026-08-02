// #578 / ADR-201 rev3 slice 6: naming a group, once.
//
// Both surfaces that confer a role on an IdP group — the space Members tab and the tenant Roles tab —
// need the same control, and the ruling on OQ4 gave it two halves: pick a group the directory has
// already produced, or type a name nobody carries yet (which is the one thing the retired mapping form
// could do that a picker could not). Two copies of that would drift, and the drift would show up as
// "the tenant screen lets me declare a group and the space screen doesn't", which is the class of
// difference this whole ticket exists to remove.
//
// The unconfirmed marker is the point of the typed half: a name the identity provider has not returned
// must not look identical to one it has. The grant applies the moment somebody carrying it signs in —
// that is what the note says, rather than implying the name is wrong.
import { useTranslation } from "react-i18next";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";

export function GroupPicker({
  value, onChange, known, testId, ariaLabel,
}: {
  value: string;
  onChange: (name: string) => void;
  known: readonly string[];
  /** `${testId}` selects, `${testId}-name` types, `${testId}-unconfirmed` is the marker. */
  testId: string;
  ariaLabel: string;
}) {
  const { t } = useTranslation();
  const isKnown = known.includes(value);
  return (
    <span className="flex flex-col gap-1">
      <Select
        size="sm"
        // a typed name is not one of the options, so the Select shows its placeholder rather than
        // silently appearing to have selected something
        value={isKnown ? value : ""}
        onChange={onChange}
        ariaLabel={ariaLabel}
        testId={testId}
        options={[
          { value: "", label: t("spaceMembers.selectGroup") },
          ...known.map((g) => ({ value: g, label: g })),
        ]}
      />
      <Input
        inputSize="sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("spaceMembers.groupNamePlaceholder")}
        aria-label={t("spaceMembers.groupNamePlaceholder")}
        data-testid={`${testId}-name`}
      />
      {value && !isKnown && (
        <span className="text-[11px] text-fg-dim" data-testid={`${testId}-unconfirmed`}>
          {t("spaceMembers.groupUnconfirmed")}
        </span>
      )}
    </span>
  );
}
