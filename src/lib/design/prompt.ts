import * as z from "zod";
import { Design, DESIGN_VERSION, allBlocks, assetId } from "./spec";

// The prompt kit: a starting prompt the user pastes into any AI, a tolerant parser for
// what comes back, and a fix prompt listing exactly what was wrong. The schema in the
// prompt is generated from the zod spec, so the prompt always matches what Kite accepts.

export type DesignAsset = {
  id: string;
  name: string;
  width: number;
  height: number;
  contentType: string;
  bytes: number;
  /** Kept out of design image lists and prompts (a Fill & sign signature). */
  private?: boolean;
};

export type DesignKind = "signature" | "email";

const KIND_RULES: Record<DesignKind, string[]> = {
  signature: [
    "This is an email signature: it sits under every message, so keep it compact (usually 2 to 8 blocks).",
    "Typical content: name, role, company, phone, website, a logo or photo, maybe one button.",
    "Use \"sm\" text for secondary details. Avoid headings larger than level 2.",
  ],
  email: [
    "This is the body of one designed email (a newsletter, announcement or invitation). The sender's signature is added below it separately, so don't include one.",
    "Lead with the message: a clear heading, short paragraphs, at most one or two buttons.",
    "Keep it under 600px wide and readable with images off: important words go in text, not in images.",
  ],
};

const CATALOGUE = `Blocks (the "type" field picks one):
- text: { "type": "text", "text": "…", "size": "sm"|"md"|"lg", "color"?: "#rrggbb", "align"?: "left"|"center"|"right", "bold"?: boolean, "caps"?: boolean (a small-capitals label in the accent colour, e.g. "FOUNDER · COMPANY") }
  Inline markup inside "text" only: **bold**, *italic*, [label](https://…), [label](mailto:…), [label](tel:…), and \\n for line breaks. No HTML.
- heading: { "type": "heading", "text": "…", "level": 1|2|3, "color"?, "align"? }
- image: { "type": "image", "src": "asset:<id>" or "https://…", "alt": "required description", "width": px (16–600), "href"?: link, "radius"?: px, "align"? }
- button: { "type": "button", "label": "…", "href": "https://…", "color"?: background, "textColor"?, "align"? }
- divider: { "type": "divider", "color"? }
- spacer: { "type": "spacer", "height": px (4–80) }
- columns: { "type": "columns", "columns": [ { "width"?: percent, "blocks": [ …any block except columns… ] }, … ] (2 or 3 columns), "gap"?: px, "valign"?: "top"|"middle"|"bottom", "rule"?: "#rrggbb" (a thin vertical line between the columns) }

Document: { "version": "${DESIGN_VERSION}", "theme": { "font": "sans"|"serif", "text": "#rrggbb", "muted": "#rrggbb", "accent": "#rrggbb" }, "blocks": [ … ], "text"?: "plain-text version (optional, generated if omitted)" }`;

const RULES = [
  "Reply with ONE JSON object and nothing else: no explanation, no code fences.",
  "It is compiled to email-safe HTML that must work in Gmail, Outlook and Apple Mail, so the blocks listed under Format are the only building blocks. Don't invent fields.",
  "Colours are 6-digit hex. Make sure text has strong contrast on a white background.",
  "Every image needs meaningful alt text: it's what people see when images are blocked.",
  "Outlook on Windows shows only the first frame of an animated GIF, so the design must still make sense with a still image.",
  "Prefer a calm, professional design with one accent colour.",
];

/** The prompt the user copies into their own AI. */
export function designPrompt({
  kind,
  request,
  current,
  assets,
  sender,
}: {
  kind: DesignKind;
  request: string;
  current?: Design | null;
  assets: DesignAsset[];
  sender?: { name: string; email: string };
}) {
  const schema = JSON.stringify(z.toJSONSchema(Design, { io: "input" }));
  const images = assets.length
    ? assets.map((a) => `- asset:${a.id} — ${a.name}, ${a.width}×${a.height}px${a.contentType === "image/gif" ? ", animated GIF" : ""}`).join("\n")
    : "None uploaded. Only use an https:// image address if I give you one; otherwise design without images.";

  return [
    `You're designing an email ${kind} for Kite, an email client. Kite accepts designs as JSON in its own format (${DESIGN_VERSION}), described below.`,
    "",
    "## What I want",
    request.trim() || "(describe it here)",
    sender ? `\nThis is for ${sender.name} <${sender.email}>.` : "",
    "",
    "## Rules",
    ...[...KIND_RULES[kind], ...RULES].map((r) => `- ${r}`),
    "",
    "## Images you can use",
    images,
    "",
    "## Format",
    CATALOGUE,
    ...(current ? ["", "## Current design (edit this rather than starting over, unless I ask for something new)", JSON.stringify(current)] : []),
    "",
    "## JSON Schema (authoritative)",
    schema,
  ]
    .filter((line) => line !== "")
    .join("\n")
    .replace(/\n## /g, "\n\n## ");
}

type ParseResult = { ok: true; design: Design } | { ok: false; errors: string[] };

function formatPath(path: PropertyKey[]) {
  return path.reduce<string>((out, key) => (typeof key === "number" ? `${out}[${key}]` : out ? `${out}.${String(key)}` : String(key)), "");
}

/** Reads a design out of whatever the AI replied: code fences and chatter around the JSON are fine. */
export function parseDesign(raw: string, knownAssets: string[]): ParseResult {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, errors: ["The reply doesn't contain a JSON object."] };

  let json: unknown;
  try {
    json = JSON.parse(body.slice(start, end + 1));
  } catch (error) {
    return { ok: false, errors: [`The JSON doesn't parse: ${error instanceof Error ? error.message : "syntax error"}.`] };
  }

  const parsed = Design.safeParse(json);
  if (!parsed.success) {
    const errors = parsed.error.issues.slice(0, 12).map((issue) => {
      const path = formatPath(issue.path);
      const message = /received undefined/.test(issue.message)
        ? "is required"
        : /expected string to have >=1 characters/.test(issue.message)
          ? "can't be empty"
          : issue.message;
      return path ? `${path}: ${message}` : message;
    });
    return { ok: false, errors };
  }

  const unknown = allBlocks(parsed.data)
    .flatMap((b) => (b.type === "image" ? [assetId(b.src)] : []))
    .filter((id): id is string => !!id && !knownAssets.includes(id));
  if (unknown.length) {
    return { ok: false, errors: unknown.map((id) => `asset:${id} isn't one of the available images. Use one from the list, or an https:// address.`) };
  }
  return { ok: true, design: parsed.data };
}

/** What to paste back into the same AI conversation when a design didn't validate. */
export function fixPrompt(errors: string[]) {
  return [
    "Kite couldn't use that design. Fix these problems and reply with the whole corrected JSON object only (no explanation, no code fences):",
    ...errors.map((e) => `- ${e}`),
  ].join("\n");
}
