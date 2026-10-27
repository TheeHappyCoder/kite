"use client";

import { useCallback, useState } from "react";
import { lastMessageDate } from "@/lib/mail/store";
import type { Thread } from "@/lib/mail/types";
import { screenshotName } from "@/lib/screenshot/annotations";
import type { Shot } from "../screenshot/screenshot-editor";

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/**
 * Screenshot: draws the open conversation (or one of its messages) from the reader and opens the
 * editor on it. With one pane at a time, the reader is brought in first.
 */
export function useScreenshot({ thread, showReader }: { thread: Thread | null; showReader: () => void }) {
  const [shot, setShot] = useState<Shot | null>(null);

  const take = useCallback(
    async (messageId?: string) => {
      if (!thread || thread.scheduled) return;
      const find = () =>
        document.querySelector<HTMLElement>(
          messageId ? `[data-screenshot-root] [data-message-id="${CSS.escape(messageId)}"]` : "[data-screenshot-root]",
        );
      let root = find();
      if (!root) {
        showReader();
        await frame();
        await frame();
        root = find();
      }
      const message = messageId ? thread.messages.find((m) => m.id === messageId) : undefined;
      const id = Date.now();
      const name = screenshotName(thread.subject, new Date(message?.date ?? lastMessageDate(thread)));
      if (!root) {
        setShot({ id, status: "error", name, message: "Open the conversation, then try again." });
        return;
      }
      setShot({ id, status: "capturing", name });
      try {
        const { captureMail } = await import("../screenshot/capture");
        const canvas = await captureMail(root);
        const scale = canvas.width / Math.max(1, root.getBoundingClientRect().width);
        setShot((current) => (current?.id === id ? { id, status: "ready", name, canvas, scale } : current));
      } catch (error) {
        console.error("Screenshot failed:", error);
        setShot((current) =>
          current?.id === id
            ? { id, status: "error", name, message: "Something in this email couldn't be drawn. Try again, or screenshot one message from its menu." }
            : current,
        );
      }
    },
    [thread, showReader],
  );

  return { shot, take, close: useCallback(() => setShot(null), []) };
}
