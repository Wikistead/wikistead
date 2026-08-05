import { test, expect, type Page } from "@playwright/test";
import { API } from "../helpers";

// #582 (review rejection, /): the floating explanation panels, measured as a FAMILY.
//
// Three complaints, one subject. Only the Radix-backed one animated, so a reader saw one panel ease in
// while its siblings appeared instantly. Text ran outside the fill. And a panel could sit off the screen —
// the second tier off the right at a 1000px window, the first tier off the bottom at a 420px one.
//
// The family has TWO implementations: panels Radix positions (the badge tooltip) and panels this app
// positions itself (`panel-placement`, used by the Select hint and the group-roles list). Every check here
// asserts its own premise first — that both implementations were actually reached. Without that, "the
// panels agree" is true of a walk that found one kind of panel, and re-animating the whole family stays
// GREEN; measured, on this file, before the premise was added.
const SCREENS = [
  { name: "roles", url: "/admin/roles" },
  { name: "space members", url: "/spaces/demo_space/settings/members" },
  { name: "tenant members", url: "/admin/members" },
];

type Panel = {
  testid: string | null;
  /** which implementation put it there — `radix` positions itself, `placed` goes through panel-placement */
  host: "radix" | "placed";
  overflow: number;
  inViewport: boolean;
  escape: string;
  animation: string;
  where: string;
};

/** Hover each `cursor: help` trigger on the page and report every panel that appears. */
async function walkPanels(page: Page, where: string): Promise<Panel[]> {
  const triggers = page.locator("css=[class*=cursor-help], [data-testid=group-role-name]");
  const n = Math.min(await triggers.count(), 8);
  const seen: Panel[] = [];
  for (let i = 0; i < n; i++) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    // in a short window most rows start below the fold, and a pointer moved to a coordinate outside the
    // viewport hovers nothing — the walk came back with only the first screen's panels and every check
    // that followed was comparing one implementation to itself
    await t.scrollIntoViewIfNeeded().catch(() => {});
    const box = await t.boundingBox();
    if (!box) continue;
    // progressive movement: a teleporting pointer is the measurement trap this repo has hit twice
    await page.mouse.move(box.x - 30, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
    await page.waitForTimeout(400);
    seen.push(...await page.evaluate((w) => {
      // the FAMILY, named by the product (`data-role-panel`), the way #589 named the sign-in rows.
      // Inferring it from a shared affordance swept up a status icon's ordinary label, which animates by
      // design and has nothing to do with this ruling.
      //
      // A Radix tooltip renders its content TWICE: once to look at, and once inside a
      // `<span role="tooltip">` clipped to `rect(0,0,0,0)` for screen readers. The clone is a real element
      // with a real `scrollWidth`, so measuring it reports `scrollWidth 220 - clientWidth 1` on a panel
      // that is not overflowing at all — an accusation of the product for being accessible.
      const visible = (e: HTMLElement) => !e.closest('[role=tooltip][style*="clip"]');
      return [...document.querySelectorAll<HTMLElement>("[data-role-panel]")]
        .filter(visible)
        .map((content) => {
          const tip = content.closest("[data-slot=tooltip-content]") as HTMLElement | null;
          return { content, box: tip ?? content, host: (tip ? "radix" : "placed") as "radix" | "placed" };
        })
        .filter(({ box }) => box.getBoundingClientRect().width > 0)
        .map(({ content, box: p, host }) => {
          const r = p.getBoundingClientRect();
          return {
            testid: content.getAttribute("data-testid") ?? p.getAttribute("data-slot"),
            host,
            // spill belongs to the CONTENT, escaping to the BOX. Measuring both on the box hides the very
            // defect reported: the box auto-sizes around a fixed-width panel, so text hanging outside
            // the 220px fill shows up as zero overflow one level out.
            overflow: content.scrollWidth - content.clientWidth,
            inViewport: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
            // which way it left, so a failure says what to fix instead of only that something is wrong
            escape: [r.left < 0 && `left ${Math.round(r.left)}`, r.top < 0 && `top ${Math.round(r.top)}`,
              r.right > window.innerWidth && `right +${Math.round(r.right - window.innerWidth)}`,
              r.bottom > window.innerHeight && `bottom +${Math.round(r.bottom - window.innerHeight)}`,
            ].filter(Boolean).join(" ") + ` [box ${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.left)},${Math.round(r.top)} vp ${window.innerWidth}x${window.innerHeight}]`,
            animation: getComputedStyle(p).animationName,
            where: w,
          };
        });
    }, where));
    await page.mouse.move(4, 4);
    await page.waitForTimeout(200);
  }
  return seen;
}

// The fixture exists so the walk meets the OTHER implementation: the group-roles panel only appears when a
// group actually confers something. Its name is 60 characters of hex — an unbreakable run, the shape that
// spilled (a sub, a token, a machine-made name), because every role name on this tenant breaks at a hyphen
// and the wrap rule could be deleted with the suite still green. Made and removed per test: a leftover
// tenant role piles into every picker on this shared dev tenant (the #582 sweep drowned in that debris).
const LONG_ROLE = `e2e582${"0123456789abcdef".repeat(3)}0123`.slice(0, 60);
const GROUP = "wiki Editors"; // the group the e2e fixture's dev-user carries

async function grantGroupRole(page: Page): Promise<string | null> {
  await page.goto("/admin/members");
  const roleId = await page.evaluate(async ({ api, name }) => {
    const r = await fetch(`${api}/admin/roles`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ name, capabilities: ["createSpaces"], scope: "tenant" }),
    });
    return r.ok ? ((await r.json()) as { id: string }).id : null;
  }, { api: API, name: LONG_ROLE });
  expect(roleId, "the fixture role was created").toBeTruthy();
  const granted = await page.evaluate(async ({ api, id, group }) => {
    const me = await fetch(`${api}/auth/me`, { headers: { Authorization: "Bearer dev-token" } });
    const tid = me.ok ? ((await me.json()) as { tenantId?: string }).tenantId ?? "tenant_dev" : "tenant_dev";
    const r = await fetch(`${api}/admin/roles/${id}/assignments`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ resourceType: "tenant", resourceId: tid, groupName: group }),
    });
    return r.ok;
  }, { api: API, id: roleId, group: GROUP });
  expect(granted, "the group was given the long-named role").toBe(true);
  return roleId;
}

async function removeGroupRole(page: Page, roleId: string | null): Promise<void> {
  await page.evaluate(async ({ api, id }) => {
    if (!id) return;
    const me = await fetch(`${api}/auth/me`, { headers: { Authorization: "Bearer dev-token" } });
    const tid = me.ok ? ((await me.json()) as { tenantId?: string }).tenantId ?? "tenant_dev" : "tenant_dev";
    const list = await fetch(`${api}/admin/roles/assignments?resourceType=tenant&resourceId=${tid}`, { headers: { Authorization: "Bearer dev-token" } });
    if (list.ok) {
      const body = (await list.json()) as { assignments?: { id: string; roleId: string | null }[] } | { id: string; roleId: string | null }[];
      const all = Array.isArray(body) ? body : (body.assignments ?? []);
      for (const a of all.filter((x) => x.roleId === id)) {
        await fetch(`${api}/admin/roles/assignments/${a.id}`, { method: "DELETE", headers: { Authorization: "Bearer dev-token" } });
      }
    }
    await fetch(`${api}/admin/roles/${id}`, { method: "DELETE", headers: { Authorization: "Bearer dev-token" } });
  }, { api: API, id: roleId });
}

/** Both implementations were reached — without this, every check below is true of an empty family. */
function assertBothHosts(all: Panel[]): void {
  const hosts = [...new Set(all.map((p) => p.host))].sort();
  expect(hosts, `the walk met only one implementation, so nothing here is a comparison :: ${JSON.stringify(all.map((p) => [p.where, p.host, p.testid]))}`)
    .toEqual(["placed", "radix"]);
}

test("#582: every role panel agrees on animation, and its text stays in the fill", async ({ page }) => {
  test.setTimeout(180_000);
  const roleId = await grantGroupRole(page);
  try {
    const all: Panel[] = [];
    for (const s of SCREENS) {
      await page.goto(s.url);
      await page.waitForTimeout(1200);
      all.push(...await walkPanels(page, s.name));
    }
    assertBothHosts(all);

    // ① one family, one behaviour: whatever the animation is, it is the same everywhere
    const animations = [...new Set(all.map((p) => p.animation))];
    expect(animations, `panels disagree on animation :: ${JSON.stringify(all.map((p) => [p.where, p.host, p.animation]))}`).toHaveLength(1);

    // ⑤ nothing hangs outside the fill
    const spilling = all.filter((p) => p.overflow > 0);
    expect(spilling, `text hanging outside the panel :: ${JSON.stringify(spilling)}`).toEqual([]);
  } finally {
    await removeGroupRole(page, roleId);
  }
});

// a panel that opens near an edge stays on the screen. Measured in a SHORT window, because the
// escape reported on the device was vertical — a tall capability list opening on a low row.
test("#582: no role panel leaves a small window", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 420 });
  const roleId = await grantGroupRole(page);
  try {
    const all: Panel[] = [];
    for (const s of SCREENS) {
      await page.goto(s.url);
      await page.waitForTimeout(1200);
      all.push(...await walkPanels(page, s.name));
    }
    assertBothHosts(all);
    const escaped = all.filter((p) => !p.inViewport);
    expect(escaped, `a panel opened outside the window :: ${JSON.stringify(escaped)}`).toEqual([]);
  } finally {
    await removeGroupRole(page, roleId);
  }
});

// ⑤ again, on the one panel that prints a name it did not choose. The walk above measures whatever the
// fixtures hold; this one guarantees the unbreakable run is on screen and looks at the fill directly.
test("#582: an unbreakable name stays inside the panel", async ({ page }) => {
  test.setTimeout(120_000);
  const roleId = await grantGroupRole(page);
  try {
    await page.goto("/admin/members");
    await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(600);
    await page.getByTestId("group-roles-mark").first().hover();
    const list = page.getByTestId("group-roles-list");
    await expect(list).toBeVisible({ timeout: 5_000 });
    await expect(list, "the panel really does print the unbreakable name").toContainText(LONG_ROLE.slice(0, 40));

    const spill = await page.evaluate(() => {
      const p = document.querySelector<HTMLElement>("[data-testid=group-roles-list]")!;
      // the widest descendant against the panel's own content box: a child that reaches further than its
      // parent can hold is text outside the fill, whatever the parent's own scrollWidth reports
      const inner = Math.max(...[...p.querySelectorAll("*")].map((k) => k.getBoundingClientRect().width));
      return { overflow: p.scrollWidth - p.clientWidth, inner: Math.round(inner), fill: p.clientWidth };
    });
    expect(spill.overflow, `the panel scrolls to reach its own text :: ${JSON.stringify(spill)}`).toBe(0);
    expect(spill.inner, `text reaches ${spill.inner - spill.fill}px past the fill :: ${JSON.stringify(spill)}`)
      .toBeLessThanOrEqual(spill.fill);
  } finally {
    await removeGroupRole(page, roleId);
  }
});
