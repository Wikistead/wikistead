import { test, expect } from "@playwright/test";
import { openScratch, sleep, API } from "../helpers";

// #578 (review rejection 2026-08-05): the page permissions dialog printed a 70-character hex subject where a
// name belongs. Three sites in one file unwrap a principal; one of them reached the shared label and the
// other two did not, and the file-level scan let the good one excuse the bad ones.
//
// This measures the dialog the reader opens, because the reject was measured there — and because the fix
// is half server (the endpoints carry no name to print until they resolve one) and half client. A source
// scan cannot see a missing projection.
//
// The principal is a REAL member with a long sub: the reject notes the defect reproduces for a current
// member, not only for the orphan rows #624 recorded. Granted and restricted here, removed at the end.
// A member whose name the product cannot resolve — the case the dialog was printing as a hash. Taken
// from the tenant rather than invented: #624's guard refuses a grant to somebody who is not here, so an
// orphan cannot be manufactured through the API, and a REAL member with no display name is the same
// question (the reject says so: "70 sub ").
//
// The assertion is that the SUBJECT ITSELF is not on screen, not that no hex is: a sub can be a UUID,
// and "no run of hex" would pass on one of those while the id sat there in full.
test("#578: the permissions dialog names people, never their subject id", async ({ page }) => {
  test.setTimeout(180_000);
  const pageId = await openScratch(page, `perm578-${Date.now()}`);

  const picked = await page.evaluate(async ({ api }) => {
    const r = await fetch(`${api}/members`, { headers: { Authorization: "Bearer dev-token" } });
    if (!r.ok) return null;
    // the admin list projects the row as it is stored (`display_name`), not as the client camelCases it
    const body = (await r.json()) as { members?: { sub: string; display_name?: string | null }[] };
    const all = body.members ?? [];
    const byLength = (a: { sub: string }, b: { sub: string }) => b.sub.length - a.sub.length;
    return {
      // the one the product cannot name: the dialog must not fall back to printing the id
      nameless: all.filter((m) => !m.display_name?.trim() && m.sub.length > 16).sort(byLength)[0]?.sub ?? null,
      // and one it CAN name — without this the server half of the fix is unmeasured, because a member
      // with no name reads the same whether or not the endpoint resolves names at all (measured: the
      // projection could be deleted and this spec stayed green)
      named: all.filter((m) => m.display_name?.trim() && m.sub !== "dev-user").sort(byLength)[0] ?? null,
    };
  }, { api: API });
  const sub = picked.nameless;
  expect(sub, "the tenant has a member whose name cannot be resolved (else this measures nothing)").toBeTruthy();
  expect(picked.named, "…and one it can name (else the server's projection is unmeasured)").toBeTruthy();

  const seated = await page.evaluate(async ({ api, sub, named, id }) => {
    const grant = await fetch(`${api}/pages/${id}/access`, {
      method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ grantee: `user:${sub}`, relation: "view" }),
    });
    const grant2 = await fetch(`${api}/pages/${id}/access`, {
      method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ grantee: `user:${named}`, relation: "view" }),
    });
    const restrict = await fetch(`${api}/pages/${id}/restrict`, {
      method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ principal: `user:${sub}` }),
    });
    return { grant: grant.status, grant2: grant2.status, restrict: restrict.status, why: await grant.text().catch(() => "") };
  }, { api: API, sub: sub!, named: picked.named!.sub, id: pageId });
  expect(seated.grant, `the fixture grant landed :: ${JSON.stringify(seated)}`).toBeLessThan(300);

  try {
    await page.reload();
    await page.waitForSelector("[data-testid=page-overflow-trigger]", { timeout: 15_000 });
    await page.click("[data-testid=page-overflow-trigger]");
    const permsItem = page.getByTestId("m-permissions").or(page.getByTestId("permissions-open")).first();
    await expect(permsItem).toBeVisible({ timeout: 8_000 });
    await permsItem.click();
    await expect(page.getByTestId("permissions-dialog")).toBeVisible({ timeout: 8_000 });
    await sleep(600);

    // the ACCESS list: the row exists, and it does not read as a hash
    const grantText = (await page.getByTestId("grant-item").allTextContents()).join(" | ");
    expect(grantText, "the fixture grant is in the list").toContain("(");
    // the server resolves names for this list the way /spaces/:id/access has since #523 — a member who
    // HAS a name is shown by it, not as "unknown"
    expect(grantText, `the named member is shown by name :: ${grantText}`).toContain(picked.named!.display_name!);
    expect(grantText, `the access list printed the subject id :: ${grantText}`).not.toContain(sub!);

    // the RESTRICTIONS list: the same question of the second list, which had its own unwrapping site
    if (seated.restrict < 300) {
      await page.getByTestId("permissions-tab-restrictions").click();
      await sleep(400);
      const restrictText = (await page.getByTestId("restrict-item").allTextContents()).join(" | ");
      expect(restrictText, `the restriction list printed the subject id :: ${restrictText}`).not.toContain(sub!);
    }

    // and nowhere in the dialog at all — the reject measured the whole panel, not one row
    const whole = (await page.getByTestId("permissions-dialog").textContent()) ?? "";
    expect(whole, `the subject id is visible somewhere in the dialog :: ${whole.slice(0, 300)}`).not.toContain(sub!);
  } finally {
    await page.evaluate(async ({ api, sub, named, id }) => {
      await fetch(`${api}/pages/${id}/restrict`, {
        method: "DELETE", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
        body: JSON.stringify({ principal: `user:${sub}` }),
      }).catch(() => {});
      for (const who of [sub, named]) {
        await fetch(`${api}/pages/${id}/access`, {
          method: "DELETE", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
          body: JSON.stringify({ grantee: `user:${who}`, relation: "view" }),
        }).catch(() => {});
      }
    }, { api: API, sub: sub!, named: picked.named!.sub, id: pageId });
  }
});
