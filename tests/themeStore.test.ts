import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { BUILTIN_THEMES } from "../src/themeBuiltins.ts";
import { ThemeStore } from "../src/themeStore.ts";
import type { WriteXThemePackage } from "../src/themeSchema.ts";

function bytes(theme: WriteXThemePackage): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(theme, null, 2)}\n`);
}

function importedTheme(id = "pakco.test", version = "1.0.0"): WriteXThemePackage {
  const theme = structuredClone(BUILTIN_THEMES.default) as WriteXThemePackage;
  theme.manifest.id = id;
  theme.manifest.name = "Imported";
  theme.manifest.version = version;
  return theme;
}

async function withVault(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "writex-theme-store-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("ThemeStore installs, lists, loads, exports, and idempotently reuses identical bytes", async () => {
  await withVault(async root => {
    const store = new ThemeStore(root);
    await store.initialize();
    const source = bytes(importedTheme());
    const first = await store.install(source, { sourceType: "import" });
    const second = await store.install(source, { sourceType: "import" });

    assert.deepEqual(second, first);
    assert.equal(store.list().length, 1);
    assert.equal((await store.load("pakco.test"))?.manifest.name, "Imported");
    const exported = await store.export("pakco.test");
    assert.equal(exported.fileName, "pakco.test-1.0.0.writex-theme.json");
    assert.equal(JSON.parse(new TextDecoder().decode(exported.bytes)).manifest.license, "MIT");
    assert.equal(JSON.parse(await readFile(join(root, ".writex/themes/index.json"), "utf8")).records.length, 1);
  });
});

test("ThemeStore rejects same-version conflicts and backs up before a version update", async () => {
  await withVault(async root => {
    const store = new ThemeStore(root);
    await store.initialize();
    await store.install(bytes(importedTheme()), { sourceType: "import" });

    const conflict = importedTheme();
    conflict.manifest.description = "different bytes";
    await assert.rejects(store.install(bytes(conflict), { sourceType: "import" }), /版本.*冲突/);

    const updated = importedTheme("pakco.test", "1.1.0");
    await store.install(bytes(updated), { sourceType: "import" });
    assert.equal(store.list()[0]?.version, "1.1.0");
    const backups = await readdir(join(root, ".writex/backups/themes"));
    assert.equal(backups.length, 1);
    assert.match(await readFile(join(root, ".writex/backups/themes", backups[0]), "utf8"), /"version": "1.0.0"/);
  });
});

test("invalid or traversal imports preserve the old store and initialization removes temp files", async () => {
  await withVault(async root => {
    const store = new ThemeStore(root);
    await store.initialize();
    const original = await store.install(bytes(importedTheme()), { sourceType: "import" });
    const indexBefore = await readFile(join(root, ".writex/themes/index.json"), "utf8");

    await assert.rejects(store.install(new TextEncoder().encode("{broken"), { sourceType: "import" }), /JSON/);
    const traversal = importedTheme("../escape");
    await assert.rejects(store.install(bytes(traversal), { sourceType: "import" }), /id|格式/);
    assert.equal((await store.load("pakco.test"))?.manifest.version, "1.0.0");
    assert.equal(await readFile(join(root, ".writex/themes/index.json"), "utf8"), indexBefore);
    assert.equal(store.list()[0]?.sha256, original.sha256);

    await writeFile(join(root, ".writex/themes/orphan.tmp-123"), "partial");
    await mkdir(join(root, ".writex/themes/nested.tmp-456"));
    const restarted = new ThemeStore(root);
    await restarted.initialize();
    assert.deepEqual((await readdir(join(root, ".writex/themes"))).filter(name => name.includes(".tmp-")), []);
  });
});

test("only imported or compiled themes can change identity and built-ins cannot be deleted", async () => {
  await withVault(async root => {
    const store = new ThemeStore(root);
    await store.initialize();
    await store.install(bytes(importedTheme()), { sourceType: "import" });
    await store.duplicate("pakco.test", "pakco.copy", "Copy");
    assert.equal((await store.load("pakco.copy"))?.manifest.name, "Copy");
    await store.rename("pakco.copy", "pakco.renamed", "Renamed");
    assert.equal(await store.load("pakco.copy"), undefined);
    assert.equal((await store.load("pakco.renamed"))?.manifest.name, "Renamed");

    const downloaded = importedTheme("pakco.download");
    await store.install(bytes(downloaded), { sourceType: "download" });
    await assert.rejects(store.rename("pakco.download", "pakco.changed", "Changed"), /下载主题/);
    await assert.rejects(store.delete("default"), /内置/);
    await store.delete("pakco.renamed");
    assert.equal(await store.load("pakco.renamed"), undefined);
  });
});
