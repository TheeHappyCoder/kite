"use client";

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import {
  Alert02Icon,
  BookmarkAdd01Icon,
  Calendar03Icon,
  Cancel01Icon,
  Download04Icon,
  Drag04Icon,
  MailReply01Icon,
  PencilEdit02Icon,
  RepeatIcon,
  SignatureIcon,
  SquareLock02Icon,
  TextFontIcon,
  Tick02Icon,
  UserIcon,
} from "@hugeicons/core-free-icons";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";
import type { AttachmentRef } from "@/lib/mail/compose";
import { uploadFile } from "@/lib/mail/upload";
import { blurFade } from "@/lib/motion";
import {
  applyFill,
  formatAcrobatDate,
  imagePdf,
  LockedPdfError,
  readForm,
  TEXT_SIZE,
  TICK_PATH,
  unsupportedCharacters,
  type FieldValue,
  type FormField,
  type FormInfo,
  type Placed,
  type PlacedKind,
} from "@/lib/pdf/fill";
import { blankBox, planAutofill, type Filled } from "@/lib/pdf/autofill";
import { findBlanks, type Blank } from "@/lib/pdf/labels";
import { applyLayout, asToday, formName, MIN_PRINT_LINES, type Layout, type LayoutSpec, type PageSizes } from "@/lib/pdf/layout";
import { loadPdfjs } from "@/lib/pdf/pdfjs";
import { pageText, readPrint } from "@/lib/pdf/print";
import { isEmptyProfile, type Profile } from "@/lib/pdf/profile";
import { cn } from "@/lib/utils";
import { Icon, type IconData } from "../icon";
import { DateTimePicker } from "../ui/date-time-picker";
import { Select } from "../ui/select";
import { Tooltip } from "../ui/tooltip";
import { fileUrl, type FileRef } from "./file-preview";
import { SignaturePad } from "./signature-pad";

import { SwitchTrack } from "../ui/switch";
import { Spinner } from "../ui/spinner";
import { formatBytes } from "@/lib/format";
// Fill & sign: fill a PDF's real form fields (Tab walks them in the form's order) or place text,
// a tick, a date and a signature anywhere, then save a new file. The original is never changed,
// and nothing is sent: "Reply with signed copy" only opens a reply with the file attached.
// Loaded with next/dynamic, so pdf.js and pdf-lib download only when the editor opens.

/** Ink for values on the page. The page is paper, so it doesn't follow the pane theme. */
const INK = "#14161f";
const MAX_SCALE = 1.6;

type Lock = "encrypted" | "unreadable";

type Loaded = {
  bytes: Uint8Array;
  doc: PDFDocumentProxy;
  pages: PDFPageProxy[];
  info: FormInfo | null;
  /** pdf-lib can't rewrite this file, so the copy is made from page images. */
  lock: Lock | null;
  annotationMode: { forms: number; all: number };
};

type Status = { kind: "loading" } | { kind: "password"; wrong: boolean } | { kind: "error"; message: string } | { kind: "ready"; loaded: Loaded };

type Saved = {
  ref: AttachmentRef;
  url: string;
  name: string;
  size: number;
  flattened: boolean;
  image: boolean;
};

const TOOLS: {
  kind: PlacedKind;
  label: string;
  icon: IconData;
  hint: string;
}[] = [
  {
    kind: "text",
    label: "Text",
    icon: TextFontIcon,
    hint: "Click the page to type",
  },
  {
    kind: "tick",
    label: "Tick",
    icon: Tick02Icon,
    hint: "Click the page to place a tick",
  },
  {
    kind: "date",
    label: "Date",
    icon: Calendar03Icon,
    hint: "Click the page to place today's date",
  },
  {
    kind: "signature",
    label: "Signature",
    icon: SignatureIcon,
    hint: "Click the page to place your signature",
  },
];

type Print = { pages: PageSizes; lines: string[] };

/** What "Fill from my profile" did, for the note, Undo and the highlights. */
type ProfileFill = {
  filled: Filled[];
  total: number;
  values: Record<string, FieldValue>;
  itemIds: string[];
  /** Field names left empty when it ran (highlighted while still empty). */
  emptyFields: string[];
  emptyBlanks: Blank[];
};

/** Who sent the form, as the user knows them. */
function senderLabel(file: FileRef) {
  const from = file.from;
  return from ? (from.name && from.name !== from.email ? from.name : from.email) : "";
}

export default function PdfEditor({
  file,
  apply,
  signatureId,
  onSignature,
  onClose,
  onReply,
  onOpenSettings,
}: {
  file: FileRef;
  /** A remembered layout the user chose in the preview ("Sign like last time"): placed on open, for review. */
  apply?: string;
  signatureId: string | null;
  onSignature: (assetId: string | null) => void;
  onClose: () => void;
  /** Opens a reply on the PDF's conversation with the saved copy attached. */
  onReply?: (ref: AttachmentRef, file: FileRef) => void;
  /** Closes the editor and opens Settings → Fill & sign (where the profile lives). */
  onOpenSettings?: () => void;
}) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [password, setPassword] = useState<string | undefined>(undefined);
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [items, setItems] = useState<Placed[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<PlacedKind | null>(null);
  const [signedOk, setSignedOk] = useState(false);
  const [flatten, setFlatten] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Leaving with unsaved changes: what to do after Discard. */
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const [padOpen, setPadOpen] = useState(false);
  const [pendingSign, setPendingSign] = useState<(Omit<Placed, "id" | "kind" | "w" | "h"> & { fit?: FormField["rect"] }) | null>(null);
  const [sigAspect, setSigAspect] = useState(3);
  const [width, setWidth] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const savedUrl = useRef<string | null>(null);
  const [print, setPrint] = useState<Print | null>(null);
  const [match, setMatch] = useState<Layout | null>(null);
  const [placedNote, setPlacedNote] = useState<string | null>(null);
  const [remember, setRemember] = useState<"closed" | "open" | "done">("closed");
  const [profileFill, setProfileFill] = useState<ProfileFill | null>(null);
  const [profileNote, setProfileNote] = useState<"empty" | "error" | null>(null);
  const [filling, setFilling] = useState(false);
  const sender = file.from?.email.trim().toLowerCase() ?? "";

  // Load the bytes (the local attachment, or a sample form in demo mode), then pdf.js and pdf-lib.
  useEffect(() => {
    let cancelled = false;
    let task: { destroy: () => Promise<void> } | null = null;
    (async () => {
      try {
        const url = fileUrl(file);
        let bytes: Uint8Array;
        if (url) {
          const res = await fetch(url);
          if (!res.ok) throw new Error("Kite couldn't open this file. Check your connection and try again.");
          bytes = new Uint8Array(await res.arrayBuffer());
        } else {
          bytes = await (await import("@/lib/pdf/sample")).samplePdf();
        }
        const pdfjs = await loadPdfjs();
        let doc: PDFDocumentProxy;
        try {
          const loading = pdfjs.getDocument({ data: bytes.slice(), password });
          task = loading;
          doc = await loading.promise;
        } catch (e) {
          if (e instanceof pdfjs.PasswordException) {
            if (!cancelled)
              setStatus({
                kind: "password",
                wrong: e.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD,
              });
            return;
          }
          throw new Error("This file doesn't look like a PDF Kite can read. Download it to open it in another app.");
        }
        let info: FormInfo | null = null;
        let lock: Lock | null = null;
        try {
          info = await readForm(bytes);
        } catch (e) {
          lock = e instanceof LockedPdfError ? "encrypted" : "unreadable";
        }
        const pages = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));
        if (cancelled) return;
        setStatus({
          kind: "ready",
          loaded: {
            bytes,
            doc,
            pages,
            info,
            lock,
            annotationMode: {
              forms: pdfjs.AnnotationMode.ENABLE_FORMS,
              all: pdfjs.AnnotationMode.ENABLE,
            },
          },
        });
      } catch (e) {
        if (!cancelled)
          setStatus({
            kind: "error",
            message: e instanceof Error ? e.message : "Kite couldn't open this PDF.",
          });
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [file, password]);

  useEffect(
    () => () => {
      if (savedUrl.current) URL.revokeObjectURL(savedUrl.current);
    },
    [],
  );

  // Pages fit the pane's width (up to a comfortable zoom), so the editor works in narrow windows.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [status.kind]);

  useEffect(() => {
    if (!signatureId) return;
    const img = new Image();
    img.onload = () => setSigAspect(img.naturalWidth / Math.max(1, img.naturalHeight));
    img.src = `/api/assets/${signatureId}`;
  }, [signatureId]);

  const touch = () => {
    setDirty(true);
    setSaved(null);
    setError(null);
  };

  /** Places a remembered layout for review. Nothing is saved: the user still presses Save copy. */
  const placeLayout = async (layout: Layout, from: Loaded) => {
    const result = applyLayout(layout.spec, from.info, from.pages.length, !!signatureId);
    let placed = result.items;
    if (signatureId && placed.some((i) => i.kind === "signature")) {
      // The saved signature may have changed shape since: keep the box's height and centre.
      const aspect = await imageAspect(`/api/assets/${signatureId}`).catch(() => null);
      if (aspect) placed = placed.map((i) => (i.kind === "signature" ? { ...i, x: i.x + (i.w - i.h * aspect) / 2, w: i.h * aspect } : i));
    }
    // The layout wins: profile text it lands on goes, and the profile note closes (press Fill again for what's left).
    const fromProfile = new Set(profileFill?.itemIds ?? []);
    setValues((v) => ({ ...v, ...result.values }));
    setItems((list) => [...list.filter((i) => !(fromProfile.has(i.id) && placed.some((p) => p.page === i.page && boxesOverlap(p, i)))), ...placed]);
    setProfileFill(null);
    setSelected(null);
    setTool(null);
    touch();
    const what = result.summary.length ? `: ${result.summary.join(", ")}` : "";
    setPlacedNote(
      `Placed like your last ${layout.name} from ${senderLabel(file) || layout.sender}${what}.` +
        (result.missingSignature ? " Add your signature to place it too." : "") +
        " Move, change or remove anything, then Save copy.",
    );
    void fetch(`/api/fill-sign/layouts/${layout.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {});
  };

  const onMatched = useEffectEvent((layout: Layout, from: Loaded) => {
    setMatch(layout);
    if (layout.id === apply) void placeLayout(layout, from);
  });

  // Recognise the form: its print, matched against layouts remembered for this sender.
  useEffect(() => {
    if (status.kind !== "ready" || !sender) return;
    const from = status.loaded;
    let cancelled = false;
    (async () => {
      try {
        const p = await readPrint(from.doc, from.info, from.pages);
        if (cancelled) return;
        setPrint(p);
        const res = await fetch("/api/fill-sign/match", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sender, ...p }),
        });
        const { layout } = (await res.json()) as { layout: Layout | null };
        if (!cancelled && layout) onMatched(layout, from);
      } catch {
        // Recognising the form is a convenience; the editor works the same without it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, sender]);

  const loaded = status.kind === "ready" ? status.loaded : null;
  const blocked = !!loaded?.info?.signed && !signedOk;
  const scale = useMemo(() => {
    if (!loaded || !width) return 0;
    const widest = Math.max(...loaded.pages.map((p) => p.getViewport({ scale: 1 }).width));
    return Math.min(MAX_SCALE, (width - 32) / widest);
  }, [loaded, width]);

  const setValue = (name: string, value: FieldValue) => {
    setValues((v) => ({ ...v, [name]: value }));
    touch();
  };

  const updateItem = (id: string, patch: Partial<Placed>) => {
    setItems((list) => list.map((i) => (i.id === id ? { ...i, ...patch } : i)));
    touch();
  };

  const removeItem = useCallback((id: string) => {
    setItems((list) => list.filter((i) => i.id !== id));
    setSelected((s) => (s === id ? null : s));
    setDirty(true);
    setSaved(null);
  }, []);

  const signatureSize = (fit?: FormField["rect"]) => {
    if (fit) {
      const w = Math.min(fit.width, fit.height * sigAspect);
      return {
        w,
        h: w / sigAspect,
        dx: (fit.width - w) / 2,
        dy: (fit.height - w / sigAspect) / 2,
      };
    }
    let w = 150;
    let h = w / sigAspect;
    if (h > 60) {
      h = 60;
      w = h * sigAspect;
    }
    return { w, h, dx: -w / 2, dy: -h / 2 };
  };

  /** Places an item with its anchor at a PDF point (text: left middle; others: centre). */
  const place = (kind: PlacedKind, page: number, x: number, y: number, fit?: FormField["rect"]) => {
    if (kind === "signature" && !signatureId) {
      setPendingSign({ page, x, y, fit });
      setPadOpen(true);
      return;
    }
    const id = crypto.randomUUID();
    let item: Placed;
    if (kind === "signature") {
      const s = signatureSize(fit);
      item = fit ? { id, kind, page, x: fit.x + s.dx, y: fit.y + s.dy, w: s.w, h: s.h } : { id, kind, page, x: x + s.dx, y: y + s.dy, w: s.w, h: s.h };
    } else if (kind === "tick") {
      item = { id, kind, page, x: x - 7, y: y - 7, w: 14, h: 14 };
    } else {
      const text = kind === "date" ? formatAcrobatDate(new Date(), "dd/mm/yyyy") : "";
      item = {
        id,
        kind,
        page,
        x,
        y: y - 7,
        w: textWidth(text, 14),
        h: 14,
        text,
      };
    }
    setItems((list) => [...list, item]);
    setSelected(id);
    setTool(null);
    touch();
  };

  const requestClose = useCallback(() => {
    if (dirty) setLeaving(() => onClose);
    else onClose();
  }, [dirty, onClose]);

  const openSettings = () => {
    if (!onOpenSettings) return;
    if (dirty) setLeaving(() => onOpenSettings);
    else onOpenSettings();
  };

  /** "Fill from my profile": only on request, only confident matches in places still empty. */
  const fillFromProfile = async () => {
    if (!loaded || filling) return;
    setFilling(true);
    setProfileNote(null);
    try {
      const res = await fetch("/api/fill-sign/profile");
      if (!res.ok) throw new Error("profile");
      const { profile } = (await res.json()) as { profile: Profile };
      if (isEmptyProfile(profile)) {
        setProfileNote("empty");
        return;
      }
      const text = await Promise.all(loaded.pages.map(pageText));
      const blanks = findBlanks(text, loaded.info?.fields ?? []);
      const plan = planAutofill({ profile, info: loaded.info, values, items, blanks, measure: textWidth });
      setValues((v) => ({ ...v, ...plan.values }));
      setItems((list) => [...list, ...plan.items]);
      setProfileFill({
        filled: plan.filled,
        total: plan.total,
        values: plan.values,
        itemIds: plan.items.map((i) => i.id),
        emptyFields: plan.emptyFields,
        emptyBlanks: plan.emptyBlanks,
      });
      setSelected(null);
      setTool(null);
      if (plan.filled.length) touch();
    } catch {
      setProfileNote("error");
    } finally {
      setFilling(false);
    }
  };

  /** Takes back what the profile filled, unless the user has since changed it. */
  const undoProfileFill = () => {
    if (!profileFill) return;
    setValues((v) => Object.fromEntries(Object.entries(v).filter(([name, value]) => profileFill.values[name] === undefined || profileFill.values[name] !== value)));
    setItems((list) => list.filter((i) => !profileFill.itemIds.includes(i.id) || i.text !== profileFill.filled.find((f) => f.target === i.id)?.value));
    setProfileFill(null);
    touch();
  };

  /** Starts an answer in a printed blank the profile left empty. */
  const answerBlank = (blank: Blank) => {
    const box = blankBox(blank);
    const id = crypto.randomUUID();
    setItems((list) => [...list, { id, kind: "text", page: blank.page, x: box.x, y: box.y, w: textWidth("", box.h), h: box.h, text: "" }]);
    setSelected(id);
    setTool(null);
    touch();
  };

  // Editor keys: Escape steps back (tool, selection, then close); Delete removes the selected item.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (padOpen || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");
      if (e.key === "Escape") {
        e.preventDefault();
        if (typing) target!.blur();
        else if (leaving) setLeaving(null);
        else if (tool) setTool(null);
        else if (selected) setSelected(null);
        else requestClose();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected && !typing) {
        e.preventDefault();
        removeItem(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [padOpen, leaving, tool, selected, requestClose, removeItem]);

  const save = async () => {
    if (!loaded || saving) return;
    setSaving(true);
    setError(null);
    try {
      const texts = [...Object.values(values).filter((v): v is string => typeof v === "string"), ...items.flatMap((i) => (i.text ? [i.text] : []))];
      const bad = await unsupportedCharacters(texts);
      if (bad.length)
        throw new Error(`Kite can't write ${bad.map((c) => `"${c}"`).join(", ")} into a PDF yet. Replace ${bad.length === 1 ? "it" : "them"} and save again.`);
      const placed = items.filter((i) => i.kind === "tick" || i.kind === "signature" || i.text?.trim());
      let signature: Uint8Array | null = null;
      if (placed.some((i) => i.kind === "signature") && signatureId) {
        const res = await fetch(`/api/assets/${signatureId}`);
        if (!res.ok) throw new Error("Your saved signature is missing. Add it again and save.");
        signature = new Uint8Array(await res.arrayBuffer());
      }
      let out: Uint8Array;
      let flattened = false;
      if (loaded.lock) {
        out = await rasterCopy(loaded, placed, signature);
      } else {
        const result = await applyFill(loaded.bytes, { values, items: placed }, { flatten, signature });
        out = result.bytes;
        flattened = result.flattened;
      }
      const base = file.attachment.name.replace(/\.pdf$/i, "");
      const name = `${base} (${placed.some((i) => i.kind === "signature") ? "signed" : "filled"}).pdf`;
      const blob = new Blob([new Uint8Array(out)], { type: "application/pdf" });
      const ref = await uploadFile(new File([blob], name, { type: "application/pdf" }));
      if (savedUrl.current) URL.revokeObjectURL(savedUrl.current);
      savedUrl.current = URL.createObjectURL(blob);
      setSaved({
        ref,
        url: savedUrl.current,
        name,
        size: blob.size,
        flattened,
        image: !!loaded.lock,
      });
      setDirty(false);
      setRemember("closed");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kite couldn't save the copy. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const hasFields = !!loaded?.info?.fields.some((f) => f.kind !== "signature");
  const activeTool = TOOLS.find((t) => t.kind === tool);

  // While the profile note is up, places still empty stay highlighted and the count follows along.
  const showFill = !!profileFill && !(saved && !dirty);
  const isBlankValue = (v: FieldValue | undefined) => v === undefined || v === "" || v === false;
  const stillEmpty = new Set(
    showFill ? profileFill.emptyFields.filter((name) => isBlankValue(values[name] ?? loaded?.info?.values[name])) : [],
  );
  const openBlanks = showFill
    ? profileFill.emptyBlanks.filter((b) => {
        const box = blankBox(b);
        return !items.some((i) => i.page === b.page && boxesOverlap(i, box));
      })
    : [];
  // "Sign like last time" stays on offer while only the profile has filled anything.
  const onlyProfile =
    Object.entries(values).every(([name, v]) => profileFill?.values[name] !== undefined && profileFill.values[name] === v) &&
    items.every((i) => profileFill?.itemIds.includes(i.id));

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-40 p-3">
      <motion.div className="absolute inset-0 bg-black/45 backdrop-blur-[3px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
      <motion.div
        role="dialog"
        aria-modal
        aria-label={`Fill & sign ${file.attachment.name}`}
        {...blurFade({ y: 8, blur: 8 })}
        className="relative flex size-full flex-col overflow-hidden rounded-2xl border border-pane-border bg-pane text-pane-fg shadow-2xl"
      >
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-2 pt-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold tracking-tight">{file.attachment.name}</h2>
            <p className="truncate text-[12px] text-pane-muted">
              {activeTool
                ? `${activeTool.hint}. Esc cancels.`
                : hasFields
                  ? "Fill the highlighted fields (Tab moves to the next), or place text, a tick, a date or your signature."
                  : "Place text, a tick, a date or your signature anywhere on the page."}
            </p>
          </div>
          {loaded && !loaded.lock && loaded.info?.fields.length ? (
            <Tooltip label="Flattened fields become part of the page, so they can't be changed after you send it">
              <button
                role="switch"
                aria-checked={flatten}
                onClick={() => setFlatten((f) => !f)}
                className="flex h-8 items-center gap-2 rounded-full px-3 text-[12.5px] text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
              >
                <SwitchTrack on={flatten} size="sm" />
                Flatten
              </button>
            </Tooltip>
          ) : null}
          <button
            onClick={() => void save()}
            disabled={!loaded || blocked || saving || (!dirty && !!saved)}
            className="flex h-8 items-center gap-1.5 rounded-full bg-pane-fg px-4 text-[12.5px] font-medium text-pane hover:opacity-90 disabled:opacity-40"
          >
            {saving ? <Spinner /> : null}
            {saving ? "Saving…" : saved && !dirty ? "Saved" : "Save copy"}
          </button>
          <Tooltip label="Close">
            <button
              onClick={requestClose}
              aria-label="Close"
              className="grid size-8 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
            >
              <Icon icon={Cancel01Icon} size={16} />
            </button>
          </Tooltip>
        </header>

        {loaded ? (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-pane-border px-4 pb-2.5">
            {TOOLS.map((t) => (
              <button
                key={t.kind}
                disabled={blocked}
                aria-pressed={tool === t.kind}
                onClick={() => setTool((current) => (current === t.kind ? null : t.kind))}
                className={cn(
                  "flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] transition-colors disabled:opacity-40",
                  tool === t.kind ? "border-accent bg-accent-soft text-pane-fg" : "border-pane-border text-pane-muted hover:bg-pane-hover hover:text-pane-fg",
                )}
              >
                <Icon icon={t.icon} size={14} /> {t.label}
              </button>
            ))}
            {signatureId ? (
              <Tooltip label="Change your saved signature">
                <button
                  onClick={() => setPadOpen(true)}
                  aria-label="Change your saved signature"
                  className="grid size-8 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
                >
                  <Icon icon={PencilEdit02Icon} size={15} />
                </button>
              </Tooltip>
            ) : null}
            {match && !placedNote && !blocked && onlyProfile ? (
              <Tooltip label={`Place things where you did on your last ${match.name} from ${senderLabel(file) || match.sender}, for you to check`}>
                <button
                  onClick={() => void placeLayout(match, loaded)}
                  className="blur-fade flex h-8 items-center gap-1.5 rounded-full border border-accent/50 px-3 text-[12.5px] text-pane-fg hover:bg-accent-soft"
                >
                  <Icon icon={RepeatIcon} size={14} /> Sign like last time
                </button>
              </Tooltip>
            ) : null}
            <button
              onClick={() => void fillFromProfile()}
              disabled={blocked || filling}
              className="flex h-8 items-center gap-1.5 rounded-full border border-pane-border px-3 text-[12.5px] text-pane-muted transition-colors hover:bg-pane-hover hover:text-pane-fg disabled:opacity-40"
            >
              <Icon icon={UserIcon} size={14} /> {filling ? "Filling…" : "Fill from my profile"}
            </button>
            <span className="ml-auto text-[12px] text-pane-muted">
              {loaded.pages.length} {loaded.pages.length === 1 ? "page" : "pages"}
            </span>
          </div>
        ) : null}

        {loaded ? <Notices loaded={loaded} /> : null}
        {error ? <Notice icon={Alert02Icon}>{error}</Notice> : null}
        {placedNote && !(saved && !dirty) ? (
          <div className="blur-fade flex items-start gap-2 border-b border-pane-border bg-accent-soft px-4 py-2 text-[12.5px]">
            <Icon icon={RepeatIcon} size={15} className="mt-px shrink-0 text-accent" />
            <p className="min-w-0 flex-1">{placedNote}</p>
            <Tooltip label="Hide">
              <button
                onClick={() => setPlacedNote(null)}
                aria-label="Hide"
                className="-my-1 grid size-6 shrink-0 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
              >
                <Icon icon={Cancel01Icon} size={12} />
              </button>
            </Tooltip>
          </div>
        ) : null}
        {profileNote ? (
          <div className="blur-fade flex flex-wrap items-center gap-2 border-b border-pane-border bg-pane-2 px-4 py-2 text-[12.5px]">
            <Icon icon={UserIcon} size={15} className="shrink-0 text-pane-muted" />
            <p className="min-w-0 flex-1 text-pane-muted">
              {profileNote === "empty"
                ? "Your profile is empty. Add your details in Settings → Fill & sign, then forms like this fill in one click."
                : "Kite couldn't read your profile. Try again."}
            </p>
            {profileNote === "empty" && onOpenSettings ? (
              <button onClick={openSettings} className="h-7 rounded-full bg-pane-fg px-3 font-medium text-pane hover:opacity-90">
                Open Settings
              </button>
            ) : null}
            <Tooltip label="Hide">
              <button
                onClick={() => setProfileNote(null)}
                aria-label="Hide"
                className="-my-1 grid size-6 shrink-0 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
              >
                <Icon icon={Cancel01Icon} size={12} />
              </button>
            </Tooltip>
          </div>
        ) : null}
        {showFill ? (
          <ProfileFillNote
            fill={profileFill}
            left={stillEmpty.size + openBlanks.length}
            onUndo={undoProfileFill}
            onHide={() => setProfileFill(null)}
          />
        ) : null}
        {leaving ? (
          <div className="blur-fade flex flex-wrap items-center gap-2 border-b border-pane-border bg-pane-2 px-4 py-2 text-[12.5px]">
            <span className="min-w-0 flex-1">Close without saving? Your changes to this PDF will be lost.</span>
            <button onClick={() => setLeaving(null)} className="h-7 rounded-full px-3 text-pane-muted hover:bg-pane-hover hover:text-pane-fg">
              Keep editing
            </button>
            <button onClick={leaving} className="h-7 rounded-full bg-pane-fg px-3 font-medium text-pane hover:opacity-90">
              Discard
            </button>
          </div>
        ) : null}
        {saved && !dirty ? (
          <div className="blur-fade flex flex-wrap items-center gap-2 border-b border-pane-border bg-accent-soft px-4 py-2 text-[12.5px]">
            <span className="min-w-0 flex-1 truncate">
              Saved as <span className="font-medium">{saved.name}</span> · {formatBytes(saved.size)}
              {saved.image ? " · made from page images" : saved.flattened ? " · flattened" : ""}. The original is unchanged.
            </span>
            <a
              href={saved.url}
              download={saved.name}
              className="flex h-7 items-center gap-1.5 rounded-full px-3 text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
            >
              <Icon icon={Download04Icon} size={14} /> Download
            </a>
            {sender && print ? (
              remember === "done" ? (
                <span className="px-2 text-pane-muted">Remembered for {senderLabel(file)}</span>
              ) : (
                <Tooltip label={`Next time ${senderLabel(file)} sends this form, Kite offers to place things the same way`}>
                  <button
                    aria-expanded={remember === "open"}
                    onClick={() => setRemember((r) => (r === "open" ? "closed" : "open"))}
                    className="flex h-7 items-center gap-1.5 rounded-full px-3 text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
                  >
                    <Icon icon={BookmarkAdd01Icon} size={14} /> <span className="max-w-[16rem] truncate">Remember for {senderLabel(file)}</span>
                  </button>
                </Tooltip>
              )
            ) : null}
            {onReply && file.threadId ? (
              <button
                onClick={() => onReply(saved.ref, file)}
                className="flex h-7 items-center gap-1.5 rounded-full bg-pane-fg px-3 font-medium text-pane hover:opacity-90"
              >
                <Icon icon={MailReply01Icon} size={14} /> Reply with signed copy
              </button>
            ) : null}
          </div>
        ) : null}
        {saved && !dirty && remember === "open" && print && loaded ? (
          <RememberPanel
            file={file}
            sender={sender}
            print={print}
            info={loaded.info}
            values={values}
            items={items}
            flatten={flatten}
            onCancel={() => setRemember("closed")}
            onSaved={(layout) => {
              setMatch(layout);
              setRemember("done");
            }}
          />
        ) : null}

        <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto bg-pane-2">
          {status.kind === "loading" ? (
            <p className="blur-fade py-16 text-center text-[12.5px] text-pane-muted">Opening the PDF…</p>
          ) : status.kind === "error" ? (
            <p className="blur-fade mx-auto max-w-sm py-16 text-center text-[12.5px] text-pane-muted">{status.message}</p>
          ) : status.kind === "password" ? (
            <PasswordForm
              wrong={status.wrong}
              onSubmit={(p) => {
                setStatus({ kind: "loading" });
                setPassword(p);
              }}
            />
          ) : scale > 0 ? (
            <div className="flex flex-col items-center gap-4 px-4 py-4">
              {status.loaded.pages.map((page, index) => (
                <PdfPage
                  key={index}
                  page={page}
                  index={index}
                  scale={scale}
                  annotationMode={status.loaded.lock ? status.loaded.annotationMode.all : status.loaded.annotationMode.forms}
                  tool={blocked ? null : tool}
                  onPlace={(x, y) => tool && place(tool, index, x, y)}
                  onBackground={() => setSelected(null)}
                >
                  {(viewport) => (
                    <>
                      {status.loaded.info?.fields
                        .filter((f) => f.page === index)
                        .map((field) => (
                          <FieldControl
                            key={field.id}
                            field={field}
                            viewport={viewport}
                            scale={scale}
                            disabled={blocked || field.readOnly}
                            missing={stillEmpty.has(field.name)}
                            value={values[field.name] ?? status.loaded.info!.values[field.name]}
                            onChange={(v) => setValue(field.name, v)}
                            onSign={() => place("signature", index, 0, 0, field.rect)}
                          />
                        ))}
                      {openBlanks
                        .filter((b) => b.page === index)
                        .map((blank) => (
                          <BlankHint key={blank.id} blank={blank} viewport={viewport} onAnswer={() => answerBlank(blank)} />
                        ))}
                      {items
                        .filter((i) => i.page === index)
                        .map((item) => (
                          <ItemBox
                            key={item.id}
                            item={item}
                            page={page}
                            viewport={viewport}
                            scale={scale}
                            signatureId={signatureId}
                            selected={selected === item.id}
                            onSelect={() => setSelected(item.id)}
                            onChange={(patch) => updateItem(item.id, patch)}
                            onRemove={() => removeItem(item.id)}
                          />
                        ))}
                    </>
                  )}
                </PdfPage>
              ))}
            </div>
          ) : null}

          {blocked ? (
            <div className="absolute inset-x-0 top-6 z-10 mx-auto w-[min(440px,calc(100%-32px))] rounded-2xl border border-pane-border bg-pane p-4 shadow-2xl blur-fade-down">
              <p className="text-[13px] font-medium">This PDF already carries a digital signature</p>
              <p className="mt-1 text-[12.5px] text-pane-muted">
                Any change breaks it, and the recipient&apos;s PDF viewer will show that signature as invalid. Your copy is a new file; the original stays as it
                is.
              </p>
              <div className="mt-3 flex justify-end gap-2">
                <button onClick={onClose} className="h-8 rounded-full px-3 text-[12.5px] text-pane-muted hover:bg-pane-hover hover:text-pane-fg">
                  Close
                </button>
                <button onClick={() => setSignedOk(true)} className="h-8 rounded-full bg-pane-fg px-4 text-[12.5px] font-medium text-pane hover:opacity-90">
                  Edit anyway
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </motion.div>

      <SignaturePad
        open={padOpen}
        hasSignature={!!signatureId}
        onClose={() => {
          setPadOpen(false);
          setPendingSign(null);
        }}
        onRemove={() => {
          onSignature(null);
          setItems((list) => list.filter((i) => i.kind !== "signature"));
          setPadOpen(false);
          setPendingSign(null);
        }}
        onSaved={(id) => {
          onSignature(id);
          setPadOpen(false);
          if (pendingSign) {
            // Wait for the new signature's shape before placing it.
            const img = new Image();
            img.onload = () => {
              const aspect = img.naturalWidth / Math.max(1, img.naturalHeight);
              setSigAspect(aspect);
              const { page, x, y, fit } = pendingSign;
              const itemId = crypto.randomUUID();
              let w = fit ? Math.min(fit.width, fit.height * aspect) : 150;
              let h = w / aspect;
              if (!fit && h > 60) {
                h = 60;
                w = h * aspect;
              }
              const at = fit
                ? {
                    x: fit.x + (fit.width - w) / 2,
                    y: fit.y + (fit.height - h) / 2,
                  }
                : { x: x - w / 2, y: y - h / 2 };
              setItems((list) => [...list, { id: itemId, kind: "signature", page, ...at, w, h }]);
              setSelected(itemId);
              setTool(null);
              touch();
            };
            img.src = `/api/assets/${id}`;
            setPendingSign(null);
          }
        }}
      />
    </div>,
    document.body,
  );
}

function Notices({ loaded }: { loaded: Loaded }) {
  if (loaded.lock === "encrypted") {
    return (
      <Notice icon={SquareLock02Icon}>
        This PDF is locked by its sender, so Kite can&apos;t fill its fields or change the file. You can still place text, ticks, dates and your signature: the
        copy is saved as images of the pages (text in it won&apos;t be selectable). For a normal copy, ask the sender for an unlocked PDF.
      </Notice>
    );
  }
  if (loaded.lock === "unreadable") {
    return (
      <Notice icon={Alert02Icon}>
        Kite can show this PDF but can&apos;t edit its structure, so the copy is saved as images of the pages. Placing text, ticks, dates and your signature
        still works.
      </Notice>
    );
  }
  if (loaded.info?.xfa) {
    return (
      <Notice icon={Alert02Icon}>
        This form uses XFA, which Kite can&apos;t fill field by field. Click to place text on the page instead. Your copy drops the XFA part, so every PDF
        viewer shows the same thing.
      </Notice>
    );
  }
  return null;
}

function Notice({ icon, children }: { icon: IconData; children: React.ReactNode }) {
  return (
    <div className="blur-fade flex items-start gap-2 border-b border-pane-border bg-pane-2 px-4 py-2 text-[12.5px] text-pane-muted">
      <Icon icon={icon} size={15} className="mt-px shrink-0 text-warning" />
      <p className="min-w-0">{children}</p>
    </div>
  );
}

function imageAspect(src: string) {
  return new Promise<number>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth / Math.max(1, img.naturalHeight));
    img.onerror = reject;
    img.src = src;
  });
}

function plural(n: number, one: string, many: string) {
  return n === 1 ? one : `${n} ${many}`;
}

/**
 * "Remember for <sender>": positions of the signature, ticks and dates are always kept; values
 * only per field the user ticks (a job number changes every time, a name doesn't). Dates are kept as "today".
 */
function RememberPanel({
  file,
  sender,
  print,
  info,
  values,
  items,
  flatten,
  onCancel,
  onSaved,
}: {
  file: FileRef;
  sender: string;
  print: Print;
  info: FormInfo | null;
  values: Record<string, FieldValue>;
  items: Placed[];
  flatten: boolean;
  onCancel: () => void;
  onSaved: (layout: Layout) => void;
}) {
  const [name, setName] = useState(() => formName(file.attachment.name));
  const [ticked, setTicked] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognisable = new Set(print.lines).size >= MIN_PRINT_LINES;

  const fields = new Map((info?.fields ?? []).map((f) => [f.name, f]));
  const choices = [
    ...Object.entries(values).flatMap(([field, value]) => {
      const f = fields.get(field);
      if (!f || value === "" || value === false) return [];
      const today = asToday(value, new Date(), f.dateFormat);
      const shown = today ? "today's date" : value === true ? "ticked" : String(value);
      return [{ key: `field:${field}`, label: f.label ?? f.name, shown }];
    }),
    ...items.flatMap((i) =>
      i.kind === "text" && i.text?.trim() ? [{ key: `item:${i.id}`, label: `Text on page ${i.page + 1}`, shown: i.text.trim() }] : [],
    ),
  ];
  const kept = [
    items.some((i) => i.kind === "signature") ? "your signature" : null,
    items.some((i) => i.kind === "date") ? "the date (as today's)" : null,
    items.some((i) => i.kind === "tick") ? plural(items.filter((i) => i.kind === "tick").length, "the tick", "ticks") : null,
  ].filter((s): s is string => !!s);

  const toggle = (key: string) =>
    setTicked((set) => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const save = async () => {
    setSaving(true);
    setError(null);
    const spec: LayoutSpec = {
      version: 1,
      items: items.flatMap((i) => {
        const box = { kind: i.kind, page: i.page, x: i.x, y: i.y, w: i.w, h: i.h };
        if (i.kind !== "text") return [box];
        return ticked.has(`item:${i.id}`) && i.text?.trim() ? [{ ...box, text: i.text.trim() }] : [];
      }),
      values: Object.entries(values).flatMap(([field, value]) => {
        if (!ticked.has(`field:${field}`)) return [];
        const today = asToday(value, new Date(), fields.get(field)?.dateFormat);
        return [today ? { field, today } : { field, value }];
      }),
      flatten,
    };
    try {
      const res = await fetch("/api/fill-sign/layouts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender, ...print, name: name.trim() || formName(file.attachment.name), spec }),
      });
      const body = (await res.json().catch(() => ({}))) as { layout?: Layout; error?: string };
      if (!res.ok || !body.layout) throw new Error(body.error ?? "Kite couldn't remember this layout. Try again.");
      onSaved(body.layout);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kite couldn't remember this layout. Try again.");
      setSaving(false);
    }
  };

  if (!recognisable) {
    return (
      <div className="blur-fade flex flex-wrap items-center gap-2 border-b border-pane-border bg-pane-2 px-4 py-2.5 text-[12.5px]">
        <p className="min-w-0 flex-1 text-pane-muted">
          This PDF has too little printed text for Kite to recognise it next time (scanned forms look like pictures), so there&apos;s nothing to remember.
        </p>
        <button onClick={onCancel} className="h-7 rounded-full px-3 text-pane-muted hover:bg-pane-hover hover:text-pane-fg">
          OK
        </button>
      </div>
    );
  }

  return (
    <div className="blur-fade flex flex-col gap-2.5 border-b border-pane-border bg-pane-2 px-4 py-3 text-[12.5px]">
      <label className="flex flex-wrap items-center gap-2">
        <span className="text-pane-muted">Form name</span>
        <input
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          className="h-7 w-56 min-w-0 max-w-full rounded-full border border-pane-border bg-pane px-3 outline-none focus:border-accent"
        />
      </label>
      <p className="text-pane-muted">
        {kept.length ? `Kite keeps where you placed ${kept.join(", ")}. ` : ""}
        {choices.length ? "Tick the values that stay the same each time; they're filled in for you next time." : "Nothing you typed is kept."}
      </p>
      {choices.length ? (
        <div className="flex flex-col gap-1">
          {choices.map((c) => (
            <label key={c.key} className="flex min-w-0 cursor-pointer items-center gap-2">
              <input type="checkbox" checked={ticked.has(c.key)} onChange={() => toggle(c.key)} className="size-3.5 shrink-0 accent-[var(--accent)]" />
              <span className="shrink-0">{c.label}</span>
              <span className="min-w-0 truncate text-pane-muted">{c.shown}</span>
            </label>
          ))}
        </div>
      ) : null}
      {error ? <p className="text-warning">{error}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <button onClick={onCancel} className="h-7 rounded-full px-3 text-pane-muted hover:bg-pane-hover hover:text-pane-fg">
          Cancel
        </button>
        <button
          onClick={() => void save()}
          disabled={saving}
          className="h-7 rounded-full bg-pane-fg px-3 font-medium text-pane hover:opacity-90 disabled:opacity-40"
        >
          {saving ? "Remembering…" : `Remember for ${senderLabel(file)}`}
        </button>
      </div>
    </div>
  );
}

/** "8 of 14 filled", what the profile put where, and Undo. */
function ProfileFillNote({ fill, left, onUndo, onHide }: { fill: ProfileFill; left: number; onUndo: () => void; onHide: () => void }) {
  return (
    <div className="blur-fade flex items-start gap-2 border-b border-pane-border bg-accent-soft px-4 py-2 text-[12.5px]">
      <Icon icon={UserIcon} size={15} className="mt-px shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        {fill.total === 0 ? (
          <p>Kite found no fields or printed labels to fill on this PDF (scanned pages are pictures, with no text to read). Place your details by hand.</p>
        ) : (
          <>
            <p>
              <span className="font-medium">
                {fill.total - left} of {fill.total} filled
              </span>
              {fill.filled.length
                ? `. From your profile: ${fill.filled.map((f) => `${f.label} (${f.value.replace(/\n/g, ", ")})`).join(", ")}.`
                : ". Nothing on this form matched your profile closely enough to fill."}
            </p>
            <p className="text-pane-muted">
              {left ? `${left === 1 ? "The highlighted place is" : `The ${left} highlighted places are`} yours to fill. ` : ""}
              Check everything, then Save copy.
            </p>
          </>
        )}
      </div>
      {fill.filled.length ? (
        <button onClick={onUndo} className="-my-1 h-7 shrink-0 rounded-full px-3 text-pane-muted hover:bg-pane-hover hover:text-pane-fg">
          Undo
        </button>
      ) : null}
      <Tooltip label="Hide">
        <button
          onClick={onHide}
          aria-label="Hide"
          className="-my-1 grid size-6 shrink-0 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
        >
          <Icon icon={Cancel01Icon} size={12} />
        </button>
      </Tooltip>
    </div>
  );
}

function PasswordForm({ wrong, onSubmit }: { wrong: boolean; onSubmit: (password: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="blur-fade mx-auto flex max-w-sm flex-col items-center gap-3 px-4 py-14 text-center"
      onSubmit={(e) => {
        e.preventDefault();
        if (value) onSubmit(value);
      }}
    >
      <span className="grid size-12 place-items-center rounded-2xl bg-pane text-pane-muted">
        <Icon icon={SquareLock02Icon} size={22} />
      </span>
      <p className="text-[12.5px] text-pane-muted">
        {wrong
          ? "That password didn't open it. Try again."
          : "This PDF needs a password to open. The sender usually includes it in the email or sends it separately."}
      </p>
      <div className="flex w-full gap-2">
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Password"
          className="h-9 min-w-0 flex-1 rounded-full border border-pane-border bg-pane px-4 text-[13px] outline-none focus:border-accent"
        />
        <button type="submit" className="h-9 rounded-full bg-pane-fg px-4 text-[12.5px] font-medium text-pane hover:opacity-90">
          Open
        </button>
      </div>
    </form>
  );
}

/** One page: the pdf.js canvas, rendered when near the screen, with fields and items over it. */
function PdfPage({
  page,
  index,
  scale,
  annotationMode,
  tool,
  onPlace,
  onBackground,
  children,
}: {
  page: PDFPageProxy;
  index: number;
  scale: number;
  annotationMode: number;
  tool: PlacedKind | null;
  onPlace: (x: number, y: number) => void;
  onBackground: () => void;
  children: (viewport: PageViewport) => React.ReactNode;
}) {
  const viewport = useMemo(() => page.getViewport({ scale }), [page, scale]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(index < 2);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || visible) return;
    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && setVisible(true), { rootMargin: "800px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  // Renders off-screen and swaps in when done, so zoom changes don't flash.
  useEffect(() => {
    if (!visible) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const scaled = page.getViewport({ scale: scale * ratio });
    const off = document.createElement("canvas");
    off.width = Math.floor(scaled.width);
    off.height = Math.floor(scaled.height);
    const task = page.render({ canvas: off, viewport: scaled, annotationMode });
    task.promise
      .then(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = off.width;
        canvas.height = off.height;
        canvas.getContext("2d")?.drawImage(off, 0, 0);
      })
      .catch(() => {});
    return () => task.cancel();
  }, [page, scale, visible, annotationMode]);

  return (
    <div
      className="relative shrink-0 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.12),0_0_0_1px_var(--pane-border)]"
      style={{ width: viewport.width, height: viewport.height }}
    >
      <canvas ref={canvasRef} aria-label={`Page ${index + 1}`} className="absolute inset-0 size-full" />
      <div
        className={cn("absolute inset-0", tool && "cursor-crosshair")}
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (!tool) {
            onBackground();
            return;
          }
          e.preventDefault();
          const box = e.currentTarget.getBoundingClientRect();
          const [x, y] = viewport.convertToPdfPoint(e.clientX - box.left, e.clientY - box.top);
          onPlace(x, y);
        }}
      >
        {children(viewport)}
      </div>
    </div>
  );
}

function screenRect(viewport: PageViewport, r: { x: number; y: number; width: number; height: number }) {
  const [x1, y1] = viewport.convertToViewportPoint(r.x, r.y) as [number, number];
  const [x2, y2] = viewport.convertToViewportPoint(r.x + r.width, r.y + r.height) as [number, number];
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

const fieldClass =
  "absolute rounded-[2px] bg-accent/10 outline-none transition-colors hover:bg-accent/15 focus:bg-accent/15 focus:ring-2 focus:ring-accent disabled:bg-transparent disabled:ring-0";
/** A place "Fill from my profile" left for the user. */
const missingClass = "bg-warning/10 ring-1 ring-warning/80";

function boxesOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** A printed blank the profile didn't fill: click to type the answer there. */
function BlankHint({ blank, viewport, onAnswer }: { blank: Blank; viewport: PageViewport; onAnswer: () => void }) {
  const box = blankBox(blank);
  const r = screenRect(viewport, { x: box.x, y: box.y, width: Math.min(box.w, 220), height: box.h });
  return (
    <Tooltip label={`Type your answer for "${blank.label}"`}>
      <button
        type="button"
        aria-label={`Answer ${blank.label}`}
        onClick={onAnswer}
        className="blur-fade absolute rounded-[2px] border border-dashed border-warning/80 bg-warning/10 hover:bg-warning/20"
        style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
      />
    </Tooltip>
  );
}

/** A real form field as a control over its widget, so Tab, arrows and Space work as usual. */
function FieldControl({
  field,
  viewport,
  scale,
  disabled,
  missing,
  value,
  onChange,
  onSign,
}: {
  field: FormField;
  viewport: PageViewport;
  scale: number;
  disabled: boolean;
  /** Left empty by "Fill from my profile": highlighted for the user. */
  missing?: boolean;
  value: FieldValue | undefined;
  onChange: (value: FieldValue) => void;
  onSign: () => void;
}) {
  // The day last picked from the calendar mark, so it opens there again.
  const [picked, setPicked] = useState("");
  const r = screenRect(viewport, field.rect);
  const box = {
    left: r.left,
    top: r.top,
    width: r.width,
    height: r.height,
    color: INK,
  };
  const fontSize = (field.fontSize ?? Math.max(6, Math.min(field.rect.height * 0.62, 12))) * scale;
  const title = field.label ?? field.name;

  switch (field.kind) {
    case "text":
    case "date": {
      const text = typeof value === "string" ? value : "";
      if (field.multiline) {
        return (
          <textarea
            aria-label={title}
            title={title}
            disabled={disabled}
            value={text}
            maxLength={field.maxLength}
            onChange={(e) => onChange(e.target.value)}
            className={cn(fieldClass, missing && missingClass, "resize-none px-1 py-0.5 leading-tight")}
            style={{ ...box, fontSize }}
          />
        );
      }
      return (
        <>
          <input
            aria-label={title}
            title={field.kind === "date" ? `${title} (${field.dateFormat})` : title}
            disabled={disabled}
            value={text}
            maxLength={field.maxLength}
            placeholder={field.kind === "date" ? field.dateFormat : undefined}
            onChange={(e) => onChange(e.target.value)}
            className={cn(fieldClass, missing && missingClass, "px-1 placeholder:text-black/25", field.kind === "date" && "pr-6")}
            style={{ ...box, fontSize }}
          />
          {field.kind === "date" && !disabled ? (
            <DateTimePicker
              label={`${title}: pick a date`}
              dateOnly
              value={{ date: picked, start: "", end: "" }}
              onChange={({ date }) => {
                setPicked(date);
                onChange(formatAcrobatDate(new Date(`${date}T00:00`), field.dateFormat ?? "dd/mm/yyyy"));
              }}
              trigger={(props) => (
                <button
                  {...props}
                  tabIndex={-1}
                  className="absolute grid place-items-center rounded-[2px] text-black/45 hover:text-black/80"
                  style={{
                    left: r.left + r.width - 22,
                    top: r.top,
                    width: 22,
                    height: r.height,
                  }}
                >
                  <Icon icon={Calendar03Icon} size={Math.min(14, r.height - 2)} />
                </button>
              )}
            />
          ) : null}
        </>
      );
    }
    case "checkbox":
    case "radio": {
      const checked = field.kind === "checkbox" ? value === true : value === field.option && !!field.option;
      return (
        <label className="absolute" style={box} title={field.kind === "radio" ? `${title}: ${field.option}` : title}>
          <input
            type={field.kind}
            name={field.kind === "radio" ? `pdf-field:${field.name}` : undefined}
            aria-label={field.kind === "radio" ? `${title}: ${field.option}` : title}
            disabled={disabled}
            checked={checked}
            onChange={(e) => onChange(field.kind === "checkbox" ? e.target.checked : (field.option ?? ""))}
            onClick={() => {
              // A second click on the chosen radio clears it, like most PDF viewers.
              if (field.kind === "radio" && checked) onChange("");
            }}
            className={cn(fieldClass, missing && missingClass, "inset-0 size-full cursor-pointer appearance-none", field.kind === "radio" && "rounded-full")}
          />
          {checked ? (
            <svg
              viewBox="0 0 24 24"
              className="pointer-events-none absolute inset-[12%]"
              fill="none"
              stroke={INK}
              strokeWidth={2.6}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {field.kind === "checkbox" ? <path d={TICK_PATH} /> : <circle cx="12" cy="12" r="6" fill={INK} stroke="none" />}
            </svg>
          ) : null}
        </label>
      );
    }
    case "dropdown":
    case "list":
      return (
        <Select
          label={title}
          title={title}
          variant="borderless"
          disabled={disabled}
          value={typeof value === "string" ? value : ""}
          options={[{ value: "", label: "" }, ...(field.options ?? []).map((o) => ({ value: o, label: o }))]}
          onChange={onChange}
          className={cn(fieldClass, missing && missingClass, "h-auto gap-0.5 rounded-[2px] px-0.5 focus-visible:bg-accent/15")}
          style={{ ...box, fontSize }}
        />
      );
    case "signature":
      return disabled ? null : (
        <button
          type="button"
          onClick={onSign}
          className={cn(fieldClass, "border border-dashed border-accent/60 text-[11px] font-medium text-accent")}
          style={{ ...box, color: undefined }}
        >
          Sign here
        </button>
      );
  }
}

let measure: CanvasRenderingContext2D | null = null;

/** Width of placed text in PDF points (Helvetica, which the copy is written in). */
function textWidth(text: string, h: number) {
  measure ??= document.createElement("canvas").getContext("2d");
  if (!measure) return h * 4;
  measure.font = `${h * TEXT_SIZE}px Helvetica, Arial, sans-serif`;
  return Math.max(h * 3, measure.measureText(text).width + h * 0.4);
}

/** A placed item: drag to move, the corner handle to resize, × or Delete to remove. */
function ItemBox({
  item,
  page,
  viewport,
  scale,
  signatureId,
  selected,
  onSelect,
  onChange,
  onRemove,
}: {
  item: Placed;
  page: PDFPageProxy;
  viewport: PageViewport;
  scale: number;
  signatureId: string | null;
  selected: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<Placed>) => void;
  onRemove: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const r = screenRect(viewport, {
    x: item.x,
    y: item.y,
    width: item.w,
    height: item.h,
  });
  const textual = item.kind === "text" || item.kind === "date";
  const [x0, y0, x1, y1] = page.view;

  useEffect(() => {
    if (item.kind === "text" && !item.text) inputRef.current?.focus();
    // Only when placed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const drag = (e: React.PointerEvent, mode: "move" | "resize") => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect();
    const start = { x: e.clientX, y: e.clientY, item };
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / scale;
      const dy = (ev.clientY - start.y) / scale;
      const s = start.item;
      if (mode === "move") {
        onChange({
          x: clamp(s.x + dx, x0 - s.w / 2, x1 - s.w / 2),
          y: clamp(s.y - dy, y0 - s.h / 2, y1 - s.h / 2),
        });
        return;
      }
      // Resize from the bottom-right corner, keeping the top-left in place and the shape.
      const factor = Math.max(0.25, (s.w + dx) / s.w);
      const h = clamp(s.h * factor, 6, 200);
      const w = textual ? textWidth(s.text ?? "", h) : (s.w / s.h) * h;
      onChange({ w, h, y: s.y + s.h - h });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      className={cn("group absolute", !textual && "cursor-move", selected ? "z-10 ring-1 ring-accent" : "hover:ring-1 hover:ring-accent/50")}
      style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
      onPointerDown={(e) => (textual ? onSelect() : drag(e, "move"))}
    >
      {textual ? (
        <input
          ref={inputRef}
          aria-label={item.kind === "date" ? "Date" : "Text"}
          value={item.text ?? ""}
          onFocus={onSelect}
          onChange={(e) =>
            onChange({
              text: e.target.value,
              w: textWidth(e.target.value, item.h),
            })
          }
          onBlur={() => {
            if (!item.text?.trim()) onRemove();
          }}
          className="block size-full bg-transparent p-0 outline-none"
          style={{
            fontSize: item.h * TEXT_SIZE * scale,
            lineHeight: `${item.h * scale}px`,
            fontFamily: "Helvetica, Arial, sans-serif",
            color: INK,
          }}
        />
      ) : item.kind === "tick" ? (
        <svg
          viewBox="0 0 24 24"
          className="pointer-events-none size-full"
          fill="none"
          stroke={INK}
          strokeWidth={2.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d={TICK_PATH} />
        </svg>
      ) : signatureId ? (
        // eslint-disable-next-line @next/next/no-img-element -- the user's own signature from data/assets
        <img src={`/api/assets/${signatureId}`} alt="Your signature" draggable={false} className="pointer-events-none size-full select-none" />
      ) : null}

      {selected ? (
        <>
          {textual ? (
            <Tooltip label="Drag to move">
              <span
                onPointerDown={(e) => drag(e, "move")}
                className="absolute -left-6 top-1/2 grid size-5 -translate-y-1/2 cursor-move place-items-center rounded-full bg-pane text-pane-muted shadow-sm ring-1 ring-pane-border"
              >
                <Icon icon={Drag04Icon} size={12} />
              </span>
            </Tooltip>
          ) : null}
          <Tooltip label="Remove">
            <button
              aria-label="Remove"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onRemove}
              className="absolute -right-2.5 -top-2.5 grid size-5 place-items-center rounded-full bg-pane text-pane-muted shadow-sm ring-1 ring-pane-border hover:text-pane-fg"
            >
              <Icon icon={Cancel01Icon} size={11} />
            </button>
          </Tooltip>
          <span
            aria-hidden
            onPointerDown={(e) => drag(e, "resize")}
            className="absolute -bottom-1.5 -right-1.5 size-3 cursor-nwse-resize rounded-full bg-accent ring-2 ring-pane"
          />
        </>
      ) : null}
    </div>
  );
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

/** Page images plus the placed items, for PDFs pdf-lib can't rewrite. */
async function rasterCopy(loaded: Loaded, items: Placed[], signature: Uint8Array | null) {
  const pages: { jpeg: Uint8Array; width: number; height: number }[] = [];
  const moved: Placed[] = [];
  for (const [index, page] of loaded.pages.entries()) {
    const base = page.getViewport({ scale: 1 });
    const hi = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(hi.width);
    canvas.height = Math.floor(hi.height);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    await page.render({
      canvas,
      viewport: hi,
      annotationMode: loaded.annotationMode.all,
    }).promise;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
    if (!blob) throw new Error("Kite couldn't make the copy. Try again.");
    pages.push({
      jpeg: new Uint8Array(await blob.arrayBuffer()),
      width: base.width,
      height: base.height,
    });
    for (const item of items.filter((i) => i.page === index)) {
      const r = screenRect(base, {
        x: item.x,
        y: item.y,
        width: item.w,
        height: item.h,
      });
      moved.push({
        ...item,
        x: r.left,
        y: base.height - r.top - r.height,
        w: r.width,
        h: r.height,
      });
    }
  }
  return imagePdf(pages, moved, signature);
}
