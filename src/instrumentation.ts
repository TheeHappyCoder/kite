/**
 * Runs once per server start. Starts unwrapping the secrets key in the background (not awaited:
 * the server starts as before), and loads the network meter only for `pnpm perf` runs (KITE_PERF=1).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  void import("./server/secrets").then((m) => m.warmKey()).catch(() => {});
  if (process.env.KITE_PERF === "1") (await import("./server/perf-meter")).installMeter();
}
