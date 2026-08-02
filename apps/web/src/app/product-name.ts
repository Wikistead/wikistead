// #575 / ADR-200 rev3 slice A: what to call the product on this deployment.
//
// Two layers, and the precedence is #143's: a tenant's own display name WINS; the deployment name is
// the fallback; the literal is the last resort for the frames that render before /branding answers.
// One hook so the answer cannot differ between the header, the sign-in card and an error toast.
import { useBranding } from "../data/queries";

export const FALLBACK_PRODUCT_NAME = "Wikistead";

/** The deployment's product name (NOT the tenant's display name — see `useBrandName` for that). */
export function useProductName(): string {
  return useBranding().data?.productName || FALLBACK_PRODUCT_NAME;
}

/** What this workspace is called: the tenant's display name if it has one, else the product name. */
export function useBrandName(): string {
  const b = useBranding().data;
  return b?.displayName || b?.productName || FALLBACK_PRODUCT_NAME;
}
