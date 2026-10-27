/// <reference lib="webworker" />
// The translation worker: Firefox's engine (Bergamot, compiled to wasm) translating on this computer,
// set up as Firefox's own worker does (toolkit/components/translations/content/translations-engine.worker.js):
// models copied into aligned memory, one TranslationModel per pair (two pivot through English), HTML
// kept as HTML. Files come from Kite's own server (/api/translate/file), never from the network.
import loadBergamot from "./bergamot-translator.js";

type ModelFile = { type: string; file: string; name: string };
type Pair = { from: string; to: string; files: ModelFile[] };
/** `origin`: Kite's address (the worker may run from a blob: URL, where relative addresses don't resolve). */
export type WorkerRequest = { id: number; origin: string; engine: string; pairs: Pair[]; html: string };
export type WorkerReply = { id: number; html?: string; error?: string };

/* eslint-disable @typescript-eslint/no-explicit-any -- the engine's own (emscripten) objects are untyped */
type Bergamot = any;

/** Memory alignment per file, as Firefox uses. */
const ALIGNMENT: Record<string, number> = { model: 256, lex: 64, vocab: 64, srcvocab: 64, trgvocab: 64 };

let engine: Promise<Bergamot> | null = null;
let origin = "";
/** Built models by pair ("es-en"), kept while the worker lives. */
const models = new Map<string, Promise<any>>();

const bytes = async (file: string) => {
  const res = await fetch(`${origin}/api/translate/file/${file}`);
  if (!res.ok) throw new Error("A translation file is missing. Download the language again.");
  return res.arrayBuffer();
};

function start(file: string): Promise<Bergamot> {
  engine ??= bytes(file).then(
    (wasmBinary) =>
      new Promise((resolve, reject) => {
        const bergamot = loadBergamot({
          // Starts small and grows, as Firefox does.
          INITIAL_MEMORY: 41_943_040,
          print: () => {},
          printErr: () => {},
          wasmBinary,
          onAbort: () => reject(new Error("The translation engine couldn't start.")),
          onRuntimeInitialized: () => queueMicrotask(() => resolve(bergamot)),
        });
      }),
  );
  return engine;
}

/** Marian's config: whitespace matters (generateTextConfig in Firefox's worker). */
function config(modelName: string) {
  const indent = "            ";
  const options: Record<string, string> = {
    "beam-size": "1",
    normalize: "1.0",
    "word-penalty": "0",
    "max-length-break": "128",
    "mini-batch-words": "1024",
    workspace: "128",
    "max-length-factor": "2.0",
    "skip-cost": "true",
    "cpu-threads": "0",
    quiet: "true",
    "quiet-translation": "true",
    "gemm-precision": modelName.endsWith("intgemm8.bin") ? "int8shiftAll" : "int8shiftAlphaAll",
    alignment: "soft",
  };
  return "\n" + Object.entries(options).map(([key, value]) => `${indent}${key}: ${value}\n`).join("") + indent;
}

function model(bergamot: Bergamot, pair: Pair) {
  const key = `${pair.from}-${pair.to}`;
  let built = models.get(key);
  if (!built) {
    built = (async () => {
      const memory: Record<string, any> = {};
      for (const file of pair.files) {
        const buffer = await bytes(file.file);
        const aligned = new bergamot.AlignedMemory(buffer.byteLength, ALIGNMENT[file.type] ?? 64);
        aligned.getByteArrayView().set(new Uint8Array(buffer));
        memory[file.type] = aligned;
      }
      const vocabs = new bergamot.AlignedMemoryList();
      if (memory.vocab) vocabs.push_back(memory.vocab);
      else {
        vocabs.push_back(memory.srcvocab);
        vocabs.push_back(memory.trgvocab);
      }
      const name = pair.files.find((f) => f.type === "model")?.name ?? "";
      return new bergamot.TranslationModel(pair.from, pair.to, config(name), memory.model, memory.lex ?? null, vocabs, null);
    })();
    built.catch(() => models.delete(key));
    models.set(key, built);
  }
  return built;
}

let service: any = null;

async function translate(request: WorkerRequest) {
  origin = request.origin;
  const bergamot = await start(request.engine);
  const built = await Promise.all(request.pairs.map((pair) => model(bergamot, pair)));
  // Caching off, as in Firefox.
  service ??= new bergamot.BlockingService({ cacheSize: 0 });
  const messages = new bergamot.VectorString();
  const options = new bergamot.VectorResponseOptions();
  messages.push_back(request.html);
  options.push_back({ qualityScores: false, alignment: true, html: true });
  const responses = built.length === 1 ? service.translate(built[0], messages, options) : service.translateViaPivoting(built[0], built[1], messages, options);
  const html: string = responses.get(0).getTranslatedText();
  messages.delete();
  options.delete();
  return html;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    (self as unknown as Worker).postMessage({ id: request.id, html: await translate(request) } satisfies WorkerReply);
  } catch (error) {
    (self as unknown as Worker).postMessage({ id: request.id, error: error instanceof Error ? error.message : "Couldn't translate this." } satisfies WorkerReply);
  }
};
