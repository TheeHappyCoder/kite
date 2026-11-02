"use client";

import { DatabaseIcon, InformationCircleIcon, FilePenIcon, FolderCloudIcon, KeyboardIcon, LayoutTemplateIcon, MailEdit02Icon, Notification03Icon, PlugSocketIcon, PaintBoardIcon, CursorPointer01Icon, SignatureIcon, SparklesIcon, Shield01Icon, UserCircleIcon, Tag01Icon } from "@hugeicons/core-free-icons";
import { type IconData } from "../icon";

export type SettingsSection = "accounts" | "labels" | "compose" | "signatures" | "templates" | "fillSign" | "notifications" | "bar" | "files" | "ai" | "privacy" | "appearance" | "buttons" | "data" | "about";

export type NavItem = { id: SettingsSection; label: string; icon: IconData } | { id: "shortcuts"; label: string; icon: IconData; opens: true };

/** The nav, in groups. Shortcuts opens its own dialog. */
export const NAV: { title: string; items: NavItem[] }[] = [
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
      { id: "buttons", label: "Buttons", icon: CursorPointer01Icon },
      { id: "privacy", label: "Privacy", icon: Shield01Icon },
      { id: "shortcuts", label: "Shortcuts", icon: KeyboardIcon, opens: true },
      { id: "data", label: "Data", icon: DatabaseIcon },
      { id: "about", label: "About", icon: InformationCircleIcon },
    ],
  },
];

export const PAGES = NAV.flatMap((g) => g.items).filter((item): item is Extract<NavItem, { id: SettingsSection }> => !("opens" in item));

export const pageIndex = (id: SettingsSection) => PAGES.findIndex((p) => p.id === id);

/**
 * What search finds: each entry is a row label (or group title) on a page, plus words people might
 * type for it. Labels must match the `label`/`title` the page renders, so search can land on the row.
 */
export const SEARCH: { section: SettingsSection | "shortcuts"; label: string; words?: string }[] = [
  { section: "accounts", label: "Connected accounts", words: "gmail outlook imap reconnect disconnect add sign in nickname rename colour color picture photo avatar ring" },
  { section: "accounts", label: "Photos from Google contacts", words: "avatar picture people" },
  { section: "accounts", label: "Use your calendar", words: "events invites today google outlook" },
  { section: "labels", label: "Labels & folders", words: "label folder category tag new make create rename delete remove organise" },
  { section: "compose", label: "Undo send", words: "delay hold take back" },
  { section: "compose", label: "Waiting on", words: "reply tracking follow up nudge no answer days today" },
  { section: "compose", label: "Snippets", words: "text shortcut ; canned replies" },
  { section: "signatures", label: "Signatures", words: "sign off footer logo" },
  { section: "appearance", label: "Always show quoted text", words: "quotes forwarded fyi see below earlier messages expand fold collapse history" },
  { section: "appearance", label: "Always show signatures", words: "signature expand fold collapse sign off" },
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
  { section: "buttons", label: "Reader toolbar", words: "buttons icons customise customize archive snooze delete reply forward star files chat people screenshot more toolbar" },
  { section: "buttons", label: "Conversation list", words: "hover buttons icons customise customize archive snooze delete read star pin mute row" },
  { section: "buttons", label: "Swipe right", words: "gesture touch swipe actions archive snooze trash phone tablet" },
  { section: "buttons", label: "Swipe left", words: "gesture touch swipe actions archive snooze trash phone tablet" },
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
