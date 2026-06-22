import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import {
  useSpaceAccess, useGrantSpaceAccess, useRevokeSpaceAccess, useMemberCandidates,
  type PageRelation,
} from "../data/queries";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { notify } from "../ui/toast";
import styles from "./SpaceMembersTab.module.css";

interface SpaceCtx { spaceId: string; name: string }
const CAPS: PageRelation[] = ["view", "edit", "manage"];

// Space Members & Permissions (Phase 5b). manage-gated end-to-end: the screen is
// only reachable by a manager (SpaceSettingsLayout), and every grant/revoke/list
// re-checks space#manage server-side. Granting is the inheritance root — it widens
// access to every published page in the space.
export function SpaceMembersTab() {
  const { t } = useTranslation();
  const { spaceId } = useOutletContext<SpaceCtx>();
  const access = useSpaceAccess(spaceId);
  const grant = useGrantSpaceAccess(spaceId);
  const revoke = useRevokeSpaceAccess(spaceId);

  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<{ grantee: string; label: string } | null>(null);
  const [capability, setCapability] = useState<PageRelation>("view");
  const candidates = useMemberCandidates(spaceId, picked ? "" : query);

  const add = () => {
    if (!picked) return;
    grant.mutate({ grantee: picked.grantee, capability }, {
      onSuccess: () => notify.success(t("toast.accessGranted")),
      onError: () => notify.error(t("toast.actionFailed")),
    });
    setPicked(null);
    setQuery("");
  };

  const grants = (access.data ?? []).slice().sort((a, b) => CAPS.indexOf(b.capability) - CAPS.indexOf(a.capability));
  const label = (g: string) => g.startsWith("group:")
    ? `${g.replace(/^group:/, "").replace(/#member$/, "")} (${t("spaceMembers.group")})`
    : g.replace(/^user:/, "");

  return (
    <div className={styles.wrap} data-testid="space-members">
      <h2 style={{ marginTop: 0 }}>{t("spaceMembers.title")}</h2>
      <p className={styles.body}>{t("spaceMembers.body")}</p>

      <div className={styles.addRow}>
        <div className={styles.typeahead}>
          <input
            className={styles.input}
            data-testid="space-grant-input"
            value={picked ? picked.label : query}
            placeholder={t("spaceMembers.addPlaceholder")}
            aria-label={t("spaceMembers.addPlaceholder")}
            onChange={(e) => { setPicked(null); setQuery(e.target.value); }}
          />
          {!picked && query.trim().length > 0 && (candidates.data?.length ?? 0) > 0 && (
            <ul className={styles.candidates} data-testid="space-grant-candidates">
              {candidates.data!.map((c) => (
                <li key={c.sub}>
                  <button type="button" className={styles.candidate} data-testid="space-grant-candidate"
                    onClick={() => { setPicked({ grantee: `user:${c.sub}`, label: c.displayName || c.sub }); setQuery(""); }}>
                    <span className={styles.candName}>{c.displayName || c.sub}</span>
                    {c.displayName && <span className={styles.candSub}>{c.sub}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Select
          value={capability}
          onChange={(v) => setCapability(v as PageRelation)}
          ariaLabel={t("spaceMembers.capability")}
          testId="space-grant-capability"
          size="sm"
          options={CAPS.map((c) => ({ value: c, label: t(`spaceMembers.${c}`) }))}
        />
        <Button variant="primary" size="sm" disabled={!picked || grant.isPending} onClick={add} data-testid="space-grant-add">{t("spaceMembers.add")}</Button>
      </div>

      <div className={styles.list} data-testid="space-grant-list">
        {grants.map((g) => (
          <div key={`${g.grantee}:${g.capability}`} className={styles.item} data-testid="space-grant-item">
            <span className={styles.cap} data-cap={g.capability}>{t(`spaceMembers.${g.capability}`)}</span>
            <span className={styles.grantee}>{label(g.grantee)}</span>
            <button type="button" className={styles.revoke} data-danger="" aria-label={t("spaceMembers.revoke")} data-testid="space-grant-revoke"
              onClick={() => revoke.mutate({ grantee: g.grantee, capability: g.capability }, {
                onSuccess: () => notify.success(t("toast.accessRevoked")),
                onError: () => notify.error(t("toast.actionFailed")),
              })}>
              <X size={14} />
            </button>
          </div>
        ))}
        {grants.length === 0 && <p className={styles.empty}>{t("spaceMembers.empty")}</p>}
      </div>
    </div>
  );
}
