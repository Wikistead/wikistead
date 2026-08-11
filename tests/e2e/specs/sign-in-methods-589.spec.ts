import { test, expect } from "@playwright/test";
import { API , sweepConnections} from "../helpers";

// #623: my own debris from failed runs, swept on the way IN (the cap makes leftovers block the suite).
test.beforeAll(async () => { await sweepConnections(["https://sim589-", "https://an-extremely-long-identity-provider"]); });

// #589 / ADR-195 addendum: one list of sign-in methods, each row edited in place.
//
// Two things need a REAL browser here. The first is the defect the ticket is about: with the legacy
// form, the SECOND connection could not be edited at all (that form always wrote
// `ORDER BY sort, id LIMIT 1`), so this walks two rows and checks each one's editor shows ITS OWN
// issuer. The second is the layout question the ADR flagged as unmeasurable by reading: a long issuer
// used to wrap under the row's buttons, and whether it covers them is a fact about rectangles.
const H = { Authorization: "Bearer dev-token", "content-type": "application/json" };
const LONG_ISSUER = "https://an-extremely-long-identity-provider-hostname-for-layout.example.test/realms/corporate-employees";

async function makeConnection(issuer: string, label: string): Promise<string> {
  const res = await fetch(`${API}/admin/connections`, {
    method: "POST", headers: H,
    body: JSON.stringify({ issuer, clientId: "sim589", redirectUri: `${issuer}/cb`, label, enabled: false }),
  });
  const body = await res.text();
  expect(res.status, body).toBe(201);
  return (JSON.parse(body) as { id: string }).id;
}
const drop = (id: string) => fetch(`${API}/admin/connections/${id}`, { method: "DELETE", headers: H });

test("#589: every connection is editable in its own row, including the second one", async ({ page }) => {
  const first = await makeConnection("https://sim589-one.example.test", "SIM 589 one");
  const second = await makeConnection("https://sim589-two.example.test", "SIM 589 two");
  try {
    await page.goto("/admin/auth");
    await expect(page.getByTestId("sign-in-methods-list")).toBeVisible({ timeout: 10_000 });

    for (const [id, issuer] of [[first, "https://sim589-one.example.test"], [second, "https://sim589-two.example.test"]] as const) {
      const row = page.getByTestId(`admin-connection-${id}`);
      await expect(row).toBeVisible();
      await page.getByTestId(`admin-connection-edit-${id}`).click();
      const editor = page.getByTestId(`admin-connection-editor-${id}`);
      await expect(editor).toBeVisible();
      // THE regression this ticket exists for: the editor must be showing this row's connection.
      await expect(editor.getByTestId("oidc-issuer")).toHaveValue(issuer);
      // and the flag that used to be settable only at creation is here.
      //
      // ONE flag, not two. #616 / ADR-212 slice 2 retired `bootstrapEligible` along with the mechanism
      // it named, and a unit test already pins its absence ("the retired one is not lingering in the
      // editor"). This spec kept asserting the toggle was visible, so it demanded a control the product
      // had deliberately removed — and failed as though the editor were incomplete.
      await expect(page.getByTestId(`admin-connection-trust-groups-${id}`)).toBeVisible();
      await page.getByTestId(`admin-connection-edit-${id}`).click(); // collapse
    }
  } finally {
    await drop(first); await drop(second);
  }
});

test("#589: an edit made in the row persists to that connection and no other", async ({ page }) => {
  const a = await makeConnection("https://sim589-edit-a.example.test", "SIM 589 A");
  const b = await makeConnection("https://sim589-edit-b.example.test", "SIM 589 B");
  try {
    await page.goto("/admin/auth");
    await page.getByTestId(`admin-connection-edit-${b}`).click();
    // groups claim was one of the three flags the old form could not change after creation
    await page.getByTestId("oidc-groups-claim").fill("roles");
    await page.getByTestId("oidc-save").click();

    await expect(async () => {
      const rows = await (await fetch(`${API}/admin/connections`, { headers: H })).json() as { id: string; groupsClaim: string | null }[];
      expect(rows.find((r) => r.id === b)?.groupsClaim, "the edited row took the change").toBe("roles");
      expect(rows.find((r) => r.id === a)?.groupsClaim, "the OTHER row was not written (the LIMIT 1 defect)").toBeNull();
    }).toPass({ timeout: 10_000 });
  } finally {
    await drop(a); await drop(b);
  }
});

test("#589: a long issuer stays on one line and never covers the row's controls", async ({ page }) => {
  // The ADR recorded this as "not verified here" — reading the code says the text overflows, but
  // whether it COVERS the buttons or just stretches the row is a question about geometry.
  const id = await makeConnection(LONG_ISSUER, "SIM 589 long");
  const other = await makeConnection("https://sim589-sibling.example.test", "SIM 589 sibling");
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/admin/auth");
    const row = page.getByTestId(`admin-connection-${id}`);
    await expect(row).toBeVisible({ timeout: 10_000 });

    const issuer = page.getByTestId(`admin-connection-issuer-${id}`);
    const del = row.getByTestId(`admin-connection-delete-${id}`);
    const [iBox, dBox] = [await issuer.boundingBox(), await del.boundingBox()];
    expect(iBox && dBox).toBeTruthy();

    // ONE line: the clipped text is no taller than a single line box (a wrapped issuer doubles it).
    expect(iBox!.height, "the issuer is one line, not wrapped").toBeLessThan(28);
    // and it ends before the controls start — no overlap, which is what "covers" would mean
    expect(iBox!.x + iBox!.width, "the issuer stops short of the row's buttons").toBeLessThanOrEqual(dBox!.x + 1);

    // the sibling exists so reordering is offered at all; with two rows both arrows are present
    await expect(row.getByRole("button", { name: /move/i })).toHaveCount(2);
  } finally {
    await drop(id); await drop(other);
  }
});

test("#589: reorder controls exist exactly when there is an order to change", async ({ page }) => {
  // Ordering IS the login screen's order; offering it for one row is a control that cannot do
  // anything (the old list rendered both arrows permanently disabled, forever).
  //
  // Both sides of the rule are measured against whatever this tenant currently has — no skip, which
  // would prove nothing, and no assumption about the seed.
  await page.goto("/admin/auth");
  await expect(page.getByTestId("sign-in-methods-list")).toBeVisible({ timeout: 10_000 });
  const rows = page.locator("[data-testid^=admin-connection-]").filter({ has: page.locator("[data-testid^=admin-connection-edit-]") });
  const count = await rows.count();
  expect(count, "the tenant has at least one connection to reason about").toBeGreaterThan(0);
  const expectedPerRow = count > 1 ? 2 : 0;
  for (let i = 0; i < count; i++) {
    await expect(rows.nth(i).getByRole("button", { name: /move/i }), `row ${i} of ${count}`).toHaveCount(expectedPerRow);
  }

  // and then the OTHER side of the rule, by changing the count: adding a second row makes the
  // controls appear (or, if there were already several, removing back down is covered by the loop).
  if (count === 1) {
    const extra = await makeConnection("https://sim589-order.example.test", "SIM 589 order");
    try {
      await page.reload();
      await expect(rows.first().getByRole("button", { name: /move/i })).toHaveCount(2);
    } finally {
      await drop(extra);
    }
  }
});
