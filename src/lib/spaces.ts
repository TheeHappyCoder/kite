import * as z from "zod";
import { ACCOUNT_COLORS } from "./mail/account-face";
import { realName } from "./mail/contacts";
import type { Contact, Thread } from "./mail/types";

// Spaces: Kite's own places for mail, across every account (a client, a house move, a trip). A
// space can hold pockets (a job for that client), and pockets can hold pockets. They live only on
// this computer: Gmail and Outlook never see them. A conversation can be in several spaces;
// "Move to space" also takes it out of the Inbox. Kept in `spaces` + `space_items` (server/spaces.ts).

/** How deep pockets go (a space, then three levels of pockets inside it). */
export const SPACE_DEPTH = 4;

/** The colours a space can wear: the account ring presets, which read on the frame and on panes. */
export const SPACE_COLORS = ACCOUNT_COLORS;

/** A space's logo, served from this computer. */
export const spaceLogoUrl = (logo: string) => `/api/assets/${logo}`;

export type Space = {
  id: string;
  /** The space this pocket is inside; null for a top-level space. */
  parentId: string | null;
  name: string;
  color: string;
  /** A private note on the space (markup, like message bodies). Never sent. */
  note: string | null;
  /** An image the user uploaded (asset id), shown in place of the dot. */
  logo: string | null;
  position: number;
  createdAt: string;
  /** Conversations directly in it (not counting its pockets). */
  threads: number;
};

export const SpaceName = z.string().trim().min(1, "Give it a name").max(80);

export const NewSpace = z.object({
  name: SpaceName,
  parentId: z.string().max(40).nullable().optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
});

export const SpacePatch = z.object({
  name: SpaceName.optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  note: z.string().max(20_000).nullable().optional(),
  /** An uploaded image (asset id), or null for the colour dot again. */
  logo: z.string().regex(/^[0-9a-f]{24}$/).nullable().optional(),
  /** Moves it inside another space, or to the top (null). */
  parentId: z.string().max(40).nullable().optional(),
});
export type SpacePatch = z.infer<typeof SpacePatch>;

/** What goes in or out of a space: Kite thread ids. */
export const SpaceItems = z.object({
  /** The space conversations go into; null only takes them out. */
  to: z.string().max(40).nullable(),
  /** Spaces they leave at the same time (moving between pockets). */
  from: z.array(z.string().max(40)).max(200).default([]),
  threads: z.array(z.string().min(1).max(300)).min(1).max(1000),
});
export type SpaceItems = z.infer<typeof SpaceItems>;

/** The space and every pocket inside it, at any depth. */
export function within(spaces: Pick<Space, "id" | "parentId">[], id: string): Set<string> {
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of spaces) {
      if (s.parentId && ids.has(s.parentId) && !ids.has(s.id)) {
        ids.add(s.id);
        grew = true;
      }
    }
  }
  return ids;
}

/** From the top space down to this one. */
export function spacePath<T extends Pick<Space, "id" | "parentId">>(spaces: T[], id: string): T[] {
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const path: T[] = [];
  let at = byId.get(id);
  while (at && path.length <= SPACE_DEPTH) {
    path.unshift(at);
    at = at.parentId ? byId.get(at.parentId) : undefined;
  }
  return path;
}

/** How many levels down it sits (0 = a space, 1 = a pocket in it…). */
export const spaceDepth = (spaces: Pick<Space, "id" | "parentId">[], id: string) => spacePath(spaces, id).length - 1;

/** Spaces in tree order (each followed by its pockets), with their depth. */
export function spaceTree<T extends Pick<Space, "id" | "parentId" | "position" | "name">>(spaces: T[]): { space: T; depth: number }[] {
  const children = new Map<string | null, T[]>();
  for (const s of spaces) {
    const parent = s.parentId && spaces.some((p) => p.id === s.parentId) ? s.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), s]);
  }
  const out: { space: T; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    const list = (children.get(parent) ?? []).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    for (const s of list) {
      out.push({ space: s, depth });
      if (depth < SPACE_DEPTH) walk(s.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** "Acme / Website" for a pocket, the name alone for a space. */
export function spaceLabel(spaces: Pick<Space, "id" | "parentId" | "name">[], id: string) {
  return spacePath(spaces, id)
    .map((s) => s.name)
    .join(" / ");
}

/** Its siblings in order: the spaces (or pockets) beside it, itself included. */
export function siblingsOf<T extends Pick<Space, "id" | "parentId" | "position" | "name">>(spaces: T[], parentId: string | null): T[] {
  return spaces.filter((s) => (s.parentId ?? null) === parentId).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

/** How many levels of pockets a space holds below it (0: none). */
function heightOf(spaces: Pick<Space, "id" | "parentId">[], id: string): number {
  const pockets = spaces.filter((s) => s.parentId === id);
  return pockets.length ? 1 + Math.max(...pockets.map((p) => heightOf(spaces, p.id))) : 0;
}

/**
 * Whether a space (with its pockets) can go inside `parentId` (null: the top, a space of its own).
 * Null when it can; otherwise the reason, said plainly, for the toast.
 */
export function placeProblem(spaces: Pick<Space, "id" | "parentId" | "name">[], id: string, parentId: string | null): string | null {
  const space = spaces.find((s) => s.id === id);
  if (!space) return "That space isn't there any more.";
  if (!parentId) return null;
  const parent = spaces.find((s) => s.id === parentId);
  if (!parent) return "That space isn't there any more.";
  if (parentId === id) return `${space.name} can't go inside itself.`;
  if (within(spaces, id).has(parentId)) return `${space.name} can't go inside one of its own pockets.`;
  if (spaceDepth(spaces, parentId) + 1 + heightOf(spaces, id) > SPACE_DEPTH - 1) {
    return heightOf(spaces, id)
      ? `${space.name} and its pockets would go deeper than ${SPACE_DEPTH} levels.`
      : `Pockets go ${SPACE_DEPTH} levels deep at most.`;
  }
  return null;
}

/**
 * Dropping a space beside another (`before` or after it): where it lands (the target's parent) and
 * that level's new order. The order leaves out nothing and repeats nothing.
 */
export function placeBeside<T extends Pick<Space, "id" | "parentId" | "position" | "name">>(spaces: T[], id: string, targetId: string, before: boolean) {
  const target = spaces.find((s) => s.id === targetId);
  const parentId = target?.parentId ?? null;
  const order = siblingsOf(spaces, parentId)
    .map((s) => s.id)
    .filter((s) => s !== id);
  const at = order.indexOf(targetId);
  order.splice(at < 0 ? order.length : before ? at : at + 1, 0, id);
  return { parentId, order };
}

/** What a space view shows: its conversations, the files in them, or the people in them. */
export const SPACE_TABS = [
  { id: "conversations", label: "Conversations" },
  { id: "files", label: "Files" },
  { id: "people", label: "People" },
] as const;
export type SpaceTab = (typeof SPACE_TABS)[number]["id"];

/** Someone in a space's conversations: how many they're in and the newest message with them. */
export type SpacePerson = { email: string; name: string; conversations: number; last: string };

/**
 * Everyone in these conversations (senders and recipients) but you (`own`: your addresses,
 * lower-cased), most conversations first, then the most recent.
 */
export function spacePeople(threads: Thread[], own: Set<string>): SpacePerson[] {
  const people = new Map<string, SpacePerson>();
  const counted = new Map<string, string>();
  for (const thread of threads) {
    for (const m of thread.messages) {
      if (m.draft) continue;
      const note = (c: Contact) => {
        const email = c.email?.trim().toLowerCase();
        if (!email || !email.includes("@") || own.has(email) || c.name === "You") return;
        const entry = people.get(email) ?? { email, name: "", conversations: 0, last: "" };
        entry.name ||= realName(c);
        if (counted.get(email) !== thread.id) {
          counted.set(email, thread.id);
          entry.conversations++;
        }
        if (m.date > entry.last) entry.last = m.date;
        people.set(email, entry);
      };
      [m.from, ...m.to, ...(m.cc ?? [])].forEach(note);
    }
  }
  return [...people.values()].sort((a, b) => b.conversations - a.conversations || b.last.localeCompare(a.last));
}

/** Conversations being dragged from the list (a JSON array of Kite thread ids). */
export const THREAD_DRAG = "application/x-kite-threads";

/** A space being dragged in the sidebar (its id), kept apart from conversations. */
export const SPACE_DRAG = "application/x-kite-space";
