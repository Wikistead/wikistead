import { test, expect, type Page } from "@playwright/test";
import { WEB_REAL_PORT } from "../helpers";

// #372: "another member's uploaded avatar shows for a NEW member". The server trace (ticket)
// proved every path is sub-scoped (storage key / /auth/me row / per-sub image URL / JIT copies no
// avatar key) — this pins that in a REAL browser with REAL OIDC logins on the real-auth web (5181),
// covering BOTH reported shapes
// 1. a FRESH browser context (the ticket's ) logging in as a brand-new member
// right after another member uploaded an avatar → initials fallback, and the other member's
// avatar-image URL is never even requested;
// 2. a LOGIN SWITCH in the SAME browser context (upload as A → logout → accept an invite as B)
// the shape that would catch any session/HTTP-cache carry-over across logins.
// dev-user's avatar is uploaded for the test and ALWAYS removed again (avatar.spec relies on dev-user
// having no picture — initials "DE").
const WEB = `http://dev.localhost:${WEB_REAL_PORT}`;
const ISSUER = "http://127.0.0.1:4444";

// A valid 1x1 red PNG (magic-byte sniff requires a real PNG header).
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg+M/AAAADAQEAf6VYPAAAAABJRU5ErkJggg==";

async function loginDefault(page: Page): Promise<void> {
  await page.goto(`${WEB}/auth/login`);
  await page.waitForURL((u) => !u.pathname.startsWith("/auth/"), { timeout: 15_000 });
}

async function makeInvite(admin: Page): Promise<string> {
  await admin.goto(`${WEB}/settings/members`);
  await admin.getByLabel("invite email").fill(`avatar372-${Date.now()}@e2e.test`);
  await admin.getByRole("button", { name: "Send invite" }).click();
  // #638: the link is shown once, in a modal — read the value inside the box, then dismiss it so the
  // console behind is usable again.
  const link = await admin.getByTestId("invite-link-value").textContent();
  await admin.getByTestId("secret-dialog-done").click();
  expect(link).toMatch(/\/invite\?token=inv_/);
  return link!;
}

// Accept an invite as `sub` on an already-prepared page whose issuer cookie selects that subject.
async function acceptInvite(page: Page, link: string, sub: string): Promise<void> {
  await page.goto(link);
  await page.getByRole("button", { name: "Accept invite" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/auth/") && u.pathname !== "/invite", { timeout: 20_000 });
  const me = await page.request.get(`${WEB}/api/auth/me`);
  expect(me.status()).toBe(200);
  expect((await me.json()).sub).toBe(sub);
}

test("#372: a new member never sees another member's uploaded avatar (fresh context AND same-context login switch)", async ({ browser }) => {
  // ── dev-user uploads an avatar and sees it in their OWN header ────────────────
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await loginDefault(pageA); // default issuer subject = dev-user (a seeded member + admin)
  const up = await pageA.request.put(`${WEB}/api/me/avatar`, { data: { data: PNG_1PX } });
  expect(up.status()).toBe(204);
  try {
    await pageA.goto(`${WEB}/`);
    const ownAvatar = pageA.getByTestId("user-avatar");
    await expect(ownAvatar.locator("img")).toHaveCount(1); // A sees their OWN picture…
    const src = await ownAvatar.locator("img").getAttribute("src");
    expect(src).toContain("/members/dev-user/avatar-image"); // …from the per-sub URL

    const link1 = await makeInvite(pageA);
    const link2 = await makeInvite(pageA);

    // ── 1. FRESH context: brand-new member B1 → initials, and A's image URL is never fetched ──
    const subB1 = `avatar372-b1-${Date.now()}`;
    const ctxB = await browser.newContext();
    await ctxB.addCookies([{ name: "e2e_sub", value: subB1, url: ISSUER }]);
    const pageB = await ctxB.newPage();
    const fetchedA: string[] = [];
    pageB.on("request", (r) => { if (r.url().includes("/members/dev-user/avatar-image")) fetchedA.push(r.url()); });
    await acceptInvite(pageB, link1, subB1);
    await pageB.goto(`${WEB}/`);
    const b1Avatar = pageB.getByTestId("user-avatar");
    await expect(b1Avatar).toBeVisible();
    await expect(b1Avatar.locator("img"), "a picture-less new member gets the initials chip, never an <img>").toHaveCount(0);
    expect(fetchedA, "dev-user's avatar bytes must never be requested in B1's session").toHaveLength(0);
    await ctxB.close();

    // ── 2. SAME context login switch: A logs out, B2 logs in — no carry-over of A's picture ──
    await pageA.request.post(`${WEB}/api/auth/logout`);
    const subB2 = `avatar372-b2-${Date.now()}`;
    await ctxA.addCookies([{ name: "e2e_sub", value: subB2, url: ISSUER }]);
    const fetchedA2: string[] = [];
    pageA.on("request", (r) => { if (r.url().includes("/members/dev-user/avatar-image")) fetchedA2.push(r.url()); });
    await acceptInvite(pageA, link2, subB2);
    await pageA.goto(`${WEB}/`);
    const b2Avatar = pageA.getByTestId("user-avatar");
    await expect(b2Avatar).toBeVisible();
    await expect(b2Avatar.locator("img"), "after a login switch the previous member's picture must not linger").toHaveCount(0);
    expect(fetchedA2, "dev-user's avatar bytes must never be requested in B2's session").toHaveLength(0);
  } finally {
    // Restore dev-user's no-picture state (avatar.spec pins the initials fallback). ctxA may now be
    // B2's session — use a fresh context logged in as the default subject.
    const ctxC = await browser.newContext();
    const pageC = await ctxC.newPage();
    await loginDefault(pageC);
    await pageC.request.delete(`${WEB}/api/me/avatar`);
    await ctxC.close();
    await ctxA.close();
  }
});
