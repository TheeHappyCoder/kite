import "server-only";

import type { MailLabel } from "@/lib/mail/providers";
import type { SearchTerm } from "@/lib/mail/search";
import type { GraphMessage } from "./convert";
import type { Folders } from "./folders";

// Kite's search terms on Outlook: what KQL can say goes into Graph's $search (from, to, subject,
// attachment names, dates, words, categories); what it can't (unread, starred, which folder) is
// checked on the results, which carry those fields.

const day = (iso: string) => iso.slice(0, 10);
const spelled = (name: string) => name.toLowerCase().replace(/[\s/-]+/g, "-");
const quoted = (value: string) => (/[\s:()"]/.test(value) ? `"${value.replace(/"/g, "")}"` : value);

/** The account's labels a `label:` value names (Gmail's spelling: "-" for spaces and "/"). */
const named = (labels: MailLabel[], value: string) => labels.filter((l) => spelled(l.name) === spelled(value));

function kqlTerm(t: SearchTerm, labels: MailLabel[]): string | null {
  const v = t.value;
  switch (t.field) {
    case "any": {
      // Every side has to be sayable in KQL, or the whole OR is left to the results.
      const sides = (t.any ?? []).map((s) => {
        const k = kqlTerm(s, labels);
        return k && s.negate ? `NOT ${k}` : k;
      });
      return sides.length && sides.every(Boolean) ? `(${sides.join(" OR ")})` : null;
    }
    case "text":
      return t.phrase ? `"${v.replace(/"/g, "")}"` : quoted(v);
    case "from":
    case "to":
    case "subject":
      return `${t.field}:${quoted(v)}`;
    case "filename":
      return `attachment:${quoted(v)}`;
    case "has":
      return "hasattachments:true";
    case "before":
      return `received<${day(v)}`;
    case "after":
      return `received>=${day(v)}`;
    case "label": {
      // A category is searchable; a folder isn't (it's checked on the results).
      const found = named(labels, v);
      return found.length === 1 && found[0].kind === "tag" ? `category:${quoted(found[0].name)}` : null;
    }
    default:
      return null;
  }
}

/** The $search value (already quoted for the URL's OData string), or null when only filters are left. */
export function toKql(terms: SearchTerm[], labels: MailLabel[]) {
  const parts = terms.flatMap((t) => {
    const k = kqlTerm(t, labels);
    return k ? [t.negate ? `NOT ${k}` : k] : [];
  });
  if (!parts.length) return null;
  return `"${parts.join(" AND ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Whether a result passes the terms KQL can't express (is:, in:, label:). */
export function matchesRest(terms: SearchTerm[], m: GraphMessage, f: Folders, labels: MailLabel[]) {
  const folder = m.parentFolderId ?? "";
  const inFolder = (name: keyof Folders["ids"]) => !!f.ids[name] && folder === f.ids[name];
  const scoped = terms.some((t) => t.field === "in" && !t.negate);
  // Like Gmail, spam and trash are left out unless asked for.
  if (!scoped && (inFolder("junkemail") || inFolder("deleteditems"))) return false;
  return terms.every((t) => {
    let hit: boolean;
    switch (t.field) {
      case "is":
        hit =
          t.value === "unread" ? m.isRead === false : t.value === "read" ? m.isRead !== false : t.value === "starred" ? m.flag?.flagStatus === "flagged" : true;
        break;
      case "in":
        hit =
          t.value === "anywhere" ||
          (t.value === "inbox" && inFolder("inbox")) ||
          (t.value === "sent" && inFolder("sentitems")) ||
          (t.value === "drafts" && inFolder("drafts")) ||
          (t.value === "trash" && inFolder("deleteditems")) ||
          (t.value === "spam" && inFolder("junkemail")) ||
          (t.value === "archive" && !["inbox", "sentitems", "drafts", "deleteditems", "junkemail"].some((n) => inFolder(n as keyof Folders["ids"])));
        break;
      case "label":
        // In the folder, or carrying the category.
        hit = named(labels, t.value).some((l) => (l.kind === "folder" ? l.id === folder : (m.categories ?? []).includes(l.id)));
        break;
      default:
        return true;
    }
    return t.negate ? !hit : hit;
  });
}
