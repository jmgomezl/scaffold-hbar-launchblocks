import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^~~\//, replacement: root },
      // Next.js resolves this marker package itself; anywhere else it throws on import.
      { find: /^server-only$/, replacement: `${root}test/server-only.ts` },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
