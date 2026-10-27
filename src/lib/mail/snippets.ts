import { escapeMarkup } from "./body";
import type { Recipient } from "./compose";
/** Unknown or multiple addressees leave a visible placeholder for the writer to resolve. */
export function expandSnippet(body: string, to: Recipient[]) {
  if (to.length !== 1) return body;
  const person = to[0];
  const first = person.name?.trim().split(/\s+/)[0];
  return body.replace(/\{(first_name|full_name|email)\}/g, (token, key: string) => {
    const value = key === "first_name" ? first : key === "full_name" ? person.name : person.email;
    return value ? escapeMarkup(value) : token;
  });
}
