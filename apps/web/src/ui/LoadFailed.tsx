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
//
// #976: "inline" (the default) is right inside a panel, tab, or dialog — those already bound the
// layout, and a quiet ghost button matches the surrounding chrome. A page-body use has no such
// bounding chrome: the same markup reads as a stray line stuck in the corner, and a ghost button
// next to nothing doesn't read as actionable. "page" centers it with the same min-height/py-8 rhythm
// the loading state on these routes already uses (e.g. WatchListPage's loading vs. error state right
// next to each other), and upgrades the retry to `variant="default"` so it reads as the way forward.
export function LoadFailed({
  onRetry,
  testId = "load-failed",
  variant = "inline",
}: {
  onRetry?: () => void;
  testId?: string;
  variant?: "inline" | "page";
}) {
  const { t } = useTranslation();
  if (variant === "page") {
    return (
      <div
        className="flex min-h-[16rem] flex-col items-center justify-center gap-2 py-8 text-center"
        data-testid={testId}
      >
        <span className="text-sm text-fg-dim">{t("common.loadFailed")}</span>
        {onRetry && (
          <Button size="sm" variant="default" data-testid={`${testId}-retry`} onClick={onRetry}>
            {t("common.loadRetry")}
          </Button>
        )}
      </div>
    );
  }
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
