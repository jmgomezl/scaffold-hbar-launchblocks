import { type Page, expect, test } from "@playwright/test";

type GalleryEntry = { id: string; title: string; flow: { id: string; steps: { id: string; type: string }[] } };

test.beforeEach(async ({ page }) => {
  // Loading an example over a launch asks for confirmation.
  page.on("dialog", dialog => void dialog.accept());
});

/** The studio has drawn the flow's blocks under the Launch block and validated them. */
async function expectValid(page: Page, steps: number) {
  await expect(page.getByText("valid", { exact: true })).toBeVisible();
  // The Run panel counts the steps connected on the canvas.
  await expect(page.getByText(/steps? will run in order on testnet/)).toHaveText(
    new RegExp(`^${steps} steps? will run in order on testnet`),
  );
}

test("opens every gallery example as a valid launch", async ({ page, request }) => {
  const { flows } = (await (await request.get("/api/launchblocks/gallery")).json()) as { flows: GalleryEntry[] };
  expect(flows.length).toBeGreaterThan(0);

  await page.goto("/launch");
  for (const entry of flows) {
    await page.getByLabel("Load an example flow").selectOption(entry.id);
    await expectValid(page, entry.flow.steps.length);
  }
});

test("opens the example a link names", async ({ page }) => {
  await page.goto("/launch?example=hts-launch-scheduled-unlocks");
  await expect(page).toHaveURL(/\/launch$/);
  await expectValid(page, 6);
  await page.getByRole("tab", { name: "Outputs" }).click();
  // The Outputs drawer lists each step's outputs under its id.
  await expect(page.locator("aside").getByText("unlockMonth1", { exact: true })).toBeVisible();
});

test("flags a problem as soon as a block's field is wrong, and blocks the run", async ({ page }) => {
  await page.goto("/launch?example=hts-launch-basic");
  await expectValid(page, 5);

  // Edit the token symbol on its block to an empty string.
  await page.locator(".blocklyEditableField", { hasText: "LBD" }).first().click();
  const editor = page.locator(".blocklyHtmlInput");
  await editor.fill("");
  await editor.press("Enter");

  const badge = page.getByRole("button", { name: /1 problem/ });
  await expect(badge).toBeVisible();
  await expect(page.getByRole("button", { name: "Run on testnet" })).toBeDisabled();
  await badge.click();
  await expect(page.getByRole("tab", { name: /Problems/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText(/createToken ·.*symbol/)).toBeVisible();
});

test("exports the launch as flow JSON and as a launch.ts that calls the core", async ({ page }) => {
  await page.goto("/launch?example=hts-launch-basic");
  await expectValid(page, 5);
  await page.getByRole("button", { name: "Export" }).click();

  const code = page.locator("dialog[open] pre code");
  await expect(code).toContainText('"id": "hts-launch-basic"');
  await page.getByRole("tab", { name: "launch.ts" }).click();
  await expect(code).toContainText("await createFungibleToken(ctx");
  await expect(page.getByRole("button", { name: "Download launch.ts" })).toBeEnabled();
});

test("explains why a run cannot start on a server without an operator", async ({ page, request }) => {
  // The guard that keeps this test from spending HBAR.
  expect(await (await request.get("/api/launchblocks/operator")).json()).toMatchObject({ accountId: null });

  await page.goto("/launch?example=hts-launch-basic");
  await expectValid(page, 5);
  await page.getByRole("button", { name: "Run on testnet" }).click();
  const error = page.locator(".alert-error", { hasText: "OPERATOR_MISSING" });
  await expect(error).toBeVisible();
  await expect(error).toContainText("HEDERA_OPERATOR_ID");
});
