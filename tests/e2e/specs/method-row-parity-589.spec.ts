import { test, expect } from "@playwright/test";

// #589 (review rejection): " ON/OFF SAML
//
// One row per sign-in method was the whole point of the ticket, and three hand-written row shapes is
// what it actually shipped: the password row switched from the row, the OIDC row switched from a stack
// below it, SAML switched only after expanding and saving, and "add a connection" opened a card with
// different padding OUTSIDE the list.
//
// The pin walks the rows instead of naming the methods (#544): every row carries `data-method-row`, so
// the fifth method (local users, #568) is measured by existing rather than by someone remembering to
// add it here. What is compared is what a reader sees — computed padding, and where the on/off control
// sits — not the classes that produce it.
test("#589: every sign-in method is the same kind of row", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/admin/auth");
  await expect(page.getByTestId("sign-in-methods")).toBeVisible({ timeout: 15_000 });

  const measure = () => page.evaluate(() => {
    const list = document.querySelector("[data-testid=sign-in-methods-list]")!;
    return [...list.querySelectorAll<HTMLElement>("[data-method-row]")].map((row) => {
      const cs = getComputedStyle(row);
      // the row's FIRST switch is the method's on/off by construction; a connection row also carries an
      // MCP switch (#592) further down, which is a different question and is not what this measures
      const sw = row.querySelector("[data-slot=switch], button[role=switch]");
      const head = row.firstElementChild;
      return {
        id: row.getAttribute("data-testid") ?? "?",
        pad: `${cs.paddingTop}/${cs.paddingRight}/${cs.paddingBottom}/${cs.paddingLeft}`,
        inList: list.contains(row),
        // the on/off control, if the row has one, must hang off the row's FIRST line — the same place
        // on every row. A switch parked in a stack below the head is a different act to perform.
        switchInHead: sw ? !!head?.contains(sw) : null,
      };
    });
  });

  const rows = await measure();
  expect(rows.length, "the list drew rows to compare").toBeGreaterThan(1);
  expect([...new Set(rows.map((r) => r.pad))], `rows disagree on padding: ${JSON.stringify(rows)}`).toHaveLength(1);
  expect(rows.filter((r) => r.switchInHead === false).map((r) => r.id), "every switch sits on the row's first line").toEqual([]);

  // …and adding a connection extends the list rather than opening a card beside it
  await page.getByTestId("admin-connection-add").click();
  await expect(page.getByTestId("admin-connection-form")).toBeVisible();
  const withForm = await measure();
  expect(withForm.some((r) => r.id === "admin-connection-form"), "the add form is a row IN the list").toBe(true);
  expect([...new Set(withForm.map((r) => r.pad))], `the add row disagrees on padding: ${JSON.stringify(withForm)}`).toHaveLength(1);
});

// #605 (review rejection, 2026-08-05): "
// ..." — and, once the stance was on, three separate strings said the row was
// off ("SSO " / / ) while the sentence they crowded out
// was the one explaining what the method IS.
//
// Walked, not named (the rule this file already follows): every row is asked whether any text inside it
// is cut off. A VALUE may be — an issuer URL is deliberately one line, with the whole of it a click
// away in the editor — and those carry `data-clip="value"`. Anything else that overflows is prose
// somebody let run out of room, and this fails naming it.
test("#605: nothing in a sign-in row is cut off, and one reason is enough", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/admin/auth");
  await expect(page.getByTestId("sign-in-methods")).toBeVisible({ timeout: 15_000 });

  const clipped = await page.evaluate(() => {
    const list = document.querySelector("[data-testid=sign-in-methods-list]")!;
    const out: string[] = [];
    for (const row of list.querySelectorAll<HTMLElement>("[data-method-row]")) {
      for (const el of row.querySelectorAll<HTMLElement>("*")) {
        if (el.children.length > 0) continue; // leaves carry the text
        if (el.closest("[data-clip=value]")) continue; // a deliberate one-liner
        if (el.scrollWidth > el.clientWidth + 1) {
          out.push(`${row.getAttribute("data-testid")}: "${(el.textContent ?? "").trim().slice(0, 40)}"`);
        }
      }
    }
    return out;
  });
  expect(clipped, "text cut off inside a sign-in row").toEqual([]);

  // …and no row states its condition twice. The selection badge is one fact; a reason is the other.
  // Two reasons on one row is the doubling #589 removed and the stance brought back.
  const doubled = await page.evaluate(() => {
    const list = document.querySelector("[data-testid=sign-in-methods-list]")!;
    return [...list.querySelectorAll<HTMLElement>("[data-method-row]")]
      .map((row) => ({
        id: row.getAttribute("data-testid") ?? "?",
        reasons: row.querySelectorAll("[data-testid=sign-in-method-blocked], [data-testid=blocked-by-stance]").length,
      }))
      .filter((r) => r.reasons > 1)
      .map((r) => `${r.id}: ${r.reasons} reasons`);
  });
  expect(doubled, "a row saying the same thing twice").toEqual([]);
});

// …and the same two claims with the STANCE BITING, which is the state the reject was looking at.
// Turning it on for real needs an exempt member who holds a password, and a password needs a person to
// set one — so the READ is stubbed and nothing else is: this measures rendering, which is what the
// reject was about. (The stance's own writes are measured server-side in sso-required-605.)
test("#605: a blocked row says why once, and still fits its sentence", async ({ page }) => {
  test.setTimeout(120_000);
  await page.route("**/api/admin/login-methods", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    if (body?.methods?.local) {
      body.methods.local.selected = true;
      body.methods.local.effective = false;
      body.methods.local.blockedByStance = true;
    }
    if (body?.methods?.["platform-oidc"]) body.methods["platform-oidc"].blockedByStance = true;
    body.ssoRequired = { selected: true, biting: true };
    await route.fulfill({ response: res, body: JSON.stringify(body) });
  });

  try {
    await page.goto("/admin/auth");
    await expect(page.getByTestId("sign-in-methods")).toBeVisible({ timeout: 15_000 });
    const row = page.getByTestId("sign-in-method-local");
    await expect(row, "the stubbed state reached the screen").toBeVisible();
    await expect(row.getByTestId("blocked-by-stance"), "the row says why it is off").toHaveCount(1);

    const shot = await page.evaluate(() => {
      const row = document.querySelector("[data-testid=sign-in-method-local]") as HTMLElement;
      const clipped: string[] = [];
      for (const el of row.querySelectorAll<HTMLElement>("*")) {
        if (el.children.length > 0 || el.closest("[data-clip=value]")) continue;
        if (el.scrollWidth > el.clientWidth + 1) clipped.push((el.textContent ?? "").trim().slice(0, 40));
      }
      return {
        clipped,
        reasons: row.querySelectorAll("[data-testid=sign-in-method-blocked], [data-testid=blocked-by-stance]").length,
      };
    });
    expect(shot.clipped, "the description survives the badges").toEqual([]);
    expect(shot.reasons, "one reason, not two — the selection badge carries the other fact").toBe(1);

    // #605 (review rejection, 2026-08-05): "SSO /
    // ON ". Both facts were the same 11px grey, and the
    // switch wore the accent — so the row read as ON with a footnote. MEASURED, not eyeballed: the colour
    // of a thing is a computed style, and "it looks clearer now" is not a check.
    const look = await page.evaluate(() => {
      const row = document.querySelector("[data-testid=sign-in-method-local]") as HTMLElement;
      const badge = row.querySelector("[data-testid=blocked-by-stance]") as HTMLElement;
      const track = row.querySelector("[data-testid=local-login-toggle]") as HTMLElement;
      // The knob has no element of its own: the track paints it with background-position (wks-switch,
      // ds-controls.css, #389). So `data-state` IS the knob position, and the muted colour is read
      // off a probe rather than hard-coded — a literal here would pass on a theme that moved the token.
      const probe = document.createElement("div");
      probe.style.background = "var(--panel-3)";
      document.body.appendChild(probe);
      const muted = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const b = getComputedStyle(badge);
      const t = getComputedStyle(track);
      return {
        badgeBorder: b.borderTopWidth,
        badgeColour: b.color,
        stateColour: getComputedStyle(row.querySelector("[data-testid=sign-in-method-state]") as HTMLElement).color,
        trackBg: t.backgroundColor,
        checked: track?.getAttribute("data-state") ?? track?.getAttribute("aria-checked"),
        disabled: (track as HTMLButtonElement)?.disabled ?? false,
        rowOpacity: getComputedStyle(row).opacity,
        muted,
      };
    });
    // the reason is the headline: it wears a border, and it is NOT the same colour as the selection text
    expect(parseFloat(look.badgeBorder), `the reason has no border :: ${JSON.stringify(look)}`).toBeGreaterThan(0);
    expect(look.badgeColour, `the reason reads exactly like the selection label :: ${JSON.stringify(look)}`)
      .not.toBe(look.stateColour);
    // the track is not wearing the accent — an accent track says "on and working", the one thing it is not
    expect(look.trackBg, `the blocked toggle does not wear the muted track :: ${JSON.stringify(look)}`)
      .toBe(look.muted);
    // …while the selection itself is preserved, pressable, and the row is not dimmed (all three ruled)
    expect(String(look.checked), "the selection is still shown as made").toMatch(/checked|true/);
    expect(look.disabled, "the switch stays pressable — the setting can still be changed").toBe(false);
    expect(look.rowOpacity, "the row is not dimmed").toBe("1");
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});
