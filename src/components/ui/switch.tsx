"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** Track inner width (track minus 2px padding each side), thumb size, and thumb width while pressed. */
const SIZES = {
  md: { track: "h-5 w-9", inner: 32, thumb: 16, stretch: 20 },
  sm: { track: "h-4 w-7", inner: 24, thumb: 12, stretch: 15 },
} as const;

/**
 * The switch's visual: the thumb travels on the moderate spring and stretches a little while pressed
 * (towards where it will go), so the toggle feels physical. Put it inside any button that owns `role="switch"`.
 */
export function SwitchTrack({ on, pressed = false, size = "md" }: { on: boolean; pressed?: boolean; size?: keyof typeof SIZES }) {
  const s = SIZES[size];
  const width = pressed ? s.stretch : s.thumb;
  return (
    <span className={cn("relative block shrink-0 rounded-full transition-colors duration-200", s.track, on ? "bg-accent" : "bg-pane-border")}>
      <motion.span
        initial={false}
        animate={{ x: on ? s.inner - width : 0, width }}
        transition={spring.moderate}
        style={{ height: s.thumb, top: 2, left: 2 }}
        className="absolute rounded-full bg-white shadow-sm"
      />
    </span>
  );
}

/** A plain on/off switch. */
export function Switch({
  value,
  onChange,
  label,
  size = "md",
  disabled = false,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  label: string;
  size?: keyof typeof SIZES;
  disabled?: boolean;
}) {
  const [pressed, setPressed] = useState(false);
  return (
    <button
      // Never submits a form it sits in.
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!value)}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      className="shrink-0 rounded-full disabled:opacity-40"
    >
      <SwitchTrack on={value} pressed={pressed} size={size} />
    </button>
  );
}
