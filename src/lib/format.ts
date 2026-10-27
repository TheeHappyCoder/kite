// Small formatting helpers shared by the client and the server.

/** "820 B", "14 KB", "3.2 MB", "1.5 GB". */
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const [value, unit] = bytes < 1024 ** 3 ? [bytes / 1024 ** 2, "MB"] : [bytes / 1024 ** 3, "GB"];
  return `${value.toFixed(1).replace(/\.0$/, "")} ${unit}`;
}

/** "1 sender", "3 senders". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Two digits: "09". */
export const pad = (n: number) => String(n).padStart(2, "0");

/** A local date as "2026-10-26". */
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
