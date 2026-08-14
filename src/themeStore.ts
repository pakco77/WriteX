import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { getBuiltinTheme } from "./themeBuiltins.ts";
import { validateThemePackage, type WriteXThemePackage } from "./themeSchema.ts";

export interface ThemeCompileProvenance {
  sourcePath: string;
  sourceHash: string;
  agent: string;
  model?: string;
  compiledAt: number;
  themeHash: string;
}

export interface InstalledThemeRecord {
  id: string;
  version: string;
  sha256: string;
  installedAt: number;
  sourceType: "download" | "import" | "compiled";
  author: string;
  license: string;
  sourceUrl: string;
  provenance?: ThemeCompileProvenance;
}

export interface InstallMetadata {
  sourceType: InstalledThemeRecord["sourceType"];
  provenance?: ThemeCompileProvenance;
}

interface ThemeIndex {
  version: 1;
  records: InstalledThemeRecord[];
}

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{1,79}$/;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseThemeBytes(bytes: Uint8Array): WriteXThemePackage {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error(`主题 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
  const validation = validateThemePackage(value);
  if (!validation.ok || !validation.theme) {
    throw new Error(`主题校验失败：${validation.errors.join("；")}`);
  }
  return validation.theme;
}

async function readOptional(path: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeAtomic(path: string, bytes: Uint8Array | string): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class ThemeStore {
  private readonly themesDirectory: string;
  private readonly backupsDirectory: string;
  private readonly indexPath: string;
  private records: InstalledThemeRecord[] = [];

  constructor(vaultRoot: string) {
    this.themesDirectory = join(vaultRoot, ".writex", "themes");
    this.backupsDirectory = join(vaultRoot, ".writex", "backups", "themes");
    this.indexPath = join(this.themesDirectory, "index.json");
  }

  async initialize(): Promise<void> {
    await mkdir(this.themesDirectory, { recursive: true });
    await mkdir(this.backupsDirectory, { recursive: true });
    for (const entry of await readdir(this.themesDirectory, { withFileTypes: true })) {
      if (entry.name.includes(".tmp-")) {
        await rm(join(this.themesDirectory, entry.name), { recursive: entry.isDirectory(), force: true });
      }
    }
    const bytes = await readOptional(this.indexPath);
    if (!bytes) {
      this.records = [];
      await this.writeIndex(this.records);
      return;
    }
    let index: unknown;
    try {
      index = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      throw new Error(`主题索引 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!index || typeof index !== "object" || (index as ThemeIndex).version !== 1 || !Array.isArray((index as ThemeIndex).records)) {
      throw new Error("主题索引格式无效");
    }
    const records = (index as ThemeIndex).records;
    if (records.some(record => !record || !SAFE_ID.test(record.id) || typeof record.sha256 !== "string")) {
      throw new Error("主题索引包含无效记录");
    }
    this.records = records.map(record => ({ ...record }));
  }

  list(): InstalledThemeRecord[] {
    return this.records.map(record => ({ ...record, provenance: record.provenance ? { ...record.provenance } : undefined }));
  }

  async load(id: string): Promise<WriteXThemePackage | undefined> {
    const record = this.records.find(item => item.id === id);
    if (!record) return undefined;
    const bytes = await readFile(this.themePath(id));
    const actualHash = sha256(bytes);
    if (actualHash !== record.sha256) throw new Error(`主题 ${id} 文件哈希与索引不一致`);
    const theme = parseThemeBytes(bytes);
    if (theme.manifest.id !== id || theme.manifest.version !== record.version) {
      throw new Error(`主题 ${id} 文件身份与索引不一致`);
    }
    return theme;
  }

  async install(bytes: Uint8Array, metadata: InstallMetadata): Promise<InstalledThemeRecord> {
    const theme = parseThemeBytes(bytes);
    const hash = sha256(bytes);
    const existing = this.records.find(record => record.id === theme.manifest.id);
    if (existing?.version === theme.manifest.version) {
      if (existing.sha256 === hash) return { ...existing };
      throw new Error(`主题 ${theme.manifest.id} 的版本 ${theme.manifest.version} 与已安装文件冲突`);
    }

    const previousRecords = this.records.map(record => ({ ...record }));
    const path = this.themePath(theme.manifest.id);
    const previousTheme = await readOptional(path);
    const previousIndex = await readOptional(this.indexPath);
    if (existing && previousTheme) await this.backup(existing, path);

    const record: InstalledThemeRecord = {
      id: theme.manifest.id,
      version: theme.manifest.version,
      sha256: hash,
      installedAt: Date.now(),
      sourceType: metadata.sourceType,
      author: theme.manifest.author,
      license: theme.manifest.license,
      sourceUrl: theme.manifest.sourceUrl,
      provenance: metadata.provenance ? { ...metadata.provenance } : undefined,
    };
    const nextRecords = [...this.records.filter(item => item.id !== record.id), record]
      .sort((left, right) => left.id.localeCompare(right.id));

    try {
      await writeAtomic(path, bytes);
      await this.writeIndex(nextRecords);
      this.records = nextRecords;
      return { ...record };
    } catch (error) {
      this.records = previousRecords;
      if (previousTheme) await writeAtomic(path, previousTheme).catch(() => undefined);
      else await rm(path, { force: true }).catch(() => undefined);
      if (previousIndex) await writeAtomic(this.indexPath, previousIndex).catch(() => undefined);
      throw new Error(`主题 ${theme.manifest.id} 安装失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async export(id: string): Promise<{ fileName: string; bytes: Uint8Array }> {
    const record = this.requireRecord(id);
    const bytes = await readFile(this.themePath(id));
    parseThemeBytes(bytes);
    if (sha256(bytes) !== record.sha256) throw new Error(`主题 ${id} 文件哈希与索引不一致`);
    return { fileName: `${id}-${record.version}.writex-theme.json`, bytes };
  }

  async duplicate(id: string, newId: string, newName: string): Promise<InstalledThemeRecord> {
    const record = this.requireMutableRecord(id);
    const theme = await this.load(id);
    if (!theme) throw new Error(`主题 ${id} 不存在`);
    const copy = structuredClone(theme);
    copy.manifest.id = newId;
    copy.manifest.name = newName;
    return this.install(new TextEncoder().encode(`${JSON.stringify(copy, null, 2)}\n`), {
      sourceType: record.sourceType,
      provenance: record.provenance,
    });
  }

  async rename(id: string, newId: string, newName: string): Promise<InstalledThemeRecord> {
    const record = this.requireMutableRecord(id);
    const renamed = await this.duplicate(id, newId, newName);
    try {
      await this.delete(id);
      return renamed;
    } catch (error) {
      await this.delete(renamed.id).catch(() => undefined);
      throw new Error(`主题 ${id} 重命名失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async delete(id: string): Promise<void> {
    if (getBuiltinTheme(id)) throw new Error(`内置主题 ${id} 不能删除`);
    const record = this.records.find(item => item.id === id);
    if (!record) return;
    const path = this.themePath(id);
    await this.backup(record, path);
    const nextRecords = this.records.filter(item => item.id !== id);
    await this.writeIndex(nextRecords);
    await rm(path, { force: true });
    this.records = nextRecords;
  }

  private themePath(id: string): string {
    if (!SAFE_ID.test(id) || basename(id) !== id) throw new Error(`主题 id 格式无效：${id}`);
    return join(this.themesDirectory, `${id}.writex-theme.json`);
  }

  private requireRecord(id: string): InstalledThemeRecord {
    const record = this.records.find(item => item.id === id);
    if (!record) throw new Error(`主题 ${id} 不存在`);
    return record;
  }

  private requireMutableRecord(id: string): InstalledThemeRecord {
    const record = this.requireRecord(id);
    if (record.sourceType === "download") throw new Error(`下载主题 ${id} 不能更改身份，请先复制为自定义主题`);
    return record;
  }

  private async backup(record: InstalledThemeRecord, path: string): Promise<void> {
    const suffix = `${record.id}-${record.version}-${record.sha256.slice(0, 8)}-${Date.now()}.writex-theme.json`;
    await copyFile(path, join(this.backupsDirectory, suffix));
  }

  private async writeIndex(records: InstalledThemeRecord[]): Promise<void> {
    const index: ThemeIndex = { version: 1, records };
    await writeAtomic(this.indexPath, `${JSON.stringify(index, null, 2)}\n`);
  }
}
