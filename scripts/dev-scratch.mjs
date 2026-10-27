// A second dev server on port 3101 with its own build folder and an empty data folder
// (data-scratch/, git-ignored), for trying sign-ins and test accounts without touching data/.
// `--data=<folder>` uses another folder (an empty one runs on demo data); `--port=<n>` runs a second
// one beside it (its own build folder, .next-scratch-<n>).
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const dataArg = process.argv.find((a) => a.startsWith("--data="))?.slice("--data=".length);
const port = Number(process.argv.find((a) => a.startsWith("--port="))?.slice("--port=".length)) || 3101;
const dataDir = resolve(dataArg ?? process.env.KITE_DATA_DIR ?? "data-scratch");
mkdirSync(dataDir, { recursive: true });
const child = spawn(`pnpm exec next dev --port ${port} --hostname 127.0.0.1`, {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, KITE_DATA_DIR: dataDir, KITE_DIST_DIR: port === 3101 ? ".next-scratch" : `.next-scratch-${port}` },
});
child.on("exit", (code) => process.exit(code ?? 0));
