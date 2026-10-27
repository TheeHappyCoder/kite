// `tauri dev` runs this before opening the window: reuse a running `pnpm dev`, or start one.
import { spawn } from "node:child_process";
import net from "node:net";

const PORT = 3100;
const HOST = "127.0.0.1";

/** A port check, not an HTTP request: Next's first compile can take longer than any sane timeout. */
function running() {
  return new Promise((resolve) => {
    const socket = net.connect(PORT, HOST);
    socket.setTimeout(1000);
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("timeout", () => (socket.destroy(), resolve(false)));
    socket.once("error", () => resolve(false));
  });
}

if (await running()) {
  console.log(`[kite] Using the dev server already running on ${HOST}:${PORT}`);
  // Tauri stops this process when the window closes; keep it alive until then.
  setInterval(() => {}, 1 << 30);
} else {
  console.log("[kite] Starting pnpm dev");
  const child = spawn(process.platform === "win32" ? "pnpm dev" : "pnpm", process.platform === "win32" ? [] : ["dev"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
}
