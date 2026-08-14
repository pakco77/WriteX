import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BUILTIN_THEMES } from "../src/themeBuiltins.ts";
import type { ThemeCatalogEntry } from "../src/themeCatalog.ts";
import { ThemeInstaller } from "../src/themeInstaller.ts";
import { parseThemeMarkdown } from "../src/themeMarkdown.ts";
import { renderParsedTheme } from "../src/themeRenderer.ts";
import { ThemeService } from "../src/themeService.ts";
import { ThemeStore } from "../src/themeStore.ts";

const catalog: ThemeCatalogEntry[] = Object.values(BUILTIN_THEMES).map(theme => ({
  id: theme.manifest.id,
  name: theme.manifest.name,
  version: theme.manifest.version,
  delivery: "builtin",
  defaultInstalled: true,
  author: theme.manifest.author,
  license: theme.manifest.license,
  sourceUrl: theme.manifest.sourceUrl,
  minWriteXVersion: theme.manifest.minWriteXVersion,
}));

function article(): string {
  const sections = Array.from({ length: 30 }, (_, index) => [
    `## 章节 ${index + 1}`,
    "",
    `第 ${index + 1} 段正文，包含 **重点**、[链接](https://example.com) 和 \`inline code\`。`,
    "",
    "> 一段引用，用来覆盖真实文章结构。",
    "",
    "- 列表一",
    "  - 嵌套列表",
    "",
    "| 项目 | 数值 |",
    "| --- | --- |",
    `| ${index + 1} | ${index * 2} |`,
    ...(index < 10 ? ["", `![图片 ${index + 1}](assets/image-${index + 1}.png)`] : []),
  ].join("\n"));
  return `# 性能验收文章\n\n${sections.join("\n\n")}\n\n\`\`\`ts\nconst done = true;\n\`\`\``;
}

test("local parse, warm render, theme switch and ten-image resolver stay bounded", async t => {
  const markdown = article();
  const parseStarted = performance.now();
  const nodes = parseThemeMarkdown(markdown);
  const parseMs = performance.now() - parseStarted;

  const coldStarted = performance.now();
  const cold = renderParsedTheme(nodes, BUILTIN_THEMES.default, source => `app://${source}`);
  const coldMs = performance.now() - coldStarted;
  assert.equal(cold.imageSources.length, 10);

  const root = await mkdtemp(join(tmpdir(), "writex-theme-performance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ThemeStore(root);
  const service = new ThemeService({
    store,
    installer: new ThemeInstaller(store, catalog, async () => new Uint8Array()),
    catalog,
  });
  await service.initialize();
  service.render(markdown, "default", source => `app://${source}`);
  const warmStarted = performance.now();
  const warm = service.render(markdown, "default", source => `app://${source}`);
  const warmMs = performance.now() - warmStarted;
  const switchStarted = performance.now();
  const switched = service.render(markdown, "xiaohei", source => `write-image://${source}`);
  const switchMs = performance.now() - switchStarted;

  assert.equal(warm.imageSources.length, 10);
  assert.equal(switched.imageSources.length, 10);
  assert.deepEqual(switched.imageSources, Array.from({ length: 10 }, (_, index) => `assets/image-${index + 1}.png`));
  assert.ok(parseMs < 5000, `parse regression: ${parseMs.toFixed(2)}ms`);
  assert.ok(coldMs < 5000, `cold render regression: ${coldMs.toFixed(2)}ms`);
  assert.ok(warmMs < 1500, `warm render regression: ${warmMs.toFixed(2)}ms`);
  assert.ok(switchMs < 2000, `theme switch regression: ${switchMs.toFixed(2)}ms`);
  t.diagnostic(`parse=${parseMs.toFixed(2)}ms cold=${coldMs.toFixed(2)}ms warm=${warmMs.toFixed(2)}ms switch=${switchMs.toFixed(2)}ms`);
});
