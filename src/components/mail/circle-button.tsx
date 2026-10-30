import { AnimatePresence, motion } from "motion/react";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import type { ShortcutAction } from "@/lib/shortcuts";
import { blurFade } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Icon, type IconData } from "../icon";
import { Spinner } from "../ui/spinner";
import { Tooltip } from "../ui/tooltip";

/** `status`: the action it starts is running (a spinner), or just finished (a tick for a moment). */
export function CircleButton({
  icon,
  label,
  shortcut,
  onClick,
  active,
  status,
  className,
  iconClassName,
  badge,
  ghost = false,
  iconSize = 17,
}: {
  icon: IconData;
  label: string;
  shortcut?: ShortcutAction;
  onClick?: () => void;
  active?: boolean;
  status?: "busy" | "done" | null;
  className?: string;
  iconClassName?: string;
  /** A count in the corner (files in the conversation). */
  badge?: number;
  /** No ring: a plain icon that fills on hover (the list header's toolbar). */
  ghost?: boolean;
  /** For optical balance beside other glyphs (a glyph that fills its box reads bigger). */
  iconSize?: number;
}) {
  return (
    <Tooltip label={label} shortcut={shortcut}>
      <button
        aria-label={label}
        aria-busy={status === "busy" || undefined}
        onClick={onClick}
        className={cn(
          "relative grid size-9 shrink-0 place-items-center rounded-full touch:size-11 text-pane-fg/80 transition-[background-color,color,transform] duration-150 hover:bg-pane-hover hover:text-pane-fg active:scale-95",
          ghost ? "text-pane-muted" : "border border-pane-border",
          active && "border-accent/40 bg-accent-soft text-accent",
          status === "done" && "text-success",
          className,
        )}
      >
        {status === undefined ? (
          <Icon icon={icon} size={iconSize} className={iconClassName} />
        ) : (
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={status ?? "idle"} {...blurFade({ blur: 3, speed: "fast" })} className="grid place-items-center">
              {status === "busy" ? (
                <Spinner size={16} />
              ) : status === "done" ? (
                <Icon icon={Tick02Icon} size={iconSize} />
              ) : (
                <Icon icon={icon} size={iconSize} className={iconClassName} />
              )}
            </motion.span>
          </AnimatePresence>
        )}
        {badge ? (
          <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-lime px-1 text-[10px] font-semibold tabular-nums text-lime-fg">
            {badge}
          </span>
        ) : null}
      </button>
    </Tooltip>
  );
}
