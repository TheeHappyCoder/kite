import { describe, expect, it } from "vitest";
import { parseUnsubscribe } from "@/server/mail/parse";

describe("parseUnsubscribe", () => {
  it("is null without a header", () => {
    expect(parseUnsubscribe("", "")).toBeNull();
  });

  it("reads https and mailto, in any order", () => {
    expect(parseUnsubscribe("<mailto:leave@list.example?subject=unsubscribe>, <https://list.example/u?id=1>", "")).toEqual({
      http: "https://list.example/u?id=1",
      mailto: "mailto:leave@list.example?subject=unsubscribe",
      oneClick: false,
    });
  });

  it("one-click needs List-Unsubscribe-Post and an https link", () => {
    expect(parseUnsubscribe("<https://list.example/u>", "List-Unsubscribe=One-Click")).toEqual({ http: "https://list.example/u", mailto: undefined, oneClick: true });
    expect(parseUnsubscribe("<mailto:leave@list.example>", "List-Unsubscribe=One-Click")?.oneClick).toBe(false);
  });

  it("ignores plain http and other schemes", () => {
    expect(parseUnsubscribe("<http://list.example/u>", "")).toBeNull();
    expect(parseUnsubscribe("<ftp://list.example/u>", "")).toBeNull();
  });

  it("trims spaces inside the brackets and takes the first of each kind", () => {
    expect(parseUnsubscribe("< https://a.example/1 >, <https://b.example/2>", "")?.http).toBe("https://a.example/1");
  });

  it("is null for a header with no brackets", () => {
    expect(parseUnsubscribe("https://list.example/u", "")).toBeNull();
  });
});
