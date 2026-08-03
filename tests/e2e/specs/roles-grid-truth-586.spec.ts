import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDemo, sleep } from "../helpers";

// #586: the screen that exists to say what a role can do was saying something the model denies.
// `/admin/roles` drew `manager` with Moderate unticked — the very error ADR-203 §4 named when this
// ticket was opened — because it rendered the server's DECLARED bundle, which omits `manage`, so the
// closure had no starting point to reach `moderate` from.
//
// Read in a real browser, from the checkboxes a person actually sees. The unit pin covers the mapping
// function; this covers the claim that the mapping reaches the screen.
//
// The expectation is not written here. It is READ from the measured table, which
// `apps/server/src/__tests__/role-capability-truth-586.test.ts` keeps equal to what a real OpenFGA
// store answers. Typing the expected set into this file would copy the mistake into the test.
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

test("#586: the roles list ticks what the store confers, for every built-in", async ({ page }) => {
  const nouns = readFileSync(resolve(WEB, "settings/role-nouns.ts"), "utf8");
  const tab = readFileSync(resolve(WEB, "settings/AdminRolesTab.tsx"), "utf8");
  const measured = parseTable(nouns, "BUILTIN_EFFECTIVE_CAPS");
  const capNoun = Object.fromEntries(
    [...(/CAP_NOUN[^=]*=\s*\{([\s\S]*?)\n\};/.exec(nouns)?.[1] ?? "").matchAll(/(\w+):\s*"(\w+)"/g)].map((m) => [m[1]!, m[2]!]),
  );
  const columns = [...(/const CAPABILITIES = \[([^\]]*)\]/.exec(tab)?.[1] ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]!);
  expect(Object.keys(measured).length, "the measured table was read").toBeGreaterThan(3);
  expect(columns.length, "the grid's columns were read").toBeGreaterThan(5);

  await openDemo(page);
  await page.goto("/admin/roles");
  await expect(page.getByTestId("roles-list-resource")).toBeVisible({ timeout: 10_000 });
  await sleep(400);

  for (const [cap, noun] of Object.entries(capNoun)) {
    const row = page.locator(`[data-testid^="builtin-${noun}-cap-"]`);
    if ((await row.count()) === 0) continue; // a noun this deployment does not render as a built-in row
    const ticked = await page.evaluate((prefix) => {
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll(`[data-testid^="${prefix}-cap-"]`))) {
        const box = el as HTMLInputElement;
        if (box.checked) out.push(box.getAttribute("data-testid")!.slice(`${prefix}-cap-`.length));
      }
      return out;
    }, `builtin-${noun}`);

    const expected = (measured[cap] ?? []).filter((c) => columns.includes(c));
    expect([...ticked].sort(), `${noun}: the grid must show what the store confers`).toEqual([...expected].sort());
  }

  // The one that was wrong on screen, named so a regression reads as itself rather than as a diff.
  const managerModerate = page.getByTestId("builtin-manager-cap-moderate");
  await expect(managerModerate, "a manager moderates — through space#moderator = … or manager").toBeChecked();
});
