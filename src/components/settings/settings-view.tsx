"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Alert02Icon, ArrowUpRight01Icon, ComputerIcon, DatabaseIcon, InformationCircleIcon, FilePenIcon, LayoutTemplateIcon, MailEdit02Icon, Moon02Icon, PaintBoardIcon, CursorPointer01Icon, Search01Icon, SignatureIcon, SparklesIcon, Sun03Icon, Shield01Icon, UserCircleIcon, Cancel01Icon, Tag01Icon } from "@hugeicons/core-free-icons";
import { type Account } from "@/lib/mail/types";
import { blurFade, springSnappy } from "@/lib/motion";
import { inDesktopApp } from "@/lib/desktop";
import { AboutSection } from "./about-section";
import { UNDO_SEND_CHOICES, WAIT_DAY_CHOICES, type Preferences, type PreferencesPatch, type StartView, type StorageInfo } from "@/lib/settings";
import { useShortcuts } from "@/lib/shortcuts";
import type { ThemePref } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Icon, type IconData } from "../icon";
import { KeyCombo } from "../ui/kbd";
import { SignatureEditor } from "../design/design-editor";
import { FillSignSection } from "./fill-sign-section";
import { SnippetsSection } from "./snippets-section";
import { TemplatesSection } from "./templates-section";
import { LabelsSection } from "./labels-section";
import { AiSection } from "./ai-section";
import { BarSection } from "./bar-section";
import { DriveSection } from "./drive-section";
import type { AiUsageSummary } from "@/lib/ai-pricing";
import { ImageSenders, ImagesRow, LockRow, PrivacyLog } from "./privacy-section";
import type { PersonPatch, PersonPrefs } from "@/lib/mail/person-prefs";
import { FontSection } from "./font-section";
import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { Tooltip } from "../ui/tooltip";
import { Group, Note, Page, Row, Segmented, ToggleRow, buttonClass } from "./settings-ui";
import { TranslateGroup } from "./translate-section";
import { Select } from "../ui/select";
import { ButtonsSection } from "./buttons-section";
import { SWIPE_ACTIONS, SWIPE_INFO, type SwipeAction, type SwipeSide } from "@/lib/swipe";
import { AccentTitle } from "../ui/accent-title";
import { NAV, type NavItem, PAGES, SEARCH, type SettingsSection, pageIndex } from "./settings-nav";
import { AccountRow, CalendarAccess, SenderPhotos, SignatureCard } from "./account-row";
import { DataSection } from "./data-section";
import { NotificationsSection } from "./notifications-section";

const noSubscribe = () => () => {};

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
        return <NotificationsSection preferences={preferences} onPreferences={props.onPreferences} desktop={desktop} people={props.people} onPerson={props.onPerson} onOpenAutomations={props.onOpenAutomations} />;
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
            <Group title="Fonts" bare>
              <FontSection />
            </Group>
          </Page>
        );
      case "buttons":
        return (
          <Page icon={CursorPointer01Icon} title="Buttons" description="Which actions get a button of their own. Everything else stays one click away in More.">
            <ButtonsSection buttons={preferences.buttons} onChange={(buttons) => void props.onPreferences({ buttons })} />
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
