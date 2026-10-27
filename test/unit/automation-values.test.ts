import { describe, expect, test } from "vitest";
import { parseAmount, parseDate, tokenize } from "@/lib/automations/values";

const types = (text: string) => tokenize(text).filter((t) => t.type !== "word" && t.type !== "punct").map((t) => `${t.type}:${t.text}`);

describe("tokens", () => {
  test("money in many formats, currency first or last", () => {
    expect(types("R 1 250,00 and R1,250.00 and 1.250,00 € and 1 250,00 EUR and Ksh1,250.00 and -R50.00")).toEqual([
      "money:R 1 250,00",
      "money:R1,250.00",
      "money:1.250,00 €",
      "money:1 250,00 EUR",
      "money:Ksh1,250.00",
      "money:-R50.00",
    ]);
  });

  test("numbers that aren't amounts stay numbers, codes or accounts", () => {
    expect(types("Order OR202618, call 0860 123 456, card ··4410, a/c..4521, ***0700")).toEqual([
      "code:OR202618",
      "num:0860",
      "num:123",
      "num:456",
      "acct:··4410",
      "acct:..4521",
      "acct:***0700",
    ]);
  });

  test("a three-letter word is a currency only when it's an ISO code", () => {
    expect(types("ABC 120 and ZAR 120")).toEqual(["num:120", "money:ZAR 120"]);
  });

  test("month and weekday names in other languages", () => {
    expect(types("Mittwoch, 30 September · 12 octobre · 3 Oktober")).toEqual([
      "weekday:Mittwoch",
      "num:30",
      "month:September",
      "num:12",
      "month:octobre",
      "num:3",
      "month:Oktober",
    ]);
  });
});

describe("number formats", () => {
  test("each example settles its own separator when it can", () => {
    expect(parseAmount("R 1 250,00")?.value).toBe(1250);
    expect(parseAmount("R1,250.00")?.value).toBe(1250);
    expect(parseAmount("1.250,00 €")?.value).toBe(1250);
    expect(parseAmount("€ 9,99")?.value).toBe(9.99);
    expect(parseAmount("R 1.250.000")?.value).toBe(1_250_000);
  });

  test("an ambiguous one reads as grouping, marked unsure", () => {
    expect(parseAmount("R1,250")).toMatchObject({ value: 1250, unsure: true });
  });

  test("currency symbols map to ISO codes", () => {
    expect(parseAmount("R 10")?.currency).toBe("ZAR");
    expect(parseAmount("£3.20")?.currency).toBe("GBP");
    expect(parseAmount("12,00 EUR")?.currency).toBe("EUR");
  });
});

describe("dates", () => {
  test("text dates take the email's year", () => {
    expect(parseDate("Wednesday, 30 September at 17:54", "2026-10-01T10:00:00Z")).toBe(new Date(2026, 8, 30, 17, 54).toISOString());
    expect(parseDate("12.10.2026 um 14:22", "2026-10-12T10:00:00Z")).toBe(new Date(2026, 9, 12, 14, 22).toISOString());
  });

  test("with no year, the one nearest the email", () => {
    expect(parseDate("30 December", "2026-01-02T10:00:00Z")).toBe(new Date(2025, 11, 30).toISOString());
    expect(parseDate("Due 3 November", "2026-10-20T10:00:00Z")).toBe(new Date(2026, 10, 3).toISOString());
    expect(parseDate("3 January", "2026-12-20T10:00:00Z")).toBe(new Date(2027, 0, 3).toISOString());
  });
});
