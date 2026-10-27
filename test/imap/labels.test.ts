import { describe, expect, it } from "vitest";
import { createLabel, deleteLabel, listStoredLabels, renameLabel } from "@/server/labels";
import { LabelError } from "@/server/mail/errors";
import { serverCopies, sync, testMailbox, thread } from "./harness";

// Making, renaming and deleting an IMAP account's own folders and tags from Kite, against the
// test server: the server changes, the stored list and the stored mail follow at once, and the
// next sync keeps it all where it now is.

const box = testMailbox();

const labelNamed = (name: string) => {
  const found = listStoredLabels(box.account.id).find((l) => l.name === name);
  if (!found) throw new Error(`No label called "${name}"`);
  return found;
};
const hasLabel = (subject: string, id: string) => thread(box.account, subject).rowLabels.includes(id);

describe("IMAP folders and tags", () => {
  it("makes folders, nested too", async () => {
    await sync(box.account);
    await createLabel(box.account, { name: "Projects", kind: "folder" });
    const made = await createLabel(box.account, { name: "Projects/2026", kind: "folder" });
    expect(made).toMatchObject({ name: "Projects/2026", kind: "folder" });
    expect(box.server.imap.getMailbox("Projects/2026")).toBeTruthy();
    expect(labelNamed("Projects/2026").id).toBe(made.id);
  });

  it("refuses names that are taken or are mailboxes", async () => {
    await expect(createLabel(box.account, { name: "Receipts", kind: "folder" })).rejects.toThrow(LabelError);
    await expect(createLabel(box.account, { name: "Trash", kind: "folder" })).rejects.toThrow(/mailboxes/);
    await expect(createLabel(box.account, { name: "Work//Old", kind: "folder" })).rejects.toThrow(LabelError);
    await expect(createLabel(box.account, { name: "Later", kind: "tag" })).rejects.toThrow(LabelError);
  });

  it("renames a folder, its mail following it", async () => {
    const before = labelNamed("Receipts");
    const renamed = await renameLabel(box.account, before.id, "Purchases");
    expect(renamed.name).toBe("Purchases");
    expect(box.server.imap.getMailbox("Purchases")?.messages).toHaveLength(1);
    expect(hasLabel("Order 7781 shipped", renamed.id)).toBe(true);
    expect(hasLabel("Order 7781 shipped", before.id)).toBe(false);
    // The next pass finds the mail in the renamed folder instead of dropping it.
    await sync(box.account);
    expect(hasLabel("Order 7781 shipped", labelNamed("Purchases").id)).toBe(true);
  });

  it("moves the folders inside one along with it", async () => {
    const child = labelNamed("Work/Clients");
    await renameLabel(box.account, labelNamed("Work").id, "Office");
    const moved = labelNamed("Office/Clients");
    expect(moved.id).not.toBe(child.id);
    expect(hasLabel("Retainer renewal", moved.id)).toBe(true);
    expect(listStoredLabels(box.account.id).some((l) => l.name.startsWith("Work"))).toBe(false);
    await sync(box.account);
    expect(hasLabel("Retainer renewal", labelNamed("Office/Clients").id)).toBe(true);
  });

  it("won't delete a folder that holds mail or other folders", async () => {
    await expect(deleteLabel(box.account, labelNamed("Purchases").id)).rejects.toThrow(/still holds a message/);
    await expect(deleteLabel(box.account, labelNamed("Projects").id)).rejects.toThrow(/folders inside/);
    expect(box.server.imap.getMailbox("Purchases")?.messages).toHaveLength(1);
  });

  it("deletes an empty folder", async () => {
    await deleteLabel(box.account, labelNamed("Projects/2026").id);
    expect(box.server.imap.getMailbox("Projects/2026")).toBeFalsy();
    expect(listStoredLabels(box.account.id).some((l) => l.name === "Projects/2026")).toBe(false);
  });

  it("renames a tag on every message carrying it", async () => {
    const before = labelNamed("Invoices");
    const renamed = await renameLabel(box.account, before.id, "Bills");
    expect(hasLabel("Invoice INV-2041", renamed.id)).toBe(true);
    expect(hasLabel("Invoice INV-2041", before.id)).toBe(false);
    const flags = (await serverCopies(box, ["INBOX"])).get("inv-2041")?.[0].flags;
    expect(flags).toContain("Bills");
    expect(flags).not.toContain("$Invoices");
    await sync(box.account);
    expect(hasLabel("Invoice INV-2041", labelNamed("Bills").id)).toBe(true);
  });

  it("deletes a tag from every message, keeping the mail", async () => {
    const tag = labelNamed("Bills");
    await deleteLabel(box.account, tag.id);
    expect(hasLabel("Invoice INV-2041", tag.id)).toBe(false);
    expect((await serverCopies(box, ["INBOX"])).get("inv-2041")?.[0].flags).not.toContain("Bills");
    await sync(box.account);
    expect(thread(box.account, "Invoice INV-2041").rowLabels).toContain("INBOX");
    expect(listStoredLabels(box.account.id).some((l) => l.name === "Bills")).toBe(false);
  });
});
