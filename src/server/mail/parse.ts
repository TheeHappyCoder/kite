import "server-only";

import { serviceFor } from "@/lib/mail/privacy";
import type { Contact } from "@/lib/mail/types";
import type { Unsubscribe } from "./types";

// Helpers every adapter uses to turn a provider's message into Kite's: addresses, plain-text
// paragraphs, tracking pixels, unsubscribe headers.

export function parseAddress(raw: string): Contact {
  const match = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) return { name: match[1].trim() || match[2], email: match[2].trim() };
  const email = raw.trim();
  return { name: email.split("@")[0] || email, email };
}

export function parseAddressList(raw: string): Contact[] {
  if (!raw) return [];
  // Split on commas that are not inside quotes.
  return raw.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(parseAddress).filter((c) => c.email);
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Strips tracking pixels and reports which services they belonged to. */
export function stripTrackers(html: string) {
  const found = new Set<string>();
  let remoteImages = false;
  const cleaned = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = tag.match(/\bsrc\s*=\s*["']?([^"'\s>]+)/i)?.[1] ?? "";
    if (!/^https?:/i.test(src)) return tag;
    let host = "";
    try {
      host = new URL(src).hostname;
    } catch {
      return tag;
    }
    const tiny =
      /\b(width|height)\s*=\s*["']?[01](px)?["'\s>]/i.test(tag) ||
      /(width|height)\s*:\s*[01]px/i.test(tag) ||
      /display\s*:\s*none/i.test(tag);
    const known = serviceFor(host) ?? serviceFor(src);
    if (tiny || (known && /open|track|pixel|beacon|\/o\/|\/e\/|wf\/open/i.test(src))) {
      found.add(known ?? host.replace(/^www\./, ""));
      return "";
    }
    remoteImages = true;
    return tag;
  });
  return { html: cleaned, trackers: [...found], remoteImages };
}

export function toParagraphs(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function decodeEntities(value: string) {
  return value
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** List-Unsubscribe (and List-Unsubscribe-Post) header values to the ways a sender offers. */
export function parseUnsubscribe(raw: string, post: string): Unsubscribe | null {
  if (!raw) return null;
  const urls = [...raw.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  const http = urls.find((u) => /^https:\/\//i.test(u));
  const mailto = urls.find((u) => /^mailto:/i.test(u));
  if (!http && !mailto) return null;
  const oneClick = /One-Click/i.test(post);
  return { http, mailto, oneClick: oneClick && !!http };
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
}

