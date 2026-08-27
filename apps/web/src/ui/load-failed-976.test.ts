// #976: LoadFailed only had one appearance — small, left-aligned, a `variant="ghost"` retry. Inside a
// panel, tab, or dialog that chrome is right (the surrounding shell already bounds the layout, and a
// quiet button matches it). On a page-body surface there is no bounding chrome: the same markup reads
// as a stray line stuck in the corner, with a retry that doesn't read as actionable — the exact
// contradiction the ticket named in WatchListPage, where the *loading* state right next to it is
// centered with `py-8 text-center` and the *error* state was not.
//
// THE FIX: a `variant?: "inline" | "page"` prop, defaulting to "inline" (today's markup, unchanged),
// plus a "page" branch that centers, gives the block a minimum height, and upgrades the retry to
// `variant="default"`. Applied to the three page-body surfaces the ticket named outright
// (RecentChangesPage / TemplatesPage / WatchListPage) plus HomeLanding in routes.tsx, which is the
// same shape (an `<AppShell>` with nothing else in it) discovered while walking the remaining sites.
// Every other call site renders inside a settings tab, a dialog, a dropdown, or a side panel — each
// already has its own bounding shell, so the default stays correct and untouched there.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC_ROOT = resolve(import.meta.dirname, "..");
const component = readFileSync(resolve(SRC_ROOT, "ui/LoadFailed.tsx"), "utf8");

function componentAround(src: string, marker: string): string {
  const at = src.indexOf(marker);
  expect(at, `${marker} not found`).toBeGreaterThan(-1);
  return src.slice(at);
}

describe("#976 LoadFailed has a full-page appearance for page-body surfaces", () => {
  it("the page branch centers the block and gives it a minimum height", () => {
    const pageBranch = componentAround(component, 'variant === "page"');
    expect(pageBranch, "the page variant needs a minimum height so it isn't just a line").toMatch(/min-h-/);
    expect(pageBranch, "the page variant must center its content").toMatch(/items-center/);
    expect(pageBranch, "the page variant must center its content").toMatch(/justify-center/);
  });

  it("the page branch's retry reads as the way forward, not a quiet aside", () => {
    const pageBranch = componentAround(component, 'variant === "page"');
    const retry = pageBranch.slice(0, pageBranch.indexOf("</div>"));
    expect(retry, "a full-page retry must not stay ghost-styled").toMatch(/variant="default"/);
  });

  it("the default stays the original inline appearance (unchanged for every other caller)", () => {
    // The inline branch is whatever comes AFTER the page branch's closing brace — this file has
    // exactly two `return`s, the page one first.
    const afterPage = component.slice(component.indexOf('variant === "page"'));
    const inlineBranch = afterPage.slice(afterPage.indexOf("return (", afterPage.indexOf("}") + 1));
    expect(inlineBranch, "the default appearance must still use the quiet ghost button").toMatch(/variant="ghost"/);
    expect(inlineBranch, "the default appearance must not gain the page centering").not.toMatch(/justify-center/);
  });

  const PAGE_BODY_SITES: { file: string; testId: string }[] = [
    { file: "app/RecentChangesPage.tsx", testId: "recent-changes-failed" },
    { file: "app/TemplatesPage.tsx", testId: "templates-failed" },
    { file: "notifications/WatchListPage.tsx", testId: "watch-list-failed" },
    { file: "app/routes.tsx", testId: "home-spaces-failed" },
  ];

  it.each(PAGE_BODY_SITES.map((s) => [s.file, s] as const))(
    "%s renders LoadFailed with variant=\"page\" (it is the whole route body, not a panel)",
    (_label, site) => {
      const src = readFileSync(resolve(SRC_ROOT, site.file), "utf8");
      const at = src.indexOf(`testId="${site.testId}"`);
      expect(at, `${site.testId} not found in ${site.file}`).toBeGreaterThan(-1);
      const around = src.slice(Math.max(0, at - 200), at + 200);
      expect(around, `${site.file}'s ${site.testId} must pass variant="page"`).toMatch(/variant="page"/);
    },
  );

  // A representative sample of panel/tab/dialog call sites — each has its own bounding shell, so the
  // default (unset, meaning "inline") is correct. This is not "assert nothing changed everywhere" (a
  // walk of all ~24 remaining sites would be the #888-style discovery test, not this ticket's job) —
  // it is a guard against reflexively applying "page" past the three named surfaces plus HomeLanding.
  it("AccountPage's ApiKeysTab keeps the inline appearance (it lives inside a settings tab)", () => {
    const src = readFileSync(resolve(SRC_ROOT, "settings/AccountPage.tsx"), "utf8");
    const at = src.indexOf('testId="account-api-keys-failed"');
    expect(at).toBeGreaterThan(-1);
    const around = src.slice(Math.max(0, at - 100), at + 200);
    expect(around, "a settings-tab surface must not switch to the page variant").not.toMatch(/variant="page"/);
  });

  it("ShareDialog keeps the inline appearance (it lives inside a dialog)", () => {
    const src = readFileSync(resolve(SRC_ROOT, "ui/ShareDialog.tsx"), "utf8");
    const around = componentAround(src, "<LoadFailed");
    expect(around.slice(0, 200), "a dialog surface must not switch to the page variant").not.toMatch(/variant="page"/);
  });
});
