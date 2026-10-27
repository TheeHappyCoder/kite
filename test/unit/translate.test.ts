import { describe, expect, it } from "vitest";
import { languageName, MODEL_LANGUAGES } from "@/lib/translate/languages";
import { detectLanguage } from "@/server/detect-language";

describe("detectLanguage", () => {
  it("names the language of a message, as the models' codes", () => {
    expect(detectLanguage("Goeie môre, ek stuur vir jou die faktuur môre oggend vroeg. Kan ons Donderdag ontmoet?")).toBe("af");
    expect(detectLanguage("Hola, ¿podemos mover la reunión al jueves? Te envío la factura mañana por la mañana.")).toBe("es");
    expect(detectLanguage("Hi, can we move the meeting to Thursday? I will send the invoice tomorrow morning.")).toBe("en");
  });
  it("says nothing about text too short to tell", () => {
    expect(detectLanguage("Thanks!")).toBeNull();
  });
});

describe("languages", () => {
  it("covers the languages Kite translates, with names", () => {
    expect(MODEL_LANGUAGES).toContain("af");
    expect(MODEL_LANGUAGES).toContain("zh");
    expect(languageName("af", "en")).toBe("Afrikaans");
  });
});
