"use client";

import { useEffect, useState } from "react";
import type { Preferences } from "@/lib/settings";
import type { SetToast } from "./util";

/**
 * App lock: with a PIN set, Kite opens locked and locks again after `privacy.lockAfter` minutes
 * idle or away. Until the lock check answers (`lockChecked`), the app stays covered so mail never
 * flashes before the lock.
 */
export function useAppLock(preferencesRef: React.RefObject<Preferences>, setToast: SetToast) {
  const [lockOn, setLockOn] = useState(false);
  const [locked, setLocked] = useState(false);
  const [lockChecked, setLockChecked] = useState(false);
  useEffect(() => {
    fetch("/api/lock")
      .then((res) => res.json())
      .then((data: { enabled: boolean }) => {
        setLockOn(data.enabled);
        if (data.enabled) setLocked(true);
      })
      .catch(() => {})
      .finally(() => setLockChecked(true));
  }, []);
  const lockNow = () => {
    if (lockOn) setLocked(true);
    else setToast({ message: "Set a PIN in Settings → Privacy to lock Kite" });
  };
  useEffect(() => {
    if (!lockOn || locked) return;
    const limit = () => preferencesRef.current.privacy.lockAfter * 60_000;
    let last = Date.now();
    let hiddenAt = 0;
    const active = () => {
      last = Date.now();
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > limit()) setLocked(true);
    };
    const timer = setInterval(() => {
      if (Date.now() - last > limit()) setLocked(true);
    }, 10_000);
    window.addEventListener("pointerdown", active);
    window.addEventListener("keydown", active);
    window.addEventListener("wheel", active, { passive: true });
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pointerdown", active);
      window.removeEventListener("keydown", active);
      window.removeEventListener("wheel", active);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [lockOn, locked, preferencesRef]);

  return { lockOn, setLockOn, locked, unlock: () => setLocked(false), lockChecked, lockNow };
}
