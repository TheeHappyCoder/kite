// `node scripts/perf/quick.mjs`: one browser scenario on the perf build, fast enough to run after
// every change (fix, test, fix). Not a replacement for `pnpm perf`: no budgets, no baseline.
//
// Flags: --build (next build first)   --data=real|demo (default real: a read-only copy of data/,
// reused between runs; --fresh-copy makes a new one)   --scenario=jk,search,open,load,press,anims,paneresize,winresize,views (default jk,search)
// --runs=<n> (default 3)   --profile (CPU profile of each scenario, mapped to source lines; --spike: only
// the longest busy stretch)   --trace (style/layout/paint totals and what forced layout)   --api (route
// times and sizes)   --sync (leave sync on)   --serve (just run the server on port 3196 to look at by hand)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attributeFiles, chunkPath } from "./bundle.mjs";
import { apiSuite } from "./api.mjs";
import { coldLoad, launch, pressAndWaitForReader } from "./browser.mjs";
import { ROOT, copyRealData, log, median, percentile, round, scratchDir, sleep, startServer } from "./lib.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.length ? v.join("=") : true];
  }),
);
const scenarios = String(args.scenario ?? (args.api ? "" : "jk,search")).split(",").filter(Boolean);
const runs = Number(args.runs ?? 3);
const data = args.data ?? "real";

if (args.build) {
  log("building…");
  const started = Date.now();
  execFileSync(process.execPath, [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "build"], {
    cwd: ROOT,
    env: { ...process.env, KITE_PERF_BUILD: "1", NODE_ENV: "production" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  log(`built in ${round((Date.now() - started) / 1000)} s`);
}

function dataFolder() {
  if (data === "demo") return scratchDir("quick-demo");
  const dir = path.join(ROOT, "perf", "results", "tmp", "quick");
  if (!args["fresh-copy"] && fs.existsSync(path.join(dir, "kite.sqlite"))) return dir;
  const copy = copyRealData("quick");
  if (!copy) throw new Error("No connected account in data/: use --data=demo.");
  return copy;
}

// ---- Source-mapped CPU profiles -------------------------------------------------------------

const B64 = Object.fromEntries([..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].map((c, i) => [c, i]));
const maps = new Map();

/** Per generated line: sorted [column, source, originalLine, name] segments. */
function loadMap(url) {
  if (maps.has(url)) return maps.get(url);
  let parsed = null;
  try {
    // Turbopack names maps after their content: follow the chunk's sourceMappingURL comment.
    // Browser chunks by URL; server chunks (server profiles) by file URL.
    const chunk = url.startsWith("file:") ? fileURLToPath(url) : chunkPath(url);
    const ref = fs.existsSync(chunk) ? fs.readFileSync(chunk, "utf8").slice(-300).match(/sourceMappingURL=(\S+)/)?.[1] : null;
    const file = ref ? path.join(path.dirname(chunk), ref) : `${chunk}.map`;
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const map = raw.sections ? null : raw;
      if (map) {
        const lines = [];
        let source = 0, origLine = 0, name = 0;
        for (const lineText of map.mappings.split(";")) {
          const segs = [];
          let column = 0;
          for (const seg of lineText ? lineText.split(",") : []) {
            if (!seg) continue;
            const values = [];
            let value = 0, shift = 0;
            for (const ch of seg) {
              const digit = B64[ch];
              value += (digit & 31) << shift;
              if (digit & 32) shift += 5;
              else {
                values.push(value & 1 ? -(value >>> 1) : value >>> 1);
                value = 0;
                shift = 0;
              }
            }
            column += values[0];
            if (values.length > 1) {
              source += values[1];
              origLine += values[2];
            }
            if (values.length > 4) name += values[4];
            segs.push([column, values.length > 1 ? source : -1, origLine, values.length > 4 ? name : -1]);
          }
          lines.push(segs);
        }
        parsed = { lines, sources: map.sources, names: map.names ?? [] };
      } else {
        // Index maps (sections): flatten each section with its offset.
        const lines = [];
        const sources = [];
        const names = [];
        for (const section of raw.sections) {
          const sub = section.map;
          const base = sources.length;
          const nameBase = names.length;
          sources.push(...sub.sources);
          names.push(...(sub.names ?? []));
          let source = 0, origLine = 0, name = 0, lineNo = section.offset.line;
          for (const lineText of sub.mappings.split(";")) {
            let column = lineNo === section.offset.line ? section.offset.column : 0;
            const segs = (lines[lineNo] ??= []);
            let rel = 0;
            for (const seg of lineText ? lineText.split(",") : []) {
              if (!seg) continue;
              const values = [];
              let value = 0, shift = 0;
              for (const ch of seg) {
                const digit = B64[ch];
                value += (digit & 31) << shift;
                if (digit & 32) shift += 5;
                else {
                  values.push(value & 1 ? -(value >>> 1) : value >>> 1);
                  value = 0;
                  shift = 0;
                }
              }
              rel += values[0];
              if (values.length > 1) {
                source += values[1];
                origLine += values[2];
              }
              if (values.length > 4) name += values[4];
              segs.push([column + rel, values.length > 1 ? base + source : -1, origLine, values.length > 4 ? nameBase + name : -1]);
            }
            lineNo++;
          }
        }
        for (const segs of lines) segs?.sort((a, b) => a[0] - b[0]);
        parsed = { lines, sources, names };
      }
    }
  } catch {}
  maps.set(url, parsed);
  return parsed;
}

const cleanSource = (s) => s.replace(/^turbopack:\/\/\/?(\[project\]\/)?/, "").replace(/.*node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?/, "").replace(/^next\/dist\/compiled\//, "");

function locate(frame) {
  const fallback = `${frame.functionName || "(anon)"} ${frame.url ? path.basename(frame.url) : "(native)"}`;
  if (!frame.url?.includes("/_next/static/") && !frame.url?.includes(".next-perf/server/")) return { fn: fallback, file: frame.url ? "(other)" : "(native/gc)" };
  const map = loadMap(frame.url);
  const segs = map?.lines[frame.lineNumber];
  if (!segs?.length) return { fn: fallback, file: path.basename(frame.url) };
  let lo = 0, hi = segs.length - 1, hit = segs[0];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid][0] <= frame.columnNumber) {
      hit = segs[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (hit[1] < 0) return { fn: fallback, file: path.basename(frame.url) };
  const file = cleanSource(map.sources[hit[1]]);
  const name = hit[3] >= 0 ? map.names[hit[3]] : frame.functionName || "(anon)";
  return { fn: `${name} ${file}:${hit[2] + 1}`, file };
}

/** The longest stretch of main-thread work (samples not idle, gaps under 4 ms): where a slow input went. */
function longestBusy(profile) {
  const idle = new Set(profile.nodes.filter((n) => n.callFrame.functionName === "(idle)").map((n) => n.id));
  let t = profile.startTime;
  let best = { from: 0, to: 0, ms: 0 };
  let from = -1, lastBusy = 0, startAt = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    t += profile.timeDeltas[i] ?? 0;
    if (idle.has(profile.samples[i])) {
      if (from >= 0 && t - lastBusy > 4000) {
        if (lastBusy - startAt > best.ms * 1000) best = { from, to: i, ms: (lastBusy - startAt) / 1000 };
        from = -1;
      }
      continue;
    }
    if (from < 0) {
      from = i;
      startAt = t;
    }
    lastBusy = t;
  }
  return best;
}

function summarizeProfile(profile, top = 25, window = null) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    if (window && (i < window.from || i > window.to)) continue;
    self.set(profile.samples[i], (self.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i + 1] ?? 0) / 1000);
  }
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const fnSelf = new Map();
  const fileSelf = new Map();
  const fnTotal = new Map();
  for (const [id, ms] of self) {
    const node = byId.get(id);
    const { fn, file } = locate(node.callFrame);
    fnSelf.set(fn, (fnSelf.get(fn) ?? 0) + ms);
    fileSelf.set(file, (fileSelf.get(file) ?? 0) + ms);
    // Inclusive: credit each distinct function on the stack once.
    const seen = new Set();
    for (let cur = id; cur != null; cur = parent.get(cur)) {
      const loc = locate(byId.get(cur).callFrame).fn;
      if (seen.has(loc)) continue;
      seen.add(loc);
      fnTotal.set(loc, (fnTotal.get(loc) ?? 0) + ms);
    }
  }
  const sorted = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => ({ ms: round(v), where: k }));
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  const idle = [...self].filter(([id]) => byId.get(id).callFrame.functionName === "(idle)").reduce((a, [, v]) => a + v, 0);
  const app = new Map([...fnTotal].filter(([k]) => k.includes(" src/")));
  // --who=<function>: the call stacks (outermost app frames) that led to that function.
  const who = new Map();
  if (args.who) {
    for (const [id, ms] of self) {
      if (!locate(byId.get(id).callFrame).fn.startsWith(String(args.who))) continue;
      const chain = [];
      for (let cur = parent.get(id); cur != null && chain.length < 40; cur = parent.get(cur)) chain.push(locate(byId.get(cur).callFrame).fn);
      const key = chain.filter((f) => f.includes(" src/") || f.includes("framer-motion") || f.includes("motion-dom")).slice(0, 8).join(" < ");
      who.set(key, (who.get(key) ?? 0) + ms);
    }
  }
  return { busyMs: round(total - idle), selfByFunction: sorted(fnSelf), selfByFile: sorted(fileSelf, 15), inclusive: sorted(fnTotal, 30), app: sorted(app, 30), who: [...who].sort((a, b) => b[1] - a[1]).slice(0, 6) };
}

// ---- Rendering traces (style, layout, paint) ------------------------------------------------

async function startTrace(cdp) {
  await cdp.send("Tracing.start", { traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.stack", "blink"] }, transferMode: "ReturnAsStream" });
}

async function stopTrace(cdp) {
  const done = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
  await cdp.send("Tracing.end");
  const { stream } = await done;
  let text = "";
  for (;;) {
    const chunk = await cdp.send("IO.read", { handle: stream });
    text += chunk.base64Encoded ? Buffer.from(chunk.data, "base64").toString() : chunk.data;
    if (chunk.eof) break;
  }
  await cdp.send("IO.close", { handle: stream });
  const events = JSON.parse(text).traceEvents ?? JSON.parse(text);
  // Main-thread complete events of the renderer: totals by name, plus the biggest style/layout passes.
  const main = events.filter((e) => e.ph === "X" && e.dur);
  const thread = main.find((e) => e.name === "UpdateLayoutTree" || e.name === "Layout")?.tid;
  const totals = new Map();
  const big = [];
  // Style and layout that JavaScript forced (it read geometry after a change), by the first app or package frame.
  const forcedBy = new Map();
  for (const e of main) {
    if (e.tid !== thread) continue;
    totals.set(e.name, (totals.get(e.name) ?? 0) + e.dur / 1000);
    const stack = e.args?.beginData?.stackTrace ?? e.args?.data?.stackTrace;
    if ((e.name === "Layout" || e.name === "UpdateLayoutTree") && stack?.length) {
      const frame = stack.find((f) => f.url?.includes("/_next/static/")) ?? stack[0];
      const where = locate({ url: frame.url, functionName: frame.functionName, lineNumber: frame.lineNumber - 1, columnNumber: frame.columnNumber - 1 }).fn;
      const entry = forcedBy.get(where) ?? { ms: 0, count: 0 };
      entry.ms += e.dur / 1000;
      entry.count++;
      forcedBy.set(where, entry);
    }
    if ((e.name === "Layout" || e.name === "UpdateLayoutTree") && e.dur > 8000) {
      big.push({ name: e.name, ms: round(e.dur / 1000), elements: e.args?.elementCount ?? e.args?.beginData?.dirtyObjects ?? null, forced: !!e.args?.beginData?.stackTrace });
    }
  }
  const counts = (n) => main.filter((e) => e.tid === thread && e.name === n).length;
  // Off the main thread: rasterising and the GPU (filters, blurs and shadows land here).
  const off = new Map();
  for (const e of main) {
    if (e.tid === thread || !/^(RasterTask|GPUTask|ImageDecodeTask|DrawFrame|Graphics\.Pipeline|ProxyMain::BeginMainFrame|LayerTreeHostImpl::PrepareToDraw|Display::DrawAndSwap|SkiaOutputSurfaceImplOnGpu::SwapBuffers)/.test(e.name)) continue;
    off.set(e.name, (off.get(e.name) ?? 0) + e.dur / 1000);
  }
  return {
    offMain: [...off].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, ms]) => ({ name: n, ms: round(ms) })),
    byName: [...totals].filter(([n]) => !/^(ThreadControllerImpl|RunTask|SequenceManager|TaskQueue|ThreadPool|MessageLoop|Scheduler)/.test(n)).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([n, ms]) => ({ name: n, ms: round(ms), count: counts(n) })),
    biggest: big.sort((a, b) => b.ms - a.ms).slice(0, 12),
    forced: [...forcedBy].sort((a, b) => b[1].ms - a[1].ms).slice(0, 15).map(([where, v]) => ({ ms: round(v.ms), count: v.count, where })),
  };
}

// ---- Scenarios ------------------------------------------------------------------------------

const keyEvents = (page) => page.evaluate(() => window.__perf.events.filter((e) => e.interactionId).map((e) => ({ name: e.name, ms: Math.round(e.duration), start: Math.round(e.start) })));

/** Main-thread tasks of one trace in order: what one input actually cost, step by step. */
function taskTimeline(events) {
  const tasks = events.filter((e) => e.ph === "X" && e.name === "RunTask" && e.dur > 1500);
  const thread = events.find((e) => e.name === "EventDispatch")?.tid;
  const own = tasks.filter((t) => t.tid === thread).sort((a, b) => a.ts - b.ts);
  if (!own.length) return [];
  const t0 = own[0].ts;
  return own.map((task) => {
    const inside = events.filter((e) => e.ph === "X" && e.tid === thread && e.ts >= task.ts && e.ts + e.dur <= task.ts + task.dur && e !== task);
    const top = new Map();
    for (const e of inside) {
      if (!["EventDispatch", "FunctionCall", "TimerFire", "FireAnimationFrame", "UpdateLayoutTree", "Layout", "Paint", "Layerize", "ParseHTML", "MessagePort::Accept", "XHRReadyStateChange", "ResourceReceivedData", "HitTest"].includes(e.name)) continue;
      top.set(e.name, (top.get(e.name) ?? 0) + e.dur / 1000);
    }
    return { atMs: round((task.ts - t0) / 1000), ms: round(task.dur / 1000), parts: [...top].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, ms]) => `${n} ${round(ms)}`).join(", ") };
  });
}

// ---- Continuous interactions (dragging, resizing): frame times and work per step ------------

/** Starts recording frame times in the page (rAF timestamps). */
const startFrames = (page) =>
  page.evaluate(() => {
    const w = window;
    w.__frames = [];
    w.__framesOn = true;
    const tick = (t) => {
      w.__frames.push(t);
      if (w.__framesOn) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

/** Frame intervals since startFrames: how smooth it looked. */
const stopFrames = (page) =>
  page.evaluate(() => {
    const w = window;
    w.__framesOn = false;
    const t = w.__frames;
    const gaps = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b);
    const at = (p) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor((p / 100) * gaps.length))] : 0);
    return { frames: t.length, frameP50Ms: Math.round(at(50) * 10) / 10, frameP90Ms: Math.round(at(90) * 10) / 10, frameMaxMs: Math.round(gaps.at(-1) ?? 0), slowFrames: gaps.filter((g) => g > 25).length };
  });

const nextFrame = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));

const counters = async (cdp) => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));

/** Main-thread work per step from the browser's counters (ms): steadier than latency on a busy machine. */
function perStep(before, after, steps) {
  const per = (name) => round(((after[name] - before[name]) * 1000) / steps, 2);
  return { taskMsPerStep: per("TaskDuration"), scriptMsPerStep: per("ScriptDuration"), styleMsPerStep: per("RecalcStyleDuration"), layoutMsPerStep: per("LayoutDuration"), layoutsPerStep: round((after.LayoutCount - before.LayoutCount) / steps, 2), stylesPerStep: round((after.RecalcStyleCount - before.RecalcStyleCount) / steps, 2) };
}

/** Waits until the page stops changing the DOM for `quiet` ms (cap `max`): when a switch has landed. Returns ms since `since`. */
const settled = (page, since, quiet = 150, max = 4000) =>
  page.evaluate(
    ({ since, quiet, max }) =>
      new Promise((resolve) => {
        let last = performance.now();
        // Motion writes style attributes on every frame of an entrance animation: those aren't the screen changing.
        const observer = new MutationObserver((records) => {
          if (records.some((r) => r.type !== "attributes" || r.attributeName !== "style")) last = performance.now();
        });
        observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
        const check = () => {
          const now = performance.now();
          if (now - last >= quiet || now - since > max) {
            observer.disconnect();
            resolve(Math.round(last - since));
          } else setTimeout(check, 25);
        };
        setTimeout(check, quiet);
      }),
    { since, quiet, max },
  );

const VIEW_KEYS = [
  ["home", "Shift+H"],
  ["calendar", "w"],
  ["contacts", "Shift+O"],
  ["automations", "Shift+U"],
  ["settings", "Control+Comma"],
  ["notes", "Shift+N"],
  ["files", "Shift+F"],
];

/** Back to the inbox: the rail's Mail button. */
async function toInbox(page) {
  await page.locator('button[aria-label="Mail"]').first().click();
}

const SCENARIOS = {
  /** Five seconds of nothing (a conversation open, no input): what the page costs just sitting there. */
  async idle(page, cdp) {
    await page.locator("[data-thread]").first().click();
    await page.waitForSelector("[data-message-id]", { timeout: 15_000 }).catch(() => {});
    await sleep(2000);
    const before = await counters(cdp);
    await sleep(5000);
    const after = await counters(cdp);
    const per = (name) => round(((after[name] - before[name]) * 1000) / 5, 1);
    return { taskMsPerSec: per("TaskDuration"), scriptMsPerSec: per("ScriptDuration"), stylesPerSec: round((after.RecalcStyleCount - before.RecalcStyleCount) / 5, 1), layoutsPerSec: round((after.LayoutCount - before.LayoutCount) / 5, 1) };
  },
  /** Drag the handle between the list and the reader 300 px left and back, one frame per step. */
  async paneresize(page, cdp) {
    await page.locator("[data-thread]").first().click();
    await page.waitForSelector("[data-message-id]", { timeout: 15_000 }).catch(() => {});
    await sleep(800);
    const handle = page.locator("[data-panel-resize-handle-id]").first();
    const box = await handle.boundingBox();
    if (!box) throw new Error("no pane handle (one pane at a time?)");
    const x0 = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x0, y);
    await page.mouse.down();
    const before = await counters(cdp);
    await startFrames(page);
    const path = [...Array(60)].map((_, i) => x0 - (i + 1) * 5).concat([...Array(60)].map((_, i) => x0 - 300 + (i + 1) * 5));
    for (const x of path) {
      await page.mouse.move(x, y);
      await nextFrame(page);
    }
    const frames = await stopFrames(page);
    const after = await counters(cdp);
    await page.mouse.up();
    await sleep(300);
    return { steps: path.length, ...frames, ...perStep(before, after, path.length) };
  },
  /** The window narrowing from 1440 to 760 px and back, 20 px a frame: crosses the sidebar's full -> rail and two panes -> one. */
  async winresize(page, cdp) {
    await page.locator("[data-thread]").first().click();
    await page.waitForSelector("[data-message-id]", { timeout: 15_000 }).catch(() => {});
    await sleep(800);
    const widths = [];
    for (let w = 1420; w >= 760; w -= 20) widths.push(w);
    for (let w = 780; w <= 1440; w += 20) widths.push(w);
    const before = await counters(cdp);
    await startFrames(page);
    for (const width of widths) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await nextFrame(page);
    }
    const frames = await stopFrames(page);
    const after = await counters(cdp);
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await sleep(500);
    return { steps: widths.length, ...frames, ...perStep(before, after, widths.length) };
  },
  /** Inbox -> Settings (or --view=<name> from VIEW_KEYS) -> Inbox ten times: just the round trip, for profiling. */
  async inboxtrip(page, cdp) {
    await page.locator("[data-thread]").first().click();
    await page.waitForSelector("[data-message-id]", { timeout: 15_000 }).catch(() => {});
    await sleep(800);
    const out = { to: [], back: [], toWork: [], backWork: [] };
    for (let i = 0; i < 10; i++) {
      for (const [list, work, go] of [[out.to, out.toWork, () => page.keyboard.press(Object.fromEntries(VIEW_KEYS)[args.view ?? "settings"])], [out.back, out.backWork, () => toInbox(page)]]) {
        const before = await counters(cdp);
        const since = await page.evaluate(() => performance.now());
        await go();
        list.push(await settled(page, since));
        const after = await counters(cdp);
        work.push(round((after.TaskDuration - before.TaskDuration) * 1000));
        await sleep(300);
      }
    }
    return { settingsReadyMs: median(out.to), settingsWorkMs: median(out.toWork), inboxReadyMs: median(out.back), inboxWorkMs: median(out.backWork) };
  },
  /** Inbox -> each view -> Inbox, twice (the first visit loads the view's code): until the screen stops changing, and the work it took. */
  async views(page, cdp) {
    await page.locator("[data-thread]").first().click();
    await page.waitForSelector("[data-message-id]", { timeout: 15_000 }).catch(() => {});
    await sleep(800);
    const out = {};
    const inbox = [];
    for (const pass of ["cold", "warm"]) {
      for (const [name, key] of VIEW_KEYS) {
        await page.evaluate(() => (window.__perf.events = []));
        let before = await counters(cdp);
        let since = await page.evaluate(() => performance.now());
        await page.keyboard.press(key);
        const ms = await settled(page, since);
        let after = await counters(cdp);
        const keyMs = Math.max(0, ...(await keyEvents(page)).filter((e) => e.name === "keydown").map((e) => e.ms));
        out[`${name}_${pass}`] = `${ms} ms ready, key ${keyMs} ms, ${round((after.TaskDuration - before.TaskDuration) * 1000)} ms work`;
        await sleep(400);
        before = await counters(cdp);
        since = await page.evaluate(() => performance.now());
        await toInbox(page);
        const back = await settled(page, since);
        after = await counters(cdp);
        inbox.push({ back, work: round((after.TaskDuration - before.TaskDuration) * 1000) });
        await sleep(400);
      }
    }
    return { ...out, toInboxMedianMs: median(inbox.map((x) => x.back)), toInboxWorkMedianMs: median(inbox.map((x) => x.work)) };
  },
  async load() {
    return {};
  },
  /** When each request of the cold load started and ended, and when the list appeared. */
  async waterfall(page) {
    const rows = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .filter((r) => r.name.includes("/api/") || r.name.includes("/_next/static/chunks/"))
        .map((r) => ({ what: new URL(r.name).pathname.replace(/^\/_next\/static\/chunks\//, "js "), start: Math.round(r.startTime), end: Math.round(r.responseEnd), kb: Math.round(r.decodedBodySize / 1024) })),
    );
    const nav = await page.evaluate(() => Math.round(performance.getEntriesByType("navigation")[0].responseEnd));
    console.log(`\nwaterfall: document at ${nav} ms`);
    console.table(rows.sort((a, b) => a.start - b.start).slice(0, 40));
    return {};
  },
  /** Animations still running once the app has settled (each costs a frame of work). */
  async anims(page) {
    await page.locator("[data-thread]").first().click();
    await sleep(3000);
    const running = await page.evaluate(() =>
      document.getAnimations().map((a) => {
        const el = a.effect?.target;
        return {
          name: a.animationName ?? a.transitionProperty ?? a.constructor.name,
          state: a.playState,
          iterations: a.effect?.getTiming().iterations,
          target: el ? `${el.tagName.toLowerCase()}.${String(el.className?.baseVal ?? el.className).split(" ").slice(0, 4).join(".")}` : "",
        };
      }),
    );
    // Who keeps asking for frames once things are still: rAF callers over one second, by stack.
    const callers = await page.evaluate(async () => {
      const counts = new Map();
      const original = window.requestAnimationFrame;
      window.requestAnimationFrame = (cb) => {
        const stack = (new Error().stack ?? "").split("\n").slice(2, 5).map((l) => l.trim().replace(/^at /, "")).join(" < ");
        counts.set(stack, (counts.get(stack) ?? 0) + 1);
        return original.call(window, cb);
      };
      await new Promise((r) => setTimeout(r, 1000));
      window.requestAnimationFrame = original;
      return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8);
    });
    console.log("\nrequestAnimationFrame calls in 1 s after settling:");
    for (const [stack, n] of callers) console.log(n, stack);
    console.log(`\nanims: ${running.length} running after 3 s`);
    console.table(running.slice(0, 30));
    return { running: running.length };
  },
  /** One j press, traced on its own: every main-thread task in the next second. */
  async press(page, cdp) {
    await page.locator("[data-thread]").first().click();
    await page.waitForSelector("[data-message-id]", { timeout: 15_000 }).catch(() => {});
    await sleep(1500);
    await cdp.send("Tracing.start", { traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "blink", "toplevel"] }, transferMode: "ReturnAsStream" });
    const ms = await pressAndWaitForReader(page, "j");
    await sleep(1000);
    const done = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
    await cdp.send("Tracing.end");
    const { stream } = await done;
    let text = "";
    for (;;) {
      const chunk = await cdp.send("IO.read", { handle: stream });
      text += chunk.base64Encoded ? Buffer.from(chunk.data, "base64").toString() : chunk.data;
      if (chunk.eof) break;
    }
    await cdp.send("IO.close", { handle: stream });
    const parsed = JSON.parse(text);
    console.log(`\npress: reader showed the next thread in ${round(ms)} ms`);
    console.table(taskTimeline(parsed.traceEvents ?? parsed));
    return { readerMs: round(ms) };
  },
  async open(page) {
    // Click a few threads in turn: the reader's first paint for a conversation.
    const times = [];
    // From the second row: the first is already shown (peeked) when the list loads.
    for (let i = 1; i <= 8; i++) {
      const shown = () => [...document.querySelectorAll("[data-message-id]")].map((e) => e.getAttribute("data-message-id")).join();
      const previous = await page.evaluate(shown);
      const before = Date.now();
      await page.locator("[data-thread]").nth(i).click();
      await page.waitForFunction((previous) => {
        const now = [...document.querySelectorAll("[data-message-id]")].map((e) => e.getAttribute("data-message-id")).join();
        return now && now !== previous;
      }, previous, { timeout: 10_000 }).catch(() => {});
      times.push(Date.now() - before);
      await sleep(150);
    }
    return { openMedianMs: median(times), openMaxMs: Math.max(...times) };
  },
  async jk(page, cdp) {
    await page.locator("[data-thread]").first().click();
    await page.waitForSelector("[data-message-id]", { timeout: 15_000 }).catch(() => {});
    await sleep(500);
    await page.evaluate(() => (window.__perf.events = []));
    // Main-thread work per press from the browser's own counters: steadier than latency on a busy machine.
    const counters = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
    const before = await counters();
    const reader = [];
    const down = Math.min(15, (await page.locator("[data-thread]").count()) - 1);
    for (let i = 0; i < down; i++) {
      reader.push(await pressAndWaitForReader(page, "j"));
      await sleep(120);
    }
    for (let i = 0; i < down; i++) {
      reader.push(await pressAndWaitForReader(page, "k"));
      await sleep(120);
    }
    const after = await counters();
    const presses = reader.length;
    const per = (name) => round(((after[name] - before[name]) * 1000) / presses, 1);
    // Back at the top: the selected row must be in view (the list scrolls to follow the selection).
    const selectedVisible = await page.evaluate(() => {
      const row = document.querySelector(".bg-pane-selected[data-thread]");
      const list = row?.closest(".overflow-y-auto");
      if (!row || !list) return false;
      const r = row.getBoundingClientRect(), l = list.getBoundingClientRect();
      return r.top >= l.top - 1 && r.bottom <= l.bottom + 1;
    });
    const keys = (await keyEvents(page)).filter((e) => e.name === "keydown").map((e) => e.ms);
    const valid = reader.filter((v) => v != null);
    return { nextThreadMedianMs: round(median(valid)), nextThreadP90Ms: round(percentile(valid, 90)), nextThreadMaxMs: round(Math.max(...valid)), keydownP90Ms: percentile(keys, 90) ?? 0, timeouts: reader.length - valid.length, selectedVisible: selectedVisible ? 1 : 0, taskMsPerPress: per("TaskDuration"), scriptMsPerPress: per("ScriptDuration"), layoutMsPerPress: per("LayoutDuration"), styleMsPerPress: per("RecalcStyleDuration") };
  },
  async search(page) {
    await page.keyboard.press("Escape");
    await page.evaluate(() => (window.__perf.events = []));
    await page.keyboard.press("/");
    const input = page.locator('input[placeholder="Search"]');
    await input.waitFor({ timeout: 5000 });
    // One key at a time, noting the rows after each: shows which keystroke swaps the list.
    const rows = [];
    for (const ch of "the invoice") {
      await page.keyboard.type(ch);
      await sleep(60);
      rows.push(await page.locator("[data-thread]").count());
    }
    await sleep(1500);
    rows.push(await page.locator("[data-thread]").count());
    const events = await keyEvents(page);
    const keydowns = events.filter((e) => e.name === "keydown").map((e) => e.ms);
    await input.fill("");
    await page.keyboard.press("Escape");
    await sleep(800);
    return { keyMaxMs: Math.max(0, ...keydowns), keyMedianMs: median(keydowns) ?? 0, slowKeys: keydowns.filter((m) => m > 100).length, keydowns: keydowns.join(" "), rows: rows.join(" ") };
  },
};

const NOFX = {
  backdrop: "*, *::before, *::after { backdrop-filter: none !important; }",
  sky: ".sky-layer { display: none !important; }",
  drift: ".sky-layer::before { animation: none !important; }",
  grain: ".sky-layer::after { display: none !important; }",
  grainbg: `.sky-layer::after { display: none !important; } .bg-sky { background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.06 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>"), var(--sky-image) !important; background-size: 160px 160px, cover !important; }`,
  grainflat: ".sky-layer::after { mix-blend-mode: normal !important; opacity: 0.06 !important; }",
  shadow: "* { box-shadow: none !important; }",
  mask: "* { mask-image: none !important; animation-timeline: auto !important; }",
  blurfade: "* { filter: none !important; }",
};

// ---- Run ------------------------------------------------------------------------------------

// No sync by default (--sync turns it on): reloads landing mid-measurement made runs noisy.
const INSPECT = 9339;
const server = await startServer({
  port: 3196,
  dataDir: dataFolder(),
  label: `quick ${data}`,
  env: { ...(args.sync ? {} : { KITE_PERF_NO_SYNC: "1" }), ...(args["server-profile"] ? { NODE_OPTIONS: `--inspect=127.0.0.1:${INSPECT}` } : {}) },
});

// --server-profile=<route>: CPU profile of the server while it answers that route 20 times.
if (args["server-profile"]) {
  const route = String(args["server-profile"]);
  const targets = await (await fetch(`http://127.0.0.1:${INSPECT}/json/list`)).json();
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg.result);
  });
  const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  for (let i = 0; i < 3; i++) await fetch(server.base + route).then((r) => r.arrayBuffer());
  await send("Profiler.enable");
  await send("Profiler.setSamplingInterval", { interval: 100 });
  await send("Profiler.start");
  const times = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    await fetch(server.base + route).then((r) => r.arrayBuffer());
    times.push(performance.now() - t);
  }
  const { profile } = await send("Profiler.stop");
  ws.close();
  const sum = summarizeProfile(profile);
  console.log(`
${route}: median ${round(median(times))} ms; server busy ${sum.busyMs} ms over 20 requests`);
  console.table(sum.selfByFunction.slice(0, 20));
  console.log("-- inclusive");
  console.table(sum.inclusive.filter((x) => !x.where.startsWith("(")).slice(0, 30));
  await server.stop();
  process.exit(0);
}
// --serve: keep the perf build running on the copy (read-only, no sync) to look at by hand.
if (args.serve) {
  log(`serving the perf build on ${server.base} (read-only copy). Ctrl+C to stop.`);
  await new Promise(() => {});
}
// --api: the local API suite (route times and sizes) on the same server.
if (args.api) {
  const api = await apiSuite(server.base);
  console.table(api.routes.map((r) => ({ route: r.route, medianMs: r.medianMs, maxMs: r.maxMs, rawKB: r.rawKB })));
  if (!scenarios.length) {
    await server.stop();
    process.exit(0);
  }
}
const browser = await launch();
const results = Object.fromEntries(scenarios.map((s) => [s, []]));
const profiles = Object.fromEntries(scenarios.map((s) => [s, []]));
const traces = Object.fromEntries(scenarios.map((s) => [s, []]));
const loads = [];
try {
  // Let the startup catch-up finish so sync doesn't land in the middle of a measurement.
  await sleep(Number(args.settle ?? (args.sync ? 3000 : 500)));
  for (let run = 0; run < runs; run++) {
    const { context, page, cdp, result, jsUrls } = await coldLoad(browser, server.base);
    // --nofx=backdrop,sky,shadow,mask,blurfade,motion: switch visual effects off to see what each costs (A/B, never shipped).
    if (args.nofx) await page.addStyleTag({ content: String(args.nofx).split(",").map((fx) => NOFX[fx] ?? "").join(" ") });
    // --bundle: which packages the cold load downloaded (all JS, including chunks that load after the list).
    if (args.bundle && run === 0) console.table(attributeFiles(jsUrls.map((u) => chunkPath(u))).slice(0, 20));
    loads.push({ listVisibleMs: result.listVisibleMs, totalBlockingMs: result.totalBlockingMs, longestTaskMs: result.longestTaskMs, jsGzipKB: result.jsGzipKB, jsFiles: result.jsFiles, domNodes: result.domNodes });
    for (const name of scenarios) {
      if (args.trace) await startTrace(cdp);
      if (args.profile) {
        await cdp.send("Profiler.enable");
        await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
        await cdp.send("Profiler.start");
      }
      // API calls made during the scenario, by route: reloads show up here.
      const calls = new Map();
      const onRequest = (req) => {
        const url = new URL(req.url());
        if (!url.pathname.startsWith("/api/")) return;
        const key = url.pathname.replace(/\/api\/mail\/threads\/[^/]+$/, "/api/mail/threads/[id]") + (url.searchParams.get("mailbox") ? "?mailbox" : "");
        calls.set(key, (calls.get(key) ?? 0) + 1);
      };
      page.on("request", onRequest);
      try {
        results[name].push(await SCENARIOS[name](page, cdp));
      } catch (error) {
        log(`${name} run ${run + 1} failed: ${error.message.split("\n")[0]}`);
      }
      page.off("request", onRequest);
      if (results[name].length) results[name].at(-1).api = [...calls].map(([k, n]) => `${k} x${n}`).join(", ");
      if (args.profile) profiles[name].push((await cdp.send("Profiler.stop")).profile);
      if (args.trace) traces[name].push(await stopTrace(cdp));
    }
    await context.close();
  }
} finally {
  await browser.close();
  await server.stop();
}

const pick = (list) => Object.fromEntries(Object.keys(list[0] ?? {}).map((k) => [k, typeof list[0][k] === "number" ? round(median(list.map((x) => x[k])), 1) : list.map((x) => x[k]).join(" | ")]));
const out = { at: new Date().toISOString(), data, runs, coldLoad: pick(loads), ...Object.fromEntries(scenarios.map((s) => [s, pick(results[s])])) };
console.log(JSON.stringify(out, null, 2));
if (args.profile) {
  for (const name of scenarios) {
    // The median run by busy time; --spike looks only at each run's longest busy stretch.
    const summaries = profiles[name]
      .map((p) => {
        const window = args.spike ? longestBusy(p) : null;
        return { ...summarizeProfile(p, 25, window), window };
      })
      .sort((a, b) => a.busyMs - b.busyMs);
    if (args.spike) console.log(`\n${name}: longest busy stretch per run: ${summaries.map((x) => round(x.window.ms)).join(", ")} ms`);
    const s = summaries[summaries.length >> 1];
    if (!s) continue;
    console.log(`\n== ${name}: ${s.busyMs} ms of main-thread work (median run)`);
    console.log("-- self time by file");
    console.table(s.selfByFile);
    console.log("-- self time by function");
    console.table(s.selfByFunction);
    console.log("-- inclusive (on the stack)");
    console.table(s.inclusive);
    console.log("-- app code, inclusive");
    console.table(s.app);
    if (args.who) for (const [stack, ms] of s.who) console.log(round(ms), "ms:", stack);
  }
}
if (args.trace) {
  for (const name of scenarios) {
    const t = traces[name][traces[name].length >> 1];
    if (!t) continue;
    console.log(`\n== ${name}: rendering work`);
    console.table(t.byName);
    console.log("-- off the main thread");
    console.table(t.offMain);
    console.table(t.biggest);
    console.log("-- forced by");
    console.table(t.forced);
  }
}
fs.mkdirSync(path.join(ROOT, "perf", "results"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "perf", "results", "quick.json"), JSON.stringify(out, null, 2));
