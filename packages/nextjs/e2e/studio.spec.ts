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

test("folds the settings most launches leave alone until asked", async ({ page }) => {
  await page.goto("/launch?example=hts-launch-basic");
  await expectValid(page, 5);
  const canvas = page.locator(".blocklyBlockCanvas");
  await expect(canvas.getByText("Fee numerator")).toHaveCount(0);

  const more = canvas.locator(".blocklyLabelField", { hasText: "more settings (11)" });
  await more.locator("xpath=preceding-sibling::*[1]").click();
  await expect(canvas.getByText("Fee numerator")).toBeVisible();
  // Folding is only a view: the flow is the same.
  await expectValid(page, 5);
});

test("unfolds folded settings when one of them has a problem", async ({ page, request }) => {
  const { flows } = (await (await request.get("/api/launchblocks/gallery")).json()) as { flows: GalleryEntry[] };
  const flow = structuredClone(flows.find(entry => entry.id === "hts-launch-basic")!.flow) as GalleryEntry["flow"] & {
    steps: { params: Record<string, unknown> }[];
  };
  flow.steps[0]!.params.fractionalFee = { numerator: 1, denominator: 0, assessment: "inclusive" };
  await page.addInitScript(saved => localStorage.setItem("launchblocks.flow.v1", saved), JSON.stringify(flow));

  await page.goto("/launch");
  await expect(page.getByRole("button", { name: /1 problem/ })).toBeVisible();
  await expect(page.locator(".blocklyBlockCanvas").getByText("Fee denominator")).toBeVisible();
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

test("says what a run costs before anything is sent", async ({ page }) => {
  await page.goto("/launch?example=hts-launch-basic");
  await expectValid(page, 5);
  // Token with custom fees 26, topic 0.4, two messages 0.2, mint 0.1.
  const cost = page.getByText("Costs about 26.7 ℏ, paid by the default account");
  await expect(cost).toBeVisible();
  await cost.click();
  await expect(page.getByRole("cell", { name: /createToken/ })).toBeVisible();
});

test("shares a launch as a link that opens the same blocks for someone else", async ({ page, context, browser }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/launch?example=hts-launch-scheduled-unlocks");
  await expectValid(page, 6);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/\/launch#flow=[A-Za-z0-9_-]+$/);

  // A visitor with nothing saved opens it.
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(link);
  await expectValid(visitor, 6);
  await expect(visitor).toHaveURL(/\/launch$/);
  await expect(visitor.locator(".blocklyBlockCanvas").getByText("unlockMonth2", { exact: true })).toBeVisible();
  await visitor.context().close();
});

test("finds a launch page by its log's topic id, and answers 404 when there is none", async ({ page }) => {
  await page.goto("/launches");
  await expect(page.getByRole("heading", { name: "Launches", exact: true })).toBeVisible();
  const response = await page.goto("/launches?topic=not-a-topic");
  expect(response?.status()).toBe(404);
  await expect(page).toHaveURL(/\/launches\/not-a-topic$/);
  await expect(page.getByRole("heading", { name: "No launch log with that id" })).toBeVisible();
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
