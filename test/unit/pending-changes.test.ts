import { describe, expect, it } from "vitest";
import { createMailChanges } from "@/lib/mail/pending-changes";

describe("mail list snapshots", () => {
  it("rejects a stale list arriving during or after a read/delete operation", () => {
    const changes = createMailChanges();
    const before = changes.snapshot();
    expect(before()).toBe(true);
    const finish = changes.begin();
    const during = changes.snapshot();
    expect(before()).toBe(false);
    expect(during()).toBe(false);
    finish();
    expect(before()).toBe(false);
    expect(during()).toBe(false);
    expect(changes.snapshot()()).toBe(true);
  });

  it("waits for overlapping writes, including failure cleanup", () => {
    const changes = createMailChanges();
    const first = changes.begin();
    const second = changes.begin();
    first();
    first();
    expect(changes.snapshot()()).toBe(false);
    second();
    expect(changes.snapshot()()).toBe(true);
  });
});
