import { HugeiconsIcon } from "@hugeicons/react";
import type { InboxIcon } from "@hugeicons/core-free-icons";

export type IconData = typeof InboxIcon;

export function Icon({
  icon,
  size = 16,
  strokeWidth = 1.6,
  className,
  style,
}: {
  icon: IconData;
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={strokeWidth} className={className} style={style} />;
}
