"use client";

import { useCallback, useEffect, useState } from "react";

// Pane theme. The choice lives in localStorage so the inline script in layout.tsx can
// apply it before first paint; "system" follows the OS setting live.

export type ThemePref = "light" | "dark" | "system";
type Theme = "light" | "dark";

const STORAGE_KEY = "kite-theme";
const LIGHT_QUERY = "(prefers-color-scheme: light)";

function readPref(): ThemePref {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {}
  return "system";
}

function systemTheme(): Theme {
  return matchMedia(LIGHT_QUERY).matches ? "light" : "dark";
}

export function useTheme() {
  const [pref, setPrefState] = useState<ThemePref>(readPref);
  const [system, setSystem] = useState<Theme>(systemTheme);
  const theme: Theme = pref === "system" ? system : pref;

  useEffect(() => {
    const media = matchMedia(LIGHT_QUERY);
    const onChange = () => setSystem(media.matches ? "light" : "dark");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const setPref = useCallback((next: ThemePref) => {
    setPrefState(next);
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {}
  }, []);

  const toggle = useCallback(() => setPref(theme === "dark" ? "light" : "dark"), [theme, setPref]);

  return { theme, pref, setPref, toggle };
}
