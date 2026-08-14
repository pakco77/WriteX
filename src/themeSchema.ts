export const THEME_SCHEMA_VERSION = 1;
export const MAX_THEME_BYTES = 2 * 1024 * 1024;
export const MAX_THEME_COMPONENTS = 128;
export const MAX_THEME_NESTING = 20;

export type ThemeNodeKind =
  | "document" | "articleHeader" | "paragraph"
  | "heading1" | "heading2" | "heading3" | "heading4" | "heading5" | "heading6"
  | "strong" | "emphasis" | "delete" | "blockquote"
  | "unorderedList" | "orderedList" | "listItem"
  | "link" | "image" | "imageCaption"
  | "inlineCode" | "codeBlock" | "horizontalRule"
  | "table" | "tableHead" | "tableBody" | "tableRow" | "tableHeaderCell" | "tableCell";

export interface WriteXThemePackage {
  schemaVersion: 1;
  manifest: {
    id: string;
    name: string;
    version: string;
    author: string;
    license: string;
    sourceUrl: string;
    description: string;
    minWriteXVersion: string;
  };
  tokens: Record<string, string>;
  components: Record<string, { template: string }>;
  mapping: Partial<Record<ThemeNodeKind, string>>;
}

export interface ThemeValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  theme?: WriteXThemePackage;
}

const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,79}$/;
const COMPONENT_ID_PATTERN = /^[a-z][a-zA-Z0-9._-]{0,79}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const ALLOWED_PLACEHOLDERS = new Set([
  "content", "children", "summary", "index", "language", "src", "alt", "caption",
]);
const THEME_NODE_KINDS = new Set<ThemeNodeKind>([
  "document", "articleHeader", "paragraph",
  "heading1", "heading2", "heading3", "heading4", "heading5", "heading6",
  "strong", "emphasis", "delete", "blockquote",
  "unorderedList", "orderedList", "listItem",
  "link", "image", "imageCaption",
  "inlineCode", "codeBlock", "horizontalRule",
  "table", "tableHead", "tableBody", "tableRow", "tableHeaderCell", "tableCell",
]);
export const THEME_ALLOWED_TAGS = [
  "section", "p", "span", "strong", "em", "a", "img",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "ul", "ol", "li", "code", "pre", "hr", "br",
  "table", "thead", "tbody", "tr", "th", "td",
] as const;
const ALLOWED_TAGS = new Set<string>(THEME_ALLOWED_TAGS);
const VOID_TAGS = new Set(["img", "hr", "br"]);
const ALLOWED_ATTRIBUTES = new Set([
  "style", "href", "src", "alt", "title", "leaf",
  "colspan", "rowspan", "cellpadding", "cellspacing", "border",
]);
export const THEME_ALLOWED_CSS_PROPERTIES = [
  "align-items", "background", "background-color", "background-image",
  "border", "border-bottom", "border-bottom-color", "border-bottom-style", "border-bottom-width",
  "border-collapse", "border-color", "border-left", "border-left-color", "border-left-style", "border-left-width",
  "border-radius", "border-right", "border-right-color", "border-right-style", "border-right-width",
  "border-spacing", "border-style", "border-top", "border-top-color", "border-top-style", "border-top-width",
  "border-width", "box-shadow", "box-sizing", "color", "display", "flex", "flex-basis", "flex-direction",
  "flex-grow", "flex-shrink", "flex-wrap", "font-family", "font-size", "font-style", "font-weight", "gap",
  "height", "justify-content", "letter-spacing", "line-height", "list-style", "list-style-position",
  "list-style-type", "margin", "margin-bottom", "margin-left", "margin-right", "margin-top", "max-height",
  "max-width", "min-height", "min-width", "opacity", "overflow", "overflow-wrap", "overflow-x", "overflow-y",
  "padding", "padding-bottom", "padding-left", "padding-right", "padding-top", "text-align", "text-decoration",
  "text-indent", "text-transform", "vertical-align", "white-space", "width", "word-break", "word-spacing",
] as const;
const ALLOWED_CSS_PROPERTIES = new Set<string>(THEME_ALLOWED_CSS_PROPERTIES);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireBoundedString(
  object: Record<string, unknown>,
  key: string,
  errors: string[],
  maximum = 2048,
): string | undefined {
  const value = object[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    errors.push(`${key} 必须是 1-${maximum} 字符的字符串`);
    return undefined;
  }
  return value;
}

function templateNesting(template: string): number {
  const voidTags = new Set(["br", "hr", "img"]);
  const tags = /<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^<>]*)?\s*\/?>/g;
  let depth = 0;
  let maximum = 0;
  for (const match of template.matchAll(tags)) {
    const source = match[0];
    const tag = match[1].toLowerCase();
    if (source.startsWith("</")) {
      depth = Math.max(0, depth - 1);
    } else if (!source.endsWith("/>") && !voidTags.has(tag)) {
      depth += 1;
      maximum = Math.max(maximum, depth);
    }
  }
  return maximum;
}

function validateTextPlaceholders(text: string, componentName: string, errors: string[]): void {
  for (const placeholder of text.matchAll(/{{([^{}]+)}}/g)) {
    const name = placeholder[1].trim();
    if (name === "src") {
      errors.push(`component ${componentName} 的 {{src}} 只能用于完整的 src/href 属性`);
    }
  }
  if (text.includes("{{") || text.includes("}}")) {
    const withoutValid = text.replace(/{{[^{}]+}}/g, "");
    if (withoutValid.includes("{{") || withoutValid.includes("}}")) {
      errors.push(`component ${componentName} 包含格式错误的占位符`);
    }
  }
}

function validateCss(value: string, componentName: string, errors: string[]): void {
  if (/[{}@\\]/.test(value) || /(?:url|expression|var)\s*\(/i.test(value)) {
    errors.push(`component ${componentName} 包含不安全的 CSS`);
    return;
  }
  for (const rawDeclaration of value.split(";")) {
    const declaration = rawDeclaration.trim();
    if (!declaration) continue;
    const separator = declaration.indexOf(":");
    if (separator <= 0) {
      errors.push(`component ${componentName} 包含格式错误的 CSS 声明`);
      continue;
    }
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const propertyValue = declaration.slice(separator + 1).trim();
    if (!ALLOWED_CSS_PROPERTIES.has(property) || !propertyValue || propertyValue.length > 1024) {
      errors.push(`component ${componentName} 不允许 CSS 属性 ${property || "(empty)"}`);
      continue;
    }
    if (property === "display" && !/^(?:block|inline|inline-block|flex|inline-flex|none|table|table-row|table-cell|list-item)$/i.test(propertyValue)) {
      errors.push(`component ${componentName} 不允许 display:${propertyValue}`);
    }
    if (/\b(?:javascript|vbscript|data)\s*:/i.test(propertyValue)) {
      errors.push(`component ${componentName} 包含不安全的 CSS 协议`);
    }
  }
}

function validateUrlAttribute(
  tag: string,
  attribute: string,
  value: string,
  componentName: string,
  errors: string[],
): void {
  if (value === "{{src}}") return;
  if (value.includes("{{") || value.includes("}}")) {
    errors.push(`component ${componentName} 的 ${attribute} 必须完整使用 {{src}}`);
    return;
  }
  const normalized = value.replace(/[\u0000-\u0020\u007f]+/g, "").toLowerCase();
  if (attribute === "src" || tag === "img") {
    errors.push(`component ${componentName} 的图片 src 必须使用 {{src}}`);
    return;
  }
  if (!/^(?:https?:|mailto:|tel:|#|\/)/.test(normalized)) {
    errors.push(`component ${componentName} 包含不安全的链接协议`);
  }
}

function validateAttribute(
  tag: string,
  name: string,
  value: string,
  componentName: string,
  errors: string[],
): void {
  const attribute = name.toLowerCase();
  if (!ALLOWED_ATTRIBUTES.has(attribute) || attribute.startsWith("on") || attribute.startsWith("data-")) {
    errors.push(`component ${componentName} 不允许属性 ${name}`);
    return;
  }
  if (attribute === "href" && tag !== "a") errors.push(`component ${componentName} 只能在 a 使用 href`);
  if ((attribute === "src" || attribute === "alt") && tag !== "img") {
    errors.push(`component ${componentName} 只能在 img 使用 ${attribute}`);
  }
  if (["colspan", "rowspan", "cellpadding", "cellspacing", "border"].includes(attribute) && !/^\d+$/.test(value)) {
    errors.push(`component ${componentName} 的 ${attribute} 必须是数字`);
  }
  if (attribute === "style") validateCss(value, componentName, errors);
  if (attribute === "src" || attribute === "href") validateUrlAttribute(tag, attribute, value, componentName, errors);
  if (attribute === "alt") {
    if (value.includes("{{") || value.includes("}}")) {
      if (value !== "{{alt}}") errors.push(`component ${componentName} 的 alt 必须完整使用 {{alt}}`);
    }
  } else if (attribute !== "src" && attribute !== "href" && (value.includes("{{") || value.includes("}}"))) {
    errors.push(`component ${componentName} 不允许在 ${attribute} 中使用占位符`);
  }
}

function findTagEnd(template: string, start: number): number {
  let quote = "";
  for (let index = start + 1; index < template.length; index += 1) {
    const character = template[index];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index;
    else if (character === "<") return -1;
  }
  return -1;
}

function validateTemplate(template: string, componentName: string, errors: string[]): void {
  // ponytail: This deliberately small tokenizer is the security boundary; extend it and the malicious corpus together.
  const stack: string[] = [];
  let cursor = 0;
  while (cursor < template.length) {
    const opening = template.indexOf("<", cursor);
    if (opening === -1) {
      validateTextPlaceholders(template.slice(cursor), componentName, errors);
      break;
    }
    validateTextPlaceholders(template.slice(cursor, opening), componentName, errors);
    if (template.startsWith("<!--", opening)) {
      errors.push(`component ${componentName} 不允许 HTML 注释`);
      return;
    }
    const closing = findTagEnd(template, opening);
    if (closing === -1) {
      errors.push(`component ${componentName} 包含格式错误的 HTML`);
      return;
    }
    const rawTag = template.slice(opening + 1, closing).trim();
    const closingMatch = rawTag.match(/^\/\s*([a-zA-Z][a-zA-Z0-9]*)\s*$/);
    if (closingMatch) {
      const tag = closingMatch[1].toLowerCase();
      if (!ALLOWED_TAGS.has(tag) || VOID_TAGS.has(tag) || stack.pop() !== tag) {
        errors.push(`component ${componentName} 包含不匹配的闭合标签 ${tag}`);
      }
      cursor = closing + 1;
      continue;
    }

    const selfClosing = /\/\s*$/.test(rawTag);
    const openSource = selfClosing ? rawTag.replace(/\/\s*$/, "").trimEnd() : rawTag;
    const openMatch = openSource.match(/^([a-zA-Z][a-zA-Z0-9]*)([\s\S]*)$/);
    if (!openMatch) {
      errors.push(`component ${componentName} 包含格式错误的标签`);
      return;
    }
    const tag = openMatch[1].toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) errors.push(`component ${componentName} 不允许标签 ${tag}`);

    const attributes = openMatch[2];
    let attributeCursor = 0;
    while (attributeCursor < attributes.length) {
      while (/\s/.test(attributes[attributeCursor] ?? "")) attributeCursor += 1;
      if (attributeCursor >= attributes.length) break;
      const attributeMatch = attributes.slice(attributeCursor).match(/^([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/);
      if (!attributeMatch) {
        errors.push(`component ${componentName} 的属性必须使用引号且格式正确`);
        break;
      }
      validateAttribute(tag, attributeMatch[1], attributeMatch[2] ?? attributeMatch[3] ?? "", componentName, errors);
      attributeCursor += attributeMatch[0].length;
    }

    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(tag);
    cursor = closing + 1;
  }
  if (stack.length > 0) errors.push(`component ${componentName} 缺少闭合标签 ${stack.at(-1)}`);
}

export function validateThemePackage(input: unknown): ThemeValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ["主题包必须是 JSON 对象"], warnings: [] };
  }
  try {
    if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_THEME_BYTES) {
      errors.push("主题包不得超过 2 MiB");
    }
  } catch {
    errors.push("主题包必须可序列化为 JSON");
  }
  if (input.schemaVersion !== THEME_SCHEMA_VERSION) errors.push("schemaVersion 必须为 1");
  if (!isPlainObject(input.manifest)) errors.push("manifest 缺失或无效");
  if (!isPlainObject(input.tokens)) errors.push("tokens 缺失或无效");
  if (!isPlainObject(input.components)) errors.push("components 缺失或无效");
  if (!isPlainObject(input.mapping)) errors.push("mapping 缺失或无效");

  if (isPlainObject(input.manifest)) {
    const id = requireBoundedString(input.manifest, "id", errors, 80);
    const version = requireBoundedString(input.manifest, "version", errors, 32);
    const minimum = requireBoundedString(input.manifest, "minWriteXVersion", errors, 32);
    requireBoundedString(input.manifest, "name", errors, 160);
    requireBoundedString(input.manifest, "author", errors, 160);
    requireBoundedString(input.manifest, "license", errors, 160);
    requireBoundedString(input.manifest, "sourceUrl", errors);
    requireBoundedString(input.manifest, "description", errors, 4096);
    if (id && !THEME_ID_PATTERN.test(id)) errors.push("manifest.id 格式无效");
    if (version && !VERSION_PATTERN.test(version)) errors.push("manifest.version 必须为 x.y.z");
    if (minimum && !VERSION_PATTERN.test(minimum)) errors.push("manifest.minWriteXVersion 必须为 x.y.z");
  }

  if (isPlainObject(input.tokens)) {
    for (const [name, value] of Object.entries(input.tokens)) {
      if (!COMPONENT_ID_PATTERN.test(name) || typeof value !== "string" || value.length > 4096) {
        errors.push(`token ${name} 无效`);
      }
    }
  }

  const componentNames = new Set<string>();
  if (isPlainObject(input.components)) {
    const components = Object.entries(input.components);
    if (components.length > MAX_THEME_COMPONENTS) errors.push("components 不得超过 128 个");
    for (const [name, value] of components) {
      componentNames.add(name);
      if (!COMPONENT_ID_PATTERN.test(name) || !isPlainObject(value) || typeof value.template !== "string") {
        errors.push(`component ${name} 无效`);
        continue;
      }
      if (templateNesting(value.template) > MAX_THEME_NESTING) {
        errors.push(`component ${name} 嵌套不得超过 20 层`);
      }
      for (const placeholder of value.template.matchAll(/{{([^{}]+)}}/g)) {
        if (!ALLOWED_PLACEHOLDERS.has(placeholder[1].trim())) {
          errors.push(`component ${name} 包含未知占位符 {{${placeholder[1]}}}`);
        }
      }
      validateTemplate(value.template, name, errors);
    }
  }

  if (isPlainObject(input.mapping)) {
    for (const [kind, target] of Object.entries(input.mapping)) {
      if (!THEME_NODE_KINDS.has(kind as ThemeNodeKind)) {
        errors.push(`mapping 节点 ${kind} 无效`);
      }
      if (typeof target !== "string" || !componentNames.has(target)) {
        errors.push(`mapping ${kind} 指向不存在的 component`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings: [] };
  return {
    ok: true,
    errors: [],
    warnings: [],
    theme: input as unknown as WriteXThemePackage,
  };
}
