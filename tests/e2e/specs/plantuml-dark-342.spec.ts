import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #342: a dark-mode plantuml render injects a built-in `!theme` server-side. The client forwards the
// resolved theme with the render request, and because the macro widget bakes its theme into eq() (#200),
// a light→dark switch REBUILDS the widget → RE-POSTs the render with theme="dark" in realtime. We stub the
// operator render endpoint (204 = degrade; the real image needs a configured Kroki, a needs-human-check
// visual) and assert the request the widget sends flips to theme="dark" on the switch. Real Chromium (the
// theme switch → widget rebuild → re-fetch chain is only observable end-to-end in a browser).
test("#342: switching to dark re-POSTs the plantuml render with theme=dark", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const bodies: { source?: string; theme?: string }[] = [];
  await page.route("**/plantuml/render", async (route) => {
    try { bodies.push(JSON.parse(route.request().postData() ?? "{}")); } catch { /* ignore */ }
    await route.fulfill({ status: 204, body: "" }); // degrade — we only assert the request the client sent
  });

  await openScratch(page, "plantuml-dark");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // insertText (paste-like) leaves the caret past the block so it renders as the widget → it POSTs.
  await page.keyboard.insertText("```plantuml\n@startuml\nA->B\n@enduml\n```\n");
  await sleep(500);

  // The widget rendered and asked the host to render its source (light / system-resolved theme).
  await expect.poll(() => bodies.length, { timeout: 5000 }).toBeGreaterThan(0);
  expect(bodies.every((b) => b.theme !== "dark"), "no dark render before the switch").toBe(true);

  // Switch to dark → #200 rebuilds the macro widgets → the plantuml widget re-fetches with theme="dark".
  await page.click("[data-testid=theme-toggle]");
  await page.locator("[data-testid=theme-menu]").getByText("Dark", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await sleep(500);

  await expect
    .poll(() => bodies.some((b) => b.theme === "dark"), { timeout: 5000 })
    .toBe(true);
  // the source the client sends is unchanged — the server owns the `!theme` injection (kept out of Y.Text).
  const dark = bodies.find((b) => b.theme === "dark")!;
  expect(dark.source).toContain("@startuml");
  expect(dark.source).not.toContain("!theme");
});
