import "server-only";

import { spawn, spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "./paths";

// Secrets at rest (Google tokens, the AI key) are encrypted with AES-256-GCM. The data key lives
// in data/secret.key, wrapped by the operating system so a copied data folder is useless on
// another machine or user account: Windows DPAPI (current user) or the macOS keychain. Elsewhere
// the key file is only protected by file permissions. Never log secrets or the key.

const PREFIX = "enc1:";
const KEY_FILE = () => path.join(dataDir(), "secret.key");
const KEYCHAIN = { service: "app.kite.desktop", account: "data-key" };

let cached: Buffer | null = null;
/** Bumped when the key is destroyed, so a warm-up still running can't bring the old one back. */
let generation = 0;
let warming: Promise<void> | null = null;

function powershell(script: string, input: string) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  if (result.status !== 0) throw new Error("The operating system couldn't protect Kite's key");
  return result.stdout.trim();
}

const DPAPI = "Add-Type -AssemblyName System.Security; $in = [Console]::In.ReadToEnd().Trim();";
const UNPROTECT = `${DPAPI} [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in), $null, 'CurrentUser'))`;

function wrap(key: Buffer): string {
  if (process.platform === "win32") {
    return `dpapi:${powershell(`${DPAPI} [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($in), $null, 'CurrentUser'))`, key.toString("base64"))}`;
  }
  if (process.platform === "darwin") {
    const add = spawnSync("security", ["add-generic-password", "-U", "-s", KEYCHAIN.service, "-a", KEYCHAIN.account, "-w", key.toString("base64")], { timeout: 15_000 });
    if (add.status === 0) return "keychain";
  }
  return `plain:${key.toString("base64")}`;
}

function unwrap(stored: string): Buffer {
  if (stored.startsWith("dpapi:")) {
    return Buffer.from(
      powershell(UNPROTECT, stored.slice(6)),
      "base64",
    );
  }
  if (stored === "keychain") {
    const found = spawnSync("security", ["find-generic-password", "-s", KEYCHAIN.service, "-a", KEYCHAIN.account, "-w"], { encoding: "utf8", timeout: 15_000 });
    if (found.status !== 0) throw new Error("Kite's key isn't in the keychain");
    return Buffer.from(found.stdout.trim(), "base64");
  }
  return Buffer.from(stored.replace(/^plain:/, ""), "base64");
}

/** Runs a command without blocking the server, feeding `input` on stdin. */
function runAsync(command: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error("Couldn't read Kite's key"))));
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on("close", () => clearTimeout(timer));
    child.stdin.end(input ?? "");
  });
}

/**
 * Unwraps the key in the background when the server starts (src/instrumentation.ts), so the first
 * requests don't wait on PowerShell or the keychain (~0.3 s that blocked the whole server). Anything
 * that needs the key sooner still unwraps it synchronously.
 */
export function warmKey(): Promise<void> {
  if (cached) return Promise.resolve();
  if (warming) return warming;
  const file = KEY_FILE();
  if (!existsSync(file)) return Promise.resolve();
  const stored = readFileSync(file, "utf8").trim();
  const started = generation;
  const unwrapped: Promise<Buffer> = stored.startsWith("dpapi:")
    ? runAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", UNPROTECT], stored.slice(6)).then((b64) => Buffer.from(b64, "base64"))
    : stored === "keychain"
      ? runAsync("security", ["find-generic-password", "-s", KEYCHAIN.service, "-a", KEYCHAIN.account, "-w"]).then((b64) => Buffer.from(b64, "base64"))
      : Promise.resolve(unwrap(stored));
  warming = unwrapped
    .then((key) => {
      if (!cached && generation === started && key.length === 32) cached = key;
    })
    .catch(() => {})
    .finally(() => (warming = null));
  return warming;
}

/** The data key: read once, created (and wrapped by the OS) the first time. */
function dataKey(): Buffer {
  if (cached) return cached;
  const file = KEY_FILE();
  if (existsSync(file)) {
    cached = unwrap(readFileSync(file, "utf8").trim());
  } else {
    const key = randomBytes(32);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, wrap(key), { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {}
    cached = key;
  }
  return cached;
}

const isSealed = (value: string | null | undefined) => !!value?.startsWith(PREFIX);

/** Encrypts a secret for storage. */
export function seal(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey(), iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

/** Decrypts a stored secret. */
export function unseal(stored: string): string {
  if (!isSealed(stored)) throw new Error("That secret isn't sealed.");
  const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
  const decipher = createDecipheriv("aes-256-gcm", dataKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

/** Forgets the key (Erase everything): anything still sealed with it can never be read again. */
export function destroyKey() {
  cached = null;
  generation++;
  rmSync(KEY_FILE(), { force: true });
  if (process.platform === "darwin") spawnSync("security", ["delete-generic-password", "-s", KEYCHAIN.service, "-a", KEYCHAIN.account], { timeout: 15_000 });
}
