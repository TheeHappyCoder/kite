"use client";

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Alert02Icon, BookmarkAdd01Icon, Calendar03Icon, Cancel01Icon, Download04Icon, InformationCircleIcon, MailReply01Icon, PencilEdit02Icon, RepeatIcon, SignatureIcon, SquareLock02Icon, TextFontIcon, Tick02Icon, UserIcon } from "@hugeicons/core-free-icons";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { AttachmentRef } from "@/lib/mail/compose";
import { uploadFile } from "@/lib/mail/upload";
import { applyFill, formatAcrobatDate, imagePdf, LockedPdfError, readForm, unsupportedCharacters, type FieldValue, type FormField, type FormInfo, type Placed, type PlacedKind } from "@/lib/pdf/fill";
import { blankBox, planAutofill } from "@/lib/pdf/autofill";
import { findBlanks, type Blank } from "@/lib/pdf/labels";
import { applyLayout, type Layout } from "@/lib/pdf/layout";
import { loadPdfjs } from "@/lib/pdf/pdfjs";
import { pageText, readPrint } from "@/lib/pdf/print";
import { isEmptyProfile, type Profile } from "@/lib/pdf/profile";
import { cn } from "@/lib/utils";
import { Icon, type IconData } from "../icon";
import { Dialog } from "../ui/dialog";
import { Tooltip } from "../ui/tooltip";
import { fileUrl, type FileRef } from "./file-preview";
import { SignaturePad } from "./signature-pad";

import { SwitchTrack } from "../ui/switch";
import { Spinner } from "../ui/spinner";
import { formatBytes } from "@/lib/format";
import { PasswordForm, type Print, type ProfileFill, ProfileFillNote, RememberPanel, senderLabel } from "./pdf-panels";
import { BlankHint, FieldControl, ItemBox, PdfPage, boxesOverlap, screenRect, textWidth } from "./pdf-page";
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

  return (
    <>
      {/* Escape steps back through the editor (above), and a stray click outside mustn't close it. */}
      <Dialog
        open
        onClose={requestClose}
        dismiss={false}
        sensitive
        title={file.attachment.name}
        description={
          activeTool
            ? `${activeTool.hint}. Esc cancels.`
            : hasFields
              ? "Fill the highlighted fields (Tab moves to the next), or place text, a tick, a date or your signature."
              : "Place text, a tick, a date or your signature anywhere on the page."
        }
        actions={
          <>
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
              className="mx-1.5 flex h-8 items-center gap-1.5 rounded-full bg-pane-fg px-4 text-[12.5px] font-medium text-pane hover:opacity-90 disabled:opacity-40"
            >
              {saving ? <Spinner /> : null}
              {saving ? "Saving…" : saved && !dirty ? "Saved" : "Save copy"}
            </button>
          </>
        }
        stage
        className="h-[calc(100dvh-32px)] max-h-none w-full max-sm:h-[calc(100dvh-16px)] max-sm:max-h-none"
      >
        {/* PDFs leave room at their sides: the controls are a rail beside the page, a bar above it on a phone. */}
        <div className="flex min-h-0 flex-1 max-sm:flex-col">
        {loaded ? (
          <div className="ink-chrome m-2 flex shrink-0 flex-wrap items-center gap-1 rounded-[22px] bg-frame p-1 text-frame-fg shadow-lg max-sm:mb-0 sm:mr-0 sm:w-[72px] sm:flex-col sm:flex-nowrap sm:overflow-y-auto">
            {TOOLS.map((t) => {
              const on = tool === t.kind;
              return (
                <div key={t.kind} className="group/tool relative">
                  <button
                    disabled={blocked}
                    aria-pressed={on}
                    onClick={() => setTool((current) => (current === t.kind ? null : t.kind))}
                    className={cn(CONTROL, "transition-colors duration-150 disabled:opacity-40", on ? "bg-lime font-medium text-lime-fg" : "text-frame-fg hover:bg-frame-hover")}
                  >
                    <Icon icon={t.icon} size={18} /> {t.label}
                  </button>
                  {/* Changing the saved signature belongs to Signature: a small badge on its corner, there when you're on it. */}
                  {t.kind === "signature" && signatureId ? (
                    <Tooltip label="Change your saved signature" className="absolute -right-0.5 -top-0.5 inline-flex opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/tool:opacity-100 max-sm:opacity-100 touch:opacity-100">
                      <button
                        onClick={() => setPadOpen(true)}
                        aria-label="Change your saved signature"
                        className="grid size-5 place-items-center rounded-full bg-frame-active text-frame-fg shadow-sm hover:bg-frame-border"
                      >
                        <Icon icon={PencilEdit02Icon} size={11} />
                      </button>
                    </Tooltip>
                  ) : null}
                </div>
              );
            })}
            <span aria-hidden className="mx-1 h-5 w-px bg-frame-border sm:mx-0 sm:my-0.5 sm:h-px sm:w-8" />
            {match && !placedNote && !blocked && onlyProfile ? (
              <Tooltip label={`Place things where you did on your last ${match.name} from ${senderLabel(file) || match.sender}, for you to check`}>
                <button
                  onClick={() => void placeLayout(match, loaded)}
                  aria-label="Sign like last time"
                  className={cn(CONTROL, "blur-fade text-frame-fg hover:bg-frame-hover")}
                >
                  <Icon icon={RepeatIcon} size={18} /> <span className="sm:hidden">Sign like last time</span><span className="max-sm:hidden">Last time</span>
                </button>
              </Tooltip>
            ) : null}
            <Tooltip label="Fill from my profile">
              <button
                onClick={() => void fillFromProfile()}
                disabled={blocked || filling}
                aria-label="Fill from my profile"
                className={cn(CONTROL, "text-frame-fg transition-colors duration-150 hover:bg-frame-hover disabled:opacity-40")}
              >
                <Icon icon={UserIcon} size={18} /> {filling ? "Filling…" : <><span className="sm:hidden">Fill from my profile</span><span className="max-sm:hidden">Profile</span></>}
              </button>
            </Tooltip>
            <span className="ml-auto sm:ml-0 sm:mt-auto" />
            <Caveat loaded={loaded} />
            <span className="px-3 text-[12px] tabular-nums text-frame-muted sm:px-0 sm:pb-2 sm:pt-1 sm:text-center sm:text-[11px]">
              {loaded.pages.length} {loaded.pages.length === 1 ? "page" : "pages"}
            </span>
          </div>
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">

        {error ? (
          <p role="alert" className="blur-fade flex items-start justify-center gap-1.5 px-4 pt-2 text-[12.5px] text-danger">
            <Icon icon={Alert02Icon} size={15} className="mt-px shrink-0" /> {error}
          </p>
        ) : null}
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
        </div>
        </div>
      </Dialog>

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
    </>
  );
}

const CONTROL = "flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] sm:h-14 sm:w-16 sm:flex-col sm:justify-center sm:gap-1 sm:rounded-[18px] sm:px-0 sm:text-[11px]";

/** What's unusual about this PDF: an icon in the controls, the whole story in its tooltip. */
function Caveat({ loaded }: { loaded: Loaded }) {
  const caveat: { icon: IconData; detail: string } | null =
    loaded.lock === "encrypted"
      ? {
          icon: SquareLock02Icon,
          detail: "This PDF is locked by its sender, so Kite can't fill its fields or change the file. You can still place text, ticks, dates and your signature: the copy is saved as images of the pages (text in it won't be selectable). For a normal copy, ask the sender for an unlocked PDF.",
        }
      : loaded.lock === "unreadable"
        ? { icon: InformationCircleIcon, detail: "Kite can show this PDF but can't edit its structure, so the copy is saved as images of the pages. Placing text, ticks, dates and your signature still works." }
        : loaded.info?.xfa
          ? { icon: InformationCircleIcon, detail: "This form uses XFA, which Kite can't fill field by field. Click to place text on the page instead. Your copy drops the XFA part, so every PDF viewer shows the same thing." }
          : null;
  if (!caveat) return null;
  return (
    <Tooltip label={caveat.detail} className="inline-flex shrink-0 pl-2 text-frame-muted sm:pl-0">
      <Icon icon={caveat.icon} size={15} />
    </Tooltip>
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
