// README screenshots from a Kite running on demo data (never a real mailbox):
//   pnpm dev:scratch --data=data-demo   (launch config `kite-demo`, port 3101)
//   node scripts/readme-shots.mjs [--url=http://localhost:3101] [--only=inbox,today]
// Writes PNGs to docs/screenshots/ with installed Edge or Chrome (playwright-core).
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const base = arg("url", "http://localhost:3101");
const only = arg("only", "")?.split(",").filter(Boolean);
const out = fileURLToPath(new URL("../docs/screenshots/", import.meta.url));

async function launch() {
  for (const channel of ["msedge", "chrome"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {}
  }
  throw new Error("No Edge or Chrome found.");
}

const nav = (page, label) => page.locator("aside").getByRole("button", { name: new RegExp(`^${label}( ?[0-9]+)?$`) }).first().click();

const shots = {
  inbox: async () => {},
  "inbox-dark": async () => {},
  chat: async (page) => {
    await page.getByText("Braai on Saturday?").first().click();
    const toggle = page.getByRole("button", { name: "Show as chat" });
    if (await toggle.count()) await toggle.click();
  },
  today: (page) => nav(page, "Today"),
  calendar: async (page) => {
    await nav(page, "Calendar");
    await page.getByText("Week", { exact: true }).first().click();
    await page.waitForTimeout(600);
  },
  files: (page) => nav(page, "Files"),
  palette: (page) => page.getByRole("button", { name: "Search or jump to" }).click(),
  automations: (page) => nav(page, "Automations"),
  privacy: async (page) => {
    await nav(page, "Settings");
    await page.getByRole("button", { name: "Privacy", exact: true }).first().click();
  },
};

await mkdir(out, { recursive: true });
const browser = await launch();
for (const [name, setup] of Object.entries(shots)) {
  if (only.length && !only.includes(name)) continue;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: name.endsWith("-dark") ? "dark" : "light",
  });
  await context.addInitScript(() => localStorage.setItem("kite-onboarded", "1"));
  const page = await context.newPage();
  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByText("Q4 planning").first().waitFor();
  await page.waitForTimeout(800);
  await setup(page);
  // The demo's "Connect my mail" card isn't part of the product.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("aside button")) {
      if (el.textContent?.includes("Connect your mail") || el.getAttribute("aria-label") === "Connect your mail") el.style.display = "none";
    }
  });
  await page.mouse.move(1439, 899);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}${name}.png` });
  console.log(`${name}.png`);
  // Chat view is saved per conversation; put it back so the demo stays as it was.
  const back = page.getByRole("button", { name: "Show as email" });
  if (name === "chat" && (await back.count())) await back.click();
  await context.close();
}
await browser.close();
