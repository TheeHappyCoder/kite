// A real mailbox of made-up mail for clips that open real files (demo mail has none): the local test
// server (scripts/imap-test-server.mjs, in memory) with one conversation carrying Excel, Word, PDF and
// video, signed in to a Kite on its own empty data folder (launch config `kite-samples`).
//   node scripts/whats-new/sample-mailbox.mjs [--url=http://localhost:3107]
// Runs until it's stopped. Delete data-scratch-samples/ afterwards: its account points at this server.
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { chromium } from "playwright-core";
import { utils, write } from "xlsx";
import { startTestServer } from "../imap-test-server.mjs";

const base = process.argv.find((a) => a.startsWith("--url="))?.slice(6) ?? "http://localhost:3107";
// jszip comes with docx-preview (it isn't a dependency of Kite's own).
const JSZip = createRequire(realpathSync(fileURLToPath(new URL("../../node_modules/docx-preview/package.json", import.meta.url))))("jszip");

function budget() {
  const book = utils.book_new();
  const rows = [
    ["Item", "Budget", "Spent", "Left"],
    ["Site labour", 186000, 171250, 14750],
    ["Materials", 244500, 251300, -6800],
    ["Plant hire", 58000, 49900, 8100],
    ["Electrical", 72400, 68150, 4250],
    ["Plumbing", 64800, 60100, 4700],
    ["Permits", 12500, 12500, 0],
    ["Contingency", 40000, 11800, 28200],
    ["Total", 678200, 625000, 53200],
  ];
  utils.book_append_sheet(book, utils.aoa_to_sheet(rows), "October");
  utils.book_append_sheet(
    book,
    utils.aoa_to_sheet([
      ["Supplier", "Contact", "Terms", "Next delivery"],
      ["Cape Timber", "Sipho Dlamini", "30 days", "4 Nov"],
      ["Harbour Plumbing", "Lerato Mokoena", "14 days", "6 Nov"],
      ["Bright Electrical", "Anika Naidoo", "30 days", "11 Nov"],
      ["Coastal Plant Hire", "Pieter Botha", "7 days", "On call"],
    ]),
    "Suppliers",
  );
  return write(book, { type: "buffer", bookType: "xlsx" });
}

const paragraph = (text, { bold = false, size = 22 } = {}) =>
  `<w:p><w:pPr><w:spacing w:after="160"/></w:pPr><w:r><w:rPr>${bold ? "<w:b/>" : ""}<w:sz w:val="${size}"/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const cell = (text, bold) => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr><w:p><w:r><w:rPr>${bold ? "<w:b/>" : ""}</w:rPr><w:t>${text}</w:t></w:r></w:p></w:tc>`;
const table = (rows) =>
  `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((side) => `<w:${side} w:val="single" w:sz="4" w:color="BBBBBB"/>`).join("")}</w:tblBorders></w:tblPr>${rows.map((row, i) => `<w:tr>${row.map((text) => cell(text, i === 0)).join("")}</w:tr>`).join("")}</w:tbl>`;

async function handover() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  const body = [
    paragraph("Site handover", { bold: true, size: 44 }),
    paragraph("12 Marine Drive, Hout Bay. Prepared for the owner, 30 October."),
    paragraph("What's finished", { bold: true, size: 28 }),
    paragraph("The kitchen, both bathrooms and the upstairs flooring are done and signed off. The new geyser passed its pressure test on Tuesday, and the certificate is attached to the job file."),
    table([
      ["Room", "Status", "Signed off by"],
      ["Kitchen", "Complete", "Lerato"],
      ["Bathrooms", "Complete", "Sipho"],
      ["Deck", "Snag list", "Pending"],
    ]),
    paragraph(""),
    paragraph("What's left", { bold: true, size: 28 }),
    paragraph("The deck has two loose boards and needs a second coat of sealant once the weather clears. Bright Electrical returns on 11 November for the outside lights."),
    paragraph("Keys and access", { bold: true, size: 28 }),
    paragraph("Two sets of keys are with the office. The alarm code changes on handover, so please arrange a time with Anika before the end of next week."),
  ].join("");
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1200" w:right="1200" w:bottom="1200" w:left="1200"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function invoice() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.12, 0.12, 0.16);
  const text = (value, x, y, size = 11, face = font) => page.drawText(value, { x, y, size, font: face, color: ink });
  text("Harbour Plumbing", 50, 770, 24, bold);
  text("Tax invoice 0042, 28 October", 50, 745);
  text("Description", 50, 690, 11, bold);
  text("Amount", 470, 690, 11, bold);
  page.drawLine({ start: { x: 50, y: 680 }, end: { x: 545, y: 680 }, color: ink, thickness: 0.6 });
  [["New geyser, supplied and fitted", "R 14 800.00"], ["Bathroom pipework, labour", "R 9 250.00"], ["Pressure test and certificate", "R 1 650.00"]].forEach(([what, amount], i) => {
    text(what, 50, 655 - i * 26);
    text(amount, 470, 655 - i * 26);
  });
  text("Total", 50, 560, 13, bold);
  text("R 25 700.00", 470, 560, 13, bold);
  return Buffer.from(await doc.save());
}

/** A few seconds of a moving picture, made in the browser (it needs no video tools installed). */
async function walkthrough() {
  const browser = await chromium.launch({ channel: "msedge", headless: true }).catch(() => chromium.launch({ channel: "chrome", headless: true }));
  const page = await browser.newPage();
  const base64 = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const canvas = Object.assign(document.createElement("canvas"), { width: 960, height: 540 });
        const draw = canvas.getContext("2d");
        const recorder = new MediaRecorder(canvas.captureStream(24), { mimeType: "video/webm" });
        const chunks = [];
        recorder.ondataavailable = (e) => chunks.push(e.data);
        recorder.onstop = async () => {
          const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
          let out = "";
          for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          resolve(btoa(out));
        };
        const started = performance.now();
        const frame = () => {
          const t = (performance.now() - started) / 1000;
          const sky = draw.createLinearGradient(0, 0, 0, 540);
          sky.addColorStop(0, "#2d6fb3");
          sky.addColorStop(1, "#f2c9a0");
          draw.fillStyle = sky;
          draw.fillRect(0, 0, 960, 540);
          draw.fillStyle = "#3d4a57";
          draw.fillRect(0, 400, 960, 140);
          draw.fillStyle = "#fff";
          draw.fillRect(120 + t * 60, 250, 260, 150);
          draw.fillStyle = "#7c4a33";
          draw.beginPath();
          draw.moveTo(100 + t * 60, 250);
          draw.lineTo(250 + t * 60, 170);
          draw.lineTo(400 + t * 60, 250);
          draw.fill();
          draw.fillStyle = "#fff";
          draw.font = "600 34px sans-serif";
          draw.fillText("12 Marine Drive: site walkthrough", 60, 70);
          if (t < 6) requestAnimationFrame(frame);
          else recorder.stop();
        };
        recorder.start();
        frame();
      }),
  );
  await browser.close();
  return Buffer.from(base64, "base64");
}

const server = await startTestServer({ quiet: true });
const mail = nodemailer.createTransport({ host: "127.0.0.1", port: server.smtpPort, secure: false, ignoreTLS: true });
await mail.sendMail({
  from: "Lerato Mokoena <lerato@harbourbuild.example>",
  to: server.user,
  subject: "October numbers and the handover",
  text: "Hi, here's everything for the Marine Drive job: the budget, the handover notes, Harbour Plumbing's invoice and a short walkthrough of the site.\n\nLet me know if anything looks off.\n\nLerato",
  attachments: [
    { filename: "Budget-October.xlsx", content: budget() },
    { filename: "Handover-Marine-Drive.docx", content: await handover() },
    { filename: "Invoice-0042.pdf", content: await invoice() },
    { filename: "Walkthrough-Marine-Drive.webm", content: await walkthrough(), contentType: "video/webm" },
  ],
});

const res = await fetch(`${base}/api/auth/imap`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: base },
  body: JSON.stringify({
    email: server.user,
    password: server.password,
    name: "Sample mailbox",
    servers: { imap: { host: "127.0.0.1", port: server.imapPort, secure: false }, smtp: { host: "127.0.0.1", port: server.smtpPort, secure: false } },
  }),
});
console.log(`Signed in to ${base}: ${res.status} ${await res.text()}`);
if (!res.ok) process.exit(1);
console.log("Running. Stop it when the recording is done.");
setInterval(() => {}, 60_000);
