import { test, expect } from "@playwright/test";
import { openScratch, enterEdit } from "../helpers";

// #977: the disconnect banner (UnsavedBanner) clears the absolute title band with its own
// `marginTop: var(--wks-band-h)`. Independently, `.lp-editor-host .cm-content` ALSO pads its own top by
// the same `--wks-band-h` — a rule written for the case where .cm-content is the first flow element
// after the band. Once the banner sits in front of it in the flow, that assumption breaks and the two
// clearances stack into a blank gap the height of the title band, right above the first line.
//
// This exercises the actual shipped CSS rule (tokens.css: `:has(> [data-testid="not-saving-banner"])
// .lp-editor-host > .cm-editor > .cm-scroller > .cm-content { padding-top: 0 }`) against a real open
// editor, rather than reproducing an actual socket drop — the disconnect state itself is exercised by
// `liveness.ts`'s own unit coverage (`isLive`/`notLiveReason` are pure), and forcing a real websocket
// drop from Playwright is its own source of flake this suite already has plenty of (#823/#825/#891). A
// synthetic banner node, inserted as a direct child of the SAME parent the real `<UnsavedBanner>` would
// render into, reproduces exactly the DOM shape the rule keys on and proves the cascade fires against
// the real page's real stylesheet.
test("#977: the band clearance under .cm-content drops to 0 once a disconnect banner is present as a sibling", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "unsaved-banner-band");
  await enterEdit(page);

  const m = await page.evaluate(() => {
    const cmContent = document.querySelector(".lp-editor-host > .cm-editor > .cm-scroller > .cm-content") as HTMLElement;
    // Editor's own root (routes.tsx renders <UnsavedBanner /> immediately before <Editor />, so this
    // root's parent is the same parent a real banner would be a direct child of).
    const editorRoot = cmContent.closest("[data-mode]") as HTMLElement;
    const parent = editorRoot.parentElement as HTMLElement;

    const before = getComputedStyle(cmContent).paddingTop;

    const banner = document.createElement("div");
    banner.dataset.testid = "not-saving-banner";
    parent.insertBefore(banner, editorRoot);
    const withBanner = getComputedStyle(cmContent).paddingTop;

    banner.remove();
    const afterRemoval = getComputedStyle(cmContent).paddingTop;

    return { before, withBanner, afterRemoval };
  });

  expect(m.before, "a title band exists on this route, so the baseline clearance is non-zero").not.toBe("0px");
  expect(m.withBanner, "the banner already clears the band itself — .cm-content must not clear it a second time").toBe("0px");
  expect(m.afterRemoval, "removing the banner must restore the original clearance (this is conditional, not a permanent override)").toBe(m.before);
});
