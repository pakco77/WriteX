import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BUILTIN_THEMES } from "../src/themeBuiltins.ts";
import type { ThemeCatalogEntry } from "../src/themeCatalog.ts";
import { ThemeInstaller } from "../src/themeInstaller.ts";
import { parseThemeMarkdown } from "../src/themeMarkdown.ts";
import { ThemeService, ThemeUnavailableError } from "../src/themeService.ts";
import { ThemeStore } from "../src/themeStore.ts";
import type { WriteXThemePackage } from "../src/themeSchema.ts";

function packageBytes(id: string, version = "1.0.0", name = id): Uint8Array {
  const theme = structuredClone(BUILTIN_THEMES.default) as WriteXThemePackage;
  theme.manifest.id = id;
  theme.manifest.name = name;
  theme.manifest.version = version;
  return new TextEncoder().encode(`${JSON.stringify(theme, null, 2)}\n`);
}

function downloadEntry(id: string, bytes: Uint8Array, defaults = false): ThemeCatalogEntry {
  const value = JSON.parse(new TextDecoder().decode(bytes)) as WriteXThemePackage;
  return {
    id,
    name: value.manifest.name,
    version: value.manifest.version,
    delivery: "download",
    defaultInstalled: defaults,
    downloadUrl: `https://example.com/${id}.json`,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    author: value.manifest.author,
    license: value.manifest.license,
    sourceUrl: value.manifest.sourceUrl,
    minWriteXVersion: "0.4.0",
  };
}

const builtinCatalog: ThemeCatalogEntry[] = Object.values(BUILTIN_THEMES).map(theme => ({
  id: theme.manifest.id,
  name: theme.manifest.name,
  version: theme.manifest.version,
  delivery: "builtin",
  defaultInstalled: true,
  author: theme.manifest.author,
  license: theme.manifest.license,
  sourceUrl: theme.manifest.sourceUrl,
  minWriteXVersion: "0.4.0",
}));

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "writex-theme-service-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function waitForStatus(service: ThemeService, id: string, status: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for ${id}:${status}`));
    }, 1500);
    const unsubscribe = service.subscribe(() => {
      if (service.listThemes().find(item => item.id === id)?.status !== status) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
}

test("ThemeService exposes built-ins immediately and never falls back for a missing theme", async () => {
  await withRoot(async root => {
    const store = new ThemeStore(root);
    const installer = new ThemeInstaller(store, builtinCatalog, async () => new Uint8Array());
    const service = new ThemeService({ store, installer, catalog: builtinCatalog });
    await service.initialize();
    assert.equal(service.getTheme("default").manifest.name, "默认");
    assert.equal(service.getTheme("xiaohei").manifest.name, "小黑");
    assert.equal(service.listThemes().find(item => item.id === "default")?.error, undefined);
    assert.equal(service.listThemes().find(item => item.id === "xiaohei")?.error, undefined);
    assert.match(service.render("正文", "xiaohei").html, /rgb\(89, 89, 89\)/);
    assert.throws(() => service.getTheme("missing"), error => error instanceof ThemeUnavailableError && error.themeId === "missing");
  });
});

test("starter Zen installs once in the background while offline failure keeps built-ins usable", async () => {
  await withRoot(async root => {
    const zen = packageBytes("zen", "1.0.0", "留白禅意");
    const catalog = [...builtinCatalog, downloadEntry("zen", zen, true)];
    const store = new ThemeStore(root);
    let downloads = 0;
    const installer = new ThemeInstaller(store, catalog, async () => {
      downloads += 1;
      return zen;
    });
    const service = new ThemeService({ store, installer, catalog });
    await service.initialize();
    const installed = waitForStatus(service, "zen", "installed");
    service.bootstrapStarterThemes();
    service.bootstrapStarterThemes();
    await installed;
    assert.equal(downloads, 1);
    assert.equal(service.getTheme("default").manifest.id, "default");
    assert.equal(service.getTheme("zen").manifest.name, "留白禅意");
  });

  await withRoot(async root => {
    const zen = packageBytes("zen", "1.0.0", "留白禅意");
    const catalog = [...builtinCatalog, downloadEntry("zen", zen, true)];
    const store = new ThemeStore(root);
    const installer = new ThemeInstaller(store, catalog, async () => { throw new Error("offline"); });
    const service = new ThemeService({ store, installer, catalog });
    await service.initialize();
    const waiting = waitForStatus(service, "zen", "waiting");
    service.bootstrapStarterThemes();
    await waiting;
    assert.match(service.render("仍可写作", "default").html, /仍可写作/);
  });
});

test("optional themes stay available until installation completes", async () => {
  await withRoot(async root => {
    const optional = packageBytes("pakco.optional");
    const catalog = [...builtinCatalog, downloadEntry("pakco.optional", optional)];
    const store = new ThemeStore(root);
    const installer = new ThemeInstaller(store, catalog, async () => optional);
    const service = new ThemeService({ store, installer, catalog });
    await service.initialize();
    assert.equal(service.listThemes().find(item => item.id === "pakco.optional")?.status, "available");
    await service.install("pakco.optional");
    assert.equal(service.listThemes().find(item => item.id === "pakco.optional")?.status, "installed");
  });
});

test("catalog only offers a real upgrade and never labels a newer local import as update", async () => {
  await withRoot(async root => {
    const newerCatalogBytes = packageBytes("pakco.newer", "1.0.0");
    const olderCatalogBytes = packageBytes("pakco.older", "1.0.0");
    const catalog = [
      ...builtinCatalog,
      downloadEntry("pakco.newer", newerCatalogBytes),
      downloadEntry("pakco.older", olderCatalogBytes),
    ];
    const store = new ThemeStore(root);
    await store.initialize();
    await store.install(packageBytes("pakco.newer", "1.1.0"), { sourceType: "import" });
    await store.install(packageBytes("pakco.older", "0.9.0"), { sourceType: "download" });
    const installer = new ThemeInstaller(store, catalog, async () => new Uint8Array());
    const service = new ThemeService({ store, installer, catalog });
    await service.initialize();

    assert.equal(service.listThemes().find(item => item.id === "pakco.newer")?.status, "installed");
    assert.equal(service.listThemes().find(item => item.id === "pakco.older")?.status, "update");
  });
});

test("Markdown parsing is cached by content while resolver and theme changes render fresh HTML", async () => {
  await withRoot(async root => {
    const store = new ThemeStore(root);
    const installer = new ThemeInstaller(store, builtinCatalog, async () => new Uint8Array());
    let parses = 0;
    const service = new ThemeService({
      store,
      installer,
      catalog: builtinCatalog,
      parseMarkdown: markdown => {
        parses += 1;
        return parseThemeMarkdown(markdown);
      },
    });
    await service.initialize();
    const markdown = "正文\n\n![图](a.png)";
    const preview = service.render(markdown, "default", source => `app:///${source}`);
    const copy = service.render(markdown, "xiaohei", source => `write-image://${source}`);
    assert.equal(parses, 1);
    assert.match(preview.html, /app:\/\/\/a\.png/);
    assert.match(copy.html, /write-image:\/\/a\.png/);
    service.render(`${markdown}\n\n新增`, "default");
    assert.equal(parses, 2);
  });
});

test("import updates refresh theme bytes and corrupt installed themes stay unavailable", async () => {
  await withRoot(async root => {
    const store = new ThemeStore(root);
    const installer = new ThemeInstaller(store, builtinCatalog, async () => new Uint8Array());
    const service = new ThemeService({ store, installer, catalog: builtinCatalog });
    await service.initialize();
    await service.import(packageBytes("pakco.custom"), { sourceType: "import" });
    const firstHash = service.render("正文", "pakco.custom").themeHash;
    const changed = JSON.parse(new TextDecoder().decode(packageBytes("pakco.custom", "1.1.0"))) as WriteXThemePackage;
    changed.components.paragraph.template = '<p style="color:#123456">{{children}}</p>';
    await service.import(new TextEncoder().encode(JSON.stringify(changed)), { sourceType: "import" });
    const updated = service.render("正文", "pakco.custom");
    assert.notEqual(updated.themeHash, firstHash);
    assert.match(updated.html, /#123456/);

    await writeFile(join(root, ".writex/themes/pakco.custom.writex-theme.json"), "corrupt");
    const restartedStore = new ThemeStore(root);
    const restartedInstaller = new ThemeInstaller(restartedStore, builtinCatalog, async () => new Uint8Array());
    const restarted = new ThemeService({ store: restartedStore, installer: restartedInstaller, catalog: builtinCatalog });
    await restarted.initialize();
    assert.throws(() => restarted.getTheme("pakco.custom"), /哈希|不可用/);
  });
});
