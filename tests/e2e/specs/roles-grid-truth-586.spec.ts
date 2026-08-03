import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDemo, sleep } from "../helpers";

// #586: the screen that exists to say what a role can do was saying something the model denies.
// `/admin/roles` drew `manager` with Moderate unticked — the very error ADR-203 §4 named when this
// ticket was opened — because it rendered the server's DECLARED bundle, which omits `manage`, so the
// closure had no starting point to reach `moderate` from.
//
//② changed the SHAPE of the answer, not its source: the read-only grids left the list, and a
// built-in now explains itself from its NAME — hover/tap raises the "what it can do" window (RoleTip).
// So this reads the window, in a real browser, for every built-in the screen draws.
//
// The expectation is not written here. It is READ from the measured tables, which
// `apps/server/src/__tests__/role-capability-truth-586.test.ts` keeps equal to what a real OpenFGA
// store answers. Typing the expected set into this file would copy the mistake into the test. The
// cap→label mapping comes from the locale file for the same reason: hand-copying labels would let the
// window drift from the vocabulary without this test noticing.
const WEB = resolve(import.meta.dirname, "../../../apps/web/src");

function parseTable(src: string, name: string): Record<string, string[]> {
  const block = new RegExp(`${name}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`).exec(src)?.[1];
  expect(block, `${name} is where this test says it is`).toBeTruthy();
  const out: Record<string, string[]> = {};
  for (const m of block!.matchAll(/^\s*(\w+):\s*\[([^\]]*)\]/gm)) {
    out[m[1]!] = [...m[2]!.matchAll(/"(\w+)"/g)].map((c) => c[1]!);
  }
  return out;
}

test("#586: the roles list's hover window says what the store confers, for every built-in", async ({ page }) => {
  const nouns = readFileSync(resolve(WEB, "settings/role-nouns.ts"), "utf8");
  const measured = parseTable(nouns, "BUILTIN_EFFECTIVE_CAPS");
  const tiers = parseTable(nouns, "TENANT_TIER_CAPS");
  const capNoun = Object.fromEntries(
    [...(/CAP_NOUN[^=]*=\s*\{([\s\S]*?)\n\};/.exec(nouns)?.[1] ?? "").matchAll(/(\w+):\s*"(\w+)"/g)].map((m) => [m[1]!, m[2]!]),
  );
  const locale = JSON.parse(readFileSync(resolve(WEB, "i18n/locales/en.json"), "utf8")) as {
    adminRoles: { cap: Record<string, string> };
  };
  const labelOf = (cap: string) => {
    const label = locale.adminRoles.cap[cap];
    expect(label, `the vocabulary names "${cap}"`).toBeTruthy();
    return label!;
  };
  expect(Object.keys(measured).length, "the measured table was read").toBeGreaterThan(3);
  expect(tiers.admin?.length, "the tenant tier table was read").toBeGreaterThan(1);

  await openDemo(page);
  await page.goto("/admin/roles");
  await expect(page.getByTestId("roles-list-resource")).toBeVisible({ timeout: 10_000 });
  await sleep(400);

  // Read one window: tap the name (the controlled toggle — same path a touch user has), read the
  // list items out of the tooltip layer (Radix keeps a second offscreen copy for aria; the role
  // scopes to the one a person sees), tap again to fold it before moving on.
  const readWindow = async (name: string): Promise<string[]> => {
    const tip = page.getByTestId(`role-tip-${name}`);
    await expect(tip, `${name} is drawn as its name`).toBeVisible();
    await tip.click();
    const panel = page.getByRole("tooltip").getByTestId(`role-tip-${name}-content`);
    await expect(panel, `${name}'s name raises its window`).toBeVisible({ timeout: 5000 });
    const items = await panel.locator("li").allInnerTexts();
    // a second tap toggles the controlled state off, but the pointer is still resting on the trigger
    // and hover holds it open (by design) — so leave the trigger before expecting it folded
    await page.keyboard.press("Escape");
    await page.mouse.move(4, 4);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    return items.map((s) => s.trim());
  };

  // every space/page built-in the deployment renders as a row
  for (const [cap, noun] of Object.entries(capNoun)) {
    if ((await page.getByTestId(`builtin-role-${noun}`).count()) === 0) continue;
    const got = await readWindow(noun);
    const expected = (measured[cap] ?? []).map(labelOf);
    expect([...got].sort(), `${noun}: the window must list what the store confers`).toEqual([...expected].sort());
  }

  // the tenant tier row: admin's window is the measured tier table, not a hand-written pair
  const adminGot = await readWindow("admin");
  expect([...adminGot].sort(), "admin: the window lists the measured tier structure").toEqual(
    [...(tiers.admin ?? []).map(labelOf)].sort(),
  );

  // The one that was wrong on screen, named so a regression reads as itself rather than as a diff:
  // a manager moderates — through space#moderator = … or manager.
  expect((await readWindow("manager")).join("\n")).toContain(labelOf("moderate"));
});
