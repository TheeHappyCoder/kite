// On-click AI on mail, shared by the app and the server (server/ai-mail.ts, /api/ai/mail).
// Summarise, Draft with AI and Rewrite run only when clicked, on that conversation or selection.

export type ThreadSummary = {
  /** One or two sentences. */
  summary: string;
  /** Key facts or decisions, up to five. */
  points: string[];
  /** What you're asked to do, if anything. */
  asks: string[];
};

/** A summary in the reader. `lastId`: the newest message when it was asked for (newer mail offers a refresh). */
export type SummaryState =
  | { status: "loading"; lastId?: string }
  | { status: "done"; lastId?: string; summary: ThreadSummary }
  | { status: "error"; lastId?: string; message: string };

export const REWRITE_STYLES = ["shorter", "friendlier", "formal", "fix"] as const;
export type RewriteStyle = (typeof REWRITE_STYLES)[number];
/** How to rewrite: one of the styles, or the user's own words ("make it sound less urgent"). */
export type RewriteHow = RewriteStyle | { instruction: string };
/** The longest own instruction the server takes. */
export const REWRITE_INSTRUCTION_MAX = 500;

export const REWRITE_LABELS: Record<RewriteStyle, string> = {
  shorter: "Shorter",
  friendlier: "Friendlier",
  formal: "More formal",
  fix: "Fix spelling and grammar",
};

type AiMailRequest =
  | { kind: "summarise"; account: string; thread: string }
  | { kind: "draft"; account: string; thread: string; notes?: string }
  | { kind: "rewrite"; text: string; style: RewriteStyle | null; instruction?: string };

/** A failed AI request. `connect`: no AI is set up yet (open AI settings instead of showing it). */
export class AiRequestError extends Error {
  constructor(
    message: string,
    readonly connect = false,
  ) {
    super(message);
  }
}

export async function askAi<T>(body: AiMailRequest): Promise<T> {
  const res = await fetch("/api/ai/mail", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  if (!res) throw new AiRequestError("Kite couldn't reach its server. Try again.");
  const data = (await res.json().catch(() => ({}))) as { error?: string; connect?: boolean };
  if (!res.ok) throw new AiRequestError(data.error ?? "The AI didn't answer. Try again.", !!data.connect);
  return data as T;
}
