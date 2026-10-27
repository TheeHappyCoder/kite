// A pretend deploy in the Kite bar, as the template for a real integration (docs/bar.md):
// a progress bar updated in place by key, a Cancel button heard over the event stream, then the
// result with a link. Usage: node scripts/bar-demo.mjs <token>   (or KITE_BAR_TOKEN=<token>)
// Make a token in Kite → Settings → Kite bar → Add integration.

const KITE = process.env.KITE_URL ?? "http://127.0.0.1:3100";
const token = process.argv[2] ?? process.env.KITE_BAR_TOKEN;
if (!token) {
  console.error("Usage: node scripts/bar-demo.mjs <token>  (Kite → Settings → Kite bar → Add integration)");
  process.exit(1);
}
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function show(activity) {
  const res = await fetch(`${KITE}/api/bar/activities`, { method: "POST", headers, body: JSON.stringify(activity) });
  const body = await res.json();
  if (!res.ok) throw new Error(body.problems?.join("\n") ?? body.error);
  return body;
}

/** Follows what the user does (server-sent events), calling `on` for each event. */
async function listen(on, signal) {
  const res = await fetch(`${KITE}/api/bar/events`, { headers, signal });
  if (!res.ok) throw new Error((await res.json()).error);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const line = buffer.slice(0, end).split("\n").find((l) => l.startsWith("data: "));
      buffer = buffer.slice(end + 2);
      if (line) on(JSON.parse(line.slice(6)));
    }
  }
}

const key = `deploy-${Date.now().toString(36)}`;
const steps = ["Building", "Running tests", "Uploading", "Migrating database", "Switching traffic"];
let cancelled = false;
const stop = new AbortController();

listen((event) => {
  if (event.type === "ready") console.log(`Connected as "${event.integration}". Watch the top of your screen.`);
  if (event.type === "action" && event.key === key && event.action === "cancel") {
    console.log("Cancel clicked in the Kite bar.");
    cancelled = true;
  }
  if (event.type === "dismissed" && event.key === key) console.log("Closed in the Kite bar.");
}, stop.signal).catch((error) => {
  if (!stop.signal.aborted) console.error("Event stream:", error.message);
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await wait(500);

for (let i = 0; i < steps.length && !cancelled; i++) {
  await show({
    key,
    title: "Deploying kite-web",
    subtitle: `main · ${steps[i]}`,
    icon: "deploy",
    value: { type: "progress", progress: i / steps.length, label: `Step ${i + 1} of ${steps.length}` },
    actions: [{ type: "callback", label: "Cancel", id: "cancel" }],
    // The first one drops open; the updates land in place.
    duration: 120,
  });
  console.log(`${steps[i]}…`);
  await wait(3_000);
}

await show(
  cancelled
    ? { key, title: "Deploy cancelled", subtitle: "kite-web", icon: "alert", tint: "warning", body: "Nothing changed: traffic stays on the last release.", duration: 30 }
    : {
        key,
        title: "Deployed kite-web",
        subtitle: "main · 3f2c1a9",
        icon: "check",
        tint: "success",
        value: { type: "text", text: "Live in 15 s" },
        actions: [
          { type: "copy", label: "Copy SHA", text: "3f2c1a9" },
          { type: "open_url", label: "Open site", url: "https://example.com" },
        ],
        priority: "high",
        duration: 45,
      },
);
console.log(cancelled ? "Cancelled." : "Done.");
await wait(1_000);
stop.abort();
