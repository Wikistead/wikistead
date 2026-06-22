import styles from "./AppShell.module.css";

// Wikistead brand lockup (icon + wordmark). Per the brand guide, only the ICON is
// a fixed asset — the "Wikistead" wordmark is CSS text (translatable, selectable,
// crisp at any size, follows dark/light via currentColor). icon.svg is inlined so
// it inherits currentColor and needs no extra request. Used as the default header
// brand when a tenant has set no logo/display name. testid "brand" for e2e.
export function BrandLockup() {
  return (
    <span className={styles.brand} data-testid="brand">
      <svg className={styles.brandIcon} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Wikistead">
        <path d="M8 21 L24 7 L40 21 L40 35 Q40 37 38 37 L29 37 L24 43 L24 37 L10 37 Q8 37 8 35 Z" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinejoin="round" strokeLinecap="round" />
        <path d="M17 24 L31 24 M17 30 L26 30" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
      </svg>
      <span className={styles.brandName}>Wikistead</span>
    </span>
  );
}
