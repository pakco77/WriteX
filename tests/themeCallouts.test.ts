import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseThemeMarkdown } from "../src/themeMarkdown.ts";
import { renderTheme, resolveThemePalette } from "../src/themeRenderer.ts";
import { validateThemePackage, type WriteXThemePackage } from "../src/themeSchema.ts";

const PACK_PATH = new URL("../../writex-theme-packs/themes/moyu-green.writex-theme.json", import.meta.url).pathname;

function miniTheme(): WriteXThemePackage {
  return {
    schemaVersion: 1,
    manifest: {
      id: "mini", name: "Mini", version: "1.0.0", author: "test", license: "MIT",
      sourceUrl: "https://example.com", description: "test", minWriteXVersion: "0.6.2",
    },
    tokens: { accent: "#111111", paper: "#ffffff" },
    components: {
      document: { template: "<section>{{children}}</section>" },
      paragraph: { template: "<p>{{children}}</p>" },
      blockquote: { template: "<blockquote>{{children}}</blockquote>" },
      calloutNote: { template: "<section>NOTE[{{title}}]{{children}}</section>" },
      calloutTip: { template: "<section style=\"border-color:{{tokens.accent}};background:{{tokens.paper}}\">TIP[{{title}}]{{children}}</section>" },
      calloutWarning: { template: "<section>WARN{{children}}</section>" },
      quoteCard: { template: "<section>QC{{children}}</section>" },
    },
    mapping: {
      document: "document", paragraph: "paragraph", blockquote: "blockquote",
      calloutNote: "calloutNote", calloutTip: "calloutTip", calloutWarning: "calloutWarning",
      quoteCard: "quoteCard",
    },
  };
}

test("parser routes callout headers to callout nodes with titles", () => {
  const nodes = parseThemeMarkdown("> [!note] 背景补充\n> 第一段。\n> 第二段。\n\n> [!tip]\n> 做法一\n");
  assert.equal(nodes[0]?.kind, "calloutNote");
  if (nodes[0]?.kind === "calloutNote") {
    assert.equal(nodes[0].title, "背景补充");
    assert.equal(nodes[0].children.length, 1);
    if (nodes[0].children[0]?.kind === "paragraph") {
      assert.match(nodes[0].children[0].sourceText, /第一段。[\s\S]*第二段。/);
    }
  }
  assert.equal(nodes[1]?.kind, "calloutTip");
  if (nodes[1]?.kind === "calloutTip") assert.equal(nodes[1].title, "");
});

test("parser is case-insensitive and unknown callouts stay plain blockquotes", () => {
  const nodes = parseThemeMarkdown("> [!WARNING] 小心\n> 内容\n\n> [!compare] 左 | 右\n");
  assert.equal(nodes[0]?.kind, "calloutWarning");
  assert.equal(nodes[1]?.kind, "blockquote");
});

test("parser routes quote callout to quoteCard with same-line or following content", () => {
  const nodes = parseThemeMarkdown("> [!quote]\n> 金句一\n\n> [!quote] 金句二\n");
  assert.equal(nodes[0]?.kind, "quoteCard");
  assert.equal(nodes[1]?.kind, "quoteCard");
});

test("renderer injects tokens and escapes callout titles", () => {
  const html = renderTheme("> [!tip] 标\"题\n> 正文", miniTheme()).html;
  assert.match(html, /border-color:#111111/);
  assert.match(html, /background:#ffffff/);
  assert.match(html, /TIP\[标&quot;题\]/);
  assert.match(html, /正文/);
});

test("resolveThemePalette overrides only the keys a palette defines", { skip: !existsSync(PACK_PATH) }, async () => {
  const theme = JSON.parse(await readFile(PACK_PATH, "utf8")) as WriteXThemePackage;
  const withPalette = resolveThemePalette(theme, "warm");
  assert.equal(withPalette.tokens.accent, theme.palettes?.find(p => p.id === "warm")?.tokens.accent);
  assert.equal(withPalette.tokens.title, theme.tokens.title);
  assert.equal(resolveThemePalette(theme, "missing").tokens.accent, theme.tokens.accent);
  assert.equal(resolveThemePalette(theme, undefined), theme);
});

test("schema accepts token placeholders and palettes, rejects bad palette shapes", () => {
  const theme = miniTheme();
  theme.components.calloutTip = { template: "<section style=\"color:{{tokens.accent}}\">{{children}}</section>" };
  theme.palettes = [{ id: "warm", name: "暖橙", tokens: { accent: "#EA580C" } }];
  assert.equal(validateThemePackage(theme).ok, true);

  const bad = { ...theme, palettes: [{ id: "warm", tokens: {} }] };
  assert.equal(validateThemePackage(bad).ok, false);

  const dup = { ...theme, palettes: [theme.palettes![0], theme.palettes![0]] };
  assert.equal(validateThemePackage(dup).ok, false);
});

test("empty callout titles drop the label line instead of leaving a blank gap", () => {
  const theme = miniTheme();
  theme.components.calloutTip = {
    template: '<section style="background:#fff"><p style="margin:0 0 6px; font-size:12px; font-weight:700; color:#111;">{{title}}</p><section style="font-size:14px;">{{children}}</section></section>',
  };
  const withoutTitle = renderTheme("> [!tip]\n> 做法一", theme).html;
  assert.doesNotMatch(withoutTitle, /font-size:12px/);
  assert.match(withoutTitle, /做法一/);
  const withTitle = renderTheme("> [!tip] 步骤\n> 做法一", theme).html;
  assert.match(withTitle, /font-size:12px/);
  assert.match(withTitle, /步骤/);
});

test("a full pack with callout components validates and renders", { skip: !existsSync(PACK_PATH) }, async () => {
  const theme = JSON.parse(await readFile(PACK_PATH, "utf8")) as WriteXThemePackage;
  const validation = validateThemePackage(theme);
  assert.equal(validation.ok, true, validation.errors.join(";"));
  const html = renderTheme("> [!warning] 风险\n> 不可逆。\n\n> [!quote]\n> 一句金句。", theme).html;
  assert.match(html, /不可逆/);
  assert.match(html, /一句金句/);
});
