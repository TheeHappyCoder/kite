// This release's clips, one scene each. They last one release: empty `scenes` when the next one starts.
// `ready`: text that says Kite has what the scene needs. `run`: what the pointer does while it records.
// `warm` (optional): loads what `run` opens, before recording, so the clip doesn't show a dev server compiling.
import { click, moveTo } from "./kit.mjs";

/** The middle of `word` inside the signature's text field. */
async function wordAt(page, word) {
  return page
    .getByRole("textbox", { name: "Text" })
    .first()
    .evaluate((el, w) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n; (n = walker.nextNode()); ) {
        const i = n.textContent.indexOf(w);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + w.length);
        const b = r.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      }
      throw new Error(`No "${w}" in the text field`);
    }, word);
}

async function pickWord(page, word) {
  const point = await moveTo(page, await wordAt(page, word));
  await page.waitForTimeout(250);
  await page.mouse.dblclick(point.x, point.y);
  await page.waitForTimeout(400);
}

async function colour(page, hex) {
  await click(page, page.getByRole("button", { name: "Colour", exact: true }));
  await page.waitForTimeout(450);
  await click(page, page.getByRole("button", { name: hex, exact: true }));
  await page.waitForTimeout(700);
}

async function openEditor(page) {
  await click(page, page.getByRole("button", { name: "Settings" }).first());
  await page.waitForTimeout(500);
  await click(page, page.getByRole("button", { name: "Signatures" }).first());
  await page.waitForTimeout(900);
  await click(page, page.getByRole("button", { name: "New signature" }).first());
  await page.waitForTimeout(1100);
  const minimal = page.getByText("Minimal", { exact: true });
  await minimal.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await click(page, minimal);
  await page.waitForTimeout(1000);
}

export const scenes = {
  // Demo data: the `kite-whats-new` server (--url=http://localhost:3106).
  signature: {
    ready: "Q4 planning",
    timeout: 30000,
    warm: async (page) => {
      await openEditor(page);
      await page.getByRole("button", { name: /Your role · Company/ }).first().click();
      await page.getByRole("button", { name: "Colour", exact: true }).click();
      await page.waitForTimeout(1500);
    },
    run: async (page) => {
      await openEditor(page);
      await click(page, page.getByRole("button", { name: /Your role · Company/ }).first());
      await page.waitForTimeout(800);
      await pickWord(page, "Company");
      await colour(page, "#1a7f37");
      await click(page, page.getByRole("button", { name: "Bold", exact: true }).first());
      await page.waitForTimeout(700);
      await pickWord(page, "role");
      await colour(page, "#c9a227");
      // Let the preview show it.
      await moveTo(page, { x: 850, y: 330 });
      await page.waitForTimeout(2500);
    },
  },
};
