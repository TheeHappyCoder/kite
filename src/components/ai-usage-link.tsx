"use client";

import { createContext, useContext } from "react";
import { LIMIT_HINT } from "@/lib/ai-pricing";

/** Opens Settings → AI (provided by mail-app). */
export const AiUsageContext = createContext<(() => void) | null>(null);

/**
 * An AI error as one line. A limit message ("… Change it in Usage.") gets "Usage" as a link to
 * Settings → AI; anything else is shown as it is.
 */
export function AiErrorText({ message }: { message: string }) {
  const openUsage = useContext(AiUsageContext);
  if (!openUsage || !message.endsWith(LIMIT_HINT)) return <>{message}</>;
  const before = message.slice(0, -LIMIT_HINT.length);
  return (
    <>
      {before}Change it in{" "}
      <button type="button" onClick={openUsage} className="font-medium underline decoration-current/40 underline-offset-2 hover:decoration-current">
        Usage
      </button>
      .
    </>
  );
}
