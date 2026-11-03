import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export type TextureVariant = "minimal" | "primary" | "accent" | "danger";
export type TextureSize = "sm" | "md" | "icon" | "icon-sm";

const SIZES: Record<TextureSize, string> = {
  sm: "h-7 gap-1.5 rounded-[8px] px-2.5 text-[12px] touch:h-10",
  md: "h-9 gap-2 rounded-[10px] px-3.5 text-[13px] touch:h-11",
  icon: "size-9 rounded-full touch:size-11",
  "icon-sm": "size-7 rounded-full touch:size-10",
};

/**
 * A button that reads as a pressed object (globals.css `.texture`): `minimal` for everyday actions,
 * `primary` for the one main action on a screen (ink in light, paper in dark), `accent` and `danger`
 * where colour means something. `aria-pressed` shows a toggle that's on.
 */
export const TextureButton = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: TextureVariant; size?: TextureSize }
>(function TextureButton({ variant = "minimal", size = "md", className, type = "button", ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      data-variant={variant}
      className={cn(
        "texture inline-flex shrink-0 select-none items-center justify-center font-medium disabled:cursor-default disabled:opacity-50",
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
});
