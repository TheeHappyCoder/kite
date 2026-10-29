import { describe, expect, it } from "vitest";
import { parseReleaseNotes } from "@/lib/release-notes";

describe("parseReleaseNotes", () => {
  it("reads features, their pictures, the intro and the smaller fixes", () => {
    const notes = parseReleaseNotes(
      ["Said first.", "- A fix", "## Print to Kite", "media: https://example.com/print.webp", "A printer.", "- One point", "## Send back", "media: http://example.com/no.gif", "Reply with it."].join("\n"),
    );
    expect(notes.intro).toEqual(["Said first."]);
    expect(notes.polish).toEqual(["A fix"]);
    expect(notes.features).toEqual([
      { title: "Print to Kite", media: "https://example.com/print.webp", lines: [{ bullet: false, text: "A printer." }, { bullet: true, text: "One point" }] },
      { title: "Send back", media: null, lines: [{ bullet: false, text: "Reply with it." }] },
    ]);
  });

  it("leaves plain notes as a list, with no features", () => {
    const notes = parseReleaseNotes("- One\n- Two");
    expect(notes.features).toEqual([]);
    expect(notes.polish).toEqual(["One", "Two"]);
  });

  it("refuses addresses that leave Kite without https", () => {
    expect(parseReleaseNotes("## A\nmedia: //evil.example/x.gif").features[0].media).toBeNull();
    expect(parseReleaseNotes("## A\nmedia: /api/dev/shots/x.webp").features[0].media).toBe("/api/dev/shots/x.webp");
  });
});
