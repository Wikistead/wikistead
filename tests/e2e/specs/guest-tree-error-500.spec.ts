import { test, expect } from "@playwright/test";
import { API } from "../helpers";

// #500: a failed guest tree fetch must read as an ERROR with a retry, never as "this space has no
// published pages" — the swallow (`.catch(() => setPages([]))`) turned FGA outages into a lying empty
// sidebar and derailed real-reviews. The wording is generic (no content disclosure).
const H = { Authorization: "Bearer dev-token", "content-type": "application/json" };

test("#500: a 500 from the guest tree shows an error + retry, not the empty message; retry recovers", async ({ browser }) => {
  test.skip(true, "#996: isolated — flaky under the 20-spec gate, a different assertion fails each run (demo_space is a shared fixture; suspected fixture-timing race, unconfirmed)");
  // a space link over demo_space (it has published pages)
  const res = await fetch(`${API}/share-links`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ resource: { type: "space", id: "demo_space" }, capability: "view" }),
  });
  const link = (await res.json()) as { id: string };
  expect(link.id).toBeTruthy();

  const guest = await (await browser.newContext()).newPage();
  // fail the tree fetch (only the GET tree — everything else passes through)
  await guest.route("**/spaces/*/pages", (route) =>
    route.request().method() === "GET" ? route.fulfill({ status: 500, body: JSON.stringify({ error: "boom" }) }) : route.fallback(),
  );
  await guest.goto(`/share/${link.id}`);

  await expect(guest.getByTestId("guest-tree-error"), "the failure shows as an error").toBeVisible({ timeout: 10000 });
  await expect(guest.getByTestId("guest-sidebar-empty"), "…never as the empty-space message").toHaveCount(0);

  // recovery: lift the failure and retry in place
  await guest.unroute("**/spaces/*/pages");
  await guest.getByTestId("guest-tree-retry").click();
  await expect(guest.getByTestId("guest-tree-page").first(), "retry loads the real tree").toBeVisible({ timeout: 10000 });
  await expect(guest.getByTestId("guest-tree-error")).toHaveCount(0);
});
