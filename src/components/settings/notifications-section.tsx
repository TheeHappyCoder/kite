"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUpRight01Icon, Notification03Icon } from "@hugeicons/core-free-icons";
import { blurFade } from "@/lib/motion";
import type { PersonPatch, PersonPrefs } from "@/lib/mail/person-prefs";
import { DEFAULT_CODE_SHORTCUT, type NotificationKind, type Preferences, type PreferencesPatch } from "@/lib/settings";
import { Icon } from "../icon";
import { BatchTimes, VipList } from "./notification-rules";
import { Group, Page, Row, ToggleRow, buttonClass } from "./settings-ui";

/** "CommandOrControl+Alt+C" -> "Ctrl+Alt+C" (or "Cmd+Alt+C" on a Mac). Client only. */
function shortcutLabel(accelerator: string) {
  return accelerator.replace("CommandOrControl", /Mac/.test(navigator.userAgent) ? "Cmd" : "Ctrl");
}

/** Settings → Notifications. */
export function NotificationsSection({
  preferences,
  onPreferences,
  desktop,
  people,
  onPerson,
  onOpenAutomations,
}: {
  preferences: Preferences;
  onPreferences: (patch: PreferencesPatch) => Promise<void>;
  desktop: boolean;
  people: Record<string, PersonPrefs>;
  onPerson: (patch: PersonPatch) => void;
  onOpenAutomations: () => void;
}) {
  const notify = (key: NotificationKind | "batch") => (value: boolean) => void onPreferences({ notifications: { [key]: value } });
  return (
    <Page icon={Notification03Icon} title="Notifications" description="What Kite tells you about while you're working elsewhere.">
      <Group title="Alerts">
        <DesktopNotifications value={preferences.notifications.desktop} onChange={notify("desktop")} />
        <ToggleRow
          label="Show content in notifications"
          detail={
            preferences.notifications.showContent
              ? "Sender, subject and codes show, including on the lock screen."
              : "Only “New mail” or “Sign-in code ready”. Nothing private on the lock screen."
          }
          value={preferences.notifications.showContent}
          onChange={(showContent) => void onPreferences({ notifications: { showContent } })}
        />
      </Group>

      <Group title="New mail" description="Your automations decide what notifies. VIPs come straight away.">
        <Row
          label="Which mail notifies"
          detail="“VIPs: notify now” and “Everyone else: notify” in Automations."
          control={
            <button onClick={onOpenAutomations} className={buttonClass}>
              Open Automations
              <Icon icon={ArrowUpRight01Icon} size={13} />
            </button>
          }
        />
        <ToggleRow
          label="Deliver the rest in batches"
          detail={preferences.notifications.batch ? "Everything but VIPs and codes waits for the next time below, as one summary." : "Notifications come as mail arrives."}
          value={preferences.notifications.batch}
          onChange={notify("batch")}
        >
          <AnimatePresence initial={false}>
            {preferences.notifications.batch ? (
              <motion.div {...blurFade({ y: -4 })}>
                <BatchTimes times={preferences.notifications.batchTimes} onChange={(batchTimes) => void onPreferences({ notifications: { batchTimes } })} />
              </motion.div>
            ) : null}
          </AnimatePresence>
        </ToggleRow>
        <VipList people={people} onRemove={(email) => onPerson({ email, vip: false })} />
      </Group>

      <Group title="Sign-in codes">
        <ToggleRow
          label="Sign-in codes"
          detail={desktop ? "Codes and sign-in links pop up as they arrive, ready to copy or open." : "Codes pop up as they arrive, ready to copy."}
          value={preferences.notifications.codes}
          onChange={notify("codes")}
        />
        {desktop ? (
          <>
            <ToggleRow
              label="Codes as Windows notifications"
              detail="With Copy code or Open link. Do Not Disturb holds these back."
              value={preferences.desktop.codeToast}
              onChange={(codeToast) => void onPreferences({ desktop: { codeToast } })}
            />
            <ToggleRow
              label="Copy code shortcut"
              detail={`${shortcutLabel(DEFAULT_CODE_SHORTCUT)} in any app copies the newest code (last 10 minutes).`}
              value={preferences.desktop.codeShortcut !== ""}
              onChange={(on) => void onPreferences({ desktop: { codeShortcut: on ? DEFAULT_CODE_SHORTCUT : "" } })}
            />
          </>
        ) : null}
      </Group>

      <Group title="Reminders">
        <ToggleRow label="Scheduled sends" detail="When a message you scheduled goes out." value={preferences.notifications.scheduled} onChange={notify("scheduled")} />
      </Group>
    </Page>
  );
}

function DesktopNotifications({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  const supported = typeof Notification !== "undefined";
  const [permission, setPermission] = useState<NotificationPermission>(supported ? Notification.permission : "denied");
  return (
    <ToggleRow
      label="Desktop notifications"
      detail={
        !supported
          ? "This browser can't show notifications."
          : permission === "denied"
            ? "Blocked for Kite. Allow notifications for this site in your browser's settings."
            : "Shown only when Kite isn't the window you're looking at."
      }
      value={value && permission !== "denied"}
      onChange={onChange}
    >
      {supported && permission === "default" && value ? (
        <button onClick={() => void Notification.requestPermission().then(setPermission)} className="self-start text-[12px] font-medium text-accent hover:opacity-80">
          Allow notifications
        </button>
      ) : null}
    </ToggleRow>
  );
}
