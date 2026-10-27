import { cn } from "@/lib/utils";

/**
 * The general wait (anything that isn't AI, which uses `Thinking`): a faint ring with a quarter arc
 * running round it. Takes the text colour, so it sits on panes, accent tiles and dark buttons alike.
 */
export function Spinner({ size = 14, stroke: width, className, style }: { size?: number; stroke?: number; className?: string; style?: React.CSSProperties }) {
  const stroke = width ?? (size <= 16 ? 2 : 2.5);
  const r = (size - stroke) / 2;
  const around = 2 * Math.PI * r;
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      className={cn("shrink-0 animate-spin [animation-duration:0.8s]", className)}
      style={style}
    >
      <circle cx={size / 2} cy={size / 2} r={r} opacity={0.25} />
      <circle cx={size / 2} cy={size / 2} r={r} strokeLinecap="round" strokeDasharray={`${around * 0.28} ${around}`} />
    </svg>
  );
}

