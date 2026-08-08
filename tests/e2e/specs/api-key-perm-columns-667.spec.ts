import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #667 ①: the twenty-one-row permission table has to READ as a table.
//
// Three of the types have no `write` cell (search / recent changes / audit — nothing writes them), and
// the row was a flex box whose label took the slack, so those three let their `none` and `read` radios
// slide 69px to the right. Running an eye down twenty-one rows, the eye catches on exactly those three.
//
// Measured as the x-coordinate of each column, across every row, in both languages — which is the claim.
// A pin on class names cannot answer a question about layout (#650 measured that the hard way: the
// shield had `size={16}` and was rendered at 10.34px, because flex may overrule an attribute). And a pin
// that only checked "the two-choice rows have three cells" would pass a spacer of the wrong width, which
// is the fix that was NOT taken here.
//
// The wording is not asserted anywhere below: this is about geometry, and #659 rewords these labels.
test.describe.configure({ mode: "serial" });

type Cols = { none: number[]; read: number[]; write: number[] };

async function columnsOf(page: import("@playwright/test").Page, lang: string): Promise<Cols> {
  await page.addInitScript((l) => { try { localStorage.setItem("wks.lang", l); } catch { /* private */ } }, lang);
  await openDemo(page);
  await page.goto("/admin/api");
  const toggle = page.getByTestId("api-key-narrow-toggle");
  await expect(toggle, "the create form is on screen").toBeVisible({ timeout: 20_000 });
  await toggle.click();
  await expect(page.getByTestId("api-key-perm-list")).toBeVisible({ timeout: 10_000 });
  await sleep(400);

  const rows = page.getByTestId("api-key-perm-row");
  const n = await rows.count();
  expect(n, "the whole vocabulary is offered").toBeGreaterThan(15);

  const out: Cols = { none: [], read: [], write: [] };
  // The radio INPUT, not its label: the label's box depends on how long the word is, and the word is
  // different in each language. The control is the thing the eye tracks down the column.
  for (const action of ["none", "read", "write"] as const) {
    const inputs = page.locator(`[data-testid$="-${action}"][type="radio"]`);
    const count = await inputs.count();
    for (let i = 0; i < count; i++) {
      const box = await inputs.nth(i).boundingBox();
      if (box) out[action].push(Math.round(box.x));
    }
  }
  return out;
}

for (const lang of ["ja", "en"] as const) {
  test(`#667 ①: every ${lang} row starts its radios in the same column`, async ({ page }) => {
    test.setTimeout(180_000);
    const cols = await columnsOf(page, lang);

    expect(cols.none.length, "every row offers `none`").toBeGreaterThan(15);
    // The three types with no write cell: fewer `write` radios than rows is the CONDITION this test is
    // about. Without it the alignment claim would be vacuous — a table where every row has three cells
    // aligns whatever the layout does, and the defect could not reproduce.
    expect(cols.write.length, "some types have no write cell — that is the condition being tested")
      .toBeLessThan(cols.none.length);
    expect(cols.write.length, "…but most of them do").toBeGreaterThan(10);

    for (const action of ["none", "read", "write"] as const) {
      const distinct = [...new Set(cols[action])];
      expect(distinct, `the \`${action}\` column is not a column :: ${JSON.stringify(cols[action])}`)
        .toHaveLength(1);
    }
    // …and the columns are in reading order, so "one column" cannot be satisfied by collapsing them.
    expect(cols.none[0]!).toBeLessThan(cols.read[0]!);
    expect(cols.read[0]!).toBeLessThan(cols.write[0]!);
  });
}
