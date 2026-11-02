"use client";

import { Cancel01Icon, SignatureIcon } from "@hugeicons/core-free-icons";
import type { Design } from "@/lib/design/spec";
import type { Signature } from "@/lib/settings";
import { Icon } from "../icon";
import { Select } from "../ui/select";
import { Tooltip } from "../ui/tooltip";
import { DesignPreview } from "./design-preview";

/**
 * The signature under a message being written, with a way to leave it off this one and,
 * when the account has several, to pick another.
 */
export function SignatureSlot({
  design,
  onRemove,
  list,
  current,
  onPick,
}: {
  design: Design;
  onRemove: () => void;
  list?: Signature[];
  current?: string | null;
  onPick?: (id: string) => void;
}) {
  return (
    <div className="blur-fade group relative">
      <DesignPreview design={design} className="max-h-[180px] overflow-hidden p-2" />
      {list && list.length > 1 && onPick && current ? (
        <div className="absolute left-1.5 top-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <Select
            label="Signature"
            value={current}
            options={list.map((s) => ({ value: s.id, label: s.name }))}
            onChange={onPick}
            className="h-6 bg-pane text-[11.5px]"
          />
        </div>
      ) : null}
      <Tooltip label="Leave signature off" side="left">
        <button
          type="button"
          onClick={onRemove}
          aria-label="Leave signature off"
          className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full border border-pane-border bg-pane text-pane-muted opacity-0 transition-opacity hover:text-pane-fg focus:opacity-100 group-hover:opacity-100"
        >
          <Icon icon={Cancel01Icon} size={12} />
        </button>
      </Tooltip>
    </div>
  );
}

/** Where a signature was left off: one quiet button puts it (or, with several, the one picked) back. */
export function AddSignature({ list, onPick }: { list: Signature[]; onPick: (id: string) => void }) {
  if (!list.length) return null;
  if (list.length === 1) {
    return (
      <button
        type="button"
        onClick={() => onPick(list[0].id)}
        className="flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] text-pane-muted transition-colors hover:bg-pane-hover hover:text-pane-fg"
      >
        <Icon icon={SignatureIcon} size={14} />
        Add signature
      </button>
    );
  }
  return (
    <Select
      label="Add a signature"
      value={"" as string}
      options={[{ value: "", label: "Add signature" }, ...list.map((s) => ({ value: s.id, label: s.name }))]}
      onChange={(id) => id && onPick(id)}
      variant="borderless"
      className="h-7 text-[12px] text-pane-muted"
    />
  );
}
