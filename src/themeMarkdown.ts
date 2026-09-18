export type InlineNode =
  | { kind: "text"; value: string }
  | { kind: "strong"; children: InlineNode[] }
  | { kind: "emphasis"; children: InlineNode[] }
  | { kind: "delete"; children: InlineNode[] }
  | { kind: "inlineCode"; value: string }
  | { kind: "link"; destination: string; children: InlineNode[] };

export type HeadingKind = "heading1" | "heading2" | "heading3" | "heading4" | "heading5" | "heading6";

export type ThemeMarkdownNode =
  | { kind: HeadingKind; inline: InlineNode[]; sourceText: string }
  | { kind: "paragraph"; inline: InlineNode[]; sourceText: string }
  | { kind: "blockquote"; children: ThemeMarkdownNode[] }
  | { kind: "calloutNote" | "calloutTip" | "calloutWarning"; title: string; children: ThemeMarkdownNode[] }
  | { kind: "quoteCard"; children: ThemeMarkdownNode[] }
  | { kind: "unorderedList" | "orderedList"; items: ThemeMarkdownNode[][] }
  | { kind: "codeBlock"; language: string; value: string }
  | { kind: "image"; source: string; alt: string }
  | { kind: "horizontalRule" }
  | { kind: "table"; header: InlineNode[][]; rows: InlineNode[][][] };

export function escapeThemeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function stripThemeFrontmatter(markdown: string): string {
  return markdown.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "");
}

export interface ThemeFrontmatter {
  title?: string;
  summary?: string;
}

function yamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
  return trimmed;
}

export function extractThemeFrontmatter(markdown: string): ThemeFrontmatter {
  const block = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)?.[1];
  if (!block) return {};
  // ponytail: article metadata only needs flat scalar keys; use a YAML parser if nested metadata becomes a theme contract.
  const values = new Map<string, string>();
  for (const line of block.split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (field && field[2] && !["|", ">"].includes(field[2])) values.set(field[1].toLowerCase(), yamlScalar(field[2]));
  }
  const title = values.get("title")?.trim();
  const summary = ["digest", "summary", "description", "excerpt"]
    .map(key => values.get(key)?.trim())
    .find(Boolean);
  return {
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
  };
}

function pushText(nodes: InlineNode[], value: string): void {
  if (!value) return;
  const previous = nodes.at(-1);
  if (previous?.kind === "text") previous.value += value;
  else nodes.push({ kind: "text", value });
}

export function parseInlineMarkdown(source: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    if (source.startsWith("**", cursor)) {
      const end = source.indexOf("**", cursor + 2);
      if (end > cursor + 2) {
        nodes.push({ kind: "strong", children: parseInlineMarkdown(source.slice(cursor + 2, end)) });
        cursor = end + 2;
        continue;
      }
    }
    if (source.startsWith("~~", cursor)) {
      const end = source.indexOf("~~", cursor + 2);
      if (end > cursor + 2) {
        nodes.push({ kind: "delete", children: parseInlineMarkdown(source.slice(cursor + 2, end)) });
        cursor = end + 2;
        continue;
      }
    }
    if (source[cursor] === "`") {
      const end = source.indexOf("`", cursor + 1);
      if (end > cursor + 1) {
        nodes.push({ kind: "inlineCode", value: source.slice(cursor + 1, end) });
        cursor = end + 1;
        continue;
      }
    }
    if (source[cursor] === "[") {
      const labelEnd = source.indexOf("](", cursor + 1);
      const destinationEnd = labelEnd === -1 ? -1 : source.indexOf(")", labelEnd + 2);
      if (labelEnd > cursor + 1 && destinationEnd > labelEnd + 2) {
        nodes.push({
          kind: "link",
          destination: source.slice(labelEnd + 2, destinationEnd),
          children: parseInlineMarkdown(source.slice(cursor + 1, labelEnd)),
        });
        cursor = destinationEnd + 1;
        continue;
      }
    }
    if ((source[cursor] === "*" || source[cursor] === "_") && source[cursor + 1] !== source[cursor]) {
      const marker = source[cursor];
      const end = source.indexOf(marker, cursor + 1);
      if (end > cursor + 1) {
        nodes.push({ kind: "emphasis", children: parseInlineMarkdown(source.slice(cursor + 1, end)) });
        cursor = end + 1;
        continue;
      }
    }
    pushText(nodes, source[cursor]);
    cursor += 1;
  }
  return nodes;
}

function parseImage(line: string): { source: string; alt: string } | undefined {
  const wiki = line.match(/^\s*!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]\s*$/);
  if (wiki) return { source: wiki[1].trim(), alt: (wiki[2] ?? "").trim() };
  const markdown = line.match(/^\s*!\[([^\]]*)\]\((.+)\)\s*$/);
  if (markdown) return { source: markdown[2].trim(), alt: markdown[1].trim() };
  return undefined;
}

function parseParagraphWithImages(sourceText: string): ThemeMarkdownNode[] {
  const pattern = /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|!\[([^\]]*)\]\(([^)\n]+)\)/g;
  const nodes: ThemeMarkdownNode[] = [];
  let cursor = 0;
  for (const match of sourceText.matchAll(pattern)) {
    const before = sourceText.slice(cursor, match.index).trim();
    if (before) nodes.push({ kind: "paragraph", sourceText: before, inline: parseInlineMarkdown(before) });
    nodes.push({
      kind: "image",
      source: (match[1] ?? match[4] ?? "").trim(),
      alt: (match[2] ?? match[3] ?? "").trim(),
    });
    cursor = (match.index ?? 0) + match[0].length;
  }
  if (!nodes.length) return [{ kind: "paragraph", sourceText, inline: parseInlineMarkdown(sourceText) }];
  const after = sourceText.slice(cursor).trim();
  if (after) nodes.push({ kind: "paragraph", sourceText: after, inline: parseInlineMarkdown(after) });
  return nodes;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map(cell => cell.trim());
}

function isTableDelimiter(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

interface ListLine {
  indent: number;
  ordered: boolean;
  content: string;
}

function matchListLine(line: string): ListLine | undefined {
  const match = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.+)$/);
  if (!match) return undefined;
  return { indent: match[1].replaceAll("\t", "  ").length, ordered: /^\d/.test(match[2]), content: match[3] };
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  return /^\s*```/.test(line)
    || Boolean(parseImage(line))
    || /^\s*#{1,6}\s+/.test(line)
    || /^\s*>/.test(line)
    || Boolean(matchListLine(line))
    || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)
    || (line.includes("|") && isTableDelimiter(lines[index + 1] ?? ""));
}

function parseBlocks(lines: string[]): ThemeMarkdownNode[] {
  // ponytail: This bounded line parser intentionally omits full CommonMark ambiguity; upgrade it only with corpus tests.
  const nodes: ThemeMarkdownNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```\s*([^\s`]*)\s*$/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      nodes.push({ kind: "codeBlock", language: fence[1] ?? "", value: code.join("\n") });
      continue;
    }

    const image = parseImage(line);
    if (image) {
      nodes.push({ kind: "image", ...image });
      index += 1;
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const sourceText = heading[2];
      nodes.push({
        kind: `heading${heading[1].length}` as HeadingKind,
        sourceText,
        inline: parseInlineMarkdown(sourceText),
      });
      index += 1;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      nodes.push({ kind: "horizontalRule" });
      index += 1;
      continue;
    }

    if (line.includes("|") && isTableDelimiter(lines[index + 1] ?? "")) {
      const header = splitTableRow(line).map(parseInlineMarkdown);
      const rows: InlineNode[][][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]).map(parseInlineMarkdown));
        index += 1;
      }
      nodes.push({ kind: "table", header, rows });
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const quote = lines[index].match(/^\s*>\s?(.*)$/);
        if (!quote) break;
        quoteLines.push(quote[1]);
        index += 1;
      }
      nodes.push(parseQuoteBlock(quoteLines));
      continue;
    }

    const firstList = matchListLine(line);
    if (firstList) {
      const kind = firstList.ordered ? "orderedList" : "unorderedList";
      const baseIndent = firstList.indent;
      const items: ThemeMarkdownNode[][] = [];
      let current: string[] | undefined;
      while (index < lines.length) {
        const matched = matchListLine(lines[index]);
        if (!matched) break;
        if (matched.indent < baseIndent) break;
        if (matched.indent === baseIndent) {
          if (matched.ordered !== firstList.ordered) break;
          if (current) items.push(parseBlocks(current));
          current = [matched.content];
        } else if (current) {
          current.push(lines[index].slice(Math.min(lines[index].length, baseIndent + 2)));
        }
        index += 1;
      }
      if (current) items.push(parseBlocks(current));
      nodes.push({ kind, items });
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    const sourceText = paragraphLines.join("\n");
    nodes.push(...parseParagraphWithImages(sourceText));
  }
  return nodes;
}

function parseQuoteBlock(quoteLines: string[]): ThemeMarkdownNode {
  const header = quoteLines[0]?.match(/^\[!([a-zA-Z]+)\]\s*(.*)$/) ?? null;
  const calloutKinds: Record<string, "calloutNote" | "calloutTip" | "calloutWarning"> = {
    note: "calloutNote",
    tip: "calloutTip",
    warning: "calloutWarning",
  };
  if (header) {
    const [, type, rest] = header;
    const calloutKind = calloutKinds[type.toLowerCase()];
    if (calloutKind) {
      const body = quoteLines.slice(1);
      return { kind: calloutKind, title: rest.trim(), children: parseBlocks(body.length ? body : [""]) };
    }
    if (type.toLowerCase() === "quote") {
      const body = rest.trim() ? [rest.trim(), ...quoteLines.slice(1)] : quoteLines.slice(1);
      return { kind: "quoteCard", children: parseBlocks(body.length ? body : [""]) };
    }
  }
  return { kind: "blockquote", children: parseBlocks(quoteLines) };
}

export function parseThemeMarkdown(markdown: string): ThemeMarkdownNode[] {
  return parseBlocks(stripThemeFrontmatter(markdown).replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n"));
}

export function extractThemeImageSources(markdown: string): string[] {
  const sources = new Set<string>();
  const visit = (nodes: ThemeMarkdownNode[]): void => {
    for (const node of nodes) {
      if (node.kind === "image") sources.add(node.source);
      else if (node.kind === "blockquote") visit(node.children);
      else if (node.kind === "unorderedList" || node.kind === "orderedList") node.items.forEach(visit);
    }
  };
  visit(parseThemeMarkdown(markdown));
  return [...sources];
}
