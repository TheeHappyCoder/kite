import path from "node:path";
import { defineConfig } from "vitest/config";

// `pnpm test`: unit tests (test/unit) and the IMAP provider against scripts/imap-test-server.mjs
// (test/imap). Separate from the app build: `server-only` is a stub here, `@/` maps to src/.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${path.resolve(import.meta.dirname, "src")}/` },
      { find: /^server-only$/, replacement: path.resolve(import.meta.dirname, "test/stubs/server-only.ts") },
    ],
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // One process per file: each gets its own data folder, database and module state.
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
