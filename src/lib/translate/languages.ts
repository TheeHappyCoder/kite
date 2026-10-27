// Languages Kite can translate on this computer (Firefox's translation models, server/translate.ts).
// Which one a message is written in is worked out by server/detect-language.ts, so the reader doesn't
// carry the statistics. Codes are the models' (ISO 639-1, plus zh).

/** franc's ISO 639-3 codes for the languages the models cover. */
export const FROM_FRANC: Record<string, string> = {
  afr: "af", arb: "ar", azj: "az", bel: "be", bul: "bg", ben: "bn", bos: "bs", cat: "ca", ces: "cs", dan: "da",
  deu: "de", ell: "el", eng: "en", spa: "es", ekk: "et", est: "et", eus: "eu", pes: "fa", fin: "fi", fra: "fr",
  glg: "gl", guj: "gu", heb: "he", hin: "hi", hrv: "hr", hun: "hu", ind: "id", isl: "is", ita: "it", jpn: "ja",
  kan: "kn", kor: "ko", lit: "lt", lvs: "lv", mal: "ml", mar: "mr", zlm: "ms", mlt: "mt", nob: "nb", nno: "nn",
  nld: "nl", pol: "pl", por: "pt", ron: "ro", rus: "ru", slk: "sk", slv: "sl", als: "sq", srp: "sr", swe: "sv",
  tam: "ta", tel: "te", tha: "th", tgl: "tl", tur: "tr", uig: "ug", ukr: "uk", urd: "ur", vie: "vi", cmn: "zh",
};

/** The language's name in the user's own language ("Spanish", "Afrikaans"). */
export function languageName(code: string, locale?: string) {
  try {
    return new Intl.DisplayNames(locale ? [locale] : undefined, { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The user's own language from the browser (the default to translate into). */
export function ownLanguage() {
  const code = (typeof navigator !== "undefined" ? navigator.language : "en").toLowerCase().split("-")[0];
  return code || "en";
}

/** What GET /api/translate says about each language. */
export type TranslateLanguage = {
  code: string;
  /** Bytes still to download to translate from it into the target (0 once it's here). */
  download: number;
  installed: boolean;
};

export type TranslateState = {
  /** The language messages are translated into. */
  target: string;
  /** Languages that can be translated into the target. */
  languages: TranslateLanguage[];
  /** Bytes the downloaded languages take on disk. */
  stored: number;
};

/** Every language the models know (any of them can be what messages are translated into). */
export const MODEL_LANGUAGES = [...new Set(Object.values(FROM_FRANC))];
