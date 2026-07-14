import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useEnrollment, useSetEnrollPolicy, useAddEnrollDomain, useVerifyEnrollDomain, useRemoveEnrollDomain } from "../data/queries";
import { Button, IconButton } from "../ui/Button";
import { RadioGroup } from "../ui/RadioGroup";
import { Input } from "../ui/Input";
import { notify } from "../ui/toast";

const label = "mb-1 mt-3.5 block text-sm text-fg-dim";

// #101 / ADR-034: OIDC enrolment policy — who a successful login auto-enrols. `domain` requires DNS-
// proven ownership of the email domain (add → publish the TXT record shown → Verify), so an email-domain
// claim is never trusted un-verified; `groups` intersects an allow-list with the normalised groups claim.
// All hooks are declared unconditionally at the top (no early return) — rules-of-hooks safe.
export function AdminEnrollmentSection() {
  const { t } = useTranslation();
  const enrollment = useEnrollment();
  const setPolicy = useSetEnrollPolicy();
  const addDomain = useAddEnrollDomain();
  const verifyDomain = useVerifyEnrollDomain();
  const removeDomain = useRemoveEnrollDomain();

  const [policy, setPolicyValue] = useState("invite_only");
  const [groups, setGroups] = useState("");
  const [newDomain, setNewDomain] = useState("");

  // Seed the form from the stored config ONCE. A refetch (after add/verify a domain) must NOT reset the
  // in-progress policy/groups edits — otherwise picking "domain", adding a domain (which refetches) would
  // snap the selector back to the saved value and hide the domain manager mid-task.
  const data = enrollment.data;
  const seeded = useRef(false);
  useEffect(() => {
    if (!data || seeded.current) return;
    seeded.current = true;
    setPolicyValue(data.policy);
    setGroups(data.allowedGroups.join(", "));
  }, [data]);

  const onSave = () => {
    const allowedGroups = groups.split(",").map((g) => g.trim()).filter(Boolean);
    setPolicy.mutate({ policy, allowedGroups }, {
      onSuccess: () => notify.success(t("toast.saved")),
      onError: () => notify.error(t("toast.actionFailed")),
    });
  };
  const onAddDomain = () => {
    const d = newDomain.trim();
    if (!d) return;
    addDomain.mutate(d, {
      onSuccess: () => { notify.success(t("toast.saved")); setNewDomain(""); },
      onError: () => notify.error(t("adminEnroll.domainAddFailed")),
    });
  };
  const onVerify = (domain: string) => {
    verifyDomain.mutate(domain, {
      onSuccess: () => notify.success(t("adminEnroll.verified")),
      onError: () => notify.error(t("adminEnroll.verifyFailed")),
    });
  };

  const policyOptions = (data?.policies ?? ["open", "domain", "groups", "invite_only"]).map((p) => ({ value: p, label: t(`adminEnroll.policy_${p}`) }));

  return (
    <div className="mt-8 border-t border-border pt-6" data-testid="admin-enrollment">
      <h3 className="mt-0 text-base font-semibold">{t("adminEnroll.title")}</h3>
      <p className="mt-0 text-sm text-fg-dim">{t("adminEnroll.body")}</p>

      <label className={label}>{t("adminEnroll.policyLabel")}</label>
      {/* #389 / ADR-146: policy needs a description per option → card radiogroup (was a Select whose
          hint only showed for the CURRENT pick). Same per-option test-ids (enroll-policy-<value>). */}
      <RadioGroup
        variant="card"
        value={policy}
        onChange={setPolicyValue}
        ariaLabel={t("adminEnroll.policyLabel")}
        testId="enroll-policy"
        options={policyOptions.map((o) => ({ ...o, description: t(`adminEnroll.policyHint_${o.value}`) }))}
      />

      {policy === "groups" && (
        <>
          <label className={label}>{t("adminEnroll.groupsLabel")}</label>
          <Input value={groups} onChange={(e) => setGroups(e.target.value)} placeholder="engineering, admins" data-testid="enroll-groups" />
        </>
      )}

      <div className="mt-4">
        <Button variant="primary" size="sm" disabled={setPolicy.isPending} onClick={onSave} data-testid="enroll-save">{t("common.save")}</Button>
      </div>

      {policy === "domain" && (
        <div className="mt-5">
          <label className={label}>{t("adminEnroll.domainsLabel")}</label>
          <div className="flex items-center gap-2">
            <Input className="flex-1" value={newDomain} onChange={(e) => setNewDomain(e.target.value)} placeholder="corp.example.com" data-testid="enroll-domain-input" />
            <Button variant="default" size="sm" disabled={addDomain.isPending} onClick={onAddDomain} data-testid="enroll-domain-add">{t("adminEnroll.addDomain")}</Button>
          </div>
          <div className="mt-2 flex flex-col gap-2" data-testid="enroll-domain-list">
            {(data?.domains ?? []).map((d) => (
              <div key={d.domain} className="rounded-md border border-border p-2 text-sm" data-testid="enroll-domain-item">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{d.domain}</span>
                  <span className={d.verified ? "text-[0.8em] text-[#2da44e]" : "text-[0.8em] text-fg-dim"}>{d.verified ? t("adminEnroll.verifiedBadge") : t("adminEnroll.pendingBadge")}</span>
                  {!d.verified && <Button variant="default" size="sm" disabled={verifyDomain.isPending} onClick={() => onVerify(d.domain)} data-testid="enroll-domain-verify">{t("adminEnroll.verify")}</Button>}
                  <IconButton aria-label={t("adminEnroll.removeDomain")} data-testid="enroll-domain-remove" onClick={() => removeDomain.mutate(d.domain)}>×</IconButton>
                </div>
                {!d.verified && (
                  <p className="m-0 mt-1 break-all text-xs text-fg-dim">{t("adminEnroll.dnsHint")} <code>{d.challengeRecord}</code> = <code>{d.challengeValue}</code></p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
