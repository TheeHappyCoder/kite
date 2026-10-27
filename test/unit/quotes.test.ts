import { describe, expect, it } from "vitest";
import { freshPreview, htmlToText, parentMessageId, splitMessage, snippetFresh } from "@/lib/mail/quotes";

// The kinds of mail the reader folds: each fixture names what its split must find. The HTML split
// is lossless by construction (fresh + signature + quoted === html), so every fixture checks that too.

type Fixture = { name: string; html: string; fresh: string; signature?: boolean; quoted?: boolean; kind?: "reply" | "forward" };

const FIXTURES: Fixture[] = [
  {
    name: "Gmail reply with signature",
    html:
      '<div dir="ltr">Thanks, looking now.<br clear="all"><div><br></div><span class="gmail_signature_prefix">-- </span><br><div dir="ltr" class="gmail_signature">Kite Test<br>082 555 0101</div></div><br>' +
      '<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Tue, 13 Oct 2026 at 09:12, Thandi Nkosi &lt;thandi@company.co.za&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex">Hi, the Q3 numbers are attached.</blockquote></div>',
    fresh: "Thanks, looking now.",
    signature: true,
    quoted: true,
    kind: "reply",
  },
  {
    name: "Gmail forward",
    html:
      '<div dir="ltr">FYI, see below.<br><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: <strong>Shop</strong> &lt;orders@shop.example&gt;<br>Subject: Order 7781 shipped<br></div><br>Your order is on the way.</div></div>',
    fresh: "FYI, see below.",
    quoted: true,
    kind: "forward",
  },
  {
    name: "Outlook web",
    html:
      '<div style="font-family:Calibri">Sounds good, Friday works.</div><div id="appendonsend"></div><hr style="display:inline-block;width:98%" tabindex="-1">' +
      '<div id="divRplyFwdMsg" dir="ltr"><font face="Calibri"><b>From:</b> Lerato &lt;lerato@mokoena-legal.co.za&gt;<br><b>Sent:</b> Tuesday, 13 October 2026 10:00<br><b>Subject:</b> Contract draft</font><div>&nbsp;</div></div><div>Here is the draft we discussed.</div>',
    fresh: "Sounds good, Friday works.",
    quoted: true,
    kind: "reply",
  },
  {
    name: "Outlook desktop",
    html:
      '<html><body><div class="WordSection1"><p class="MsoNormal">Approved, go ahead.<o:p></o:p></p><p class="MsoNormal"><o:p>&nbsp;</o:p></p>' +
      '<div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm"><p class="MsoNormal"><b>From:</b> Thandi Nkosi &lt;thandi@company.co.za&gt;<br><b>Sent:</b> 13 October 2026 09:12<br><b>To:</b> Kite<br><b>Subject:</b> Budget</p></div></div>' +
      '<p class="MsoNormal">Can you approve the budget?</p></div></body></html>',
    fresh: "Approved, go ahead.",
    quoted: true,
    kind: "reply",
  },
  {
    name: "Outlook mobile",
    html:
      '<div dir="auto">On my way.</div><div dir="auto"><br></div><div id="ms-outlook-mobile-signature" dir="auto">Get <a href="https://aka.ms/o0ukef">Outlook for Android</a></div>' +
      '<hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg" dir="ltr"><b>From:</b> Sipho &lt;sipho@example.org&gt;<br><b>Sent:</b> Tuesday<br><b>Subject:</b> Lunch</div><div>Where are you?</div>',
    fresh: "On my way.",
    signature: true,
    quoted: true,
    kind: "reply",
  },
  {
    name: "Apple Mail",
    html:
      '<html><body dir="auto"><div>See you then.</div><div><br></div><div id="AppleMailSignature">Sent from my iPhone</div><div><br>' +
      'On 13 Oct 2026, at 09:12, Thandi Nkosi &lt;thandi@company.co.za&gt; wrote:<br><br></div><blockquote type="cite"><div>Lunch at one?</div></blockquote></body></html>',
    fresh: "See you then.",
    signature: true,
    quoted: true,
    kind: "reply",
  },
  {
    name: "inline reply stays whole",
    html: '<div>My answers below.</div><blockquote type="cite"><div>Question one?</div></blockquote><div>Yes.</div><blockquote type="cite"><div>Question two?</div></blockquote><div>No.</div>',
    fresh: "My answers below.",
  },
  {
    name: "newsletter stays whole",
    html: '<html><head><style>p{color:#333}</style></head><body><table><tr><td><h1>Weekly digest</h1><p>Ten things worth reading.</p><hr><p>From: the editors</p></td></tr></table></body></html>',
    fresh: "Weekly digest",
  },
];

describe("splitMessage (HTML)", () => {
  for (const fixture of FIXTURES) {
    it(fixture.name, () => {
      const { html } = splitMessage({ html: fixture.html, body: [] });
      expect(html).toBeDefined();
      const split = html!;
      expect(split.fresh + split.signature + split.quoted).toBe(fixture.html);
      expect(htmlToText(split.fresh)).toContain(fixture.fresh);
      expect(!!split.signature).toBe(!!fixture.signature);
      expect(!!split.quoted).toBe(!!fixture.quoted);
      if (fixture.kind) expect(split.kind).toBe(fixture.kind);
      if (!fixture.signature && !fixture.quoted) expect(split.fresh).toBe(fixture.html);
    });
  }

  it("keeps a message whose only text is quoted", () => {
    const html = '<div class="gmail_quote">On Tue, A wrote:<blockquote class="gmail_quote">Hello</blockquote></div>';
    const split = splitMessage({ html, body: [] }).html!;
    expect(split.fresh).toBe(html);
    expect(split.quoted).toBe("");
  });
});

describe("splitMessage (plain text)", () => {
  const split = (text: string) => splitMessage({ body: text.split(/\n{2,}/) }).text;

  it("cuts an attribution and > lines", () => {
    const text = split("Thanks, looking now.\n\nOn Tue, 13 Oct 2026 at 09:12, Thandi Nkosi <thandi@company.co.za> wrote:\n> Hi, the Q3 numbers are attached.\n> Can you check page 2?");
    expect(text.fresh).toBe("Thanks, looking now.");
    expect(text.quoted).toContain("> Hi, the Q3 numbers");
    expect(text.attribution).toMatch(/^On Tue/);
    expect(text.kind).toBe("reply");
  });

  it("finds the signature after -- and Sent from my iPhone", () => {
    expect(split("See you at one.\n\n-- \nKite Test\n082 555 0101")).toMatchObject({ fresh: "See you at one.", signature: "-- \nKite Test\n082 555 0101" });
    expect(split("On my way.\n\nSent from my iPhone")).toMatchObject({ fresh: "On my way.", signature: "Sent from my iPhone" });
  });

  it("finds Outlook's From / Sent / Subject block", () => {
    const text = split("Approved.\n\nFrom: Thandi Nkosi\nSent: 13 October 2026 09:12\nTo: Kite\nSubject: Budget\n\nCan you approve?");
    expect(text.fresh).toBe("Approved.");
    expect(text.attribution).toContain("From: Thandi Nkosi");
  });

  it("finds forwards", () => {
    const text = split("FYI.\n\n---------- Forwarded message ---------\nFrom: Shop <orders@shop.example>\n\nYour order is on the way.");
    expect(text.kind).toBe("forward");
    expect(text.fresh).toBe("FYI.");
  });

  it("keeps inline replies and sentences that only look like attributions", () => {
    expect(split("> Question one?\nYes.\n> Question two?\nNo.").quoted).toBe("");
    expect(split("On Monday Sam wrote: the plan is fine.\n\nLet's go.").quoted).toBe("");
  });

  it("is lossless for each part", () => {
    const original = "Fine by me.\n\n-- \nKite\n\nOn Tue, A <a@b.c> wrote:\n> old";
    const text = split(original);
    for (const part of [text.fresh, text.signature, text.quoted]) expect(original.replace(/\n{2,}/g, "\n\n")).toContain(part);
  });
});

describe("previews and ids", () => {
  it("previews only the fresh text", () => {
    expect(freshPreview({ body: ["Thanks!", "On Tue, 13 Oct 2026, A <a@b.c> wrote:\n> old"] })).toBe("Thanks!");
  });

  it("cuts Gmail snippets at the reply header", () => {
    expect(snippetFresh("Thanks, looking now. On Tue, 13 Oct 2026 at 09:12 Thandi wrote: Hi")).toBe("Thanks, looking now.");
    expect(snippetFresh("Nothing quoted here")).toBe("Nothing quoted here");
  });

  it("reads the parent from In-Reply-To, else the end of References", () => {
    expect(parentMessageId({ inReplyTo: "<b@x>", references: "<a@x> <b@x>" })).toBe("b@x");
    expect(parentMessageId({ references: "<a@x>  <b@x>" })).toBe("b@x");
    expect(parentMessageId({})).toBeUndefined();
  });
});
