// Bundle size: every client chunk of the perf build (raw / gzip / brotli) and, from the
// browser source maps, how many bytes each package or source folder contributes.
import fs from "node:fs";
import path from "node:path";
import { ROOT, compressedSizes, kb } from "./lib.mjs";

export const DIST = path.join(ROOT, ".next-perf");
const STATIC = path.join(DIST, "static");

const B64 = Object.fromEntries([..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].map((c, i) => [c, i]));

/** Decodes one mappings line into [generatedColumn, sourceIndex | -1] pairs (columns are absolute). */
function* segments(mappings) {
  let line = 0;
  let column = 0;
  let source = 0;
  for (const lineText of mappings.split(";")) {
    column = 0;
    if (lineText) {
      for (const seg of lineText.split(",")) {
        if (!seg) continue;
        const values = [];
        let value = 0;
        let shift = 0;
        for (const ch of seg) {
          const digit = B64[ch];
          value += (digit & 31) << shift;
          if (digit & 32) shift += 5;
          else {
            values.push(value & 1 ? -(value >>> 1) : value >>> 1);
            value = 0;
            shift = 0;
          }
        }
        column += values[0];
        if (values.length > 1) source += values[1];
        yield { line, column, source: values.length > 1 ? source : -1 };
      }
    }
    line++;
  }
}

/** Groups a source path: a package name for node_modules, a folder for app code. */
export function groupOf(source) {
  // Packages that ship their own source maps keep their bundler's paths (pdf.js: webpack://pdf.js/...).
  const nested = source.match(/^webpack:\/\/([^/]+)\//);
  if (nested) return nested[1] === "pdf.js" ? "pdfjs-dist" : nested[1];
  const clean = source.replace(/^turbopack:\/\/\/?(\[project\]\/)?/, "").replace(/\\/g, "/");
  // React and friends are vendored inside next: report them by name.
  const compiled = clean.match(/next\/dist\/compiled\/((?:@[^/]+\/)?[^/]+)/);
  if (compiled) return compiled[1];
  const nm = clean.lastIndexOf("node_modules/");
  if (nm >= 0) {
    const rest = clean.slice(nm + "node_modules/".length).split("/");
    return rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  }
  const parts = clean.split("/");
  if (parts[0] === "src") return parts.slice(0, Math.min(3, parts.length - 1)).join("/") || clean;
  if (clean.startsWith("[turbopack]") || clean.includes("turbopack")) return "(turbopack runtime)";
  return parts[0] || "(unknown)";
}

/** Bytes of a chunk attributed to source groups via its source map. */
export function attribute(file) {
  const code = fs.readFileSync(file, "utf8");
  const ref = code.match(/\/\/# sourceMappingURL=(\S+)\s*$/);
  const result = new Map();
  if (!ref) return { groups: result, mapped: false };
  const mapFile = path.join(path.dirname(file), ref[1]);
  if (!fs.existsSync(mapFile)) return { groups: result, mapped: false };
  const map = JSON.parse(fs.readFileSync(mapFile, "utf8"));
  const lines = code.split("\n");
  const add = (group, bytes) => result.set(group, (result.get(group) ?? 0) + bytes);
  let prev = null;
  const flush = (end) => {
    if (!prev) return;
    const bytes = Math.max(0, end - prev.column);
    add(prev.source >= 0 ? groupOf(map.sources[prev.source]) : "(unmapped)", bytes);
  };
  let currentLine = -1;
  for (const seg of segments(map.mappings)) {
    if (seg.line !== currentLine) {
      if (prev) flush((lines[prev.line] ?? "").length);
      if (currentLine === -1 && seg.column > 0) add("(unmapped)", seg.column);
      prev = null;
      currentLine = seg.line;
    }
    if (prev) flush(seg.column);
    prev = seg;
  }
  if (prev) flush((lines[prev.line] ?? "").length);
  return { groups: result, mapped: true };
}

export function chunkPath(url) {
  const pathname = new URL(url, "http://x").pathname;
  const rel = pathname.replace(/^\/_next\/static\//, "");
  return path.join(STATIC, ...rel.split("/"));
}

/** Every client JS/CSS file of the build with its sizes. */
export function measureBundle() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|css)$/.test(entry.name)) files.push(full);
    }
  };
  walk(STATIC);
  const chunks = files.map((file) => ({
    file: path.relative(STATIC, file).replace(/\\/g, "/"),
    type: file.endsWith(".css") ? "css" : "js",
    ...compressedSizes(fs.readFileSync(file)),
  }));
  chunks.sort((a, b) => b.gzip - a.gzip);
  const sum = (type, key) => chunks.filter((c) => c.type === type).reduce((s, c) => s + c[key], 0);
  return {
    chunks,
    totals: {
      jsRawKB: kb(sum("js", "raw")),
      jsGzipKB: kb(sum("js", "gzip")),
      jsBrotliKB: kb(sum("js", "brotli")),
      cssGzipKB: kb(sum("css", "gzip")),
      files: chunks.length,
    },
  };
}

/** Attribution across a set of chunk files (raw minified bytes per group). */
export function attributeFiles(files) {
  const total = new Map();
  for (const file of files) {
    if (!file.endsWith(".js") || !fs.existsSync(file)) continue;
    for (const [group, bytes] of attribute(file).groups) total.set(group, (total.get(group) ?? 0) + bytes);
  }
  return [...total.entries()].sort((a, b) => b[1] - a[1]).map(([group, bytes]) => ({ group, rawKB: kb(bytes) }));
}
