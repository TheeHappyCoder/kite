# Kite privacy policy

Kite is an email client that runs on your computer. Your mail, contacts, notes and settings are stored in a local database on this computer. Kite has no servers of its own, no account with Kite, no analytics and no telemetry. The author never receives your mail or anything about how you use Kite.

Everything Kite sends anywhere other than your mail provider is listed in **Settings → Privacy** as it happens.

## What leaves your computer

**Services you choose**

- **Your mail provider** (Google, Microsoft, iCloud, Yahoo, your own IMAP server and so on): Kite reads and sends mail there, under that provider's own privacy policy.
- **Your AI provider**, only if you connect one: only the emails or text a named action is about (Summarise, Draft with AI, Rewrite, Describe an automation), and only when you click it. The one exception is an automation's "Draft with AI" with its "Allow AI" switch on, which sends a new email's fresh text to draft a reply. Under that provider's privacy policy.
- **Remote images in an email**: held until you load them (Settings → Privacy → Remote images).
- **Unsubscribe**: when you click Unsubscribe, Kite contacts the address or page the sender listed.

**Services Kite uses for you, each with a way to turn it off or avoid it**

| What | Sent to | What is sent | How to avoid it |
|---|---|---|---|
| Company logos for senders | Gravatar, DuckDuckGo site icons, the sender company's own logo address (BIMI) | A hashed email address or a company domain. Never personal addresses (Gmail, Outlook.com and the like) | Settings → Privacy → Company logos from the web |
| Contact photos | Google People API | Addresses of people in your mail | Off unless you switch it on in Settings → Accounts |
| Finding your mail servers at sign-in | Mozilla Thunderbird's autoconfig directory | Your email address's domain only | Enter your server settings yourself |
| Looking up domains when this computer's own DNS fails | Cloudflare DNS (DNS-over-HTTPS) | Domain names (mail servers, company logo records) | Settings → Privacy → Cloudflare DNS when this computer's fails |
| Translation | Mozilla (Firefox's translation models) | Nothing but the download request. The text you translate never leaves your computer | Each language downloads only after you say yes |
| Update checks (desktop app) | GitHub | A request for the latest version file | Settings → Privacy → Check for updates |

## Kite in Explorer (desktop app)

Off unless you switch it on (Settings → Files). Nothing leaves your computer for it, but it puts your mail's files where other programs on this computer can see them: the files' names are listed in Explorer and Windows Search, and files you open are kept in the Kite folder in your user profile. Switching it off, or Erase everything, removes that folder and everything in it.

Files there carry Windows' "came from the internet" note, the same one your browser adds to every download, so Windows warns before running anything and Office opens documents in Protected View. That note holds Kite's link to the attachment (account, message and part ids, never a name or any mail text). Programs, scripts, installers and shortcuts are never put in the folder.

Files you save from Kite get the same note from Windows. Copies of files outside the Kite folder keep it, and Disconnect and Erase everything can't reach them.

## Updates

The desktop app checks GitHub for a newer version shortly after it starts and every hour, unless Settings → Privacy → Check for updates is off. It installs one only when you click Update. Updates are verified against Kite's signing key before they install.

## Third-party privacy policies

Google: https://policies.google.com/privacy · Microsoft: https://privacy.microsoft.com · Gravatar: https://automattic.com/privacy/ · DuckDuckGo: https://duckduckgo.com/privacy · Cloudflare DNS: https://developers.cloudflare.com/1.1.1.1/privacy/public-dns-resolver/ · Mozilla: https://www.mozilla.org/privacy/ · GitHub: https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement

## Removing your data

Settings → Accounts → Disconnect removes everything stored for that account. Settings → Data → Erase everything removes all of Kite's data from this computer. To remove everything before uninstalling the desktop app, use Erase everything first.

Questions: https://github.com/TheeHappyCoder/kite/issues
