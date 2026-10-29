"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { formatDistanceToNow } from "date-fns";
import {
  Alert02Icon,
  ArrowUpRight01Icon,
  ComputerIcon,
  DatabaseIcon,
  InformationCircleIcon,
  FilePenIcon,
  FolderCloudIcon,
  KeyboardIcon,
  LayoutTemplateIcon,
  MailEdit02Icon,
  Moon02Icon,
  Notification03Icon,
  PlugSocketIcon,
  PaintBoardIcon,
  Search01Icon,
  SignatureIcon,
  SparklesIcon,
  Sun03Icon,
  Shield01Icon,
  UserCircleIcon,
  Cancel01Icon,
  Tag01Icon,
} from "@hugeicons/core-free-icons";
import { accountName, type Account } from "@/lib/mail/types";
import { blurFade, springSnappy } from "@/lib/motion";
import { inDesktopApp } from "@/lib/desktop";
import { AboutSection } from "./about-section";
import { DEFAULT_CODE_SHORTCUT, UNDO_SEND_CHOICES, WAIT_DAY_CHOICES, type NotificationKind, type Preferences, type PreferencesPatch, type StartView, type StorageInfo } from "@/lib/settings";
import { useShortcuts } from "@/lib/shortcuts";
import type { ThemePref } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Icon, type IconData } from "../icon";
import { KeyCombo } from "../ui/kbd";
import type { Design } from "@/lib/design/spec";
import { SignatureEditor } from "../design/design-editor";
import { DesignPreview } from "../design/design-preview";
import { AccountFace } from "../mail/account-face";
import { AccountLook } from "./account-look";
import { FillSignSection } from "./fill-sign-section";
import { SnippetsSection } from "./snippets-section";
import { TemplatesSection } from "./templates-section";
import { BatchTimes, VipList } from "./notification-rules";
import { LabelsSection } from "./labels-section";
import { AiSection } from "./ai-section";
import { BarSection } from "./bar-section";
import { DriveSection } from "./drive-section";
import type { AiUsageSummary } from "@/lib/ai-pricing";
import { signInCompany } from "@/lib/mail/connect";
import { accountSpec, permissionHref, serviceName } from "@/lib/mail/providers";
import { ImageSenders, ImagesRow, LockRow, PrivacyLog } from "./privacy-section";
import type { PersonPatch, PersonPrefs } from "@/lib/mail/person-prefs";
import { FontSection } from "./font-section";
import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { Tooltip } from "../ui/tooltip";
import { Confirm, Group, Note, Page, Row, Segmented, ToggleRow, buttonClass } from "./settings-ui";
import { TranslateGroup } from "./translate-section";
import { Spinner } from "../ui/spinner";
import { Select } from "../ui/select";
import { SWIPE_ACTIONS, SWIPE_INFO, type SwipeAction, type SwipeSide } from "@/lib/swipe";
import { syncCount, useAccountSync } from "../mail/first-sync";
import { AccentTitle } from "../ui/accent-title";
import { formatBytes } from "@/lib/format";

const noSubscribe = () => () => {};

/** "CommandOrControl+Alt+C" -> "Ctrl+Alt+C" (or "Cmd+Alt+C" on a Mac). Client only. */
function shortcutLabel(accelerator: string) {
  return accelerator.replace("CommandOrControl", /Mac/.test(navigator.userAgent) ? "Cmd" : "Ctrl");
}

export type SettingsSection = "accounts" | "labels" | "compose" | "signatures" | "templates" | "fillSign" | "notifications" | "bar" | "files" | "ai" | "privacy" | "appearance" | "data" | "about";

type NavItem = { id: SettingsSection; label: string; icon: IconData } | { id: "shortcuts"; label: string; icon: IconData; opens: true };

/** The nav, in groups. Shortcuts opens its own dialog. */
const NAV: { title: string; items: NavItem[] }[] = [
  {
    title: "Mail",
    items: [
      { id: "accounts", label: "Accounts", icon: UserCircleIcon },
      { id: "labels", label: "Labels & folders", icon: Tag01Icon },
      { id: "compose", label: "Compose", icon: MailEdit02Icon },
      { id: "signatures", label: "Signatures", icon: SignatureIcon },
      { id: "templates", label: "Templates", icon: LayoutTemplateIcon },
      { id: "fillSign", label: "Fill & sign", icon: FilePenIcon },
      { id: "files", label: "Files", icon: FolderCloudIcon },
    ],
  },
  {
    title: "Automation",
    items: [
      { id: "notifications", label: "Notifications", icon: Notification03Icon },
      { id: "bar", label: "Kite bar", icon: PlugSocketIcon },
      { id: "ai", label: "AI", icon: SparklesIcon },
    ],
  },
  {
    title: "Kite",
    items: [
      { id: "appearance", label: "Appearance", icon: PaintBoardIcon },
      { id: "privacy", label: "Privacy", icon: Shield01Icon },
      { id: "shortcuts", label: "Shortcuts", icon: KeyboardIcon, opens: true },
      { id: "data", label: "Data", icon: DatabaseIcon },
      { id: "about", label: "About", icon: InformationCircleIcon },
    ],
  },
];

const PAGES = NAV.flatMap((g) => g.items).filter((item): item is Extract<NavItem, { id: SettingsSection }> => !("opens" in item));
const pageIndex = (id: SettingsSection) => PAGES.findIndex((p) => p.id === id);

/**
 * What search finds: each entry is a row label (or group title) on a page, plus words people might
 * type for it. Labels must match the `label`/`title` the page renders, so search can land on the row.
 */
const SEARCH: { section: SettingsSection | "shortcuts"; label: string; words?: string }[] = [
  { section: "accounts", label: "Connected accounts", words: "gmail outlook imap reconnect disconnect add sign in nickname rename colour color picture photo avatar ring" },
  { section: "accounts", label: "Photos from Google contacts", words: "avatar picture people" },
  { section: "accounts", label: "Use your calendar", words: "events invites today google outlook" },
  { section: "labels", label: "Labels & folders", words: "label folder category tag new make create rename delete remove organise" },
  { section: "compose", label: "Undo send", words: "delay hold take back" },
  { section: "compose", label: "Waiting on", words: "reply tracking follow up nudge no answer days today" },
  { section: "compose", label: "Snippets", words: "text shortcut ; canned replies" },
  { section: "signatures", label: "Signatures", words: "sign off footer logo" },
  { section: "templates", label: "Brand kit", words: "logo colours font designed email" },
  { section: "templates", label: "Templates", words: "designed email" },
  { section: "fillSign", label: "Your signature", words: "pdf fill sign draw" },
  { section: "fillSign", label: "Remembered layouts", words: "pdf form fill sign like last time" },
  { section: "notifications", label: "Desktop notifications", words: "alerts popups" },
  { section: "notifications", label: "Show content in notifications", words: "lock screen private" },
  { section: "notifications", label: "Deliver the rest in batches", words: "summary times digest" },
  { section: "notifications", label: "VIPs", words: "important people crown" },
  { section: "notifications", label: "Sign-in codes", words: "otp 2fa verification code toast bar" },
  { section: "notifications", label: "Scheduled sends", words: "send later" },
  { section: "bar", label: "Codes in the Kite bar", words: "otp 2fa verification sign-in desktop" },
  { section: "bar", label: "Important mail in the Kite bar", words: "vip notify reply archive desktop" },
  { section: "bar", label: "Meetings starting soon", words: "calendar join reminder event" },
  { section: "bar", label: "Quiet", words: "do not disturb pill calm bar" },
  { section: "bar", label: "Other apps and scripts", words: "integrations api token webhook plugin developer ai claude bar" },
  { section: "files", label: "Show your files in Explorer", words: "drive explorer onedrive folder windows open dialog attachments upload" },
  { section: "files", label: "Folders", words: "drive explorer people spaces month labels saved searches order layout" },
  { section: "ai", label: "Usage", words: "ai cost spend tokens dollars requests" },
  { section: "ai", label: "Limits", words: "ai limit daily monthly budget cap cost tokens dollars" },
  { section: "ai", label: "Setup", words: "ai anthropic claude openai ollama model key price" },
  { section: "ai", label: "Recent", words: "ai requests log calls" },
  { section: "appearance", label: "Theme", words: "dark light system mode" },
  { section: "appearance", label: "Open Kite on", words: "start startup launch home inbox last screen remember" },
  { section: "appearance", label: "Open conversations as chat", words: "bubbles reading view" },
  { section: "appearance", label: "Fonts", words: "typeface interface reading" },
  { section: "appearance", label: "Swipe right", words: "gesture touch swipe actions archive snooze trash phone tablet" },
  { section: "appearance", label: "Swipe left", words: "gesture touch swipe actions archive snooze trash phone tablet" },
  { section: "appearance", label: "Translate into", words: "translate translation language foreign spanish afrikaans offline firefox" },
  { section: "appearance", label: "Downloaded languages", words: "translate translation remove storage" },
  { section: "privacy", label: "Remote images", words: "tracking pixels load" },
  { section: "privacy", label: "Clean tracking from links", words: "utm redirect" },
  { section: "privacy", label: "Company logos from the web", words: "gravatar bimi pictures duckduckgo" },
  { section: "privacy", label: "Cloudflare DNS when this computer's fails", words: "dns doh lookup domain fallback" },
  { section: "privacy", label: "Check for updates", words: "updates github version automatic" },
  { section: "privacy", label: "Lock with a PIN", words: "password lock security" },
  { section: "privacy", label: "What left this computer", words: "log third party" },
  { section: "shortcuts", label: "Shortcuts", words: "keys keyboard bindings" },
  { section: "data", label: "Clear pictures and files", words: "cache storage avatars attachments" },
  { section: "data", label: "Reset local copy", words: "resync download again" },
  { section: "data", label: "Erase everything", words: "delete reset" },
  { section: "about", label: "Kite", words: "about version update check for updates new release install restart" },
];

const SWIPE_OPTIONS = SWIPE_ACTIONS.map((value: SwipeAction) => ({ value, label: value === "none" ? "Nothing" : SWIPE_INFO[value].label }));

const SECTION_KEY = "kite-settings-section";

function storedSection(): SettingsSection | null {
  try {
    const value = localStorage.getItem(SECTION_KEY);
    return PAGES.some((p) => p.id === value) ? (value as SettingsSection) : null;
  } catch {
    return null;
  }
}

type Props = {
  section?: SettingsSection;
  accounts: Account[];
  demo: boolean;
  /** Account ids whose Google access has lapsed. */
  reconnect: string[];
  preferences: Preferences;
  onPreferences: (patch: PreferencesPatch) => Promise<void>;
  themePref: ThemePref;
  onThemePref: (pref: ThemePref) => void;
  onOpenShortcuts: () => void;
  /** Opens the AI setup dialog. */
  onOpenAi: () => void;
  /** Live AI usage (the `ai` sync event), for the AI page. */
  aiUsage: AiUsageSummary | null;
  onAddAccount: () => void;
  /** Sign in again with a password (accounts that sign in with one, IMAP). */
  onSignInAgain: (email: string) => void;
  onDisconnected: (accountId: string) => void;
  /** How the account looks in Kite changed: its local name (null: back to the provider's), colour or picture. */
  onAccount: (accountId: string, patch: Partial<Account>) => void;
  onToast: (message: string) => void;
  /** Opens Automations. */
  onOpenAutomations: () => void;
  /** A label or folder was made, renamed or deleted: the sidebar and lists read them again. */
  onLabelsChanged: () => void;
  /** VIP flags and private notes, keyed by lower-cased address. */
  people: Record<string, PersonPrefs>;
  onPerson: (patch: PersonPatch) => void;
  /** App lock: whether a PIN is set; told when it's set or removed here. */
  lockOn: boolean;
  onLockChanged: (on: boolean) => void;
};

async function request<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "Request failed");
  return data as T;
}

export function SettingsView(props: Props) {
  const [active, setActive] = useState<SettingsSection>(() => props.section ?? storedSection() ?? "accounts");
  // Which way the page moves: down the nav slides content up, and back.
  const [direction, setDirection] = useState(1);
  // A row search picked: scrolled to and lit once its page has arrived.
  const landing = useRef<string | null>(null);
  const [query, setQuery] = useState("");
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [storageKey, setStorageKey] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Below 640px the nav is an icon rail (the @max-[640px] classes); its buttons then need tooltips.
  const sectionRef = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 640));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Kept after closing so the editor can animate out.
  const [editing, setEditing] = useState<Account | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  useEffect(() => {
    if (props.demo) return;
    const controller = new AbortController();
    fetch("/api/settings?storage=1", { signal: controller.signal })
      .then((res) => res.json())
      .then((data: { storage: StorageInfo }) => setStorage(data.storage))
      .catch(() => {});
    return () => controller.abort();
  }, [props.demo, storageKey]);

  // A deep link (Manage snippets, Fill & sign…) opens its page.
  const [linked, setLinked] = useState(props.section);
  if (props.section !== linked) {
    setLinked(props.section);
    if (props.section) setActive(props.section);
  }

  useEffect(() => {
    try {
      localStorage.setItem(SECTION_KEY, active);
    } catch {}
  }, [active]);

  const land = () => {
    const label = landing.current;
    if (!label) return;
    landing.current = null;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-setting="${CSS.escape(label)}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.removeAttribute("data-flash");
    void el.offsetWidth;
    el.setAttribute("data-flash", "");
  };

  const go = (id: SettingsSection) => {
    if (id === active) return scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    setDirection(pageIndex(id) > pageIndex(active) ? 1 : -1);
    setActive(id);
  };

  const open = (item: NavItem) => {
    if (item.id === "shortcuts") return props.onOpenShortcuts();
    go(item.id);
  };

  const results = useMemo(() => {
    // Every typed word starts a word of the entry; entries whose label matches come first.
    const tokens = (text: string) => text.toLowerCase().split(/[^a-z0-9&;-]+/).filter(Boolean);
    const words = tokens(query);
    if (!words.length) return [];
    const hits = (list: string[]) => words.filter((w) => list.some((t) => t.startsWith(w))).length;
    return SEARCH.map((entry) => {
      const label = tokens(entry.label);
      const all = [...label, ...tokens(`${entry.words ?? ""} ${PAGES.find((p) => p.id === entry.section)?.label ?? ""}`)];
      return { entry, all: hits(all), label: hits(label) };
    })
      .filter((r) => r.all === words.length)
      .sort((a, b) => b.label - a.label)
      .map((r) => r.entry);
  }, [query]);

  const pick = (entry: (typeof SEARCH)[number]) => {
    setQuery("");
    if (entry.section === "shortcuts") return props.onOpenShortcuts();
    landing.current = entry.label;
    // Same page: land now. Another page: land when it has finished coming in.
    if (entry.section === active) land();
    else go(entry.section);
  };

  // Up / Down move through the pages while the nav has focus.
  const onNavKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    e.preventDefault();
    const next = PAGES[pageIndex(active) + (e.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    go(next.id);
    requestAnimationFrame(() => e.currentTarget.querySelector<HTMLElement>(`[data-page="${next.id}"]`)?.focus());
  };

  const { preferences } = props;
  const notify = (key: NotificationKind | "batch") => (value: boolean) => void props.onPreferences({ notifications: { [key]: value } });
  const desktop = useSyncExternalStore(noSubscribe, inDesktopApp, () => false);
  const reconnectCount = props.reconnect.length;

  const page = (() => {
    switch (active) {
      case "accounts":
        return (
          <Page icon={UserCircleIcon} title="Accounts" description="The mail Kite keeps in sync on this computer.">
            <Group
              title="Connected accounts"
              action={
                <button onClick={props.onAddAccount} className={buttonClass}>
                  {props.demo ? "Connect my mail" : "Add account"}
                </button>
              }
            >
              {props.accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  demo={props.demo}
                  reconnect={props.reconnect.includes(account.id)}
                  info={storage?.accounts.find((a) => a.id === account.id)}
                  onDisconnected={() => {
                    props.onDisconnected(account.id);
                    setStorageKey((k) => k + 1);
                  }}
                  onChange={(patch) => props.onAccount(account.id, patch)}
                  onError={props.onToast}
                  onSignInAgain={() => props.onSignInAgain(account.email)}
                />
              ))}
            </Group>
            {props.demo ? null : (
              <Group title="Extras" description="Off until you turn them on. Each asks for its own permission.">
                <SenderPhotos value={preferences.senderPhotos} accounts={props.accounts} onChange={(senderPhotos) => void props.onPreferences({ senderPhotos })} />
                {props.accounts.some((a) => a.calendar !== undefined) ? (
                  <CalendarAccess value={preferences.calendar} accounts={props.accounts} onChange={(calendar) => void props.onPreferences({ calendar })} />
                ) : null}
              </Group>
            )}
          </Page>
        );
      case "compose":
        return (
          <Page icon={MailEdit02Icon} title="Compose" description="Writing and sending messages.">
            <Group title="Sending">
              <Row
                label="Undo send"
                detail={preferences.compose.undoSend ? `Messages wait ${preferences.compose.undoSend} seconds, so you can take them back.` : "Messages go as soon as you press Send."}
                control={
                  <Segmented
                    label="Undo send"
                    value={preferences.compose.undoSend}
                    options={UNDO_SEND_CHOICES.map((s) => ({ id: s, label: s ? `${s} s` : "Off" }))}
                    onChange={(undoSend) => void props.onPreferences({ compose: { undoSend } })}
                  />
                }
              />
              <Row
                label="Waiting on"
                detail={`Mail you sent to people shows in Today's Waiting on after ${preferences.compose.waitDays} days without an answer.`}
                control={
                  <Segmented
                    label="Waiting on"
                    value={preferences.compose.waitDays}
                    options={WAIT_DAY_CHOICES.map((d) => ({ id: d, label: `${d} days` }))}
                    onChange={(waitDays) => void props.onPreferences({ compose: { waitDays } })}
                  />
                }
              />
            </Group>
            <Group title="Snippets" description="Text you send often. Type ; and its word in any message." bare>
              <SnippetsSection snippets={preferences.snippets} onSave={(snippets) => props.onPreferences({ snippets })} />
            </Group>
          </Page>
        );
      case "signatures":
        return (
          <Page icon={SignatureIcon} title="Signatures" description="Added below new messages and replies, with fallbacks for every mail app.">
            <Group title="Signatures" bare>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-3">
                {props.accounts.map((account) => (
                  <SignatureCard
                    key={account.id}
                    account={account}
                    design={preferences.signatures[account.id]}
                    onEdit={() => {
                      setEditing(account);
                      setEditorOpen(true);
                    }}
                  />
                ))}
              </div>
            </Group>
          </Page>
        );
      case "templates":
        return (
          <Page icon={LayoutTemplateIcon} title="Templates" description="Designed emails you start new messages from, and the brand they use.">
            <TemplatesSection onToast={props.onToast} />
          </Page>
        );
      case "fillSign":
        return (
          <Page icon={FilePenIcon} title="Fill & sign" description="Your signature and details for PDFs, and the forms Kite can sign like last time.">
            <FillSignSection
              signatureId={preferences.pdfSign.signature}
              onSignature={(signature) => props.onPreferences({ pdfSign: { signature } })}
              onToast={props.onToast}
            />
          </Page>
        );
      case "labels":
        return (
          <Page icon={Tag01Icon} title="Labels & folders" description="Your own labels, folders and categories in each account. Changes happen in the account itself.">
            <LabelsSection accounts={props.accounts} demo={props.demo} onChanged={props.onLabelsChanged} onToast={props.onToast} />
          </Page>
        );
      case "notifications":
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
                onChange={(showContent) => void props.onPreferences({ notifications: { showContent } })}
              />
            </Group>

            <Group title="New mail" description="Your automations decide what notifies. VIPs come straight away.">
              <Row
                label="Which mail notifies"
                detail="“VIPs: notify now” and “Everyone else: notify” in Automations."
                control={
                  <button onClick={props.onOpenAutomations} className={buttonClass}>
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
                      <BatchTimes times={preferences.notifications.batchTimes} onChange={(batchTimes) => void props.onPreferences({ notifications: { batchTimes } })} />
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </ToggleRow>
              <VipList people={props.people} onRemove={(email) => props.onPerson({ email, vip: false })} />
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
                    onChange={(codeToast) => void props.onPreferences({ desktop: { codeToast } })}
                  />
                  <ToggleRow
                    label="Copy code shortcut"
                    detail={`${shortcutLabel(DEFAULT_CODE_SHORTCUT)} in any app copies the newest code (last 10 minutes).`}
                    value={preferences.desktop.codeShortcut !== ""}
                    onChange={(on) => void props.onPreferences({ desktop: { codeShortcut: on ? DEFAULT_CODE_SHORTCUT : "" } })}
                  />
                </>
              ) : null}
            </Group>

            <Group title="Reminders">
              <ToggleRow label="Scheduled sends" detail="When a message you scheduled goes out." value={preferences.notifications.scheduled} onChange={notify("scheduled")} />
            </Group>
          </Page>
        );
      case "bar":
        return <BarSection preferences={preferences} onPreferences={props.onPreferences} desktop={desktop} />;
      case "files":
        return <DriveSection preferences={preferences} onPreferences={props.onPreferences} desktop={desktop} accounts={props.accounts.length} />;
      case "ai":
        return (
          <Page icon={SparklesIcon} title="AI" description="What your AI used, the limits Kite holds it to, and which AI it is.">
            <AiSection
              usage={props.aiUsage}
              models={preferences.aiModels}
              onLimits={(aiLimits) => props.onPreferences({ aiLimits })}
              onModels={(aiModels) => props.onPreferences({ aiModels })}
              onOpenAi={props.onOpenAi}
              demo={props.demo}
            />
          </Page>
        );
      case "appearance":
        return (
          <Page icon={PaintBoardIcon} title="Appearance" description="How Kite looks and how conversations open.">
            <Group title="Look">
              <Row
                label="Theme"
                detail="The sidebar stays dark. The panes follow this."
                control={<Segmented label="Pane theme" value={props.themePref} options={THEMES} onChange={props.onThemePref} />}
              />
              <Row
                label="Open Kite on"
                detail="Where you were last time, or always the same place."
                control={
                  <Segmented label="Open Kite on" value={preferences.startView} options={START_OPTIONS} onChange={(startView) => void props.onPreferences({ startView })} />
                }
              />
              <ToggleRow
                label="Open conversations as chat"
                detail="Bubbles with only the new text. Switch any conversation from the reader."
                value={preferences.chatView}
                onChange={(chatView) => void props.onPreferences({ chatView })}
              />
            </Group>
            <TranslateGroup preferences={preferences} onPreferences={props.onPreferences} />
            <Group title="Touch-screen swipes" description="These gestures need a touch screen. With a mouse, hover over a conversation for Delete, Mark as unread and other actions. The Screener always swipes to Allow and Block.">
              {(["right", "left"] as SwipeSide[]).map((side) => (
                <Row
                  key={side}
                  label={side === "right" ? "Swipe right" : "Swipe left"}
                  control={
                    <Select
                      label={side === "right" ? "Swipe right" : "Swipe left"}
                      value={preferences.swipe[side]}
                      options={SWIPE_OPTIONS}
                      onChange={(action) => void props.onPreferences({ swipe: { [side]: action } })}
                    />
                  }
                />
              ))}
            </Group>
            <Group title="Fonts" bare>
              <FontSection />
            </Group>
          </Page>
        );
      case "privacy":
        return (
          <Page icon={Shield01Icon} title="Privacy" description="Kite removes tracking pixels from every email. These cover the rest.">
            <Group title="Images and links">
              <ImagesRow value={preferences.privacy.images} onChange={(images) => void props.onPreferences({ privacy: { images } })} />
              {preferences.privacy.images === "ask" ? <ImageSenders people={props.people} onRemove={(email) => props.onPerson({ email, images: false })} /> : null}
              <ToggleRow
                label="Clean tracking from links"
                detail="Strips campaign tags and unwraps redirects. Sign-in and unsubscribe links are never changed."
                value={preferences.privacy.cleanLinks}
                onChange={(cleanLinks) => void props.onPreferences({ privacy: { cleanLinks } })}
              />
              <ToggleRow
                label="Company logos from the web"
                detail={
                  preferences.privacy.webPictures
                    ? "Company senders get a logo, Gravatar or site icon. Personal addresses never leave for a picture."
                    : "Nothing is looked up. Senders show their initials."
                }
                value={preferences.privacy.webPictures}
                onChange={(webPictures) => void props.onPreferences({ privacy: { webPictures } })}
              />
            </Group>
            <Group title="Connections">
              <ToggleRow
                label="Cloudflare DNS when this computer's fails"
                detail="Finds mail servers and company logos when Windows can't look a domain up. Only the domain name is sent."
                value={preferences.privacy.dnsFallback}
                onChange={(dnsFallback) => void props.onPreferences({ privacy: { dnsFallback } })}
              />
              <ToggleRow
                label="Check for updates"
                detail={
                  preferences.privacy.updateChecks
                    ? "The desktop app asks GitHub for a newer version now and again. Nothing installs until you click Update."
                    : "No automatic checks. Settings → About still checks when you ask."
                }
                value={preferences.privacy.updateChecks}
                onChange={(updateChecks) => void props.onPreferences({ privacy: { updateChecks } })}
              />
            </Group>
            <Group title="App lock">
              <LockRow
                on={props.lockOn}
                after={preferences.privacy.lockAfter}
                onAfter={(lockAfter) => void props.onPreferences({ privacy: { lockAfter } })}
                onChanged={props.onLockChanged}
                onToast={props.onToast}
              />
            </Group>
            {props.demo ? null : <PrivacyLog onToast={props.onToast} />}
          </Page>
        );
      case "data":
        return (
          <Page icon={DatabaseIcon} title="Data" description="Your mail is stored here, so lists and search never wait on the network.">
            {props.demo ? (
              <Note>Nothing is stored yet. Connect an account to keep your mail here.</Note>
            ) : (
              <DataSection storage={storage} onChanged={setStorage} onToast={props.onToast} />
            )}
          </Page>
        );
      case "about":
        return (
          <Page icon={InformationCircleIcon} title="About" description="Which Kite this is, and its updates.">
            <AboutSection desktop={desktop} />
          </Page>
        );
    }
  })();

  return (
    <section ref={sectionRef} className="@container flex h-full overflow-hidden rounded-2xl bg-pane pane-on-sky text-pane-fg">
      <nav onKeyDown={onNavKey} className="flex w-[clamp(184px,24%,232px)] shrink-0 flex-col border-r border-pane-border @max-[640px]:w-[60px]">
        <div className="flex flex-col gap-3 px-3 pb-2 pt-4 @max-[640px]:hidden">
          <h1 className="px-2 text-[20px] font-medium tracking-[-0.035em]"><AccentTitle text="Settings" /></h1>
          <label className="flex h-8 items-center gap-2 rounded-full bg-pane-2 px-3 shadow-[inset_0_0_0_1px_var(--pane-border)] transition-shadow focus-within:shadow-[inset_0_0_0_1px_var(--accent)]">
            <Icon icon={Search01Icon} size={14} className="shrink-0 text-pane-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && results[0]) pick(results[0]);
                if (e.key === "Escape") setQuery("");
              }}
              placeholder="Search settings"
              aria-label="Search settings"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-pane-muted"
            />
            {query ? (
              <Tooltip label="Clear">
                <button aria-label="Clear search" onClick={() => setQuery("")} className="grid size-5 shrink-0 place-items-center rounded-full text-pane-muted hover:text-pane-fg">
                  <Icon icon={Cancel01Icon} size={12} />
                </button>
              </Tooltip>
            ) : null}
          </label>
        </div>

        <div className="scroll-fade min-h-0 flex-1 overflow-y-auto px-3 pb-4 @max-[640px]:px-2 @max-[640px]:pt-3">
          <AnimatePresence mode="popLayout" initial={false}>
            {query ? (
              <motion.div key="results" {...blurFade({ y: 4, blur: 4 })} className="pt-1">
                {results.length ? (
                  <FluidList tone="pane" className="flex flex-col gap-0.5">
                    {results.map((entry, i) => {
                      const where = NAV.flatMap((g) => g.items).find((item) => item.id === entry.section);
                      return (
                        <button
                          key={`${entry.section}:${entry.label}`}
                          {...FLUID_ITEM}
                          onClick={() => pick(entry)}
                          className={cn(
                            "flex min-w-0 flex-col items-start rounded-lg px-2.5 py-1.5 text-left transition-colors duration-150",
                            i === 0 && "bg-pane-hover",
                            "data-[lit]:bg-pane-hover",
                          )}
                        >
                          <span className="w-full truncate text-[13px] font-medium">{entry.label}</span>
                          <span className="flex items-center gap-1 text-[11.5px] text-pane-muted">
                            {where ? <Icon icon={where.icon} size={12} /> : null}
                            {where?.label}
                          </span>
                        </button>
                      );
                    })}
                  </FluidList>
                ) : (
                  <p className="px-2.5 py-2 text-[12.5px] text-pane-muted">Nothing matches “{query}”.</p>
                )}
              </motion.div>
            ) : (
              <motion.div key="nav" {...blurFade({ y: -4, blur: 4 })} className="flex flex-col gap-4 pt-1">
                {NAV.map((group) => (
                  <div key={group.title} className="flex flex-col gap-0.5">
                    <p className="px-2.5 pb-1 text-[11.5px] font-medium text-pane-muted @max-[640px]:hidden">{group.title}</p>
                    <FluidList tone="pane" className="flex flex-col gap-0.5">
                      {group.items.map((item) => {
                        const current = item.id === active;
                        const button = (
                          <button
                            key={item.id}
                            {...FLUID_ITEM}
                            data-page={item.id}
                            aria-current={current ? "page" : undefined}
                            onClick={() => open(item)}
                            className={cn(
                              "group relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-[color,background-color,font-weight] duration-150",
                              current ? "font-medium text-pane-fg" : "text-pane-muted data-[lit]:text-pane-fg",
                            )}
                          >
                            {current ? <motion.span layoutId="settings-nav" transition={springSnappy} className="absolute inset-0 rounded-lg bg-pane-hover" /> : null}
                            <Icon icon={item.icon} size={15} className="relative shrink-0" />
                            <span className="relative min-w-0 flex-1 truncate text-left @max-[640px]:sr-only">{item.label}</span>
                            {item.id === "shortcuts" ? (
                              <span className="relative shrink-0 opacity-70 @max-[640px]:hidden">
                                <ShortcutsHint />
                              </span>
                            ) : "opens" in item ? (
                              <Icon icon={ArrowUpRight01Icon} size={12} className="relative shrink-0 opacity-0 transition-opacity duration-150 group-data-[lit]:opacity-60 @max-[640px]:hidden" />
                            ) : item.id === "accounts" && reconnectCount ? (
                              <Icon icon={Alert02Icon} size={13} className="relative shrink-0 text-warning @max-[640px]:absolute @max-[640px]:right-1 @max-[640px]:top-1 @max-[640px]:size-2.5" />
                            ) : null}
                          </button>
                        );
                        // Collapsed to icons: the label moves to a tooltip.
                        return narrow ? (
                          <Tooltip key={item.id} label={item.label} side="right" className="flex flex-col">
                            {button}
                          </Tooltip>
                        ) : (
                          button
                        );
                      })}
                    </FluidList>
                  </div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </nav>

      <div ref={scrollRef} className="scroll-fade min-w-0 flex-1 overflow-y-auto">
        <AnimatePresence mode="wait" initial={false} onExitComplete={() => scrollRef.current?.scrollTo({ top: 0 })}>
          <motion.div
            key={active}
            {...blurFade({ y: direction * 10, blur: 4, speed: "moderate" })}
            onAnimationComplete={land}
            className="mx-auto max-w-[720px] px-[clamp(16px,5cqw,32px)] pb-24 pt-8"
          >
            {page}
          </motion.div>
        </AnimatePresence>
      </div>

      {editing ? (
        <SignatureEditor
          key={editing.id}
          open={editorOpen}
          account={editing}
          initial={preferences.signatures[editing.id] ?? null}
          onSave={(design) => props.onPreferences({ signatures: { [editing.id]: design } })}
          onRemove={() => props.onPreferences({ signatures: { [editing.id]: null } })}
          onClose={() => setEditorOpen(false)}
        />
      ) : null}
    </section>
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

/**
 * "Reconnect" links for accounts whose sign-in is missing a permission, under a short why. Gmail over
 * IMAP gets "Connect Google" instead: its optional Google sign-in asks for it.
 */
function ReconnectNote({ why, accounts }: { why: string; accounts: Account[] }) {
  return (
    <AnimatePresence initial={false}>
      {accounts.length ? (
        <motion.div {...blurFade({ y: -4 })}>
          <Note>
            {why}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {accounts.map((account) => {
                const verb = account.googleLink !== undefined ? "Connect Google" : "Reconnect";
                return (
                  <a key={account.id} href={permissionHref(account)} className={cn(buttonClass, "border-accent/50 text-accent")}>
                    {accounts.length === 1 ? verb : `${verb} for ${accountName(account)}`}
                  </a>
                );
              })}
            </div>
          </Note>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function SenderPhotos({ value, accounts, onChange }: { value: boolean; accounts: Account[]; onChange: (value: boolean) => void }) {
  // Accounts whose sign-in doesn't include contacts yet. Until they reconnect, Kite uses the other sources.
  const missing = value ? accounts.filter((a) => a.contactPhotos === false) : [];
  return (
    <ToggleRow
      label="Photos from Google contacts"
      detail={value ? "Kite asks Google only about senders you see, and keeps the photos here." : "Show the photo from your Google contacts next to people who email you."}
      value={value}
      onChange={onChange}
    >
      <ReconnectNote
        why="Google needs your permission first: tick the contacts boxes when it asks. Until then Kite uses logos and Gravatar."
        accounts={missing}
      />
    </ToggleRow>
  );
}

function CalendarAccess({ value, accounts, onChange }: { value: boolean; accounts: Account[]; onChange: (value: boolean) => void }) {
  // Accounts whose sign-in doesn't include the calendar yet. Until they reconnect, invite cards ask first.
  const missing = value ? accounts.filter((a) => a.calendar === false) : [];
  return (
    <ToggleRow
      label="Use your calendar"
      detail={
        value
          ? "Events show in Today and Calendar; invite answers and Add to calendar go to your calendar. Kite never answers or adds by itself."
          : "Show your events, answer invites in your calendar and add events from mail."
      }
      value={value}
      onChange={onChange}
    >
      <ReconnectNote
        why="Allow calendar access first. Until then Today has no events for these accounts."
        accounts={missing}
      />
      <MailCalendarNote accounts={accounts.filter((a) => a.mailCalendar)} />
    </ToggleRow>
  );
}

/** Accounts without a calendar Kite can reach get Kite's mail calendar: say plainly what it can and can't do. */
function MailCalendarNote({ accounts }: { accounts: Account[] }) {
  if (!accounts.length) return null;
  return (
    <Note>
      {accounts.map(accountName).join(", ")} {accounts.length === 1 ? "has" : "have"} no calendar Kite can reach, so Kite builds one from the invites in
      your mail: ones you answered Yes or Maybe, and ones you haven&rsquo;t answered yet. It can&rsquo;t see events that never came by email, and events you
      add stay in Kite, not on your phone.
      {accounts.some((a) => a.googleLink === false) ? " For Gmail, Connect Google on the account above to use Google Calendar instead." : null}
    </Note>
  );
}

function AccountRow({
  account,
  demo,
  reconnect,
  info,
  onDisconnected,
  onChange,
  onError,
  onSignInAgain,
}: {
  account: Account;
  demo: boolean;
  reconnect: boolean;
  info?: StorageInfo["accounts"][number];
  onDisconnected: () => void;
  onChange: (patch: Partial<Account>) => void;
  onError: (message: string) => void;
  onSignInAgain: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [look, setLook] = useState(false);
  const [name, setName] = useState(account.nickname ?? "");

  /** Saves the name shown in Kite's sidebar and switcher. Empty goes back to the Google name. */
  const saveName = async () => {
    const nickname = name.trim() || null;
    if (nickname === (account.nickname ?? null)) return;
    const before = account.nickname ?? null;
    onChange({ nickname });
    if (demo) return;
    try {
      await request(`/api/accounts`, "PATCH", { id: account.id, nickname });
    } catch (error) {
      onChange({ nickname: before });
      setName(before ?? "");
      onError(error instanceof Error && error.message !== "Request failed" ? error.message : "Couldn't rename the account. Try again.");
    }
  };
  const [busy, setBusy] = useState(false);
  const spec = accountSpec(account);
  const syncing = useAccountSync(account.id);
  const status = demo
    ? "Demo account"
    : syncing && !reconnect
      ? `Syncing · ${syncCount(syncing)}`
    : reconnect
      ? spec.signIn === "imap"
        ? "Your mail server stopped accepting the password. Reconnect to keep syncing."
        : `${signInCompany(spec.signIn)} stopped letting Kite in. Reconnect to keep syncing.`
      : info
        ? `${info.threads.toLocaleString()} conversations${info.syncedAt ? ` · synced ${formatDistanceToNow(new Date(info.syncedAt), { addSuffix: true })}` : ""}`
        : serviceName(account);

  const disconnect = async () => {
    setBusy(true);
    try {
      await request(`/api/accounts?id=${encodeURIComponent(account.id)}`, "DELETE");
      onDisconnected();
    } catch {
      onError("Couldn't disconnect. Try again.");
      setBusy(false);
    }
  };

  const highlight = reconnect || !!account.reconnectFor;
  return (
    <div className="flex flex-col gap-2.5 px-4 py-3.5" data-sensitive>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
        <Tooltip label={look ? "Done" : "Colour and picture"}>
          <button aria-label="Colour and picture" aria-expanded={look} onClick={() => setLook((v) => !v)} className="rounded-full transition-transform duration-150 hover:scale-105">
            <AccountFace account={account} syncing={!!syncing && !reconnect} className="size-9 text-[12px]" />
          </button>
        </Tooltip>
        <div className="min-w-0 flex-1 basis-48">
          <input
            value={name}
            maxLength={40}
            aria-label={`Name for ${account.email} in Kite`}
            placeholder={account.name || "Name this account"}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void saveName()}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setName(account.nickname ?? "");
                requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
              }
            }}
            className="-mx-1.5 h-7 w-full max-w-[260px] rounded-md border border-transparent bg-transparent px-1.5 text-[13.5px] font-semibold outline-none transition-colors placeholder:text-pane-fg hover:border-pane-border focus:border-accent/60 focus:placeholder:text-pane-muted"
          />
          <p className="truncate text-[12px] text-pane-muted">
            {account.email} <span className="opacity-60">·</span> {serviceName(account)}
          </p>
          <p className={cn("mt-0.5 flex items-center gap-1 truncate text-[12px]", reconnect ? "text-warning" : "text-pane-muted")}>
            {reconnect ? <Icon icon={Alert02Icon} size={13} className="shrink-0" /> : syncing ? <Spinner size={12} className="shrink-0 text-accent" /> : null}
            {status}
          </p>
        </div>
        {demo ? null : (
          <div className="flex shrink-0 items-center gap-1.5">
            {spec.signIn === "imap" ? (
              // A password account signs in again in Kite's own form.
              <button onClick={onSignInAgain} className={cn(buttonClass, highlight && "border-accent/50 text-accent")}>
                Reconnect
              </button>
            ) : (
              <a href={`/api/auth/${spec.signIn}?hint=${encodeURIComponent(account.email)}`} className={cn(buttonClass, highlight && "border-accent/50 text-accent")}>
                Reconnect
              </a>
            )}
            <button onClick={() => setConfirming(true)} disabled={confirming} className={buttonClass}>
              Disconnect
            </button>
          </div>
        )}
      </div>
      <AnimatePresence initial={false}>{look ? <AccountLook account={account} demo={demo} onChange={onChange} onError={onError} /> : null}</AnimatePresence>
      {account.reconnectFor && !reconnect && !demo ? <Note>{account.reconnectFor}</Note> : null}
      {account.googleLink !== undefined && !demo ? <GoogleLink account={account} onError={onError} /> : null}
      <AnimatePresence initial={false}>
        {confirming ? (
          <Confirm action="Disconnect" busy={busy} onCancel={() => setConfirming(false)} onConfirm={() => void disconnect()}>
            Kite signs out and removes this account&apos;s mail from this computer. Nothing changes in {serviceName(account)}.
          </Confirm>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/**
 * Gmail over IMAP: the optional Google sign-in for what IMAP can't give (the account's photo, its
 * calendar, photos from its contacts). Never asks for mail, never required.
 */
function GoogleLink({ account, onError }: { account: Account; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const unlink = async () => {
    setBusy(true);
    try {
      await request(`/api/google-link?account=${encodeURIComponent(account.id)}`, "DELETE");
    } catch {
      onError("Couldn't disconnect Google. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-pane-2 px-3 py-2 text-[12px]">
      <span className="min-w-0 flex-1 basis-56 text-pane-muted">
        {account.googleLink
          ? "Google sign-in connected for your photo, calendar and contact photos. It can't read your mail."
          : "Connect Google for your photo, calendar and contact photos. Optional, and it can't read your mail."}
      </span>
      {account.googleLink ? (
        <button onClick={() => void unlink()} disabled={busy} className={cn(buttonClass, "flex items-center gap-1.5")}>
          {busy ? <Spinner size={12} /> : null}
          Disconnect Google
        </button>
      ) : (
        <a href={permissionHref(account)} className={buttonClass}>
          Connect Google
        </a>
      )}
    </div>
  );
}

function SignatureCard({ account, design, onEdit }: { account: Account; design: Design | undefined; onEdit: () => void }) {
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-pane-border">
      <div className="flex min-w-0 items-center gap-2.5 px-3.5 py-3">
        <AccountFace account={account} className="size-6 text-[10px]" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium">{accountName(account)}</p>
          <p className="truncate text-[11.5px] text-pane-muted">{account.email}</p>
        </div>
        <button onClick={onEdit} className={buttonClass}>
          {design ? "Edit" : "Design"}
        </button>
      </div>
      <button
        onClick={onEdit}
        className="group block min-h-24 flex-1 border-t border-pane-border bg-pane-2/60 p-2 text-left transition-colors hover:bg-pane-hover"
        aria-label={`${design ? "Edit" : "Design a"} signature for ${account.email}`}
      >
        {design ? (
          <DesignPreview design={design} className="pointer-events-none" />
        ) : (
          <span className="grid h-full min-h-20 place-items-center rounded-lg border border-dashed border-pane-border text-[12px] text-pane-muted transition-colors group-hover:text-pane-fg">
            No signature yet
          </span>
        )}
      </button>
    </div>
  );
}

const START_OPTIONS: { id: StartView; label: string }[] = [
  { id: "last", label: "Last screen" },
  { id: "home", label: "Home" },
  { id: "inbox", label: "Inbox" },
];

const THEMES: { id: ThemePref; label: string; icon: IconData }[] = [
  { id: "light", label: "Light", icon: Sun03Icon },
  { id: "dark", label: "Dark", icon: Moon02Icon },
  { id: "system", label: "System", icon: ComputerIcon },
];

function ShortcutsHint() {
  const { primary } = useShortcuts();
  const combo = primary("shortcuts");
  return combo ? <KeyCombo combo={combo} keyClassName="bg-pane-2 text-pane-muted" /> : null;
}

function DataSection({
  storage,
  onChanged,
  onToast,
}: {
  storage: StorageInfo | null;
  onChanged: (storage: StorageInfo) => void;
  onToast: (message: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<"reset-cache" | "clear-avatars" | null>(null);

  const run = async (action: "reset-cache" | "clear-avatars") => {
    setBusy(action);
    try {
      const res = await request<{ storage: StorageInfo }>("/api/settings", "POST", { action });
      onChanged(res.storage);
      onToast(action === "reset-cache" ? "Local copy cleared. Downloading your mail again." : "Pictures and files cleared");
      setConfirming(false);
    } catch {
      onToast("That didn't go through. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const stats: [string, string][] = storage
    ? [
        ["Mail database", formatBytes(storage.database)],
        ["Pictures and files", formatBytes(storage.avatars + (storage.attachments ?? 0))],
        ["Conversations", storage.threads.toLocaleString()],
        ["Readable offline", storage.offline.toLocaleString()],
      ]
    : [];

  return (
    <>
      <Group title="On this computer" bare>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,9rem),1fr))] gap-2">
          {(stats.length ? stats : [["", ""], ["", ""], ["", ""], ["", ""]]).map(([label, value], i) => (
            <div key={i} className="rounded-xl border border-pane-border px-3.5 py-3">
              {label ? (
                <div key={value} className="blur-fade">
                  <p className="text-[18px] font-semibold tabular-nums tracking-tight">{value}</p>
                  <p className="mt-0.5 text-[11.5px] text-pane-muted">{label}</p>
                </div>
              ) : (
                <div className="h-[45px] animate-pulse rounded-md bg-pane-2" />
              )}
            </div>
          ))}
        </div>
      </Group>

      <Group title="Maintenance">
        <Row
          label="Clear pictures and files"
          detail="Sender pictures and opened attachments. Fetched again when needed."
          control={
            <button onClick={() => void run("clear-avatars")} disabled={busy != null} className={buttonClass}>
              {busy === "clear-avatars" ? <Spinner /> : null}
              Clear
            </button>
          }
        />
        <Row
          label="Reset local copy"
          detail="Fixes mail that looks out of date by downloading it again."
          control={
            <button onClick={() => setConfirming(true)} disabled={busy != null || confirming} className={buttonClass}>
              Reset
            </button>
          }
        >
          <AnimatePresence initial={false}>
            {confirming ? (
              <Confirm action="Reset and download" busy={busy === "reset-cache"} onCancel={() => setConfirming(false)} onConfirm={() => void run("reset-cache")}>
                Removes the local copy of your mail. Accounts, Screener decisions, automations and their collections, snoozes and scheduled sends are kept.
              </Confirm>
            ) : null}
          </AnimatePresence>
        </Row>
      </Group>

      <Group title="Start over">
        <EraseRow onToast={onToast} />
      </Group>
    </>
  );
}

/** Erases everything Kite keeps and disconnects every account, after an inline confirm. */
function EraseRow({ onToast }: { onToast: (message: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const erase = async () => {
    setBusy(true);
    try {
      await request("/api/settings", "POST", { action: "erase-everything" });
      try {
        for (const key of Object.keys(localStorage)) if (key.startsWith("kite-")) localStorage.removeItem(key);
      } catch {}
      window.location.reload();
    } catch {
      setBusy(false);
      onToast("Kite couldn't erase everything. Try again.");
    }
  };
  return (
    <Row
      label="Erase everything"
      detail="Disconnects every account and deletes all mail, settings, automations and files Kite keeps here."
      control={
        <button onClick={() => setConfirming(true)} disabled={busy || confirming} className={cn(buttonClass, "text-warning")}>
          Erase
        </button>
      }
    >
      <AnimatePresence initial={false}>
        {confirming ? (
          <Confirm action="Erase everything" danger busy={busy} onCancel={() => setConfirming(false)} onConfirm={() => void erase()}>
            This can&apos;t be undone. Your mail stays with your provider.
          </Confirm>
        ) : null}
      </AnimatePresence>
    </Row>
  );
}
