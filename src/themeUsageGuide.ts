import { renderTheme } from "./themeRenderer.ts";
import type { WriteXThemePackage } from "./themeSchema.ts";

export interface ThemeUsageGuideEntry {
  id: string;
  label: string;
  /** 左侧展示的 Markdown 符号写法。 */
  syntax: string;
  /** 实际送进渲染器的 Markdown（可与 syntax 相同，也可补全触发条件）。 */
  markdown: string;
  /** 右侧按当前排版真实渲染出的 HTML。 */
  html: string;
}

interface ThemeUsageGuideSpec {
  id: string;
  label: string;
  syntax: string;
  markdown: string;
}

/**
 * 排版使用说明的固定条目：左边符号、右边 demo。
 * 顺序即展示顺序，覆盖用户能在正文里写出的全部触发方式。
 */
export const THEME_USAGE_GUIDE_SPECS: readonly ThemeUsageGuideSpec[] = [
  {
    id: "article-title",
    label: "文章标题",
    syntax: "# 文章标题",
    markdown: "# 文章标题",
  },
  {
    id: "article-summary",
    label: "头部摘要条",
    syntax: "---\nsummary: 一句摘要写在最前\n---\n# 文章标题",
    markdown: "---\nsummary: 一句摘要写在最前\n---\n# 文章标题",
  },
  {
    id: "heading2",
    label: "二级标题",
    syntax: "## 小节标题",
    markdown: "## 小节标题",
  },
  {
    id: "heading3",
    label: "三级标题",
    syntax: "### 细节标题",
    markdown: "### 细节标题",
  },
  {
    id: "strong",
    label: "加粗",
    syntax: "**加粗文字**",
    markdown: "段落里的**加粗文字**示例。",
  },
  {
    id: "emphasis",
    label: "着重",
    syntax: "*着重文字*",
    markdown: "段落里的*着重文字*示例。",
  },
  {
    id: "delete",
    label: "删除线",
    syntax: "~~删除文字~~",
    markdown: "段落里的~~删除文字~~示例。",
  },
  {
    id: "inline-code",
    label: "行内代码",
    syntax: "`code`",
    markdown: "段落里的`inlineCode`示例。",
  },
  {
    id: "code-block",
    label: "代码块",
    syntax: "```js\nconst a = 1;\n```",
    markdown: "```js\nconst a = 1;\n```",
  },
  {
    id: "blockquote",
    label: "引用块",
    syntax: "> 一句判断",
    markdown: "> 一句判断",
  },
  {
    id: "callout-note",
    label: "提示框",
    syntax: "> [!note] 可选标题",
    markdown: "> [!note] 背景补充\n> 补充一段背景说明。",
  },
  {
    id: "callout-tip",
    label: "技巧框",
    syntax: "> [!tip] 可选标题",
    markdown: "> [!tip] 更省力的做法\n> 写一条实操技巧。",
  },
  {
    id: "callout-warning",
    label: "警示框",
    syntax: "> [!warning] 可选标题",
    markdown: "> [!warning] 操作前注意\n> 写一条风险提醒。",
  },
  {
    id: "quote-card",
    label: "金句卡",
    syntax: "> [!quote] 金句",
    markdown: "> [!quote]\n> 一句想被记住的话。",
  },
  {
    id: "unordered-list",
    label: "无序列表",
    syntax: "- 第一项\n- 第二项",
    markdown: "- 第一项\n- 第二项",
  },
  {
    id: "ordered-list",
    label: "有序列表",
    syntax: "1. 第一步\n2. 第二步",
    markdown: "1. 第一步\n2. 第二步",
  },
  {
    id: "link",
    label: "链接",
    syntax: "[链接文字](https://example.com)",
    markdown: "段落里的[链接文字](https://example.com)示例。",
  },
  {
    id: "image",
    label: "图片与图注",
    syntax: "![图注文字](图片.png)",
    markdown: "![图注文字](guide-demo.png)",
  },
  {
    id: "table",
    label: "表格",
    syntax: "| 表头一 | 表头二 |\n| --- | --- |\n| 内容 | 内容 |",
    markdown: "| 表头一 | 表头二 |\n| --- | --- |\n| 内容甲 | 内容乙 |",
  },
  {
    id: "horizontal-rule",
    label: "分隔线",
    syntax: "---",
    markdown: "上段文字。\n\n---\n\n下段文字。",
  },
];

/**
 * 用指定排版把每个条目的 Markdown 真实渲染一遍，供 UI 左右对照展示。
 * 单个条目渲染失败不中断整体，该条目 demo 为空串由 UI 标注。
 */
export function renderThemeUsageGuide(theme: WriteXThemePackage): ThemeUsageGuideEntry[] {
  return THEME_USAGE_GUIDE_SPECS.map(spec => {
    let html = "";
    try {
      html = renderTheme(spec.markdown, theme).html;
    } catch {
      html = "";
    }
    return { id: spec.id, label: spec.label, syntax: spec.syntax, markdown: spec.markdown, html };
  });
}
