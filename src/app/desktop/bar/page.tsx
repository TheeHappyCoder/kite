import type { Metadata } from "next";
import { Bar } from "@/components/desktop/bar";
import { ShortcutsProvider } from "@/lib/shortcuts";

export const metadata: Metadata = { title: "Kite" };

/** The desktop shell's Kite bar window (src-tauri/src/bar.rs). `?demo` (dev only): sample items in a browser. Shortcuts: the quick reply sends with the user's own Send binding. */
export default async function BarPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const demo = process.env.NODE_ENV !== "production" && "demo" in (await searchParams);
  return (
    <ShortcutsProvider>
      <Bar demo={demo} />
    </ShortcutsProvider>
  );
}
