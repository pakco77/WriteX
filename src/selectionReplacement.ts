import { preserveSelectionWhitespace } from "./codex.ts";

export function cleanAssistantMarkdown(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

/** The comparison preview and the protected editor write must use these exact bytes. */
export function computeSelectionReplacement(original: string, markdown: string): string {
  const cleaned = cleanAssistantMarkdown(markdown);
  return original.trim() ? preserveSelectionWhitespace(original, cleaned) : cleaned;
}
