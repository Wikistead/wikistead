import { test, expect } from "@playwright/test";

test("#907: space settings returns to the space that opened it", async ({ page }) => {
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");

  const spaceId = await page.evaluate(async () => {
    const response = await fetch("/api/spaces", {
      method: "POST",
      headers: { authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ name: `settings-back-${Date.now().toString(36)}` }),
    });
    if (!response.ok) throw new Error(`Failed to create a space: ${response.status}`);
    const space = (await response.json()) as { id: string };
    return space.id;
  });

  await page.goto(`/spaces/${spaceId}/settings/general`);
  await expect(page.getByTestId("space-general")).toBeVisible();
  await page.getByTestId("settings-back").click();

  await expect(page).toHaveURL(new RegExp(`/spaces/${spaceId}$`));
  await expect(page.getByTestId("space-home-empty")).toBeVisible();
});
