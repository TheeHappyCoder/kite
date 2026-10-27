import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// Every test file gets a fresh data folder (database, caches, secret key) in the system temp
// folder, never the project's data/ or data-demo/.
const dir = mkdtempSync(path.join(tmpdir(), "kite-test-"));
process.env.KITE_DATA_DIR = dir;

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // SQLite may still hold the file on Windows; the temp folder is cleaned up later.
  }
});
