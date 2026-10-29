"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { TranslateIcon } from "@hugeicons/core-free-icons";
import { formatBytes } from "@/lib/format";
import { htmlToText, paragraphs, unwrap, type splitMessage } from "@/lib/mail/quotes";
import type { Message } from "@/lib/mail/types";
import { translateHtml } from "@/lib/translate/engine";
import { languageName, ownLanguage, type TranslateState } from "@/lib/translate/languages";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { Spinner } from "../ui/spinner";

// Translate in the reader (lib/translate): a quiet line under a message written in another language,
// "Translate" in place on this computer, then "Show original". The first time for a language Kite asks
// before downloading it from Mozilla. `t` (or the palette) translates the newest message.

/**
 * What the reader needs to know: the target, whether to offer, and `register`: the newest message
 * hands in what the shortcut does (mail-app calls it on `t`); returns the unregister.
 */
export type TranslateSettings = { to: string; offer: boolean; register: (handler: () => void) => () => void };
export const TranslateContext = createContext<TranslateSettings>({ to: "", offer: true, register: () => () => {} });

/** The language messages go into: the preference, else the user's own. */
export const targetOf = (to: string) => to || ownLanguage();

/** How long a message stays open before its language is worked out. */
const DETECT_AFTER_MS = 400;

/** The language of a message's text, worked out by Kite's own server (the statistics stay out of the window). */
const detected = new Map<string, Promise<string | null>>();
function detect(text: string) {
  const sample = text.replace(/\s+/g, " ").trim().slice(0, 1500);
  // Too short to tell (the server would say so too): no request.
  if (sample.length < 40) return Promise.resolve(null);
  let found = detected.get(sample);
  if (!found) {
    found = fetch("/api/translate/detect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: sample }) })
      .then((res) => (res.ok ? (res.json() as Promise<{ language: string | null }>) : { language: null }))
      .then((data) => data.language)
      .catch(() => null);
    detected.set(sample, found);
  }
  return found;
}

/** What can be translated into each target, read once per target (again after a download or removal). */
const states = new Map<string, Promise<TranslateState>>();
export function translateStateFor(target: string, fresh = false) {
  if (fresh) states.delete(target);
  let state = states.get(target);
  if (!state) {
    state = fetch(`/api/translate?to=${target}`).then(async (res) => {
      const data = (await res.json().catch(() => ({}))) as TranslateState & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't read which languages Kite can translate.");
      return data;
    });
    state.catch(() => states.delete(target));
    states.set(target, state);
  }
  return state;
}

type Phase =
  | { kind: "idle" }
  | { kind: "confirm"; size: number }
  | { kind: "working"; downloading: boolean }
  | { kind: "shown" }
  | { kind: "original" }
  | { kind: "same" }
  | { kind: "error"; message: string };

/** A translation of the message's new text: HTML for HTML mail, paragraphs for plain text. */
export type Translated = { html: string } | { paragraphs: string[] };

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Translation for one message: the line to show (or null) and, while it's shown, the translated new
 * text. `newest`: the message the shortcut translates.
 */
export function useMessageTranslation(message: Message, split: ReturnType<typeof splitMessage>, newest: boolean) {
  const { to, offer, register } = useContext(TranslateContext);
  const target = targetOf(to);
  const [language, setLanguage] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [result, setResult] = useState<Translated | null>(null);
  // Whether the user asked (the shortcut): then the line shows even with offers off.
  const [asked, setAsked] = useState(false);
  const source = split.html ? split.html.fresh : split.text.fresh;

  // Once the message has stayed open a moment: moving through the list with j / k reads nothing for the ones passed by.
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void detect(split.html ? htmlToText(split.html.fresh) : split.text.fresh).then((found) => {
        if (live) setLanguage(found);
      });
    }, DETECT_AFTER_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [split]);

  const run = async (from: string) => {
    setPhase({ kind: "working", downloading: false });
    try {
      const state = await translateStateFor(target);
      const entry = state.languages.find((l) => l.code === from);
      if (!entry) throw new Error(`Kite can't translate ${languageName(from)} into ${languageName(target)} on this computer yet.`);
      if (!entry.installed) setPhase({ kind: "working", downloading: true });
      if (split.html) {
        const html = await translateHtml(source, from, target);
        setResult({ html });
      } else {
        const html = paragraphs(source)
          .map((p) => `<p>${escapeHtml(unwrap(p))}</p>`)
          .join("");
        const translated = await translateHtml(html, from, target);
        const doc = new DOMParser().parseFromString(translated, "text/html");
        setResult({ paragraphs: [...doc.querySelectorAll("p")].map((p) => p.textContent ?? "") });
      }
      if (!entry.installed) void translateStateFor(target, true);
      setPhase({ kind: "shown" });
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : "Couldn't translate this." });
    }
  };

  /** Translate: straight away when the language is here, else ask before the download. */
  const translate = async () => {
    if (!language) return;
    if (result) return setPhase({ kind: "shown" });
    try {
      const state = await translateStateFor(target);
      const entry = state.languages.find((l) => l.code === language);
      if (entry && !entry.installed) return setPhase({ kind: "confirm", size: entry.download });
    } catch {
      // Offline: try anyway, the error explains.
    }
    void run(language);
  };

  // The shortcut: the newest message translates (or flips back to the original). The handler reads
  // the latest state through a ref, so registering happens once per message.
  const shortcut = useRef<() => void>(() => {});
  useEffect(() => {
    shortcut.current = () => {
      setAsked(true);
      if (!language || language === target) return setPhase({ kind: "same" });
      if (phase.kind === "shown") setPhase({ kind: "original" });
      else void translate();
    };
  });
  useEffect(() => (newest ? register(() => shortcut.current()) : undefined), [newest, register]);

  const foreign = language !== null && language !== target;
  const visible = phase.kind === "same" ? asked : foreign && (offer || asked || phase.kind !== "idle");
  const name = language ? languageName(language) : "";
  const into = languageName(target);

  const line = !visible ? null : (
    <div data-screenshot-hide className="blur-fade mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-[12.5px] text-pane-muted">
      <Icon icon={TranslateIcon} size={14} className="shrink-0" />
      {phase.kind === "idle" ? (
        <>
          <span>Written in {name}</span>
          <LineButton onClick={() => void translate()}>Translate to {into}</LineButton>
        </>
      ) : phase.kind === "confirm" ? (
        <>
          <span className="min-w-0">
            {name} translates on this PC. Download it once from Mozilla ({formatBytes(phase.size)})?
          </span>
          <span className="flex gap-1.5">
            <LineButton onClick={() => setPhase({ kind: "idle" })}>Not now</LineButton>
            <LineButton primary onClick={() => language && void run(language)}>
              Download and translate
            </LineButton>
          </span>
        </>
      ) : phase.kind === "working" ? (
        <span className="flex items-center gap-1.5">
          <Spinner size={12} />
          {phase.downloading ? `Downloading ${name}…` : "Translating on this PC…"}
        </span>
      ) : phase.kind === "shown" ? (
        <>
          <span>Translated from {name} on this PC</span>
          <LineButton onClick={() => setPhase({ kind: "original" })}>Show original</LineButton>
        </>
      ) : phase.kind === "original" ? (
        <>
          <span>Written in {name}</span>
          <LineButton onClick={() => setPhase({ kind: "shown" })}>Show translation</LineButton>
        </>
      ) : phase.kind === "same" ? (
        <span>{language ? `Already in ${into}.` : "Kite can't tell which language this is."}</span>
      ) : (
        <>
          <span className="min-w-0 text-danger">{phase.message}</span>
          <LineButton onClick={() => language && void run(language)}>Try again</LineButton>
        </>
      )}
    </div>
  );

  return { line, translated: phase.kind === "shown" ? result : null };
}

function LineButton({ primary, onClick, children }: { primary?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "h-7 shrink-0 rounded-full px-3 text-[12.5px] font-medium transition-colors duration-150 touch:h-9",
        primary ? "bg-accent text-accent-fg hover:bg-accent/90" : "bg-pane-2 text-pane-fg hover:bg-pane-hover",
      )}
    >
      {children}
    </button>
  );
}
