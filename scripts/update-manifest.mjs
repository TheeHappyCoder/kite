// Prepare latest.json beside a signed NSIS installer. No publishing or credentials needed.
// node scripts/update-manifest.mjs <installer.exe> <release-notes.md> [release-tag]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function updateManifest({ version, tag, filename, signature, notes, date = new Date().toISOString() }) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error("Invalid release version");
  if (!filename.endsWith("-setup.exe") || path.basename(filename) !== filename) throw new Error("Expected an NSIS setup executable");
  if (!signature.trim()) throw new Error("Missing updater signature; build with TAURI_SIGNING_PRIVATE_KEY");
  return {
    version, notes, pub_date: date,
    platforms: {
      "windows-x86_64": {
        signature: signature.trim(),
        url: `https://github.com/TheeHappyCoder/kite/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(filename)}`,
      },
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [installer, notesFile, releaseTag] = process.argv.slice(2);
  if (!installer || !notesFile) throw new Error("Usage: node scripts/update-manifest.mjs <installer.exe> <release-notes.md> [release-tag]");
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const filename = path.basename(installer);
  if (!filename.includes(`_${config.version}_x64-setup.exe`)) throw new Error("Installer must match the configured version and x64 architecture");
  const manifest = updateManifest({
    version: config.version, tag: releaseTag || `v${config.version}`, filename,
    signature: readFileSync(`${installer}.sig`, "utf8"), notes: readFileSync(notesFile, "utf8"),
  });
  const output = path.join(path.dirname(installer), "latest.json");
  writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Prepared ${output}. Upload it with ${filename} and ${filename}.sig to the same GitHub release.`);
}
