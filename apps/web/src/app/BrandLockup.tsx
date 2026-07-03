// Wikistead brand mark + lockup. Per the brand guide, only the ICON is a fixed
// asset — the "Wikistead" wordmark is CSS text (translatable, selectable, crisp at
// any size, follows dark/light via currentColor). icon.svg is inlined so it inherits
// currentColor and needs no extra request.

// The icon mark alone. Used as the DEFAULT logo slot in the header when a tenant has
// uploaded no custom logo (#143: the logo slot is always filled — default OR custom —
// and is independent of the name slot). No "brand-logo" testid: that testid is for the
// CUSTOM uploaded <img> only, so removing a custom logo falls back here (brand-logo → 0).
export function WikisteadMark() {
  return (
    <svg className="block h-[22px] w-[22px] flex-none" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Wikistead" data-testid="brand-mark">
      <path d="M8 21 L24 7 L40 21 L40 35 Q40 37 38 37 L29 37 L24 43 L24 37 L10 37 Q8 37 8 35 Z" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinejoin="round" strokeLinecap="round" />
      <path d="M17 24 L31 24 M17 30 L26 30" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  );
}

// Full lockup (icon + wordmark). Kept for standalone/pre-app surfaces that want the
// canonical lockup as one unit. The header composes the two slots itself (#143).
export function BrandLockup() {
  return (
    <span className="inline-flex items-center gap-2 text-foreground" data-testid="brand">
      <WikisteadMark />
      <span className="text-[18px] font-semibold leading-none tracking-[-0.02em]" style={{ fontFamily: '"Plus Jakarta Sans", var(--font)' }}>Wikistead</span>
    </span>
  );
}
