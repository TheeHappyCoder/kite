// What's new pictures for the update dialog (lib/release-notes.ts `media:`): short animated WebPs
// recorded from a Kite running on demo data (never a real mailbox):
//   pnpm dev:scratch --data=data-scratch-demo --port=3106
//   node scripts/whats-new-media.mjs [--url=http://localhost:3106] [--only=forward,print] [--version=0.2.5]
// Writes docs/whats-new/<version>/<name>.webp (the website serves them). Windows' own parts (Explorer's
// right-click menu, an app's Print window) can't be recorded from a browser, so they're drawn here as a
// window over Kite; everything after them is Kite itself.
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// sharp comes with Next (it isn't a dependency of Kite's own).
const sharp = createRequire(createRequire(import.meta.url).resolve("next/package.json"))("sharp");

const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const base = arg("url", "http://localhost:3106");
const only = arg("only", "").split(",").filter(Boolean);
const version = arg("version", "0.2.5");
const debug = process.argv.includes("--debug");
const out = fileURLToPath(new URL(`../docs/whats-new/${version}/`, import.meta.url));

const VIEW = { width: 1280, height: 800 };
/** The pictures' width: the dialog shows them about 500 px wide, twice that for sharp screens. */
const WIDTH = 1000;

async function launch() {
  for (const channel of ["msedge", "chrome"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {}
  }
  throw new Error("No Edge or Chrome found.");
}

// ---- A pointer you can see (headless screenshots have none), with a ring on each click ----

const CURSOR = () => {
  // The top page only: emails and previews are sandboxed frames.
  if (window !== window.top) return;
  const make = () => {
    if (document.getElementById("kite-cursor")) return;
    const style = document.createElement("style");
    style.textContent = `
      #kite-cursor{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transition:opacity .2s;filter:drop-shadow(0 1px 2px rgb(0 0 0/.35))}
      .kite-ring{position:fixed;z-index:2147483646;pointer-events:none;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;background:rgb(91 79 240/.28);animation:kite-ring .45s ease-out forwards}
      @keyframes kite-ring{from{transform:scale(.3);opacity:1}to{transform:scale(1.4);opacity:0}}`;
    document.head.append(style);
    const cursor = document.createElement("div");
    cursor.id = "kite-cursor";
    cursor.innerHTML = `<svg width="22" height="26" viewBox="0 0 22 26"><path d="M2 2 L2 20 L7 15.5 L10.5 23.5 L13.5 22.2 L10 14.5 L17 14.5 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    document.body.append(cursor);
    addEventListener("mousemove", (e) => (cursor.style.transform = `translate(${e.clientX - 2}px, ${e.clientY - 2}px)`), true);
    addEventListener(
      "mousedown",
      (e) => {
        const ring = document.createElement("div");
        ring.className = "kite-ring";
        ring.style.left = `${e.clientX}px`;
        ring.style.top = `${e.clientY}px`;
        document.body.append(ring);
        setTimeout(() => ring.remove(), 500);
      },
      true,
    );
  };
  if (document.body) make();
  else addEventListener("DOMContentLoaded", make);
};

/** Glides the pointer to the middle of `target` (a locator or a point). */
async function moveTo(page, target, steps = 24) {
  if (debug) console.log("    move", "x" in target ? JSON.stringify(target) : String(target));
  const point = "x" in target ? target : await target.boundingBox().then((b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 }));
  await page.mouse.move(point.x, point.y, { steps });
  return point;
}

async function click(page, target, { button = "left", pause = 220 } = {}) {
  await moveTo(page, target);
  await page.waitForTimeout(pause);
  await page.mouse.down({ button });
  await page.mouse.up({ button });
}

// ---- Recording: Chrome's screencast frames with their times, then one animated WebP ----

async function record(page, scene) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    frames.push({ data: Buffer.from(data, "base64"), at: metadata.timestamp * 1000 });
    void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  console.log("  recording…");
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: VIEW.width, maxHeight: VIEW.height, everyNthFrame: 1 });
  await page.waitForTimeout(300);
  const started = Date.now();
  await scene();
  console.log(`  scene took ${((Date.now() - started) / 1000).toFixed(1)} s, ${frames.length} frames`);
  await page.waitForTimeout(1400);
  await cdp.send("Page.stopScreencast");
  return frames;
}

/** Frames -> animated WebP: equal neighbours merged, each shown for its real time (at most 10 a second). */
async function encode(frames, file) {
  const kept = [];
  for (const frame of frames) {
    const last = kept[kept.length - 1];
    if (last && (frame.data.equals(last.data) || frame.at - last.at < 100)) {
      if (frame.data.equals(last.data)) continue;
      last.data = frame.data;
      continue;
    }
    kept.push({ ...frame });
  }
  const delays = kept.map((f, i) => Math.round(Math.min(4000, Math.max(100, (kept[i + 1]?.at ?? f.at + 2200) - f.at))));
  console.log(`  encoding ${kept.length} frames…`);
  const images = await Promise.all(kept.map((f) => sharp(f.data).resize({ width: WIDTH }).png().toBuffer()));
  console.log("  frames resized, joining…");
  const webp = await sharp(images, { join: { animated: true } }).webp({ loop: 0, delay: delays, quality: 72, effort: 2 }).toBuffer();
  await writeFile(file, webp);
  return { frames: kept.length, bytes: webp.length, seconds: delays.reduce((a, b) => a + b, 0) / 1000 };
}

// ---- Windows' own windows, drawn over Kite (Explorer, a Print window) ----

const WINDOW_CSS = `
  .kw-shade{position:fixed;inset:0;z-index:2147483000;background:rgb(10 12 20/.28);display:grid;place-items:center;font:13px/1.4 "Segoe UI",system-ui,sans-serif;color:#1b1b1f;animation:kw-in .25s ease-out}
  .kw-window{width:640px;border-radius:10px;background:#fbfbfc;box-shadow:0 24px 60px -12px rgb(0 0 0/.45),0 0 0 1px rgb(0 0 0/.08);overflow:hidden}
  .kw-title{height:36px;display:flex;align-items:center;gap:8px;padding:0 14px;background:#f0f1f4;font-size:12px;color:#444}
  .kw-dots{margin-left:auto;display:flex;gap:16px;color:#666;font-size:14px}
  .kw-bar{display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid #e6e7eb;color:#555;font-size:12px}
  .kw-path{flex:1;border-radius:6px;background:#fff;border:1px solid #e1e2e6;padding:4px 10px}
  .kw-list{padding:6px}
  .kw-head,.kw-row{display:grid;grid-template-columns:1fr 150px 80px;gap:12px;align-items:center;padding:6px 10px;border-radius:6px}
  .kw-head{color:#777;font-size:11.5px}
  .kw-row.kw-on{background:#dce8fb}
  .kw-name{display:flex;align-items:center;gap:9px}
  .kw-ico{width:18px;height:22px;border-radius:3px;position:relative;flex:none}
  .kw-menu{position:fixed;z-index:2147483001;width:250px;border-radius:8px;background:#fbfbfc;box-shadow:0 12px 32px -6px rgb(0 0 0/.35),0 0 0 1px rgb(0 0 0/.08);padding:5px;animation:kw-pop .14s ease-out}
  .kw-item{display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:5px}
  .kw-item.kw-lit{background:#e8ebf2}
  .kw-sep{height:1px;background:#e6e7eb;margin:4px 6px}
  .kw-muted{color:#8a8b93}
  .kw-kite{width:16px;height:16px}
  .kw-out{animation:kw-out .22s ease-in forwards}
  @keyframes kw-in{from{opacity:0}}
  @keyframes kw-pop{from{opacity:0;transform:translateY(-4px)}}
  @keyframes kw-out{to{opacity:0;transform:scale(.98)}}
  .kw-print{width:560px}
  .kw-field{display:grid;grid-template-columns:110px 1fr;align-items:center;gap:12px;padding:8px 20px}
  .kw-select{border:1px solid #d8d9de;border-radius:6px;background:#fff;padding:6px 10px;display:flex;align-items:center;gap:8px}
  .kw-preview{margin:14px 20px;height:190px;border-radius:6px;background:#eceef2;display:grid;place-items:center}
  .kw-page{width:130px;height:170px;background:#fff;box-shadow:0 1px 4px rgb(0 0 0/.15);padding:14px;display:flex;flex-direction:column;gap:6px}
  .kw-line{height:5px;border-radius:3px;background:#dcdde2}
  .kw-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px 16px}
  .kw-btn{border-radius:6px;padding:6px 18px;border:1px solid #d8d9de;background:#fff}
  .kw-primary{background:#2f6fe4;border-color:#2f6fe4;color:#fff}
`;

const KITE_MARK = `<svg class="kw-kite" viewBox="0 0 36 44"><path d="M18 0 L34 18 L18 44 L2 18 Z" fill="#5b4ff0"/><path d="M2 18 H34 M18 0 V44" stroke="#fff" stroke-width="2" opacity=".8"/></svg>`;
const fileIcon = (kind) => {
  const colour = { pdf: "#e2463b", doc: "#2b6be8", xls: "#1f8f4e", img: "#b25ad6" }[kind] ?? "#8a8b93";
  return `<span class="kw-ico" style="background:${colour}"><span style="position:absolute;left:3px;right:3px;bottom:3px;height:2px;background:#fff;opacity:.8"></span></span>`;
};

/** An Explorer-like window over Kite with these files; returns the row locators by name. */
async function showExplorer(page, folder, files) {
  await page.evaluate(
    ({ css, folder, files, icons }) => {
      const style = document.createElement("style");
      style.id = "kw-style";
      style.textContent = css;
      document.head.append(style);
      const shade = document.createElement("div");
      shade.className = "kw-shade";
      shade.id = "kw";
      shade.innerHTML = `<div class="kw-window">
        <div class="kw-title">📁 ${folder}<span class="kw-dots"><span>—</span><span>☐</span><span>✕</span></span></div>
        <div class="kw-bar"><span>←</span><span>→</span><span>↑</span><span class="kw-path">This PC › ${folder}</span></div>
        <div class="kw-list"><div class="kw-head"><span>Name</span><span>Date modified</span><span>Size</span></div>
        ${files.map((f, i) => `<div class="kw-row" data-file="${f.name}"><span class="kw-name">${icons[i]}${f.name}</span><span class="kw-muted">${f.date}</span><span class="kw-muted">${f.size}</span></div>`).join("")}
        </div></div>`;
      document.body.append(shade);
    },
    { css: WINDOW_CSS, folder, files, icons: files.map((f) => fileIcon(f.kind)) },
  );
  await page.waitForTimeout(500);
}

/** Right-click on a file: Explorer's menu with Kite's two entries; clicks `choose`. */
async function explorerMenu(page, file, choose) {
  const row = page.locator(`.kw-row[data-file="${file}"]`);
  await click(page, row);
  await page.evaluate((file) => document.querySelector(`.kw-row[data-file="${file}"]`).classList.add("kw-on"), file);
  await page.waitForTimeout(250);
  const box = await row.boundingBox();
  const at = { x: box.x + 150, y: box.y + box.height / 2 };
  await moveTo(page, at, 10);
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
  await page.evaluate(
    ({ at, kite }) => {
      const menu = document.createElement("div");
      menu.className = "kw-menu";
      menu.id = "kw-menu";
      menu.style.left = `${at.x + 4}px`;
      menu.style.top = `${at.y + 4}px`;
      const item = (label, icon = "") => `<div class="kw-item" data-item="${label}">${icon || '<span style="width:16px"></span>'}${label}</div>`;
      menu.innerHTML = [item("Open"), item("Open with"), '<div class="kw-sep"></div>', item("Show the email in Kite", kite), item("Send back in Kite", kite), '<div class="kw-sep"></div>', item("Copy"), item("Rename"), item("Delete"), '<div class="kw-sep"></div>', item("Properties")].join("");
      document.body.append(menu);
    },
    { at, kite: KITE_MARK },
  );
  await page.waitForTimeout(500);
  const item = page.locator(`#kw-menu [data-item="${choose}"]`);
  await moveTo(page, item, 18);
  await page.evaluate((choose) => document.querySelector(`#kw-menu [data-item="${choose}"]`).classList.add("kw-lit"), choose);
  await page.waitForTimeout(450);
  await page.mouse.down();
  await page.mouse.up();
  await closeWindows(page);
}

async function closeWindows(page) {
  await page.evaluate(() => {
    for (const id of ["kw", "kw-menu"]) document.getElementById(id)?.classList.add("kw-out");
  });
  await page.waitForTimeout(240);
  await page.evaluate(() => ["kw", "kw-menu", "kw-style"].forEach((id) => document.getElementById(id)?.remove()));
}

/** An app's Print window with Kite picked as the printer; clicks Print. */
async function showPrint(page, document_) {
  await page.evaluate(
    ({ css, doc, kite }) => {
      const style = document.createElement("style");
      style.id = "kw-style";
      style.textContent = css;
      document.head.append(style);
      const shade = document.createElement("div");
      shade.className = "kw-shade";
      shade.id = "kw";
      shade.innerHTML = `<div class="kw-window kw-print">
        <div class="kw-title">🖨 Print · ${doc}<span class="kw-dots"><span>✕</span></span></div>
        <div class="kw-field"><span>Printer</span><span class="kw-select" id="kw-printer"><span style="width:16px"></span>Microsoft Print to PDF<span class="kw-muted" style="margin-left:auto">▾</span></span></div>
        <div class="kw-field"><span>Copies</span><span class="kw-select" style="width:70px">1</span></div>
        <div class="kw-preview"><div class="kw-page"><div class="kw-line" style="width:50%;background:#5b4ff0"></div><div class="kw-line"></div><div class="kw-line" style="width:80%"></div><div class="kw-line" style="width:65%"></div><div style="flex:1"></div><div class="kw-line" style="width:40%;margin-left:auto"></div></div></div>
        <div class="kw-foot"><span class="kw-btn">Cancel</span><span class="kw-btn kw-primary" id="kw-go">Print</span></div>
      </div>`;
      document.body.append(shade);
      window.__kwKite = kite;
    },
    { css: WINDOW_CSS, doc: document_, kite: KITE_MARK },
  );
  await page.waitForTimeout(600);
  await click(page, page.locator("#kw-printer"));
  // The list of printers, Kite picked.
  await page.evaluate(() => {
    const select = document.getElementById("kw-printer");
    const box = select.getBoundingClientRect();
    const menu = document.createElement("div");
    menu.className = "kw-menu";
    menu.id = "kw-menu";
    menu.style.left = `${box.left}px`;
    menu.style.top = `${box.bottom + 4}px`;
    menu.style.width = `${box.width}px`;
    const item = (label, icon = '<span style="width:16px"></span>') => `<div class="kw-item" data-item="${label}">${icon}${label}</div>`;
    menu.innerHTML = [item("Microsoft Print to PDF"), item("Kite", window.__kwKite), item("Office printer (2nd floor)")].join("");
    document.body.append(menu);
  });
  await page.waitForTimeout(400);
  const kite = page.locator('#kw-menu [data-item="Kite"]');
  await moveTo(page, kite, 14);
  await page.evaluate(() => document.querySelector('#kw-menu [data-item="Kite"]').classList.add("kw-lit"));
  await page.waitForTimeout(350);
  await page.mouse.down();
  await page.mouse.up();
  await page.evaluate(() => {
    document.getElementById("kw-menu").remove();
    document.getElementById("kw-printer").innerHTML = `${window.__kwKite}Kite<span class="kw-muted" style="margin-left:auto">▾</span>`;
  });
  await page.waitForTimeout(500);
  await click(page, page.locator("#kw-go"));
  await page.waitForTimeout(200);
  await closeWindows(page);
}

// ---- Kite ----

/** A small PDF for the files Kite attaches in these scenes (the demo has no real files). */
function pdf(title, kb = 200) {
  const text = `BT /F1 18 Tf 40 760 Td (${title}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((o, i) => {
    const at = body.length;
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // A realistic size on the file chip (a comment after the end, which readers ignore).
  return Buffer.from(`${body}%${"0".repeat(Math.max(0, kb * 1024 - body.length - 2))}\n`);
}

const threadRow = (page, subject) => page.getByText(subject).first();

/** Attaches a file to the composer that's open, as a drop from Explorer would. */
async function attachToComposer(page, name, kb) {
  const input = page.locator('input[type="file"]').last();
  await input.setInputFiles({ name, mimeType: "application/pdf", buffer: pdf(name.replace(/\.[a-z]+$/, ""), kb) });
}

const scenes = {
  "show-email": async (page) => {
    await showExplorer(page, "Downloads", [
      { name: "Itinerary-QX7P2M.pdf", kind: "pdf", date: "Yesterday 18:12", size: "120 KB" },
      { name: "Services-Agreement-v3.docx", kind: "doc", date: "26/10/2026 09:40", size: "212 KB" },
      { name: "Statement-Oct.pdf", kind: "pdf", date: "21/10/2026 07:02", size: "310 KB" },
      { name: "braai-photos.zip", kind: "img", date: "18/10/2026 20:15", size: "14.2 MB" },
    ]);
    await explorerMenu(page, "Itinerary-QX7P2M.pdf", "Show the email in Kite");
    await page.waitForTimeout(200);
    // What Kite does: the booking is in the Updates tab (the inbox tabs are 1 to 4).
    await page.keyboard.press("4");
    await page.waitForTimeout(300);
    await threadRow(page, "Booking confirmed: CPT → JNB").click();
    await page.waitForTimeout(900);
    const pill = page.getByRole("button", { name: /1 file|Itinerary/i }).first();
    if (await pill.count()) await click(page, pill);
  },
  "send-back": async (page) => {
    await showExplorer(page, "Documents › Contracts", [
      { name: "Services-Agreement-v3.docx", kind: "doc", date: "Today 11:24", size: "214 KB" },
      { name: "Services-Agreement-v2.docx", kind: "doc", date: "24/10/2026 16:05", size: "209 KB" },
      { name: "NDA-Mokoena.pdf", kind: "pdf", date: "12/10/2026 10:30", size: "96 KB" },
    ]);
    await explorerMenu(page, "Services-Agreement-v3.docx", "Send back in Kite");
    await threadRow(page, "Contract draft v3").click();
    await page.waitForTimeout(500);
    // The full reply (r only focuses the quick reply box).
    await page.keyboard.press("a");
    await page.waitForTimeout(700);
    await attachToComposer(page, "Services-Agreement-v3.docx", 214);
    await page.waitForTimeout(600);
    await page.keyboard.type("Signed and attached. Thanks Lerato!", { delay: 35 });
  },
  forward: async (page) => {
    // The bank's mail is in the Updates tab (the inbox tabs are 1 to 4).
    await page.keyboard.press("4");
    await page.waitForTimeout(600);
    await click(page, threadRow(page, "Transaction update"));
    await page.waitForTimeout(700);
    await page.keyboard.press("f");
    await page.waitForTimeout(800);
    // To is focused first: an address, then the note in the body.
    await page.keyboard.type("claims@discovery.co.za", { delay: 25 });
    await page.keyboard.press("Enter");
    await click(page, page.locator("[contenteditable=true]").last());
    await page.keyboard.type("For the claim, see below.", { delay: 30 });
    await click(page, page.getByRole("button", { name: "Remove parts…" }));
    const frame = page.frameLocator('iframe[title="The forwarded message"]');
    await frame.locator("body").waitFor();
    await page.waitForTimeout(600);
    for (const phrase of ["****7713", "R18 204.11"]) {
      // Select the phrase the way a drag would, then Remove.
      const handle = await page.locator('iframe[title="The forwarded message"]').elementHandle();
      const inner = await handle.contentFrame();
      const box = await inner.evaluate((phrase) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n; (n = walker.nextNode()); ) {
          const i = n.data.indexOf(phrase);
          if (i < 0) continue;
          const range = document.createRange();
          range.setStart(n, i);
          range.setEnd(n, i + phrase.length);
          const r = range.getBoundingClientRect();
          return { x: r.left, y: r.top, w: r.width, h: r.height };
        }
        return null;
      }, phrase);
      const frameBox = await handle.boundingBox();
      const from = { x: frameBox.x + box.x + 1, y: frameBox.y + box.y + box.h / 2 };
      const to = { x: frameBox.x + box.x + box.w - 1, y: from.y };
      // Pressing the mouse inside the sandboxed frame crashes headless Edge while it records: the pointer
      // sweeps across the words and the selection grows with it, set from inside the frame.
      await moveTo(page, from);
      const sweep = 14;
      for (let step = 1; step <= sweep; step++) {
        await page.mouse.move(from.x + ((to.x - from.x) * step) / sweep, from.y);
        await inner.evaluate(
          ({ phrase, upTo }) => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            for (let n; (n = walker.nextNode()); ) {
              const i = n.data.indexOf(phrase);
              if (i < 0) continue;
              const range = document.createRange();
              range.setStart(n, i);
              range.setEnd(n, i + upTo);
              const selection = getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
              return;
            }
          },
          { phrase, upTo: Math.ceil((phrase.length * step) / sweep) },
        );
        await page.waitForTimeout(30);
      }
      await page.waitForTimeout(350);
      await click(page, page.getByRole("button", { name: /^Remove “/ }));
      await page.waitForTimeout(700);
    }
    const hide = page.getByRole("switch", { name: "Leave out who it was sent to" });
    await moveTo(page, hide);
    await page.waitForTimeout(200);
    await hide.click();
    await page.waitForTimeout(700);
    await click(page, page.getByRole("button", { name: "Done" }));
  },
  print: async (page) => {
    await showPrint(page, "Invoice 42");
    await page.waitForTimeout(300);
    await page.keyboard.press("c");
    await page.waitForTimeout(700);
    await attachToComposer(page, "Invoice 42.pdf", 48);
    await page.waitForTimeout(500);
    // To is focused first: who it goes to, then a line in the body.
    await page.keyboard.type("accounts@siphoplumbing.co.za", { delay: 25 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
    await click(page, page.locator("[contenteditable=true]").last());
    await page.waitForTimeout(500);
    await page.keyboard.type("Hi Sipho, your invoice for October is attached.", { delay: 30 });
  },
};

await mkdir(out, { recursive: true });
const browser = await launch();
for (const [name, scene] of Object.entries(scenes)) {
  if (only.length && !only.includes(name)) continue;
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, colorScheme: "light" });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("kite-onboarded", "1");
    } catch {}
  });
  await context.addInitScript(CURSOR);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  console.log("  opening Kite…");
  await page.goto(base, { waitUntil: "networkidle" });
  console.log("  open");
  await page.getByText("Q4 planning").first().waitFor();
  // Rest the pointer over the reader, where it shows no tooltip.
  await page.mouse.move(980, 620);
  await page.waitForTimeout(800);
  try {
    const frames = await record(page, () => scene(page));
    const result = await encode(frames, `${out}${name}.webp`);
    console.log(`${name}: ${result.frames} frames, ${result.seconds.toFixed(1)} s, ${(result.bytes / 1024).toFixed(0)} KB`);
  } catch (error) {
    await page.screenshot({ path: `${out}${name}-failed.png` });
    console.error(`${name} failed: ${error.message}`);
  }
  await context.close();
}
await browser.close();
