export const CURRENT_PLUGIN_ID = "writex";
export const LEGACY_PLUGIN_ID = "obsidian-agent";

export interface PluginMigrationAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
}

export type InitialPluginData =
  | { data: unknown; source: "current" }
  | { data: unknown; source: "legacy"; legacyPath: string }
  | { data: null; source: "empty" };

function configPath(configDir: string, ...segments: string[]): string {
  const root = configDir.replace(/\/+$/, "");
  return [root, ...segments.map(segment => segment.replace(/^\/+|\/+$/g, ""))].filter(Boolean).join("/");
}

function parseDataObject(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} data.json 无法解析。原文件未修改，请先恢复或修复后再迁移。`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} data.json 不是对象。原文件未修改，请先恢复或修复后再迁移。`);
  }
  return value as Record<string, unknown>;
}

export function pluginDataPath(configDir: string, pluginId: string): string {
  return configPath(configDir, "plugins", pluginId, "data.json");
}

export async function readInitialPluginData(
  currentData: unknown,
  adapter: PluginMigrationAdapter,
  configDir: string,
): Promise<InitialPluginData> {
  const currentPath = pluginDataPath(configDir, CURRENT_PLUGIN_ID);
  if (await adapter.exists(currentPath)) {
    if (!currentData || typeof currentData !== "object" || Array.isArray(currentData)) {
      throw new Error("当前 WriteX data.json 无法读取，已停止启动以避免覆盖。请先恢复该文件。");
    }
    return { data: currentData, source: "current" };
  }

  const legacyPath = pluginDataPath(configDir, LEGACY_PLUGIN_ID);
  if (!await adapter.exists(legacyPath)) return { data: null, source: "empty" };
  const legacy = parseDataObject(await adapter.read(legacyPath), "旧版 WriteX");
  return { data: legacy, source: "legacy", legacyPath };
}

export async function isLegacyPluginEnabled(
  adapter: PluginMigrationAdapter,
  configDir: string,
): Promise<boolean> {
  const path = configPath(configDir, "community-plugins.json");
  if (!await adapter.exists(path)) return false;
  let value: unknown;
  try {
    value = JSON.parse(await adapter.read(path));
  } catch {
    throw new Error("community-plugins.json 无法解析，无法确认旧版 WriteX 是否已停用。");
  }
  if (!Array.isArray(value)) throw new Error("community-plugins.json 不是数组，无法确认旧版 WriteX 是否已停用。");
  return value.includes(LEGACY_PLUGIN_ID);
}
