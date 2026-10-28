import { NextResponse } from "next/server";
import type { Mailbox } from "@/lib/mail/types";
import { inScope, scopeIds } from "@/lib/mail/scope";
import * as z from "zod";
import { THREAD_KEY } from "@/lib/mail/threads";
import { getAccount, getDb, listAccounts } from "@/server/db";
import { mailFor } from "@/server/providers/registry";
import { errorResponse } from "@/server/errors";
import { rejectCrossSite } from "@/server/guard";
import { refreshDraftList } from "@/server/drafts";
import { scheduledThreads } from "@/server/scheduled";
import { withAmounts } from "@/server/home";
import { countThreads, queryLabel, queryThreads, searchThreads, threadCount } from "@/server/store";
import { ensureSyncLoop, runLabelChange, runOps, syncProgress, undoMove } from "@/server/sync";

export const runtime = "nodejs";

const MAILBOXES: Mailbox[] = ["inbox", "screener", "snoozed", "scheduled", "starred", "sent", "drafts", "archive", "trash"];

const Targets = z.array(z.object({ account: z.string(), id: z.string().regex(THREAD_KEY) })).min(1).max(1000);
const LabelIds = z.array(z.string().min(1).max(200)).max(50);

const BulkOp = z.union([
  z.object({
    op: z.enum(["archive", "unarchive", "star", "unstar", "read", "unread", "spam", "unspam", "trash", "untrash", "snooze", "unsnooze"]),
    until: z.iso.datetime().optional(),
    threads: Targets,
  }),
  // The user's own labels: tags are added to and removed from every conversation; a folder moves it there.
  z.object({ labels: z.object({ add: LabelIds, remove: LabelIds }), threads: Targets }),
]);

/** Undo of a folder move: the id runLabelChange returned. */
const UndoMove = z.object({ undoMove: z.uuid() });

/** Bulk select: one operation on many threads. */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const body = await request.json().catch(() => null);
  const undo = UndoMove.safeParse(body);
  if (undo.success) {
    try {
      await undoMove(undo.data.undoMove);
      return NextResponse.json({ ok: true });
    } catch (error) {
      return errorResponse(error);
    }
  }
  const parsed = BulkOp.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "That selection couldn't be read." }, { status: 400 });
  const { threads } = parsed.data;
  const items = threads.flatMap((t) => {
    const account = getAccount(t.account);
    return account ? [{ account, key: t.id }] : [];
  });
  if (!items.length) return NextResponse.json({ error: "Unknown account" }, { status: 404 });
  try {
    if ("labels" in parsed.data) return NextResponse.json(await runLabelChange(items, parsed.data.labels.add, parsed.data.labels.remove));
    return NextResponse.json(await runOps(items, parsed.data.op, parsed.data.until));
  } catch (error) {
    return errorResponse(error);
  }
}

/** Reads from the local store, so it answers instantly; the sync engine keeps the store fresh. */
export async function GET(request: Request) {
  ensureSyncLoop();
  const params = new URL(request.url).searchParams;
  const mailbox = params.get("mailbox") as Mailbox | "label";
  if (!MAILBOXES.includes(mailbox as Mailbox) && mailbox !== "label") return NextResponse.json({ error: "Unknown mailbox" }, { status: 400 });
  const accountId = params.get("account") || "all";
  const query = params.get("q")?.trim();
  if (mailbox === "drafts" && !query) for (const account of listAccounts().filter((a) => inScope(accountId, a.id) && mailFor(a))) void refreshDraftList(account).catch(() => {});
  // A label belongs to one account: ?mailbox=label&label=<provider id>&account=<account id>.
  const label = params.get("label");
  if (mailbox === "label" && (!label || scopeIds(accountId)?.length !== 1)) return NextResponse.json({ error: "Unknown label" }, { status: 400 });

  const offset = Math.max(0, Math.min(1_000_000, Number(params.get("offset")) || 0));
  const threads = query
    ? searchThreads(query, accountId, 101, offset)
    : mailbox === "label"
      ? queryLabel(accountId, label!)
      : mailbox === "scheduled"
      ? scheduledThreads(accountId)
      : mailbox === "inbox"
        ? withAmounts(queryThreads(mailbox, accountId))
        : queryThreads(mailbox, accountId);

  // Unread inbox per account, so the account switcher shows mail waiting elsewhere.
  const unread = new Map(listAccounts().map((account) => [account.id, countThreads("inbox", account.id, { unread: true })]));
  const sync = Object.fromEntries(
    listAccounts().map((account) => {
      const state = getDb().prepare("SELECT initial_done, synced_at, error FROM sync_state WHERE account_id = ?").get(account.id) as
        | { initial_done: number; synced_at: string | null; error: string | null }
        | undefined;
      return [
        account.id,
        {
          // A provider Kite only signs in to so far has nothing to wait for.
          ready: !!state?.initial_done || !mailFor(account),
          syncedAt: state?.synced_at ?? null,
          reconnect: state?.error === "reconnect",
          progress: syncProgress(account.id),
          stored: threadCount(account.id),
          unread: unread.get(account.id) ?? 0,
        },
      ];
    }),
  );

  const counts = {
    inbox: [...unread].reduce((n, [id, c]) => n + (inScope(accountId, id) ? c : 0), 0),
    screener: countThreads("screener", accountId),
    snoozed: countThreads("snoozed", accountId),
    scheduled: scheduledThreads(accountId).length,
    drafts: countThreads("drafts", accountId),
  };

  return NextResponse.json({ threads: query ? threads.slice(0, 100) : threads, nextOffset: query && threads.length > 100 ? offset + 100 : null, sync, counts });
}
