// #1169: the page-level loading state became one shared component with an animated product mark. Three
// things can quietly break it, and none of them are visible in a screenshot of the happy path:
//
//  1. a page-level surface goes back to hand-rolling the bare line (the drift #976 fixed for LoadFailed);
//  2. the loader's mark answers to `brand-mark`, which branding.spec asserts reaches COUNT 0 once a
//     tenant uploads a custom logo — a second copy on the page turns that spec red for the wrong reason;
//  3. the draw animation is given `animation-fill-mode: forwards`. Under `prefers-reduced-motion` the
//     global rule cuts it to one ~0-length iteration; with `forwards` the paths would then HOLD the
//     final keyframe, which is the ERASED state — a reader who asked for less motion would get a blank
//     square where the logo should be. The static case is correct only because the paths fall back to
//     their base values.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(resolve(SRC, p), "utf8");
const loader = read("ui/FullPageLoader.tsx");
const tokens = read("styles/tokens.css");

// Every surface whose WHOLE page body is the loading state. Inline loading lines (dialogs, settings
// tabs, side panels, tree rows) are deliberately not here — they keep the plain line.
const PAGE_LEVEL_SURFACES = [
  "app/routes.tsx",
  "settings/AdminPage.tsx",
  "settings/AccountPage.tsx",
  "settings/SpaceSettingsPage.tsx",
];

describe("#1169 the full-page loading state is one component, not twelve copies", () => {
  it("no page-level surface hand-rolls the bare loading line any more", () => {
    const offenders = PAGE_LEVEL_SURFACES.filter((f) =>
      /<div style=\{\{ padding: (16|24)[^}]*\}\}>\{t\("common\.loading"\)\}<\/div>/.test(read(f)),
    );
    expect(offenders, "these render the old bare line instead of <FullPageLoader />").toEqual([]);
  });

  it("each page-level surface actually reaches the shared component", () => {
    for (const f of PAGE_LEVEL_SURFACES) {
      const src = read(f);
      expect(src, `${f} renders <FullPageLoader />`).toContain("<FullPageLoader />");
      expect(src, `${f} imports it`).toMatch(/import \{ FullPageLoader \} from ".*FullPageLoader"/);
    }
  });

  it("the loader announces itself and keeps the words a screen reader reads", () => {
    expect(loader).toContain('role="status"');
    expect(loader).toContain('aria-live="polite"');
    expect(loader, "the animation is not a substitute for the text").toContain('t("common.loading")');
  });

  it("the loader's mark does not answer to brand-mark", () => {
    // The mark is rendered with an explicit testId; if that argument is ever dropped, WikisteadMark's
    // default (`brand-mark`) applies and branding.spec's count-0 assertion breaks.
    expect(loader).toMatch(/testId=\{`\$\{testId\}-mark`\}/);
    expect(loader, "never the default identity").not.toContain('testId="brand-mark"');
  });

  it("the draw animation does not hold its final (erased) keyframe", () => {
    const at = tokens.indexOf(".wks-logo-draw path {");
    expect(at, ".wks-logo-draw rule not found").toBeGreaterThan(-1);
    const rule = tokens.slice(at, tokens.indexOf("}", at));
    expect(rule, "reduced motion must fall back to the drawn logo, not a blank one").not.toMatch(/forwards|both/);
    expect(rule).toContain("infinite");
  });
});
