import "server-only";

import path from "node:path";

/**
 * Where local data lives: `KITE_DATA_DIR` (set by the desktop shell) or `data/` in the project.
 * The paths are only known at runtime, so `turbopackIgnore` keeps the build from tracing every
 * file under the project (and the user's mail cache) into the server bundle.
 */
export function dataDir(...parts: string[]) {
  const root = process.env.KITE_DATA_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), "data");
  return path.join(/* turbopackIgnore: true */ root, ...parts);
}
