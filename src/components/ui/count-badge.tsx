import { cn } from "@/lib/utils";

/** A count in a small pill: muted, or in the accent for the one in view. */
export function CountBadge({ count, active = false, className }: { count: number; active?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 text-[11px] font-medium tabular-nums transition-colors duration-150",
        active ? "bg-accent-soft text-accent" : "bg-pane-border/60 text-pane-muted",
        className,
      )}
    >
      {count}
    </span>
  );
}
