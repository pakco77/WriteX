import { App, Modal, Notice, TFile } from "obsidian";
import type ObsidianAgentPlugin from "./main";
import { AGENT_LABELS } from "./chatAgents";
import { WRITING_STYLE_SKILL_PATH } from "./writingStyle";
import { renderStyleSkill } from "./writingStyle";
import { allocateWritingStyleSources } from "./writingStyleController";
import type { SelectionContext, WritingStyleProfile } from "./types";

export class WritingStyleModal extends Modal {
  private candidate = "";
  private sources: WritingStyleProfile["sources"] = [];
  private agent: WritingStyleProfile["agent"] = "codex";
  private model = "默认";
  private running = false;

  constructor(
    app: App,
    private readonly plugin: ObsidianAgentPlugin,
    private readonly selectionContext: SelectionContext | null,
  ) { super(app); }

  override onOpen(): void {
    this.modalEl.addClass("oa-writing-style-modal");
    this.render();
  }

  private render(): void {
    const profile = this.plugin.data.writingStyleProfile;
    this.setTitle(profile ? `我的文风 · v${profile.revision}` : "建立我的文风");
    const root = this.contentEl; root.empty();
    root.createEl("p", { text: "只有你确认后，文风才会写入本地档案；代表作只会在你点击提炼时发送给当前选择的 Agent。" });
    if (profile) this.renderConfirmedProfile(root, profile);
    else this.renderSourcePicker(root);
  }

  private renderConfirmedProfile(root: HTMLElement, profile: WritingStyleProfile): void {
    root.createEl("p", { cls: "oa-writing-style-meta", text: `提炼：${AGENT_LABELS[profile.agent]} · ${profile.model} · 修订于 ${new Date(profile.updatedAt).toLocaleString()}` });
    root.createEl("p", { cls: "oa-writing-style-meta", text: `代表作：${profile.sources.map(source => source.filePath ?? "当前选段").join("、") || "无"}` });
    const editor = root.createEl("textarea", { cls: "oa-writing-style-editor", attr: { "aria-label": "我的文风 Markdown", rows: "14" } });
    editor.value = this.candidate || profile.markdown;
    editor.oninput = () => { this.candidate = editor.value; };
    const actions = root.createDiv({ cls: "oa-writing-style-actions" });
    const confirm = actions.createEl("button", { cls: "mod-cta", text: "确认文风", attr: { type: "button" } });
    confirm.onclick = () => void this.confirm(editor.value, profile.sources, profile.agent, profile.model).catch(error => new Notice(errorMessage(error)));
    const reextract = actions.createEl("button", { text: "重新提炼", attr: { type: "button" } });
    reextract.onclick = () => { this.candidate = ""; this.sources = []; this.renderSourcePicker(root, true); };
    const exportButton = actions.createEl("button", { text: "导出为本地 Skill", attr: { type: "button", title: WRITING_STYLE_SKILL_PATH } });
    exportButton.onclick = () => this.renderExportConfirm(root, profile);
  }

  private renderSourcePicker(root: HTMLElement, replace = false): void {
    if (replace) root.empty();
    root.createEl("h3", { text: "明确选择代表作" });
    root.createEl("p", { text: `本次所有代表作共用 ${this.plugin.agentSettings.maxContextChars} 字上下文预算；WriteX 不会自动扫描正文或持续学习。` });
    const selected = new Set<string>();
    const sourceList = root.createDiv({ cls: "oa-writing-style-sources" });
    const summary = root.createEl("p", { cls: "oa-writing-style-meta", text: "未选择代表作。" });
    const updateSummary = async (): Promise<void> => {
      const inputs: Array<{ kind: "note" | "selection"; filePath?: string; content: string }> = [];
      if (selected.has("__selection__") && this.selectionContext) inputs.push({ kind: "selection", filePath: this.selectionContext.filePath, content: this.selectionContext.text });
      for (const path of selected) {
        if (path === "__selection__") continue;
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) inputs.push({ kind: "note", filePath: file.path, content: await this.app.vault.cachedRead(file) });
      }
      const allocated = allocateWritingStyleSources(inputs, this.plugin.agentSettings.maxContextChars, Date.now, () => "预览");
      const characters = allocated.reduce((total, source) => total + source.characterCount, 0);
      const included = allocated.reduce((total, source) => total + source.includedChars, 0);
      summary.setText(`已选择 ${allocated.length} 份代表作 · ${characters} 字；本次将发送 ${included} 字。${allocated.map(source => `\n${source.filePath ?? "当前选段"}：${source.includedChars}/${source.characterCount}${source.includedChars === 0 ? "（完全截断）" : source.includedChars < source.characterCount ? "（部分截断）" : ""}`).join("")}`);
    };
    if (this.selectionContext?.text.trim()) {
      const label = sourceList.createEl("label");
      const checkbox = label.createEl("input", { attr: { type: "checkbox" } });
      checkbox.checked = true; selected.add("__selection__");
      checkbox.onchange = () => { checkbox.checked ? selected.add("__selection__") : selected.delete("__selection__"); void updateSummary(); };
      label.createSpan({ text: `当前选段 · ${this.selectionContext.fileName} · ${this.selectionContext.text.length} 字` });
    }
    for (const file of this.app.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path))) {
      const label = sourceList.createEl("label");
      const checkbox = label.createEl("input", { attr: { type: "checkbox" } });
      checkbox.onchange = () => { checkbox.checked ? selected.add(file.path) : selected.delete(file.path); void updateSummary(); };
      label.createSpan({ text: file.path });
    }
    const extract = root.createEl("button", { cls: "mod-cta", text: "提炼候选文风", attr: { type: "button" } });
    extract.onclick = async () => {
      if (this.running) return;
      this.running = true; extract.disabled = true;
      try {
        const chosen: Array<{ kind: "note" | "selection"; filePath?: string; content: string }> = [];
        if (selected.has("__selection__") && this.selectionContext?.text.trim()) chosen.push({ kind: "selection", filePath: this.selectionContext.filePath, content: this.selectionContext.text });
        for (const path of selected) {
          if (path === "__selection__") continue;
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file instanceof TFile) chosen.push({ kind: "note", filePath: file.path, content: await this.app.vault.cachedRead(file) });
        }
        const extracted = await this.plugin.extractWritingStyle(chosen);
        this.candidate = extracted.markdown; this.sources = extracted.sources; this.agent = extracted.agent; this.model = extracted.model;
        this.renderCandidate(root);
      } catch (error) { new Notice(errorMessage(error)); }
      finally { this.running = false; extract.disabled = false; }
    };
    void updateSummary();
  }

  private renderCandidate(root: HTMLElement): void {
    root.empty();
    this.setTitle("确认候选文风");
    root.createEl("p", { text: `候选来自 ${this.sources.map(source => source.filePath ?? "当前选段").join("、")}；确认前不会覆盖现有档案。` });
    const current = this.plugin.data.writingStyleProfile;
    if (current) {
      root.createEl("h3", { text: "当前档案（用于对照）" });
      root.createEl("pre", { cls: "oa-writing-style-skill-preview", text: current.markdown });
    }
    const editor = root.createEl("textarea", { cls: "oa-writing-style-editor", attr: { "aria-label": "候选文风 Markdown", rows: "14" } });
    editor.value = this.candidate;
    editor.oninput = () => { this.candidate = editor.value; };
    const actions = root.createDiv({ cls: "oa-writing-style-actions" });
    const confirm = actions.createEl("button", { cls: "mod-cta", text: "确认文风", attr: { type: "button" } });
    confirm.onclick = () => void this.confirm(editor.value, this.sources, this.agent, this.model).catch(error => new Notice(errorMessage(error)));
    const cancel = actions.createEl("button", { text: "取消", attr: { type: "button" } });
    cancel.onclick = () => this.close();
  }

  private async confirm(markdown: string, sources: WritingStyleProfile["sources"], agent: WritingStyleProfile["agent"], model: string): Promise<void> {
    const value = markdown.trim();
    if (!value) { new Notice("文风档案不能为空。"); return; }
    const previous = this.plugin.data.writingStyleProfile;
    await this.plugin.saveWritingStyleProfile({
      markdown: value, sources: sources.length ? sources : previous?.sources ?? [], revision: (previous?.revision ?? 0) + 1,
      agent, model, createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now(), lastSkillExport: previous?.lastSkillExport,
    });
    new Notice("已确认我的文风；新笔记默认会使用它。");
    this.close();
  }

  private renderExportConfirm(root: HTMLElement, profile: WritingStyleProfile): void {
    root.empty(); this.setTitle("导出为本地 Skill");
    const absolutePath = `${this.plugin.getVaultBasePath()}/${WRITING_STYLE_SKILL_PATH}`;
    root.createEl("p", { text: `将创建或更新 ${absolutePath}。如果该文件被其它工具或你手动修改过，WriteX 会停止，不会覆盖。` });
    const preview = root.createEl("pre", { cls: "oa-writing-style-skill-preview" }); preview.setText(renderStyleSkill(profile));
    const actions = root.createDiv({ cls: "oa-writing-style-actions" });
    const confirm = actions.createEl("button", { cls: "mod-cta", text: "确认导出", attr: { type: "button" } });
    confirm.onclick = async () => { try { await this.plugin.exportWritingStyleSkill(); new Notice("已导出本地 Skill。"); this.close(); } catch (error) { new Notice(errorMessage(error)); } };
    actions.createEl("button", { text: "取消", attr: { type: "button" } }).onclick = () => this.render();
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
