// `pnpm desktop:build`: builds Kite, bundles it with Node and the files its server runs, then builds the Tauri app.
// Output: src-tauri/target/release/kite.exe and the installer in src-tauri/target/release/bundle/nsis.
// `--to-desktop` (`pnpm desktop:release`) also copies the installer to the desktop as "Kite Setup.exe".
//
// The installer ships only what the server loads: Next's server, its compiled pages, and the few packages left
// outside the bundle (pino, pdfjs-dist). Everything the app imports is already compiled into .next, so the
// rest of node_modules (SWC, icons, date-fns…, ~50,000 files) stays out; installing then copies ~2,500 files.
// Next's standalone output would do this, but it links packages with symlinks, which Windows only allows in
// Developer Mode. So the production packages get a plain hoisted install in a staging folder, and the files
// the server needs are traced there with Next's own tracer (the same ignores Next uses) and copied out.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "src-tauri", "resources", "server");
const stage = path.join(root, "src-tauri", "target", "server-stage");
const win = process.platform === "win32";
// Rust may be installed but not on PATH in an older shell.
const cargoBin = path.join(os.homedir(), ".cargo", "bin");
if (existsSync(cargoBin)) process.env.PATH = `${cargoBin}${path.delimiter}${process.env.PATH}`;

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: win });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("[kite] next build");
run("pnpm", ["exec", "next", "build"]);

console.log("[kite] Installing production packages (staging)");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
  if (existsSync(path.join(root, file))) cpSync(path.join(root, file), path.join(stage, file));
}
run("pnpm", ["install", "--prod", "--frozen-lockfile", "--ignore-scripts", "--config.node-linker=hoisted", "--config.package-import-method=copy"], stage);

// The built app only: no build cache, dev output, traces, type stubs or server source maps (~90 MB).
const keepBuilt = (src) =>
  !/[\\/]\.next[\\/](?:cache|dev|standalone|types|trace|trace-build|diagnostics)(?:[\\/]|$)/.test(src) &&
  !/\.(?:map|nft\.json)$/.test(src);
cpSync(path.join(root, ".next"), path.join(stage, ".next"), { recursive: true, filter: keepBuilt });

// Next's standalone server.js: `next start` without the CLI (which pulls in the build tooling).
const config = { ...JSON.parse(readFileSync(path.join(root, ".next", "required-server-files.json"), "utf8")).config, distDir: "./.next" };
writeFileSync(
  path.join(stage, "server.js"),
  `// Written by scripts/desktop-build.mjs, like Next's standalone server.js.
process.env.NODE_ENV = "production";
process.chdir(__dirname);
const nextConfig = ${JSON.stringify(config)};
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig);
require("next");
const { startServer } = require("next/dist/server/lib/start-server");
startServer({
  dir: __dirname,
  isDev: false,
  config: nextConfig,
  hostname: process.env.HOSTNAME || "127.0.0.1",
  port: parseInt(process.env.PORT, 10) || 3100,
  allowRetry: false,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
`,
);

console.log("[kite] Tracing the server's files");
const stageRequire = createRequire(path.join(stage, "package.json"));
const { nodeFileTrace } = stageRequire("next/dist/compiled/@vercel/nft");
const picomatch = stageRequire("next/dist/compiled/picomatch");
// Next's own server ignores (build/collect-build-traces.js), plus what Kite never runs: image optimisation
// (no next/image), the compiler and TypeScript.
const ignored = picomatch(
  [
    "**/next/dist/compiled/next-server/**/*.dev.js",
    "**/next/dist/compiled/webpack/*",
    "**/next/dist/server/lib/route-resolver*",
    "**/next/dist/compiled/semver/semver/**/*.js",
    "**/node_modules/react{,-dom,-dom-server-turbopack}/**/*.development.js",
    "**/next/dist/pages/**/*",
    "**/*.d.ts",
    "**/*.map",
    "**/node_modules/sharp/**/*",
    "**/node_modules/@img/**/*",
    "**/node_modules/@next/swc*/**/*",
    "**/node_modules/typescript/**/*",
    // pdf.js runs from legacy/build only.
    "**/node_modules/pdfjs-dist/{build,web,image_decoders,types}/**/*",
    "**/node_modules/pdfjs-dist/legacy/{web,image_decoders}/**/*",
  ],
  { dot: true },
);
const entries = [path.join(stage, "server.js")];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.[cm]?js$/.test(entry.name)) entries.push(file);
  }
})(path.join(stage, ".next", "server"));
// Document text extraction imports pdf.js by name at runtime (serverExternalPackages), and pdf.js loads its
// worker beside itself: neither is visible to the tracer.
for (const file of ["pdf.mjs", "pdf.worker.mjs"]) entries.push(path.join(stage, "node_modules", "pdfjs-dist", "legacy", "build", file));
const { fileList } = await nodeFileTrace(entries, {
  base: stage,
  processCwd: stage,
  mixedModules: true,
  ignore: (file) => ignored(file.split(path.sep).join("/")),
});

console.log("[kite] Bundling the server");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// Next itself file by file (the big saving); every other package the trace touches goes whole, since Next's
// require hook and pino's workers load files the tracer can't see (styled-jsx/style, transports).
let files = 0;
const whole = new Set();
const copyFile = (file) => {
  cpSync(path.join(stage, file), path.join(out, file));
  files++;
};
for (const file of fileList) {
  if (!file.startsWith("node_modules") || !statSync(path.join(stage, file)).isFile()) continue;
  const pkg = file.match(/^(.*node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)/)[1];
  if (/node_modules[\\/]next$/.test(pkg)) copyFile(file);
  else whole.add(pkg);
}
for (const pkg of whole) {
  (function walk(dir) {
    for (const entry of readdirSync(path.join(stage, dir), { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (ignored(file.split(path.sep).join("/"))) continue;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(file);
      } else copyFile(file);
    }
  })(pkg);
}
cpSync(path.join(stage, ".next"), path.join(out, ".next"), { recursive: true });
cpSync(path.join(stage, "server.js"), path.join(out, "server.js"));
cpSync(path.join(stage, "package.json"), path.join(out, "package.json"));
if (existsSync(path.join(root, "public"))) cpSync(path.join(root, "public"), path.join(out, "public"), { recursive: true });
// The public installer carries no secrets: only the Microsoft client id (a public PKCE client).
// `--with-google` bundles the whole .env.local (Google client secret included) for a personal build.
if (existsSync(path.join(root, ".env.local"))) {
  const lines = readFileSync(path.join(root, ".env.local"), "utf8").split(/\r?\n/);
  const keep = process.argv.includes("--with-google") ? lines : lines.filter((l) => /^MICROSOFT_CLIENT_ID=/.test(l));
  writeFileSync(path.join(out, ".env.production.local"), keep.join("\n") + "\n");
}
// The same Node that builds Kite runs it (node:sqlite needs Node 22.5+).
cpSync(process.execPath, path.join(out, win ? "node.exe" : "node"));
console.log(`[kite] ${files} package files bundled`);

// The installer's first page (tauri.bundle.conf.json `licenseFile`): the licence in a line, then the whole
// privacy policy, as plain text (Markdown tables become one line per row).
const privacy = readFileSync(path.join(root, "PRIVACY.md"), "utf8")
  .split(/\r?\n/)
  .flatMap((line) => {
    if (!line.startsWith("|")) return [line.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\[([^\]]+)\]\(#[^)]*\)/g, "$1").replace(/^#+ /, "")];
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.every((c) => /^-+$/.test(c)) || cells[0] === "What") return [];
    return [`- ${cells[0]}: sent to ${cells[1]}. ${cells[2]}. To avoid it: ${cells[3]}.`];
  })
  .join("\r\n");
writeFileSync(
  path.join(root, "src-tauri", "target", "installer-notice.txt"),
  `Kite is free software under the GNU Affero General Public License v3.0: https://github.com/TheeHappyCoder/kite/blob/main/LICENSE\r\n\r\n${privacy}\r\n`,
);

// `--no-bundle` (the release workflow): kite.exe only, so it can be signed before the installer is made around it.
console.log("[kite] tauri build");
run("pnpm", ["exec", "tauri", "build", "--config", "src-tauri/tauri.bundle.conf.json", ...(process.argv.includes("--no-bundle") ? ["--no-bundle"] : [])]);

if (process.argv.includes("--to-desktop")) {
  const nsis = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");
  const newest = readdirSync(nsis)
    .filter((f) => f.endsWith("-setup.exe"))
    .map((f) => path.join(nsis, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!newest) throw new Error(`No installer in ${nsis}`);
  // The Desktop folder Windows actually shows (OneDrive moves it), else ~/Desktop.
  const shown = win
    ? spawnSync("powershell", ["-NoProfile", "-Command", "[Environment]::GetFolderPath('Desktop')"], { encoding: "utf8" }).stdout?.trim()
    : "";
  const target = path.join(shown || path.join(os.homedir(), "Desktop"), "Kite Setup.exe");
  cpSync(newest, target);
  console.log(`[kite] Installer copied to ${target}`);
}
