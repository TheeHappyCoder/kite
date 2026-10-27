"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Alert02Icon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { designPrompt, fixPrompt, parseDesign, type DesignAsset, type DesignKind } from "@/lib/design/prompt";
import type { Design } from "@/lib/design/spec";
import { blurFade } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";

import { CopyIcon } from "../ui/copy";
/**
 * Lets any AI the user already uses design for Kite: copy a prompt that teaches it the
 * format, paste the reply back. Nothing is sent anywhere by Kite.
 */
export function PromptKit({
  kind,
  current,
  assets,
  sender,
  onApply,
}: {
  kind: DesignKind;
  current: Design | null;
  assets: DesignAsset[];
  sender: { name: string; email: string };
  onApply: (design: Design) => void;
}) {
  const [request, setRequest] = useState("");
  const [includeCurrent, setIncludeCurrent] = useState(true);
  const [reply, setReply] = useState("");
  const [errors, setErrors] = useState<string[] | null>(null);
  const [copied, setCopied] = useState<"prompt" | "fix" | null>(null);
  const [applied, setApplied] = useState(false);

  const copy = async (text: string, which: "prompt" | "fix") => {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(which);
    setTimeout(() => setCopied((c) => (c === which ? null : c)), 1800);
  };

  const use = () => {
    const result = parseDesign(reply, assets.map((a) => a.id));
    if (result.ok) {
      onApply(result.design);
      setErrors(null);
      setApplied(true);
      setReply("");
      setTimeout(() => setApplied(false), 2200);
    } else {
      setErrors(result.errors);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <Step n={1} title="Describe it" detail="Say what you want, in your own words.">
        <textarea
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          rows={3}
          placeholder="e.g. Minimal, my logo on the left, name and role on the right, a teal accent, and a link to book a call"
          className={areaClass}
        />
        {current ? (
          <label className="mt-2 flex items-center gap-2 text-[12px] text-pane-muted">
            <input type="checkbox" checked={includeCurrent} onChange={(e) => setIncludeCurrent(e.target.checked)} className="accent-[var(--accent)]" />
            Start from the current design
          </label>
        ) : null}
      </Step>

      <Step n={2} title="Copy the prompt into your AI" detail="Claude, ChatGPT, Gemini or any other. It explains Kite's format and lists your images.">
        <button
          onClick={() => copy(designPrompt({ kind, request, current: includeCurrent ? current : null, assets, sender }), "prompt")}
          className={primaryClass}
        >
          <CopyIcon copied={copied === "prompt"} tint={false} />
          {copied === "prompt" ? "Copied" : "Copy prompt"}
        </button>
      </Step>

      <Step n={3} title="Paste what it replies" detail="Code fences and extra text around it are fine.">
        <textarea
          value={reply}
          onChange={(e) => {
            setReply(e.target.value);
            setErrors(null);
          }}
          rows={5}
          placeholder='{ "version": "kite-design/1", … }'
          className={cn(areaClass, "tabular-nums text-[11.5px]")}
        />
        <div className="mt-2 flex items-center gap-2">
          <button onClick={use} disabled={!reply.trim()} className={primaryClass}>
            Use this design
          </button>
          <AnimatePresence>
            {applied ? (
              <motion.span {...blurFade({ x: -4, blur: 3 })} className="flex items-center gap-1 text-[12px] text-success">
                <Icon icon={CheckmarkCircle02Icon} size={13} /> Applied. Check the preview
              </motion.span>
            ) : null}
          </AnimatePresence>
        </div>
      </Step>

      <AnimatePresence>
        {errors ? (
          <motion.div {...blurFade({ y: -4 })} className="rounded-xl bg-warning/10 p-3">
            <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-warning">
              <Icon icon={Alert02Icon} size={14} /> Kite couldn&apos;t use that yet
            </p>
            <ul className="mt-1.5 flex flex-col gap-0.5 pl-5 text-[12px] leading-snug text-pane-fg/80 [list-style:disc]">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
            <button onClick={() => copy(fixPrompt(errors), "fix")} className={cn(primaryClass, "mt-2.5")}>
              <CopyIcon copied={copied === "fix"} tint={false} />
              {copied === "fix" ? "Copied. Paste it into the same chat" : "Copy fix prompt"}
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

const areaClass =
  "block w-full resize-y rounded-lg border border-pane-border bg-pane-2 px-2.5 py-2 text-[12.5px] leading-5 outline-none placeholder:text-pane-muted/80 focus:border-accent/60";
const primaryClass =
  "flex h-8 w-fit items-center gap-1.5 rounded-full bg-pane-fg px-3.5 text-[12.5px] font-medium text-pane transition-opacity hover:opacity-90 disabled:opacity-40";

function Step({ n, title, detail, children }: { n: number; title: string; detail: string; children: React.ReactNode }) {
  return (
    <section className="flex gap-3">
      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">{n}</span>
      <div className="min-w-0 flex-1">
        <h3 className="text-[13px] font-medium">{title}</h3>
        <p className="mb-2 mt-0.5 text-[12px] text-pane-muted">{detail}</p>
        {children}
      </div>
    </section>
  );
}
