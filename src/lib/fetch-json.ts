/** Calls one of Kite's own JSON routes: the parsed answer, or an Error with the route's message (else `fallback`). */
export async function fetchJson<T>(url: string, method: string, body?: unknown, fallback = "That didn't go through. Try again."): Promise<T> {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? fallback);
  return data as T;
}
