export type AssistantBlockKind =
  | "paragraph"
  | "heading"
  | "list"
  | "blockquote"
  | "code"
  | "table"
  | "image"
  | "rule";

export interface AssistantMarkdownBlock {
  id: string;
  kind: AssistantBlockKind;
  markdown: string;
}

export interface MarkdownBlockInsertion {
  text: string;
  cursorOffset: number;
}

interface Fence {
  character: "`" | "~";
  length: number;
}

const isBlank = (line: string): boolean => /^[\t ]*$/.test(line);
const isAtxHeading = (line: string): boolean => /^ {0,3}#{1,6}(?:[\t ]+.*|[\t ]*)$/.test(line);
const isListItem = (line: string): boolean => /^ {0,3}(?:[*+-]|\d{1,9}[.)])[\t ]+/.test(line);
const isListContinuation = (line: string): boolean => /^(?: {2,}|\t)\S/.test(line);
const isBlockquote = (line: string): boolean => /^ {0,3}>/.test(line);

function openingFence(line: string): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!match) return null;
  const fence = match[1] as string;
  return { character: fence[0] as Fence["character"], length: fence.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`+|~+)[\t ]*$/.exec(line);
  return Boolean(
    match
      && match[1]?.[0] === fence.character
      && match[1].length >= fence.length,
  );
}

function isSetextUnderline(line: string): boolean {
  return /^ {0,3}(?:=+|-+)[\t ]*$/.test(line);
}

function isRule(line: string): boolean {
  const indentation = /^ */.exec(line)?.[0].length ?? 0;
  if (indentation > 3) return false;
  const body = line.slice(indentation);
  return /^(?:\*[\t ]*){3,}$/.test(body)
    || /^(?:_[\t ]*){3,}$/.test(body)
    || /^(?:-[\t ]*){3,}$/.test(body);
}

function isTableDelimiter(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  const body = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = body.split("|");
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell.trim()));
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index];
  const delimiter = lines[index + 1];
  return Boolean(
    header
      && delimiter
      && header.includes("|")
      && !isAtxHeading(header)
      && isTableDelimiter(delimiter),
  );
}

function isTableRow(line: string): boolean {
  return !isBlank(line)
    && line.includes("|")
    && !openingFence(line)
    && !isAtxHeading(line)
    && !isListItem(line)
    && !isBlockquote(line)
    && !isRule(line);
}

function isImage(line: string): boolean {
  const indentation = /^ */.exec(line)?.[0].length ?? 0;
  if (indentation > 3) return false;
  const value = line.trim();
  return /^!\[[^\]\n]*\]\(.*\)$/.test(value)
    || /^!\[[^\]\n]*\]\[[^\]\n]*\]$/.test(value)
    || /^!\[\[[^\]\n]+\]\]$/.test(value);
}

function isExplicitBlockStart(lines: string[], index: number): boolean {
  const line = lines[index];
  if (line === undefined || isBlank(line)) return false;
  return Boolean(
    openingFence(line)
      || isAtxHeading(line)
      || (lines[index + 1] !== undefined && isSetextUnderline(lines[index + 1] as string))
      || isTableStart(lines, index)
      || isListItem(line)
      || isBlockquote(line)
      || isImage(line)
      || isRule(line),
  );
}

function listEnd(lines: string[], start: number): number {
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index] as string;
    if (isListItem(line) || isListContinuation(line)) {
      index += 1;
      continue;
    }
    if (!isBlank(line)) break;

    let next = index;
    while (next < lines.length && isBlank(lines[next] as string)) next += 1;
    if (next >= lines.length) break;
    const nextLine = lines[next] as string;
    if (!isListItem(nextLine) && !isListContinuation(nextLine)) break;
    index = next;
  }
  return index;
}

function blockquoteEnd(lines: string[], start: number): number {
  let index = start + 1;
  while (index < lines.length) {
    if (isBlockquote(lines[index] as string)) {
      index += 1;
      continue;
    }
    if (!isBlank(lines[index] as string)) break;

    let next = index;
    while (next < lines.length && isBlank(lines[next] as string)) next += 1;
    if (next >= lines.length || !isBlockquote(lines[next] as string)) break;
    index = next;
  }
  return index;
}

export function splitAssistantMarkdownBlocks(
  messageId: string,
  source: string,
): AssistantMarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Array<Omit<AssistantMarkdownBlock, "id">> = [];
  let index = 0;

  // ponytail: deterministic grouping intentionally stops short of a CommonMark AST;
  // add a parser only if future editing semantics require full syntax fidelity.
  const add = (kind: AssistantBlockKind, start: number, end: number): void => {
    blocks.push({ kind, markdown: lines.slice(start, end).join("\n") });
  };

  while (index < lines.length) {
    while (index < lines.length && isBlank(lines[index] as string)) index += 1;
    if (index >= lines.length) break;

    const start = index;
    const line = lines[index] as string;
    const fence = openingFence(line);
    if (fence) {
      index += 1;
      while (index < lines.length) {
        const closed = closesFence(lines[index] as string, fence);
        index += 1;
        if (closed) break;
      }
      add("code", start, index);
      continue;
    }

    if (isAtxHeading(line)) {
      add("heading", start, ++index);
      continue;
    }

    if (lines[index + 1] !== undefined && isSetextUnderline(lines[index + 1] as string)) {
      index += 2;
      add("heading", start, index);
      continue;
    }

    if (isTableStart(lines, index)) {
      index += 2;
      while (index < lines.length && isTableRow(lines[index] as string)) index += 1;
      add("table", start, index);
      continue;
    }

    if (isListItem(line)) {
      index = listEnd(lines, index);
      add("list", start, index);
      continue;
    }

    if (isBlockquote(line)) {
      index = blockquoteEnd(lines, index);
      add("blockquote", start, index);
      continue;
    }

    if (isImage(line)) {
      index += 1;
      if (
        index < lines.length
        && !isBlank(lines[index] as string)
        && !isExplicitBlockStart(lines, index)
      ) index += 1;
      add("image", start, index);
      continue;
    }

    if (isRule(line)) {
      add("rule", start, ++index);
      continue;
    }

    index += 1;
    while (
      index < lines.length
      && !isBlank(lines[index] as string)
      && !isExplicitBlockStart(lines, index)
    ) index += 1;
    add("paragraph", start, index);
  }

  return blocks.map((block, blockIndex) => ({
    id: `${messageId}:${blockIndex}`,
    ...block,
  }));
}

function edgeLineBreakCount(value: string, edge: "start" | "end"): number {
  const run = edge === "start"
    ? /^(?:(?:\r\n|\n|\r))+/.exec(value)?.[0]
    : /(?:(?:\r\n|\n|\r))+$/.exec(value)?.[0];
  return run?.match(/\r\n|\n|\r/g)?.length ?? 0;
}

function normalizeInsertedBlock(markdown: string, newline: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && isBlank(lines[0] as string)) lines.shift();
  while (lines.length > 0 && isBlank(lines.at(-1) as string)) lines.pop();
  return lines.join(newline);
}

export function buildMarkdownBlockInsertion(
  documentText: string,
  offset: number,
  markdown: string,
): MarkdownBlockInsertion {
  if (!Number.isInteger(offset) || offset < 0 || offset > documentText.length) {
    throw new RangeError(`offset must be an integer between 0 and ${documentText.length}`);
  }

  const newline = documentText.match(/\r\n|\n/)?.[0] ?? "\n";
  const block = normalizeInsertedBlock(markdown, newline);
  if (!block) return { text: "", cursorOffset: offset };

  const before = documentText.slice(0, offset);
  const after = documentText.slice(offset);
  const prefix = before
    ? newline.repeat(Math.max(0, 2 - edgeLineBreakCount(before, "end")))
    : "";
  const suffix = after
    ? newline.repeat(Math.max(0, 2 - edgeLineBreakCount(after, "start")))
    : "";

  return {
    text: prefix + block + suffix,
    cursorOffset: offset + prefix.length + block.length,
  };
}
