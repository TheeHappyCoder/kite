import "server-only";

import { categoryFrom, STARRED, UNREAD } from "@/lib/mail/mailboxes";
import type { Message } from "@/lib/mail/types";
import type { AccountRow } from "../db";
import type { ThreadRecord, Unsubscribe } from "./types";

/** A conversation in Kite's model (the record the store indexes). `unsubscribeOf`: the unsubscribe headers of the message at that index. */
export function threadRecord(
  account: AccountRow,
  remoteId: string,
  messages: Message[],
  { subject, full, unsubscribeOf }: { subject: string | null | undefined; full: boolean; unsubscribeOf: (index: number) => Unsubscribe | null },
): ThreadRecord {
  const labels = [...new Set(messages.flatMap((m) => m.labels ?? []))];
  const me = account.email.toLowerCase();
  const externalIndex = messages.findLastIndex((m) => m.from.email.toLowerCase() !== me);
  const recipients = messages
    .filter((m) => m.from.email.toLowerCase() === me)
    .flatMap((m) => [...m.to, ...(m.cc ?? [])])
    .map((c) => c.email.toLowerCase());
  return {
    thread: {
      id: `${account.id}:${remoteId}`,
      remoteId,
      accountId: account.id,
      subject: subject || "(no subject)",
      messages,
      mailbox: "inbox",
      category: categoryFrom(messages.at(-1)?.labels ?? []),
      unread: labels.includes(UNREAD),
      starred: labels.includes(STARRED),
      loaded: full,
    },
    labels,
    sender: externalIndex >= 0 ? messages[externalIndex].from : null,
    unsubscribe: externalIndex >= 0 ? unsubscribeOf(externalIndex) : null,
    recipients: [...new Set(recipients)],
  };
}
