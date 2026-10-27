"use client";

import { Cancel01Icon } from "@hugeicons/core-free-icons";
import type { Design } from "@/lib/design/spec";
import { Icon } from "../icon";
import { Tooltip } from "../ui/tooltip";
import { DesignPreview } from "./design-preview";

/** The signature under a message being written, with a way to leave it off this one. */
export function SignatureSlot({ design, onRemove }: { design: Design; onRemove: () => void }) {
  return (
    <div className="blur-fade group relative">
      <DesignPreview design={design} className="max-h-[180px] overflow-hidden p-2" />
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
