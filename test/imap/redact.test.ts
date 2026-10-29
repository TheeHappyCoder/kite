import { describe, expect, it } from "vitest";
import { REMOVED, REMOVED_NOTE } from "@/lib/mail/redact";
import { replyDraft } from "@/lib/mail/compose";
import { outgoingFromDraft } from "@/server/drafts";
import { renderOutgoing } from "@/server/outgoing";
import { storedThreads, sync, testMailbox } from "./harness";

// Forward with parts removed: what goes on the wire, built from a message in the local copy.

const box = testMailbox();

describe("Forward with parts removed", () => {
  it("takes the phrases out of the HTML and text, and the To line when asked", async () => {
    await sync(box.account);
    const [t, message] = storedThreads(box.account)
      .flatMap((t) => t.messages.map((m) => [t, m] as const))
      .find(([, m]) => !m.draft && m.to.length > 0 && /\b[A-Za-z]{6,}\b/.test(m.snippet ?? ""))!;
    // Bodies come on demand: the send fetches the message the way it does for a forward of unopened mail.
    const word = message.snippet!.match(/\b[A-Za-z]{6,}\b/)![0];
    const draft = replyDraft({ mode: "forward", message, subject: t.subject, accountId: box.account.id, me: box.account.email, threadId: t.remoteId });

    const plain = await renderOutgoing(box.account, outgoingFromDraft(box.account, { ...draft, to: [{ email: "x@example.com" }] }));
    expect(plain.html).toMatch(new RegExp(word, "i"));
    expect(plain.text).toContain("To: ");

    const redact = { phrases: [word], images: [], hideTo: true };
    const cut = await renderOutgoing(box.account, outgoingFromDraft(box.account, { ...draft, to: [{ email: "x@example.com" }], quote: { ...draft.quote!, redact } }));
    expect(cut.html).not.toMatch(new RegExp(word, "i"));
    expect(cut.text).not.toMatch(new RegExp(word, "i"));
    expect(cut.html).toContain(REMOVED);
    expect(cut.text).toContain(REMOVED_NOTE);
    expect(cut.text).not.toContain("To: ");
  });
});
