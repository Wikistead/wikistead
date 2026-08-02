import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RadioGroup } from "../ui/RadioGroup";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { notify } from "../ui/toast";
import { useSaveTemplate, type TemplateScope } from "../data/queries";

// #248 / ADR-110: "Save as template" — snapshot this page's published content as a reusable template.
// Scope selects the audience (personal default). A shared scope (space/tenant) shows an explicit warning
// that the content becomes visible to that audience (it is an intentional re-publish). The server
// view-gates the source and writes the FGA tuples; this dialog only collects name + scope.
const SCOPES: TemplateScope[] = ["personal", "space", "tenant"];

export function SaveTemplateDialog({
  open, pageId, spaceId, defaultName, onClose,
}: { open: boolean; pageId: string | null; spaceId: string | null; defaultName: string; onClose: () => void }) {
  const { t } = useTranslation();
  const save = useSaveTemplate();
  const [name, setName] = useState(defaultName);
  const [scope, setScope] = useState<TemplateScope>("personal");

  // Reset the form each time the dialog opens (the default name follows the current page title).
  useEffect(() => { if (open) { setName(defaultName); setScope("personal"); } }, [open, defaultName]);

  const submit = () => {
    if (!pageId || !name.trim() || save.isPending) return;
    save.mutate(
      { fromPageId: pageId, name: name.trim(), scope, spaceId: scope === "space" ? spaceId : null },
      {
        onSuccess: () => { notify.success(t("template.saved", { name: name.trim() })); onClose(); },
        onError: () => notify.error(t("template.saveFailed")),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="save-template-dialog" className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{t("template.saveTitle")}</DialogTitle>
          <DialogDescription>{t("template.saveDesc")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex flex-col gap-3">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("template.namePlaceholder")}
            data-testid="template-name"
          />
          {/* #587: the DS card radiogroup — each option carries a description line, which is exactly
              what `variant="card"` is for. The native <input type="radio"> rows it replaces had no
              shared styling with the rest of the app. */}
          <RadioGroup
            variant="card"
            value={scope}
            onChange={(v) => setScope(v as (typeof SCOPES)[number])}
            ariaLabel={t("template.scopeLabel")}
            testId="template-scope"
            options={SCOPES.map((s) => ({
              value: s,
              label: t(`template.scope.${s}`),
              description: t(`template.scopeHint.${s}`),
            }))}
          />
          {scope !== "personal" && (
            <p
              data-testid="template-scope-warning"
              className="rounded-md border border-[color-mix(in_srgb,var(--callout-warning)_45%,transparent)] bg-[color-mix(in_srgb,var(--callout-warning)_10%,transparent)] px-3 py-2 text-[length:var(--text-ui)] text-foreground"
            >
              {t(`template.warning.${scope}`)}
            </p>
          )}
          <DialogFooter className="mt-1">
            <Button variant="default" type="button" onClick={onClose}>{t("common.cancel")}</Button>
            <Button variant="primary" type="submit" data-testid="save-template-submit" disabled={!name.trim() || save.isPending}>
              {t("template.saveAction")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
