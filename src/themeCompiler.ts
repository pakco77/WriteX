import { renderTheme } from "./themeRenderer.ts";
import {
  MAX_THEME_BYTES,
  THEME_ALLOWED_CSS_PROPERTIES,
  THEME_ALLOWED_TAGS,
  validateThemePackage,
  type WriteXThemePackage,
} from "./themeSchema.ts";

export type ThemeCompileStage =
  | "idle" | "reading" | "compiling" | "validating"
  | "previewing" | "done" | "failed" | "cancelled";

export interface ThemeCompileSource {
  kind: "skill" | "vault";
  name: string;
  path: string;
  sha256: string;
  content?: string;
}

export const MAX_THEME_SOURCE_BYTES = 512 * 1024;

const FIXTURE = [
  "# 一级标题",
  "",
  "## 二级标题",
  "",
  "### 三级标题",
  "",
  "#### 四级标题",
  "",
  "##### 五级标题",
  "",
  "###### 六级标题",
  "",
  "正文 **加粗** *强调* ~~删除~~ `代码` [链接](https://example.com)。",
  "",
  "> 引用",
  "",
  "- 无序一",
  "  - 嵌套项",
  "",
  "1. 有序一",
  "2. 有序二",
  "",
  "```ts",
  "const ready = true;",
  "```",
  "",
  "---",
  "",
  "| A | B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "![样例图](fixture.png)",
].join("\n");

const DROPPED_AGENT_CSS = new Set(["transform", "transform-origin", "table-layout"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeKnownCss(style: string): string {
  return style.split(";").flatMap(raw => {
    const declaration = raw.trim();
    if (!declaration) return [];
    const separator = declaration.indexOf(":");
    if (separator <= 0) return [declaration];
    const rawProperty = declaration.slice(0, separator).trim();
    const property = rawProperty.toLowerCase();
    if (DROPPED_AGENT_CSS.has(property)) return [];
    const normalizedProperty = property === "word-wrap" ? "overflow-wrap" : rawProperty;
    return [`${normalizedProperty}:${declaration.slice(separator + 1).trim()}`];
  }).join(";");
}

function normalizeDeleteTag(template: string): string {
  return template
    .replace(/<del(\s[^<>]*?)?>/gi, (_match, rawAttributes: string | undefined) => {
      let attributes = rawAttributes ?? "";
      const style = /\bstyle\s*=\s*(["'])([\s\S]*?)\1/i;
      if (style.test(attributes)) {
        attributes = attributes.replace(style, (_source, quote: string, value: string) => {
          const decoration = /(?:^|;)\s*text-decoration\s*:/i.test(value)
            ? value
            : `${value.replace(/;?\s*$/, ";")}text-decoration:line-through`;
          return `style=${quote}${decoration}${quote}`;
        });
      } else {
        attributes += ' style="text-decoration:line-through"';
      }
      return `<span${attributes}>`;
    })
    .replace(/<\/del\s*>/gi, "</span>");
}

export function normalizeThemeCompileCandidate(input: unknown): unknown {
  if (!isPlainRecord(input)) return input;
  const normalized = structuredClone(input);
  if (isPlainRecord(normalized.tokens)) {
    // ponytail: Token objects are model formatting drift and are currently unused by the renderer;
    // keep only schema-valid scalar values instead of inventing a recursive token language.
    normalized.tokens = Object.fromEntries(
      Object.entries(normalized.tokens).filter(([, value]) => typeof value === "string"),
    );
  }
  if (isPlainRecord(normalized.components)) {
    for (const component of Object.values(normalized.components)) {
      if (!isPlainRecord(component) || typeof component.template !== "string") continue;
      const deleteNormalized = normalizeDeleteTag(component.template);
      component.template = deleteNormalized.replace(
        /\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi,
        (_source, quote: string, style: string) => `style=${quote}${normalizeKnownCss(style)}${quote}`,
      );
    }
  }
  return normalized;
}

export function buildThemeCompilePrompt(source: ThemeCompileSource): string {
  if (!/^[a-f0-9]{64}$/i.test(source.sha256)) throw new Error("排版源 SHA-256 无效");
  const content = source.content ?? "";
  if (new TextEncoder().encode(content).byteLength > MAX_THEME_SOURCE_BYTES) {
    throw new Error("排版源超过 512 KiB，未发送给 Agent");
  }
  const sourceInstruction = source.kind === "skill"
    ? `完整读取这个明确选中的本地 Skill 及其为排版所必需的只读引用：${source.path}`
    : ["选中的源文件内容：", "---", content, "---"].join("\n");
  return [
    "把一个明确选中的排版源编译为 WriteX v1 静态排版包。只返回一个 JSON 对象，不要 Markdown 围栏，不要解释文字。",
    "不要修改源文件或任何其他文件。不要添加 script、style、class、id 或网络资源。不要运行写入命令。",
    `源类型：${source.kind}`,
    `源名称：${source.name}`,
    `源路径：${source.path}`,
    `源 SHA-256：${source.sha256}`,
    sourceInstruction,
    "输出 JSON 必须符合：",
    '{"schemaVersion":1,"manifest":{"id":"lowercase.id","name":"名称","version":"1.0.0","author":"作者","license":"许可证","sourceUrl":"来源","description":"说明","minWriteXVersion":"0.4.0"},"tokens":{},"components":{"component":{"template":"<section style=\\"...\\">{{children}}</section>"}},"mapping":{"document":"component"}}',
    "tokens 的每个值必须是字符串，不能使用对象、数组或数字；tokens 只保存扁平的命名值。",
    "允许的节点：document, paragraph, heading1..heading6, strong, emphasis, delete, blockquote, unorderedList, orderedList, listItem, link, image, imageCaption, inlineCode, codeBlock, horizontalRule, table, tableHead, tableBody, tableRow, tableHeaderCell, tableCell。",
    "允许的占位符：{{children}}, {{content}}, {{index}}, {{language}}, {{caption}}, {{src}}, {{alt}}。{{src}} 只能完整用于 src 或 href 属性；不要发明其他占位符。",
    `允许的 HTML 标签：${THEME_ALLOWED_TAGS.join(", ")}。delete 节点必须使用 span 配合 text-decoration:line-through。`,
    `允许的 CSS 属性：${THEME_ALLOWED_CSS_PROPERTIES.join(", ")}。不要使用 del、transform、transform-origin 或 table-layout。`,
    "模板只能使用上面列出的安全内联 HTML/CSS；所有样式全内联，不得引用外部字体、图片、脚本或 CSS。",
    "必须覆盖所有上述节点，并让样例文章能够完整渲染。",
  ].join("\n");
}

export function parseThemeCompileResult(output: string): WriteXThemePackage {
  const bytes = new TextEncoder().encode(output);
  if (bytes.byteLength > MAX_THEME_BYTES) throw new Error("Agent 输出超过排版包 2 MiB 限制");
  const trimmed = output.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  const json = fenced?.[1] ?? trimmed;
  if (!fenced && !(json.startsWith("{") && json.endsWith("}"))) {
    throw new Error("只允许返回一个 JSON 对象");
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error(`Agent 输出不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("只允许返回一个 JSON 对象");
  const validation = validateThemePackage(normalizeThemeCompileCandidate(value));
  if (!validation.ok || !validation.theme) throw new Error(`排版包校验失败：${validation.errors.join("；")}`);
  try {
    renderTheme(FIXTURE, validation.theme, source => `app://${source}`);
  } catch (error) {
    throw new Error(`排版包样例渲染失败：${error instanceof Error ? error.message : String(error)}`);
  }
  return validation.theme;
}
