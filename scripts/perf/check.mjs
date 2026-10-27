// `pnpm perf:check`: compares perf/results/latest.json with perf/budgets.json (hard limits)
// and perf/baseline.json (last accepted run). Exit code 1 when a budget is broken.
// `pnpm perf:check --save-baseline` accepts the latest run as the new baseline.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./lib.mjs";

const read = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);
const latest = read(path.join(ROOT, "perf", "results", "latest.json"));
if (!latest) {
  console.error("No perf/results/latest.json: run `pnpm perf` first.");
  process.exit(1);
}
const budgets = read(path.join(ROOT, "perf", "budgets.json"));
const baselineFile = path.join(ROOT, "perf", "baseline.json");

if (process.argv.includes("--save-baseline")) {
  // A partial run carries older sections forward, so its numbers come from more than one commit.
  if (latest.partial) {
    console.error(`latest.json is a partial run (--only=${latest.partial}): run the full \`pnpm perf\` before saving a baseline.`);
    process.exit(1);
  }
  fs.writeFileSync(baselineFile, JSON.stringify({ at: latest.at, commit: latest.commit, metrics: latest.metrics }, null, 2) + "\n");
  console.log(`Saved baseline from ${latest.at} (${latest.commit}).`);
  process.exit(0);
}
const baseline = read(baselineFile);
// No budgets means nothing would be checked: fail instead of printing an empty PASS.
if (!Object.keys(budgets?.limits ?? {}).length) {
  console.error("No limits in perf/budgets.json: nothing to check.");
  process.exit(1);
}

// Timings are noisy: flag them only past 25% and 30 ms. Sizes and counts are exact: 5%.
const isTiming = (key) => /Ms$|Seconds$/.test(key);
function regressed(key, now, before) {
  if (before == null || now == null || now <= before) return false;
  if (isTiming(key)) return now > before * 1.25 && now - before > 30;
  return now > before * 1.05 && now - before > 1;
}

const rows = [];
let broken = 0;
for (const [key, limit] of Object.entries(budgets.limits)) {
  const now = latest.metrics[key];
  const ok = now == null ? null : now <= limit;
  // A budgeted number the run didn't produce is a renamed metric or a skipped suite: fail it too.
  if (ok !== true) broken++;
  rows.push({ status: ok == null ? "MISSING" : ok ? "ok" : "OVER BUDGET", metric: key, now, limit, baseline: baseline?.metrics[key] ?? null });
}
const regressions = baseline
  ? Object.entries(latest.metrics)
      .filter(([key, now]) => regressed(key, now, baseline.metrics[key]))
      .map(([key, now]) => ({ metric: key, baseline: baseline.metrics[key], now, change: `+${Math.round((now / baseline.metrics[key] - 1) * 100)}%` }))
  : [];
const improvements = baseline
  ? Object.entries(latest.metrics)
      .filter(([key, now]) => regressed(key, baseline.metrics[key], now))
      .map(([key, now]) => ({ metric: key, baseline: baseline.metrics[key], now }))
  : [];

console.log(`Run ${latest.at} at ${latest.commit}${latest.dirty ? " (uncommitted changes)" : ""}${latest.partial ? ` (partial: --only=${latest.partial}, other sections from earlier runs)` : ""}; baseline ${baseline ? `${baseline.at} at ${baseline.commit}` : "none"}`);
console.log("\nBudgets:");
console.table(rows);
console.log(`\nRegressions vs baseline (${regressions.length}):`);
if (regressions.length) console.table(regressions);
console.log(`\nImprovements vs baseline (${improvements.length}):`);
if (improvements.length) console.table(improvements);
console.log(broken ? `\nFAIL: ${broken} budget(s) broken or missing.` : "\nPASS: every budget holds.");
process.exit(broken ? 1 : 0);
