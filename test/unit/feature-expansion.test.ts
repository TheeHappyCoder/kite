import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { bodyImageIds, bodyToHtml, bodyToEditorHtml, bodyToText } from "@/lib/mail/body";
import { expandSnippet } from "@/lib/mail/snippets";
import { extractDocumentText } from "@/server/document-text";

describe("composing", () => {
  it("expands a named recipient, escapes markup, and leaves unknown names visible", () => {
    expect(expandSnippet("Hi {first_name}", [{ name: "Jo **Smith", email: "jo@example.com" }])).toBe("Hi Jo");
    expect(expandSnippet("Hi {first_name}", [{ email: "jo@example.com" }])).toBe("Hi {first_name}");
    expect(expandSnippet("{email}", [{ email: "jo@example.com" }])).toBe("jo@example.com");
  });
  it("renders local images as CID email parts and local editor previews", () => {
    const id = "a".repeat(24), body = `Before\n![Chart](asset:${id})\nAfter`;
    expect(bodyImageIds(body)).toEqual([id]);
    expect(bodyToHtml(body)).toContain(`src="cid:${id}@kite"`);
    expect(bodyToEditorHtml(body)).toContain(`src="/api/assets/${id}"`);
    expect(bodyToText(body)).toBe("Before\nChart\nAfter");
    expect(bodyToHtml("![x](javascript:alert(1))")).not.toContain("<img");
  });
});

describe("local document extraction", () => {
  it("extracts a real PDF without AI or a provider", async () => {
    const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText("Uncommon invoice reference 839127", { font });
    expect(await extractDocumentText("invoice.pdf", Buffer.from(await pdf.save()))).toContain("839127");
  });
  it("reads plain documents and ignores unsupported formats", async () => {
    expect(await extractDocumentText("notes.txt", Buffer.from("Local only"))).toBe("Local only");
    expect(await extractDocumentText("old.doc", Buffer.from("Local only"))).toBe("");
  });
});
