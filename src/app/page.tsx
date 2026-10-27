"use client";

import { useSyncExternalStore } from "react";
import { MailApp } from "@/components/mail/mail-app";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ShortcutsProvider } from "@/lib/shortcuts";

const subscribe = () => () => {};

export default function Home() {
  // The mailbox depends on the current time and local storage, so render it on the client only.
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  return mounted ? (
    <ShortcutsProvider>
      <TooltipProvider>
        <MailApp />
      </TooltipProvider>
    </ShortcutsProvider>
  ) : (
    <div className="bg-sky h-screen" />
  );
}
