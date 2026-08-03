// #281 review (via #602): each provider sign-in button needs its provider's brand mark (Google's guidelines make the
// logo effectively required, and it aids recognition). The marks are INLINE SVG — no external fetch, so the
// strict self-contained/CSP posture is unchanged. Google's G and Microsoft's tiles are fixed brand colours
// (legible on both themes); GitHub's octocat is monochrome, so it uses currentColor to track the button's
// foreground. aria-hidden — the provider name is already the button's readable label.
//
// Kept in its own dependency-free module (no Button/UI imports) so it renders in isolation for a unit test —
// importing it does not drag in the `@/`-aliased UI chain the node vitest config can't resolve.
// #602 / ADR-206: the mark follows the connection's PRESET, not the route it came in by. `preset` is
// already the field that says "this is that provider" — and already the reason a tenant may not rename
// such a connection (a renamed brand is a phishing surface) — so the mark reads from the same fact.
// A preset with no mark here renders as text, which is correct rather than missing: adding a brand's
// asset is a per-brand decision, not a batch.
export function ProviderMark({ preset }: { preset: string }) {
  switch (preset) {
    case "google":
      return (
        <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true" className="flex-none">
          <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z" />
          <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z" />
          <path fill="#FBBC05" d="M11.69 28.18c-.44-1.32-.69-2.73-.69-4.18s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z" />
          <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z" />
        </svg>
      );
    case "github":
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="flex-none">
          <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.09 1.85 1.24 1.85 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.39 1.24-3.23-.13-.3-.54-1.53.11-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 016 0c2.29-1.55 3.3-1.23 3.3-1.23.65 1.65.24 2.88.12 3.18.77.84 1.23 1.92 1.23 3.23 0 4.62-2.8 5.64-5.48 5.94.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .32.22.7.83.58C20.56 22.29 24 17.8 24 12.5 24 5.87 18.63.5 12 .5z" />
        </svg>
      );
    case "microsoft":
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" className="flex-none">
          <path fill="#F25022" d="M1 1h10.5v10.5H1z" />
          <path fill="#7FBA00" d="M12.5 1H23v10.5H12.5z" />
          <path fill="#00A4EF" d="M1 12.5h10.5V23H1z" />
          <path fill="#FFB900" d="M12.5 12.5H23V23H12.5z" />
        </svg>
      );
    default:
      return null;
  }
}
