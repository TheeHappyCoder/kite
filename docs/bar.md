# The Kite bar API

The Kite bar is the strip of Kite's sky that floats at the top of the screen in the Kite desktop app. Kite puts its own things there (sign-in codes, meetings about to start, important mail with a quick reply), and **any app or script on the same computer can put its own activities there too**: a build, a deploy, a timer, a song, a price alert, anything.

You send JSON. Kite draws it in its own look and handles the motion, the queue, the pointer and the keyboard. You never ship UI.

> Building with an AI assistant? Point it at `http://127.0.0.1:3100/api/bar`. That endpoint returns everything below plus the exact JSON Schema.

## 1. Get a token

Kite → Settings → Kite bar → **Add integration**. Name it after your app ("GitHub builds"), copy the token (shown once) and keep it in your script's config or an environment variable. Paste nothing else anywhere: the token is all you need.

Every request carries it:

```
Authorization: Bearer kite_bar_…
```

The API answers only on this computer (`127.0.0.1` / `localhost`) and refuses web pages (anything sending an `Origin` header). Pause or remove an integration in the same settings page and its token stops working at once.

## 2. Show something

```powershell
curl.exe -X POST http://127.0.0.1:3100/api/bar/activities `
  -H "Authorization: Bearer $env:KITE_BAR_TOKEN" -H "content-type: application/json" `
  -d '{\"title\":\"Coffee is ready\",\"icon\":\"bell\"}'
```

```bash
curl -X POST http://127.0.0.1:3100/api/bar/activities \
  -H "Authorization: Bearer $KITE_BAR_TOKEN" -H "content-type: application/json" \
  -d '{"title":"Coffee is ready","icon":"bell"}'
```

The answer is `{ "id", "key", "expiresAt" }`.

## 3. The activity

| Field | | |
|---|---|---|
| `key` | optional | Your id for it. **Send the same key again to update it in place** (progress, status, countdown). Without a key every call is a new activity. Up to 64 of `A-Z a-z 0-9 . : - _`. |
| `title` | required | Up to 60 characters. |
| `subtitle` | | Up to 100. Defaults to your integration's name. |
| `body` | | Up to 280, shown when the Kite bar opens. |
| `icon` | `bell` | `bell check alert info build deploy bug code timer calendar message mail music download upload chart money home bolt sparkles star heart` |
| `tint` | `accent` | `accent success warning danger neutral`: the icon and progress colour. |
| `value` | | One of the four below. |
| `actions` | `[]` | Up to 3 buttons, below. The last one is the main one. |
| `priority` | `normal` | `passive`: arrives resting, as one line. `normal`: drops open for a moment (all its buttons, its body on the paper sheet below), then rests as one line. `high`: also goes ahead of whatever is waiting. |
| `duration` | `60` | Seconds it stays, counted from your last update, 5 to 86400. |

**Values**

```json
{ "type": "text", "text": "3 – 1" }
{ "type": "code", "code": "482193" }
{ "type": "progress", "progress": 0.4, "label": "Step 2 of 5" }
{ "type": "countdown", "until": "2026-10-23T14:30:00+02:00", "label": "Tea" }
```

`code` gets its own Copy button. `countdown` ticks by itself; you don't need to update it.

**Actions**

```json
{ "type": "open_url", "label": "View logs", "url": "https://ci.example.com/builds/482" }
{ "type": "copy", "label": "Copy SHA", "text": "3f2c1a9" }
{ "type": "callback", "label": "Retry", "id": "retry" }
```

`open_url` takes `https://` only and opens in the browser when the user clicks. `copy` puts the text on the clipboard. `callback` tells **you**: see events below.

## 4. Hear what the user does

Keep one connection open to the event stream:

```
GET http://127.0.0.1:3100/api/bar/events
Authorization: Bearer kite_bar_…
```

It's server-sent events: one `data: {json}` line per event.

```json
{ "type": "ready", "integration": "GitHub builds" }
{ "type": "action", "key": "build-482", "action": "retry" }
{ "type": "dismissed", "key": "build-482" }
{ "type": "expired", "key": "build-482" }
{ "type": "ping" }
```

## 5. The rest

- `GET /api/bar/activities`: your activities still showing or waiting.
- `DELETE /api/bar/activities/{key}`: take one away (finished, cancelled).
- Up to 60 calls a minute and 20 live activities per integration. For something that changes often, update one key instead of sending new ones. Too much gets a `429` saying what to do.
- A bad request gets a `400` with `problems`: every mistake with where it is (`actions.0.url: Use an https:// address`).
- Activities live in Kite's memory: they end when they expire, when the user closes them, or when Kite restarts. Send again to bring one back.
- Nothing you send runs, loads from the internet, or leaves the computer. Kite draws it from the fields above, in its own look.

## How it behaves

The Kite bar keeps one queue for Kite's own things and every integration's. One thing shows at a time; what's waiting sits beside it as chips (click one to bring it forward). Codes, meetings and `high` activities step in front; a quick reply being written is never covered. Long-lived activities (a 15-minute deploy) take turns with whatever is waiting and come back. The user's **Quiet** setting makes everything arrive resting.

## Examples

`node scripts/bar-demo.mjs <token>` runs a pretend deploy: a progress bar updated in place, a Cancel button heard over the event stream, then a result with a link. Read it as the template for your own.

**Node** (18+, no packages):

```js
const KITE = "http://127.0.0.1:3100/api/bar";
const headers = { authorization: `Bearer ${process.env.KITE_BAR_TOKEN}`, "content-type": "application/json" };

await fetch(`${KITE}/activities`, {
  method: "POST",
  headers,
  body: JSON.stringify({ key: "tests", title: "Tests passed", icon: "check", tint: "success", value: { type: "text", text: "482 / 482" } }),
});
```

**Python** (standard library):

```python
import json, os, urllib.request

def bar(activity):
    req = urllib.request.Request(
        "http://127.0.0.1:3100/api/bar/activities",
        data=json.dumps(activity).encode(),
        headers={"Authorization": f"Bearer {os.environ['KITE_BAR_TOKEN']}", "Content-Type": "application/json"},
    )
    return json.load(urllib.request.urlopen(req))

bar({"key": "train", "title": "Training run", "icon": "chart", "value": {"type": "progress", "progress": 0.3, "label": "Epoch 3 of 10"}, "duration": 3600})
```
