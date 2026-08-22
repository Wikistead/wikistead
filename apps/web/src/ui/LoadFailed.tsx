import { useTranslation } from "react-i18next";
import { Button } from "./Button";

// #888: a list that could not be fetched is not an empty list.
//
// #500 drew this line for the page tree — a failed request had been swallowed into an empty tree, so
// a space with pages looked like a space with none. The same shape was still on six other surfaces,
// and on two of them it answers a question about access: a share-link list and a permissions list
// that say "nobody" because a request failed tell an admin doing a review that the page is private
// when nothing of the sort was established.
//
// The wording is deliberately generic — it names no resource, so it cannot leak the existence of one
// (#227) — and it always offers the way back, because a dead end in kinder words is still a dead end.
export function LoadFailed({ onRetry, testId = "load-failed" }: { onRetry?: () => void; testId?: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-start gap-1.5 py-2" data-testid={testId}>
      <span className="text-sm text-fg-dim">{t("common.loadFailed")}</span>
      {onRetry && (
        <Button size="sm" variant="ghost" data-testid={`${testId}-retry`} onClick={onRetry}>
          {t("common.loadRetry")}
        </Button>
      )}
    </div>
  );
}
