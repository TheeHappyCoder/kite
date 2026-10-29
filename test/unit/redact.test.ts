import { describe, expect, it } from "vitest";
import { redactHtml, redactText, REMOVED, type Redactions } from "@/lib/mail/redact";

const r = (patch: Partial<Redactions>): Redactions => ({ phrases: [], images: [], hideTo: false, ...patch });

describe("redactHtml", () => {
  it("takes a phrase out of the text, leaving no trace of it", () => {
    const out = redactHtml("<p>Account ZA12 3456 is yours</p>", r({ phrases: ["ZA12 3456"] }));
    expect(out).not.toContain("ZA12");
    expect(out).not.toContain("3456");
    expect(out).toContain(REMOVED);
    expect(out).toContain("is yours");
  });

  it("matches across tags, case and line breaks", () => {
    const out = redactHtml("<p>Dear <b>Jane</b>\n  smith, hello</p>", r({ phrases: ["jane Smith"] }));
    expect(out).not.toMatch(/jane|smith/i);
    expect(out).toContain("<b>");
    expect(out.match(new RegExp(REMOVED, "g"))).toHaveLength(1);
    expect(out).toContain(", hello");
  });

  it("matches text written with entities and keeps the other entities as they were", () => {
    const out = redactHtml("<p>Tom&nbsp;&amp;&nbsp;Jerry &lt;3</p>", r({ phrases: ["Tom & Jerry"] }));
    expect(out).not.toMatch(/Tom|Jerry/);
    expect(out).toContain("&lt;3");
  });

  it("drops a link whose address names the phrase and rewrites other attributes", () => {
    const out = redactHtml('<a href="mailto:jane@acme.com" title="Mail jane@acme.com">jane@acme.com</a><img alt="jane@acme.com" src="x.png">', r({ phrases: ["jane@acme.com"] }));
    expect(out).not.toContain("jane@acme.com");
    expect(out).not.toContain("href=");
    expect(out).toContain('title="Mail █████"');
    expect(out).toContain("<img");
  });

  it("takes pictures out by their place", () => {
    const out = redactHtml('<img src="cid:a"><p>x</p><img src="cid:b"><img src="cid:c">', r({ images: [1] }));
    expect(out).toContain("cid:a");
    expect(out).not.toContain("cid:b");
    expect(out).toContain("cid:c");
    expect(out).toContain("Picture removed");
  });

  it("leaves styles and the head alone", () => {
    const html = "<html><head><title>Jane</title><style>.jane{color:red}</style></head><body>Jane</body></html>";
    const out = redactHtml(html, r({ phrases: ["jane"] }));
    expect(out).toContain("<title>Jane</title>");
    expect(out).toContain(".jane{color:red}");
    expect(out).toContain(`<body><span`);
  });

  it("marks pictures and removed parts for the preview", () => {
    const out = redactHtml('<p>a b</p><img src="x"><img src="y">', r({ phrases: ["b"], images: [0] }), { mark: true });
    expect(out).toContain('data-kite-removed="0"');
    expect(out).toContain('data-kite-img="0" data-kite-removed-img');
    expect(out).toContain('<img data-kite-img="1"');
  });

  it("changes nothing with nothing removed", () => {
    expect(redactHtml("<p>Hi &amp; bye</p>", r({}))).toBe("<p>Hi &amp; bye</p>");
  });
});

describe("redactText", () => {
  it("takes every phrase out, longest first", () => {
    expect(redactText("Jane Smith wrote to Jane", r({ phrases: ["Jane", "Jane Smith"] }))).toBe(`${REMOVED} wrote to ${REMOVED}`);
  });
});
