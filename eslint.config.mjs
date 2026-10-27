import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Mail providers are plug-ins (src/server/providers/<name>/): everything else reaches them through
  // providers/registry.ts and the contract in server/mail/provider.ts, never by importing their files.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/server/providers/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/providers/*", "**/providers/*/**", "!**/providers/registry"],
              message: "Go through @/server/providers/registry (providerFor, mailOf) instead of a provider's own files.",
            },
          ],
        },
      ],
    },
  },
  // A provider never reaches into another one: shared code lives in server/mail.
  {
    files: ["src/server/providers/*/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["../*/**", "!../../**", "../registry"], message: "Providers don't import each other or the registry; put shared code in server/mail." },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Next build output: .next (default), .next-perf (`pnpm perf`), .next-scratch and per-worktree dirs.
    ".next*/**",
    // Claude Code worktrees (each with its own build output) and settings.
    ".claude/**",
    // `pnpm perf` results.
    "data-scratch/**",
    "perf/results/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Firefox's generated translation loader, vendored as it ships (lib/translate/worker.ts).
    "src/lib/translate/bergamot-translator.js",
    // Tauri shell build output.
    "src-tauri/**",
  ]),
]);

export default eslintConfig;
