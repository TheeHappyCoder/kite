"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { inScope, pruneScope, scopeIds, type AccountScope } from "@/lib/mail/scope";
import { inboxTabs, type InboxSide } from "@/lib/mail/sides";
import { ACCOUNTS, createDemoThreads } from "@/lib/mail/demo-data";
import { mailReducer, shownThread, visibleThreads, type MailState, type View } from "@/lib/mail/store";
import { personKey, type PersonPrefs } from "@/lib/mail/person-prefs";
import { applyOverride, type ThreadOverride } from "@/lib/mail/overrides";
import type { Account, Thread } from "@/lib/mail/types";
import { threadKey } from "@/lib/mail/threads";
import { inDesktopApp } from "@/lib/desktop";
import { applyPatch, DEFAULT_PREFERENCES, type Preferences, type PreferencesPatch } from "@/lib/settings";
import { rememberView, startViewFor } from "@/lib/start-view";
import { useTheme } from "@/lib/theme";
import type { OnboardingStart } from "../onboarding";
import { ShortcutsDialog } from "../shortcuts-dialog";
import { LockScreen } from "../lock-screen";
import { CleanupList, CleanupPane, useCleanup } from "./cleanup-view";
import { CommandPalette } from "./command-palette";
import { TranslateContext } from "./translate";
import { PrivacyContext, type PrivacyPolicy } from "./privacy-chip";
import type { FileRef } from "../files/file-preview";
import { FillSignContext } from "../files/fill-sign";
import type { RichEditorHandle } from "./rich-editor";
import { MessageList } from "./message-list";
import { FirstSyncContext } from "./first-sync";
import { BulkPanel, type BulkAction } from "./bulk-panel";
import { Reader } from "./reader";
import { MergePicker } from "./merge-picker";
import { PeoplePanel } from "./people-panel";
import { Sidebar, SidebarDrawer, SidebarTopBar } from "./sidebar";
import { MailPanes, WithPaneBack } from "./mail-panes";
import { TWO_PANES_MIN, useSidebarMode, useWidth, type SidebarMode } from "@/lib/layout";
import { cn } from "@/lib/utils";
import { useSkyPhase } from "@/lib/use-sky";
import type { CalendarEvent } from "@/lib/calendar/event";
import type { DesktopCode } from "@/lib/desktop";
import type { PreparedReply } from "@/lib/rules/prepared";
import { CodePopup, type CodeAlert } from "../code-popup";
import type { CalendarHandle } from "../calendar/calendar-view";
import type { EventSeed } from "../today/add-event";
import { whenFromSelection } from "@/lib/calendar/when";
import { nudgeLine } from "@/lib/replies";
import { LabelPicker } from "./labels";
import { accountSpec, providerSpec, serviceNames } from "@/lib/mail/providers";
import type { AiUsageSummary } from "@/lib/ai-pricing";
import { AiUsageContext } from "../ai-usage-link";
import { useScreenshot } from "./app/use-screenshot";
import { AddEventDialog, AiSettings, AutomationsView, ContactsView, NotesView, ScreenshotEditor, CalendarView, Compose, FilesView, Onboarding, PdfEditor, SettingsView } from "./app/lazy";
import { AppToast, ScreenPrivacyBadge, useToastTimer } from "./app/toast";
import { useAiMail } from "./app/use-ai-mail";
import { useAppLock } from "./app/use-app-lock";
import { useComposers } from "./app/use-composers";
import { useCounts } from "./app/use-counts";
import { useAppKeys, type KeyHandlers } from "./app/use-keyboard";
import { useLabels } from "./app/use-labels";
import { useLiveEvents, useNotifications } from "./app/use-live-events";
import { useMailList } from "./app/use-mail-list";
import { usePeople } from "./app/use-people";
import { useRegroup } from "./app/use-regroup";
import { useSending } from "./app/use-sending";
import { useThreadActions } from "./app/use-thread-actions";
import { useToday } from "./app/use-today";
import { HomeView } from "../home/home-view";
import type { ExpectAction } from "../home/day";
import type { Expectation } from "@/lib/automations/expect";
import type { ComposeDraft } from "@/lib/mail/compose";
import {
  notify,
  ONBOARDED_KEY,
  postJson,
  readConnectResult,
  readGoogleResult,
  selectedText,
  type ListResponse,
  type Toast,
} from "./app/util";

/** A stable empty list, so memoised panes keep their props. */
const NO_THREADS: Thread[] = [];
/** Stable empty list for Home while Today (and its calendar events) hasn't loaded. */
const NO_EVENTS: CalendarEvent[] = [];

// The app shell: state, live mode, keyboard and the panes. The work lives in ./app (one hook per
// concern); this file wires them together and lays out the screen.
export function MailApp() {
  const [state, dispatch] = useReducer(mailReducer, undefined, (): MailState => ({
    threads: createDemoThreads(),
    view: { kind: "mailbox", mailbox: "inbox" },
    accountId: "all",
    side: "important",
    query: "",
    selectedId: null,
    unseen: null,
    remote: false,
    listQuery: "",
    overrides: {},
  }));
  const { theme, pref: themePref, setPref: setThemePref, toggle: toggleTheme } = useTheme();
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);
  /** "Hold new senders" is on (the Screener mailbox also shows while anyone still waits in it). */
  const [screenerOn, setScreenerOn] = useState(false);
  const preferencesRef = useRef(preferences);
  // Where Kite opens (lib/start-view.ts): every screen the user goes to is kept for the next start.
  const startedRef = useRef(false);
  const viewRef = useRef(state.view);
  useEffect(() => {
    viewRef.current = state.view;
    if (startedRef.current) rememberView(state.view);
  }, [state.view]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [fillSign, setFillSign] = useState<{ file: FileRef; layout?: string } | null>(null);
  const openFillSign = useCallback((file: FileRef, options?: { layout?: string }) => setFillSign({ file, layout: options?.layout }), []);
  const [toast, setToast] = useState<Toast | null>(null);
  useToastTimer(toast, setToast);
  const { composers, composeDock, openCompose, closeComposer, minimizeComposer, frontComposer, toggleComposer, composeFull } = useComposers(setToast);
  /** Screen privacy (shift+p): blurs everything marked data-sensitive while sharing a screen. Not remembered. */
  const [screenPrivate, setScreenPrivate] = useState(false);
  useEffect(() => {
    document.documentElement.toggleAttribute("data-screen-private", screenPrivate);
  }, [screenPrivate]);
  const lock = useAppLock(preferencesRef, setToast);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>(ACCOUNTS);
  /** The services behind these accounts ("Gmail", "Gmail and iCloud Mail"); all accounts when none is given. */
  const serviceOf = useCallback(
    (accountIds: string[]) => serviceNames(accounts.filter((a) => !accountIds.length || accountIds.includes(a.id))),
    [accounts],
  );
  const [mode, setMode] = useState<"loading" | "demo" | "live">("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const [onboarding, setOnboarding] = useState<OnboardingStart | null>(null);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [aiLabel, setAiLabel] = useState<string | null>(null);
  const [aiPreset, setAiPreset] = useState<string | null>(null);
  /** AI usage and limits: read once, then live from the `ai` sync event (sidebar ring, Settings → AI). */
  const [aiUsage, setAiUsage] = useState<AiUsageSummary | null>(null);
  /** Bumped when the AI setup changes (whether one is connected, its name). */
  const [aiKey, setAiKey] = useState(0);
  /** Bumped when the local copy of a calendar changes (Today reads it again). */
  const [calendarKey, setCalendarKey] = useState(0);
  const [aiOpen, setAiOpen] = useState(false);
  const [codeAlert, setCodeAlert] = useState<CodeAlert | null>(null);
  useSkyPhase();
  const live = mode === "live";
  /** Refresh (button, shortcut, pull to refresh): new mail checked at the provider now, then the list read again. */
  const [checking, setChecking] = useState<"busy" | "done" | null>(null);
  const checkingRef = useRef(false);
  const refresh = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking("busy");
    // Long enough to see the spinner when the check answers at once (demo mode, nothing new).
    const shown = new Promise((done) => setTimeout(done, 450));
    try {
      if (live) {
        await postJson("/api/sync/watch", { now: true }).catch(() => {});
        reload();
      }
      await shown;
    } finally {
      checkingRef.current = false;
      setChecking("done");
      setTimeout(() => setChecking((current) => (current === "done" ? null : current)), 1400);
    }
  }, [live, reload]);
  const searchRef = useRef<HTMLInputElement>(null);
  const filesSearchRef = useRef<HTMLInputElement>(null);
  const replyRef = useRef<RichEditorHandle>(null);

  // Narrow windows: the sidebar becomes a rail, then a drawer (opened for the form it was opened
  // in, so it never pops back open when the window changes); below two panes' minimums, the list
  // and the reader take turns (`paneDetail`: the reader's turn).
  const sidebarMode = useSidebarMode();
  const [drawerFor, setDrawerFor] = useState<SidebarMode | null>(null);
  const drawerOpen = drawerFor === sidebarMode && sidebarMode !== "full";
  const openDrawer = useCallback(() => setDrawerFor(sidebarMode), [sidebarMode]);
  const closeDrawer = useCallback(() => setDrawerFor(null), []);
  const [mainRef, mainWidth] = useWidth<HTMLElement>();
  const onePane = mainWidth !== null && mainWidth < TWO_PANES_MIN;
  const [paneDetail, setPaneDetail] = useState(false);

  const list = useMailList({ live, state, dispatch, reloadKey, reload, setToast });
  const { query, loading, sync, pendingSelect } = list;

  // Only what the list reads: moving the selection doesn't refilter and resort every thread.
  const { threads: stateThreads, overrides: stateOverrides, view: stateView, accountId: stateAccount, side: stateSide, query: stateQuery, listQuery: stateListQuery, remote: stateRemote } = state;
  const threads = useMemo(
    () => visibleThreads({ threads: stateThreads, overrides: stateOverrides, view: stateView, accountId: stateAccount, side: stateSide, query: stateQuery, listQuery: stateListQuery, remote: stateRemote, selectedId: null, unseen: null }),
    [stateThreads, stateOverrides, stateView, stateAccount, stateSide, stateQuery, stateListQuery, stateRemote],
  );
  const listKey = `${state.accountId}:${
    state.view.kind === "mailbox" ? state.view.mailbox : state.view.kind === "label" ? `label:${state.view.accountId}:${state.view.labelId}` : state.view.kind
  }:${state.side}`;
  const listVisible = state.view.kind === "mailbox" || state.view.kind === "label";
  const selected = useMemo(() => shownThread(state, state.selectedId), [state]);

  const {
    checkedSet,
    checkedThreads,
    selecting,
    setChecked,
    clearChecked,
    setOverride,
    remoteMany,
    selectThread,
    moveThread,
    archiveQuietly,
    senderAction,
    actions,
    check,
    clearSelection,
    bulkWith,
    undoToast,
    overrideWithUndo,
    togglePin,
    toggleMute,
  } = useThreadActions({ live, state, dispatch, threads, listKey, listVisible, accounts, serviceOf, setToast, reload });
  /** Opening a conversation from the list: with one pane at a time, the reader takes the screen. */
  const openThread = useCallback(
    (id: string | null) => {
      selectThread(id);
      if (id) setPaneDetail(true);
    },
    [selectThread],
  );
  const { people, setPeople, vips, updatePerson, peopleOpen, setPeopleOpen, personPick, myEmails, showPerson, toggleVip } = usePeople({ accounts, selected, setToast });

  // Translate (components/mail/translate.tsx): the newest open message registers what `t` does.
  const translateHandler = useRef<(() => void) | null>(null);
  const registerTranslate = useCallback((handler: () => void) => {
    translateHandler.current = handler;
    return () => {
      if (translateHandler.current === handler) translateHandler.current = null;
    };
  }, []);
  const translateSettings = useMemo(
    () => ({ to: preferences.translate.to, offer: preferences.translate.offer, register: registerTranslate }),
    [preferences.translate.to, preferences.translate.offer, registerTranslate],
  );

  const privacyPolicy = useMemo<PrivacyPolicy>(
    () => ({
      ...preferences.privacy,
      imagesFrom: (email) => !!people[personKey(email)]?.images,
      setImagesFrom: (email, on) => void updatePerson({ email, images: on }),
      openSettings: () => dispatch({ type: "view", view: { kind: "settings", section: "privacy" } }),
    }),
    [preferences.privacy, people, updatePerson],
  );
  /** Chat or email view: the per-thread choice (stored with the overrides) or the Settings default. */
  const chatFor = useCallback(
    (thread: Thread | null) => !!thread && (state.overrides[thread.id]?.chat ?? preferences.chatView),
    [state.overrides, preferences.chatView],
  );
  const toggleChat = useCallback(() => {
    if (!selected) return;
    const chat = !chatFor(selected);
    // Matching the default forgets the choice, so a later change of the default applies.
    void setOverride(selected.id, { chat: chat === preferences.chatView ? null : chat }, "Kite couldn't remember that view. Try again.");
  }, [selected, chatFor, preferences.chatView, setOverride]);
  const cleanup = state.view.kind === "cleanup";

  const { counts, accountUnread, sideCounts, presentSides, syncLabel, firstSync, syncingIds, firstSyncs, reconnecting } = useCounts({ live, state, serverCounts: list.serverCounts, sync });
  // The provider's inbox tabs in view; Outlook's words when every account in view is Outlook.
  const inView = accounts.filter((a) => inScope(state.accountId, a.id));
  const focusedInbox = inView.length > 0 && inView.every((a) => a.provider === "outlook");
  const tabs = useMemo(() => inboxTabs(presentSides ? (presentSides.split(",") as InboxSide[]) : [], focusedInbox), [presentSides, focusedInbox]);
  // A tab that's gone (its mail read and moved, another account in view) falls back to Primary.
  useEffect(() => {
    if (!tabs.some((t) => t.id === state.side)) dispatch({ type: "side", side: "important" });
  }, [tabs, state.side]);

  /** Changes the accounts in view. A label belongs to one account, so leaving it out opens the inbox. */
  const switchAccount = useCallback(
    (accountId: AccountScope) => {
      if (state.view.kind === "label" && !inScope(accountId, state.view.accountId)) dispatch({ type: "view", view: { kind: "mailbox", mailbox: "inbox" } });
      dispatch({ type: "account", accountId });
    },
    [state.view],
  );

  // Discover connected accounts. With none, show the demo mailbox and onboarding.
  useEffect(() => {
    const connect = readConnectResult();
    const google = readGoogleResult();
    if (google) dispatch({ type: "view", view: { kind: "settings", section: "accounts" } });
    fetch("/api/accounts")
      .then((res) => res.json())
      .then((data: { accounts: Account[] }) => {
        if (data.accounts.length) {
          setAccounts(data.accounts);
          dispatch({ type: "replace", threads: [] });
          dispatch({ type: "remote", remote: true });
          setMode("live");
        } else {
          setMode("demo");
        }
        let seen = false;
        try {
          seen = localStorage.getItem(ONBOARDED_KEY) === "1";
        } catch {}
        if (connect) setOnboarding(connect);
        else if (!data.accounts.length && !seen) setOnboarding({ step: "welcome" });
      })
      .catch(() => setMode("demo"))
      .finally(() => {
        if (google) setToast({ message: google });
      });
  }, []);

  // Preferences live in the local database (demo mode included).
  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data: { preferences: Preferences; screener: boolean; overrides?: Record<string, ThreadOverride>; people?: Record<string, PersonPrefs> }) => {
        setPreferences(data.preferences);
        // The first time only: open where the user was last (or their fixed choice), unless they've moved already.
        if (!startedRef.current) {
          startedRef.current = true;
          if (viewRef.current.kind === "mailbox" && viewRef.current.mailbox === "inbox") {
            const view = startViewFor(data.preferences.startView);
            if (view.kind !== "mailbox" || view.mailbox !== "inbox") dispatch({ type: "view", view });
          }
        }
        if (data.people) setPeople(data.people);
        setScreenerOn(data.screener);
        if (data.overrides) dispatch({ type: "overrides", overrides: data.overrides });
      })
      .catch(() => {});
  }, [reloadKey, setPeople]);

  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  /** Applies a preference change at once, then saves it. Demo signatures stay on the page. */
  const updatePreferences = useCallback(
    async (patch: PreferencesPatch) => {
      setPreferences((current) => applyPatch(current, patch));
      const body = live ? patch : { ...patch, signatures: undefined };
      if (!Object.values(body).some((v) => v !== undefined)) return;
      try {
        const res = await postJson<{ preferences: Preferences }>("/api/settings", body, "PATCH");
        setPreferences((current) => (live ? res.preferences : { ...res.preferences, signatures: current.signatures }));
      } catch (error) {
        setToast({ message: "That setting didn't save. Try again." });
        reload();
        throw error;
      }
    },
    [live, reload],
  );

  const { decide, deliver } = useNotifications(preferencesRef);
  const sending = useSending({
    live,
    accounts,
    threads: state.threads,
    selected,
    preferences,
    dispatch,
    setToast,
    reload,
    openCompose,
    closeComposer,
    composeFull,
    moveThread,
    archiveQuietly,
    serviceOf,
  });
  const { prepared, setPrepared, dropPrepared, startCompose } = sending;

  /**
   * What an automation waits for (Waiting on, Today): Send goes through the usual send (Undo send
   * applies; the wait counts it when it goes); Edit, or a blank Kite couldn't fill, opens compose.
   */
  const expectAction = async (item: Expectation, action: ExpectAction) => {
    if (!live) return setToast({ message: "This is the demo, so nothing is sent or changed. Connect your mail to use it." });
    if (action === "send" || action === "edit") {
      try {
        const res = await fetch(`/api/expectations/${item.id}`);
        const data = (await res.json()) as { draft?: ComposeDraft; missing?: string[]; error?: string };
        if (!res.ok || !data.draft) throw new Error(data.error ?? "That couldn't be prepared. Try again.");
        if (action === "edit" || data.missing?.length) {
          openCompose(data.draft, undefined, { force: true });
          if (action === "send") setToast({ message: `Fill in {${data.missing![0]}} first, then send.` });
          return;
        }
        await sending.send(data.draft, {});
      } catch (error) {
        setToast({ message: error instanceof Error ? error.message : "That couldn't be sent. Try again." });
      }
      return;
    }
    try {
      await postJson(`/api/expectations/${item.id}`, { op: action });
    } catch (error) {
      return setToast({ message: error instanceof Error ? error.message : "That didn't work. Try again." });
    }
    reload();
    if (action === "reopen") return;
    setToast({
      message: action === "received" ? `Marked as in from ${item.who[0]?.name || item.who[0]?.email || "them"}` : "Stopped waiting",
      onUndo: () => void postJson(`/api/expectations/${item.id}`, { op: "reopen" }).then(reload, () => {}),
    });
  };

  /**
   * A fresh sign-in code (Codes, built in): the code bar and a notification in the browser. The
   * desktop app shows its own Kite bar over every window instead, so nothing doubles up.
   */
  const onCode = (code: DesktopCode) => {
    if ((!code.code && !code.choices?.length) || inDesktopApp() || decide({ kind: "code", muted: false }) === "never") return;
    setCodeAlert({ id: code.id, service: code.service, code: code.code, choices: code.choices });
    notify(code.code ? `${code.service} code: ${code.code}` : `${code.service} code`, "Click Copy in Kite, or type it in", preferencesRef.current, ["Sign-in code ready", "Open Kite to copy it"]);
  };

  // The desktop shell opens a conversation from the Kite bar's Open / Reply (src-tauri/src/bar.rs `open_mail`).
  const fromBar = useRef<(target: { threadId: string; accountId: string; subject: string; reply: boolean }) => void>(null);
  useLayoutEffect(() => {
    fromBar.current = ({ reply, ...target }) => {
      list.openFromToday(target);
      if (reply) void startCompose("reply", "", { threadId: target.threadId });
    };
  });
  useEffect(() => {
    if (!inDesktopApp()) return;
    const shell = window as { __kiteOpenMail?: (target: { threadId: string; accountId: string; subject: string; reply: boolean }) => void };
    shell.__kiteOpenMail = (target) => fromBar.current?.(target);
    return () => {
      delete shell.__kiteOpenMail;
    };
  }, []);

  // AI status (live accounts only).
  useEffect(() => {
    if (!live) return;
    fetch("/api/ai")
      .then((res) => res.json())
      .then((data: { settings: { models: { id: string; name: string }[]; defaultModel: string; preset: string; provider: string; hasKey: boolean } | null }) => {
        const models = data.settings?.models ?? [];
        setAiConfigured(!!data.settings && (data.settings.provider !== "anthropic" || data.settings.hasKey));
        setAiLabel((models.find((m) => m.id === data.settings?.defaultModel) ?? models[0])?.name ?? null);
        setAiPreset(data.settings?.preset ?? null);
      })
      .catch(() => {});
    fetch("/api/ai/usage")
      .then((res) => res.json())
      .then((data: AiUsageSummary) => setAiUsage(data))
      .catch(() => {});
  }, [live, aiKey]);

  useLiveEvents(live, {
    decide,
    deliver,
    setToast,
    reload,
    calendarChanged: () => setCalendarKey((k) => k + 1),
    aiUsage: setAiUsage,
    accounts: setAccounts,
    code: onCode,
    mailBar: preferences.desktop.mailBar,
    prepared: (threadId, reply) => setPrepared((current) => (threadId in current ? { ...current, [threadId]: reply } : current)),
  });

  // Cleanup: the sender table comes straight from the local store.
  const cleanupState = useCleanup({ open: cleanup, live, accountId: state.accountId, reloadKey, onToast: setToast });

  const { todayData, todayNow, todayCount } = useToday({
    ready: mode !== "loading",
    live,
    accountId: state.accountId,
    threads: state.threads,
    overrides: state.overrides,
    accounts,
    waitDays: preferences.compose.waitDays,
    refresh: `${reloadKey}:${calendarKey}:${state.view.kind === "home"}`,
  });

  const labels = useLabels({ live, threads: state.threads, accounts, accountId: state.accountId, reloadKey, reload, dispatch, setToast });
  const { allLabels, labelOf, sidebarLabels, pickerThreads, labelPick, openLabels, changeLabels, openLabel } = labels;

  // Live mode: download the full thread the first time it's opened (most are prefetched already).
  useEffect(() => {
    if (!live || !selected || selected.loaded || !selected.remoteId) return;
    const controller = new AbortController();
    const mailbox = state.view.kind === "mailbox" ? state.view.mailbox : "inbox";
    fetch(`/api/mail/threads/${threadKey(selected)}?account=${selected.accountId}&mailbox=${mailbox}`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Couldn't open that conversation"))))
      .then((data: { thread: Thread; prepared?: PreparedReply | null }) => {
        dispatch({ type: "patch", id: selected.id, patch: { messages: data.thread.messages, loaded: true } });
        setPrepared((current) => ({ ...current, [selected.id]: data.prepared ?? null }));
      })
      .catch((error: Error) => {
        if (error.name !== "AbortError") setToast({ message: error.message });
      });
    return () => controller.abort();
  }, [live, selected, state.view, setPrepared]);

  const { undoRegroups, splitThread, mergeThreads } = useRegroup({
    live,
    threads: state.threads,
    selectedId: state.selectedId,
    selected,
    dispatch,
    setToast,
    reload,
    pendingSelect,
    clearChecked,
  });
  const [mergeOpen, setMergeOpen] = useState(false);
  const bulk = useCallback((action: BulkAction) => bulkWith(action, { label: openLabels, merge: mergeThreads }), [bulkWith, openLabels, mergeThreads]);

  // "Add to calendar": the form opens on the subject, and on a date only when the user selected one.
  // Clicking a menu can clear a selection in the page, so the last one made just before is kept briefly.
  const [addEvent, setAddEvent] = useState<EventSeed | null>(null);
  const lastSelection = useRef<{ text: string; at: number } | null>(null);
  useEffect(() => {
    const grab = () => {
      const text = selectedText();
      if (text) lastSelection.current = { text, at: Date.now() };
    };
    window.addEventListener("pointerdown", grab, true);
    window.addEventListener("keydown", grab, true);
    return () => {
      window.removeEventListener("pointerdown", grab, true);
      window.removeEventListener("keydown", grab, true);
    };
  }, []);
  // Calendar: the arrows and "back to today" for the shortcuts.
  const calendarRef = useRef<CalendarHandle>(null);
  const calendarOpen = state.view.kind === "calendar";
  const showReader = useCallback(() => setPaneDetail(true), []);
  const screenshot = useScreenshot({ thread: selected, showReader });
  const openAddEvent = (thread: Thread | null) => {
    const recent = lastSelection.current && Date.now() - lastSelection.current.at < 15_000 ? lastSelection.current.text : "";
    const text = selectedText() || recent;
    lastSelection.current = null;
    setAddEvent({ subject: thread?.subject ?? "", accountId: thread?.accountId, when: text ? whenFromSelection(text, new Date()) : null });
  };
  const mergeCandidates = useMemo(
    () => (mergeOpen ? state.threads.map((t) => applyOverride(t, state.overrides[t.id])) : []),
    [mergeOpen, state.threads, state.overrides],
  );

  // Keep a selection in the list: select the first thread when the current one leaves the view.
  // Home opens nothing by itself: a conversation is a sheet the user opens.
  const home = state.view.kind === "home";
  useEffect(() => {
    if (home) {
      if (state.selectedId && !threads.some((t) => t.id === state.selectedId)) dispatch({ type: "select", id: null });
      return;
    }
    if (threads.length === 0) {
      if (state.selectedId) dispatch({ type: "select", id: null });
      return;
    }
    // Only once the new list has arrived (a search being typed keeps its rows meanwhile).
    if (loading) return;
    // Shown, not opened: it stays unread (locally and in Gmail) until the user picks it.
    if (!state.selectedId || !threads.some((t) => t.id === state.selectedId)) {
      dispatch({ type: "select", id: threads[0].id, peek: true });
    }
  }, [threads, state.selectedId, loading, home]);

  const undo = () => undoToast(toast);

  const setView = (view: View) => {
    dispatch({ type: "view", view });
    setPaneDetail(false);
  };

  /** Settings → AI (usage and limits): the sidebar's AI row and every "Change it in Usage" link. */
  const openAiUsage = () => {
    setAiOpen(false);
    setView({ kind: "settings", section: "ai" });
  };

  const { summaries, summarise, forgetSummary, draftWithAi, rewriteWithAi } = useAiMail({ live, aiConfigured, setToast, openAi: () => setAiOpen(true) });

  /** Providers of the accounts in view (same array while they don't change: the list is memoised). */
  const searchProvidersKey = [...new Set(accounts.filter((a) => inScope(state.accountId, a.id)).map((a) => a.provider))].join(",");
  const searchWhere = serviceNames(accounts.filter((a) => inScope(state.accountId, a.id)));
  const searchProviders = useMemo(() => (searchProvidersKey ? (searchProvidersKey.split(",") as Account["provider"][]) : []), [searchProvidersKey]);

  const saveSearch = () => {
    const q = state.query.trim();
    if (!q || preferences.savedSearches.some((s) => s.query === q)) return;
    const savedSearches = [...preferences.savedSearches, { id: crypto.randomUUID(), name: q.slice(0, 60), query: q }];
    updatePreferences({ savedSearches })
      .then(() => setToast({ message: "Search saved to the sidebar" }))
      .catch(() => {});
  };

  const removeSearch = (id: string) => {
    updatePreferences({ savedSearches: preferences.savedSearches.filter((s) => s.id !== id) }).catch(() => {});
  };

  /** Runs a saved search across every mailbox. */
  const runSearch = (q: string) => {
    // Like a view change: drop the old list so nothing from it is opened while the search loads.
    if (live && q !== state.query) dispatch({ type: "replace", threads: [] });
    if (state.view.kind !== "mailbox") dispatch({ type: "view", view: { kind: "mailbox", mailbox: "inbox" } });
    dispatch({ type: "query", query: q });
  };

  const renameThread = useCallback(
    (subject: string | null) => {
      if (!selected) return;
      overrideWithUndo(selected.id, { subject }, { subject: selected.originalSubject ? selected.subject : null }, subject ? "Renamed (only in Kite)" : "Original subject back");
    },
    [selected, overrideWithUndo],
  );
  const saveNote = useCallback(
    (markup: string) => {
      if (selected) void setOverride(selected.id, { note: markup.trim() ? markup : null }, "The note couldn't be saved. Try again.");
    },
    [selected, setOverride],
  );
  /** Opens the note or the subject editor in the reader. */
  const [editRequest, setEditRequest] = useState<{ threadId: string; kind: "note" | "rename"; n: number } | null>(null);
  const requestEdit = useCallback(
    (kind: "note" | "rename") => {
      if (selected && !selected.scheduled) setEditRequest((current) => ({ threadId: selected.id, kind, n: (current?.n ?? 0) + 1 }));
    },
    [selected],
  );
  const inboxTab = state.view.kind === "mailbox" && state.view.mailbox === "inbox" && !state.query.trim();
  const tabLabel = tabs.find((s) => s.id === state.side)?.label ?? "this tab";
  /** Marks every unread conversation in the current inbox tab read: one request, one Undo. */
  const markAllRead = useCallback(() => {
    if (!inboxTab) return;
    const unread = threads.filter((t) => t.unread && !t.scheduled);
    if (!unread.length) return;
    unread.forEach((t) => dispatch({ type: "patch", id: t.id, patch: { unread: false } }));
    remoteMany(unread, "read");
    setToast({
      message: `Marked ${unread.length} ${unread.length === 1 ? "conversation" : "conversations"} read in ${tabLabel}`,
      undo: unread,
      undoOp: "unread",
    });
  }, [inboxTab, threads, remoteMany, tabLabel]);

  // Keyboard shortcuts: the handlers for each action, built when a key is pressed.
  const keyHandlers = (): KeyHandlers => {
    const index = threads.findIndex((t) => t.id === state.selectedId);
    const move = (delta: number) => {
      const next = threads[Math.min(threads.length - 1, Math.max(0, index + delta))];
      if (next) selectThread(next.id);
    };
    const isInbox = state.view.kind === "mailbox" && state.view.mailbox === "inbox";
    const tab = (n: number) => {
      if (isInbox && tabs[n]) dispatch({ type: "side", side: tabs[n].id });
    };

    // While threads are ticked, j/k move a cursor without opening, and actions apply to the selection.
    const focus = (delta: number) => {
      const next = threads[Math.min(threads.length - 1, Math.max(0, index + delta))];
      if (next) dispatch({ type: "focus", id: next.id });
    };
    const extend = (delta: number) => {
      const next = threads[Math.min(threads.length - 1, Math.max(0, index + delta))];
      if (!next || !state.selectedId) return;
      const from = state.selectedId;
      setChecked((current) => {
        const same = current.key === listKey;
        const ids = same ? current.ids : [];
        return { key: listKey, ids: [...new Set([...ids, from, next.id])], anchor: (same ? current.anchor : null) ?? from };
      });
      dispatch({ type: "focus", id: next.id });
    };
    const either = (bulkAction: BulkAction, single: () => void) => () => (selecting ? bulk(bulkAction) : single());

    // Cleanup's sender table: the same keys move the picked sender, tick it and clear the ticks.
    const senders = cleanup && live ? cleanupState.keys : null;
    const cleanupKeys: KeyHandlers = senders
      ? {
          next: () => senders.move(1),
          prev: () => senders.move(-1),
          select: senders.toggle,
          selectNext: () => senders.extend(1),
          selectPrev: () => senders.extend(-1),
          selectAll: senders.all,
          clearSelection: cleanupState.checked.length ? senders.clear : undefined,
          open: onePane && !paneDetail && (cleanupState.selected || cleanupState.checked.length) ? () => setPaneDetail(true) : undefined,
        }
      : {};

    return {
      // One pane at a time, on the list: j/k move the cursor, Enter opens.
      next: () => (selecting || (onePane && !paneDetail) ? focus(1) : move(1)),
      prev: () => (selecting || (onePane && !paneDetail) ? focus(-1) : move(-1)),
      open: onePane && !paneDetail && listVisible && state.selectedId ? () => openThread(state.selectedId) : undefined,
      back: state.view.kind === "home" && state.selectedId ? () => selectThread(null) : onePane && paneDetail ? () => setPaneDetail(false) : undefined,
      menu: sidebarMode !== "full" ? () => (drawerOpen ? closeDrawer() : openDrawer()) : undefined,
      archive: either("archive", () => actions.archive()),
      delete: either("delete", () => actions.remove()),
      spam: either("spam", () => actions.spam()),
      star: either("star", () => actions.star()),
      toggleRead: either("read", () => actions.toggleRead()),
      snooze: either("snooze", () => actions.snooze()),
      chatView: selected ? toggleChat : undefined,
      merge: selecting ? () => bulk("merge") : selected && !selected.scheduled ? () => setMergeOpen(true) : undefined,
      pin: selected && !selecting ? () => togglePin() : undefined,
      mute: selected && !selecting ? () => toggleMute() : undefined,
      note: selected && !selecting ? () => requestEdit("note") : undefined,
      summarise: selected && !selecting && !selected.scheduled ? () => summarise(selected) : undefined,
      people: selected ? () => setPeopleOpen((open) => !open) : undefined,
      vip: selected && !selecting ? toggleVip : undefined,
      label: selecting ? () => bulk("label") : selected && !selected.scheduled ? () => openLabels([selected]) : undefined,
      screenshot: selecting || calendarOpen || !selected ? undefined : () => void screenshot.take(),
      translate: selecting || calendarOpen || !selected ? undefined : () => translateHandler.current?.(),
      addToCalendar: selecting ? undefined : () => openAddEvent(calendarOpen ? null : selected && !selected.scheduled ? selected : null),
      select: listVisible && state.selectedId ? () => check(state.selectedId!, "toggle") : undefined,
      selectNext: listVisible ? () => extend(1) : undefined,
      selectPrev: listVisible ? () => extend(-1) : undefined,
      selectAll: listVisible && threads.length ? () => setChecked({ key: listKey, ids: threads.map((t) => t.id), anchor: null }) : undefined,
      clearSelection: selecting ? clearSelection : undefined,
      reply: () => {
        if (!onePane || paneDetail) return replyRef.current?.focus();
        // The reader is off screen: bring it in, then focus its reply box once it shows.
        setPaneDetail(true);
        requestAnimationFrame(() => replyRef.current?.focus());
      },
      replyAll: () => void startCompose("replyAll"),
      forward: () => void startCompose("forward"),
      compose: () => openCompose(),
      search: () => (state.view.kind === "files" || state.view.kind === "notes" || state.view.kind === "contacts" ? filesSearchRef : searchRef).current?.focus(),
      refresh: () => void refresh(),
      undo: () => {
        if (toast?.undo || toast?.onUndo) undo();
      },
      shortcuts: () => setShortcutsOpen(true),
      theme: toggleTheme,
      settings: () => setView({ kind: "settings" }),
      screenPrivacy: () => setScreenPrivate((on) => !on),
      lock: () => lock.lockNow(),
      files: () => setView({ kind: "files" }),
      notes: () => setView({ kind: "notes" }),
      home: () => setView({ kind: "home" }),
      contacts: () => setView({ kind: "contacts" }),
      automations: () => setView({ kind: "automations" }),
      calendar: () => setView({ kind: "calendar" }),
      calendarPrev: calendarOpen ? () => calendarRef.current?.move(-1) : undefined,
      calendarNext: calendarOpen ? () => calendarRef.current?.move(1) : undefined,
      calendarToday: calendarOpen ? () => calendarRef.current?.today() : undefined,
      accountAll: accounts.length > 1 ? () => switchAccount("all") : undefined,
      ...Object.fromEntries(accounts.slice(0, 9).map((a, i) => [`account${i + 1}`, () => switchAccount(a.id)])),
      tab1: () => tab(0),
      tab2: () => tab(1),
      tab3: () => tab(2),
      tab4: () => tab(3),
      ...cleanupKeys,
    };
  };
  useAppKeys({
    locked: lock.locked,
    blocked: !!(paletteOpen || shortcutsOpen || onboarding || mergeOpen || labelPick || fillSign || drawerOpen || screenshot.shot),
    onPalette: () => setPaletteOpen((open) => !open),
    onMinimizeCompose: toggleComposer,
    handlers: keyHandlers,
  });


  /** After an account is disconnected: drop its mail, or fall back to the demo when none are left. */
  const onDisconnected = (accountId: string) => {
    const remaining = accounts.filter((a) => a.id !== accountId);
    const gone = accounts.find((a) => a.id === accountId);
    if (!remaining.length) {
      window.location.reload();
      return;
    }
    setAccounts(remaining);
    dispatch({ type: "replace", threads: state.threads.filter((t) => t.accountId !== accountId) });
    if (inScope(state.accountId, accountId)) dispatch({ type: "account", accountId: pruneScope(state.accountId, remaining) });
    reload();
    setToast({ message: `${gone?.email ?? "Account"} disconnected` });
  };

  // One set of props for the sidebar in the frame and in the drawer.
  // The mail list's title: mailboxes, saved searches and labels (they left the sidebar).
  const mailboxSwitcher = { counts: counts.mailbox, screener: screenerOn || !!counts.mailbox.screener, labels: sidebarLabels, onView: setView, onSearch: runSearch };
  const sidebarProps = {
    accounts,
    unread: accountUnread,
    accountId: state.accountId,
    view: state.view,
    counts,
    // What needs you: replies you owe (not set aside) plus what's due today.
    homeCount: (todayData ? todayData.replies.toReply.filter((r) => !state.overrides[r.threadId]?.replyOff && state.overrides[r.threadId]?.replyDone !== r.messageId).length : 0) + todayCount,
    labels: sidebarLabels,
    theme,
    onAccount: switchAccount,
    onView: setView,
    onCompose: () => openCompose(),
    onToggleTheme: toggleTheme,
    onOpenPalette: () => setPaletteOpen(true),
    onOpenShortcuts: () => setShortcutsOpen(true),
    onAddAccount: () => setOnboarding({ step: "welcome" }),
    demo: mode === "demo",
    syncLabel,
    syncing: syncingIds,
    reconnecting,
    aiLabel,
    aiPreset,
    onOpenAi: () => setAiOpen(true),
    onOpenAiUsage: openAiUsage,
    aiUsage,
    screener: screenerOn,
    savedSearches: preferences.savedSearches,
    activeQuery: state.view.kind === "mailbox" ? query.trim() : "",
    onSearch: runSearch,
    onRemoveSearch: removeSearch,
  };

  // The reader: beside the list in mailbox views, and as a sheet over Home.
  const reader = (
    <Reader
      searchQuery={state.query}
      ref={replyRef}
      thread={selected}
      chat={chatFor(selected)}
      onToggleChat={toggleChat}
      unseen={selected && state.unseen?.threadId === selected.id ? state.unseen.ids : undefined}
      account={accounts.find((a) => a.id === selected?.accountId)}
      signature={selected ? preferences.signatures[selected.accountId] : undefined}
      onArchive={() => actions.archive()}
      onDelete={() => actions.remove()}
      onSpam={() => actions.spam()}
      onStar={() => actions.star()}
      onToggleRead={() => actions.toggleRead()}
      onSnooze={() => actions.snooze()}
      onSend={sending.sendReply}
      onCompose={(mode, body) => {
        if (mode === "reply" && body?.trim() && selected) dropPrepared(selected);
        void startCompose(mode, body);
      }}
      prepared={selected ? (prepared[selected.id] ?? null) : null}
      summary={selected ? summaries[selected.id] : undefined}
      onSummarise={() => selected && summarise(selected)}
      onCloseSummary={() => selected && forgetSummary(selected.id)}
      onDraftAi={(notes) => (selected ? draftWithAi({ accountId: selected.accountId, key: threadKey(selected) }, notes) : Promise.resolve(null))}
      onDiscardPrepared={() => selected && dropPrepared(selected)}
      onScheduled={sending.onScheduled}
      onDraft={(action) => void sending.onDraft(action)}
      snippets={preferences.snippets}
      onManageSnippets={() => setView({ kind: "settings", section: "compose" })}
      onSender={(action) => selected && senderAction(selected.id, action)}
      onSplit={splitThread}
      onPin={() => togglePin()}
      onMute={() => toggleMute()}
      onNote={saveNote}
      onRename={renameThread}
      edit={editRequest && selected && editRequest.threadId === selected.id ? editRequest : undefined}
      onRequestEdit={requestEdit}
      onTogglePeople={() => setPeopleOpen((open) => !open)}
      onPerson={showPerson}
      people={
        peopleOpen && selected
          ? (onPreview) => (
              <PeoplePanel
                thread={selected}
                me={myEmails}
                live={live}
                demoThreads={live ? [] : state.threads}
                email={personPick?.threadId === selected.id ? personPick.email : null}
                onPick={showPerson}
                onOpenThread={(id, email) => {
                  if (state.threads.some((t) => t.id === id)) selectThread(id);
                  else {
                    runSearch(email);
                    pendingSelect.current = { id, query: email.trim() };
                  }
                }}
                onSearch={runSearch}
                onPreview={onPreview}
                onClose={() => setPeopleOpen(false)}
                people={people}
                onUpdate={updatePerson}
              />
            )
          : null
      }
      onMerge={() => setMergeOpen(true)}
      onAddToCalendar={() => selected && openAddEvent(selected)}
      onScreenshot={(messageId) => void screenshot.take(messageId)}
      onUndoRegroup={(regroup) => undoRegroups([regroup.id], regroup.sourceId)}
      labels={selected ? (selected.labels ?? []).flatMap((id) => labelOf(selected.accountId, id) ?? []) : []}
      onLabels={() => selected && openLabels([selected])}
      onOpenLabel={(id) => selected && openLabel(selected.accountId, id)}
    />
  );

  return (
    <FillSignContext value={openFillSign}>
      <PrivacyContext value={privacyPolicy}>
      <TranslateContext value={translateSettings}>
      <AiUsageContext value={openAiUsage}>
      <FirstSyncContext value={firstSyncs}>
      <div className="on-sky bg-sky relative isolate flex h-screen w-screen overflow-hidden">
        <div aria-hidden className="sky-layer" />
        {sidebarMode === "drawer" ? null : <Sidebar {...sidebarProps} mode={sidebarMode} onExpand={openDrawer} />}
        <SidebarDrawer {...sidebarProps} open={drawerOpen} onClose={closeDrawer} />

        <div className="flex min-w-0 flex-1 flex-col">
        {sidebarMode === "drawer" ? (
          <SidebarTopBar accounts={accounts} accountId={state.accountId} onMenu={openDrawer} onOpenPalette={() => setPaletteOpen(true)} onCompose={() => openCompose()} />
        ) : null}
        <main ref={mainRef} className={cn("min-h-0 min-w-0 flex-1", sidebarMode === "drawer" ? "px-2 pb-2" : "py-2 pr-2")}>
          {state.view.kind === "settings" ? (
            <SettingsView
              section={state.view.section}
              accounts={accounts}
              demo={mode !== "live"}
              reconnect={Object.entries(sync).filter(([, s]) => s.reconnect).map(([id]) => id)}
              preferences={preferences}
              onPreferences={updatePreferences}
              themePref={themePref}
              onThemePref={setThemePref}
              onOpenShortcuts={() => setShortcutsOpen(true)}
              onOpenAi={() => setAiOpen(true)}
              aiUsage={aiUsage}
              onAddAccount={() => setOnboarding({ step: "welcome" })}
              onSignInAgain={(email) => setOnboarding({ step: "password", email })}
              onDisconnected={onDisconnected}
              onAccount={(id, patch) => setAccounts((list) => list.map((a) => (a.id === id ? { ...a, ...patch } : a)))}
              onToast={(message) => setToast({ message })}
              onOpenAutomations={() => setView({ kind: "automations" })}
              onLabelsChanged={reload}
              people={people}
              onPerson={updatePerson}
              lockOn={lock.lockOn}
              onLockChanged={lock.setLockOn}
            />
          ) : state.view.kind === "home" ? (
            <HomeView
              live={live}
              accounts={accounts}
              accountId={state.accountId}
              demoThreads={live ? NO_THREADS : state.threads}
              overrides={state.overrides}
              threads={state.threads}
              demoPeople={live ? null : (todayData?.replies ?? null)}
              events={todayData?.events ?? NO_EVENTS}
              day={todayData}
              now={todayNow}
              refreshKey={String(reloadKey)}
              selectedId={state.selectedId}
              sheet={selected ? reader : null}
              onOpen={(line) => {
                // In the inbox Home sits on: open it in place. Elsewhere (an archived conversation you're waiting on): find it.
                if (state.threads.some((t) => t.id === line.threadId)) selectThread(line.threadId);
                else list.openFromToday(line);
              }}
              onCloseSheet={() => selectThread(null)}
              onReply={(item, action) => {
                if (action === "nudge") return void startCompose("replyAll", nudgeLine(item.person), { threadId: item.threadId });
                const patch = action === "done" ? { replyDone: item.messageId } : { replyOff: true };
                void setOverride(item.threadId, patch);
                setToast({
                  // Dismissing someone you've never written to teaches To reply to leave them out (lib/replies.ts).
                  message:
                    action === "done"
                      ? "Marked done"
                      : item.known
                        ? "Kite won't track replies in this conversation"
                        : `Kite won't ask you to reply to ${item.person.name || item.person.email} again`,
                  onUndo: () => void setOverride(item.threadId, action === "done" ? { replyDone: null } : { replyOff: false }),
                });
              }}
              onExpect={(item, action) => void expectAction(item, action)}
              onCompose={() => openCompose()}
              onSearch={() => setPaletteOpen(true)}
            />
          ) : state.view.kind === "calendar" ? (
            <CalendarView
              ref={calendarRef}
              live={live}
              accounts={accounts}
              demoThreads={live ? NO_THREADS : state.threads}
              refreshKey={calendarKey}
              onOpen={list.openFromToday}
              onAdd={(when) => setAddEvent({ subject: "", when })}
            />
          ) : state.view.kind === "automations" ? (
            <AutomationsView
              live={live}
              accounts={accounts}
              demoThreads={live ? NO_THREADS : state.threads}
              single={onePane}
              width={mainWidth}
              refreshKey={`${reloadKey}`}
              onToast={(message) => setToast({ message })}
              onChanged={reload}
              onOpenConversation={list.openFromToday}
              onOpenUsage={openAiUsage}
              onCompose={(draft) => openCompose(draft, undefined, { force: true })}
            />
          ) : state.view.kind === "contacts" ? (
            <ContactsView
              ref={filesSearchRef}
              live={live}
              accounts={accounts}
              demoThreads={live ? NO_THREADS : state.threads}
              refreshKey={`${reloadKey}`}
              people={people}
              single={onePane}
              width={mainWidth}
              onUpdate={(patch) => void updatePerson(patch)}
              onWrite={(contact) => openCompose({ to: [contact.name ? { name: contact.name, email: contact.email } : { email: contact.email }] })}
              onSearch={runSearch}
              onOpenConversation={list.openFromToday}
            />
          ) : state.view.kind === "notes" ? (
            <NotesView
              ref={filesSearchRef}
              live={live}
              accounts={accounts}
              accountId={state.accountId}
              refreshKey={reloadKey}
              overrides={state.overrides}
              people={people}
              demoThreads={live ? NO_THREADS : state.threads}
              onOpenConversation={(note) =>
                note.thread
                  ? list.openFromToday({ threadId: note.id, accountId: note.accountId, subject: note.thread.subject })
                  : setToast({ message: "That conversation isn't on this computer right now." })
              }
              onPersonMail={(email) => {
                dispatch({ type: "view", view: { kind: "mailbox", mailbox: "archive" } });
                dispatch({ type: "query", query: `from:${email}` });
              }}
              onSaveConversation={(id, note) => void setOverride(id, { note }, "The note couldn't be saved. Try again.")}
              onSavePerson={(email, note) => void updatePerson({ email, note })}
            />
          ) : state.view.kind === "files" ? (
            <FilesView
              ref={filesSearchRef}
              live={live}
              accounts={accounts}
              accountId={state.accountId}
              demoThreads={live ? [] : state.threads}
              refreshKey={reloadKey}
              onOpenEmail={(file) => {
                dispatch({ type: "view", view: { kind: "mailbox", mailbox: "inbox" } });
                dispatch({ type: "query", query: file.subject ?? "" });
                if (file.threadId) dispatch({ type: "select", id: file.threadId });
              }}
            />
          ) : (
          <MailPanes
            single={onePane}
            width={mainWidth}
            // While conversations are ticked, the list (with its bulk bar) keeps the screen.
            showDetail={paneDetail && (cleanup || !selecting)}
            onBack={() => setPaneDetail(false)}
            list={
              <>
              {cleanup ? (
                live ? (
                  <CleanupList cleanup={cleanupState} onOpen={onePane ? () => setPaneDetail(true) : undefined} />
                ) : (
                  <section className="grid h-full place-items-center bg-pane p-8 text-center text-[13px] text-pane-muted">
                    Connect an account to see who fills your inbox and clear them out in one go.
                  </section>
                )
              ) : (
                <MessageList
                  ref={searchRef}
                  vips={vips}
                  view={state.view}
                  threads={threads}
                  accounts={accounts}
                  accountId={state.accountId}
                  tabs={tabs}
                  side={state.side}
                  sideCounts={sideCounts}
                  query={state.query}
                  selectedId={state.selectedId}
                  onQuery={(q) => dispatch({ type: "query", query: q })}
                  onSide={(side) => dispatch({ type: "side", side })}
                  onSelect={openThread}
                  onArchive={(id) => actions.archive(id)}
                  onStar={(id) => actions.star(id)}
                  onSnooze={(id) => actions.snooze(id)}
                  onAllow={actions.allow}
                  onBlock={actions.block}
                  onPin={(id) => togglePin(id)}
                  onMute={(id) => toggleMute(id)}
                  onToggleRead={(id) => actions.toggleRead(id)}
                  onTrash={(id) => actions.remove(id)}
                  swipe={preferences.swipe}
                  onMarkAllRead={markAllRead}
                  onCompose={() => openCompose()}
                  onRefresh={refresh}
                  checking={checking}
                  switcher={sidebarMode === "full" ? undefined : mailboxSwitcher}
                  checked={checkedSet}
                  onCheck={check}
                  onSelectAll={() => setChecked({ key: listKey, ids: threads.map((t) => t.id), anchor: null })}
                  onClearSelection={clearSelection}
                  onBulk={bulk}
                  savedSearches={preferences.savedSearches}
                  onSaveSearch={saveSearch}
                  onRemoveSearch={removeSearch}
                  onSearchRemote={live ? () => void list.searchRemote() : undefined}
                  remoteSearch={list.remoteSearch}
                  onLoadMore={list.hasMore ? () => void list.loadMore() : undefined}
                  paging={list.paging}
                  searchProviders={searchProviders}
                  searchWhere={searchWhere}
                  loading={loading || mode === "loading"}
                  firstSync={firstSync}
                  listKey={listKey}
                  labelOf={labelOf}
                  onOpenLabel={openLabel}
                  searchContacts={sending.searchContacts}
                />
              )}
              </>
            }
            detail={
              <>
              {cleanup ? (
                <WithPaneBack label="Senders">
                  <CleanupPane cleanup={cleanupState} live={live} accounts={accounts} onOpenRules={() => setView({ kind: "automations" })} />
                </WithPaneBack>
              ) : selecting ? (
                <BulkPanel threads={checkedThreads} accounts={accounts} onAction={bulk} onClear={clearSelection} />
              ) : (
                reader
              )}
              </>
            }
          />
          )}
        </main>
        </div>

        <CommandPalette
          open={paletteOpen}
          accounts={accounts}
          hasSelection={!!selected}
          onOpenChange={setPaletteOpen}
          onView={setView}
          onAccount={switchAccount}
          onCompose={() => openCompose()}
          onToggleTheme={toggleTheme}
          onArchive={() => actions.archive()}
          onStar={() => actions.star()}
          onSnooze={() => actions.snooze()}
          onOpenShortcuts={() => setShortcutsOpen(true)}
          screener={screenerOn || !!counts.mailbox.screener}
          conversation={
            selected && !selected.scheduled
              ? {
                  pinned: !!selected.pinned,
                  muted: !!selected.muted,
                  hasNote: !!selected.note,
                  onPin: () => togglePin(),
                  onMute: () => toggleMute(),
                  onNote: () => requestEdit("note"),
                  onRename: () => requestEdit("rename"),
                  onMerge: () => setMergeOpen(true),
                  onAddToCalendar: () => openAddEvent(selected),
                  onScreenshot: () => void screenshot.take(),
                  onTranslate: () => translateHandler.current?.(),
                  labelsLabel: `Change ${accountSpec(accounts.find((a) => a.id === selected.accountId)).organise.plural}…`,
                  onLabels: () => openLabels([selected]),
                }
              : null
          }
          labels={sidebarLabels.map((l) => ({
            accountId: l.accountId,
            id: l.id,
            name: l.name,
            account: accounts.length > 1 ? (accounts.find((a) => a.id === l.accountId)?.email ?? null) : null,
          }))}
          markAllRead={inboxTab && sideCounts[state.side] ? { label: tabLabel, onSelect: markAllRead } : null}
        />

        <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

        <LabelPicker
          threads={pickerThreads}
          account={accounts.find((a) => a.id === pickerThreads?.[0]?.accountId)}
          labels={allLabels.filter((l) => l.accountId === pickerThreads?.[0]?.accountId)}
          onClose={labels.closeLabels}
          onChange={(change) => pickerThreads && changeLabels(pickerThreads, change)}
          onCreate={live && pickerThreads?.[0] ? (input) => labels.createLabel(pickerThreads[0].accountId, input) : undefined}
        />

        {screenshot.shot ? <ScreenshotEditor shot={screenshot.shot} onClose={screenshot.close} onToast={(message) => setToast({ message })} /> : null}

        {addEvent ? (
          <AddEventDialog
            seed={addEvent}
            accounts={accounts}
            demo={!live}
            onClose={() => setAddEvent(null)}
            onAdded={(event, account) => {
              setAddEvent(null);
              if (!event) return setToast({ message: "Sample mail: connect your account to add events to your calendar" });
              setCalendarKey((k) => k + 1);
              setToast({ message: account.mailCalendar ? "Added to Kite's calendar" : `Added to ${providerSpec(account.provider).calendar ?? "your calendar"}` });
            }}
          />
        ) : null}

        <MergePicker
          thread={mergeOpen ? selected : null}
          threads={mergeCandidates}
          live={live}
          onClose={() => setMergeOpen(false)}
          onMerge={(other) => {
            setMergeOpen(false);
            if (selected) mergeThreads([selected, other]);
          }}
        />

        <AiSettings open={aiOpen} onClose={() => setAiOpen(false)} onChanged={() => setAiKey((k) => k + 1)} />

        <CodePopup alert={codeAlert} onDismiss={() => setCodeAlert(null)} />

        {onboarding ? (
          <Onboarding
            key={JSON.stringify(onboarding)}
            start={onboarding}
            connected={mode === "live"}
            onDismiss={() => {
              try {
                localStorage.setItem(ONBOARDED_KEY, "1");
              } catch {}
              setOnboarding(null);
            }}
            onSync={async () => {
              const res = await fetch("/api/accounts");
              const data = (await res.json()) as { accounts: Account[] };
              if (!data.accounts.length) throw new Error("No account connected");
              setAccounts(data.accounts);
              const list = await fetch("/api/mail/threads?mailbox=inbox&account=all");
              const payload = (await list.json()) as ListResponse;
              if (!list.ok || !payload.threads) throw new Error("Couldn't load mail");
              dispatch({ type: "account", accountId: "all" });
              dispatch({ type: "view", view: { kind: "mailbox", mailbox: "inbox" } });
              dispatch({ type: "replace", threads: payload.threads });
              dispatch({ type: "remote", remote: true });
              setMode("live");
              const stored = Object.values(payload.sync ?? {}).reduce((n, s) => n + (s.progress?.total ?? s.stored), 0);
              return stored || payload.threads.length;
            }}
            onFinish={() => {
              try {
                localStorage.setItem(ONBOARDED_KEY, "1");
              } catch {}
              setOnboarding(null);
            }}
          />
        ) : null}

        {fillSign ? (
          <PdfEditor
            file={fillSign.file}
            apply={fillSign.layout}
            signatureId={preferences.pdfSign.signature}
            onSignature={(signature) => void updatePreferences({ pdfSign: { signature } }).catch(() => {})}
            onClose={() => setFillSign(null)}
            onOpenSettings={() => {
              setFillSign(null);
              setView({ kind: "settings", section: "fillSign" });
            }}
            onReply={(ref, file) => {
              setFillSign(null);
              if (file.threadId) void startCompose("reply", "", { threadId: file.threadId, attachments: [ref] });
            }}
          />
        ) : null}

        {/* Fill & sign isn't offered from compose's file picker. */}
        <FillSignContext value={null}>
          {composers.map((c) => (
            <Compose
              key={c.id}
              win={{
                id: c.id,
                slot: c.slot,
                // Rank in the stack, so windows stay under dialogs and toasts.
                z: 30 + composers.filter((o) => o.z < c.z).length,
                minimized: c.minimized,
                dock: composeDock,
                onFront: () => frontComposer(c.id),
                onMinimize: () => minimizeComposer(c.id),
                onRestore: () => frontComposer(c.id, true),
              }}
              accounts={accounts}
              defaultAccountId={(scopeIds(state.accountId) ?? [])[0] ?? accounts[0].id}
              signatures={preferences.signatures}
              snippets={preferences.snippets}
              searchContacts={sending.searchContacts}
              initial={c.initial}
              context={c.context}
              live={live}
              demoThreads={live ? [] : state.threads}
              onClose={(pending) => sending.closeCompose(c.id, pending)}
              onSend={(draft, options, draftId) => sending.sendDraft(c.id, draft, options, draftId, c.context?.threadId)}
              onSaveDraft={live ? sending.saveDraft : undefined}
              onDiscardDraft={live ? sending.discardDraft : undefined}
              onDraftAi={draftWithAi}
              onRewrite={rewriteWithAi}
              onManageSnippets={() => {
                setView({ kind: "settings", section: "compose" });
              }}
            />
          ))}
        </FillSignContext>

        <AppToast toast={toast} onUndo={undo} />
        <ScreenPrivacyBadge on={screenPrivate} onOff={() => setScreenPrivate(false)} />
      </div>
      {lock.locked ? <LockScreen onUnlock={lock.unlock} /> : !lock.lockChecked ? <div aria-hidden className="bg-sky fixed inset-0 z-[200]" /> : null}
      </FirstSyncContext>
      </AiUsageContext>
      </TranslateContext>
      </PrivacyContext>
    </FillSignContext>
  );
}
