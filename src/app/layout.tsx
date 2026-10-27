import type { Metadata } from "next";
import { Figtree, Geist, Inter, Instrument_Sans, Instrument_Serif } from "next/font/google";
import localFont from "next/font/local";
import { fontScript } from "@/lib/fonts";
import { skyScript } from "@/lib/sky";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});
// The serif for one accent word in a heading (`font-accent`), always italic.
const instrumentSerif = Instrument_Serif({ variable: "--font-instrument-serif", subsets: ["latin"], weight: "400", style: "italic" });

// The fonts in Settings → Appearance (lib/fonts.ts). Only the defaults (Geist for the interface, Inter for
// reading) are preloaded: a browser downloads any other font once something uses it.
// Satoshi, Switzer and General Sans are from Fontshare (ITF Free Font License).
const inter = Inter({ variable: "--font-inter", subsets: ["latin"], style: ["normal", "italic"] });
const instrument = Instrument_Sans({ variable: "--font-instrument", subsets: ["latin"], style: ["normal", "italic"], preload: false });
const figtree = Figtree({ variable: "--font-figtree", subsets: ["latin"], style: ["normal", "italic"], preload: false });
const satoshi = localFont({
  variable: "--font-satoshi",
  preload: false,
  src: [
    { path: "./fonts/Satoshi-Variable.woff2", weight: "300 900", style: "normal" },
    { path: "./fonts/Satoshi-VariableItalic.woff2", weight: "300 900", style: "italic" },
  ],
});
const switzer = localFont({
  variable: "--font-switzer",
  preload: false,
  src: [
    { path: "./fonts/Switzer-Variable.woff2", weight: "100 900", style: "normal" },
    { path: "./fonts/Switzer-VariableItalic.woff2", weight: "100 900", style: "italic" },
  ],
});
const general = localFont({
  variable: "--font-general",
  preload: false,
  src: [
    { path: "./fonts/GeneralSans-Variable.woff2", weight: "200 700", style: "normal" },
    { path: "./fonts/GeneralSans-VariableItalic.woff2", weight: "200 700", style: "italic" },
  ],
});

const fontVariables = [geistSans, instrumentSerif, inter, instrument, figtree, satoshi, switzer, general].map((f) => f.variable).join(" ");

export const metadata: Metadata = {
  title: "Kite",
  description: "A fast, keyboard-first email client.",
};

// Applies the saved pane theme before first paint to avoid a flash.
const themeScript = `try{var t=localStorage.getItem("kite-theme");if(t!=="light"&&t!=="dark"){t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme="dark"}`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The font variables sit on <html> so the chosen fonts (--font-ui, --font-reading, set there by fontScript) can use them.
  return (
    <html lang="en" className={fontVariables} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript + fontScript + skyScript }} />
      </head>
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
