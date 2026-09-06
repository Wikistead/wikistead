import { test, expect } from "@playwright/test";
import { API } from "../helpers";

// #500: a failed guest tree fetch must read as an ERROR with a retry, never as "this space has no
// published pages" — the swallow (`.catch(() => setPages([]))`) turned FGA outages into a lying empty
// sidebar and derailed real-reviews. The wording is generic (no content disclosure).
const H = { Authorization: "Bearer dev-token", "content-type": "application/json" };

test("#500: a 500 from the guest tree shows an error + retry, not the empty message; retry recovers", async ({ browser }) => {
  // #998: this test's own retry assertion needs the tree to have a non-home page to SHOW once the
  // fetch succeeds — demo_space's only always-there page is its home page 'demo', which #364 excludes
  // from the tree deliberately. Whether that page exists at retry time used to depend entirely on
  // whichever OTHER spec happened to create one first (real in a full 20-spec gate run that runs
  // dozens of them, absent standalone or early in a smaller run — reproduced here: 3/3 standalone runs
  // failed at the SAME assertion, not "a different one each time" as first suspected). Create the page
  // this test needs itself, the same fix shape as #939/#969.
  const seed = await fetch(`${API}/spaces/demo_space/pages`, {
    method: "POST", headers: H, body: JSON.stringify({ title: `Guest tree fixture ${Date.now()}` }),
  });
  expect(seed.ok, "a page for the guest tree to show after retry").toBe(true);
  const { id: seedPageId } = (await seed.json()) as { id: string };
  // a new page is an unpublished draft — invisible on the guest surface until published.
  // no content-type here: this POST has no body, and the server 400s a JSON content-type on an empty one.
  const published = await fetch(`${API}/pages/${seedPageId}/publish`, { method: "POST", headers: { Authorization: H.Authorization } });
  expect(published.ok, "the fixture page is published, so the guest tree can show it").toBe(true);

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
