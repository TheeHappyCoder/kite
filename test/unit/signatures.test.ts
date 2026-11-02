import { describe, expect, it } from "vitest";
import { compileHtml, compileText } from "@/lib/design/compile";
import { inlineToText } from "@/lib/design/inline";
import { Design } from "@/lib/design/spec";
import { Preferences, signatureFor, signatureIdFor } from "@/lib/settings";

const design = (text: string) => Design.parse({ blocks: [{ type: "text", text }] });
const html = (text: string) => compileHtml(design(text), { image: (s) => s });

describe("coloured text in designs", () => {
  it("colours one run inside a line", () => {
    const out = html("Kind regards\n{#1a7f37|**Stefan Potgieter**} RTT teacher");
    expect(out).toContain('<span style="color:#1a7f37"><strong>Stefan Potgieter</strong></span> RTT teacher');
    expect(out).toContain("Kind regards<br>");
  });

  it("gives a link inside a coloured run that colour", () => {
    const out = html("{#c9a227|[Geleenthede](https://hswilgers.co.za)}");
    expect(out).toContain('<a href="https://hswilgers.co.za" style="color:#c9a227;text-decoration:underline">Geleenthede</a>');
  });

  it("keeps a coloured label inside a link", () => {
    const out = html("[{#b42318|Red} and plain](https://a.example)");
    expect(out).toContain('<a href="https://a.example" style="color:#5b4ff0;text-decoration:underline"><span style="color:#b42318">Red</span> and plain</a>');
  });

  it("reads escapes literally", () => {
    expect(html("Tel \\*123\\# \\{not a colour\\}")).toContain("Tel *123# {not a colour}");
    expect(inlineToText("Dial \\*120\\*")).toBe("Dial *120*");
  });

  it("drops colours from the plain-text version", () => {
    expect(compileText(design("{#1a7f37|**Stefan**} · [site](https://hswilgers.co.za)"))).toBe("Stefan · site <https://hswilgers.co.za>");
  });

  it("never lets a colour carry anything but a hex value", () => {
    const out = html('{red;background:url(x)|hi} {#12345g|no}');
    expect(out).not.toContain("<span");
  });
});

describe("several signatures per account", () => {
  const sig = (id: string) => ({ id, name: id, design: design(id) });
  const set = { list: [sig("long"), sig("short")], newMail: "long", replies: "short" };

  it("keeps a signature saved by 0.2.7 as the account's only one", () => {
    const prefs = Preferences.parse({ signatures: { acc: design("Old") } });
    expect(prefs.signatures.acc).toMatchObject({ newMail: "main", replies: "main", list: [{ id: "main", name: "Signature" }] });
  });

  it("starts new mail and replies with their own pick", () => {
    expect(signatureIdFor(set, {})).toBe("long");
    expect(signatureIdFor(set, { threadId: "abc" })).toBe("short");
    expect(signatureIdFor(set, { quote: {} })).toBe("short");
    expect(signatureIdFor(set, { threadId: "abc", signatureId: "long" })).toBe("long");
  });

  it("adds none when switched off, unknown or not chosen", () => {
    const signatures = { acc: set };
    expect(signatureFor(signatures, "acc", { signature: false })).toBeUndefined();
    expect(signatureFor(signatures, "acc", { signature: true, signatureId: "gone" })).toBeUndefined();
    expect(signatureFor({ acc: { ...set, replies: null } }, "acc", { signature: true, threadId: "x" })).toBeUndefined();
    expect(signatureFor(signatures, "acc", { signature: true })?.blocks[0]).toMatchObject({ text: "long" });
  });
});
