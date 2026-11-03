import { describe, expect, it } from "vitest";
import { DEFAULT_BUTTONS, DIVIDER, TOOLBAR_SIZES, fitToolbar } from "@/lib/buttons";

const bar = DEFAULT_BUTTONS.toolbar; // archive, trash | replyAll, forward  ·  files, star, chat, people, screenshot
const all = () => true;
const step = TOOLBAR_SIZES.button + TOOLBAR_SIZES.gap;

describe("fitting the reader toolbar", () => {
  it("keeps every button the user placed while there's room", () => {
    expect(fitToolbar(bar, all, 2000)).toEqual({ left: bar.left, right: bar.right });
  });

  it("folds from the end of the right group first, one at a time", () => {
    const full = 9 * step + TOOLBAR_SIZES.divider + TOOLBAR_SIZES.gap;
    expect(fitToolbar(bar, all, full - 1).right).toEqual(["files", "star", "chat", "people"]);
    expect(fitToolbar(bar, all, full - 1).left).toEqual(bar.left);
  });

  it("then the left group past its first divider, never below the old minimum", () => {
    expect(fitToolbar(bar, all, 0)).toEqual({ left: ["archive", "trash"], right: ["files", "star"] });
    const one = fitToolbar(bar, all, 5 * step + TOOLBAR_SIZES.divider + TOOLBAR_SIZES.gap);
    expect(one).toEqual({ left: ["archive", "trash", DIVIDER, "replyAll"], right: ["files", "star"] });
  });

  it("gives no room to actions that don't apply to this conversation", () => {
    const fit = fitToolbar(bar, (a) => a !== "files", 2000);
    expect(fit.right).toEqual(["star", "chat", "people", "screenshot"]);
  });
});
