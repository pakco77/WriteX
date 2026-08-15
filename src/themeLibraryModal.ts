import { createHash } from "node:crypto";
import { App, FuzzySuggestModal, Modal, Notice, TFile } from "obsidian";
import type ObsidianAgentPlugin from "./main";
import { AGENT_LABELS, configuredAgentModel } from "./chatAgents.ts";
import {
  filterThemeRows,
  themeActions,
  type ThemeLibraryAction,
  type ThemeLibraryFilter,
} from "./themeLibrary.ts";
import type { LocalSkill } from "./skills.ts";
import {
  MAX_THEME_SOURCE_BYTES,
  parseThemeCompileResult,
  type ThemeCompileSource,
  type ThemeCompileStage,
} from "./themeCompiler.ts";
import { renderTheme } from "./themeRenderer.ts";
import type { ThemeService, ThemeListItem } from "./themeService.ts";
import { validateThemePackage } from "./themeSchema.ts";

const FILTERS: Array<{ id: ThemeLibraryFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "installed", label: "已安装" },
  { id: "available", label: "可安装" },
  { id: "update", label: "有更新" },
  { id: "failed", label: "失败" },
];

const ACTION_LABELS: Record<ThemeLibraryAction, string> = {
  install: "安装",
  retry: "重试",
  cancel: "取消安装",
  select: "使用",
  export: "导出",
  duplicate: "复制",
  rename: "重命名",
  delete: "删除",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusLabel(item: ThemeListItem): string {
  if (item.status === "builtin") return "内置 · 已安装";
  if (item.status === "installed") return "已安装";
  if (item.status === "available") return "可安装";
  if (item.status === "update") return "有更新";
  if (item.status === "installing") return item.task?.message || "正在安装";
  if (item.status === "waiting") return "等待网络";
  return `失败${item.error ? ` · ${item.error}` : ""}`;
}

class ThemeConfirmModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly heading: string,
    private readonly detail: string,
    private readonly confirmLabel: string,
    private readonly settle: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(this.heading);
    this.contentEl.createEl("p", { text: this.detail });
    const actions = this.contentEl.createDiv({ cls: "oa-modal-actions" });
    const cancel = actions.createEl("button", { text: "取消", attr: { type: "button" } });
    cancel.onclick = () => this.close();
    const confirm = actions.createEl("button", { cls: "mod-cta", text: this.confirmLabel, attr: { type: "button" } });
    confirm.onclick = () => {
      this.settled = true;
      this.settle(true);
      this.close();
    };
  }

  override onClose(): void {
    if (!this.settled) this.settle(false);
  }
}

class ThemeSkillSourceModal extends FuzzySuggestModal<LocalSkill> {
  constructor(app: App, private readonly skills: LocalSkill[], private readonly choose: (skill: LocalSkill) => void) {
    super(app);
    this.setPlaceholder("选择已安装的排版 Skill…");
  }

  getItems(): LocalSkill[] {
    return this.skills;
  }

  getItemText(skill: LocalSkill): string {
    return `${skill.name} · ${skill.description} · ${skill.rootLabel}`;
  }

  onChooseItem(skill: LocalSkill): void {
    this.choose(skill);
  }
}

class ThemeVaultSourceModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private readonly choose: (file: TFile) => void) {
    super(app);
    this.setPlaceholder("选择 Vault 中的 MD 或 HTML 排版源…");
  }

  getItems(): TFile[] {
    return this.app.vault.getFiles().filter(file => file.extension === "md" || file.extension === "html");
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.choose(file);
  }
}

class ThemeCompilePreviewModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly themeName: string,
    private readonly detail: string,
    private readonly html: string,
    private readonly settle: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("oa-theme-compile-preview-modal");
    this.setTitle(`预览编译排版 · ${this.themeName}`);
    this.contentEl.createEl("p", { text: this.detail });
    const preview = this.contentEl.createDiv({ cls: "oa-theme-compile-preview" });
    preview.appendChild(document.createRange().createContextualFragment(this.html));
    const actions = this.contentEl.createDiv({ cls: "oa-modal-actions" });
    const cancel = actions.createEl("button", { text: "不安装", attr: { type: "button" } });
    cancel.onclick = () => this.close();
    const install = actions.createEl("button", { cls: "mod-cta", text: "确认安装", attr: { type: "button" } });
    install.onclick = () => {
      this.settled = true;
      this.settle(true);
      this.close();
    };
  }

  override onClose(): void {
    if (!this.settled) this.settle(false);
  }
}

export class ThemeLibraryModal extends Modal {
  private query = "";
  private filter: ThemeLibraryFilter = "all";
  private unsubscribe: (() => void) | null = null;
  private busyAction = "";
  private compileStage: ThemeCompileStage = "idle";
  private compileError = "";
  private compileSource: ThemeCompileSource | null = null;
  private compileController: AbortController | null = null;
  private readonly service: ThemeService;

  constructor(
    private readonly plugin: ObsidianAgentPlugin,
    private currentId: string,
    private readonly selectTheme: (themeId: string) => Promise<void>,
  ) {
    super(plugin.app);
    this.service = plugin.themeService;
  }

  override onOpen(): void {
    this.modalEl.addClass("oa-chat-modal", "oa-theme-library-modal");
    this.setTitle("排版库");
    this.unsubscribe = this.service.subscribe(() => this.render());
    this.render();
  }

  override onClose(): void {
    this.compileController?.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.contentEl.empty();
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();
    const controls = container.createDiv({ cls: "oa-theme-library-controls" });
    const search = controls.createEl("input", {
      cls: "oa-chat-search",
      attr: { type: "search", placeholder: "搜索名称、作者、许可证或来源", "aria-label": "搜索排版" },
    });
    search.value = this.query;
    search.oninput = () => {
      this.query = search.value;
      this.renderRows();
    };
    const importButton = controls.createEl("button", { text: "导入本地排版", attr: { type: "button" } });
    importButton.onclick = () => this.chooseImport();
    const skillButton = controls.createEl("button", { text: "从 Skill 编译", attr: { type: "button" } });
    skillButton.disabled = this.isCompiling();
    skillButton.onclick = () => void this.chooseSkillSource();
    const fileButton = controls.createEl("button", { text: "从 MD/HTML 编译", attr: { type: "button" } });
    fileButton.disabled = this.isCompiling();
    fileButton.onclick = () => this.chooseVaultSource();

    if (this.compileStage !== "idle") {
      const task = container.createDiv({ cls: `oa-theme-compile-task is-${this.compileStage}` });
      task.createEl("strong", { text: this.compileStageLabel() });
      if (this.compileSource) task.createEl("span", { text: this.compileSource.path });
      if (this.compileError) task.createEl("small", { cls: "oa-theme-compile-error", text: this.compileError });
      if (this.isCompiling()) {
        const cancel = task.createEl("button", { text: "取消", attr: { type: "button" } });
        cancel.onclick = () => {
          this.compileController?.abort();
          this.compileStage = "cancelled";
          this.render();
        };
      }
    }

    const chips = container.createDiv({ cls: "oa-theme-library-filters" });
    for (const option of FILTERS) {
      const chip = chips.createEl("button", { text: option.label, attr: { type: "button" } });
      chip.toggleClass("is-active", option.id === this.filter);
      chip.onclick = () => {
        this.filter = option.id;
        this.render();
      };
    }
    container.createDiv({ cls: "oa-theme-library-list" });
    this.renderRows();
  }

  private renderRows(): void {
    const list = this.contentEl.querySelector<HTMLElement>(".oa-theme-library-list");
    if (!list) return;
    list.empty();
    const rows = filterThemeRows(this.service.listThemes(), this.query, this.filter);
    for (const item of rows) this.renderRow(list, item);
    if (!rows.length) list.createEl("p", { cls: "oa-skill-no-results", text: "没有匹配的排版。" });
  }

  private renderRow(container: HTMLElement, item: ThemeListItem): void {
    const row = container.createDiv({ cls: "oa-theme-library-row" });
    row.toggleClass("is-current", item.id === this.currentId);
    const summary = row.createDiv({ cls: "oa-theme-library-summary" });
    const title = summary.createDiv({ cls: "oa-theme-library-title" });
    title.createEl("strong", { text: item.name });
    if (item.id === this.currentId) title.createEl("span", { cls: "oa-theme-current", text: "当前" });
    title.createEl("span", { cls: `oa-theme-status is-${item.status}`, text: statusLabel(item) });
    summary.createEl("small", { text: `${item.id} · v${item.version} · ${item.author} · ${item.license}` });
    if (/^https:\/\//i.test(item.sourceUrl)) {
      summary.createEl("a", { text: "查看来源", href: item.sourceUrl, attr: { target: "_blank", rel: "noreferrer" } });
    } else {
      summary.createEl("span", { cls: "oa-theme-source", text: item.sourceUrl });
    }
    if (item.error && item.status !== "failed" && item.status !== "waiting") {
      summary.createEl("small", { cls: "oa-theme-error", text: item.error });
    }

    const actions = row.createDiv({ cls: "oa-theme-library-actions" });
    for (const action of themeActions(item, this.currentId)) {
      const button = actions.createEl("button", { text: ACTION_LABELS[action], attr: { type: "button" } });
      button.toggleClass("mod-cta", action === "select" || action === "install" || action === "retry");
      button.disabled = Boolean(this.busyAction);
      button.onclick = () => void this.runAction(action, item);
    }
  }

  private async runAction(action: ThemeLibraryAction, item: ThemeListItem): Promise<void> {
    if (action === "cancel") {
      this.service.cancelInstall(item.id);
      return;
    }
    this.busyAction = `${item.id}:${action}`;
    this.render();
    try {
      if (action === "install" || action === "retry") await this.service.install(item.id);
      if (action === "select") {
        await this.selectTheme(item.id);
        this.currentId = item.id;
      }
      if (action === "export") await this.exportTheme(item.id);
      if (action === "duplicate") await this.duplicateTheme(item);
      if (action === "rename") await this.renameTheme(item);
      if (action === "delete") await this.deleteTheme(item);
    } catch (error) {
      new Notice(errorMessage(error));
    } finally {
      this.busyAction = "";
      this.render();
    }
  }

  private chooseImport(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".writex-theme.json,application/json";
    input.hidden = true;
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void this.importTheme(file);
      input.remove();
    };
    this.contentEl.appendChild(input);
    input.click();
  }

  private async chooseSkillSource(): Promise<void> {
    try {
      this.compileError = "";
      this.compileStage = "reading";
      this.render();
      const skills = await this.plugin.discoverSkills();
      this.compileStage = "idle";
      this.render();
      if (!skills.length) {
        new Notice("当前 Vault 还没有可用 Skill；可以先在 Chat 的 Skill 面板一键安装。 ");
        return;
      }
      new ThemeSkillSourceModal(this.app, skills, skill => {
        void this.compileSourceWithAgent({
          kind: "skill",
          name: skill.name,
          path: skill.skillFile,
          sha256: skill.sourceHash,
        });
      }).open();
    } catch (error) {
      this.compileError = errorMessage(error);
      this.compileStage = "failed";
      new Notice(this.compileError);
      this.render();
    }
  }

  private chooseVaultSource(): void {
    this.compileError = "";
    new ThemeVaultSourceModal(this.app, file => void this.readVaultSource(file)).open();
  }

  private async readVaultSource(file: TFile): Promise<void> {
    this.compileError = "";
    this.compileStage = "reading";
    this.render();
    try {
      const content = await this.app.vault.cachedRead(file);
      const bytes = new TextEncoder().encode(content);
      if (bytes.byteLength > MAX_THEME_SOURCE_BYTES) throw new Error("排版源超过 512 KiB，未发送给 Agent");
      await this.compileSourceWithAgent({
        kind: "vault",
        name: file.name,
        path: file.path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        content,
      });
    } catch (error) {
      this.compileError = errorMessage(error);
      this.compileStage = "failed";
      new Notice(this.compileError);
      this.render();
    }
  }

  private async compileSourceWithAgent(source: ThemeCompileSource): Promise<void> {
    this.compileSource = source;
    const agent = this.plugin.agentSettings.activeChatAgent;
    const model = configuredAgentModel(this.plugin.agentSettings, agent);
    const confirmed = await this.confirm(
      "确认一次性编译排版",
      `${source.name} · ${source.path} · SHA-256 ${source.sha256}。使用当前 Agent 账号/API 额度：${AGENT_LABELS[agent]} · ${model || "默认模型"}；WriteX 积分 0；只生成一个静态排版包，不进入 Chat 历史，不会切换到 WriteX Cloud。`,
      "确认调用 Agent",
    );
    if (!confirmed) {
      this.compileStage = "idle";
      this.render();
      return;
    }

    const controller = new AbortController();
    this.compileController = controller;
    this.compileError = "";
    this.compileStage = "compiling";
    this.render();
    try {
      const result = await this.plugin.compileThemeSource(source, agent, model, controller.signal);
      if (controller.signal.aborted) throw new DOMException("编译已取消", "AbortError");
      this.compileStage = "validating";
      this.render();
      const theme = parseThemeCompileResult(result.text);
      const bytes = new TextEncoder().encode(`${JSON.stringify(theme, null, 2)}\n`);
      const themeHash = createHash("sha256").update(bytes).digest("hex");
      const preview = renderTheme(
        "# 标题\n\n这是一段 **公众号正文**。\n\n> 这是引用。\n\n![图片](preview.png)",
        theme,
        () => "",
      );
      this.compileStage = "previewing";
      this.render();
      const install = await new Promise<boolean>(resolve => new ThemeCompilePreviewModal(
        this.app,
        theme.manifest.name,
        `${theme.manifest.id} · v${theme.manifest.version} · ${theme.manifest.author} · ${theme.manifest.license}`,
        preview.html,
        resolve,
      ).open());
      if (!install) {
        this.compileStage = "idle";
        this.render();
        return;
      }
      const compiledAt = Date.now();
      await this.service.import(bytes, {
        sourceType: "compiled",
        provenance: {
          sourcePath: source.path,
          sourceHash: source.sha256,
          agent,
          model: model || undefined,
          compiledAt,
          themeHash,
        },
      });
      this.compileError = "";
      this.compileStage = "done";
      new Notice(`已安装编译排版：${theme.manifest.name}`);
    } catch (error) {
      this.compileStage = controller.signal.aborted ? "cancelled" : "failed";
      this.compileError = controller.signal.aborted ? "" : errorMessage(error);
      if (this.compileError) new Notice(this.compileError);
    } finally {
      this.compileController = null;
      this.render();
    }
  }

  private isCompiling(): boolean {
    return ["reading", "compiling", "validating", "previewing"].includes(this.compileStage);
  }

  private compileStageLabel(): string {
    if (this.compileStage === "reading") return "正在读取排版源";
    if (this.compileStage === "compiling") return "Agent 正在编译排版";
    if (this.compileStage === "validating") return "正在本地校验排版包";
    if (this.compileStage === "previewing") return "正在预览，等待确认安装";
    if (this.compileStage === "done") return "排版已编译并安装";
    if (this.compileStage === "cancelled") return "编译已取消";
    if (this.compileStage === "failed") return "编译失败，可重新选择源文件";
    return "";
  }

  private async importTheme(file: File): Promise<void> {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder().decode(bytes));
      } catch (error) {
        throw new Error(`排版 JSON 无法解析：${errorMessage(error)}`);
      }
      const validation = validateThemePackage(value);
      if (!validation.ok || !validation.theme) throw new Error(`排版校验失败：${validation.errors.join("；")}`);
      const theme = validation.theme;
      const confirmed = await this.confirm(
        "确认导入本地排版",
        `${theme.manifest.name} · ${theme.manifest.id} · v${theme.manifest.version} · ${theme.manifest.author} · ${theme.manifest.license}。只写入当前 Vault 的 .writex/themes，不调用 Agent、不联网。`,
        "确认导入",
      );
      if (!confirmed) return;
      await this.service.import(bytes, { sourceType: "import" });
      new Notice(`已导入排版：${theme.manifest.name}`);
    } catch (error) {
      new Notice(errorMessage(error));
    }
  }

  private async exportTheme(id: string): Promise<void> {
    const exported = await this.service.export(id);
    const blob = new Blob([Uint8Array.from(exported.bytes).buffer], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement("a");
      link.href = url;
      link.download = exported.fileName;
      link.hidden = true;
      document.body.appendChild(link);
      link.click();
      link.remove();
      new Notice(`已请求导出 ${exported.fileName}；请在系统下载列表确认文件真实出现。`);
    } catch (error) {
      throw new Error(`宿主阻止了导出；排版仍保留在本地：${errorMessage(error)}`);
    } finally {
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }

  private async duplicateTheme(item: ThemeListItem): Promise<void> {
    const id = window.prompt("新排版 ID（小写字母、数字、点、横线或下划线）", `${item.id}.copy`)?.trim();
    if (!id) return;
    const name = window.prompt("新排版名称", `${item.name} 副本`)?.trim();
    if (!name) return;
    await this.service.duplicate(item.id, id, name);
  }

  private async renameTheme(item: ThemeListItem): Promise<void> {
    const id = window.prompt("新排版 ID", item.id)?.trim();
    if (!id) return;
    const name = window.prompt("新排版名称", item.name)?.trim();
    if (!name || (id === item.id && name === item.name)) return;
    await this.service.rename(item.id, id, name);
    if (this.currentId === item.id) {
      await this.selectTheme(id);
      this.currentId = id;
    }
  }

  private async deleteTheme(item: ThemeListItem): Promise<void> {
    const confirmed = await this.confirm(
      "确认删除排版",
      `删除 ${item.name} 后会在 .writex/backups/themes 保留备份。当前正在使用的排版不能删除。`,
      "确认删除",
    );
    if (confirmed) await this.service.delete(item.id);
  }

  private confirm(title: string, detail: string, label: string): Promise<boolean> {
    return new Promise(resolve => new ThemeConfirmModal(this.app, title, detail, label, resolve).open());
  }
}
