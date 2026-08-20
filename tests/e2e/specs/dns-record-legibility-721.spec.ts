import { test, expect } from "@playwright/test";
import { openDemo } from "../helpers";

// #721the DNS challenge has to LOOK like three fields.
//
// The names landed and the reader still could not read it: the rows look misaligned somehow, and it
// is hard to tell whether this is a table or plain text. Measured on that version, the labels lined
// up and the values
// lined up — the columns were fine. What was wrong was between the rows and inside them:
//
//   * only two of the three fields carried a copy button, so their lines were 32px tall and the first
//     was 15px, and the three rows sat 27px and 36px apart. The eye follows the text, so unequal
//     spacing reads as misalignment even when every left edge agrees.
//   * label and value were both 11px in the same dim colour, separated by position alone — which is
//     precisely "is this a table or is it a paragraph".
//
// WHY AN E2E: both facts are computed style and layout. A class-name assertion passes on a build where
// the token behind the class is undefined and nothing is painted (#535), and happy-dom has no layout
// engine, so every rect there is zero and agrees with any answer.
//
// The rows are stubbed rather than created: the question is entirely about how a PENDING record is
// drawn, and creating one for real needs an entitled plan plus DNS the test cannot publish. The stub
// answers the endpoint's own shape (`{ domains, nextCursor }`); the row-count assertion below is what
// keeps this honest if that shape moves.
const DOMAINS = {
  domains: [{
    domain: "docs.example.com",
    status: "pending",
    verifiedAt: null,
    challengeRecord: "_wikistead-challenge.docs.example.com",
    challengeValue: "49Soh4EsmKjQxNWEG4FNIfOYj3xm70Mw",
    passkeysStranded: 0,
  }],
  nextCursor: null,
};

const FIELDS = ["type", "host", "value"] as const;

test("#721the DNS record reads as three fields, evenly spaced and telling name from value", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.route((url) => url.pathname === "/api/admin/custom-domains", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(DOMAINS) })
      : route.fallback());

  await openDemo(page);
  await page.goto("/admin/domains");
  await expect(page.getByTestId("domain-challenge"), "the pending record is on screen").toBeVisible({ timeout: 30_000 });
  // The element being visible says nothing about its rows; an empty box is visible too.
  await expect(page.getByTestId("domain-challenge-value")).toHaveText(DOMAINS.domains[0]!.challengeValue, { timeout: 10_000 });

  const measured = await page.evaluate((fields) => {
    const read = (el: Element | null) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { top: r.top, look: `${cs.fontSize}/${cs.fontWeight}/${cs.color}/${cs.letterSpacing}`, text: (el.textContent ?? "").trim() };
    };
    return fields.map((f) => ({
      field: f,
      label: read(document.querySelector(`[data-testid="domain-challenge-${f}-label"]`)),
      value: read(document.querySelector(`[data-testid="domain-challenge-${f}"]`)),
      copy: document.querySelector(`[data-testid="domain-challenge-${f}-copy"]`)?.getBoundingClientRect() ?? null,
    }));
  }, [...FIELDS]);

  // 0. All three fields are actually on screen. A measurement of nothing agrees with every layout.
  for (const m of measured) {
    expect(m.label, `${m.field} has a label element`).not.toBeNull();
    expect(m.value, `${m.field} has a value element`).not.toBeNull();
    expect(m.label!.text.length, `${m.field}'s label carries text`).toBeGreaterThan(0);
  }

  // 1. THE RULING'S (a): the three fields are evenly spaced. Measured on the LABELS, because those are
  //    the lines the eye tracks down the block, and rounded to a pixel so subpixel layout is not the
  //    thing being asserted. Unequal spacing was the reported "rows look misaligned".
  const gaps = FIELDS.slice(1).map((_, i) => Math.round(measured[i + 1]!.label!.top - measured[i]!.label!.top));
  expect(new Set(gaps).size, `the three fields are unevenly spaced: ${JSON.stringify(gaps)}`).toBe(1);
  expect(gaps[0], "…and they are spaced apart at all, rather than collapsed into one line").toBeGreaterThan(20);

  // 2. THE RULING'S (b): a name does not look like a value. Compared as one string of the properties a
  //    reader actually distinguishes by — if the two ever paint the same, position is again the only
  //    difference and the block goes back to reading as a paragraph.
  for (const m of measured) {
    expect(m.value!.look, `${m.field}: the name and the value are painted identically (${m.look ?? m.value!.look})`)
      .not.toBe(m.label!.look);
  }

  // 3. The copy control belongs to the value it copies. It used to sit at the end of a column that
  //    stretched to fill the pane, 150px of empty space away from the string it copies, so which row
  //    it belonged to was a guess.
  for (const m of measured) {
    if (!m.copy) continue; // the record TYPE is chosen from a dropdown, never pasted
    const valueEl = await page.getByTestId(`domain-challenge-${m.field}`).boundingBox();
    expect(valueEl, `${m.field}'s value has a box`).not.toBeNull();
    const gap = m.copy.left - (valueEl!.x + valueEl!.width);
    expect(gap, `${m.field}: the copy control is ${Math.round(gap)}px from its value`).toBeLessThan(48);
  }
});
