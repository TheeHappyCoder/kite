"use client";

import { useSyncExternalStore } from "react";
import { DEFAULT_FONTS, FONT_STORAGE_KEY, FONTS, fontOf, type FontChoice, type FontId, type FontRole } from "./fonts";

/** Sets `--font-ui` / `--font-reading` (+ `-features`) on <html>; globals.css reads them. fontScript in fonts.ts does the same before first paint. */
function applyFonts(choice: FontChoice) {
  const style = document.documentElement.style;
  for (const role of ["ui", "reading"] as const) {
    const font = fontOf(choice[role]);
    style.setProperty(`--font-${role}`, `var(${font.cssVar})`);
    style.setProperty(`--font-${role}-features`, font.features);
  }
}

const listeners = new Set<() => void>();
let current: FontChoice | null = null;

function read(): FontChoice {
  if (current) return current;
  let saved: Partial<FontChoice> = {};
  try {
    saved = JSON.parse(localStorage.getItem(FONT_STORAGE_KEY) ?? "{}");
  } catch {}
  const known = (id: unknown): id is FontId => FONTS.some((f) => f.id === id);
  current = { ui: known(saved.ui) ? saved.ui : DEFAULT_FONTS.ui, reading: known(saved.reading) ? saved.reading : DEFAULT_FONTS.reading };
  return current;
}

export function setFont(role: FontRole, id: FontId) {
  current = { ...read(), [role]: id };
  try {
    localStorage.setItem(FONT_STORAGE_KEY, JSON.stringify(current));
  } catch {}
  applyFonts(current);
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The current font choice; re-renders when Settings changes it. */
export function useFonts(): FontChoice {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_FONTS);
}

const faces = new Map<FontId, string>();

/**
 * For the sandboxed email frame, which can't see the app's fonts: the reading font's family and its
 * @font-face rules (Kite's own files, so the frame allows font-src 'self'). Browser only.
 */
export function frameFont(id: FontId): { family: string; features: string; faces: string } {
  const font = fontOf(id);
  const family = getComputedStyle(document.documentElement).getPropertyValue(font.cssVar).trim();
  if (!faces.has(id)) {
    const names = new Set(family.split(",").map((name) => name.trim().replace(/^['"]|['"]$/g, "")));
    const rules: string[] = [];
    const walk = (list: CSSRuleList) => {
      for (const rule of list) {
        if (rule instanceof CSSFontFaceRule) {
          if (!names.has(rule.style.getPropertyValue("font-family").trim().replace(/^['"]|['"]$/g, ""))) continue;
          // Font URLs are relative to their stylesheet; the frame has no such base, so make them absolute.
          const base = rule.parentStyleSheet?.href ?? location.href;
          rules.push(rule.cssText.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (_, url: string) => `url("${new URL(url, base).href}")`));
        } else if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        walk(sheet.cssRules);
      } catch {}
    }
    if (rules.length) faces.set(id, rules.join("\n"));
  }
  return { family: family || "system-ui", features: font.features, faces: faces.get(id) ?? "" };
}
