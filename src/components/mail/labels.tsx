"use client";

import { useState } from "react";
import { Command } from "cmdk";
import { Add01Icon, Folder01Icon, MinusSignIcon, Tag01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { Account, Thread } from "@/lib/mail/types";
import { accountSpec, canManage, labelDepth, leafName, serviceName, sortLabels, type LabelKind, type MailLabel, type ProviderSpec } from "@/lib/mail/providers";
import { Spinner } from "../ui/spinner";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";

import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { capitalise } from "@/lib/format";
/** Looks a label up by account and provider id. */
export type LabelLookup = (accountId: string, id: string) => MailLabel | undefined;

export function labelKey(accountId: string, id: string) {
  return `${accountId}\u0000${id}`;
}

/** A label's mark: a folder icon for folders, its colour dot for tags. */
function LabelMark({ label, size }: { label: MailLabel; size: "chip" | "row" }) {
  if (label.kind === "folder") {
    return (
      <span className="shrink-0" style={label.color ? { color: label.color } : undefined}>
        <Icon icon={Folder01Icon} size={size === "chip" ? 10 : 13} />
      </span>
    );
  }
  return <span className={cn("shrink-0 rounded-full", size === "chip" ? "size-1.5" : "size-2")} style={{ background: label.color ?? "var(--pane-muted)" }} />;
}

/** A label as a small pill: its colour (when the provider stores one) or folder icon, and its last name part. */
export function LabelChip({ label, spec, onClick, className }: { label: MailLabel; spec: ProviderSpec; onClick?: () => void; className?: string }) {
  const content = (
    <>
      <LabelMark label={label} size="chip" />
      <span className="truncate">{leafName(label, spec)}</span>
    </>
  );
  const classes = cn(
    "inline-flex max-w-[140px] items-center gap-1 rounded-full border border-pane-border px-1.5 py-px text-[10.5px] font-medium text-pane-muted",
    onClick && "transition-colors hover:border-accent/50 hover:text-pane-fg",
    className,
  );
  const title = label.kind === "folder" ? `In ${label.name}` : label.name;
  return onClick ? (
    <button
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={classes}
    >
      {content}
    </button>
  ) : (
    <span title={title} className={classes}>
      {content}
    </span>
  );
}


/**
 * Picks labels for one or more conversations of one account. Tags toggle: added to every
 * conversation, or removed when all already carry it. Folders pick like radios (a message is in
 * one): choosing one moves the conversations there. A name that isn't there yet can be made
 * (`onCreate`, where the provider allows it) and is then applied. Providers Kite can't change yet
 * get a plain explanation instead.
 */
export function LabelPicker({
  threads,
  account,
  labels,
  onClose,
  onChange,
  onCreate,
}: {
  /** Null when closed. */
  threads: Thread[] | null;
  account: Account | undefined;
  /** This account's labels. */
  labels: MailLabel[];
  onClose: () => void;
  onChange: (change: { add: string[]; remove: string[] }) => void;
  /** Makes a label/folder of this account (live accounts only); rejects with the reason to show. */
  onCreate?: (input: { name: string; kind: LabelKind }) => Promise<MailLabel>;
}) {
  const [query, setQuery] = useState("");
  const [making, setMaking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const spec = accountSpec(account);
  const service = serviceName(account);
  const { noun, plural } = spec.organise;
  const sorted = sortLabels(labels, spec);
  const kinds = new Set(sorted.map((l) => l.kind));
  // With none yet, the footer says what the provider's kinds would do.
  const described = kinds.size ? kinds : new Set((["folder", "tag"] as const).filter((k) => spec.organise[k]));
  const open = !!threads?.length;
  const count = (id: string) => threads?.filter((t) => t.labels?.includes(id)).length ?? 0;
  const searching = !!query.trim();
  const close = () => {
    setQuery("");
    setProblem(null);
    onClose();
  };
  // "Make “…”": offered while the name typed isn't one of this account's, for each kind it can make.
  const typed = query.trim();
  const makeKinds = onCreate && typed && !labels.some((l) => l.name.toLowerCase() === typed.toLowerCase())
    ? (["folder", "tag"] as const).filter((kind) => spec.organise[kind] && canManage(spec, "create", kind))
    : [];
  const make = async (kind: LabelKind) => {
    if (!onCreate || making) return;
    setMaking(true);
    setProblem(null);
    try {
      const label = await onCreate({ name: typed, kind });
      setQuery("");
      onChange({ add: [label.id], remove: [] });
      if (kind === "folder") close();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "That didn't go through. Try again.");
    } finally {
      setMaking(false);
    }
  };

  const group = (kind: LabelKind) => {
    const own = sorted.filter((l) => l.kind === kind);
    if (!own.length) return null;
    const items = own.map((label) => {
      const n = count(label.id);
      const all = !!threads && n === threads.length;
      const folder = label.kind === "folder";
      return (
        <Command.Item
          {...FLUID_ITEM}
          key={label.id}
          value={`${label.name} ${label.id}`}
          onSelect={() => {
            if (!folder) return onChange(all ? { add: [], remove: [label.id] } : { add: [label.id], remove: [] });
            // Already all in it: nothing to move.
            if (!all) onChange({ add: [label.id], remove: [] });
            close();
          }}
          className="relative flex h-9 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-[13px] touch:h-11"
        >
          {/* One child: cmdk hands an Item's children on as one array, which React then wants keys for. */}
          <>
          {folder ? (
            <span
              className={cn("grid size-4 shrink-0 place-items-center rounded-full border", n ? "border-accent" : "border-pane-muted/60")}
              role="radio"
              aria-checked={all}
            >
              {n ? <span className={cn("rounded-full bg-accent", all ? "size-2" : "h-0.5 w-2")} /> : null}
            </span>
          ) : (
            <span
              className={cn("grid size-4 shrink-0 place-items-center rounded-[5px] border", n ? "border-accent bg-accent text-accent-fg" : "border-pane-muted/60")}
              role="checkbox"
              aria-checked={all ? true : n ? "mixed" : false}
            >
              {all ? <Icon icon={Tick02Icon} size={12} strokeWidth={2.5} /> : n ? <Icon icon={MinusSignIcon} size={12} strokeWidth={2.5} /> : null}
            </span>
          )}
          <LabelMark label={label} size="row" />
          <span className="min-w-0 flex-1 truncate" style={searching ? undefined : { paddingLeft: labelDepth(label, spec) * 14 }} title={label.name}>
            {searching ? label.name : leafName(label, spec)}
          </span>
          </>
        </Command.Item>
      );
    });
    const heading = kinds.size > 1 ? capitalise(spec.organise[kind]?.plural ?? plural) : undefined;
    return heading ? (
      <Command.Group heading={heading}>{items}</Command.Group>
    ) : (
      items
    );
  };

  const folderWords = spec.organise.folder;
  const tagWords = spec.organise.tag;
  const footer =
    described.has("folder") && described.has("tag") && folderWords && tagWords
      ? `${capitalise(folderWords.plural)} move the conversation there; ${tagWords.plural} stay with it. Changes ${service} at once.`
      : described.has("folder")
        ? `Moves the conversation into that ${folderWords?.noun ?? noun}. Changes ${service} at once.`
        : `Changes ${service} at once. Conversations stay where they are.`;

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      label={`Choose ${plural}`}
      overlayClassName="blur-fade fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]"
      contentClassName="blur-fade-down fixed inset-x-0 top-[18%] z-50 mx-auto w-[440px] max-w-[calc(100vw-32px)] overflow-hidden rounded-2xl border border-pane-border bg-pane text-pane-fg shadow-2xl"
    >
      <div className="border-b border-pane-border px-4 pb-2 pt-3">
        <p className="truncate text-[12px] text-pane-muted">
          {threads && threads.length > 1 ? `${threads.length} conversations` : `“${threads?.[0]?.subject ?? ""}”`}
          {account ? ` · ${account.email}` : ""}
        </p>
      </div>
      {spec.labelsSupported ? (
        <>
          <Command.Input
            value={query}
            onValueChange={setQuery}
            placeholder={`Find a ${noun}…`}
            className="h-12 w-full border-b border-pane-border bg-transparent px-4 text-[14px] outline-none placeholder:text-pane-muted"
          />
          <Command.List className="scroll-fade max-h-[340px] overflow-y-auto p-2 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-pane-muted">
            <Command.Empty className="px-3 py-6 text-center text-[13px] text-pane-muted">
              {labels.length ? `No ${plural} match.` : `This account has no ${plural} yet.${onCreate ? " Type a name to make one." : ""}`}
            </Command.Empty>
            <FluidList tone="pane" follow="[data-selected=true]">
              {group("folder")}
              {group("tag")}
              {makeKinds.map((kind) => (
                <Command.Item
                  {...FLUID_ITEM}
                  key={`make-${kind}`}
                  forceMount
                  value={`make ${kind} ${typed}`}
                  disabled={making}
                  onSelect={() => void make(kind)}
                  className="relative flex h-9 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-[13px] touch:h-11"
                >
                  <span className="grid size-4 shrink-0 place-items-center text-accent">{making ? <Spinner size={13} /> : <Icon icon={Add01Icon} size={14} />}</span>
                  <span className="min-w-0 flex-1 truncate">
                    Make the {spec.organise[kind]?.noun ?? noun} <span className="font-medium">“{typed}”</span>
                  </span>
                </Command.Item>
              ))}
            </FluidList>
          </Command.List>
          <p className={cn("border-t border-pane-border px-4 py-2 text-[11.5px]", problem ? "text-warning" : "text-pane-muted")}>{problem ?? footer}</p>
        </>
      ) : (
        <div className="flex items-center gap-3 px-4 py-6 text-[13px] text-pane-muted">
          <Icon icon={Tag01Icon} size={18} />
          Kite can&apos;t change {service} {plural} yet.
        </div>
      )}
    </Command.Dialog>
  );
}
