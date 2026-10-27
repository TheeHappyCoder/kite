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
}: {
  icon: IconData;
  label: string;
  shortcut?: ShortcutAction;
  onClick?: () => void;
  active?: boolean;
  status?: "busy" | "done" | null;
  className?: string;
  iconClassName?: string;
}) {
  return (
    <Tooltip label={label} shortcut={shortcut}>
      <button
        aria-label={label}
        aria-busy={status === "busy" || undefined}
        onClick={onClick}
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-full touch:size-11 border border-pane-border text-pane-fg/80 transition-[background-color,color,transform] duration-150 hover:bg-pane-hover hover:text-pane-fg active:scale-95",
          active && "border-accent/40 bg-accent-soft text-accent",
          status === "done" && "text-success",
          className,
        )}
      >
        {status === undefined ? (
          <Icon icon={icon} size={17} className={iconClassName} />
        ) : (
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={status ?? "idle"} {...blurFade({ blur: 3, speed: "fast" })} className="grid place-items-center">
              {status === "busy" ? (
                <Spinner size={16} />
              ) : status === "done" ? (
                <Icon icon={Tick02Icon} size={17} />
              ) : (
                <Icon icon={icon} size={17} className={iconClassName} />
              )}
            </motion.span>
          </AnimatePresence>
        )}
      </button>
    </Tooltip>
  );
}
