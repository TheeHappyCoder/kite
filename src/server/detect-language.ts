import "server-only";

import { franc } from "franc";
import { FROM_FRANC } from "@/lib/translate/languages";

// Which language a message is written in (franc: trigram statistics, local, no AI), here on Kite's own
// server so the reader doesn't carry the statistics (/api/translate/detect).

/** Text shorter than this can't be told apart reliably: no offer. */
const MIN_LENGTH = 40;

/** The language of a piece of text, as a model code, or null when it's too short or unclear. */
export function detectLanguage(text: string): string | null {
  const sample = text.replace(/s+/g, " ").trim().slice(0, 1500);
  if (sample.length < MIN_LENGTH) return null;
  return FROM_FRANC[franc(sample, { minLength: MIN_LENGTH })] ?? null;
}
