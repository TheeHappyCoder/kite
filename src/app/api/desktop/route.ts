import { NextResponse } from "next/server";
import type { DesktopState } from "@/lib/desktop";
import { rejectForeignHost } from "@/server/guard";
import { getPreferences } from "@/server/settings";
import { freshCodes } from "@/server/codes";

export const runtime = "nodejs";

/** For the desktop shell's tray and toasts: fresh codes and links, plus its settings (read-only). */
export async function GET(request: Request) {
  const rejected = rejectForeignHost(request);
  if (rejected) return rejected;
  const { notifications, desktop, compose, bar, privacy } = getPreferences();
  const state: DesktopState = {
    codes: freshCodes(),
    codeToast: notifications.desktop && desktop.codeToast,
    codeCard: desktop.codeCard,
    mailBar: desktop.mailBar,
    undoSend: compose.undoSend,
    barQuiet: bar.quiet,
    codeShortcut: desktop.codeShortcut,
    showContent: notifications.showContent,
    updateChecks: privacy.updateChecks,
  };
  return NextResponse.json(state, { headers: { "cache-control": "no-store" } });
}
