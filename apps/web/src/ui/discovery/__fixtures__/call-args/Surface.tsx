import { useTranslation } from "react-i18next";
import { LoadFailed } from "../../../LoadFailed";
import { useBacklinks, type Backlink } from "../../../../data/queries";

// A small local helper, not a react-query hook — its NAME does not start with `use`, so nothing marks
// it as special. Before #1016 the resolver dropped a plain call's arguments entirely, so a chain that
// runs through one of these (rather than reading `backlinks.data` inline) was invisible to it.
function visible(items: readonly Backlink[]): readonly Backlink[] {
  return items.filter((item) => item.title.length > 0);
}

// #1016, guarded: the failure is drawn before the helper-wrapped empty check, same as any other query.
export function GuardedThroughHelper() {
  const { t } = useTranslation();
  const backlinks = useBacklinks("page-1");
  const rows = visible(backlinks.data ?? []);
  return backlinks.isError
    ? <LoadFailed onRetry={() => { void backlinks.refetch(); }} />
    : rows.length === 0 ? <p>{t("backlinks.empty")}</p> : <ul>{rows.map((r) => <li key={r.id}>{r.title}</li>)}</ul>;
}

// #1016, unguarded: the same helper-wrapped chain with no failure check anywhere — before the fix this
// read as `vacuous` (nothing to check); it must now name `backlinks` as the unhandled query.
export function UngatedThroughHelper() {
  const { t } = useTranslation();
  const backlinks = useBacklinks("page-1");
  const rows = visible(backlinks.data ?? []);
  return rows.length === 0 ? <p>{t("related.empty")}</p> : <ul>{rows.map((r) => <li key={r.id}>{r.title}</li>)}</ul>;
}

// #1016, opaque: a zero-argument plain call the resolver has no way to trace to any query — it must
// give up loudly instead of reading as `vacuous`, per ADR-266 §3's "a chain it cannot follow is RED".
function opaqueRows(): string[] {
  return [];
}

export function OpaqueCall() {
  const { t } = useTranslation();
  const rows = opaqueRows();
  return rows.length === 0 ? <p>{t("related.graphEmpty")}</p> : <ul>{rows.map((r) => <li key={r}>{r}</li>)}</ul>;
}
