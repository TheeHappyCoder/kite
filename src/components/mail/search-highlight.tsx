"use client";
import { createContext, useContext, useEffect, type RefObject } from "react";
import { parseSearch } from "@/lib/mail/search";
export const SearchQuery = createContext("");
export function highlightSearch(root: HTMLElement, query: string) {
  const doc = root.ownerDocument;
  const view = doc.defaultView as (Window & { Highlight?: new (...ranges: Range[]) => Highlight; CSS?: typeof CSS }) | null;
  if (!view?.Highlight || !view.CSS?.highlights) return;
  // Install at runtime: the build CSS parser does not support named highlights yet.
  if (!doc.getElementById("kite-search-style")) {
    const style = doc.createElement("style");
    style.id = "kite-search-style";
    style.textContent = "::highlight(kite-search){background:#fde68a;color:#171717}";
    doc.head.append(style);
  }
  const words = parseSearch(query).filter((t) => !t.negate && ["text", "subject"].includes(t.field)).map((t) => t.value).filter(Boolean);
  if (!words.length) {
    view.CSS.highlights.delete("kite-search");
    return;
  }
  const patterns = words.map((word) => new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"));
  const ranges: Range[] = [];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode()) && ranges.length < 2000) {
    if (node.parentElement?.closest('script,style,textarea,input,button,[contenteditable="true"]')) continue;
    const text = node.textContent ?? "";
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        if (ranges.length >= 2000) break;
        const range = doc.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        ranges.push(range);
      }
    }
  }
  view.CSS.highlights.set("kite-search", new view.Highlight(...ranges));
}
export function useSearchHighlight(ref: RefObject<HTMLElement | null>, query: string, key: string) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const refresh = () => highlightSearch(root, query);
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => { observer.disconnect(); CSS.highlights?.delete("kite-search"); };
  }, [ref, query, key]);
}
export const useSearchQuery = () => useContext(SearchQuery);
