// This release's clips, one scene each. They last one release: empty `scenes` when the next one starts.
// `ready`: text that says Kite has what the scene needs. `run`: what the pointer does while it records.
// `warm` (optional): loads what `run` opens, before recording, so the clip doesn't show a dev server compiling.
import { click, moveTo } from "./kit.mjs";

async function openGallery(page) {
  await click(page, page.getByRole("button", { name: "Settings" }).first());
  await page.waitForTimeout(500);
  await click(page, page.getByRole("button", { name: "Signatures" }).first());
  await page.waitForTimeout(900);
  await click(page, page.getByRole("button", { name: "New signature" }).first());
  await page.waitForTimeout(1400);
}

/** Scrolls the gallery's scroller down by `dy`, in small steps so it glides. */
async function glide(page, dy) {
  await moveTo(page, { x: 290, y: 430 });
  for (let i = 0; i < 20; i++) {
    await page.mouse.wheel(0, dy / 20);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(700);
}

async function palette(page, name) {
  await click(page, page.getByRole("button", { name, exact: true }).first());
  await page.waitForTimeout(1100);
}

export const scenes = {
  // Demo data: the `kite-whats-new` server (--url=http://localhost:3106).
  signatures: {
    ready: "Q4 planning",
    timeout: 30000,
    warm: async (page) => {
      await openGallery(page);
      await page.getByText("Studio", { exact: true }).first().click();
      await page.waitForTimeout(1500);
    },
    run: async (page) => {
      await openGallery(page);
      await glide(page, 520);
      await glide(page, -520);
      await click(page, page.getByText("Studio", { exact: true }).first());
      await page.waitForTimeout(1300);
      await palette(page, "Moss");
      await palette(page, "Plum");
      await palette(page, "Clay");
      await click(page, page.getByText("Serif", { exact: true }).first());
      await page.waitForTimeout(1600);
    },
  },
};
