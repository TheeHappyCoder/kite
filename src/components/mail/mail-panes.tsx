"use client";

import { createContext, useContext } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { DETAIL_MIN_PX, LIST_MIN_PX, PANE_GAP_PX, useWidth } from "@/lib/layout";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { CircleButton } from "./circle-button";

/** However wide the window, the list takes at most about half. */
const LIST_MAX_SHARE = 55;

/**
 * One pane at a time: the reader (or Cleanup's sender pane) shows a Back button that returns to
 * the list. Null when both panes are on screen.
 */
const PaneBackContext = createContext<(() => void) | null>(null);

/** The Back action while one pane shows at a time, else null. */
export function usePaneBack() {
  return useContext(PaneBackContext);
}

/**
 * The list and the reader. Side by side when both fit at their pixel minimums (`single` is false;
 * the resizable panels take percentages, so the minimums are worked out from its own measured width,
 * which re-renders only this, not the app around it);
 * otherwise one at a time, `showDetail` picking which. Both stay mounted, so the list keeps its
 * scroll and the reader its state when you go back and forth.
 */
export function MailPanes({
  list,
  detail,
  single,
  showDetail,
  onBack,
}: {
  list: React.ReactNode;
  detail: React.ReactNode;
  single: boolean;
  showDetail: boolean;
  onBack: () => void;
}) {
  // Percent of the group (the panels' unit), never past what leaves the other pane its minimum.
  // Until the width is measured (the first frame), shares that suit a usual window.
  const [ref, width] = useWidth<HTMLDivElement>();
  const share = (px: number, before: number) => (width ? Math.min(100, (px / (width - PANE_GAP_PX)) * 100) : before);
  const listMin = share(LIST_MIN_PX, 26);
  const detailMin = share(DETAIL_MIN_PX, 35);
  const listMax = Math.max(listMin, Math.min(LIST_MAX_SHARE, 100 - detailMin));

  return (
    <div ref={ref} className="h-full min-w-0">
      {single ? (
        <PaneBackContext value={onBack}>
          {/* A pane coming back into view replays its blur fade (display none -> shown restarts the animation). */}
          <div hidden={showDetail} className="blur-fade-right pane-on-sky h-full overflow-hidden rounded-2xl">
            {list}
          </div>
          <div hidden={!showDetail} className="blur-fade-left pane-on-sky h-full overflow-hidden rounded-2xl">
            {detail}
          </div>
        </PaneBackContext>
      ) : (
        <PanelGroup direction="horizontal" autoSaveId="kite-panes" className="h-full" style={{ overflow: "visible" }}>
          <Panel defaultSize={Math.min(listMax, Math.max(listMin, 38))} minSize={listMin} maxSize={listMax} className="pane-on-sky overflow-hidden rounded-2xl">
            {list}
          </Panel>
          <PanelResizeHandle className="group relative w-2">
            <span className="absolute inset-y-1/3 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-white/0 transition-colors group-hover:bg-white/60 group-data-[resize-handle-state=drag]:bg-accent" />
          </PanelResizeHandle>
          <Panel minSize={detailMin} className="pane-on-sky overflow-hidden rounded-2xl">
            {detail}
          </Panel>
        </PanelGroup>
      )}
    </div>
  );
}

/**
 * A detail pane without a toolbar of its own (Cleanup's sender pane): with one pane at a time, a
 * bar above it with Back to the list (`label` names the list). Nothing when both panes show.
 */
export function WithPaneBack({ label, children }: { label: string; children: React.ReactNode }) {
  const back = usePaneBack();
  if (!back) return children;
  return (
    <div className="flex h-full flex-col bg-pane text-pane-fg">
      <div className="flex shrink-0 items-center gap-2 border-b border-pane-border px-3 py-2.5">
        <CircleButton icon={ArrowLeft01Icon} label={`Back to ${label}`} shortcut="back" onClick={back} />
        <span className="truncate text-[13px] font-medium text-pane-muted">{label}</span>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
