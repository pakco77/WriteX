import assert from "node:assert/strict";
import test from "node:test";
import {
  extractThemeFrontmatter,
  extractThemeImageSources,
  parseInlineMarkdown,
  parseThemeMarkdown,
} from "../src/themeMarkdown.ts";

test("theme frontmatter exposes an explicit article summary without leaking metadata into body nodes", () => {
  const markdown = [
    "---",
    "title: 一篇文章",
    "digest: '一句 **摘要**'",
    "---",
    "# 正文标题",
    "",
    "第一段",
  ].join("\n");
  assert.deepEqual(extractThemeFrontmatter(markdown), {
    title: "一篇文章",
    summary: "一句 **摘要**",
  });
  assert.equal(parseThemeMarkdown(markdown)[0]?.kind, "heading1");
});

test("theme Markdown removes frontmatter and preserves headings, paragraphs, raw HTML, and images", () => {
  const markdown = [
    "---",
    "title: hidden",
    "---",
    "# 一级",
    "## 二级",
    "### 三级",
    "#### 四级",
    "##### 五级",
    "###### 六级",
    "",
    "第一行",
    "第二行",
    "",
    "<script>x</script>",
    "",
    "![说明](a.png)",
    "",
    "![[b.jpg|维基说明]]",
  ].join("\n");

  const nodes = parseThemeMarkdown(markdown);
  assert.deepEqual(nodes.slice(0, 6).map(node => node.kind), [
    "heading1", "heading2", "heading3", "heading4", "heading5", "heading6",
  ]);
  assert.equal(nodes[6]?.kind, "paragraph");
  assert.equal(nodes[6]?.kind === "paragraph" ? nodes[6].sourceText : "", "第一行\n第二行");
  assert.equal(nodes[7]?.kind === "paragraph" ? nodes[7].sourceText : "", "<script>x</script>");
  assert.deepEqual(nodes.slice(8).map(node => node.kind), ["image", "image"]);
  assert.deepEqual(extractThemeImageSources(markdown), ["a.png", "b.jpg"]);
});

test("Obsidian images dragged after text become gallery and renderable image nodes", () => {
  const markdown = "正文首图：![[Pasted image.png]]\n\n![证书](certificate.png)完成";
  const nodes = parseThemeMarkdown(markdown);

  assert.deepEqual(nodes.map(node => node.kind), ["paragraph", "image", "image", "paragraph"]);
  assert.deepEqual(extractThemeImageSources(markdown), ["Pasted image.png", "certificate.png"]);
  assert.equal(nodes[0]?.kind === "paragraph" ? nodes[0].sourceText : "", "正文首图：");
  assert.equal(nodes[3]?.kind === "paragraph" ? nodes[3].sourceText : "", "完成");
});

test("inline Markdown recognizes strong, emphasis, delete, code, and links without emitting HTML", () => {
  const nodes = parseInlineMarkdown("普通 **重点** *语气* ~~删除~~ `code` [链接](https://example.com)");
  assert.deepEqual(nodes.map(node => node.kind), [
    "text", "strong", "text", "emphasis", "text", "delete", "text", "inlineCode", "text", "link",
  ]);
  assert.equal(nodes.some(node => "value" in node && node.value.includes("<")), false);
});

test("theme Markdown parses quotes, lists, fenced code, rules, and tables", () => {
  const markdown = [
    "> 引用一",
    "> 引用二",
    "",
    "- 项目一",
    "  - 子项目",
    "- 项目二",
    "",
    "1. 第一步",
    "2) 第二步",
    "",
    "```ts",
    "const x = '<safe>';",
    "```",
    "",
    "---",
    "",
    "| 名称 | 数值 |",
    "| --- | ---: |",
    "| A | 1 |",
  ].join("\n");

  const nodes = parseThemeMarkdown(markdown);
  assert.deepEqual(nodes.map(node => node.kind), [
    "blockquote", "unorderedList", "orderedList", "codeBlock", "horizontalRule", "table",
  ]);
  const code = nodes.find(node => node.kind === "codeBlock");
  assert.equal(code?.kind === "codeBlock" ? code.language : "", "ts");
  assert.equal(code?.kind === "codeBlock" ? code.value : "", "const x = '<safe>';" );
  const table = nodes.find(node => node.kind === "table");
  assert.equal(table?.kind === "table" ? table.header.length : 0, 2);
  assert.equal(table?.kind === "table" ? table.rows.length : 0, 1);
});
