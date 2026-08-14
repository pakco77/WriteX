import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CURRENT_PLUGIN_ID,
  LEGACY_PLUGIN_ID,
  isLegacyPluginEnabled,
  pluginDataPath,
  readInitialPluginData,
} from "../src/pluginMigration.ts";

class MemoryAdapter {
  reads: string[] = [];
  private readonly files: Record<string, string>;

  constructor(files: Record<string, string>) {
    this.files = files;
  }

  async exists(path: string): Promise<boolean> {
    return Object.hasOwn(this.files, path);
  }

  async read(path: string): Promise<string> {
    this.reads.push(path);
    const value = this.files[path];
    if (value === undefined) throw new Error(`missing ${path}`);
    return value;
  }
}

test("plugin IDs use the compliant public ID while retaining the one legacy source", () => {
  assert.equal(CURRENT_PLUGIN_ID, "writex");
  assert.equal(LEGACY_PLUGIN_ID, "obsidian-agent");
  assert.equal(pluginDataPath(".obsidian", CURRENT_PLUGIN_ID), ".obsidian/plugins/writex/data.json");
  assert.equal(pluginDataPath(".config/", LEGACY_PLUGIN_ID), ".config/plugins/obsidian-agent/data.json");
});

test("an existing writex data file always wins and the legacy file is not read", async () => {
  const current = { version: 5, settings: { syncRoute: "self-hosted" }, notes: { "new.md": {} } };
  const adapter = new MemoryAdapter({
    ".obsidian/plugins/writex/data.json": JSON.stringify(current),
    ".obsidian/plugins/obsidian-agent/data.json": JSON.stringify({ notes: { "old.md": {} } }),
  });

  const result = await readInitialPluginData(current, adapter, ".obsidian");

  assert.deepEqual(result, { data: current, source: "current" });
  assert.deepEqual(adapter.reads, []);
});

test("a first writex start copies legacy data without changing the legacy source", async () => {
  const legacy = {
    version: 5,
    settings: { syncRoute: "write-cloud", hasCloudToken: true },
    notes: { "article.md": { messages: [{ id: "m1", content: "kept" }], assets: [] } },
    topics: [{ id: "topic-1", title: "kept" }],
  };
  const legacyPath = ".obsidian/plugins/obsidian-agent/data.json";
  const adapter = new MemoryAdapter({ [legacyPath]: JSON.stringify(legacy) });

  const result = await readInitialPluginData(null, adapter, ".obsidian");

  assert.deepEqual(result, { data: legacy, source: "legacy", legacyPath });
  assert.deepEqual(adapter.reads, [legacyPath]);
});

test("a genuinely new install starts empty and malformed legacy data stops migration", async () => {
  assert.deepEqual(await readInitialPluginData(null, new MemoryAdapter({}), ".obsidian"), {
    data: null,
    source: "empty",
  });

  await assert.rejects(
    readInitialPluginData(null, new MemoryAdapter({
      ".obsidian/plugins/obsidian-agent/data.json": "{broken",
    }), ".obsidian"),
    /旧版 WriteX data\.json 无法解析/,
  );
  await assert.rejects(
    readInitialPluginData(null, new MemoryAdapter({
      ".obsidian/plugins/obsidian-agent/data.json": "[]",
    }), ".obsidian"),
    /旧版 WriteX data\.json 不是对象/,
  );
});

test("the new plugin refuses to load while the legacy plugin remains enabled", async () => {
  const path = ".obsidian/community-plugins.json";
  assert.equal(await isLegacyPluginEnabled(new MemoryAdapter({
    [path]: JSON.stringify(["obsidian-agent", "writex"]),
  }), ".obsidian"), true);
  assert.equal(await isLegacyPluginEnabled(new MemoryAdapter({
    [path]: JSON.stringify(["writex"]),
  }), ".obsidian"), false);
  assert.equal(await isLegacyPluginEnabled(new MemoryAdapter({}), ".obsidian"), false);
  await assert.rejects(
    isLegacyPluginEnabled(new MemoryAdapter({ [path]: "{}" }), ".obsidian"),
    /community-plugins\.json 不是数组/,
  );
});

test("a filesystem rehearsal copies legacy data byte-safely and leaves rollback data untouched", async t => {
  const root = await mkdtemp(join(tmpdir(), "writex-id-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = ".obsidian";
  const legacyRelativePath = pluginDataPath(configDir, LEGACY_PLUGIN_ID);
  const currentRelativePath = pluginDataPath(configDir, CURRENT_PLUGIN_ID);
  const legacyPath = join(root, legacyRelativePath);
  const currentPath = join(root, currentRelativePath);
  const legacyBytes = `${JSON.stringify({
    version: 5,
    settings: { syncRoute: "write-cloud", hasCloudToken: true },
    notes: { "article.md": { messages: [], assets: [], themeId: "moyu-green" } },
    topics: [{ id: "topic-1", title: "kept" }],
  }, null, 2)}\n`;
  await mkdir(join(root, configDir, "plugins", LEGACY_PLUGIN_ID), { recursive: true });
  await writeFile(legacyPath, legacyBytes, "utf8");
  await writeFile(join(root, configDir, "community-plugins.json"), JSON.stringify([CURRENT_PLUGIN_ID]), "utf8");
  const adapter = {
    exists: async (path: string) => {
      try {
        await readFile(join(root, path));
        return true;
      } catch {
        return false;
      }
    },
    read: async (path: string) => readFile(join(root, path), "utf8"),
  };

  assert.equal(await isLegacyPluginEnabled(adapter, configDir), false);
  const selected = await readInitialPluginData(null, adapter, configDir);
  assert.equal(selected.source, "legacy");
  await mkdir(join(root, configDir, "plugins", CURRENT_PLUGIN_ID), { recursive: true });
  await writeFile(currentPath, `${JSON.stringify(selected.data, null, 2)}\n`, "utf8");

  assert.equal(await readFile(legacyPath, "utf8"), legacyBytes);
  assert.deepEqual(JSON.parse(await readFile(currentPath, "utf8")), JSON.parse(legacyBytes));
});

test("ID migration keeps the legacy view type and every established SecretStorage key", async () => {
  const [manifestText, main, view, styles] = await Promise.all([
    readFile(new URL("../manifest.json", import.meta.url), "utf8"),
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/view.ts", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
  ]);
  assert.equal(JSON.parse(manifestText).id, "writex");
  assert.match(view, /VIEW_TYPE = "obsidian-agent-view"/);
  assert.match(styles, /data-type="obsidian-agent-view"/);
  assert.match(main, /"obsidian-agent-openai-image-key"/);
  assert.match(main, /"write-wechat-relay-key"/);
  assert.match(main, /"writex-cloud-access-token"/);
  assert.match(main, /"writex-cloud-installation-token"/);
});
