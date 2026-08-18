import { useEffect, useState } from "react";
import { ListRow, ListBox } from "../ui/list-rows";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { useEmbedProviders, useUpdateEmbedProviders } from "../data/queries";
import { Button, IconButton } from "../ui/Button";
import { FormRow } from "../ui/FormRow";
import { Input } from "../ui/Input";
import { notify } from "../ui/toast";
import { SettingsPane } from "./SettingsShell"; // #735: the pane draws the frame AND the heading

const label = "mb-1.5 mt-[18px] block text-sm text-fg-dim";

// #108 bounce: normalise a typed host to the bare lowercase hostname the server + isAllowlistedEmbed
// match (strip scheme/path/port; require a dotted host). Mirrors the server's normalizeEmbedProviders
// so the UI shows exactly what will be stored.
function normalizeHost(input: string): string {
  let h = input.trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/^\.+/, "").replace(/\.+$/, "");
  return /^[a-z0-9.-]+$/.test(h) && h.includes(".") ? h : "";
}

// External-embed host allowlist (#108 / ADR-071). tenant#admin only (the PUT re-checks, 403 otherwise).
// External embeds are OFF by default (empty list ⇒ every embed degrades to a link); an admin opts in
// per host. https is implied. The app's own origin can't be a working embed (the render guard always
// degrades a same-origin URL — sandbox-escape protection), so we block adding it here too.
export function AdminEmbedsTab() {
  const { t } = useTranslation();
  const providers = useEmbedProviders();
  const update = useUpdateEmbedProviders();

  const [hosts, setHosts] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  // Seed once loaded; the query is the source of truth (re-seed if it changes).
  const loaded = providers.data?.providers;
  useEffect(() => { if (loaded) setHosts(loaded); }, [loaded]);

  const ownOrigin = typeof window !== "undefined" ? window.location.hostname.toLowerCase() : "";
  const add = () => {
    const h = normalizeHost(draft);
    if (!h) { notify.error(t("adminEmbeds.invalidHost")); return; }
    if (h === ownOrigin) { notify.error(t("adminEmbeds.ownOrigin")); return; }
    if (hosts.includes(h)) { setDraft(""); return; }
    setHosts([...hosts, h]);
    setDraft("");
  };
  const remove = (h: string) => setHosts(hosts.filter((x) => x !== h));
  const dirty = loaded ? (hosts.length !== loaded.length || hosts.some((h, i) => h !== loaded[i])) : hosts.length > 0;
  const save = () =>
    update.mutate(hosts, {
      onSuccess: (r) => { setHosts(r?.providers ?? hosts); notify.success(t("toast.saved")); },
      onError: () => notify.error(t("toast.actionFailed")),
    });

  return (
    <SettingsPane width="form" testId="admin-embeds" title={t("adminEmbeds.title")} description={t("adminEmbeds.body")}>

      <label className={label}>{t("adminEmbeds.addTitle")}</label>
      <FormRow>
        {/* #740`youtube.com` is one of the answers, not the question. */}
        <label className="flex flex-col gap-1 text-xs text-fg-dim">
          {t("adminEmbeds.host")}
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
            placeholder="youtube.com"
            data-testid="embed-host-input"
          />
        </label>
        <Button variant="default" disabled={!draft.trim()} onClick={add} data-testid="embed-host-add">{t("adminEmbeds.add")}</Button>
      </FormRow>

      <ListBox className="mt-5" data-testid="embed-host-list">
        {hosts.map((h) => (
          <ListRow key={h} data-testid="embed-host-item">
            <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">{h}</span>
            {/* #504: red at rest; no confirm — the removal is STAGED (nothing changes until Save),
                so it is undoable in place (exception candidate). */}
            <IconButton aria-label={t("adminEmbeds.remove")} data-testid="embed-host-remove" variant="danger" onClick={() => remove(h)}>
              <Trash2 size={14} />
            </IconButton>
          </ListRow>
        ))}
        {hosts.length === 0 && <p className="text-xs text-fg-dim">{t("adminEmbeds.empty")}</p>}
      </ListBox>

      <div className="mt-5 flex gap-2">
        <Button variant="primary" size="sm" disabled={!dirty || update.isPending} onClick={save} data-testid="embed-save">{t("common.save")}</Button>
      </div>
    </SettingsPane>
  );
}
