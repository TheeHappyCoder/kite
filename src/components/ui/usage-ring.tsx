import { cn } from "@/lib/utils";

/**
 * How much of an AI limit is used, as a small donut: the arc fills clockwise from the top and turns
 * from success to warning (60%) to danger (90%). `share` null (no limit) draws only the track.
 * Takes the text colour for its track, so it sits on the frame and on panes alike.
 */
export function UsageRing({ share, size = 12, stroke = 2, className }: { share: number | null; size?: number; stroke?: number; className?: string }) {
  const r = (size - stroke) / 2;
  const around = 2 * Math.PI * r;
  const filled = share === null ? 0 : Math.max(0, Math.min(1, share));
  const tone = share === null ? "" : filled < 0.6 ? "text-success" : filled < 0.9 ? "text-warning" : "text-danger";
  return (
    <svg aria-hidden width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" strokeWidth={stroke} className={cn("shrink-0 -rotate-90", className)}>
      <circle cx={size / 2} cy={size / 2} r={r} stroke="currentColor" opacity={0.22} />
      {share === null ? null : (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="currentColor"
          strokeLinecap={filled > 0 ? "round" : "butt"}
          strokeDasharray={around}
          strokeDashoffset={around * (1 - filled)}
          className={cn("[transition:stroke-dashoffset_300ms_ease,color_150ms]", tone)}
        />
      )}
    </svg>
  );
}
