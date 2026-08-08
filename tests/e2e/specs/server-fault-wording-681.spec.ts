import { test, expect } from "@playwright/test";

// #681: the sign-in screen said "that email and password do not work" while the server was answering
// 500 with `column "second_factor_kinds" does not exist`. The reporter suspected their own password
// first and lost minutes to it.
//
// The server draws the line on purpose — a broken dependency is not a fact about anyone's credentials
// and the screen threw it away in a `!res.ok` branch. During an outage that sends every reader to the
// password-reset flow, and the operator sees only "people cannot log in", never the 500.
//
// The unit pin covers the predicate. What this covers is the SENTENCE, because the whole defect is that
// a reader was told the wrong thing.
test("#681: a 500 does not blame the reader's password", async ({ page }) => {
  test.setTimeout(60_000);
  // ⚠️ the route is installed BEFORE the screen loads: the form posts on submit, and a route added
  // afterwards would race the click.
  await page.route("**/auth/local/login", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }));

  await page.goto("/login/recovery");
  await expect(page.getByTestId("login-local")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("login-local-identifier").fill("someone@example.test");
  await page.getByTestId("login-local-password").fill("whatever-1234");
  await page.getByTestId("login-local-submit").click();

  const err = page.getByTestId("login-local-error");
  await expect(err, "the screen said nothing at all").toBeVisible({ timeout: 20_000 });
  const text = (await err.textContent()) ?? "";
  // The reader must not be pointed at their own input. Asserted as the ABSENCE of the credential
  // sentence plus the presence of the outage one, so a third wording cannot pass by accident.
  // ⚠️ Matched against the SHIPPED wording, read out of the locale files rather than guessed: the first
  // draft looked for "email and password" and the English string says "email address and password", so
  // the contrast case failed for a reason that had nothing to do with the product.
  expect(text, `a 500 still blamed the credentials: ${text}`).not.toMatch(/メールアドレスとパスワード|email address and password/);
  expect(text, `a 500 did not say the service is at fault: ${text}`).toMatch(/問題が起きて|wrong on our side/);
});

test("#681: a 401 still says the credentials are wrong (the contrast)", async ({ page }) => {
  // Without this, answering "something is wrong on our side" to EVERYTHING would satisfy the case
  // above — and a real wrong password would stop telling the reader to check it.
  test.setTimeout(60_000);
  await page.route("**/auth/local/login", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "no" }) }));

  await page.goto("/login/recovery");
  await expect(page.getByTestId("login-local")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("login-local-identifier").fill("someone@example.test");
  await page.getByTestId("login-local-password").fill("whatever-1234");
  await page.getByTestId("login-local-submit").click();

  const err = page.getByTestId("login-local-error");
  await expect(err).toBeVisible({ timeout: 20_000 });
  const text = (await err.textContent()) ?? "";
  expect(text, `a 401 stopped naming the credentials: ${text}`).toMatch(/メールアドレスとパスワード|email address and password/);
});
