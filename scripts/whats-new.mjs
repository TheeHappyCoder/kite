// One folder per release: docs/whats-new/<version>/ holds notes.md (what the update dialog says) and
// the pictures it shows, and nothing else (docs/updates.md).
//   pnpm whats-new new 0.2.6   makes the folder and a notes.md to fill in
//   pnpm whats-new check       is the newest release's folder ready? (also: no release pictures elsewhere)
//   pnpm whats-new tag         writes the tag message with the pictures' website addresses, and says how to tag
// In notes.md a picture is just its file name (`media: files.webp`). Never tags or pushes by itself.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FOLDER = join(ROOT, "docs", "whats-new");
const SITE = "https://theehappycoder.github.io/kite/whats-new";
const MEDIA = /^[a-z0-9-]+\.(webp|gif|png|jpg)$/;
const MAX_BYTES = 1024 * 1024;
/** Releases that keep their folder. */
const KEEP = 5;
/** Where pictures may live in the repository: anything else is one that lost its way. */
const PICTURE = /\.(gif|webp|png|jpe?g|mp4|webm)$/i;
const PICTURE_HOMES = /^(docs\/whats-new\/\d+\.\d+\.\d+\/|docs\/images\/|docs\/screenshots\/|src-tauri\/|public\/|src\/app\/)/;

const TEMPLATE = `TODO: one line under the version, said first.
- TODO: a smaller fix, one line each. These become "Smaller things".
## TODO: a feature's name
media: TODO-a-picture-in-this-folder.webp
TODO: what it does, in a sentence or two.
`;

const newer = (a, b) => b.split(".").reduce((order, n, i) => order || Number(n) - Number(a.split(".")[i]), 0);
const versions = () => readdirSync(FOLDER).filter((name) => /^\d+\.\d+\.\d+$/.test(name)).sort(newer);
const packageVersion = () => JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

/** What's wrong with a release's folder, in plain lines. */
function problems(version) {
  const dir = join(FOLDER, version);
  const notesFile = join(dir, "notes.md");
  if (!existsSync(notesFile)) return [`${version} has no notes.md`];
  const found = [];
  const notes = readFileSync(notesFile, "utf8");
  if (/TODO/.test(notes)) found.push("notes.md still has a TODO in it");
  const used = new Set();
  let inFeature = false;
  for (const raw of notes.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^##\s/.test(line)) inFeature = true;
    const media = line.match(/^media:\s*(\S+)$/i)?.[1];
    if (!media) continue;
    if (!inFeature) found.push(`"${line}" is above the first "## ": the dialog only shows pictures under a feature`);
    if (!MEDIA.test(media)) found.push(`"${media}" should be a lower-case file name in this folder (.webp, .gif, .png or .jpg)`);
    else if (!existsSync(join(dir, media))) found.push(`${media} is in notes.md but not in the folder`);
    used.add(media);
  }
  for (const name of readdirSync(dir)) {
    if (name === "notes.md") continue;
    if (!used.has(name)) found.push(`${name} is in the folder but notes.md doesn't use it`);
    else if (statSync(join(dir, name)).size > MAX_BYTES) found.push(`${name} is over 1 MB: every user downloads it to read the notes`);
  }
  return found;
}

function strays() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((file) => PICTURE.test(file) && !PICTURE_HOMES.test(file));
}

function check(version) {
  const found = [...problems(version), ...strays().map((file) => `${file} is a picture outside docs/whats-new/<version>/ (or docs/images, docs/screenshots)`)];
  for (const line of found) console.error(`  ${line}`);
  return found.length === 0;
}

const [command, argument] = process.argv.slice(2);
if (command === "new") {
  if (!/^\d+\.\d+\.\d+$/.test(argument ?? "")) throw new Error("Which version? pnpm whats-new new 0.2.6");
  const file = join(FOLDER, argument, "notes.md");
  if (existsSync(file)) throw new Error(`${file} is already there.`);
  mkdirSync(join(FOLDER, argument), { recursive: true });
  writeFileSync(file, TEMPLATE);
  console.log(`Made docs/whats-new/${argument}/notes.md. Record pictures with: node scripts/whats-new-media.mjs --version=${argument}`);
  // The update dialog only ever shows the newest notes; git keeps the rest.
  for (const old of versions().slice(KEEP)) {
    rmSync(join(FOLDER, old), { recursive: true });
    console.log(`Removed docs/whats-new/${old}: only the newest ${KEEP} are kept. Commit it, or restore it if you want it back.`);
  }
  console.log("Empty the old scenes in scripts/whats-new/scenes.mjs before writing this release's.");
} else if (command === "check" || command === "tag") {
  const version = argument ?? versions()[0];
  console.log(`Kite ${version}`);
  if (!check(version)) process.exit(1);
  if (command === "check") {
    console.log("Ready.");
  } else {
    if (version !== packageVersion()) throw new Error(`package.json says ${packageVersion()}: bump the version first (docs/updates.md).`);
    const notes = readFileSync(join(FOLDER, version, "notes.md"), "utf8").replace(/^media:\s*(\S+)\s*$/gim, `media: ${SITE}/${version}/$1`);
    const file = join(tmpdir(), `kite-${version}-notes.txt`);
    writeFileSync(file, notes);
    // Pictures must be on the website before anyone reads the notes; a push to main deploys it.
    for (const url of notes.match(/^media: (\S+)/gim)?.map((line) => line.slice(7)) ?? []) {
      const res = await fetch(url, { method: "HEAD" }).catch(() => null);
      if (!res?.ok) console.warn(`  Not on the website yet (push main first): ${url}`);
    }
    // --cleanup=verbatim: by default git treats "## " lines as comments and deletes them.
    console.log(`Tag it with:\n  git tag -a v${version} --cleanup=verbatim -F "${file}"\n  git push origin v${version}`);
  }
} else {
  console.log("pnpm whats-new new <version> | check [version] | tag [version]");
}
