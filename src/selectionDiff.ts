export type DiffPart = { kind: "same" | "added" | "removed"; text: string };

export function buildBoundedTextDiff(original: string, suggestion: string, budget = 8_000): { parts: DiffPart[]; truncated: boolean } {
  const before = Array.from(original);
  const after = Array.from(suggestion);
  if (before.length + after.length > budget) return { parts: [], truncated: true };
  const table = Array.from({ length: before.length + 1 }, () => new Uint16Array(after.length + 1));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i]![j] = before[i] === after[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const parts: DiffPart[] = [];
  const append = (kind: DiffPart["kind"], value: string) => {
    const last = parts.at(-1);
    if (last?.kind === kind) last.text += value;
    else parts.push({ kind, text: value });
  };
  for (let i = 0, j = 0; i < before.length || j < after.length;) {
    if (i < before.length && j < after.length && before[i] === after[j]) { append("same", before[i]!); i += 1; j += 1; }
    else if (j < after.length && (i === before.length || table[i]![j + 1]! >= table[i + 1]![j]!)) { append("added", after[j]!); j += 1; }
    else { append("removed", before[i]!); i += 1; }
  }
  return { parts, truncated: false };
}
