import { describe, expect, it } from "vitest";
import { maskLayout, maskText, rectFrom, screenshotName } from "@/lib/screenshot/annotations";

/** A white box with dark "ink" rectangles painted in. */
function picture(w: number, h: number, ink: { x: number; y: number; w: number; h: number }[]) {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (const r of ink) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const i = (y * w + x) * 4;
        data[i] = 20;
        data[i + 1] = 20;
        data[i + 2] = 30;
      }
    }
  }
  return data;
}

describe("maskLayout", () => {
  it("finds lines and words, with the background and ink colours", () => {
    // Line 1: "Hello world" (two words, letters 1px apart); line 2: one word.
    const letters = (x: number, n: number, y: number) => Array.from({ length: n }, (_, i) => ({ x: x + i * 7, y, w: 6, h: 12 }));
    const data = picture(200, 60, [...letters(5, 5, 4), ...letters(60, 5, 4), ...letters(5, 3, 30)]);
    const layout = maskLayout(data, 200, 60, 100, 50);
    expect(layout.bg).toBe("rgb(255, 255, 255)");
    expect(layout.ink).toBe("rgb(20, 20, 30)");
    expect(layout.lines).toHaveLength(2);
    expect(layout.lines[0]).toEqual({ y: 54, h: 12, words: [{ x: 105, w: 34 }, { x: 160, w: 34 }] });
    expect(layout.lines[1].words).toEqual([{ x: 105, w: 20 }]);
  });

  it("covers a picture in rows of text height", () => {
    const layout = maskLayout(picture(100, 100, [{ x: 10, y: 0, w: 80, h: 100 }]), 100, 100, 0, 0, 40);
    expect(layout.lines.length).toBeGreaterThan(3);
    expect(layout.lines.every((l) => l.h <= 20 && l.words[0].x === 10 && l.words[0].w === 80)).toBe(true);
  });

  it("finds nothing on a blank box", () => {
    expect(maskLayout(picture(50, 20, []), 50, 20, 0, 0).lines).toEqual([]);
  });
});

describe("maskText", () => {
  it("repeats the characters in order", () => {
    expect(maskText("x#", 5)).toBe("x#x#x");
    expect(maskText("•", 3)).toBe("•••");
    expect(maskText("🙈a", 3)).toBe("🙈a🙈");
    expect(maskText("", 3)).toBe("");
  });
});

describe("helpers", () => {
  it("makes a rectangle from any two corners", () => {
    expect(rectFrom({ x: 10, y: 20 }, { x: 2, y: 5 })).toEqual({ x: 2, y: 5, w: 8, h: 15 });
  });
  it("names the file after the subject", () => {
    expect(screenshotName('Re: "Q3"/plan?', new Date(2026, 9, 23))).toBe("Re Q3 plan - 2026-10-23.png");
  });
});
