import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAbuseFilterConfig, useUpdateAbuseFilterConfig } from "../data/queries";
import { notify } from "../ui/toast";
import { SETTINGS_WIDTHS } from "./SettingsShell"; // #735: the column width is a named step, not a number

// #491 / ADR-140: tenant-admin config for the publish-boundary abuse filter. The two knobs
// (mass-delete shrink ratio + banned words) were DB-direct-only; this is their UI. tenant#admin only
// (the GET/PATCH re-check, 403 otherwise). Defaults are all-permissive (ratio empty = off, no words), so
// a tenant that never opens this tab keeps zero behavior change. The server normalizes what it stores.
export function AdminModerationTab() {
  const { t } = useTranslation();
  const { data, isLoading } = useAbuseFilterConfig();
  const update = useUpdateAbuseFilterConfig();
  const [ratio, setRatio] = useState("");
  const [words, setWords] = useState("");

  useEffect(() => {
    if (!data) return;
    setRatio(data.shrinkRatio != null ? String(data.shrinkRatio) : "");
    setWords(data.bannedWords.join("\n"));
  }, [data]);

  const save = () => {
    const r = ratio.trim() === "" ? null : Number(ratio);
    const shrinkRatio = typeof r === "number" && Number.isFinite(r) && r > 0 && r <= 1 ? r : null;
    const bannedWords = words.split("\n").map((w) => w.trim()).filter(Boolean);
    update.mutate({ shrinkRatio, bannedWords }, {
      onSuccess: (d) => {
        notify.success(t("toast.saved"));
        if (d) { setRatio(d.shrinkRatio != null ? String(d.shrinkRatio) : ""); setWords(d.bannedWords.join("\n")); }
      },
      onError: () => notify.error(t("toast.actionFailed")),
    });
  };

  return (
    <div data-settings-pane="form" className={SETTINGS_WIDTHS.form} data-testid="admin-moderation">
      <h2 className="mt-0">{t("adminModeration.title")}</h2>
      <p className="mt-0 text-sm text-fg-dim">{t("adminModeration.body")}</p>

      <label className="mt-4 block">
        <span className="block text-sm text-foreground">{t("adminModeration.shrinkLabel")}</span>
        <span className="block text-xs text-fg-dim">{t("adminModeration.shrinkHint")}</span>
        <input
          type="number" min="0" max="1" step="0.05" data-testid="abuse-shrink-ratio"
          className="mt-1 w-32 rounded-md border border-border bg-panel px-2 py-1 text-sm"
          value={ratio} onChange={(e) => setRatio(e.target.value)}
          placeholder={t("adminModeration.off")} disabled={isLoading}
        />
      </label>

      <label className="mt-4 block">
        <span className="block text-sm text-foreground">{t("adminModeration.wordsLabel")}</span>
        <span className="block text-xs text-fg-dim">{t("adminModeration.wordsHint")}</span>
        <textarea
          rows={6} data-testid="abuse-banned-words" spellCheck={false}
          className="mt-1 w-full rounded-md border border-border bg-panel px-2 py-1 font-mono text-sm"
          value={words} onChange={(e) => setWords(e.target.value)} disabled={isLoading}
        />
      </label>

      <button
        type="button" data-testid="abuse-save"
        className="mt-4 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
        onClick={save} disabled={isLoading || update.isPending}
      >
        {t("common.save")}
      </button>
    </div>
  );
}
