// #575 / ADR-200 rev3 slice A: the DEPLOYMENT's product name.
//
// The tenant layer already existed (`tenant_settings.display_name`, read through `getTenantBranding`);
// what had no home at all was the name of the deployment itself, so a self-hosted copy could not say
// what it was called. This is that one value, read from the environment in exactly one place.
//
// Precedence is unchanged and belongs to the caller: a tenant display name WINS over this (#143). This
// is the fallback, not an override.
export const DEFAULT_PRODUCT_NAME = 'Wikistead'

/** The deployment's product name. Blank or unset env → the default; never an empty string. */
export function productName(): string {
  return (process.env.WKS_BRAND_NAME ?? '').trim() || DEFAULT_PRODUCT_NAME
}
