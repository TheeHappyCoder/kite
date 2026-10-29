"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { withSpaces, type ThreadOverride } from "@/lib/mail/overrides";
import type { MailAction, MailState, View } from "@/lib/mail/store";
import type { Thread } from "@/lib/mail/types";
import { placeBeside, placeProblem, siblingsOf, spaceLabel, within, type Space, type SpacePatch } from "@/lib/spaces";
import { postJson, type Reload, type SetToast } from "./util";

const RECENT_KEY = "kite-spaces-recent";

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "That didn't go through. Try again.");
  return data;
}

type Saved = { spaces: unknown[]; items: unknown[] };
type Suggestion = { email: string; name: string };

/**
 * Kite's spaces (lib/spaces.ts) on the client: make, rename, recolour, nest and delete them (with
 * Undo), and put conversations in or take them out. "Move" adds, then archives through the usual
 * path, with one Undo for both. Shown at once, then saved.
 */
export function useSpaces({
  state,
  dispatch,
  setToast,
  reload,
  archiveQuietly,
}: {
  state: MailState;
  dispatch: React.Dispatch<MailAction>;
  setToast: SetToast;
  reload: Reload;
  archiveQuietly: (id: string) => (() => void) | null;
}) {
  const overridesRef = useRef(state.overrides);
  const spacesRef = useRef(state.spaces);
  const viewRef = useRef<View>(state.view);
  useEffect(() => {
    overridesRef.current = state.overrides;
    spacesRef.current = state.spaces;
    viewRef.current = state.view;
  });

  const [recent, setRecent] = useState<string[]>(() => {
    try {
      return (localStorage.getItem(RECENT_KEY) ?? "").split(",").filter(Boolean);
    } catch {
      return [];
    }
  });
  const remember = useCallback((id: string) => {
    setRecent((list) => {
      const next = [id, ...list.filter((x) => x !== id)].slice(0, 8);
      try {
        localStorage.setItem(RECENT_KEY, next.join(","));
      } catch {
        // Storage unavailable: recents last this page load.
      }
      return next;
    });
  }, []);

  const setSpaces = useCallback((spaces: Space[]) => dispatch({ type: "spaces", spaces }), [dispatch]);
  const nameOf = useCallback((id: string) => spaceLabel(spacesRef.current, id) || "that space", []);

  const create = useCallback(
    async (name: string, parentId: string | null = null): Promise<Space | null> => {
      try {
        const res = await send<{ space: Space; spaces: Space[] }>("/api/spaces", "POST", { name, parentId });
        setSpaces(res.spaces);
        return res.space;
      } catch (error) {
        setToast({ message: error instanceof Error ? error.message : "Couldn't make that space." });
        return null;
      }
    },
    [setSpaces, setToast],
  );

  const update = useCallback(
    async (id: string, patch: SpacePatch) => {
      const before = spacesRef.current;
      setSpaces(before.map((s) => (s.id === id ? { ...s, ...patch, note: patch.note === undefined ? s.note : patch.note } : s)));
      try {
        const res = await send<{ spaces: Space[] }>(`/api/spaces/${encodeURIComponent(id)}`, "PATCH", patch);
        setSpaces(res.spaces);
        return true;
      } catch (error) {
        setSpaces(before);
        setToast({ message: error instanceof Error ? error.message : "Couldn't save that." });
        return false;
      }
    },
    [setSpaces, setToast],
  );

  const remove = useCallback(
    async (id: string) => {
      const name = nameOf(id);
      const gone = within(spacesRef.current, id);
      try {
        const res = await send<{ saved: Saved; spaces: Space[] }>(`/api/spaces/${encodeURIComponent(id)}`, "DELETE");
        setSpaces(res.spaces);
        // Out of the conversations' copies too, and away from a view that's gone.
        for (const [thread, override] of Object.entries(overridesRef.current)) {
          if (override.spaces?.some((s) => gone.has(s))) dispatch({ type: "override", id: thread, override: withSpaces(override, override.spaces.filter((s) => !gone.has(s))) });
        }
        const view = viewRef.current;
        if (view.kind === "space" && gone.has(view.spaceId)) dispatch({ type: "view", view: { kind: "mailbox", mailbox: "inbox" } });
        setToast({
          message: `Deleted ${name}. Its mail is where it was`,
          onUndo: () =>
            void send<{ spaces: Space[] }>("/api/spaces", "POST", { restore: res.saved })
              .then((back) => {
                setSpaces(back.spaces);
                reload();
              })
              .catch(() => setToast({ message: "Couldn't bring that space back." })),
        });
      } catch (error) {
        setToast({ message: error instanceof Error ? error.message : "Couldn't delete that space." });
      }
    },
    [nameOf, setSpaces, dispatch, setToast, reload],
  );

  /** Writes conversations' spaces: shown at once, then the server's answer. */
  const write = useCallback(
    async (ids: string[], to: string | null, from: string[]) => {
      const before = new Map(ids.map((id) => [id, overridesRef.current[id]]));
      for (const id of ids) {
        const current = overridesRef.current[id];
        const now = new Set((current?.spaces ?? []).filter((s) => !from.includes(s)));
        if (to) now.add(to);
        dispatch({ type: "override", id, override: withSpaces(current, [...now]) });
      }
      try {
        const res = await postJson<{ memberships: Record<string, string[]>; spaces: Space[]; suggest: Suggestion | null }>("/api/spaces/items", { to, from, threads: ids });
        for (const [id, spaces] of Object.entries(res.memberships)) dispatch({ type: "override", id, override: withSpaces(overridesRef.current[id], spaces) });
        setSpaces(res.spaces);
        return res;
      } catch {
        for (const [id, override] of before) dispatch({ type: "override", id, override: (override as ThreadOverride | undefined) ?? null });
        setToast({ message: "Couldn't change that space. Try again." });
        return null;
      }
    },
    [dispatch, setSpaces, setToast],
  );

  /** "Always": an automation that puts this sender's new mail in the space (and out of the Inbox when it was a move). */
  const always = useCallback(
    async (sender: Suggestion, spaceId: string, move: boolean) => {
      const space = nameOf(spaceId);
      try {
        const res = await postJson<{ rule: { id: string } }>("/api/rules", {
          name: `${sender.name} → ${space}`.slice(0, 60),
          when: "new_mail",
          conditions: [{ kind: "senders", emails: [sender.email], negate: false }],
          actions: [{ verb: "space", space: spaceId }, ...(move ? [{ verb: "archive" }] : [])],
        });
        setToast({
          message: `New mail from ${sender.name} goes to ${space}`,
          onUndo: () => void postJson(`/api/rules/${encodeURIComponent(res.rule.id)}`, {}, "DELETE").catch(() => setToast({ message: "Couldn't remove that automation. It's in Automations." })),
        });
      } catch (error) {
        setToast({ message: error instanceof Error ? error.message : "Couldn't make that automation." });
      }
    },
    [nameOf, setToast],
  );

  /**
   * Puts conversations in a space. `move` also archives the ones in the Inbox; `from` takes them out
   * of other spaces at the same time (moving between pockets). One Undo puts everything back.
   */
  const put = useCallback(
    async (threads: Thread[], spaceId: string, { move = false, from = [] as string[] } = {}) => {
      const list = threads.filter((t) => !t.scheduled);
      if (!list.length) return;
      const fresh = list.filter((t) => !t.spaces?.includes(spaceId)).map((t) => t.id);
      const left = new Map(list.map((t) => [t.id, (t.spaces ?? []).filter((s) => from.includes(s) && s !== spaceId)]));
      remember(spaceId);
      const res = await write(list.map((t) => t.id), spaceId, from);
      if (!res) return;
      const unarchive = move ? list.filter((t) => t.mailbox === "inbox").flatMap((t) => archiveQuietly(t.id) ?? []) : [];
      const what = list.length === 1 ? "" : ` ${list.length} conversations`;
      const suggest = res.suggest;
      setToast({
        message: `${move && unarchive.length ? "Moved" : "Added"}${what} to ${nameOf(spaceId)}`,
        onUndo: () => {
          unarchive.forEach((back) => back());
          if (fresh.length) void write(fresh, null, [spaceId]);
          for (const [id, spaces] of left) for (const s of spaces) void write([id], s, []);
        },
        // Their mail keeps landing here: one tap makes the automation (shown in Automations, with Undo).
        action: suggest ? { label: `Always for ${suggest.name.split(/[\s@]/)[0]}`, run: () => void always(suggest, spaceId, move) } : undefined,
      });
    },
    [nameOf, write, archiveQuietly, remember, setToast, always],
  );

  /** Takes conversations out of a space (and its pockets, when `deep`), with Undo. */
  const takeOut = useCallback(
    async (threads: Thread[], spaceId: string, deep = false) => {
      const ids = deep ? [...within(spacesRef.current, spaceId)] : [spaceId];
      const had = threads.map((t) => ({ id: t.id, spaces: (t.spaces ?? []).filter((s) => ids.includes(s)) })).filter((t) => t.spaces.length);
      if (!had.length) return;
      if (!(await write(had.map((t) => t.id), null, ids))) return;
      setToast({
        message: `Taken out of ${nameOf(spaceId)}`,
        onUndo: () => {
          for (const t of had) for (const s of t.spaces) void write([t.id], s, []);
        },
      });
    },
    [nameOf, write, setToast],
  );

  /** Puts spaces (siblings, in this order). */
  const order = useCallback(
    async (ids: string[]) => {
      const position = new Map(ids.map((id, i) => [id, i]));
      setSpaces(spacesRef.current.map((s) => (position.has(s.id) ? { ...s, position: position.get(s.id)! } : s)));
      try {
        const res = await send<{ spaces: Space[] }>("/api/spaces", "PUT", { order: ids });
        setSpaces(res.spaces);
      } catch {
        setToast({ message: "Couldn't save that order." });
      }
    },
    [setSpaces, setToast],
  );

  /** Moves a space (with its pockets) under `parentId` at that level's `order`: shown at once, then saved. */
  const relocate = useCallback(
    async (id: string, parentId: string | null, nextOrder: string[]): Promise<boolean> => {
      const before = spacesRef.current;
      const position = new Map(nextOrder.map((s, i) => [s, i]));
      setSpaces(before.map((s) => (s.id === id ? { ...s, parentId, position: position.get(s.id) ?? s.position } : position.has(s.id) ? { ...s, position: position.get(s.id)! } : s)));
      try {
        if (before.find((s) => s.id === id)?.parentId !== parentId) await send(`/api/spaces/${encodeURIComponent(id)}`, "PATCH", { parentId });
        const res = await send<{ spaces: Space[] }>("/api/spaces", "PUT", { order: nextOrder });
        setSpaces(res.spaces);
        return true;
      } catch (error) {
        setSpaces(before);
        setToast({ message: error instanceof Error ? error.message : "Couldn't move that space." });
        return false;
      }
    },
    [setSpaces, setToast],
  );

  /**
   * Moves a space (with its pockets) to `parentId` (null: a space of its own) at that level's `order`,
   * with Undo. Refused with the reason when it can't go there.
   */
  const arrange = useCallback(
    async (id: string, parentId: string | null, nextOrder: string[]) => {
      const before = spacesRef.current;
      const space = before.find((s) => s.id === id);
      if (!space) return;
      const problem = placeProblem(before, id, parentId);
      if (problem) {
        setToast({ message: problem });
        return;
      }
      const wasParent = space.parentId;
      const wasOrder = siblingsOf(before, wasParent).map((s) => s.id);
      if (!(await relocate(id, parentId, nextOrder))) return;
      setToast({
        message: wasParent === parentId ? `Moved ${space.name}` : parentId ? `${space.name} is now a pocket in ${nameOf(parentId)}` : `${space.name} is a space of its own now`,
        onUndo: () => void relocate(id, wasParent, wasOrder),
      });
    },
    [relocate, setToast, nameOf],
  );

  /** A space dropped on another: it becomes a pocket there, last in line. */
  const nest = useCallback(
    (id: string, parentId: string) => arrange(id, parentId, [...siblingsOf(spacesRef.current, parentId).map((s) => s.id).filter((s) => s !== id), id]),
    [arrange],
  );

  /** A space dropped in the gap before or after another: beside it, at its level. */
  const placeNear = useCallback(
    (id: string, targetId: string, before: boolean) => {
      const { parentId, order: next } = placeBeside(spacesRef.current, id, targetId, before);
      return arrange(id, parentId, next);
    },
    [arrange],
  );

  return { recent, create, update, remove, put, takeOut, order, nest, placeNear };
}

export type SpacesApi = ReturnType<typeof useSpaces>;
