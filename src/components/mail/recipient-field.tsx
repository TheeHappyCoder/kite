"use client";

import { forwardRef, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { parseRecipients, type Recipient } from "@/lib/mail/compose";
import { blurFade } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { Tooltip } from "../ui/tooltip";
import { Avatar } from "./avatar";

/** Address chips with suggestions from people in your mail. Typed text becomes a chip on , ; Enter or Tab. */
export const RecipientField = forwardRef<
  HTMLInputElement,
  {
    label: string;
    value: Recipient[];
    onChange: (value: Recipient[]) => void;
    search: (query: string) => Promise<Recipient[]>;
    /** Reports text that isn't a valid address yet, so sending can wait for it. */
    onPendingInvalid?: (invalid: boolean) => void;
    autoFocus?: boolean;
    trailing?: React.ReactNode;
  }
>(function RecipientField({ label, value, onChange, search, onPendingInvalid, autoFocus, trailing }, ref) {
  const [text, setText] = useState("");
  const [results, setResults] = useState<{ query: string; list: Recipient[] }>({ query: "", list: [] });
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const query = text.trim();
  const chosen = new Set(value.map((r) => r.email.toLowerCase()));
  const suggestions = open && query && results.query === query ? results.list.filter((r) => !chosen.has(r.email.toLowerCase())) : [];

  useEffect(() => {
    if (!query) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      search(query)
        .then((list) => {
          if (cancelled) return;
          setResults({ query, list });
          setIndex(0);
        })
        .catch(() => {});
    }, 90);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, search]);

  const setPending = (next: string, bad: boolean) => {
    setText(next);
    setInvalid(bad);
    onPendingInvalid?.(bad && !!next.trim());
  };

  const add = (list: Recipient[]) => {
    const fresh = list.filter((r) => !chosen.has(r.email.toLowerCase()));
    if (fresh.length) onChange([...value, ...fresh]);
  };

  /** Turns typed text into chips. What isn't an address stays in the box, marked. */
  const commit = (raw = text) => {
    if (!raw.trim()) return false;
    const { valid, invalid: rest } = parseRecipients(raw);
    add(valid);
    setPending(rest.join(", "), rest.length > 0);
    return valid.length > 0 || rest.length > 0;
  };

  const pick = (r: Recipient) => {
    add([r]);
    setPending("", false);
    setOpen(false);
  };

  return (
    <div className="relative flex min-h-10 items-center gap-3 border-b border-pane-border px-4 py-1.5">
      <span className="w-14 shrink-0 text-[12.5px] text-pane-muted">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {value.map((r, i) => (
          <span
            key={r.email}
            title={r.email}
            className="blur-fade flex h-6 max-w-full items-center gap-1 rounded-full bg-pane-hover pl-1 pr-1 text-[12.5px]"
            style={{ "--blur-fade-duration": "200ms" } as React.CSSProperties}
          >
            <Avatar name={r.name || r.email} email={r.email} className="size-4 text-[7px]" />
            <span className="truncate">{r.name || r.email}</span>
            <Tooltip label={`Remove ${r.name || r.email}`}>
              <button
                aria-label={`Remove ${r.email}`}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
                className="grid size-4 place-items-center rounded-full text-pane-muted hover:bg-pane-border hover:text-pane-fg"
              >
                <Icon icon={Cancel01Icon} size={10} />
              </button>
            </Tooltip>
          </span>
        ))}
        <input
          ref={ref}
          autoFocus={autoFocus}
          value={text}
          aria-label={label}
          aria-invalid={invalid}
          onChange={(e) => {
            const next = e.target.value;
            if (/[,;]\s*$/.test(next)) {
              commit(next.replace(/[,;]\s*$/, ""));
              return;
            }
            setPending(next, false);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            commit();
          }}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text/plain");
            if (/[,;\n]/.test(pasted) || /<[^>]+@/.test(pasted)) {
              e.preventDefault();
              commit(`${text}${pasted}`);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              if (!suggestions.length) return;
              e.preventDefault();
              setIndex((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
            } else if ((e.key === "Enter" || e.key === "Tab") && suggestions.length) {
              e.preventDefault();
              pick(suggestions[Math.min(index, suggestions.length - 1)]);
            } else if (e.key === "Enter" && text.trim()) {
              e.preventDefault();
              commit();
            } else if (e.key === "Tab" && text.trim()) {
              commit();
            } else if (e.key === "Backspace" && !text && value.length) {
              onChange(value.slice(0, -1));
            } else if (e.key === "Escape" && suggestions.length) {
              e.preventDefault();
              setOpen(false);
            }
          }}
          className={cn("h-6 min-w-[120px] flex-1 bg-transparent text-[13px] outline-none", invalid && "text-warning")}
        />
      </div>
      {trailing}

      <AnimatePresence>
        {suggestions.length ? (
          <motion.div
            {...blurFade({ y: 4, blur: 4 })}
            onMouseDown={(e) => e.preventDefault()}
            className="absolute left-[84px] right-4 top-full z-40 mt-1 overflow-hidden rounded-xl border border-pane-border bg-pane p-1 shadow-2xl"
          >
            {suggestions.map((r, i) => (
              <button
                key={r.email}
                onClick={() => pick(r)}
                onMouseEnter={() => setIndex(i)}
                className={cn("flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left", i === index && "bg-pane-hover")}
              >
                <Avatar name={r.name || r.email} email={r.email} className="size-6 text-[9px]" />
                <span className="min-w-0 flex-1 truncate text-[12.5px]">
                  {r.name ? <span className="font-medium">{r.name} </span> : null}
                  <span className="text-pane-muted">{r.email}</span>
                </span>
              </button>
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
});
