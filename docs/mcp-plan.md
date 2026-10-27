# MCP server: plan (not built yet)

Outside AI tools (Claude Desktop, Claude Code, Cursor, ChatGPT desktop) get read access to Kite's mail, trackers and Today, and can **propose** changes and drafts. The user approves proposals in Kite. Nothing is sent and nothing changes by itself.

## How the principles apply

| Principle | What it means for MCP |
|---|---|
| AI runs only when the user asks | Kite never calls the AI tool. The tool calls Kite only when the user asks it something there. Off by default. One switch turns every connection off. |
| The AI sees only what the action is about | Small, narrow tools: a search returns at most 25 list rows (name, address, subject, date, preview), never bodies. A body is returned only for one conversation the tool names by id, as fresh text with quotes and signatures folded (quotes.ts). Per connection: which accounts it can see, and labels / folders it never sees (default: none hidden). Never exposed: sign-in codes and magic links (Codes tracker, code events), private notes, the Fill & sign profile, AI settings, secrets, muted and blocked senders' mail (opt-in). |
| Everything is logged | Each call goes through `logSent("mcp", <connection name>, <tool>, <how many conversations / records>)`, so it shows in Settings → Privacy. A connection's page lists its recent calls ("Read 1 conversation: Invoice INV-2041"). Ids and counts only, never content. |
| Nothing happens by itself | Read tools return data. Write tools create a **proposal** (archive these 12, label as Receipts, snooze to Monday, add a tracker record, save this draft). It shows in Kite as a card ("Claude Desktop suggests…": Approve / Decline, with the list). Approving runs it through the normal ops (`runOps` / `runLabelChange`), so Undo and Activity work. A draft is saved as a draft at most, never sent. There's no send tool. |
| Local-first, private | The server runs inside Kite on 127.0.0.1, so mail never leaves the computer except to the AI tool the user connected (and whatever that tool does with it, stated in one plain line at setup). |
| Rules engine owns automation | MCP can't create rules or change settings. A suggested rule is a proposal that opens the rule editor prefilled (like "Describe a rule"). |

Prompt injection is the main risk: email text written by strangers reaches an AI that can call tools. Proposals needing a click in Kite are the defence, and tool descriptions say that email content is third-party data, not instructions.

## Shape

- **Transport:** Streamable HTTP at `POST /api/mcp`, stateless, via `@modelcontextprotocol/sdk` (web-standard transport in a Node route handler). For stdio-only clients, a tiny shim (`kite-mcp` in the desktop bundle, `node scripts/kite-mcp.mjs` in dev) forwards stdio to that URL with the token.
- **Auth:** Settings → Connections → "Connect an AI tool": a name ("Claude Desktop"), what it can see, and a token shown once with copy-paste config snippets for the common clients. Token hashed at rest (`mcp_connections`: id, name, token hash, scope JSON, created, last used, paused). Revoke = delete row. The route is exempt from `rejectCrossSite` (no browser Origin), so it **rejects any request with an Origin header** and requires `Authorization: Bearer`. The proxy's localhost host check still applies.
- **Limits:** results per call (25 rows, 1 conversation body, 50 tracker records), a per-connection daily cap on conversations read (default 200, editable), answered plainly when hit.

## Tools (v1)

Read:
- `search_mail(query, account?, limit?)`: Kite search syntax over the local store. Returns list rows.
- `get_conversation(id)`: one conversation's messages (fresh text, attachment names and sizes, labels, dates). No file bytes.
- `list_labels()`, `list_trackers()`, `get_tracker_records(tracker, since?, limit?)`, `get_today(days?)`.
- `get_person(email)`: conversation count, last contact, VIP flag. Never the private note.

Propose (each returns "Waiting for approval in Kite" plus a proposal id; `get_proposal(id)` reports approved / declined / pending):
- `propose_changes(ids, op)`: archive, trash, star, mark read / unread, label / folder, snooze until.
- `propose_draft(reply_to? | to, subject, body)`: markup body. On approve it's saved as a draft at the provider and opens in compose. Never sent.
- `propose_tracker_record(tracker, values, source_message?)`: checked against the tracker spec (zod).

## Build order

1. `mcp_connections` table, token handling, Settings → Connections (create, scope, pause, revoke, recent calls), the `mcp` log kind.
2. `/api/mcp` with read tools on the local store (demo data works as well), plus the stdio shim. Test with Claude Code and MCP Inspector.
3. Proposals: a `mcp_proposals` table, a card in the app (SSE `proposal` event; notification through `shouldNotify` with a new `proposal` type), then approve / decline through the existing ops with Undo.
4. Desktop bundle: ship the shim and add the config snippet for Claude Desktop.
5. Docs in CLAUDE.md (route, tables, the "MCP sees only…" rule) and the ROADMAP.

## Open questions for Mark

1. Should approving be allowed per connection for low-risk changes (star, mark read, label: all undoable)? My recommendation is no for v1, so every change takes a click.
2. Should trackers' sign-in codes be fully hidden (recommended), or offered behind a separate per-connection tick?
3. Should there be a stdio shim at all, or only HTTP? Claude Desktop's local config still wants stdio, so I'd keep the shim; it's about 40 lines.
