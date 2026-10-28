import { expect, it } from "vitest";
import { appPasswordLetters } from "@/lib/mail/app-password";

it.each([
  "abcd efgh ijkl mnop",
  " abcd\u00a0efgh\u202fijkl\nm nop\t",
  "abcd\u200befgh\u2060ijkl\u200dmnop",
])("normalizes a grouped Google password copied as %j", (value) => {
  expect(appPasswordLetters(value)).toBe("abcdefghijklmnop");
});

it("preserves invalid characters so validation can reject them", () => {
  expect(appPasswordLetters("abcd-efgh ijkl mnop!")).toBe("abcd-efghijklmnop!");
});
