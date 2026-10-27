"use client";

import { useId } from "react";
import { AnimatePresence, motion } from "motion/react";
import { blurFade, springSnappy } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Icon, type IconData } from "../icon";
import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Tooltip } from "../ui/tooltip";
import { AccentTitle } from "../ui/accent-title";

/** The building blocks every settings page is made of: a page header, titled groups of rows, rows, pill choices. */

export const buttonClass =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-pane-border px-3.5 text-[12.5px] font-medium transition-colors hover:bg-pane-hover disabled:opacity-40 touch:h-11";

export const quietButtonClass = "h-8 shrink-0 rounded-full px-3 text-[12.5px] text-pane-muted transition-colors hover:bg-pane-hover hover:text-pane-fg touch:h-11";

/** One settings page: icon tile, title and one line on what it covers, then its groups. */
export function Page({ icon, title, description, children }: { icon: IconData; title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-8">
      <header className="flex items-center gap-3.5">
        <span className="grid size-11 shrink-0 place-items-center rounded-[14px] border border-pane-border bg-pane-2 text-pane-fg shadow-[0_1px_2px_rgba(0,0,0,0.06)]">
          <Icon icon={icon} size={20} />
        </span>
        <div className="min-w-0">
          <h2 className="text-[22px] font-medium leading-tight tracking-[-0.035em]"><AccentTitle text={title} /></h2>
          <p className="mt-0.5 text-[13px] leading-snug text-pane-muted">{description}</p>
        </div>
      </header>
      {children}
    </div>
  );
}

/**
 * A titled card of rows. `bare` drops the card for content that draws its own (font cards, stats).
 * `id` lets search land on the whole group.
 */
export function Group({
  title,
  description,
  action,
  bare,
  id,
  children,
}: {
  title?: string;
  description?: string;
  action?: React.ReactNode;
  bare?: boolean;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <section data-setting={id ?? title} className="flex scroll-mt-6 flex-col gap-2.5">
      {title ? (
        <div className="flex items-end gap-3 px-1">
          <div className="min-w-0 flex-1">
            <h3 className="text-[13px] font-semibold tracking-tight">{title}</h3>
            {description ? <p className="mt-0.5 text-[12px] leading-snug text-pane-muted">{description}</p> : null}
          </div>
          {action}
        </div>
      ) : null}
      {bare ? children : <div className="flex flex-col divide-y divide-pane-border rounded-xl border border-pane-border">{children}</div>}
    </section>
  );
}

/** A setting: label, one short line under it, the control on the right; `children` sit below (pickers, lists, confirms). */
export function Row({
  label,
  detail,
  control,
  children,
  tone,
}: {
  label: React.ReactNode;
  detail?: React.ReactNode;
  control?: React.ReactNode;
  children?: React.ReactNode;
  tone?: "warning";
}) {
  return (
    <div data-setting={typeof label === "string" ? label : undefined} className="flex scroll-mt-6 flex-col gap-2.5 px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <p className={cn("text-[13px] font-medium", tone === "warning" && "text-warning")}>{label}</p>
          {detail ? (
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.p
                key={typeof detail === "string" ? detail : undefined}
                {...blurFade({ y: 3, blur: 3 })}
                className="mt-0.5 text-[12px] leading-snug text-pane-muted"
              >
                {detail}
              </motion.p>
            </AnimatePresence>
          ) : null}
        </div>
        {control}
      </div>
      {children}
    </div>
  );
}

export function ToggleRow({
  label,
  detail,
  value,
  onChange,
  children,
}: {
  label: string;
  detail?: React.ReactNode;
  value: boolean;
  onChange: (value: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <Row label={label} detail={detail} control={<Switch value={value} onChange={onChange} label={label} />}>
      {children}
    </Row>
  );
}

/** A pill segmented control (radiogroup) with the sliding selected pill. A `disabled` option says why in its tooltip. */
export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string; icon?: IconData; disabled?: string }[];
  onChange: (value: T) => void;
}) {
  const layoutId = useId();
  return (
    <FluidList
      axis="x"
      tone="pill"
      role="radiogroup"
      aria-label={label}
      className="flex w-fit max-w-full shrink-0 items-center rounded-full bg-pane-2 p-[3px] shadow-[inset_0_0_0_1px_var(--pane-border)]"
    >
      {options.map((option) => {
        const active = option.id === value;
        const pill = (
          <button
            key={option.id}
            {...FLUID_ITEM}
            role="radio"
            aria-checked={active}
            aria-disabled={option.disabled ? true : undefined}
            onClick={() => !option.disabled && onChange(option.id)}
            className={cn(
              "relative flex h-[30px] min-w-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] transition-[color,background-color,font-weight] duration-150",
              active ? "font-semibold text-pane-fg" : option.disabled ? "cursor-default font-medium text-pane-muted/50" : "font-medium text-pane-muted data-[lit]:text-pane-fg",
            )}
          >
            {active ? (
              <motion.span
                layoutId={layoutId}
                transition={springSnappy}
                className="absolute inset-0 rounded-full bg-pane-raised shadow-[0_1px_2px_rgba(0,0,0,0.08),0_0_0_1px_var(--pane-border)]"
              />
            ) : null}
            {option.icon ? <Icon icon={option.icon} size={14} className="relative" /> : null}
            <span className="relative truncate">{option.label}</span>
          </button>
        );
        return option.disabled ? (
          <Tooltip key={option.id} label={option.disabled}>
            {pill}
          </Tooltip>
        ) : (
          pill
        );
      })}
    </FluidList>
  );
}

/** The inline "are you sure" strip under a row: what happens, Cancel, and the action. */
export function Confirm({
  children,
  action,
  busy,
  danger,
  onCancel,
  onConfirm,
}: {
  children: React.ReactNode;
  action: string;
  busy: boolean;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <motion.div {...blurFade({ y: -4 })} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-pane-2 px-3 py-2.5">
      <p className="min-w-0 flex-1 basis-48 text-[12px] leading-snug text-pane-muted">{children}</p>
      <button onClick={onCancel} disabled={busy} className={quietButtonClass}>
        Cancel
      </button>
      <button
        onClick={onConfirm}
        disabled={busy}
        className={cn(
          "flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-medium disabled:opacity-60",
          danger ? "bg-warning text-white" : "bg-pane-fg text-pane",
        )}
      >
        {busy ? <Spinner /> : null}
        {action}
      </button>
    </motion.div>
  );
}



/** A soft note inside a row: why something isn't working yet, with its fix. */
export function Note({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("rounded-lg bg-pane-2 px-3 py-2.5 text-[12px] leading-snug text-pane-muted", className)}>{children}</div>;
}
