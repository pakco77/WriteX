import { createHash } from "node:crypto";
import { BUILTIN_THEMES } from "./themeBuiltins.ts";
import type { ThemeCatalogEntry } from "./themeCatalog.ts";
import { ThemeInstaller, type ThemeInstallTask } from "./themeInstaller.ts";
import { extractThemeFrontmatter, parseThemeMarkdown, type ThemeMarkdownNode } from "./themeMarkdown.ts";
import {
  renderParsedTheme,
  type ThemeRenderResult,
} from "./themeRenderer.ts";
import type { WriteXThemePackage } from "./themeSchema.ts";
import {
  ThemeStore,
  type InstallMetadata,
  type InstalledThemeRecord,
} from "./themeStore.ts";

export type ThemeAvailabilityStatus =
  | "builtin" | "installed" | "available" | "update"
  | "installing" | "waiting" | "failed";

export interface ThemeListItem extends ThemeCatalogEntry {
  status: ThemeAvailabilityStatus;
  installedVersion?: string;
  sourceType?: InstalledThemeRecord["sourceType"] | "builtin";
  error?: string;
  task?: ThemeInstallTask;
}

export interface ThemeServiceRenderResult extends ThemeRenderResult {
  themeName: string;
  themeHash: string;
}

export interface ThemeServiceOptions {
  store: ThemeStore;
  installer: ThemeInstaller;
  catalog: readonly ThemeCatalogEntry[];
  parseMarkdown?: (markdown: string) => ThemeMarkdownNode[];
}

interface LoadedTheme {
  theme: WriteXThemePackage;
  hash: string;
  record?: InstalledThemeRecord;
}

export class ThemeUnavailableError extends Error {
  readonly themeId: string;

  constructor(themeId: string, detail?: string) {
    super(`排版 ${themeId} 不可用${detail ? `：${detail}` : ""}`);
    this.name = "ThemeUnavailableError";
    this.themeId = themeId;
  }
}

function hashBytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

export class ThemeService {
  private readonly store: ThemeStore;
  private readonly installer: ThemeInstaller;
  private readonly catalog: readonly ThemeCatalogEntry[];
  private readonly catalogById: Map<string, ThemeCatalogEntry>;
  private readonly parseMarkdown: (markdown: string) => ThemeMarkdownNode[];
  private readonly loaded = new Map<string, LoadedTheme>();
  private readonly unavailable = new Map<string, string>();
  private readonly parseCache = new Map<string, ThemeMarkdownNode[]>();
  private readonly listeners = new Set<() => void>();
  private readonly starterAttempts = new Set<string>();

  constructor(options: ThemeServiceOptions) {
    this.store = options.store;
    this.installer = options.installer;
    this.catalog = options.catalog;
    this.catalogById = new Map(options.catalog.map(entry => [entry.id, entry]));
    this.parseMarkdown = options.parseMarkdown ?? parseThemeMarkdown;
    this.installer.subscribe(() => this.notify());
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    this.loaded.clear();
    this.unavailable.clear();
    for (const theme of Object.values(BUILTIN_THEMES)) {
      this.loaded.set(theme.manifest.id, {
        theme,
        hash: hashBytes(JSON.stringify(theme)),
      });
    }
    for (const record of this.store.list()) await this.refreshRecord(record.id);
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listThemes(): ThemeListItem[] {
    const items: ThemeListItem[] = [];
    const seen = new Set<string>();
    for (const entry of this.catalog) {
      seen.add(entry.id);
      items.push(this.catalogItem(entry));
    }
    for (const record of this.store.list()) {
      if (seen.has(record.id)) continue;
      const loaded = this.loaded.get(record.id);
      items.push({
        id: record.id,
        name: loaded?.theme.manifest.name ?? record.id,
        version: record.version,
        delivery: "download",
        defaultInstalled: false,
        author: record.author,
        license: record.license,
        sourceUrl: record.sourceUrl,
        minWriteXVersion: loaded?.theme.manifest.minWriteXVersion ?? "0.4.0",
        status: this.unavailable.has(record.id) ? "failed" : "installed",
        installedVersion: record.version,
        sourceType: record.sourceType,
        error: this.unavailable.get(record.id),
      });
    }
    return items;
  }

  getTheme(id: string): WriteXThemePackage {
    const loaded = this.loaded.get(id);
    if (loaded) return loaded.theme;
    throw new ThemeUnavailableError(id, this.unavailable.get(id));
  }

  render(
    markdown: string,
    id: string,
    resolveImage?: (source: string) => string,
  ): ThemeServiceRenderResult {
    const loaded = this.loaded.get(id);
    if (!loaded) throw new ThemeUnavailableError(id, this.unavailable.get(id));
    const contentHash = hashBytes(markdown);
    let nodes = this.parseCache.get(contentHash);
    if (!nodes) {
      nodes = this.parseMarkdown(markdown);
      this.parseCache.set(contentHash, nodes);
      if (this.parseCache.size > 20) this.parseCache.delete(this.parseCache.keys().next().value as string);
    } else {
      this.parseCache.delete(contentHash);
      this.parseCache.set(contentHash, nodes);
    }
    const result = renderParsedTheme(nodes, loaded.theme, resolveImage, extractThemeFrontmatter(markdown));
    return {
      ...result,
      themeName: loaded.theme.manifest.name,
      themeHash: loaded.hash,
    };
  }

  async install(id: string): Promise<void> {
    await this.installer.install(id);
    await this.refreshRecord(id);
    this.notify();
  }

  cancelInstall(id: string): void {
    this.installer.cancel(id);
  }

  async import(bytes: Uint8Array, metadata: InstallMetadata = { sourceType: "import" }): Promise<InstalledThemeRecord> {
    const record = await this.store.install(bytes, metadata);
    await this.refreshRecord(record.id);
    this.notify();
    return record;
  }

  async export(id: string): Promise<{ fileName: string; bytes: Uint8Array }> {
    const builtin = BUILTIN_THEMES[id as keyof typeof BUILTIN_THEMES];
    if (builtin) {
      return {
        fileName: `${id}-${builtin.manifest.version}.writex-theme.json`,
        bytes: new TextEncoder().encode(`${JSON.stringify(builtin, null, 2)}\n`),
      };
    }
    return this.store.export(id);
  }

  async duplicate(id: string, newId: string, newName: string): Promise<void> {
    const record = await this.store.duplicate(id, newId, newName);
    await this.refreshRecord(record.id);
    this.notify();
  }

  async rename(id: string, newId: string, newName: string): Promise<void> {
    const record = await this.store.rename(id, newId, newName);
    this.loaded.delete(id);
    this.unavailable.delete(id);
    await this.refreshRecord(record.id);
    this.notify();
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(id);
    this.loaded.delete(id);
    this.unavailable.delete(id);
    this.notify();
  }

  bootstrapStarterThemes(): void {
    for (const entry of this.catalog) {
      if (entry.delivery !== "download" || !entry.defaultInstalled || this.loaded.has(entry.id) || this.starterAttempts.has(entry.id)) continue;
      this.starterAttempts.add(entry.id);
      void this.install(entry.id).catch(() => this.notify());
    }
  }

  private catalogItem(entry: ThemeCatalogEntry): ThemeListItem {
    const loaded = this.loaded.get(entry.id);
    const record = loaded?.record;
    const task = this.installer.getTask(entry.id);
    let status: ThemeAvailabilityStatus;
    if (entry.delivery === "builtin") status = "builtin";
    else if (task && ["checking", "downloading", "verifying", "installing"].includes(task.stage)) status = "installing";
    else if (loaded) status = record && compareVersions(entry.version, record.version) > 0 ? "update" : "installed";
    else if (task?.stage === "failed") status = entry.defaultInstalled ? "waiting" : "failed";
    else status = "available";
    return {
      ...entry,
      status,
      installedVersion: record?.version,
      sourceType: entry.delivery === "builtin" ? "builtin" : record?.sourceType,
      error: this.unavailable.get(entry.id) ?? task?.error
        ?? (entry.delivery === "download" && !entry.downloadUrl ? "发行包尚未配置" : undefined),
      task,
    };
  }

  private async refreshRecord(id: string): Promise<void> {
    const record = this.store.list().find(item => item.id === id);
    if (!record) return;
    try {
      const theme = await this.store.load(id);
      if (!theme) throw new Error("主题文件不存在");
      this.loaded.set(id, { theme, hash: record.sha256, record });
      this.unavailable.delete(id);
    } catch (error) {
      this.loaded.delete(id);
      this.unavailable.set(id, error instanceof Error ? error.message : String(error));
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
