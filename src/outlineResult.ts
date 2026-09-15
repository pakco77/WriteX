export const OUTLINE_READY_MARKER = "[[WRITEX_OUTLINE_READY]]";
export const OUTLINE_NEEDS_INPUT_MARKER = "[[WRITEX_OUTLINE_NEEDS_INPUT]]";

/** Only an outline turn may consume a final protocol line; prose mentioning it stays intact. */
export function parseOutlineResult(text: string): { text: string; ready: boolean } {
  const lines = text.split("\n");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const markers: string[] = [];
  while (lines.length) {
    const last = lines[lines.length - 1].trim();
    if (last !== OUTLINE_READY_MARKER && last !== OUTLINE_NEEDS_INPUT_MARKER) break;
    markers.unshift(last);
    lines.pop();
  }
  if (markers.length !== 1) return { text, ready: false };
  return { text: lines.join("\n").trimEnd(), ready: markers[0] === OUTLINE_READY_MARKER };
}
