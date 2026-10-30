import { cn } from "@/lib/utils";

/**
 * What kind of file a name is, finer than `Attachment.kind`: the kinds people tell apart at a glance.
 * By extension first (senders often send everything as octet-stream), then the MIME type.
 */
export type FileType = "word" | "sheet" | "slides" | "pdf" | "image" | "video" | "audio" | "archive" | "text" | "calendar" | "mail" | "other";

const BY_EXTENSION: Record<string, FileType> = {};
const add = (type: FileType, extensions: string) => extensions.split(" ").forEach((ext) => (BY_EXTENSION[ext] = type));
add("word", "doc docx docm dot dotx odt rtf pages");
add("sheet", "xls xlsx xlsm xlsb xlt xltx ods numbers csv tsv");
add("slides", "ppt pptx pptm pps ppsx pot potx odp key");
add("pdf", "pdf");
add("image", "jpg jpeg png gif webp bmp avif heic heif tif tiff svg ico");
add("video", "mp4 m4v mov webm avi mkv wmv 3gp");
add("audio", "mp3 m4a wav ogg oga flac aac wma opus amr");
add("archive", "zip rar 7z tar gz tgz bz2 xz");
add("text", "txt md log json xml html htm yaml yml");
add("calendar", "ics vcs");
add("mail", "eml msg vcf");

export function fileType(name: string, mimeType?: string): FileType {
  const dot = name.lastIndexOf(".");
  const byName = dot > 0 ? BY_EXTENSION[name.slice(dot + 1).toLowerCase()] : undefined;
  if (byName) return byName;
  const type = (mimeType ?? "").toLowerCase();
  if (type === "application/pdf") return "pdf";
  if (type.includes("wordprocessingml") || type === "application/msword") return "word";
  if (type.includes("spreadsheetml") || type === "application/vnd.ms-excel") return "sheet";
  if (type.includes("presentationml") || type === "application/vnd.ms-powerpoint") return "slides";
  if (type === "text/calendar") return "calendar";
  if (type === "message/rfc822") return "mail";
  for (const kind of ["image", "video", "audio", "text"] as const) if (type.startsWith(`${kind}/`)) return kind;
  return "other";
}

/** Literal class names, so Tailwind sees them. */
const COLOR: Record<FileType, string> = {
  word: "text-file-word",
  sheet: "text-file-sheet",
  slides: "text-file-slides",
  pdf: "text-file-pdf",
  image: "text-file-image",
  video: "text-file-video",
  audio: "text-file-audio",
  archive: "text-file-archive",
  text: "text-file-text",
  calendar: "text-file-calendar",
  mail: "text-file-mail",
  other: "text-file-other",
};

/** Office files get their one letter, the way people know them; everything else its extension. */
const LETTER: Partial<Record<FileType, string>> = { word: "W", slides: "P" };

function label(name: string, type: FileType) {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toUpperCase() : "";
  if (LETTER[type]) return LETTER[type];
  if (type === "sheet") return ext === "CSV" || ext === "TSV" ? ext : "X";
  if (ext.length > 0 && ext.length <= 4) return ext;
  return type === "other" ? "FILE" : type.slice(0, 4).toUpperCase();
}

/**
 * A page with a folded corner in the file type's colour, its letter or extension on it. Drawn here
 * (not Microsoft's or Adobe's marks, which aren't open source); `className` sets the height.
 */
export function FileTypeIcon({ name, mimeType, className, style }: { name: string; mimeType?: string; className?: string; style?: React.CSSProperties }) {
  const type = fileType(name, mimeType);
  const text = label(name, type);
  const letter = text.length === 1;
  return (
    <svg viewBox="0 0 24 30" aria-hidden className={cn("h-8 w-auto shrink-0", COLOR[type], className)} style={style}>
      <path d="M4 1h11.2L23 8.8V26a3 3 0 0 1-3 3H4a3 3 0 0 1-3-3V4a3 3 0 0 1 3-3z" fill="currentColor" />
      <path d="M15.2 1v5a2.8 2.8 0 0 0 2.8 2.8h5" fill="#fff" fillOpacity={0.38} />
      <text
        x="12"
        y={letter ? 22.5 : 21.5}
        textAnchor="middle"
        fill="#fff"
        fontWeight={700}
        fontSize={letter ? 11 : text.length > 3 ? 5.6 : 6.6}
        letterSpacing={letter ? 0 : 0.2}
        style={{ fontFamily: "inherit" }}
      >
        {text}
      </text>
    </svg>
  );
}
