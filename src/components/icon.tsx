import { HugeiconsIcon } from "@hugeicons/react";
import type { InboxIcon } from "@hugeicons/core-free-icons";

export type IconData = typeof InboxIcon;

/** Every line at least this wide on screen, whatever the icon's size: a thinner one can't be drawn solid on a 1x screen and smears grey. */
const LINE_PX = 1.5;

export function Icon({
  icon,
  size = 16,
  strokeWidth,
  className,
  style,
}: {
  icon: IconData;
  size?: number;
  /** In the icon's own 24-unit grid, like Hugeicons': a bolder tick passes 2.5. */
  strokeWidth?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const px = Math.max(LINE_PX, ((strokeWidth ?? 0) * size) / 24);
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={px} absoluteStrokeWidth className={className} style={style} />;
}
