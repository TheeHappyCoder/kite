"use client";

import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { type StorageInfo } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { Confirm, Group, Row, buttonClass } from "./settings-ui";
import { Spinner } from "../ui/spinner";
import { formatBytes } from "@/lib/format";
import { request } from "./settings-ui";

export function DataSection({
  storage,
  onChanged,
  onToast,
}: {
  storage: StorageInfo | null;
  onChanged: (storage: StorageInfo) => void;
  onToast: (message: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<"reset-cache" | "clear-avatars" | null>(null);

  const run = async (action: "reset-cache" | "clear-avatars") => {
    setBusy(action);
    try {
      const res = await request<{ storage: StorageInfo }>("/api/settings", "POST", { action });
      onChanged(res.storage);
      onToast(action === "reset-cache" ? "Local copy cleared. Downloading your mail again." : "Pictures and files cleared");
      setConfirming(false);
    } catch {
      onToast("That didn't go through. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const stats: [string, string][] = storage
    ? [
        ["Mail database", formatBytes(storage.database)],
        ["Pictures and files", formatBytes(storage.avatars + (storage.attachments ?? 0))],
        ["Conversations", storage.threads.toLocaleString()],
        ["Readable offline", storage.offline.toLocaleString()],
      ]
    : [];

  return (
    <>
      <Group title="On this computer" bare>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,9rem),1fr))] gap-2">
          {(stats.length ? stats : [["", ""], ["", ""], ["", ""], ["", ""]]).map(([label, value], i) => (
            <div key={i} className="rounded-xl border border-pane-border px-3.5 py-3">
              {label ? (
                <div key={value} className="blur-fade">
                  <p className="text-[18px] font-semibold tabular-nums tracking-tight">{value}</p>
                  <p className="mt-0.5 text-[11.5px] text-pane-muted">{label}</p>
                </div>
              ) : (
                <div className="h-[45px] animate-pulse rounded-md bg-pane-2" />
              )}
            </div>
          ))}
        </div>
      </Group>

      <Group title="Maintenance">
        <Row
          label="Clear pictures and files"
          detail="Sender pictures and opened attachments. Fetched again when needed."
          control={
            <button onClick={() => void run("clear-avatars")} disabled={busy != null} className={buttonClass}>
              {busy === "clear-avatars" ? <Spinner /> : null}
              Clear
            </button>
          }
        />
        <Row
          label="Reset local copy"
          detail="Fixes mail that looks out of date by downloading it again."
          control={
            <button onClick={() => setConfirming(true)} disabled={busy != null || confirming} className={buttonClass}>
              Reset
            </button>
          }
        >
          <AnimatePresence initial={false}>
            {confirming ? (
              <Confirm action="Reset and download" busy={busy === "reset-cache"} onCancel={() => setConfirming(false)} onConfirm={() => void run("reset-cache")}>
                Removes the local copy of your mail. Accounts, Screener decisions, automations and their collections, snoozes and scheduled sends are kept.
              </Confirm>
            ) : null}
          </AnimatePresence>
        </Row>
      </Group>

      <Group title="Start over">
        <EraseRow onToast={onToast} />
      </Group>
    </>
  );
}

/** Erases everything Kite keeps and disconnects every account, after an inline confirm. */
function EraseRow({ onToast }: { onToast: (message: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const erase = async () => {
    setBusy(true);
    try {
      await request("/api/settings", "POST", { action: "erase-everything" });
      try {
        for (const key of Object.keys(localStorage)) if (key.startsWith("kite-")) localStorage.removeItem(key);
      } catch {}
      window.location.reload();
    } catch {
      setBusy(false);
      onToast("Kite couldn't erase everything. Try again.");
    }
  };
  return (
    <Row
      label="Erase everything"
      detail="Disconnects every account and deletes all mail, settings, automations and files Kite keeps here."
      control={
        <button onClick={() => setConfirming(true)} disabled={busy || confirming} className={cn(buttonClass, "text-warning")}>
          Erase
        </button>
      }
    >
      <AnimatePresence initial={false}>
        {confirming ? (
          <Confirm action="Erase everything" danger busy={busy} onCancel={() => setConfirming(false)} onConfirm={() => void erase()}>
            This can&apos;t be undone. Your mail stays with your provider.
          </Confirm>
        ) : null}
      </AnimatePresence>
    </Row>
  );
}
