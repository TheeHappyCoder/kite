import "server-only";

import { ImapFlow } from "imapflow";
import type { AccountRow } from "../../db";
import { ProviderError, ReconnectRequired } from "../../mail/errors";
import type { MailServers } from "../../mail/provider";
import { presetById } from "./presets";
import { getServers } from "./servers";

// IMAP connections. One open connection per account for everything Kite asks (commands queue on
// it; a folder is locked while it's in use), closed after a few quiet minutes. Push (IDLE) keeps
// its own connection (watch.ts). Kept on globalThis so routes and the sync engine share them.

const IDLE_CLOSE_MS = 4 * 60_000;

export class ImapError extends ProviderError {}

type Entry = { client: ImapFlow; ready: Promise<ImapFlow>; timer?: ReturnType<typeof setTimeout> };
const g = globalThis as typeof globalThis & { __kiteImap?: Map<string, Entry> };
const pool = (g.__kiteImap ??= new Map());

/** The name for messages: the service ("iCloud Mail") or the server. */
export function serviceName(accountId: string) {
  const servers = getServers(accountId);
  return presetById(servers?.preset)?.name ?? servers?.imap.host ?? "your mail server";
}

/** A server on this computer (a test server, Proton Bridge): the only kind a password may reach without TLS. */
export const isLocalHost = (host: string) => ["localhost", "127.0.0.1", "::1"].includes(host.toLowerCase());

/** A new, unconnected client. Passwords never cross the network in cleartext: without TLS from the start, STARTTLS is required. */
export function makeClient(servers: MailServers, user: string, pass: string, { idle = false }: { idle?: boolean } = {}) {
  return new ImapFlow({
    host: servers.imap.host,
    port: servers.imap.port,
    secure: servers.imap.secure,
    ...(servers.imap.secure || isLocalHost(servers.imap.host) ? {} : { doSTARTTLS: true }),
    auth: { user, pass },
    logger: false,
    clientInfo: { name: "Kite" },
    // The push connection (watch.ts) sits in IDLE whenever it's quiet; command connections never do.
    disableAutoIdle: !idle,
    qresync: true,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 5 * 60_000,
  });
}

/** Whether an error from imapflow means the login was refused. */
export const loginRefused = (error: unknown) => !!(error as { authenticationFailed?: boolean })?.authenticationFailed;

/** Turns imapflow errors into Kite's: a refused login asks to reconnect; the rest name the server. */
function imapError(accountId: string, error: unknown): Error {
  if (error instanceof ProviderError || error instanceof ReconnectRequired) return error;
  if (loginRefused(error)) return new ReconnectRequired(accountId);
  const e = error as { responseText?: string; message?: string; code?: string };
  const status = e.code === "ETIMEDOUT" || e.code === "ECONNREFUSED" || e.code === "ENOTFOUND" ? 503 : 502;
  return new ImapError(e.responseText || e.message || "The mail server didn't answer", status, serviceName(accountId));
}

/** The account's connection, opened (or reopened) as needed. */
async function connection(account: Pick<AccountRow, "id">): Promise<ImapFlow> {
  const existing = pool.get(account.id);
  if (existing?.client.usable) {
    keepAlive(account.id, existing);
    return existing.ready;
  }
  if (existing) pool.delete(account.id);
  const servers = getServers(account.id);
  if (!servers) throw new ReconnectRequired(account.id);
  const client = makeClient(servers, servers.username, servers.password);
  const entry: Entry = {
    client,
    ready: client.connect().then(
      () => client,
      (error) => {
        pool.delete(account.id);
        throw imapError(account.id, error);
      },
    ),
  };
  // A dropped connection is simply opened again on the next request.
  client.on("error", () => {});
  client.on("close", () => {
    if (pool.get(account.id) === entry) pool.delete(account.id);
    clearTimeout(entry.timer);
  });
  pool.set(account.id, entry);
  keepAlive(account.id, entry);
  return entry.ready;
}

function keepAlive(accountId: string, entry: Entry) {
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    if (pool.get(accountId) === entry) pool.delete(accountId);
    entry.client.logout().catch(() => entry.client.close());
  }, IDLE_CLOSE_MS);
  entry.timer.unref?.();
}

/** Runs `fn` with a folder selected (locked, so other work on this connection waits). */
export async function inFolder<T>(account: Pick<AccountRow, "id">, path: string, fn: (client: ImapFlow) => Promise<T>, readOnly = false): Promise<T> {
  const client = await connection(account);
  let lock;
  try {
    lock = await client.getMailboxLock(path, { readOnly });
  } catch (error) {
    throw imapError(account.id, error);
  }
  try {
    return await fn(client);
  } catch (error) {
    throw imapError(account.id, error);
  } finally {
    lock.release();
  }
}

/** Runs `fn` on the connection without selecting a folder (LIST, STATUS, APPEND). */
export async function onConnection<T>(account: Pick<AccountRow, "id">, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = await connection(account);
  try {
    return await fn(client);
  } catch (error) {
    throw imapError(account.id, error);
  }
}

/** Closes the account's connection (Disconnect, sign-in with a new password). */
export async function closeConnection(accountId: string) {
  const entry = pool.get(accountId);
  pool.delete(accountId);
  if (!entry) return;
  clearTimeout(entry.timer);
  await entry.client.logout().catch(() => entry.client.close());
}
