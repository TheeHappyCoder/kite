import { describe, expect, it } from "vitest";
import { createLabel, deleteLabel, listStoredLabels, renameLabel } from "@/server/labels";
import { LabelError } from "@/server/mail/errors";
import { serverCopies, sync, testMailbox, thread } from "./harness";

// Gmail over IMAP: the user's labels are Gmail labels (tags), made, renamed and deleted as IMAP
// folders. The test server plays Gmail: a renamed or deleted label folder renames or removes the
// label on every message (scripts/imap-test-server.mjs).

const box = testMailbox({ gmail: true });

const labelNamed = (name: string) => {
  const found = listStoredLabels(box.account.id).find((l) => l.name === name);
  if (!found) throw new Error(`No label called "${name}"`);
  return found;
};
const hasLabel = (subject: string, id: string) => thread(box.account, subject).rowLabels.includes(id);
const ALL = "[Gmail]/All Mail";

describe("Gmail labels over IMAP", () => {
  it("makes a label", async () => {
    await sync(box.account);
    const made = await createLabel(box.account, { name: "Travel", kind: "tag" });
    expect(made).toMatchObject({ name: "Travel", kind: "tag" });
    expect(labelNamed("Travel").id).toBe(made.id);
    await expect(createLabel(box.account, { name: "Travel", kind: "tag" })).rejects.toThrow(LabelError);
  });

  it("renames a label on its mail, nested labels too", async () => {
    const before = labelNamed("Receipts");
    const renamed = await renameLabel(box.account, before.id, "Purchases");
    expect(hasLabel("Order 7781 shipped", renamed.id)).toBe(true);
    expect(hasLabel("Invoice INV-2041", renamed.id)).toBe(true);
    expect(hasLabel("Order 7781 shipped", before.id)).toBe(false);
    expect((await serverCopies(box, [ALL])).get("order-7781")?.[0].labels).toContain("Purchases");

    await renameLabel(box.account, labelNamed("Work").id, "Office");
    expect(hasLabel("Contract draft", labelNamed("Office/Clients").id)).toBe(true);
    expect((await serverCopies(box, [ALL])).get("contract-1")?.[0].labels).toContain("Office/Clients");

    // The next pass reads the same labels back from the server.
    await sync(box.account);
    expect(hasLabel("Order 7781 shipped", labelNamed("Purchases").id)).toBe(true);
    expect(hasLabel("Contract draft", labelNamed("Office/Clients").id)).toBe(true);
  });

  it("deletes a label, the mail staying in All Mail", async () => {
    const label = labelNamed("Purchases");
    await deleteLabel(box.account, label.id);
    expect(hasLabel("Order 7781 shipped", label.id)).toBe(false);
    expect((await serverCopies(box, [ALL])).get("order-7781")?.[0].labels).not.toContain("Purchases");
    await sync(box.account);
    expect(thread(box.account, "Order 7781 shipped")).toBeTruthy();
    expect(listStoredLabels(box.account.id).some((l) => l.name === "Purchases")).toBe(false);
  });
});
