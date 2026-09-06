// #1169: the page-level loading state. Twelve surfaces used to render a bare
// `<div style={{ padding: 16 }}>{t("common.loading")}</div>` — the whole page being that one line,
// pinned to the top-left corner. This is the one place that shape is now written, so the twelve cannot
// drift apart again (the same reasoning #976 applied to LoadFailed's page appearance).
//
// NOT for the sixteen INLINE loading lines (a dialog, a settings tab, a side panel, a tree row): those
// sit inside chrome that already bounds them, and a centered animating logo inside a dropdown would be
// the mark dancing in a corner of someone else's box. They keep the plain line.
//
// The mark is the PRODUCT's mark, never the tenant's uploaded logo: at this moment the app usually does
// not know yet which tenant it is (`status === "loading"` is precisely the answer not having arrived),
// and a custom logo here would flash and swap once it did.
//
// The text stays. It is what a screen reader announces, and `role="status"` + `aria-live="polite"` is
// how that reaches a reader who never sees the animation at all.
import { useTranslation } from "react-i18next";
import { WikisteadMark } from "../app/BrandLockup";

export function FullPageLoader({ testId = "full-page-loader" }: { testId?: string } = {}) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={testId}
      className="flex min-h-[60vh] w-full flex-col items-center justify-center gap-4 p-6"
    >
      {/* `text-fg-dim` on the wrapper, not the mark: the artwork strokes with `currentColor`, so the
          mark and the word under it stay the same weight of grey in either theme. */}
      <span className="flex flex-col items-center gap-4 text-fg-dim">
        <WikisteadMark className="wks-logo-draw block h-14 w-14 flex-none" testId={`${testId}-mark`} />
        <span className="text-sm">{t("common.loading")}</span>
      </span>
    </div>
  );
}
