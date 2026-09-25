import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests of the Launch Studio against the production build
 * (`yarn next:build` first). The server gets no operator, so nothing can
 * spend HBAR: Next.js never lets .env override a variable that is already
 * set, even to an empty string.
 */
const PORT = Number(process.env.E2E_PORT ?? 3210);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: `next start -p ${PORT} -H 127.0.0.1`,
    url: `${BASE_URL}/api/launchblocks/steps`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { HEDERA_OPERATOR_ID: "", HEDERA_OPERATOR_KEY: "", LAUNCHBLOCKS_PUBLIC_DEMO: "" },
  },
});
