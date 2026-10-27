import { ImapFlow } from "imapflow";
import { afterAll, beforeAll } from "vitest";
import type { Thread } from "@/lib/mail/types";
import { getDb, type AccountRow } from "@/server/db";
import { connectAccount } from "@/server/mail/auth";
import type { MailServers } from "@/server/mail/provider";
import { imapAuth } from "@/server/providers/imap/auth";
import { closeConnection } from "@/server/providers/imap/client";
import { imapProvider } from "@/server/providers/imap";
import { syncAccount, syncIdle } from "@/server/sync";
import { startTestServer } from "../../scripts/imap-test-server.mjs";

// One Hoodiecrow server (scripts/imap-test-server.mjs, in memory, free ports) and one Kite account
// signed in to it per test file. The data folder is the file's own temp folder (test/setup.ts).

export type TestServer = Awaited<ReturnType<typeof startTestServer>>;

export type Mailbox = { server: TestServer; servers: MailServers; account: AccountRow };

export const serversOf = (server: TestServer): MailServers => ({
  imap: { host: "127.0.0.1", port: server.imapPort, secure: false },
  smtp: { host: "127.0.0.1", port: server.smtpPort, secure: false },
});

/** Starts the server and signs in (the way POST /api/auth/imap does), before the file's tests. */
export function testMailbox(options: { gmail?: boolean; uidplus?: boolean; password?: string; typed?: string } = {}): Mailbox {
  const box = {} as Mailbox;
  beforeAll(async () => {
    const { typed, ...start } = options;
    box.server = await startTestServer({ ...start, quiet: true });
    box.servers = serversOf(box.server);
    // `typed`: the password as the user pasted it, when that isn't exactly the server's.
    const signedIn = await imapAuth.signIn({ email: box.server.user, password: typed ?? box.server.password, servers: box.servers, name: "Kite Test" });
    const account = connectAccount(imapProvider, signedIn);
    if (!account) throw new Error("Sign-in didn't make an account");
    signedIn.save(account.id);
    box.account = account;
  });
  afterAll(async () => {
    if (box.account) {
      await syncIdle(box.account.id);
      // Push connections the engine may have started (Reset local copy runs a full pass).
      const engine = (globalThis as { __kiteSync?: { watchers?: Map<string, () => void> } }).__kiteSync;
      engine?.watchers?.forEach((stop) => stop());
      engine?.watchers?.clear();
      await closeConnection(box.account.id);
    }
    // Hoodiecrow waits for every client to leave; don't hang the run on a straggler.
    await Promise.race([box.server?.close(), new Promise((resolve) => setTimeout(resolve, 3000))]);
  });
  return box;
}

/** One full sync pass, as the engine's tick runs it (first sync, labels, prefetch...). */
export async function sync(account: AccountRow) {
  await syncAccount(account.id);
  const error = (getDb().prepare("SELECT error FROM sync_state WHERE account_id = ?").get(account.id) as { error: string | null } | undefined)?.error;
  if (error) throw new Error(`Sync failed: ${error}`);
}

/** Every stored conversation of the account, full rows parsed. */
export function storedThreads(account: AccountRow) {
  const rows = getDb().prepare("SELECT id, data, labels FROM threads WHERE account_id = ?").all(account.id) as { id: string; data: string; labels: string }[];
  return rows.map((r) => ({ ...(JSON.parse(r.data) as Thread), id: r.id, rowLabels: JSON.parse(r.labels) as string[] }));
}

/** The stored conversation whose first subject is `subject` (throws when there isn't exactly one). */
export function thread(account: AccountRow, subject: string) {
  const found = storedThreads(account).filter((t) => t.subject === subject);
  if (found.length !== 1) throw new Error(`${found.length} conversations called "${subject}"`);
  return found[0];
}

/** The thread key ops and routes take (the id after the account). */
export const keyOf = (account: AccountRow, t: { id: string }) => t.id.slice(account.id.length + 1);

export type ServerCopy = { folder: string; flags: string[]; labels: string[]; subject: string };

/**
 * What the server holds, read with a separate connection: every copy by Message-ID (without the
 * brackets and domain, as the fixtures name them: "q3-1").
 */
export async function serverCopies(box: Mailbox, folders: string[]): Promise<Map<string, ServerCopy[]>> {
  const client = new ImapFlow({ host: "127.0.0.1", port: box.server.imapPort, secure: false, auth: { user: box.server.user, pass: box.server.password }, logger: false });
  client.on("error", () => {});
  await client.connect();
  const out = new Map<string, ServerCopy[]>();
  try {
    for (const folder of folders) {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        if (!client.mailbox || !client.mailbox.exists) continue;
        const gmail = client.capabilities.has("X-GM-EXT-1");
        for (const m of await client.fetchAll("1:*", { envelope: true, flags: true, ...(gmail ? { labels: true } : {}) })) {
          const id = (m.envelope?.messageId ?? "").replace(/^<|@.*$/g, "");
          const copy = { folder, flags: [...(m.flags ?? [])].sort(), labels: [...(m.labels ?? [])].sort(), subject: m.envelope?.subject ?? "" };
          out.set(id, [...(out.get(id) ?? []), copy]);
        }
      } finally {
        lock.release();
      }
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
  return out;
}
