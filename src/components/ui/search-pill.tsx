"use client";

import type { Ref } from "react";
import { Search01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

/** The search field at the top of a view's list: Escape clears it and lets go of the keyboard. */
export function SearchPill({
  value,
  onChange,
  placeholder,
  inputRef,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
}) {
  return (
    <label className={cn("flex h-10 flex-1 items-center gap-2 rounded-full border border-pane-border bg-pane px-3.5 text-[13.5px] transition-colors focus-within:border-accent/60", className)}>
      <Icon icon={Search01Icon} size={16} className="text-pane-muted" />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onChange("");
            e.currentTarget.blur();
          }
        }}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-pane-muted"
      />
    </label>
  );
}
