import { comboParts } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

/** Renders a combo such as "mod+k" as individual key caps. */
export function KeyCombo({ combo, className, keyClassName }: { combo: string; className?: string; keyClassName?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      {comboParts(combo).map((part, i) => (
        <kbd
          key={i}
          className={cn(
            "inline-grid h-[18px] min-w-[18px] place-items-center rounded-[5px] px-1 font-sans text-[10.5px] font-medium leading-none",
            keyClassName,
          )}
        >
          {part}
        </kbd>
      ))}
    </span>
  );
}
