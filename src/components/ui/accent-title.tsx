/**
 * A heading in Kite's voice: the interface font, with its last word in the italic serif
 * ("All *inboxes*"). One word only, so it reads as an accent rather than a second typeface.
 */
export function AccentTitle({ text }: { text: string }) {
  const at = text.trimEnd().lastIndexOf(" ");
  const head = at > 0 ? text.slice(0, at + 1) : "";
  const last = at > 0 ? text.slice(at + 1) : text;
  return (
    <>
      {head}
      {/* The serif sits optically small beside the sans: a touch larger, on the same baseline. */}
      <span className="font-accent text-[1.12em] leading-none">{last}</span>
    </>
  );
}
