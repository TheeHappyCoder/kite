// What's new pictures for the update dialog (lib/release-notes.ts `media:`): short animated WebPs
// recorded from a Kite running on demo data (never a real mailbox):
//   pnpm dev:scratch --data=data-scratch-demo --port=3106
//   node scripts/whats-new-media.mjs --version=0.2.6 --only=list [--url=http://localhost:3106] [--headed]
// Writes docs/whats-new/<version>/<name>.webp, the release's folder (scripts/whats-new.mjs), which the
// website serves; a scene that fails leaves its screenshot in the system's temp folder.
//
// The scenes are in whats-new/scenes.mjs and last one release: empty that file when the next one starts
// (the clips are kept, and git has the old scenes). Everything they share is in whats-new/kit.mjs.
// Demo mail has no real files: a scene that opens one uses whats-new/sample-mailbox.mjs.
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CURSOR, VIEW, encode, record } from "./whats-new/kit.mjs";
import { scenes } from "./whats-new/scenes.mjs";

const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const base = arg("url", "http://localhost:3106");
const only = arg("only", "").split(",").filter(Boolean);
const version = arg("version", JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
const headless = !process.argv.includes("--headed");
const out = fileURLToPath(new URL(`../docs/whats-new/${version}/`, import.meta.url));

async function launch() {
  for (const channel of ["msedge", "chrome"]) {
    try {
      return await chromium.launch({ channel, headless });
    } catch {}
  }
  throw new Error("No Edge or Chrome found.");
}

await mkdir(out, { recursive: true });
const browser = await launch();
for (const [name, scene] of Object.entries(scenes)) {
  if (only.length && !only.includes(name)) continue;
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, colorScheme: "light" });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("kite-onboarded", "1");
      localStorage.setItem("kite-theme", "light");
    } catch {}
  });
  await context.addInitScript(CURSOR);
  const page = await context.newPage();
  page.setDefaultTimeout(scene.timeout ?? 8000);
  console.log("  opening Kite…");
  // A dev server may still be compiling, and its live events mean the network is never idle.
  await page.goto(base, { waitUntil: "load", timeout: 180_000 });
  console.log("  open");
  await page.getByText(scene.ready).first().waitFor({ timeout: 180_000 });
  // Anything the scene loads for the first time, loaded before the recording starts.
  if (scene.warm) {
    await scene.warm(page);
    await page.reload({ waitUntil: "load" });
    await page.getByText(scene.ready).first().waitFor();
  }
  // Rest the pointer over the reader, where it shows no tooltip.
  await page.mouse.move(980, 620);
  await page.waitForTimeout(800);
  try {
    const frames = await record(page, () => scene.run(page));
    const result = await encode(frames, `${out}${name}.webp`);
    console.log(`${name}: ${result.frames} frames, ${result.seconds.toFixed(1)} s, ${(result.bytes / 1024).toFixed(0)} KB`);
  } catch (error) {
    const shot = join(tmpdir(), `kite-${name}-failed.png`);
    await page.screenshot({ path: shot });
    console.error(`${name} failed: ${error.message} (${shot})`);
  }
  await context.close();
}
await browser.close();
