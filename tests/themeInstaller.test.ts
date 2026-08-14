import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BUILTIN_THEMES } from "../src/themeBuiltins.ts";
import type { ThemeCatalogEntry } from "../src/themeCatalog.ts";
import { ThemeInstaller, themeInstallWriteCredits } from "../src/themeInstaller.ts";
import { ThemeStore } from "../src/themeStore.ts";
import type { WriteXThemePackage } from "../src/themeSchema.ts";

function themeBytes(version = "1.0.0"): Uint8Array {
  const theme = structuredClone(BUILTIN_THEMES.default) as WriteXThemePackage;
  theme.manifest.id = "pakco.remote";
  theme.manifest.name = "Remote";
  theme.manifest.version = version;
  return new TextEncoder().encode(`${JSON.stringify(theme, null, 2)}\n`);
}

function entry(bytes: Uint8Array, overrides: Partial<ThemeCatalogEntry> = {}): ThemeCatalogEntry {
  return {
    id: "pakco.remote",
    name: "Remote",
    version: "1.0.0",
    delivery: "download",
    defaultInstalled: false,
    downloadUrl: "https://example.com/pakco.remote.writex-theme.json",
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    author: "Pakco",
    license: "MIT",
    sourceUrl: "https://example.com/source",
    minWriteXVersion: "0.4.0",
    ...overrides,
  };
}

async function withStore(run: (store: ThemeStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "writex-installer-"));
  try {
    const store = new ThemeStore(root);
    await store.initialize();
    await run(store);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("ThemeInstaller reports exact static download stages and sends only URL plus cancellation", async () => {
  await withStore(async store => {
    const source = themeBytes();
    const requests: string[][] = [];
    const installer = new ThemeInstaller(store, [entry(source)], async request => {
      requests.push(Object.keys(request).sort());
      return source;
    });
    const stages: string[] = [];
    installer.subscribe(task => stages.push(task.stage));

    const record = await installer.install("pakco.remote");
    assert.equal(record.version, "1.0.0");
    assert.deepEqual(stages, ["checking", "downloading", "verifying", "installing", "done"]);
    assert.deepEqual(requests, [["signal", "url"]]);
    assert.equal(themeInstallWriteCredits("pakco.remote"), 0);
  });
});

test("hash mismatch, missing release metadata, and cancellation never install a theme", async () => {
  await withStore(async store => {
    const source = themeBytes();
    const badHash = new ThemeInstaller(store, [entry(source, { sha256: "0".repeat(64) })], async () => source);
    await assert.rejects(badHash.install("pakco.remote"), /SHA-256/);
    assert.equal(store.list().length, 0);
    assert.equal(badHash.getTask("pakco.remote")?.stage, "failed");

    const unconfigured = new ThemeInstaller(store, [entry(source, { downloadUrl: undefined, sha256: undefined, byteLength: undefined })], async () => source);
    await assert.rejects(unconfigured.install("pakco.remote"), /发行包尚未配置/);
    assert.equal(unconfigured.getTask("pakco.remote")?.message, "发行包尚未配置");

    const cancelled = new ThemeInstaller(store, [entry(source)], request => new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    }));
    const running = cancelled.install("pakco.remote");
    cancelled.cancel("pakco.remote");
    await assert.rejects(running, /取消/);
    assert.equal(cancelled.getTask("pakco.remote")?.stage, "cancelled");
    assert.equal(store.list().length, 0);
  });
});

test("duplicate install clicks share one task and a failed update preserves the installed version", async () => {
  await withStore(async store => {
    const source = themeBytes();
    let resolveDownload: ((bytes: Uint8Array) => void) | undefined;
    let downloads = 0;
    const installer = new ThemeInstaller(store, [entry(source)], async () => {
      downloads += 1;
      return new Promise(resolve => { resolveDownload = resolve; });
    });
    const first = installer.install("pakco.remote");
    const second = installer.install("pakco.remote");
    assert.equal(first, second);
    resolveDownload?.(source);
    await first;
    assert.equal(downloads, 1);

    const updateBytes = themeBytes("1.1.0");
    const brokenUpdate = new ThemeInstaller(store, [entry(updateBytes, { version: "1.1.0", sha256: "f".repeat(64) })], async () => updateBytes);
    await assert.rejects(brokenUpdate.install("pakco.remote"), /SHA-256/);
    assert.equal((await store.load("pakco.remote"))?.manifest.version, "1.0.0");
  });
});
