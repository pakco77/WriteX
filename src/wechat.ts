import { extractThemeImageSources, stripThemeFrontmatter } from "./themeMarkdown.ts";

export function extractMarkdownImageSources(markdown: string): string[] {
  return extractThemeImageSources(markdown);
}

export function markdownToPlainText(markdown: string): string {
  return stripThemeFrontmatter(markdown)
    .replace(/!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "[图片：$1]")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}
