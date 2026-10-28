import type { Message } from "./types";

/** A conversation can contain both deleted messages and replies that are still in the inbox. */
export function messagesInMailbox(messages: Message[], trash: boolean) {
  return messages.filter((m) => trash ? m.labels?.includes("TRASH") : !m.labels?.includes("TRASH") && !m.labels?.includes("SPAM"));
}
