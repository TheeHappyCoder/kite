// This release's clips, one scene each. They last one release: empty `scenes` when the next one starts.
// `ready`: text that says Kite has what the scene needs. `run`: what the pointer does while it records.
// `warm` (optional): loads what `run` opens, before recording, so the clip doesn't show a dev server compiling.
import { click, threadRow } from "./kit.mjs";

const SAMPLE = "Q4 planning";

async function reply(page) {
  await click(page, threadRow(page, SAMPLE));
  await page.waitForTimeout(800);
  await page.keyboard.press("r");
  await page.waitForTimeout(500);
  await click(page, page.getByRole("button", { name: "Open in full compose" }));
  await page.waitForTimeout(900);
}

export const scenes = {
  // Demo data: the `kite-whats-new` server (--url=http://localhost:3106).
  compose: {
    ready: SAMPLE,
    timeout: 30000,
    warm: async (page) => {
      await reply(page);
      await click(page, page.getByRole("button", { name: "Full page" }));
      await page.waitForTimeout(3000);
      // Full page is remembered: back to a window, so the clip can show the step.
      await click(page, page.getByRole("button", { name: "Make it a window" }));
      await page.waitForTimeout(500);
    },
    run: async (page) => {
      await reply(page);
      await page.keyboard.type("Thanks, that all works for me. ", { delay: 45 });
      await page.waitForTimeout(500);
      await click(page, page.getByRole("button", { name: "Full page" }));
      await page.waitForTimeout(1300);
      await click(page, page.locator('[contenteditable="true"]').last());
      await page.keyboard.press("Control+End");
      await page.keyboard.type("I'll send the numbers over by Friday.", { delay: 45 });
      await page.waitForTimeout(1600);
    },
  },
};
