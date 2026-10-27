"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { comboFromEvent, useShortcuts, type ShortcutAction } from "@/lib/shortcuts";

export type KeyHandlers = Partial<Record<ShortcutAction, () => void>>;

/**
 * The app's keyboard shortcuts, resolved through the user's editable bindings. `handlers` is
 * built when a key is pressed (from the latest render), so typing never rebuilds it.
 * - `blocked`: a dialog or picker is open, so only the palette shortcut works.
 * - Compose windows and dialogs handle their own keys; the minimise shortcut works anywhere.
 */
export function useAppKeys(options: {
  locked: boolean;
  blocked: boolean;
  onPalette: () => void;
  onMinimizeCompose: (target: EventTarget | null) => void;
  handlers: () => KeyHandlers;
}) {
  const shortcuts = useShortcuts();
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { locked, blocked, onPalette, onMinimizeCompose, handlers } = latest.current;
      const combo = comboFromEvent(e);
      const action = combo ? shortcuts.actionFor(combo) : undefined;
      if (!action || locked) return;

      if (action === "palette") {
        e.preventDefault();
        onPalette();
        return;
      }
      if (blocked) return;
      if (action === "minimizeCompose") {
        e.preventDefault();
        onMinimizeCompose(e.target);
        return;
      }
      // Compose windows (and their dialogs) handle their own keys; the app's work when focus is elsewhere.
      if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable=true], [data-composer], [role=dialog]")) return;

      const handler = handlers()[action];
      if (handler) {
        e.preventDefault();
        handler();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcuts]);
}
