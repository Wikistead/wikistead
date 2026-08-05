import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #614: the member list's status marks, measured in a real browser. The dev tenant cannot mint a
// suspended member or a local user from here, so GET /members alone is stubbed (the #537 pattern:
// stub the read, keep every write real) with the three states the feature distinguishes. What is
// measured is the part unit pins cannot see: the icons actually render, the suspended row is
// actually dim, and the ⋯ menu actually withholds the password item from somebody who has one.
const MEMBERS = {
  members: [
    { sub: "dev-user", email: "a@x.test", display_name: "IdP Only", picture_url: null, role: "admin", groups: null, created_at: "2026-01-01T00:00:00Z", identity_source: "oidc", has_password: false, deactivated_at: null },
    { sub: "m-added", email: "b@x.test", display_name: "IdP Plus Password", picture_url: null, role: "member", groups: null, created_at: "2026-01-02T00:00:00Z", identity_source: "oidc", has_password: true, deactivated_at: null },
    { sub: "wlocal_x", email: "c@x.test", display_name: "Password Born", picture_url: null, role: "member", groups: null, created_at: "2026-01-03T00:00:00Z", identity_source: "local", has_password: true, deactivated_at: null },
    { sub: "m-frozen", email: "d@x.test", display_name: "Suspended One", picture_url: null, role: "member", groups: null, created_at: "2026-01-04T00:00:00Z", identity_source: "oidc", has_password: false, deactivated_at: "2026-08-01T00:00:00Z" },
  ],
};

test("#614: status marks, the dim, and the menu split reach the screen", async ({ page }) => {
  await page.route("**/api/members", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MEMBERS) })
      : route.fallback(),
  );
  await openDemo(page);
  await page.goto("/admin/members");
  await expect(page.getByText("IdP Plus Password")).toBeVisible({ timeout: 10_000 });
  await sleep(300);

  const row = (name: string) => page.locator("tr", { hasText: name });

  // the icon group spells the three states
  await expect(row("IdP Only").getByTestId("member-status-idp")).toBeVisible();
  await expect(row("IdP Only").getByTestId("member-status-password")).toHaveCount(0);
  await expect(row("IdP Plus Password").getByTestId("member-status-idp")).toBeVisible();
  await expect(row("IdP Plus Password").getByTestId("member-status-password")).toBeVisible();
  await expect(row("Password Born").getByTestId("member-status-local")).toBeVisible();
  await expect(row("Password Born").getByTestId("member-status-idp")).toHaveCount(0);

  // The suspended row wears the mark AND reads as dormant — but the MARK must stay legible, because it
  // is how a reader learns the row is suspended at all. Measured as contrast, not as "it looks dim":
  // dimming the whole row put the marks at 2.22:1 in light, under the 3:1 a non-text UI element needs.
  await expect(row("Suspended One").getByTestId("member-status-deactivated")).toBeVisible();
  const geom = await page.evaluate(() => {
    const parse = (c: string): [number, number, number] => {
      const n = (c.match(/-?[\d.]+/g) ?? []).map(Number);
      return c.startsWith("color(")
        ? [(n[0] ?? 0) * 255, (n[1] ?? 0) * 255, (n[2] ?? 0) * 255]
        : [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0];
    };
    const lum = (rgb: [number, number, number]) => {
      const [r, g, b] = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const effective = (el: Element) => { let o = 1, p: Element | null = el; while (p) { o *= Number(getComputedStyle(p).opacity || 1); p = p.parentElement; } return o; };
    const paint = (el: Element) => { let p: Element | null = el, bg = "rgba(0, 0, 0, 0)"; while (p && (bg === "rgba(0, 0, 0, 0)" || bg === "transparent")) { bg = getComputedStyle(p).backgroundColor; p = p.parentElement; } return parse(bg); };
    const mark = document.querySelector("[data-testid=member-row-deactivated] [data-testid=member-status-deactivated]")!;
    const bg = paint(mark);
    const fg = parse(getComputedStyle(mark).color);
    const a = effective(mark);
    // composite the mark over its paint at its effective opacity, then the standard WCAG ratio
    const mixed = fg.map((v, i) => v * a + bg[i]! * (1 - a)) as [number, number, number];
    const [l1, l2] = [lum(mixed), lum(bg)].sort((x, y) => y - x) as [number, number];
    return { ratio: (l1 + 0.05) / (l2 + 0.05), markOpacity: a };
  });
  expect(geom.ratio, `the suspended row's mark is at ${geom.ratio.toFixed(2)}:1 — a non-text UI element needs 3:1`)
    .toBeGreaterThanOrEqual(3);

  // hover explains a mark (the #586 school): the key's words appear on hover, in the tooltip layer
  await row("IdP Plus Password").getByTestId("member-status-password").hover();
  await expect(page.getByText("Has a password entrance")).toBeVisible({ timeout: 3_000 });

  // the ⋯ menu withholds the entrance from somebody who has one, and still offers it otherwise
  await row("IdP Only").getByTestId("member-actions-trigger").click();
  await expect(page.getByTestId("member-enable-password")).toBeVisible();
  await page.keyboard.press("Escape");
  await row("IdP Plus Password").getByTestId("member-actions-trigger").click();
  await expect(page.getByTestId("member-erase-analytics")).toBeVisible();
  await expect(page.getByTestId("member-enable-password")).toHaveCount(0);
});
