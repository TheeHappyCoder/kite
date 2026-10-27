"use client";

import { memo, useLayoutEffect, useRef, useState, type ComponentType } from "react";

/**
 * Memoises a heavy pane (sidebar, list) that its parent re-renders often. Event props (`on…`)
 * are swapped for stable functions that call the latest prop, so inline handlers in the parent
 * don't defeat the memo; every other prop is compared by identity. Functions called during
 * render (like `labelOf`) must not start with `on`.
 */
export function stableHandlers<P extends object>(Inner: ComponentType<P>) {
  const Memo = memo(Inner) as unknown as ComponentType<P>;
  function Stable(props: P) {
    const latest = useRef(props);
    useLayoutEffect(() => {
      latest.current = props;
    });
    const [proxies] = useState(() => new Map<string, (...args: unknown[]) => unknown>());
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (typeof value === "function" && /^on[A-Z]/.test(key)) {
        let proxy = proxies.get(key);
        if (!proxy) {
          proxy = (...args) => (latest.current as Record<string, (...a: unknown[]) => unknown>)[key]?.(...args);
          proxies.set(key, proxy);
        }
        next[key] = proxy;
      } else next[key] = value;
    }
    return <Memo {...(next as P)} />;
  }
  Stable.displayName = `Stable(${Inner.displayName ?? Inner.name ?? "Component"})`;
  return Stable;
}
