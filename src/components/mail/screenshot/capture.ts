"use client";

import { domToCanvas } from "modern-screenshot";

/** Largest side of a capture, so a very long conversation can't run the browser out of canvas. */
const MAX_SIDE = 16_000;

/**
 * Draws part of the reader (the conversation, or one message) into a canvas, all of it rather than
 * only what's scrolled into view. Email frames are same-origin, so their documents are drawn inline.
 * Left out: elements marked `data-screenshot-hide` (buttons on the email) and the hidden second frame
 * an email swaps in. Screen privacy's blur doesn't carry into the picture: the user asked for it.
 * Pictures from other sites the email is showing are fetched once more through Kite
 * (/api/screenshot/image), since the browser won't put another site's image in a saved file;
 * pictures still held for privacy stay placeholders.
 */
export async function captureMail(node: HTMLElement): Promise<HTMLCanvasElement> {
  // Entrance fades still running would be copied part-way (a conversation just opened is still
  // fading in): they're finished first.
  for (const animation of node.getAnimations({ subtree: true })) animation.finish();
  // A picture that comes out empty anyway (a frame not drawn yet) gets a couple more goes, a moment apart.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((done) => setTimeout(done, 400));
    const canvas = await draw(node);
    if (!blank(canvas)) return canvas;
  }
  throw new Error("The screenshot came out empty");
}

async function draw(node: HTMLElement) {
  await Promise.all([document.fonts.ready, loadLazyImages(node)]);
  const pane = getComputedStyle(node.closest("section") ?? node).backgroundColor;
  const box = node.getBoundingClientRect();
  const scale = Math.max(1, Math.min(2, window.devicePixelRatio || 1, MAX_SIDE / Math.max(box.width, box.height, 1)));
  return domToCanvas(node, {
    scale,
    backgroundColor: pane,
    maximumCanvasSize: MAX_SIDE,
    timeout: 15_000,
    // Only the fonts this email shows: Kite bundles dozens, and embedding every one makes each capture slow and large.
    font: { cssText: usedFontFaces(node) },
    filter: (el) =>
      !(el instanceof Element) ||
      !(el.hasAttribute("data-screenshot-hide") || (el.tagName === "IFRAME" && el.getAttribute("aria-hidden") === "true")),
    onCloneEachNode: (cloned) => {
      if (!(cloned instanceof HTMLElement)) return;
      // An animation copied into the picture would start again there, from nothing: drawn as it ends.
      cloned.style.animation = "none";
      cloned.style.transition = "none";
      if (cloned.hasAttribute("data-sensitive")) cloned.style.filter = "none";
    },
    fetchFn: async (url) => {
      if (!/^https?:/i.test(url) || new URL(url, location.href).origin === location.origin) return false;
      const res = await fetch(`/api/screenshot/image?url=${encodeURIComponent(url)}`);
      if (!res.ok) throw new Error("Couldn't get a picture");
      return blobToDataUrl(await res.blob());
    },
  });
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Every sampled pixel the same colour: nothing was drawn but the background. */
function blank(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d");
  if (!ctx || !canvas.width || !canvas.height) return true;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const step = Math.max(4, Math.floor(data.length / 4 / 20_000)) * 4;
  for (let i = step; i < data.length; i += step) {
    if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2]) return false;
  }
  return true;
}

/** The family each element draws with first (the one its @font-face rules are named for). */
function firstFamily(el: Element) {
  return getComputedStyle(el).fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "");
}

/** The @font-face rules for the families used inside `node`, its email frames included, with absolute URLs. */
function usedFontFaces(node: HTMLElement) {
  const families = new Set<string>();
  const docs = new Set<Document>([document]);
  const walk = (root: Element) => {
    families.add(firstFamily(root));
    for (const el of root.querySelectorAll("*")) {
      if (el instanceof HTMLIFrameElement && el.contentDocument?.documentElement) {
        docs.add(el.contentDocument);
        walk(el.contentDocument.documentElement);
      } else if (el.childNodes.length) families.add(firstFamily(el));
    }
  };
  walk(node);
  const rules: string[] = [];
  for (const doc of docs) {
    for (const sheet of doc.styleSheets) {
      let list: CSSRuleList;
      try {
        list = sheet.cssRules;
      } catch {
        continue;
      }
      const base = sheet.href ?? doc.baseURI;
      for (const rule of list) {
        if (!(rule instanceof CSSFontFaceRule)) continue;
        const family = rule.style.getPropertyValue("font-family").trim().replace(/^["']|["']$/g, "");
        if (!families.has(family)) continue;
        rules.push(rule.cssText.replace(/url\((["']?)([^"')]+)\1\)/g, (_, q: string, url: string) => `url(${q}${new URL(url, base).href}${q})`));
      }
    }
  }
  return rules.join("\n");
}

/**
 * Pictures the browser hasn't loaded yet because they're out of view (`loading="lazy"`, like avatars
 * in folded messages) would hold the capture until its timeout: they're asked for now, a few seconds at most.
 */
function loadLazyImages(node: HTMLElement) {
  const pending = [...node.querySelectorAll<HTMLImageElement>("img")].filter((img) => !img.complete);
  for (const img of pending) img.loading = "eager";
  const loaded = Promise.all(
    pending.map((img) => new Promise<void>((done) => {
      img.addEventListener("load", () => done(), { once: true });
      img.addEventListener("error", () => done(), { once: true });
    })),
  );
  return Promise.race([loaded, new Promise<void>((done) => setTimeout(done, 3_000))]);
}
