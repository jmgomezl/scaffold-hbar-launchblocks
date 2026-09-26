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
  // Under the field's own label, in plain words.
  await expect(page.getByText("createToken · Symbol: Required")).toBeVisible();
});

/** Edit a block's id field in place: the first editable field showing `from`. */
async function renameStep(page: Page, from: string, to: string) {
  await page
    .locator(".blocklyEditableField", { hasText: new RegExp(`^${from}$`) })
    .first()
    .click();
  const editor = page.locator(".blocklyHtmlInput");
  await editor.fill(to);
  await editor.press("Enter");
}

test("keeps the launch's references on the original block when a block is duplicated", async ({ page }) => {
  await page.goto("/launch?example=hts-launch-basic");
  await expectValid(page, 5);
  // Duplicate "Mint tokens" (a paste takes the same path): the copy lands outside the Launch block.
  await page.locator(".blocklyBlockCanvas .blocklyText", { hasText: "Mint tokens" }).first().click({ button: "right" });
  await page.locator(".blocklyContextMenu").getByText("Duplicate", { exact: true }).click();

  // The only problem is the loose copy; recordMint still reads the original mintReserve.
  await expect(page.getByRole("button", { name: "1 problem" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run on testnet" })).toBeDisabled();
  await page.getByRole("button", { name: "1 problem" }).click();
  await expect(page.locator("aside li")).toHaveCount(1);
  await expect(page.locator("aside li")).toContainText("is outside the Launch block");
});

test("refuses a step id another step already has", async ({ page }) => {
  await page.goto("/launch?example=hts-launch-basic");
  await expectValid(page, 5);
  await renameStep(page, "createToken", "createLog");
  // The field keeps its id, so nothing is rewired and the launch stays valid.
  await expect(page.locator(".blocklyEditableField", { hasText: /^createToken$/ })).toHaveCount(1);
  await expectValid(page, 5);
});

test("takes back a rename, and every reference it rewrote, with one undo", async ({ page }) => {
  await page.goto("/launch?example=hts-launch-basic");
  await expectValid(page, 5);
  await renameStep(page, "createToken", "tokenA");
  await expect(
    page
      .locator(".blocklyBlockCanvas")
      // Blockly draws spaces as no-break spaces, which \s matches.
      .getByText(/^tokenA\s▸/)
      .first(),
  ).toBeVisible();
  await expectValid(page, 5);

  await page.locator(".blocklyBlockCanvas .blocklyText", { hasText: "Mint tokens" }).first().click();
  // Blockly takes Ctrl+Z and Cmd+Z; headless Chromium on macOS only delivers the Ctrl form.
  await page.keyboard.press("Control+z");
  await expect(page.locator(".blocklyBlockCanvas").getByText(/^tokenA/)).toHaveCount(0);
  await expect(page.locator(".blocklyEditableField", { hasText: /^createToken$/ })).toHaveCount(1);
  await expectValid(page, 5);
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

test("sends security headers, so no other site can frame the studio", async ({ request }) => {
  for (const path of ["/launch", "/api/launchblocks/gallery"]) {
    const headers = (await request.get(path)).headers();
    expect(headers).toMatchObject({
      "x-frame-options": "DENY",
      "content-security-policy": "frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    });
    expect(headers["x-powered-by"]).toBeUndefined();
  }
});

test("refuses a run posted from another site before looking at the flow", async ({ request }) => {
  const response = await request.post("/api/launchblocks/flows/run", {
    headers: { "content-type": "application/json", "sec-fetch-site": "cross-site", origin: "https://evil.example" },
    data: {},
  });
  expect(response.status()).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: "CROSS_SITE_REFUSED" } });
});

test("says how to turn the assistant on when the server has no AI key", async ({ page }) => {
  await page.goto("/launch?example=hts-launch-basic");
  await expectValid(page, 5);
  // It floats at the bottom right of the studio, whatever the panel shows.
  await page.getByRole("button", { name: "Open the assistant" }).click();
  const assistant = page.getByRole("dialog", { name: "Assistant" });
  await expect(assistant.getByText("The assistant is not set up here")).toBeVisible();
  await expect(assistant.getByText("OPENAI_API_KEY")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(assistant).toBeHidden();
});

/** Stand in for the assistant: it is on, and every answer is the given text, streamed in two pieces. */
async function mockAssistant(page: Page, answer: string) {
  const questions: Record<string, unknown>[] = [];
  await page.route("**/api/launchblocks/assistant", async route => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: { enabled: true, model: "test-model" } });
    }
    questions.push(route.request().postDataJSON() as Record<string, unknown>);
    const half = Math.ceil(answer.length / 2);
    const lines = [answer.slice(0, half), answer.slice(half)].map(text => JSON.stringify({ type: "text", text }));
    return route.fulfill({
      contentType: "application/x-ndjson",
      body: `${[...lines, JSON.stringify({ type: "done" })].join("\n")}\n`,
    });
  });
  return questions;
}

test("explains a problem from the Problems tab, with the launch in view", async ({ page }) => {
  const questions = await mockAssistant(page, "Give the token a **symbol**, such as `RKT`.");
  await page.goto("/launch?example=hts-launch-basic");
  await expectValid(page, 5);
  await page.locator(".blocklyEditableField", { hasText: "LBD" }).first().click();
  await page.locator(".blocklyHtmlInput").fill("");
  await page.locator(".blocklyHtmlInput").press("Enter");
  await page.getByRole("button", { name: "1 problem" }).click();

  // A problem puts a dot on the floating button; Explain opens the window with the question asked.
  await expect(page.getByRole("button", { name: "Open the assistant" })).toHaveAttribute("data-attention", "true");
  await page.getByRole("button", { name: "Explain" }).click();
  await expect(page.getByRole("dialog", { name: "Assistant" })).toBeVisible();
  const conversation = page.getByRole("list", { name: "Conversation with the assistant" });
  await expect(conversation.getByText('Explain this problem and how to fix it: "Symbol: Required"')).toBeVisible();
  // The answer's Markdown is drawn as elements, not as raw asterisks.
  await expect(conversation.locator("strong", { hasText: "symbol" })).toBeVisible();
  await expect(conversation.locator("code", { hasText: "RKT" })).toBeVisible();

  expect(questions).toHaveLength(1);
  expect(questions[0]).toMatchObject({
    focus: { stepId: "createToken" },
    signer: "operator",
    flow: { id: "hts-launch-basic", steps: expect.arrayContaining([expect.objectContaining({ id: "createToken" })]) },
  });
});

test("answers about a block from its right-click menu", async ({ page }) => {
  const questions = await mockAssistant(page, "It mints more supply into the treasury.");
  await page.goto("/launch?example=hts-launch-basic");
  await expectValid(page, 5);
  await page.locator(".blocklyBlockCanvas .blocklyText", { hasText: "Mint tokens" }).first().click({ button: "right" });
  await page.locator(".blocklyContextMenu").getByText("Ask the assistant about this block").click();

  await expect(page.getByText("It mints more supply into the treasury.")).toBeVisible();
  expect(questions[0]).toMatchObject({
    question: expect.stringContaining('"Mint tokens" block (mintReserve)'),
    focus: { stepId: "mintReserve", type: "hts.mint" },
  });
  // A follow-up carries the conversation so far.
  await page.getByLabel("Your question for the assistant").fill("And how much does it cost?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect.poll(() => questions.length).toBe(2);
  expect(questions[1]).toMatchObject({
    history: [
      { role: "user", content: expect.stringContaining("Mint tokens") },
      { role: "assistant", content: "It mints more supply into the treasury." },
    ],
  });
});
