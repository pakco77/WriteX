import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BUILTIN_THEMES } from "../src/themeBuiltins.ts";
import type { ThemeCatalogEntry } from "../src/themeCatalog.ts";
import { ThemeInstaller } from "../src/themeInstaller.ts";
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

function normalizeSources(html: string): string {
  return html.replace(/\bsrc="[^"]*"/g, 'src="<image>"');
}

test("preview copy and sync share one semantic render and differ only by image src", async t => {
  const root = await mkdtemp(join(tmpdir(), "writex-theme-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ThemeStore(root);
  const service = new ThemeService({
    store,
    installer: new ThemeInstaller(store, catalog, async () => new Uint8Array()),
    catalog,
  });
  await service.initialize();
  const markdown = "# 标题\n\n正文 **重点**\n\n![一](one.png)\n\n![二](two.png)";
  const preview = service.render(markdown, "default", source => `app://${source}`).html;
  const copy = service.render(markdown, "default", source => `data:image/png;base64,${source}`).html;
  const sync = service.render(markdown, "default", source => `write-image://${source}`).html;

  assert.equal(normalizeSources(preview), normalizeSources(copy));
  assert.equal(normalizeSources(copy), normalizeSources(sync));
  assert.ok(sync.indexOf("write-image://one.png") < sync.indexOf("write-image://two.png"));
});

test("production preview copy and sync contain no legacy Skill render branch", async () => {
  const [view, sync] = await Promise.all([
    readFile(new URL("../src/view.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/sync.ts", import.meta.url), "utf8"),
  ]);
  assert.match(view, /renderCopyHtml[\s\S]*themeService\.render\(/);
  assert.match(sync, /themeService\.render\(/);
  assert.doesNotMatch(`${view}\n${sync}`, /isSkillBackedTheme|layoutSkillNamesForTheme|isFreshSkillRender|replaceSkillImageSources/);
});
