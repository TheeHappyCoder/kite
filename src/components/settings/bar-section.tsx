"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { formatDistanceToNow } from "date-fns";
import { Add01Icon, PlugSocketIcon, SparklesIcon } from "@hugeicons/core-free-icons";
import type { Preferences, PreferencesPatch } from "@/lib/settings";
import { blurFade } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { postJson } from "../mail/app/util";
import { CopyIcon, useCopy } from "../ui/copy";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { buttonClass, Confirm, Group, Note, Page, quietButtonClass, Row, ToggleRow } from "./settings-ui";

/*
 * Settings → Kite bar: what Kite shows in the desktop app's Kite bar, how loudly, and the other apps and
 * scripts allowed in (the Kite bar API, docs/bar.md): make one (its token shows once), pause,
 * remove, and a test to see what an integration's activity looks like.
 */

type Integration = { id: string; name: string; hint: string; enabled: boolean; createdAt: string; lastSeen: string | null; live: number };

export function BarSection(props: { preferences: Preferences; onPreferences: (patch: PreferencesPatch) => Promise<void>; desktop: boolean }) {
  const { preferences, onPreferences } = props;
  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [made, setMade] = useState<{ name: string; token: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState(false);

  useEffect(() => {
    let live = true;
    const read = () =>
      fetch("/api/bar/integrations")
        .then((res) => res.json() as Promise<{ integrations: Integration[] }>)
        .then((data) => live && setIntegrations(data.integrations))
        .catch(() => live && setIntegrations([]));
    void read();
    // "Last connected" and the live counts, kept fresh while the page is open.
    const timer = setInterval(read, 15_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const create = () =>
    run(async () => {
      const name = adding?.trim() ?? "";
      const res = await postJson<{ integration: Integration; token: string }>("/api/bar/integrations", { name });
      setIntegrations((all) => [...(all ?? []), res.integration]);
      setMade({ name: res.integration.name, token: res.token });
      setAdding(null);
    });
  const toggle = (integration: Integration, enabled: boolean) =>
    run(async () => {
      const res = await postJson<{ integration: Integration }>("/api/bar/integrations", { id: integration.id, enabled }, "PATCH");
      setIntegrations((all) => all?.map((i) => (i.id === integration.id ? res.integration : i)) ?? null);
    });
  const remove = (id: string) =>
    run(async () => {
      await postJson(`/api/bar/integrations?id=${encodeURIComponent(id)}`, null, "DELETE");
      setIntegrations((all) => all?.filter((i) => i.id !== id) ?? null);
      setRemoving(null);
    });
  const test = () =>
    run(async () => {
      await postJson("/api/bar/test", {});
      setTested(true);
    });

  return (
    <Page icon={PlugSocketIcon} title="Kite bar" description="The strip of sky at the top of your screen in the Kite desktop app: what drops into it, and which apps may use it.">
      {!props.desktop ? <Note>The Kite bar is part of the Kite desktop app. These settings apply there.</Note> : null}

      <Group title="From Kite">
        <ToggleRow
          label="Codes in the Kite bar"
          detail="Sign-in codes and links drop down over every app, ready to copy or open."
          value={preferences.desktop.codeCard}
          onChange={(codeCard) => void onPreferences({ desktop: { codeCard } })}
        />
        <ToggleRow
          label="Important mail in the Kite bar"
          detail="Mail your automations say to notify about now, with Reply (files too), Archive and Open."
          value={preferences.desktop.mailBar}
          onChange={(mailBar) => void onPreferences({ desktop: { mailBar } })}
        />
        <ToggleRow
          label="Meetings starting soon"
          detail="Two minutes before a meeting in your calendar, with Join."
          value={preferences.notifications.meetings}
          onChange={(meetings) => void onPreferences({ notifications: { meetings } })}
        />
      </Group>

      <Group title="How things arrive">
        <ToggleRow
          label="Quiet"
          detail={preferences.bar.quiet ? "Everything arrives resting, as one line. Hover it to open." : "New things drop open for a moment, then rest as one line."}
          value={preferences.bar.quiet}
          onChange={(quiet) => void onPreferences({ bar: { quiet } })}
        />
        <Row
          label="See an integration's activity"
          detail={tested ? "Sent. Look at the top of your screen." : "Sends a sample from Kite itself, the way another app's would look."}
          control={
            <button onClick={() => void test()} disabled={busy} className={buttonClass}>
              <Icon icon={SparklesIcon} size={14} />
              Send a test
            </button>
          }
        />
      </Group>

      <Group
        title="Other apps and scripts"
        description="Anything on this computer with a token can show its own activities: builds, timers, deploys, music, alerts. Nothing it sends can run code or reach the internet."
        action={
          adding === null ? (
            <button onClick={() => setAdding("")} disabled={!preferences.bar.integrations} className={buttonClass}>
              <Icon icon={Add01Icon} size={14} />
              Add integration
            </button>
          ) : null
        }
      >
        <ToggleRow
          label="Let other apps in"
          detail={preferences.bar.integrations ? "Apps with a token can use the Kite bar." : "Off: every token is refused, and nothing from other apps shows."}
          value={preferences.bar.integrations}
          onChange={(integrations) => void onPreferences({ bar: { integrations } })}
        />
        <AnimatePresence initial={false}>
          {adding !== null ? (
            <motion.div key="add" {...blurFade({ y: -4 })} className="flex flex-wrap items-center gap-2 px-4 py-3.5">
              <input
                autoFocus
                value={adding}
                aria-label="Name of the new integration"
                placeholder="Name it after the app or script (“GitHub builds”)"
                onChange={(event) => setAdding(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && adding.trim()) void create();
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setAdding(null);
                  }
                }}
                className="h-9 min-w-0 flex-1 basis-48 rounded-full border border-pane-border bg-pane px-3.5 text-[13px] outline-none focus:border-accent/60 touch:h-11"
              />
              <button onClick={() => setAdding(null)} disabled={busy} className={quietButtonClass}>
                Cancel
              </button>
              <button
                onClick={() => void create()}
                disabled={busy || !adding.trim()}
                className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-pane-fg px-3.5 text-[12.5px] font-medium text-pane disabled:opacity-50 touch:h-11"
              >
                {busy ? <Spinner /> : null}
                Make token
              </button>
            </motion.div>
          ) : null}
          {made ? <TokenCard key="token" made={made} onDone={() => setMade(null)} /> : null}
        </AnimatePresence>
        {integrations === null ? (
          <div className="flex items-center gap-2 px-4 py-3.5 text-[12.5px] text-pane-muted">
            <Spinner /> Loading
          </div>
        ) : (
          integrations.map((integration) => (
            <Row
              key={integration.id}
              label={integration.name}
              detail={
                <>
                  Token …{integration.hint} ·{" "}
                  {integration.lastSeen ? `last connected ${formatDistanceToNow(new Date(integration.lastSeen), { addSuffix: true })}` : "hasn't connected yet"}
                  {integration.live ? ` · ${integration.live} showing` : ""}
                </>
              }
              control={
                <div className="flex items-center gap-2">
                  <button onClick={() => setRemoving(integration.id)} className={quietButtonClass}>
                    Remove
                  </button>
                  <Switch value={integration.enabled} onChange={(enabled) => void toggle(integration, enabled)} label={`${integration.name} on`} />
                </div>
              }
            >
              <AnimatePresence initial={false}>
                {removing === integration.id ? (
                  <Confirm action="Remove" busy={busy} danger onCancel={() => setRemoving(null)} onConfirm={() => void remove(integration.id)}>
                    Its activities leave the Kite bar and its token stops working. Anything still using it will be refused.
                  </Confirm>
                ) : null}
              </AnimatePresence>
            </Row>
          ))
        )}
        {error ? <div className="px-4 py-3 text-[12px] text-warning">{error}</div> : null}
      </Group>
    </Page>
  );
}

/** The new token, shown this once, with what to do with it. */
function TokenCard({ made, onDone }: { made: { name: string; token: string }; onDone: () => void }) {
  const token = useCopy();
  const example = useCopy();
  const origin = typeof window === "undefined" ? "http://127.0.0.1:3100" : window.location.origin;
  const curl = `curl.exe -X POST ${origin}/api/bar/activities -H "Authorization: Bearer ${made.token}" -H "content-type: application/json" -d "{\\"title\\":\\"Hello from ${made.name.replace(/"/g, "")}\\",\\"icon\\":\\"sparkles\\"}"`;
  return (
    <motion.div {...blurFade({ y: -4 })} className="flex flex-col gap-3 px-4 py-3.5">
      <p className="text-[12.5px] leading-snug">
        <span className="font-medium">Token for {made.name}.</span> <span className="text-pane-muted">{"Copy it now: Kite keeps only a fingerprint and can't show it again."}</span>
      </p>
      <div className="flex items-center gap-2 rounded-lg bg-pane-2 py-1.5 pl-3 pr-1.5">
        <code data-sensitive className="min-w-0 flex-1 truncate tabular-nums text-[12px]">
          {made.token}
        </code>
        <button onClick={() => void token.copy(made.token)} className={buttonClass}>
          <CopyIcon copied={token.copied} />
          {token.copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-[12px] leading-snug text-pane-muted">
          Try it from PowerShell, or point your AI assistant at <span className="tabular-nums text-pane-fg">{origin}/api/bar</span>: it describes everything an integration
          can do.
        </p>
        <div className="flex items-start gap-2 rounded-lg bg-pane-2 py-1.5 pl-3 pr-1.5">
          <code data-sensitive className={cn("min-w-0 flex-1 whitespace-pre-wrap break-all py-1 tabular-nums text-[11.5px] leading-relaxed text-pane-muted")}>
            {curl}
          </code>
          <button onClick={() => void example.copy(curl)} className={buttonClass}>
            <CopyIcon copied={example.copied} />
            Copy
          </button>
        </div>
      </div>
      <div className="flex justify-end">
        <button onClick={onDone} className="flex h-8 items-center rounded-full bg-pane-fg px-3.5 text-[12.5px] font-medium text-pane">
          {"I've copied it"}
        </button>
      </div>
    </motion.div>
  );
}
