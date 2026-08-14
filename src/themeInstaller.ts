import { createHash } from "node:crypto";
import type { ThemeCatalogEntry } from "./themeCatalog.ts";
import { validateThemePackage } from "./themeSchema.ts";
import { ThemeStore, type InstalledThemeRecord } from "./themeStore.ts";

export type ThemeInstallStage =
  | "idle" | "checking" | "downloading" | "verifying"
  | "installing" | "done" | "failed" | "cancelled";

export interface ThemeInstallTask {
  themeId: string;
  stage: ThemeInstallStage;
  message: string;
  startedAt: number;
  error?: string;
}

export interface ThemeDownloadRequest {
  url: string;
  signal: AbortSignal;
}

export type ThemeDownloadTransport = (request: ThemeDownloadRequest) => Promise<Uint8Array>;

interface RunningInstall {
  controller: AbortController;
  promise: Promise<InstalledThemeRecord>;
}

export function themeInstallWriteCredits(_themeId: string): 0 {
  return 0;
}

export class ThemeInstaller {
  private readonly store: ThemeStore;
  private readonly transport: ThemeDownloadTransport;
  private readonly catalog: Map<string, ThemeCatalogEntry>;
  private readonly tasks = new Map<string, ThemeInstallTask>();
  private readonly running = new Map<string, RunningInstall>();
  private readonly listeners = new Set<(task: ThemeInstallTask) => void>();

  constructor(
    store: ThemeStore,
    entries: readonly ThemeCatalogEntry[],
    transport: ThemeDownloadTransport,
  ) {
    this.store = store;
    this.transport = transport;
    this.catalog = new Map(entries.map(entry => [entry.id, entry]));
  }

  subscribe(listener: (task: ThemeInstallTask) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getTask(themeId: string): ThemeInstallTask | undefined {
    const task = this.tasks.get(themeId);
    return task ? { ...task } : undefined;
  }

  install(themeId: string): Promise<InstalledThemeRecord> {
    const active = this.running.get(themeId);
    if (active) return active.promise;
    const controller = new AbortController();
    const startedAt = Date.now();
    this.update({ themeId, stage: "checking", message: "正在检查", startedAt });
    const promise = this.execute(themeId, controller, startedAt);
    this.running.set(themeId, { controller, promise });
    return promise;
  }

  cancel(themeId: string): void {
    this.running.get(themeId)?.controller.abort();
  }

  private async execute(themeId: string, controller: AbortController, startedAt: number): Promise<InstalledThemeRecord> {
    try {
      const entry = this.catalog.get(themeId);
      if (!entry) throw new Error(`排版 ${themeId} 不在本地目录中`);
      if (entry.delivery !== "download") throw new Error(`内置排版 ${themeId} 无需安装`);
      if (!entry.downloadUrl || !entry.sha256 || entry.byteLength === undefined) {
        throw new Error("发行包尚未配置");
      }

      this.update({ themeId, stage: "downloading", message: "正在下载", startedAt });
      const bytes = await this.transport({ url: entry.downloadUrl, signal: controller.signal });
      this.assertNotCancelled(controller.signal);

      this.update({ themeId, stage: "verifying", message: "正在校验", startedAt });
      if (bytes.byteLength !== entry.byteLength) {
        throw new Error(`下载大小不匹配：预期 ${entry.byteLength}，实际 ${bytes.byteLength}`);
      }
      const actualHash = createHash("sha256").update(bytes).digest("hex");
      if (actualHash !== entry.sha256) throw new Error("主题 SHA-256 校验失败");
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder().decode(bytes));
      } catch (error) {
        throw new Error(`主题 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`);
      }
      const validation = validateThemePackage(value);
      if (!validation.ok || !validation.theme) throw new Error(`主题校验失败：${validation.errors.join("；")}`);
      if (validation.theme.manifest.id !== entry.id || validation.theme.manifest.version !== entry.version) {
        throw new Error("主题身份或版本与固定目录不一致");
      }
      this.assertNotCancelled(controller.signal);

      this.update({ themeId, stage: "installing", message: "正在安装", startedAt });
      const record = await this.store.install(bytes, { sourceType: "download" });
      this.assertNotCancelled(controller.signal);
      this.update({ themeId, stage: "done", message: "已安装", startedAt });
      return record;
    } catch (error) {
      const cancelled = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
      const message = cancelled ? "安装已取消" : error instanceof Error ? error.message : String(error);
      this.update({
        themeId,
        stage: cancelled ? "cancelled" : "failed",
        message: cancelled ? "已取消" : message,
        startedAt,
        error: message,
      });
      throw new Error(message);
    } finally {
      this.running.delete(themeId);
    }
  }

  private assertNotCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new DOMException("cancelled", "AbortError");
  }

  private update(task: ThemeInstallTask): void {
    this.tasks.set(task.themeId, task);
    for (const listener of this.listeners) listener({ ...task });
  }
}
