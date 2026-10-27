"use client";

import { useCallback, useRef, useState } from "react";
import type { ComposeDraft } from "@/lib/mail/compose";
import type { AttachContext } from "../../files/attach-picker";
import { ComposeDock, MAX_COMPOSERS } from "../compose-window";
import type { SetToast } from "./util";

/** An open compose window. `slot` is where it opened; `z` orders the stack (highest in front). */
export type Composer = {
  id: number;
  slot: number;
  z: number;
  minimized: boolean;
  key?: string;
  initial?: Partial<ComposeDraft>;
  context?: AttachContext;
};

const topZ = (list: Composer[]) => Math.max(0, ...list.map((c) => c.z)) + 1;

/** The open compose windows (at most MAX_COMPOSERS): opening, stacking, minimising and closing them. */
export function useComposers(setToast: SetToast) {
  const [composers, setComposers] = useState<Composer[]>([]);
  /** The same list, current between renders (opening checks it before React re-renders). */
  const composersRef = useRef<Composer[]>([]);
  const composerSeq = useRef(0);
  const [composeDock] = useState(() => new ComposeDock());

  const updateComposers = useCallback((change: (list: Composer[]) => Composer[]) => {
    composersRef.current = change(composersRef.current);
    setComposers(composersRef.current);
  }, []);
  /** Brings a compose window to the front (and back from the tray). */
  const frontComposer = useCallback(
    (id: number, restore = false) => {
      const list = composersRef.current;
      const target = list.find((c) => c.id === id);
      if (!target || (target.z === Math.max(...list.map((c) => c.z)) && !(restore && target.minimized))) return;
      const z = topZ(list);
      updateComposers((cs) => cs.map((c) => (c.id === id ? { ...c, z, minimized: restore ? false : c.minimized } : c)));
    },
    [updateComposers],
  );
  const composeFull = useCallback(() => {
    if (composersRef.current.length < MAX_COMPOSERS) return false;
    setToast({ message: `${MAX_COMPOSERS} messages open. Send or close one first.` });
    return true;
  }, [setToast]);
  /**
   * Opens a compose window. `key` names what it's for (a reply to one conversation, say): a window
   * already open for it comes forward instead. `force` opens past the limit (Undo send, so the
   * message is never lost).
   */
  const openCompose = useCallback(
    (initial?: Partial<ComposeDraft>, context?: AttachContext, options?: { key?: string; force?: boolean }) => {
      const existing = options?.key ? composersRef.current.find((c) => c.key === options.key) : undefined;
      if (existing) return frontComposer(existing.id, true);
      if (!options?.force && composeFull()) return;
      const used = new Set(composersRef.current.map((c) => c.slot));
      let slot = 0;
      while (used.has(slot)) slot++;
      const composer: Composer = { id: ++composerSeq.current, slot, z: topZ(composersRef.current), minimized: false, key: options?.key, initial, context };
      updateComposers((cs) => [...cs, composer]);
    },
    [frontComposer, composeFull, updateComposers],
  );
  const closeComposer = useCallback((id: number) => updateComposers((cs) => cs.filter((c) => c.id !== id)), [updateComposers]);
  const minimizeComposer = useCallback(
    (id: number) => updateComposers((cs) => cs.map((c) => (c.id === id ? { ...c, minimized: true } : c))),
    [updateComposers],
  );
  /** The minimise shortcut: minimises the composer with focus, else restores the last one in front. */
  const toggleComposer = useCallback(
    (target: EventTarget | null) => {
      const inside = target instanceof Element ? target.closest("[data-composer]")?.getAttribute("data-composer") : null;
      const focused = composersRef.current.find((c) => String(c.id) === inside && !c.minimized);
      if (focused) {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        return minimizeComposer(focused.id);
      }
      const last = composersRef.current.filter((c) => c.minimized).sort((a, b) => b.z - a.z)[0];
      if (last) frontComposer(last.id, true);
    },
    [minimizeComposer, frontComposer],
  );

  return { composers, composeDock, openCompose, closeComposer, minimizeComposer, frontComposer, toggleComposer, composeFull };
}
