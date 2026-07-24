import { useTranslation } from "react-i18next";
import { FilePlus } from "lucide-react";

// #274 the ONE new-page control, shared by the member sidebar and the guest (edit share-link)
// sidebar so both surfaces have the identical operation model and look: click → create a blank
// "Untitled" page immediately → open it in the editor (naming happens there). The surfaces differ only
// in what the click DOES server-side (member: draft create; guest: the atomic create-publish path with
// its caps) and in the adjacent chrome (the template ▾ stays member-only — template non-leak).
export function NewPageButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="flex cursor-pointer rounded-sm p-1 text-fg-dim transition-colors duration-[120ms] hover:bg-panel-2 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      data-tip={t("sidebar.newPage")}
      aria-label={t("sidebar.newPage")}
      data-testid="new-page"
      disabled={disabled}
      onClick={onClick}
    >
      <FilePlus size={15} />
    </button>
  );
}
