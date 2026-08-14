import assert from "node:assert/strict";
import test from "node:test";
import { BUILTIN_THEMES } from "../src/themeBuiltins.ts";
import {
  ThemeRenderError,
  renderTheme,
} from "../src/themeRenderer.ts";
import type { WriteXThemePackage } from "../src/themeSchema.ts";

function normalizeSrc(html: string): string {
  return html.replace(/\ssrc="[^"]*"/g, ' src="<image>"');
}

test("preview and copy resolvers change only image src", () => {
  const markdown = "## 章节\n\n正文 **重点**\n\n![图](a.png)";
  const preview = renderTheme(markdown, BUILTIN_THEMES.xiaohei, source => `app:///${source}`);
  const copy = renderTheme(markdown, BUILTIN_THEMES.xiaohei, source => `write-image://${source}`);
  assert.equal(normalizeSrc(preview.html), normalizeSrc(copy.html));
  assert.deepEqual(preview.imageSources, ["a.png"]);
  assert.deepEqual(copy.imageSources, ["a.png"]);
});

test("user text and image attributes cannot escape trusted templates", () => {
  const html = renderTheme(
    '## <img onerror=x>\n\n<script>alert(1)</script>\n\n![" onerror="x](javascript:x)',
    BUILTIN_THEMES.default,
    value => value,
  ).html;
  assert.doesNotMatch(html, /onerror=/i);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
});

test("renderer applies indices, nested lists, tables, code language, captions, and image order", () => {
  const indexed = structuredClone(BUILTIN_THEMES.default) as WriteXThemePackage;
  indexed.manifest.id = "pakco.indexed";
  indexed.components.heading2.template = '<h2>{{index}} {{children}}</h2>';
  indexed.components.codeBlock.template = '<pre><span>{{language}}</span><code>{{content}}</code></pre>';

  const markdown = [
    "## 第一节",
    "## 第二节",
    "## 总结",
    "",
    "- 外层",
    "  - 内层",
    "",
    "```ts",
    "const x = 1;",
    "```",
    "",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "![](one.png)",
    "",
    "![第二张](two.png)",
  ].join("\n");

  const result = renderTheme(markdown, indexed, source => `app:///${source}`);
  assert.match(result.html, /<h2>01 第一节<\/h2>/);
  assert.match(result.html, /<h2>02 第二节<\/h2>/);
  assert.match(result.html, /<h2>∞ 总结<\/h2>/);
  assert.match(result.html, /<ul[^>]*>.*外层.*<ul[^>]*>.*内层.*<\/ul>.*<\/ul>/s);
  assert.match(result.html, /<span>ts<\/span><code>const x = 1;<\/code>/);
  assert.match(result.html, /<table[^>]*>.*<th[^>]*>A<\/th>.*<td[^>]*>1<\/td>.*<\/table>/s);
  assert.deepEqual(result.imageSources, ["one.png", "two.png"]);
  assert.equal((result.html.match(/第二张/g) ?? []).length, 2);
  assert.equal(result.html.includes("{{"), false);
});

test("missing semantic mappings fail truthfully instead of falling back to another theme", () => {
  const incomplete = structuredClone(BUILTIN_THEMES.default) as WriteXThemePackage;
  incomplete.manifest.id = "pakco.incomplete";
  delete incomplete.mapping.blockquote;

  assert.throws(
    () => renderTheme("> 必须保留", incomplete),
    (error: unknown) => error instanceof ThemeRenderError
      && error.themeId === "pakco.incomplete"
      && error.nodeKind === "blockquote"
      && error.stage === "mapping",
  );
});

test("article-level gzh headers consume an explicit digest or the first paragraph exactly once", () => {
  const theme = structuredClone(BUILTIN_THEMES.default) as WriteXThemePackage;
  theme.manifest.id = "pakco.article-header";
  theme.mapping.articleHeader = "articleHeader";
  theme.components.articleHeader = {
    template: '<section><h1>WRITEX_HEADER {{children}}</h1><p>WRITEX_SUMMARY {{summary}}</p></section>',
  };

  const explicit = renderTheme("---\ndigest: 明确摘要\n---\n# 标题\n\n正文第一段", theme).html;
  assert.match(explicit, /WRITEX_SUMMARY 明确摘要/);
  assert.equal((explicit.match(/正文第一段/g) ?? []).length, 1);

  const inferred = renderTheme("# 标题\n\n作为摘要的第一段\n\n## 第一节\n\n正文", theme).html;
  assert.match(inferred, /WRITEX_SUMMARY 作为摘要的第一段/);
  assert.equal((inferred.match(/作为摘要的第一段/g) ?? []).length, 1);
});
