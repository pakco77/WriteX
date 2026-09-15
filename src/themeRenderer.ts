import {
  escapeThemeHtml,
  extractThemeFrontmatter,
  parseThemeMarkdown,
  parseInlineMarkdown,
  type ThemeFrontmatter,
  type InlineNode,
  type ThemeMarkdownNode,
} from "./themeMarkdown.ts";
import {
  validateThemePackage,
  type ThemeNodeKind,
  type WriteXThemePackage,
} from "./themeSchema.ts";

export interface ThemeRenderResult {
  html: string;
  themeId: string;
  themeVersion: string;
  imageSources: string[];
  nodeCount: number;
}

export class ThemeRenderError extends Error {
  readonly themeId: string;
  readonly nodeKind: string;
  readonly stage: "validation" | "mapping" | "resolver";

  constructor(
    message: string,
    themeId: string,
    nodeKind: string,
    stage: "validation" | "mapping" | "resolver",
  ) {
    super(message);
    this.name = "ThemeRenderError";
    this.themeId = themeId;
    this.nodeKind = nodeKind;
    this.stage = stage;
  }
}

interface RenderContext {
  theme: WriteXThemePackage;
  resolveImage: (source: string) => string;
  imageSources: string[];
  nodeCount: number;
  heading2Index: number;
}

function escapeScalar(value: string): string {
  return escapeThemeHtml(value).replace(/(\bon[a-z]+\s*)=/gi, "$1&#61;");
}

function safeImageUrl(value: string): string {
  const trimmed = value.trim();
  if (/^(?:https?:\/\/|app:|blob:|write-image:|data:image\/(?:png|jpe?g|gif|webp);base64,)/i.test(trimmed)) {
    return trimmed;
  }
  return "";
}

function safeLinkUrl(value: string): string {
  const trimmed = value.trim();
  if (/^(?:https?:\/\/|mailto:|tel:|#|\/)/i.test(trimmed)) return trimmed;
  return "";
}

function compressPlainCss(css: string): string {
  const compact = css.replace(/rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)/gi, (match, red, green, blue) => {
    const channels = [Number(red), Number(green), Number(blue)];
    if (channels.some(channel => channel > 255)) return match;
    const hex = channels.map(channel => channel.toString(16).padStart(2, "0")).join("");
    return `#${hex[0] === hex[1] && hex[2] === hex[3] && hex[4] === hex[5] ? `${hex[0]}${hex[2]}${hex[4]}` : hex}`;
  });
  return compact.replace(/\s+/g, (spaces, index) => {
    const before = compact[index - 1] ?? "";
    const after = compact[index + spaces.length] ?? "";
    // calc() needs spaces around binary +/-; quoted CSS is handled before this helper.
    return /[:;,]/.test(before) || /[:;,]/.test(after) ? "" : " ";
  });
}

function compressInlineCss(css: string): string {
  let result = "";
  let plain = "";
  let quote = "";
  let escaped = false;
  const flushPlain = () => { result += compressPlainCss(plain); plain = ""; };
  for (const character of css) {
    if (quote) {
      result += character;
      if (!escaped && character === quote) quote = "";
      escaped = !escaped && character === "\\";
      continue;
    }
    if (character === '"' || character === "'") {
      flushPlain();
      quote = character;
      result += character;
    } else {
      plain += character;
    }
  }
  flushPlain();
  return result.trim().replace(/;$/, "");
}

/** Keeps article text untouched; only trusted template style attributes are compacted. */
export function compressThemeHtml(html: string): string {
  return html.replace(/\sstyle=(['"])([\s\S]*?)\1/gi, (_match, quote: string, css: string) => ` style=${quote}${compressInlineCss(css)}${quote}`);
}

function component(
  context: RenderContext,
  kind: ThemeNodeKind,
  values: Partial<Record<"content" | "children" | "summary" | "index" | "language" | "src" | "alt" | "caption", string>>,
): string {
  const componentName = context.theme.mapping[kind];
  if (!componentName) {
    throw new ThemeRenderError(
      `排版 ${context.theme.manifest.name} 缺少 ${kind} 映射`,
      context.theme.manifest.id,
      kind,
      "mapping",
    );
  }
  const definition = context.theme.components[componentName];
  if (!definition) {
    throw new ThemeRenderError(
      `排版 ${context.theme.manifest.name} 的 ${kind} 组件不存在`,
      context.theme.manifest.id,
      kind,
      "mapping",
    );
  }
  return definition.template.replace(/{{([^{}]+)}}/g, (_match, rawName: string) => {
    const name = rawName.trim() as keyof typeof values;
    const value = values[name] ?? "";
    return name === "children" || name === "summary" ? value : escapeScalar(value);
  });
}

function renderInline(nodes: InlineNode[], context: RenderContext): string {
  return nodes.map(node => {
    context.nodeCount += 1;
    switch (node.kind) {
      case "text":
        return escapeScalar(node.value);
      case "strong":
      case "emphasis":
      case "delete":
        return component(context, node.kind, { children: renderInline(node.children, context) });
      case "inlineCode":
        return component(context, "inlineCode", { content: node.value });
      case "link":
        return component(context, "link", {
          children: renderInline(node.children, context),
          src: safeLinkUrl(node.destination),
        });
    }
  }).join("");
}

function isSummaryHeading(value: string): boolean {
  return /^(?:总结|结语|写在最后|最后|尾声)(?:$|[：:\s])/.test(value.trim());
}

function isHeadingNode(
  node: ThemeMarkdownNode,
): node is Extract<ThemeMarkdownNode, { kind: `heading${1 | 2 | 3 | 4 | 5 | 6}` }> {
  return /^heading[1-6]$/.test(node.kind);
}

function renderBlocks(nodes: ThemeMarkdownNode[], context: RenderContext): string {
  return nodes.map(node => {
    context.nodeCount += 1;
    if (isHeadingNode(node)) {
      let index = "";
      if (node.kind === "heading2") {
        if (isSummaryHeading(node.sourceText)) index = "∞";
        else {
          context.heading2Index += 1;
          index = String(context.heading2Index).padStart(2, "0");
        }
      }
      return component(context, node.kind as ThemeNodeKind, {
        children: renderInline(node.inline, context),
        index,
      });
    }
    switch (node.kind) {
      case "paragraph":
        return component(context, "paragraph", { children: renderInline(node.inline, context) });
      case "blockquote":
        return component(context, "blockquote", { children: renderBlocks(node.children, context) });
      case "unorderedList":
      case "orderedList": {
        const children = node.items.map(item => component(context, "listItem", {
          children: renderBlocks(item, context),
        })).join("");
        return component(context, node.kind, { children });
      }
      case "codeBlock":
        return component(context, "codeBlock", { content: node.value, language: node.language });
      case "image": {
        context.imageSources.push(node.source);
        let resolved = "";
        try {
          resolved = safeImageUrl(context.resolveImage(node.source));
        } catch (error) {
          throw new ThemeRenderError(
            `图片 ${node.source} 解析失败：${error instanceof Error ? error.message : String(error)}`,
            context.theme.manifest.id,
            "image",
            "resolver",
          );
        }
        const image = component(context, "image", { src: resolved, alt: node.alt });
        const caption = node.alt.trim()
          ? component(context, "imageCaption", { caption: node.alt })
          : "";
        return image + caption;
      }
      case "horizontalRule":
        return component(context, "horizontalRule", {});
      case "table": {
        const headerCells = node.header.map(cell => component(context, "tableHeaderCell", {
          children: renderInline(cell, context),
        })).join("");
        const head = component(context, "tableHead", {
          children: component(context, "tableRow", { children: headerCells }),
        });
        const rows = node.rows.map(row => component(context, "tableRow", {
          children: row.map(cell => component(context, "tableCell", {
            children: renderInline(cell, context),
          })).join(""),
        })).join("");
        const body = component(context, "tableBody", { children: rows });
        return component(context, "table", { children: head + body });
      }
    }
  }).join("");
}

function renderArticle(nodes: ThemeMarkdownNode[], context: RenderContext, frontmatter: ThemeFrontmatter): string {
  if (!context.theme.mapping.articleHeader || nodes[0]?.kind !== "heading1") return renderBlocks(nodes, context);
  const heading = nodes[0];
  let summary = frontmatter.summary ? parseInlineMarkdown(frontmatter.summary) : undefined;
  let bodyStart = 1;
  const lead = nodes[1];
  if (!summary && lead?.kind === "paragraph") {
    summary = lead.inline;
    bodyStart = 2;
  } else if (!summary && lead?.kind === "blockquote" && lead.children.length === 1 && lead.children[0]?.kind === "paragraph") {
    summary = lead.children[0].inline;
    bodyStart = 2;
  }
  if (!summary?.length) return renderBlocks(nodes, context);
  context.nodeCount += 1;
  const header = component(context, "articleHeader", {
    children: renderInline(heading.inline, context),
    summary: renderInline(summary, context),
  });
  return header + renderBlocks(nodes.slice(bodyStart), context);
}

export function renderTheme(
  markdown: string,
  theme: WriteXThemePackage,
  resolveImage: (source: string) => string = source => source,
): ThemeRenderResult {
  return renderParsedTheme(parseThemeMarkdown(markdown), theme, resolveImage, extractThemeFrontmatter(markdown));
}

export function renderParsedTheme(
  nodes: ThemeMarkdownNode[],
  theme: WriteXThemePackage,
  resolveImage: (source: string) => string = source => source,
  frontmatter: ThemeFrontmatter = {},
): ThemeRenderResult {
  const validation = validateThemePackage(theme);
  if (!validation.ok || !validation.theme) {
    throw new ThemeRenderError(
      `排版 ${theme.manifest?.id ?? "unknown"} 校验失败：${validation.errors.join("；")}`,
      theme.manifest?.id ?? "unknown",
      "document",
      "validation",
    );
  }
  const context: RenderContext = {
    theme: validation.theme,
    resolveImage,
    imageSources: [],
    nodeCount: 0,
    heading2Index: 0,
  };
  const children = renderArticle(nodes, context, frontmatter);
  context.nodeCount += 1;
  return {
    html: compressThemeHtml(component(context, "document", { children })),
    themeId: theme.manifest.id,
    themeVersion: theme.manifest.version,
    imageSources: context.imageSources,
    nodeCount: context.nodeCount,
  };
}
