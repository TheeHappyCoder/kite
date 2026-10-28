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
  accounts: { id: string; email: string; count: number }[];
};
export type MailBatchResult = { done: number; failed: number; skipped: number; stopped?: boolean; undo?: string; subscriptions?: { email: string; note: string; url?: string }[] };

/**
 * A review, run or undo working on the server (server/mail-batch.ts), read back with GET /api/mail/batch?job=.
 * `total` is 0 while it's still finding out how much there is. It keeps going when the window looks away.
 */
export type MailBatchJob = {
  id: string;
  kind: "review" | "run" | "undo";
  done: number;
  total: number;
  finished: boolean;
  error?: string;
  preview?: MailBatchPreview;
  result?: MailBatchResult;
};
