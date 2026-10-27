import { describe, expect, it } from "vitest";
import { searchContacts } from "@/server/contacts";
import { sync, testMailbox } from "./harness";

// Address suggestions from the local copy: compose's ranking, and a search's `from:` / `to:`
// (people who wrote to you, and people you wrote to). The fixtures: Thandi and Nomsa (the invites'
// organiser) write and are written to; Lerato and Sipho Plumbing only write.

const box = testMailbox();

describe("contacts", () => {
  it("suggests people from synced mail, never your own address", async () => {
    await sync(box.account);
    expect(searchContacts("thandi").map((c) => c.email)).toEqual(["thandi@company.co.za"]);
    expect(searchContacts(box.account.email.split("@")[0]).some((c) => c.email === box.account.email)).toBe(false);
  });

  it("puts people you write to first for compose", () => {
    const order = searchContacts("co.za").map((c) => c.email);
    expect(order.slice(0, 2).sort()).toEqual(["nomsa@company.co.za", "thandi@company.co.za"]);
    expect(order).toContain("lerato@mokoena-legal.co.za");
  });

  it("from: offers only people who wrote to you", () => {
    const from = searchContacts("co.za", 8, "from").map((c) => c.email);
    expect(from).toEqual(expect.arrayContaining(["thandi@company.co.za", "lerato@mokoena-legal.co.za", "accounts@siphoplumbing.co.za"]));
  });

  it("to: offers only people you wrote to", () => {
    expect(searchContacts("co.za", 8, "to").map((c) => c.email).sort()).toEqual(["nomsa@company.co.za", "thandi@company.co.za"]);
    expect(searchContacts("lerato", 8, "to")).toEqual([]);
  });

  it("matches names as well as addresses", () => {
    expect(searchContacts("nkosi", 8, "from").map((c) => c.name)).toEqual(["Thandi Nkosi"]);
  });
});
