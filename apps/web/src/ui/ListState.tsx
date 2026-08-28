import type { ReactNode } from "react";
import { LoadFailed } from "./LoadFailed";

// ADR-266 §3.1: the chokepoint. Every hand-rolled `isLoading ? … : isError ? … : length === 0 ? … : …`
// ternary in this tree is a place a future round of #888/#895 can happen again — a surface that does
// not decide which of the three states it is showing cannot render an empty list for a failed fetch.
//
// `loading` is optional on purpose: several existing surfaces (RelatedPanel's sections) never drew a
// dedicated loading state — `data` stays undefined and `isEmpty(fallback)` decides — and migrating them
// onto this component must not invent one. Supply `loading` only where the surface already had one.
export interface ListStateQuery<T> {
  isLoading?: boolean;
  isError: boolean;
  data: T | undefined;
  refetch?: () => unknown;
}

export function ListState<T>({
  query,
  fallback,
  isEmpty,
  loading,
  empty,
  variant = "inline",
  testId = "load-failed",
  children,
}: {
  query: ListStateQuery<T>;
  /** stands in for `query.data` before it arrives or on failure, so `isEmpty`/`children` never see undefined */
  fallback: T;
  isEmpty: (data: T) => boolean;
  loading?: ReactNode;
  empty: ReactNode;
  variant?: "inline" | "page";
  testId?: string;
  children: (data: T) => ReactNode;
}) {
  if (loading !== undefined && query.isLoading) return <>{loading}</>;
  if (query.isError) {
    return <LoadFailed testId={testId} variant={variant} onRetry={query.refetch ? () => { void query.refetch!(); } : undefined} />;
  }
  const data = query.data ?? fallback;
  if (isEmpty(data)) return <>{empty}</>;
  return <>{children(data)}</>;
}
