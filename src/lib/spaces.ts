import * as z from "zod";
import { ACCOUNT_COLORS } from "./mail/account-face";

// Spaces: Kite's own places for mail, across every account (a client, a house move, a trip). A
// space can hold pockets (a job for that client), and pockets can hold pockets. They live only on
// this computer: Gmail and Outlook never see them. A conversation can be in several spaces;
// "Move to space" also takes it out of the Inbox. Kept in `spaces` + `space_items` (server/spaces.ts).

/** How deep pockets go (a space, then three levels of pockets inside it). */
export const SPACE_DEPTH = 4;

/** The colours a space can wear: the account ring presets, which read on the frame and on panes. */
export const SPACE_COLORS = ACCOUNT_COLORS;

export type Space = {
  id: string;
  /** The space this pocket is inside; null for a top-level space. */
  parentId: string | null;
  name: string;
  color: string;
  /** A private note on the space (markup, like message bodies). Never sent. */
  note: string | null;
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

/** Conversations being dragged from the list (a JSON array of Kite thread ids). */
export const THREAD_DRAG = "application/x-kite-threads";
