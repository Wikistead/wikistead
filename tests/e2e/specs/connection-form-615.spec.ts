import { test, expect } from "@playwright/test";
import { API , sweepConnections} from "../helpers";

// #623: my own debris from failed runs, swept on the way IN (the cap makes leftovers block the suite).
test.beforeAll(async () => { await sweepConnections(["http://127.0.0.1:9/"]); });

// #615: a connection is configured where it is created.
//
// What happened: an admin made an OIDC connection from the form, signed in, and no groups arrived —
// because the claim name and the trust switch were not on the form. The connection had to be created,
// then reopened, then saved again, and until that second pass it looked broken rather than unconfigured.
//
// Measured through a real browser and read back from the API, because the claim is about what the FORM
// sends: a field that renders but is dropped on submit would pass any source-level check.
const cleanup = async (request: import("@playwright/test").APIRequestContext, id: string) => {
  await request.delete(`${API}/admin/connections/${id}`, { headers: { Authorization: "Bearer dev-token" } }).catch(() => {});
};

test("#615: the create form carries the groups claim and the trust switch", async ({ page, request }) => {
  test.setTimeout(120_000);
  const stamp = Date.now().toString(36);
  const label = `e2e-615-${stamp}`;
  let created: string | undefined;

  try {
    await page.goto("/admin/auth");
    await expect(page.getByTestId("sign-in-methods")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("admin-connection-add").click();
    await expect(page.getByTestId("admin-connection-form")).toBeVisible();

    await page.getByTestId("admin-connection-issuer").fill(`http://127.0.0.1:9/${stamp}`);
    await page.getByTestId("admin-connection-label").fill(label);
    await page.getByTestId("admin-connection-clientid").fill("cid-615");
    await page.getByTestId("admin-connection-redirect").fill("http://dev.localhost/auth/callback");
    // the two this ticket is about — both on the form, before the connection exists
    await page.getByTestId("admin-connection-groups-claim").fill("roles");
    await page.getByTestId("admin-connection-trust-groups").click();
    await page.getByTestId("admin-connection-save").click();

    // read the server's answer: what the form SENT, not what it drew
    await expect.poll(async () => {
      const list = await request.get(`${API}/admin/connections`, { headers: { Authorization: "Bearer dev-token" } }).then((r) => r.json());
      const mine = (Array.isArray(list) ? list : []).find((c: { label?: string }) => c.label === label);
      created = mine?.id;
      return mine ? { claim: mine.groupsClaim, trust: mine.trustGroups } : null;
    }, { timeout: 15_000 }).toEqual({ claim: "roles", trust: true });
  } finally {
    if (created) await cleanup(request, created);
  }
});

test("#615: leaving them alone still creates the connection the way it always did", async ({ page, request }) => {
  test.setTimeout(120_000);
  const stamp = Date.now().toString(36);
  const label = `e2e-615d-${stamp}`;
  let created: string | undefined;

  try {
    await page.goto("/admin/auth");
    await expect(page.getByTestId("sign-in-methods")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("admin-connection-add").click();
    await page.getByTestId("admin-connection-issuer").fill(`http://127.0.0.1:9/${stamp}`);
    await page.getByTestId("admin-connection-label").fill(label);
    await page.getByTestId("admin-connection-clientid").fill("cid-615d");
    await page.getByTestId("admin-connection-redirect").fill("http://dev.localhost/auth/callback");
    await page.getByTestId("admin-connection-save").click();

    // the defaults are the ADR-197 judgement and this ticket does not move them: an untouched claim
    // stays null (the server's `groups` decides) and an external IdP's groups stay untrusted
    await expect.poll(async () => {
      const list = await request.get(`${API}/admin/connections`, { headers: { Authorization: "Bearer dev-token" } }).then((r) => r.json());
      const mine = (Array.isArray(list) ? list : []).find((c: { label?: string }) => c.label === label);
      created = mine?.id;
      return mine ? { claim: mine.groupsClaim, trust: mine.trustGroups } : null;
    }, { timeout: 15_000 }).toEqual({ claim: null, trust: false });
  } finally {
    if (created) await cleanup(request, created);
  }
});
