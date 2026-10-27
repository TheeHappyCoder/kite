// Speed in a real browser (installed Edge or Chrome, headless) against a perf server:
// cold load, what it downloads, input latency for j/k, opening a thread, search, memory.
import { chromium } from "playwright-core";
import fs from "node:fs";
import zlib from "node:zlib";
import { chunkPath, attributeFiles } from "./bundle.mjs";
import { kb, log, median, percentile, round, sleep } from "./lib.mjs";

const VIEWPORT = { width: 1440, height: 900 };
const RUNS = 3;

export async function launch() {
  for (const channel of ["msedge", "chrome"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {}
  }
  throw new Error("No Edge or Chrome found for the browser tests.");
}

/** Installed before any page script: event timing, long tasks, paints. */
function observe() {
  const w = window;
  w.__perf = { events: [], longtasks: [], lastKeyAt: 0 };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) w.__perf.events.push({ name: e.name, duration: e.duration, start: e.startTime, interactionId: e.interactionId });
  }).observe({ type: "event", durationThreshold: 16, buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) w.__perf.longtasks.push({ start: e.startTime, duration: e.duration });
  }).observe({ type: "longtask", buffered: true });
  addEventListener("keydown", () => (w.__perf.lastKeyAt = performance.now()), { capture: true });
  try {
    localStorage.setItem("kite-onboarded", "1");
  } catch {}
}

const gzipOf = (url) => {
  const file = chunkPath(url);
  return fs.existsSync(file) ? zlib.gzipSync(fs.readFileSync(file)).length : 0;
};

export async function coldLoad(browser, base) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.addInitScript(observe);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const t0 = Date.now();
  await page.goto(base, { waitUntil: "commit" });
  await page.waitForSelector("[data-thread]", { timeout: 60_000 });
  const listMs = Date.now() - t0;
  // Let the app finish its first fetches before reading sizes.
  await page.waitForLoadState("networkidle").catch(() => {});
  await sleep(500);
  const timing = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const paint = Object.fromEntries(performance.getEntriesByType("paint").map((p) => [p.name, p.startTime]));
    const resources = performance.getEntriesByType("resource").map((r) => ({
      url: r.name,
      initiator: r.initiatorType,
      decoded: r.decodedBodySize,
    }));
    return {
      ttfb: nav.responseStart,
      domContentLoaded: nav.domContentLoadedEventEnd,
      load: nav.loadEventEnd,
      fcp: paint["first-contentful-paint"] ?? null,
      longtasks: window.__perf.longtasks,
      resources,
      rows: document.querySelectorAll("[data-thread]").length,
      domNodes: document.getElementsByTagName("*").length,
    };
  });
  const metrics = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  const tbt = timing.longtasks.reduce((s, t) => s + Math.max(0, t.duration - 50), 0);
  const isJs = (r) => r.url.includes("/_next/static/") && r.url.endsWith(".js");
  const isApi = (r) => new URL(r.url).pathname.startsWith("/api/");
  const sum = (list, key) => list.reduce((s, r) => s + (r[key] || 0), 0);
  const js = timing.resources.filter(isJs);
  const api = timing.resources.filter(isApi);
  const result = {
    listVisibleMs: listMs,
    fcpMs: round(timing.fcp),
    domContentLoadedMs: round(timing.domContentLoaded),
    totalBlockingMs: round(tbt),
    longestTaskMs: round(Math.max(0, ...timing.longtasks.map((t) => t.duration))),
    jsFiles: js.length,
    // Sizes on the wire come from the build files (gzip), not the browser: local web filters
    // (ESET here) unpack compressed responses for browsers, even on localhost.
    jsGzipKB: kb(js.reduce((s, r) => s + gzipOf(r.url), 0)),
    jsDecodedKB: kb(sum(js, "decoded")),
    apiRequests: api.length,
    apiDecodedKB: kb(sum(api, "decoded")),
    apiByRoute: Object.entries(
      api.reduce((acc, r) => {
        const route = new URL(r.url).pathname.replace(/\/api\/avatar.*/, "/api/avatar");
        acc[route] ??= { requests: 0, decodedKB: 0 };
        acc[route].requests++;
        acc[route].decodedKB = round(acc[route].decodedKB + r.decoded / 1024, 1);
        return acc;
      }, {}),
    )
      .sort((a, b) => b[1].decodedKB - a[1].decodedKB)
      .map(([route, v]) => ({ route, ...v })),
    rows: timing.rows,
    domNodes: timing.domNodes,
    // The whole page grows with the inbox (rows are all rendered; content-visibility skips off-screen ones), so the budget is per row.
    domNodesPerRow: timing.rows ? round(timing.domNodes / timing.rows, 1) : null,
    heapUsedMB: round(metrics.JSHeapUsedSize / 1024 / 1024, 1),
  };
  return { context, page, cdp, result, jsUrls: js.map((r) => r.url) };
}

/** Presses a key and waits until the reader shows a different conversation. */
export async function pressAndWaitForReader(page, key) {
  const before = await page.evaluate(() => [...document.querySelectorAll("[data-message-id]")].map((e) => e.getAttribute("data-message-id")).join());
  await page.keyboard.press(key);
  return page.evaluate(
    (before) =>
      new Promise((resolve) => {
        const started = window.__perf.lastKeyAt;
        const check = () => {
          const now = [...document.querySelectorAll("[data-message-id]")].map((e) => e.getAttribute("data-message-id")).join();
          if (now && now !== before) {
            // Wait for the frame that shows it.
            requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - started), 0));
          } else if (performance.now() - started > 10_000) resolve(null);
          else requestAnimationFrame(check);
        };
        check();
      }),
    before,
  );
}

async function interactions(page) {
  await page.evaluate(() => (window.__perf.events = []));
  // Open the first conversation, then step through the list.
  await page.locator("[data-thread]").first().click();
  await page.waitForSelector("[data-message-id]", { timeout: 15_000 }).catch(() => {});
  const readerMs = [];
  // Step down as far as the list allows (demo data is short), then back up.
  const down = Math.min(15, (await page.locator("[data-thread]").count()) - 1);
  for (let i = 0; i < down; i++) {
    readerMs.push(await pressAndWaitForReader(page, "j"));
    await sleep(120);
  }
  for (let i = 0; i < Math.min(5, down); i++) {
    readerMs.push(await pressAndWaitForReader(page, "k"));
    await sleep(120);
  }
  const navEvents = await page.evaluate(() => window.__perf.events.filter((e) => e.name === "keydown").map((e) => e.duration));

  // Search: focus with "/", type, then wait for the list to settle.
  await page.keyboard.press("Escape");
  await page.evaluate(() => (window.__perf.events = []));
  await page.keyboard.press("/");
  const searchInput = page.locator('input[placeholder="Search"]');
  await searchInput.waitFor({ timeout: 5000 });
  const query = "the invoice";
  await searchInput.pressSequentially(query, { delay: 60 });
  const searchSettleMs = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const started = window.__perf.lastKeyAt;
        let lastChange = performance.now();
        const list = document.querySelector("[data-thread]")?.parentElement?.parentElement ?? document.body;
        const observer = new MutationObserver(() => (lastChange = performance.now()));
        observer.observe(list, { childList: true, subtree: true });
        const check = () => {
          if (performance.now() - lastChange > 400 || performance.now() - started > 8000) {
            observer.disconnect();
            resolve(Math.max(0, lastChange - started));
          } else setTimeout(check, 50);
        };
        check();
      }),
  );
  const typeEvents = await page.evaluate(() => window.__perf.events.filter((e) => e.name === "keydown" || e.name === "keypress" || e.name === "input").map((e) => e.duration));
  await searchInput.fill("");
  await page.keyboard.press("Escape");

  const valid = readerMs.filter((v) => v != null);
  return {
    nextThreadMedianMs: round(median(valid)),
    nextThreadP90Ms: round(percentile(valid, 90)),
    nextThreadMaxMs: round(Math.max(0, ...valid)),
    navKeyInteractionP90Ms: round(percentile(navEvents, 90) ?? 0),
    searchKeyInteractionMaxMs: round(Math.max(0, ...typeEvents)),
    searchResultsSettleMs: round(searchSettleMs),
    readerTimeouts: readerMs.length - valid.length,
  };
}

/** Runs the browser suite `RUNS` times on a server and takes the median of each number. */
export async function browserSuite(base, label) {
  const browser = await launch();
  const loads = [];
  const steps = [];
  let jsUrls = [];
  let memory = null;
  try {
    for (let run = 0; run < RUNS; run++) {
      const { context, page, cdp, result, jsUrls: urls } = await coldLoad(browser, base);
      loads.push(result);
      jsUrls = urls;
      try {
        steps.push(await interactions(page));
      } catch (error) {
        log(`${label}: interaction run ${run + 1} failed: ${error.message}`);
      }
      if (run === RUNS - 1) {
        await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
        const metrics = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
        memory = { heapAfterUseMB: round(metrics.JSHeapUsedSize / 1024 / 1024, 1), domNodesAfterUse: metrics.Nodes };
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const pick = (list) =>
    Object.fromEntries(
      Object.keys(list[0] ?? {})
        .filter((k) => typeof list[0][k] === "number")
        .map((k) => [k, round(median(list.map((x) => x[k])), 1)]),
    );
  const initialJs = attributeFiles(jsUrls.map((u) => chunkPath(u)));
  return {
    load: { ...pick(loads), apiByRoute: loads.at(-1)?.apiByRoute ?? [] },
    interaction: pick(steps),
    memory,
    initialJsByPackage: initialJs.slice(0, 25),
  };
}
