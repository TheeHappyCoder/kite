import "server-only";

import { resolveMx, resolveSrv, resolveTxt } from "node:dns/promises";
import { countSent } from "./privacy-log";

// Node's resolver can fail on some Windows setups (ECONNREFUSED), so fall back to
// DNS-over-HTTPS. Only the queried domain name leaves the machine.

async function doh(name: string, type: "MX" | "TXT" | "SRV") {
  countSent("dns", "Cloudflare DNS");
  const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(3000),
  });
  const data = (await res.json()) as { Answer?: { type: number; data: string }[] };
  return data.Answer ?? [];
}

/** MX hosts sorted by priority. */
export async function mxHosts(domain: string): Promise<string[]> {
  try {
    const records = await resolveMx(domain);
    return records.sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
  } catch {
    return (await doh(domain, "MX"))
      .filter((a) => a.type === 15)
      .map((a) => a.data.split(" "))
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map((parts) => (parts[1] ?? "").replace(/\.$/, ""));
  }
}

/** TXT records, each joined into one string. Empty when none exist. */
export async function txtRecords(name: string): Promise<string[]> {
  try {
    return (await resolveTxt(name)).map((chunks) => chunks.join(""));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "ENODATA") return [];
    return (await doh(name, "TXT"))
      .filter((a) => a.type === 16)
      .map((a) => a.data.replace(/^"|"$/g, "").replace(/"\s*"/g, ""));
  }
}

type SrvRecord = { host: string; port: number };

/** SRV targets sorted by priority, then weight (highest first). Empty when none exist or the service is "not here" ("."). */
export async function srvRecords(name: string): Promise<SrvRecord[]> {
  let records: { priority: number; weight: number; port: number; name: string }[];
  try {
    records = await resolveSrv(name);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "ENODATA") return [];
    records = (await doh(name, "SRV"))
      .filter((a) => a.type === 33)
      .map((a) => a.data.split(" "))
      .map(([priority, weight, port, target]) => ({ priority: Number(priority), weight: Number(weight), port: Number(port), name: target ?? "" }));
  }
  return records
    .map((r) => ({ ...r, name: r.name.replace(/\.$/, "") }))
    .filter((r) => r.name && r.name !== "." && r.port > 0)
    .sort((a, b) => a.priority - b.priority || b.weight - a.weight)
    .map((r) => ({ host: r.name, port: r.port }));
}
