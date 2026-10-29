// Release notes as the tag's message writes them (release.yml puts it in latest.json), read into what
// the update dialog shows (components/desktop/update.tsx). Plain text, so a tag message stays easy to write:
//
//   One line under the version, said first.          <- intro
//   ## Show the email in Kite                        <- a feature: its own tab
//   media: https://…/show-email.webp                 <- optional picture or animated picture (https)
//   Right-click a file in Explorer…                  <- its text, paragraphs and "- " lists
//   ## …
// "- " lines before the first "## " are the smaller fixes: "Smaller things", the last tab.
//
// Notes with no "## " read as before: a list of changes.

export type NoteLine = { bullet: boolean; text: string };
export type ReleaseFeature = { title: string; media: string | null; lines: NoteLine[] };
export type ReleaseNotes = { intro: string[]; features: ReleaseFeature[]; polish: string[] };

const BULLET = /^[-*•]\s+/;

export function parseReleaseNotes(text: string | null): ReleaseNotes {
  const notes: ReleaseNotes = { intro: [], features: [], polish: [] };
  let feature: ReleaseFeature | null = null;
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      feature = { title: heading[1].trim(), media: null, lines: [] };
      notes.features.push(feature);
      continue;
    }
    const media = line.match(/^media:\s*(\S+)$/i);
    if (media && feature) {
      // https, or Kite's own address ("/…", the dev demo's stand-ins).
      if (/^https:\/\//i.test(media[1]) || /^\/(?!\/)/.test(media[1])) feature.media = media[1];
      continue;
    }
    const bullet = BULLET.test(line);
    const body = line.replace(BULLET, "");
    if (feature) feature.lines.push({ bullet, text: body });
    else if (bullet) notes.polish.push(body);
    else notes.intro.push(body);
  }
  return notes;
}
