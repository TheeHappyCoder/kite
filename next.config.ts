import type { NextConfig } from "next";
import { version } from "./package.json";

// `pnpm perf` builds into its own folder with browser source maps (to attribute bundle bytes
// to packages), so it never touches the normal `.next` build or the running dev server.
const perf = process.env.KITE_PERF_BUILD === "1";
const dev = process.env.NODE_ENV !== "production";

/**
 * The app's own pages may only load Kite's code and talk to Kite's server. Images allow http(s)
 * because email frames (srcdoc) inherit this policy and load remote images when the user asks;
 * each frame adds its own stricter policy on top. `ipc:` is the desktop shell's command channel.
 */
const csp = [
  "default-src 'self'",
  // wasm-unsafe-eval: compiling WebAssembly (the translation engine, lib/translate/worker.ts), not eval of script.
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: cid: https: http:",
  "font-src 'self' data:",
  `connect-src 'self' ipc: http://ipc.localhost${dev ? " ws:" : ""}`,
  "frame-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "media-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  devIndicators: false,
  // Settings → About shows it (the desktop shell's version is the same number, tauri.conf.json).
  env: { KITE_VERSION: version },
  ...(perf ? { distDir: ".next-perf", productionBrowserSourceMaps: true } : {}),
  // A second dev server beside `pnpm dev` (own build folder; give it its own KITE_DATA_DIR): `pnpm dev:scratch`.
  ...(process.env.KITE_DIST_DIR ? { distDir: process.env.KITE_DIST_DIR } : {}),
  // Local mail, tokens and caches are read at runtime from dataDir(); never trace them into the build.
  outputFileTracingExcludes: { "*": ["./data/**/*"] },
  // imapflow's logger (pino, CommonJS) starts worker threads from files a bundle can't hold: load it
  // from node_modules (pino is a direct dependency so it resolves from here). Never imapflow or
  // nodemailer themselves: as externals they turn into async modules and circular imports break.
  // PDF text extraction also loads its worker beside the package at runtime.
  serverExternalPackages: ["pino", "pdfjs-dist"],
  async headers() {
    return [
      {
        source: "/((?!api/).*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
