import "server-only";

import type { AccountRow } from "../../db";
import { labelIdsOnMail } from "../../labels";
import type { RemoteLabel } from "../../mail/types";
import { GraphError, pages } from "./graph";
import { canReadCategories } from "./oauth";

// Outlook categories are Kite tags keyed by their name: a message carries the names, and the
// mailbox keeps a list with colours (masterCategories). A category renamed outside Kite is a new
// name on every message; a deleted one stays on its messages. So the list is the mailbox's own
// plus every name found on stored mail, and a name is never dropped while mail still carries it.

/** Outlook's category colour presets, as the colours Outlook shows. */
const PRESETS: Record<string, string> = {
  preset0: "#e74856", preset1: "#ff8c00", preset2: "#ab7b51", preset3: "#fff100", preset4: "#47d041",
  preset5: "#30c6cc", preset6: "#73aa24", preset7: "#00bcf2", preset8: "#8764b8", preset9: "#f495bf",
  preset10: "#a0aeb2", preset11: "#004b60", preset12: "#b1adab", preset13: "#5d5a58", preset14: "#000000",
  preset15: "#750b1c", preset16: "#ca5010", preset17: "#603d30", preset18: "#c19c00", preset19: "#0b6a0b",
  preset20: "#038387", preset21: "#4f6b14", preset22: "#004e8c", preset23: "#5c2e91", preset24: "#77004d",
};

/** The account's categories. `isFolder` tells folder ids (current or just deleted) apart from category names on mail. */
export async function listCategories(account: AccountRow, isFolder: (id: string) => boolean): Promise<RemoteLabel[]> {
  const found = new Map<string, RemoteLabel>();
  // Accounts connected before categories didn't grant MailboxSettings.Read: names from mail only.
  if (canReadCategories(account.id)) {
    try {
      const master = await pages<{ displayName?: string; color?: string }>(account.id, "/me/outlook/masterCategories", 500);
      for (const c of master) {
        const name = c.displayName?.trim();
        if (name && !isFolder(name)) found.set(name, { id: name, name, kind: "tag", color: PRESETS[c.color ?? ""] ?? null, hidden: false });
      }
    } catch (error) {
      if (!(error instanceof GraphError && (error.status === 403 || error.status === 404))) throw error;
    }
  }
  for (const id of labelIdsOnMail(account)) {
    if (!found.has(id) && !isFolder(id)) found.set(id, { id, name: id, kind: "tag", color: null, hidden: false });
  }
  return [...found.values()];
}
