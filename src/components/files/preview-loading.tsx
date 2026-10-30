import { cn } from "@/lib/utils";
import { Spinner } from "../ui/spinner";

/** Every file type's wait in the preview. */
export function PreviewLoading({ className }: { className?: string }) {
  return (
    <div className={cn("flex min-h-0 flex-1 items-center justify-center gap-2 text-[12.5px] text-pane-muted", className)}>
      <Spinner /> Opening the file…
    </div>
  );
}
