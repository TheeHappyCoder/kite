import "server-only";

import * as z from "zod";
import { splitMessage } from "@/lib/mail/quotes";
import type { RewriteStyle, ThreadSummary } from "@/lib/ai-mail";
import type { Message, Thread } from "@/lib/mail/types";
import { generateJson } from "./ai";
import type { AccountRow } from "./db";

// AI on mail, through BYO AI (server/ai.ts). Summarise, Draft with AI and Rewrite run only when
// the user clicks them and see only that conversation (or the selected text). A rule's "Draft with
// AI" (server/ai-drafts.ts) sees less: the one new email's fresh text. Names are sent, addresses
// never; quotes and signatures are cut (lib/mail/quotes.ts), and everything is trimmed.

/** One message's new text, at most this long. */
const MESSAGE_CHARS = 3_000;
/** A whole conversation, newest messages first until this much. */
const THREAD_CHARS = 14_000;

const MARKUP = `Write plain text in the language of the email you answer. Paragraphs are separated by a blank line. You may use **bold**, *italic* and lines starting with "- " for a list, nothing else (no headings, no HTML).`;

function trim(text: string, max: number) {
  const clean = text.replace(/\[(image|cid|inline image)[^\]]*\]/gi, "").replace(/\n{3,}/g, "\n\n").trim();
  return clean.length > max ? `${clean.slice(0, max).trimEnd()} […]` : clean;
}

/** The new text of a message: quotes and signature cut. */
function freshText(message: Message) {
  return splitMessage(message).text.fresh;
}

function isMine(message: Message, account: AccountRow) {
  return message.from.email.toLowerCase() === account.email.toLowerCase() || message.from.name === "You";
}

function who(message: Message, account: AccountRow) {
  if (isMine(message, account)) return "You";
  const name = message.from.name.replace(/["']/g, "").trim();
  return name && !name.includes("@") ? name : "The sender";
}

/** The conversation as the AI sees it: newest messages kept first, oldest dropped when it's long. */
function conversationText(thread: Thread, account: AccountRow) {
  const parts: string[] = [];
  let used = 0;
  const messages = thread.messages.filter((m) => !m.draft);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const text = trim(freshText(m), MESSAGE_CHARS);
    const part = `From: ${who(m, account)}\nDate: ${m.date.slice(0, 16).replace("T", " ")}\n\n${text || "(no text)"}`;
    if (used + part.length > THREAD_CHARS && parts.length) {
      parts.unshift(`(${i + 1} earlier message${i ? "s" : ""} left out)`);
      break;
    }
    parts.unshift(part);
    used += part.length;
  }
  return parts.join("\n\n---\n\n");
}

const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Summarise
// ---------------------------------------------------------------------------

const SummarySchema = z.object({
  /** One or two sentences. */
  summary: z.string(),
  /** The main points, up to five. */
  points: z.array(z.string()),
  /** What the user is asked to do, if anything. */
  asks: z.array(z.string()),
});

export async function summariseThread(account: AccountRow, thread: Thread): Promise<ThreadSummary> {
  const system = `You summarise email conversations for the person reading them ("You" in the messages). Be short and concrete: names, dates, amounts. summary: one or two sentences on what this is about and where it stands. points: up to five key facts or decisions (none for a short simple email). asks: what You are asked or expected to do, with any deadline (empty when nothing). Use the language of the conversation. Don't invent anything.`;
  const prompt = `Subject: ${thread.subject}\nToday is ${today()}.\n\n${conversationText(thread, account)}`;
  const { value: result } = await generateJson(SummarySchema, system, prompt, { task: "summarise", action: "Summarise", detail: thread.subject, threadId: thread.id }, 1500);
  return { summary: result.summary.trim(), points: result.points.slice(0, 5), asks: result.asks.slice(0, 5) };
}

// ---------------------------------------------------------------------------
// Draft a reply
// ---------------------------------------------------------------------------

const DraftSchema = z.object({ body: z.string() });

const DRAFT_RULES = `Write only the body of the reply: no subject line and no signature (one is added). Start with a short greeting using their first name when you know it. Keep it as short as the email allows and match its tone. Never invent facts, dates, prices, promises or attachments: where the reply needs something you don't know, put a short placeholder in square brackets, like [time] or [amount]. ${MARKUP}`;

/** "Draft with AI": a reply to the conversation, in your name, optionally following your notes. */
export async function draftReply(account: AccountRow, thread: Thread, notes: string) {
  const name = account.nickname?.trim() || account.name || "the user";
  const system = `You write email replies for ${name} ("You" in the conversation). ${DRAFT_RULES}`;
  const steer = notes.trim() ? `\n\nWhat You want to say (follow this, in your own words):\n${trim(notes, 2_000)}` : "";
  const prompt = `Subject: ${thread.subject}\nToday is ${today()}.\n\nThe conversation, oldest first. Reply to the last message from someone else.\n\n${conversationText(thread, account)}${steer}`;
  const { value } = await generateJson(DraftSchema, system, prompt, { task: "draft", action: "Draft with AI", detail: thread.subject, threadId: thread.id }, 1500);
  return value.body.trim();
}

/**
 * A rule's "Draft with AI": sees only the one email it answers (fresh text, trimmed), its subject
 * and the sender's name, plus the rule's own instruction. What it used goes in the usage ledger.
 */
export async function draftForRule(account: AccountRow, thread: Thread, message: Message, instruction: string, rule: { id: string; name: string; model: string | null }) {
  const name = account.nickname?.trim() || account.name || "the user";
  const system = `You write email replies for ${name}. ${DRAFT_RULES}`;
  const steer = instruction.trim() ? `\n\nHow ${name} wants to answer emails like this:\n${instruction.trim()}` : "";
  const prompt = `Subject: ${message.subject ?? thread.subject}\nFrom: ${who(message, account)}\nToday is ${today()}.\n\n${trim(freshText(message), MESSAGE_CHARS) || "(no text)"}${steer}`;
  const { value } = await generateJson(
    DraftSchema,
    system,
    prompt,
    { task: "rule_drafts", model: rule.model, action: "Rule draft", detail: `${thread.subject} (rule “${rule.name}”)`, ruleId: rule.id, threadId: thread.id },
    1500,
  );
  return value.body.trim();
}

// ---------------------------------------------------------------------------
// Rewrite
// ---------------------------------------------------------------------------

const STYLE_ASK: Record<RewriteStyle, string> = {
  shorter: "Make it shorter and clearer. Keep every fact and request.",
  friendlier: "Make it warmer and friendlier, still natural and not gushing.",
  formal: "Make it more formal and professional.",
  fix: "Fix spelling, grammar and punctuation only. Change nothing else.",
};

/** Rewrites text you selected in compose (or the whole message): only that text is sent. */
export async function rewriteText(text: string, style: RewriteStyle | null, instruction: string) {
  const ask = style ? STYLE_ASK[style] : instruction.trim();
  const system = `You rewrite part of an email the user is writing. Return only the rewritten text, in the same language, keeping names, numbers, links and any [placeholders]. Keep its formatting markup: **bold**, *italic*, [label](url), lines starting with "- " or "1. ". Don't add a greeting or sign-off that wasn't there.`;
  const { value } = await generateJson(z.object({ text: z.string() }), system, `${ask}\n\nThe text:\n${text}`, { task: "rewrite", action: "Rewrite", detail: "Selected text only" }, 2000);
  return value.text.trim();
}
