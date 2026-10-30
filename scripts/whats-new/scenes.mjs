// This release's clips, one scene each. They last one release: empty `scenes` when the next one starts.
// `ready`: text that says Kite has what the scene needs. `run`: what the pointer does while it records.
import { click, moveTo, threadRow } from "./kit.mjs";

export const scenes = {
  // Demo data: `pnpm dev:scratch --data=data-scratch-demo --port=3106`.
  list: {
    ready: "Q4 planning",
    run: async (page) => {
      await page.waitForTimeout(600);
      // Down the list: unread rows, account colours, the file cards.
      for (const subject of ["Q4 planning", "Contract draft v3", "Booking confirmed"]) {
        const row = threadRow(page, subject);
        if (await row.count()) {
          await moveTo(page, row);
          await page.waitForTimeout(650);
        }
      }
      // The tabs, then search growing out of its icon.
      await page.keyboard.press("2");
      await page.waitForTimeout(900);
      await page.keyboard.press("1");
      await page.waitForTimeout(900);
      await page.keyboard.press("/");
      await page.waitForTimeout(500);
      await page.keyboard.type("contract", { delay: 70 });
      await page.waitForTimeout(1500);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(800);
    },
  },
  // A real mailbox of made-up mail: whats-new/sample-mailbox.mjs on the `kite-samples` server (--url=http://localhost:3107).
  previews: {
    ready: "October numbers and the handover",
    timeout: 20000,
    run: async (page) => {
      await click(page, threadRow(page, "October numbers and the handover"));
      await page.waitForTimeout(1000);
      await click(page, page.getByRole("button", { name: /^\d+ files$/ }));
      await page.waitForTimeout(800);
      const drawer = page.getByRole("complementary", { name: "Files in this conversation" });
      const open = async (name) => {
        await click(page, drawer.getByRole("button", { name }).first());
        await page.getByRole("dialog").last().waitFor();
      };
      const close = async () => {
        await click(page, page.getByRole("dialog").last().getByRole("button", { name: "Close" }));
        await page.waitForTimeout(500);
      };

      await open(/Budget/);
      await page.getByRole("button", { name: "Suppliers" }).waitFor();
      await page.waitForTimeout(1200);
      await click(page, page.getByRole("button", { name: "Suppliers" }));
      await page.waitForTimeout(1100);
      await close();

      await open(/Handover/);
      await page.locator('[role=dialog] iframe').waitFor();
      await page.waitForTimeout(1500);
      await moveTo(page, { x: 640, y: 450 });
      await page.mouse.wheel(0, 260);
      await page.waitForTimeout(1200);
      await close();

      await open(/Invoice/);
      await page.waitForTimeout(2200);
      await close();

      await open(/Walkthrough/);
      const video = page.locator("video");
      await video.waitFor();
      await page.waitForTimeout(500);
      await moveTo(page, video);
      await video.evaluate((v) => {
        v.muted = true;
        return v.play();
      });
      await page.waitForTimeout(2600);
      await close();
    },
  },
};
