import { describe, expect, it } from "vitest";
import { threadFiles } from "@/lib/mail/attachments";
import type { Message, Thread } from "@/lib/mail/types";
import { placeBeside, placeProblem, spacePeople, type Space } from "@/lib/spaces";

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

describe("dragging spaces in the sidebar", () => {
  const space = (id: string, parentId: string | null, position = 0): Space => ({ id, parentId, name: id, color: "#000000", note: null, position, createdAt: "", threads: 0 });
  // acme > web > phase > copy (four levels), house (on its own), trip > flights
  const spaces = [
    space("acme", null, 0),
    space("web", "acme"),
    space("phase", "web"),
    space("copy", "phase"),
    space("house", null, 1),
    space("trip", null, 2),
    space("flights", "trip"),
  ];

  it("nests a space in another while the whole tree stays four levels deep", () => {
    expect(placeProblem(spaces, "house", "acme")).toBeNull();
    expect(placeProblem(spaces, "house", "phase")).toBeNull();
    expect(placeProblem(spaces, "house", "copy")).toMatch(/4 levels deep at most/);
    // trip brings its pocket: under phase that would be five levels.
    expect(placeProblem(spaces, "trip", "web")).toBeNull();
    expect(placeProblem(spaces, "trip", "phase")).toMatch(/trip and its pockets would go deeper/);
    expect(placeProblem(spaces, "web", "trip")).toBeNull();
    expect(placeProblem(spaces, "web", "flights")).toMatch(/deeper/);
    expect(placeProblem(spaces, "phase", "flights")).toBeNull();
  });

  it("never puts a space inside itself or its own pockets", () => {
    expect(placeProblem(spaces, "acme", "acme")).toMatch(/inside itself/);
    expect(placeProblem(spaces, "acme", "phase")).toMatch(/own pockets/);
    expect(placeProblem(spaces, "web", null)).toBeNull();
    expect(placeProblem(spaces, "gone", "acme")).toMatch(/isn't there/);
  });

  it("places a space beside another at that one's level", () => {
    expect(placeBeside(spaces, "trip", "acme", true)).toEqual({ parentId: null, order: ["trip", "acme", "house"] });
    expect(placeBeside(spaces, "acme", "trip", false)).toEqual({ parentId: null, order: ["house", "trip", "acme"] });
    // A pocket dropped beside a top-level space becomes a space of its own.
    expect(placeBeside(spaces, "flights", "house", false)).toEqual({ parentId: null, order: ["acme", "house", "flights", "trip"] });
    expect(placeBeside(spaces, "house", "web", false)).toEqual({ parentId: "acme", order: ["web", "house"] });
  });
});

describe("the toast after conversations go into a space", () => {
  it("names the full path, and says Moved when they left somewhere", async () => {
    const { putMessage } = await import("@/components/mail/app/use-spaces");
    expect(putMessage(1, false, "Acme / Website")).toBe("Added to Acme / Website");
    expect(putMessage(3, true, "Acme / Website")).toBe("Moved 3 conversations to Acme / Website");
  });
});
