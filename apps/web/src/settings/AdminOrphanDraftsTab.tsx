import { useState } from "react";
import { ListBox } from "../ui/list-rows";
import { useTranslation } from "react-i18next";
import { ListState } from "../ui/ListState";
import { useOrphanDrafts, useClaimOrphanDraft, useReassignOrphanDraft } from "../data/queries";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { notify } from "../ui/toast";
import { SettingsPane } from "./SettingsShell"; // #735: the pane draws the frame AND the heading

// Orphan-draft admin handoff (#99 / ADR-061), tenant#admin only. On-demand list of stranded
// strict-private drafts (creator gone, no live viewer). Recovery is two-stage: CLAIM grants the
// admin temporary access (so they can open the page and decide an owner), then REASSIGN hands it
// to a live member and revokes the admin's temporary access. All authorization is server-side
// (this tab only calls the admin-gated endpoints); a non-admin never reaches the data (404).
export function AdminOrphanDraftsTab() {
  const { t } = useTranslation();
  const orphans = useOrphanDrafts();
  const claim = useClaimOrphanDraft();
  const reassign = useReassignOrphanDraft();
  // Local UI state: which rows the admin has claimed this session, and the new-owner input.
  const [claimed, setClaimed] = useState<Record<string, boolean>>({});
  const [owner, setOwner] = useState<Record<string, string>>({});

  return (
    <SettingsPane width="list" testId="admin-orphans" title={t("adminOrphans.title")} description={t("adminOrphans.body")}>

      {/* ADR-266 §3.1: an admin reading "no orphaned drafts" acts on it — the chokepoint means a
          failed fetch can no longer read as that answer. */}
      <ListState
        query={orphans}
        fallback={[]}
        isEmpty={(list) => list.length === 0}
        loading={<p className="text-sm text-fg-dim">{t("common.loading")}</p>}
        empty={<p className="text-sm text-fg-dim" data-testid="admin-orphans-empty">{t("adminOrphans.empty")}</p>}
        testId="admin-orphans-failed"
      >
        {(list) => (
        <ListBox>
          {/* #623 slice 10: the shared box from #639 — the same 26rem everywhere, so a long list
              scrolls inside itself instead of growing the page. The server bound landed in slice 4; the
              container waited until #639 settled, so this did not become a second one. */}
        <ul className="mt-4 list-none p-0">
            {list.map((o) => (
              <li key={o.id} className="border-b border-border py-3" data-testid="admin-orphan-row">
                <div className="font-medium">{o.title || t("adminOrphans.untitled")}</div>
                <div className="text-xs text-fg-dim">{new Date(o.createdAt).toLocaleDateString()}</div>
                {!claimed[o.id] ? (
                  <Button
                    size="sm"
                    className="mt-2"
                    onClick={() =>
                      claim.mutate(o.id, {
                        onSuccess: () => { setClaimed((c) => ({ ...c, [o.id]: true })); notify.success(t("adminOrphans.claimed")); },
                        onError: () => notify.error(t("toast.actionFailed")),
                      })
                    }
                  >
                    {t("adminOrphans.claim")}
                  </Button>
                ) : (
                  <div className="mt-2 flex items-center gap-2">
                    <Input
                      inputSize="sm"
                      value={owner[o.id] ?? ""}
                      onChange={(e) => setOwner((s) => ({ ...s, [o.id]: e.target.value }))}
                      placeholder={t("adminOrphans.newOwnerPlaceholder")}
                      aria-label={t("adminOrphans.newOwnerPlaceholder")}
                    />
                    <Button
                      size="sm"
                      disabled={!(owner[o.id] ?? "").trim()}
                      onClick={() =>
                        reassign.mutate(
                          { pageId: o.id, to: (owner[o.id] ?? "").trim() },
                          {
                            onSuccess: () => notify.success(t("adminOrphans.reassigned")),
                            onError: () => notify.error(t("toast.actionFailed")),
                          },
                        )
                      }
                    >
                      {t("adminOrphans.reassign")}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
      </ListBox>
        )}
      </ListState>
    </SettingsPane>
  );
}
