import { describe, expect, it } from "vitest";
import { threadFiles } from "@/lib/mail/attachments";
import type { Message, Thread } from "@/lib/mail/types";
import { spacePeople } from "@/lib/spaces";

const message = (id: string, from: string, to: string[], date: string, extra: Partial<Message> = {}): Message => ({
  id,
  from: { name: from.split("@")[0] === "me" ? "You" : from.split("@")[0].replace(/^./, (c) => c.toUpperCase()), email: from },
  to: to.map((email) => ({ name: email, email })),
  date,
  body: [],
  ...extra,
});

const thread = (id: string, messages: Message[]): Thread => ({
  id,
  accountId: "a",
  remoteId: id,
  subject: `About ${id}`,
  mailbox: "inbox",
  category: "important",
  unread: false,
  starred: false,
  messages,
});

describe("a space's Files and People tabs", () => {
  const threads = [
    thread("a:1", [
      message("m1", "ann@acme.test", ["me@kite.test"], "2026-10-01T09:00:00Z", {
        attachments: [
          { name: "quote.pdf", size: "80 KB", kind: "pdf", partId: "2" },
          { name: "logo.png", size: "2 KB", kind: "image", partId: "3", inline: true },
        ],
      }),
      message("m2", "me@kite.test", ["ann@acme.test", "bob@acme.test"], "2026-10-03T09:00:00Z"),
    ]),
    thread("a:2", [
      message("m3", "ann@acme.test", ["me@kite.test"], "2026-10-05T09:00:00Z", { attachments: [{ name: "plan.docx", size: "20 KB", kind: "doc", partId: "2" }] }),
      message("m4", "ann@acme.test", ["me@kite.test"], "2026-10-06T09:00:00Z", { draft: true, to: [{ name: "", email: "draft@acme.test" }] }),
    ]),
  ];

  it("lists the files, newest first, without inline images", () => {
    expect(threadFiles(threads).map((f) => [f.name, f.threadId, f.messageId])).toEqual([
      ["plan.docx", "a:2", "m3"],
      ["quote.pdf", "a:1", "m1"],
    ]);
  });

  it("counts each person's conversations once and leaves you and drafts out", () => {
    expect(spacePeople(threads, new Set(["me@kite.test"]))).toEqual([
      { email: "ann@acme.test", name: "Ann", conversations: 2, last: "2026-10-05T09:00:00Z" },
      { email: "bob@acme.test", name: "", conversations: 1, last: "2026-10-03T09:00:00Z" },
    ]);
  });
});
