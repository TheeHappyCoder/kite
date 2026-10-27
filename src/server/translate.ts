import "server-only";

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TranslateState } from "@/lib/translate/languages";
import { dataDir } from "./paths";
import { logSent } from "./privacy-log";

// Translation on this computer with Firefox's engine (Bergamot, MPL-2.0) and models: the engine and
// each language are downloaded once from Mozilla's Remote Settings (what Firefox itself uses), checked
// against the hash Mozilla publishes, and kept in data/translations. Message text never leaves the
// computer: the reader translates in a worker (lib/translate/worker.ts) with files served by
// /api/translate/file. Every download is in the privacy log.

const SERVICE = "Mozilla (Firefox translations)";
const RECORDS = "https://firefox.settings.services.mozilla.com/v1/buckets/main/collections";
const ATTACHMENTS = "https://firefox-settings-attachments.cdn.mozilla.net/";
/** The engine build the bundled loader (lib/translate/bergamot-translator.js) matches. */
const ENGINE_VERSION = "3.0";
/** Model majors that engine runs (Firefox's notes: 1.x and 2.x models run on 3.x engines). */
const MODEL_MAJORS = new Set(["1", "2"]);
/** The list of languages is read again after this long. */
const RECORDS_MAX_AGE = 7 * 86_400_000;

export type FileType = "model" | "lex" | "vocab" | "srcvocab" | "trgvocab";
const FILE_TYPES = new Set<string>(["model", "lex", "vocab", "srcvocab", "trgvocab"]);

type Attachment = { hash: string; size: number; location: string };
type ModelRecord = { name: string; fromLang: string; toLang: string; version: string; fileType: FileType; attachment: Attachment; filter_expression?: string };
type WasmRecord = { name: string; version: string; attachment: Attachment; filter_expression?: string };
type Records = { at: number; models: ModelRecord[]; engine: WasmRecord | null };

/** One model file as the worker loads it. */
export type ModelFile = { type: FileType; file: string; name: string; size: number };
/** A pair's files (from -> to), what the worker builds one TranslationModel from. */
export type PairFiles = { from: string; to: string; files: ModelFile[] };

const dir = (...parts: string[]) => dataDir("translations", ...parts);
const fileOf = (attachment: Attachment, ext: string) => `${attachment.hash.slice(0, 32)}${ext}`;

/** Files the worker may ask for: only names Kite wrote (a hash and an extension). */
export const FILE_NAME = /^[a-f0-9]{32}\.(bin|spm|wasm)$/;

type State = { records?: Records; downloads: Map<string, Promise<void>> };
const store = globalThis as unknown as { kiteTranslate?: State };
const state: State = (store.kiteTranslate ??= { downloads: new Map() });

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new TranslateError(`Mozilla's server answered ${res.status}. Try again in a moment.`);
  return (await res.json()) as T;
}

export class TranslateError extends Error {}

/** The list saved on disk (any age), or null when translation has never been used here. */
function savedRecords(): Records | null {
  if (state.records) return state.records;
  try {
    return (state.records = JSON.parse(readFileSync(dir("records.json"), "utf8")) as Records);
  } catch {
    return null;
  }
}

/** The models and engine Mozilla offers, read at most once a week (and kept on disk meanwhile). */
async function records(): Promise<Records> {
  const saved = savedRecords();
  if (saved && Date.now() - saved.at < RECORDS_MAX_AGE) return saved;
  logSent("translation", SERVICE, "Read the list of languages");
  const [models, wasm] = await Promise.all([
    getJson<{ data: ModelRecord[] }>(`${RECORDS}/translations-models/records`),
    getJson<{ data: WasmRecord[] }>(`${RECORDS}/translations-wasm/records`),
  ]);
  const fresh: Records = {
    at: Date.now(),
    models: models.data.filter((r) => FILE_TYPES.has(r.fileType) && !r.filter_expression && /^\d+\.\d+$/.test(r.version) && MODEL_MAJORS.has(r.version.split(".")[0])),
    engine: wasm.data.find((r) => r.name === "bergamot-translator" && r.version === ENGINE_VERSION && !r.filter_expression) ?? null,
  };
  mkdirSync(dir(), { recursive: true });
  writeFileSync(dir("records.json"), JSON.stringify(fresh));
  return (state.records = fresh);
}

const newer = (a: string, b: string) => {
  const [am, an] = a.split(".").map(Number);
  const [bm, bn] = b.split(".").map(Number);
  return am - bm || an - bn;
};

/** The newest files for each pair, by "from-to". */
function pairs(models: ModelRecord[]) {
  const latest = new Map<string, Map<FileType, ModelRecord>>();
  for (const record of models) {
    const key = `${record.fromLang}-${record.toLang}`;
    const files = latest.get(key) ?? new Map<FileType, ModelRecord>();
    const have = files.get(record.fileType);
    if (!have || newer(record.version, have.version) > 0) files.set(record.fileType, record);
    latest.set(key, files);
  }
  // A pair has to be whole: a model and its vocabulary (one, or source and target).
  for (const [key, files] of latest) {
    if (!files.has("model") || !(files.has("vocab") || (files.has("srcvocab") && files.has("trgvocab")))) latest.delete(key);
  }
  return latest;
}

/** The pairs that take `from` into `to`: direct, or through English as Firefox does. */
function route(all: ReturnType<typeof pairs>, from: string, to: string) {
  const direct = all.get(`${from}-${to}`);
  if (direct) return [direct];
  const out = all.get(`${from}-en`);
  const back = all.get(`en-${to}`);
  return out && back ? [out, back] : null;
}

const extOf = (record: ModelRecord) => (record.fileType.endsWith("vocab") ? ".spm" : ".bin");
const onDisk = (file: string) => existsSync(dir(file));

/** Downloads one file (once, even when asked twice at the same time) and checks it against Mozilla's hash. */
async function fetchFile(attachment: Attachment, file: string, what: string) {
  if (onDisk(file)) return;
  const pending = state.downloads.get(file);
  if (pending) return pending;
  const job = (async () => {
    logSent("translation", SERVICE, `Downloaded ${what}`, `${Math.round(attachment.size / 1e5) / 10} MB`);
    const res = await fetch(ATTACHMENTS + attachment.location, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) throw new TranslateError(`Couldn't download ${what} (${res.status}). Try again in a moment.`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== attachment.hash) throw new TranslateError(`The download of ${what} didn't check out. Try again.`);
    mkdirSync(dir(), { recursive: true });
    writeFileSync(dir(`${file}.part`), bytes);
    renameSync(dir(`${file}.part`), dir(file));
  })().finally(() => state.downloads.delete(file));
  state.downloads.set(file, job);
  return job;
}

const pairFiles = (files: Map<FileType, ModelRecord>): PairFiles => {
  const any = files.get("model")!;
  return {
    from: any.fromLang,
    to: any.toLang,
    files: [...files.values()].map((record) => ({ type: record.fileType, file: fileOf(record.attachment, extOf(record)), name: record.name, size: record.attachment.size })),
  };
};

/**
 * What's offered and what's here, for `target`. `local`: only from what's on this computer (Settings
 * reads it without asking Mozilla); before translation is first used that's nothing.
 */
export async function translateState(target: string, local = false): Promise<TranslateState> {
  const known = local ? savedRecords() : await records();
  if (!known) return { target, languages: [], stored: storedBytes() };
  const { models } = known;
  const all = pairs(models);
  const sources = new Set([...all.keys()].map((k) => k.split("-")[0]));
  const languages = [...sources]
    .filter((code) => code !== target)
    .flatMap((code) => {
      const chain = route(all, code, target);
      if (!chain) return [];
      const files = chain.flatMap((p) => pairFiles(p).files);
      const download = files.filter((f) => !onDisk(f.file)).reduce((n, f) => n + f.size, 0);
      return [{ code, download, installed: download === 0 }];
    });
  return { target, languages, stored: storedBytes() };
}

function storedBytes() {
  if (!existsSync(dir())) return 0;
  return readdirSync(dir())
    .filter((f) => FILE_NAME.test(f))
    .reduce((n, f) => n + statSync(dir(f)).size, 0);
}

/**
 * Makes sure the engine and the files for `from` -> `to` are here (downloading what's missing) and
 * says what the worker loads: the engine file and one or two pairs.
 */
export async function prepare(from: string, to: string): Promise<{ engine: string; pairs: PairFiles[] }> {
  const { models, engine } = await records();
  if (!engine) throw new TranslateError("Mozilla isn't offering the translation engine Kite uses right now.");
  const chain = route(pairs(models), from, to);
  if (!chain) throw new TranslateError("Kite can't translate between these two languages on this computer.");
  const engineFile = fileOf(engine.attachment, ".wasm");
  await fetchFile(engine.attachment, engineFile, "the translation engine");
  for (const files of chain) {
    for (const record of files.values()) await fetchFile(record.attachment, fileOf(record.attachment, extOf(record)), `${record.fromLang} to ${record.toLang} (${record.fileType})`);
  }
  return { engine: engineFile, pairs: chain.map(pairFiles) };
}

/** Removes a language: every file only it uses (the engine and English pairs other languages share stay). */
export async function removeLanguage(code: string, target: string) {
  const { models } = await records();
  const all = pairs(models);
  const keep = new Set<string>();
  const drop = new Set<string>();
  for (const [key, files] of all) {
    const names = [...files.values()].map((r) => fileOf(r.attachment, extOf(r)));
    const [from, to] = key.split("-");
    const mine = from === code || to === code;
    for (const name of names) (mine ? drop : keep).add(name);
    // The English half of a pivot is shared with every other language into the target.
    if (!mine && from === "en" && to === target) names.forEach((n) => keep.add(n));
  }
  for (const name of drop) if (!keep.has(name) && onDisk(name)) rmSync(dir(name));
}

/** A downloaded file's path, for the route that serves it to the worker. */
export function translationFile(name: string) {
  if (!FILE_NAME.test(name)) return null;
  const file = dir(name);
  return existsSync(file) ? path.resolve(file) : null;
}

/** Everything translation keeps (Erase everything, Reset). */
export function clearTranslations() {
  rmSync(dir(), { recursive: true, force: true });
  state.records = undefined;
}
