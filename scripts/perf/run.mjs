// `pnpm perf`: builds Kite into .next-perf and measures bundle size, speed and data usage.
// Writes perf/results/latest.json (every number) and prints a summary; `pnpm perf:check`
// compares it to perf/budgets.json and perf/baseline.json.
//
// Flags: --only=bundle,browser,api,data,initial (merged into the last results)   --idle=<minutes, default 5>   --skip-build
//
// Nothing here touches the real mailbox: speed tests run on demo data or a read-only copy,
// and the copy's server refuses every write to Gmail or AI (KITE_PERF_READONLY).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { apiSuite } from "./api.mjs";
import { browserSuite } from "./browser.mjs";
import { measureBundle, attributeFiles, chunkPath } from "./bundle.mjs";
import { initialSyncScenario, steadyScenarios } from "./data.mjs";
import { ROOT, copyRealData, log, round, scratchDir, startServer } from "./lib.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const only = args.only ? new Set(String(args.only).split(",")) : new Set(["bundle", "browser", "api", "data", "initial"]);
const idleMinutes = Number(args.idle ?? 5);

const results = { at: new Date().toISOString(), commit: git("rev-parse", "--short", "HEAD"), dirty: !!git("status", "--porcelain"), machine: `${process.platform} node ${process.version}` };

function git(...a) {
  try {
    return execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function build() {
  log("building (next build → .next-perf)…");
  const started = Date.now();
  execFileSync(process.execPath, [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "build"], {
    cwd: ROOT,
    env: { ...process.env, KITE_PERF_BUILD: "1", NODE_ENV: "production" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  results.buildSeconds = round((Date.now() - started) / 1000);
}

async function withServer(options, fn) {
  const server = await startServer(options);
  try {
    return await fn(server.base);
  } finally {
    await server.stop();
  }
}

/** Numbers only, keyed by path, for budgets and baselines. */
function flatten(value, prefix = "", out = {}) {
  if (typeof value === "number") out[prefix] = value;
  else if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

async function main() {
  if (!args["skip-build"]) build();
  else if (!fs.existsSync(path.join(ROOT, ".next-perf", "BUILD_ID"))) throw new Error("No perf build yet: run without --skip-build.");

  if (only.has("bundle")) {
    const bundle = measureBundle();
    const allJs = bundle.chunks.filter((c) => c.type === "js").map((c) => chunkPath(`/_next/static/${c.file}`));
    results.bundle = { totals: bundle.totals, largestChunks: bundle.chunks.slice(0, 10), allJsByPackage: attributeFiles(allJs).slice(0, 30) };
    log(`bundle: ${bundle.totals.jsGzipKB} KB gzip of JS in ${bundle.totals.files} files`);
  }

  if (only.has("browser")) {
    log("browser suite on demo data…");
    results.demo = await withServer({ port: 3197, dataDir: scratchDir("demo"), label: "demo" }, (base) => browserSuite(base, "demo"));
    log(`demo: list in ${results.demo.load.listVisibleMs} ms, ${results.demo.load.jsGzipKB} KB JS (gzip)`);
  }

  const realDir = only.has("api") || only.has("data") || only.has("browser") ? copyRealData("real") : null;
  if (realDir) {
    await withServer({ port: 3198, dataDir: realDir, label: "real copy" }, async (base) => {
      if (only.has("data")) results.data = await steadyScenarios(base, { idleMinutes });
      if (only.has("api")) {
        results.api = await apiSuite(base);
        log("api: done");
      }
      if (only.has("browser")) {
        log("browser suite on the real copy…");
        results.real = await browserSuite(base, "real");
        log(`real: list in ${results.real.load.listVisibleMs} ms, ${results.real.load.apiDecodedKB} KB from the local API`);
      }
    });
  } else if (only.has("api") || only.has("data")) log("no connected account in data/: skipping api and data");

  if (only.has("initial")) {
    const freshDir = copyRealData("fresh", { fresh: true });
    if (freshDir) {
      log("initial sync from an empty local copy (read-only)…");
      results.initialSync = await withServer({ port: 3199, dataDir: freshDir, label: "fresh copy" }, (base) => initialSyncScenario(base));
    }
  }

  // A partial run (--only) keeps the other sections of the last full results.
  const dir = path.join(ROOT, "perf", "results");
  const latestFile = path.join(dir, "latest.json");
  if (args.only && fs.existsSync(latestFile)) {
    const previous = JSON.parse(fs.readFileSync(latestFile, "utf8"));
    delete previous.metrics;
    for (const [key, value] of Object.entries(previous)) if (!(key in results)) results[key] = value;
    results.partial = [...only].join(",");
  }

  // Routes become keys so budgets can name them.
  const forMetrics = structuredClone(results);
  if (forMetrics.api) forMetrics.api = Object.fromEntries(forMetrics.api.routes.map((r) => [r.route, r]));
  for (const key of ["at", "commit", "dirty", "machine", "partial"]) delete forMetrics[key];
  results.metrics = flatten(forMetrics);

  fs.mkdirSync(path.join(dir, "runs"), { recursive: true });
  fs.writeFileSync(latestFile, JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(dir, "runs", `${results.at.replace(/[:.]/g, "-")}.json`), JSON.stringify(results, null, 2));
  fs.rmSync(path.join(dir, "tmp"), { recursive: true, force: true });
  log(`wrote perf/results/latest.json (${Object.keys(results.metrics).length} numbers)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
