import "server-only";

import type { AccountRow } from "../../db";
import { loginRefused, makeClient } from "./client";
import { getServers } from "./servers";

// Push for IMAP: a second connection sits in IDLE on INBOX (imapflow re-issues IDLE before servers
// drop it) and says when something changed there; the engine then reads the change feed. Drops are
// retried with backoff; a refused password stops it (the account shows Reconnect on the next tick).

const RETRY_MIN = 5_000;
const RETRY_MAX = 5 * 60_000;
const SETTLE_MS = 500;

export function watch(account: Pick<AccountRow, "id">, onChange: () => void): () => void {
  let stopped = false;
  let client: ReturnType<typeof makeClient> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A burst of EXISTS / FETCH lines is one change.
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(() => !stopped && onChange(), SETTLE_MS);
  };

  void (async () => {
    let wait = RETRY_MIN;
    while (!stopped) {
      const servers = getServers(account.id);
      if (!servers) return;
      client = makeClient(servers, servers.username, servers.password, { idle: true });
      client.on("error", () => {});
      try {
        await client.connect();
        await client.mailboxOpen("INBOX", { readOnly: true });
        client.on("exists", changed);
        client.on("expunge", changed);
        client.on("flags", changed);
        wait = RETRY_MIN;
        const open = client;
        await new Promise<void>((resolve) => open.once("close", () => resolve()));
      } catch (error) {
        client.close();
        if (loginRefused(error)) return;
      }
      if (stopped) return;
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, RETRY_MAX);
    }
  })();

  return () => {
    stopped = true;
    clearTimeout(timer);
    const open = client;
    if (open) void open.logout().catch(() => open.close());
  };
}
