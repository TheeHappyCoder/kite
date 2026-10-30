# Kite roadmap

Only what isn't built yet. What exists is in the code and CLAUDE.md; finished work is removed from this file, not ticked. Everything works without AI first, with typed data and named actions an AI can drive later. Audited against the code 2026-10-14.

## Top: chores people still do by hand (research 2026-10-26)

From Reddit (r/Bookkeeping, r/freelance, r/smallbusiness, r/jobs, r/Parenting, r/Outlook) and HN: email announces a change, then a person copies it somewhere or remembers to act later. Built: Expect (waits, nudge ladders, Waiting on's checklist), mail you send and schedules as triggers, the month-end pack, one row per thing, wait before acting, Send separately, and their starters. Still missing:

- **Send separately with each person's own file:** 200 clients, each with their own PDF invoice (match a file to a person by name or a column)
- **Portal invoices:** Kite can't log in to a supplier's portal; the pack lists those links. A one-click "open all links" or a reminder list is the next step
- **A nudge is ready:** no notification yet (Waiting on's count and the conversation back in the inbox only); a `shouldNotify` kind for it, and a line in the Kite bar
- **Job replies through hiring systems:** replies from greenhouse.io / lever.co name the system, not the company; read the company from the subject or the sender's name there
- **Expect on more answers:** a payment in a bank notification (amount and reference match) as the answer to an invoice you sent; "Paid" from a collection row
- **Not tried on a real mailbox yet:** schedules over a month, auto nudges on Gmail over IMAP and Outlook, mail you send from a phone starting a wait (sync sees it as new), Send separately on the Gmail API

## Order

1. **Features:** the top section above, then Automations' gaps (below) once Mark has used them on his own mail, the gaps below that matter day to day, Designed mail 3, Calendar later items as wanted
2. **Reach:** real IMAP accounts, then the browser extension and the MCP server
3. **Desktop release:** start on login, OAuth deep links, OAuth client as build config, auto-update and signing
4. **Public release:** Gmail over IMAP with an app-password walkthrough (no CASA), Google verification for calendar and contacts, tests, error reporting, big-mailbox test, landing page

## Bugs and gaps from live tests

- Outlook attachment sizes are Graph's item size, not the file's (3.2 KB shown for a 3,000-byte file): Graph lists no file length, so the exact size needs the bytes (correct it once a file is opened, and keep it through refreshes)
- The mail calendar reads an IMAP invite only once its conversation's bodies are stored (prefetch: the newest 60 Inbox conversations); older invites wait until opened
- IMAP: untrash or unspam of mail from one of the user's folders lands in the Inbox (IMAP keeps no note of the folder it came from)
- An Outlook category named like a built-in mailbox ("INBOX") is ignored
- Outlook mail deleted for good is only noticed when its conversation is read again
- Not tested live yet: making, renaming and deleting labels in the Gmail API and Outlook (Graph has no local test server; Outlook accounts need Reconnect for `MailboxSettings.ReadWrite`); Disconnect Google on a Gmail-over-IMAP account (revoking ends Kite's whole grant for that Google account, so a Gmail API sign-in of the same address elsewhere needs Reconnect), an Outlook folder move with Undo (needs a user folder), the real-data Calendar view on screen, iCloud / Yahoo / Fastmail / cPanel IMAP accounts and IMAP invites

## Automations

Built: When → Read → Check → Do, collections with month totals and coming up, the starter gallery, Bring it back on a date, Kite-only calendar events, Undo for all of it.

- **Read:** a value that sits in different places across one sender's emails (several kinds of email from one bank) needs one automation per kind today; categories for a text column ("Woolworths" -> Groceries)
- **More triggers:** when a collection's date is near ("3 days before due"), and a manual Run from the reader on one email
- **More steps:** forward, export to a file or webhook, a Kite bar activity (outward steps marked and off until switched on)
- **Collections:** correct a row's value, budgets and goals on an amount column, income vs spending on one list
- **Describe an automation:** server/rule-design.ts writes When (new or sent mail), Do and expect; teach it Read, Check, schedules and the pack
- **Read on existing mail:** uses the body Kite has, else the preview; offer to download bodies for a better first fill

## Home and the inbox tabs

- **Gmail over IMAP tabs:** `category:primary` wins, so with Gmail's Updates tab turned off its mail stays in Primary and Home's Updates is empty; offer to show Gmail's own Updates anyway
- **To reply:** company words in names (`NOT_A_PERSON` in lib/replies.ts) are English only; a "Not for me" from a known person only drops that conversation
- **Lines:** the Updates tab and Home show only an amount an automation collected; a date or tracking link would help too
- **Home:** j / k over its own rows (they move through the inbox order today); reading-time estimates on the To read shelf
- **Perf:** run `pnpm perf:check` on the inbox list now that it carries collected amounts (`withAmounts`)

## Mail client

- **Compose in three sizes:** the quick reply (inline), the floating window, and a new **full** size: the same window filling the area beside the sidebar (text column ~760 px, sky around it), so a draft never remounts when it changes size. Switch with a maximise button in the title bar, a double-click on it, a shortcut (`Mod+Shift+F` is free) and Escape back; new composers open in the size used last (localStorage `kite-compose-mode`, a "Open new messages as" setting later). Fix first: quick-reply text is lost when you switch conversations (keep it per conversation in mail-app); expanding drops the signature choice and the prepared-reply note (hand over a whole ComposeDraft); expanding waits on `/api/mail/compose` (open from the local `replyDraft`, fill recipients when it answers). Later: the quick reply as a real autosaved draft (so a full reply can fold back into it), a full reply beside the conversation (thread left, reply right), the sky held still while writing, a desktop pop-out window only if asked (its own webview, drafts synced through the drafts API)
- **Read receipts:** ask for one when sending (Disposition-Notification-To; Outlook's isReadReceiptRequested), show "Read by … at …" when one returns (multipart/report disposition-notification; Outlook's by subject), answer others' requests only on the user's click
- **Code Fill by shortcut:** a global shortcut that types the newest code where the cursor is (today Fill is the Kite bar's button)
- **Translate:** names in a sign-off sometimes get translated ("Ria" -> "Mary"): keep the signature-like last lines as written; Firefox now ships newer models (3.x) and engine (4.x, zstd) than Kite uses (2.x / 3.0): move up when Mozilla's public bucket offers them; translate the subject line too; translate replies you write (into their language)

- **Codes:** a list of recent codes in the app (today only the code bar, desktop toasts and tray show them)
- **Search:** `from:` / `to:` suggestions for people only in mail Kite hasn't stored; OCR for scanned documents; old binary `.doc` extraction
- **Spaces:** notes and contacts kept in a space, fold Collections into spaces (a collection as a table inside one), an optional mirror as a label / folder at the provider
- **Threads:** split from the chat view; merge suggestions (same subject, different provider threads); follow-up nudges per split part (both halves show them today); "Mute and archive"
- **Reply tracking:** read List-Id (lists without List-Unsubscribe count as people today); match the account's aliases as "you"
- **People:** reply times by hour of day; the panel remembering it was open
- **Home's day:** mark a bill paid or a delivery received (a record status); items overdue more than a day
- **Notifications:** held batches in a server-side queue (today the open window holds them); new-mail toasts from the desktop shell; a VIP-only filter or tab (`is:vip`)
- **Labels:** pick label colours in Kite; rename an Outlook category (Graph can't: make one, move the mail, delete the old); delete a folder that still holds mail (move it out first today); a deleted Outlook category stays on mail Kite hasn't stored
- **Sidebar:** drag to reorder accounts (drives `Alt+1`–`Alt+9`)
- **Attachments:** Range requests so long videos seek; search inside PDFs and documents (local text extraction); a total size cap for the attachment cache (today: 25 MB per file, 30-day sweep); scale wide fixed-width emails to fit
- **Cleanup:** message sizes (only file sizes are stored, so the Files column leaves out bodies); "Archive future mail" for several ticked senders at once; the queue's Undo lasts while the toast does (the server keeps it 10 minutes)
- **Privacy:** clean links in plain-text bodies and chat bubbles; tracker count in list rows (maybe); verified-sender results for mail stored before they existed (refetch headers once); Windows Hello instead of the PIN in the desktop app

## Calendar

- Invites: old Gmail mail whose invite is a nameless text/calendar part shows no card until refetched; Outlook without calendar permission can't answer by email; Gmail aliases aren't matched as "you"; answering one occurrence answers the series when Google has no exception for it; COUNTER (proposed new time) shows as a plain event
- Events: calendars other than Google's primary; reminders and guests in "Add to calendar"; delete an event Kite added to a provider's calendar; Outlook all-day events read from the date part of their start (check across zones)
- Mail calendar: `.ics` files sent as METHOD:PUBLISH (bookings, tickets) aren't added (an "Add to calendar" button on them would be the user-driven way); rules with BYYEARDAY / BYWEEKNO / BYHOUR show only the first occurrence; events added in Kite can be removed but not edited; not tested live on iCloud / Fastmail / Outlook.com-over-IMAP invites or a Reset local copy rebuild
- Later: propose a new time from the invite card; send invites from compose (`.ics`, `METHOD:REQUEST`); an `rsvp` rule verb (user rules only); free/busy as a snippet variable; CalDAV events for IMAP accounts; AI only when asked ("Summarise my day", "Draft a reply with times I'm free")

## Rules and AI

- **Rules:** drag to reorder (arrows today); search hints in the rule's search field; "Run on existing mail" beyond 30 days / 500 conversations; body-text rules fetch bodies for every conversation whose other terms match
- **Prepare reply:** a sign in the message list that a reply is waiting; keep edits to the prepared text; prepared replies in demo mode; reply to the rule's `messageId`, not the latest message
- **Also run in Gmail:** a filter removed in Gmail, failed or waiting for a missing label is only retried when the rule is saved (retry on sync, and when the label appears); `from:` matches part of an address in Kite, whole words in Gmail
- **AI:** list prices to prefill for models other than Claude's (DeepSeek, OpenAI) and a model list read from the provider; keep summaries after a reload; calls to OpenAI-compatible providers that report no token usage count nothing in the usage ledger or against limits (count the estimate instead); Settings → AI shows this month only (no history by day or month); say in Activity when an AI draft was dropped after three failures; "Describe a rule" picking accounts and any snooze time

## Files and forms

- **Fill & sign:** rotated pages; pdf.js extras for unusual PDFs (standard fonts, CJK cmaps, JPEG 2000 wasm); non-Latin text in the saved copy (embed a font); typed signature and initials; a Fill & sign button on PDF chips and a shortcut
- **Sign like last time:** "Why isn't last time's layout offered?"; rename a remembered form; friendlier labels than raw field names from the printed text
- **Profile autofill:** split date and comb boxes; nameless fields (`Text7`) matched by their printed label; section headings as context ("Next of kin" then "Name:"); title, gender and work address; Yes/No ticks only when clearly confident
- **Later, AI layer:** scanned forms (local text recognition or BYO AI), only when asked

## Designed mail

- **Editor and templates:** brand colours as swatches; rename or update a template (today: save new, delete); "New message from template" in the palette; Settings → Templates refreshes after a save from compose; custom fonts beyond sans / serif / mono; higher limits than 40 blocks / 2,000 characters per text block; designed quick reply in the chat view
- **3. Paste HTML import** with a per-client compatibility check and fixes; a size budget (Gmail clips at 102 KB); Promotions-tab warning for image-heavy personal mail
- **4. Kite-to-Kite mail:** an extra MIME alternative carrying the design JSON, rendered by Kite's own components (motion, dark mode, widgets: polls, RSVP, checklists, galleries, countdowns); data, never code; only for authenticated senders you've allowed; responses as structured replies
- **5. AI generation** through BYO AI with the same schema (today a copy-paste prompt kit), when asked

## Reach

- **IMAP:** OAuth for Yahoo / AOL / Zoho instead of app passwords; push for folders other than INBOX (20 s tick today); keywords before they're on stored mail (IMAP has no keyword list); stable ids for messages without a Message-ID when moved
- **Browser extension** (optional): fills sign-in codes (server/codes.ts) into `autocomplete="one-time-code"` fields and opens magic links; native messaging or a paired localhost port; fill only when the page's domain matches the sender's, never submit; Chrome, Edge, Firefox
- **MCP server:** plan in [docs/mcp-plan.md](docs/mcp-plan.md), waiting for approval: read tools on the local store, changes and drafts only as proposals approved in Kite, every call logged, off by default
- Microsoft 365 tenants may need admin consent until Kite is publisher-verified

## Narrow windows

- Not checked on a real phone or touch screen yet; swipe back from the reader; Calendar's week grid and the Fill & sign editor at phone width; the People panel beside a narrow reader

## Desktop release

- Start on login; deep links for OAuth (the release build uses the fixed 127.0.0.1:3100 redirect)
- The OAuth client comes from `.env.local` at build time; move it to build config
- "Open link" for magic links in the in-app code popup
- The secrets key in the Windows Credential Manager (today sealed with DPAPI)
- Auto-update; code signing
- Verify on the release build that sync, scheduled sends and nudges keep running while the window is hidden

## Before public release

- **Big-mailbox test:** a `pnpm perf` scenario on generated data with 1,000+ inbox conversations (j/k, search, load) kept as a budget; virtual scrolling if it slows down
- **Gmail without CASA:** public users sign in to Gmail over IMAP + SMTP with an app password; the Gmail API provider stays as is for Mark's own test users (up to 100 in Testing, sign-ins expire after 7 days), no CASA. Needs:
  - **Gmail mode, rest:** a nested label (`label:Work/Clients`; none on the test account), Gmail's "When I mark a message in IMAP as deleted" / expunge settings, the Workspace refusals (IMAP off by the admin, app passwords off) seen live
- Google OAuth verification for the sensitive scopes above (calendar, contacts); justify the contacts scopes and enable the People API (off in the current project too: contact photo lookups get 403)
- Tests (IMAP, Gmail mode, rules, sending and scheduling are covered, `pnpm test`): the Gmail API and Outlook providers (incl. history and delta edge cases), AI drafts and Describe an automation (with a stub provider)
- Error reporting that never includes email content; crash-safe schema migrations (a transaction and a version, or a backup first)
- Landing page, privacy policy, pricing (one-time purchase)

## Low priority

- Perf drift vs the Oct 12 baseline (real list ~1.3–1.6 s vs 678 ms; timing budgets also fail on the old code while dev servers run): bisect with `quick.mjs` between ce1766d and 4050d65 on a quiet machine, then refresh perf/baseline.json
- Skip the full list reload after Kite's own changes (keep unread counts right); a slimmer list payload (~780 KB)
- Gmail push (`users.watch` + Pub/Sub pull) if the 5 s history check ever isn't enough; needs a Google Cloud project Kite owns

## Decided against

A local image proxy (the sender still sees the same IP); local-only drafts (the provider holds them); whole-database encryption (node:sqlite has none; BitLocker covers a stolen disk); unwrapping click trackers that hide their target (would need a request); extending BYO AI beyond the named actions until asked
