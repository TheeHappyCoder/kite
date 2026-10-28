export type MailBatchRequest = {
  account: string;
  action: "trash" | "archive" | "permanent";
  threads?: { account: string; id: string }[];
  senders?: string[];
  inboxOnly?: boolean;
  unsubscribe?: boolean;
};
export type MailBatchPreview = {
  token: string;
  count: number;
  accounts: { email: string; count: number }[];
};
export type MailBatchResult = { done: number; failed: number; skipped: number; undo?: string; subscriptions?: { email: string; note: string; url?: string }[] };
