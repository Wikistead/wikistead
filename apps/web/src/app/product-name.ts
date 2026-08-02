// #575 / ADR-200 rev3 slice A: what to call the product on this deployment.
//
// Two layers, and the precedence is #143's: a tenant's own display name WINS; the deployment name is
// the fallback; the literal is the last resort for the frames that render before /branding answers.
// One hook so the answer cannot differ between the header, the sign-in card and an error toast.
import { useEffect } from "react";
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

/**
 * #575 slice C: the browser tab.
 *
 * `index.html` is served before any tenant is known, so its `<title>` can only ever be a static
 * fallback — that limit is ADR-200 rev3's, and it is why this runs in the app instead. Once branding
 * has resolved, the tab says what this workspace is called; a renamed deployment or a renamed tenant
 * both reach it. The PWA manifest cannot be reached this way at all (it is fetched as a file, not
 * rendered), which is stated in the ADR rather than worked around.
 */
export function useDocumentTitle(): void {
  const name = useBrandName();
  useEffect(() => {
    if (name) document.title = name;
  }, [name]);
}
