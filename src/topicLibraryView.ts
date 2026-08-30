import { ItemView, Menu, Modal, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type ObsidianAgentPlugin from "./main";
import { groupTopicsByCreatedAt } from "./topics";
import { saveQuickTopicInput, searchDraftForTopicActivation, shouldSaveQuickTopicOnKey, shouldScrollFocusedTopic } from "./topicLibraryController";
import type { TopicIdea } from "./types";

export const TOPIC_LIBRARY_VIEW_TYPE = "writex-topic-library-view";

interface TopicLibraryActivation {
  focusedTopicId?: string;
  candidateTargetPath?: string;
}

export class TopicLibraryView extends ItemView {
  private focusedTopicId = "";
  private candidateTargetPath = "";
  private quickDraft = "";
  private searchDraft = "";
  private saving = false;
  private topicCountEl: HTMLElement | null = null;
  private cardsEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: ObsidianAgentPlugin) {
    super(leaf);
  }

  override getViewType(): string { return TOPIC_LIBRARY_VIEW_TYPE; }
  override getDisplayText(): string { return "WriteX 选题库"; }
  override getIcon(): string { return "lightbulb"; }

  override async onOpen(): Promise<void> {
    this.contentEl.addClass("oa-topic-library-view");
    this.registerEvent(this.app.vault.on("rename", file => {
      if (file instanceof TFile && file.path === this.candidateTargetPath) this.render();
    }));
    this.render();
  }

  setActivation(activation: TopicLibraryActivation): void {
    if (activation.focusedTopicId) {
      this.focusedTopicId = activation.focusedTopicId;
      this.searchDraft = searchDraftForTopicActivation(this.searchDraft, activation.focusedTopicId);
    }
    if (activation.candidateTargetPath) this.candidateTargetPath = activation.candidateTargetPath;
    else if (!this.candidateTargetPath) {
      const active = this.app.workspace.getActiveFile();
      if (active instanceof TFile && active.extension === "md") this.candidateTargetPath = active.path;
    }
    this.render();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    const header = root.createDiv({ cls: "oa-topic-page-header" });
    header.createEl("h2", { text: "WriteX 选题库" });
    this.topicCountEl = header.createEl("span", { text: `${this.plugin.data.topics.length} 条` });
    root.createEl("p", { cls: "oa-topic-intro", text: "把还没开始写、但不想忘记的一句话收住。只保存在本地，不会自动调用 Agent。" });
    const controls = root.createDiv({ cls: "oa-topic-page-controls" });
    const quick = controls.createEl("input", { cls: "oa-topic-quick-input", attr: { type: "text", maxlength: "120", placeholder: "想到什么，回车收住……", "aria-label": "快速记录选题" } });
    quick.value = this.quickDraft;
    quick.disabled = this.saving;
    quick.oninput = () => { this.quickDraft = quick.value; };
    quick.onkeydown = event => {
      if (shouldSaveQuickTopicOnKey(event.key, event.isComposing)) { event.preventDefault(); void this.saveQuickTopic(quick); }
    };
    const search = controls.createEl("input", { cls: "oa-topic-search-input", attr: { type: "search", placeholder: "搜索标题或来源", "aria-label": "搜索选题" } });
    search.value = this.searchDraft;
    search.oninput = () => { this.searchDraft = search.value; this.renderCards(); };
    const targetRow = root.createDiv({ cls: "oa-topic-target-row" });
    targetRow.createEl("label", { text: "继续到", attr: { for: "writex-topic-target" } });
    const target = targetRow.createEl("select", { attr: { id: "writex-topic-target", "aria-label": "继续到目标笔记" } });
    target.createEl("option", { value: "", text: "选择一篇 Markdown 笔记…" });
    for (const file of this.app.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path))) {
      target.createEl("option", { value: file.path, text: file.path });
    }
    target.value = this.targetFile() ? this.candidateTargetPath : "";
    target.onchange = () => { this.candidateTargetPath = target.value; this.render(); };
    this.cardsEl = root.createDiv({ cls: "oa-topic-card-host" });
    this.renderCards();
  }

  private renderCards(): void {
    const cardsEl = this.cardsEl;
    if (!cardsEl) return;
    cardsEl.empty();
    this.topicCountEl?.setText(`${this.plugin.data.topics.length} 条`);
    const visible = this.visibleTopics();
    if (!visible.length) {
      const empty = cardsEl.createDiv({ cls: "oa-topic-empty" });
      const icon = empty.createSpan(); setIcon(icon, "lightbulb");
      empty.createEl("strong", { text: this.plugin.data.topics.length ? "没有匹配的选题。" : "一句话就够，先把它收住。" });
      return;
    }
    const cards = cardsEl.createDiv({ cls: "oa-topic-card-groups" });
    for (const group of groupTopicsByCreatedAt(visible)) {
      cards.createEl("h3", { cls: "oa-topic-group-title", text: group.label });
      const grid = cards.createDiv({ cls: "oa-topic-card-grid" });
      for (const topic of group.topics) this.renderTopicCard(grid, topic);
    }
  }

  private visibleTopics(): TopicIdea[] {
    const needle = this.searchDraft.trim().toLocaleLowerCase();
    if (!needle) return this.plugin.data.topics;
    return this.plugin.data.topics.filter(topic => `${topic.title}\n${this.sourceLabel(topic)}`.toLocaleLowerCase().includes(needle));
  }

  private renderTopicCard(grid: HTMLElement, topic: TopicIdea): void {
    const card = grid.createDiv({ cls: "oa-topic-card" });
    card.toggleClass("is-focused", topic.id === this.focusedTopicId);
    card.createEl("strong", { text: topic.title });
    card.createEl("small", { text: this.sourceLabel(topic) });
    card.createEl("time", { text: new Date(topic.createdAt).toLocaleString() });
    const actions = card.createDiv({ cls: "oa-topic-card-actions" });
    const send = actions.createEl("button", { text: "送入 WriteX Chat", attr: { type: "button", "aria-label": `将“${topic.title}”送入 WriteX Chat` } });
    send.onclick = async () => {
      if (!this.targetFile()) { new Notice("请先在“继续到”选择一篇仍存在的 Markdown 笔记。"); return; }
      send.disabled = true;
      try {
        const sent = await this.plugin.continueTopicToChat(topic.id, this.candidateTargetPath);
        if (!sent) new Notice("Chat 输入框已有内容，请先发送或清空；选题未被覆盖。 ");
      } catch (error) { new Notice(errorMessage(error)); }
      finally { send.disabled = false; }
    };
    const more = actions.createEl("button", { text: "···", attr: { type: "button", "aria-label": `更多操作：${topic.title}` } });
    more.onclick = event => { event.stopPropagation(); this.openTopicMenu(event, topic); };
    if (shouldScrollFocusedTopic(topic.id, this.focusedTopicId)) window.setTimeout(() => card.scrollIntoView({ block: "nearest" }), 0);
  }

  private sourceLabel(topic: TopicIdea): string {
    if (!topic.sourceNotePath) return topic.sourceKind === "chat" ? "来自 Chat" : "手动记录";
    const file = this.app.vault.getAbstractFileByPath(topic.sourceNotePath);
    return file instanceof TFile ? (topic.sourceKind === "chat" ? `来自 Chat · ${file.basename}` : `来自 ${file.basename}`) : "来源已移动或删除";
  }

  private targetFile(): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(this.candidateTargetPath);
    return file instanceof TFile && file.extension === "md" ? file : null;
  }

  private async saveQuickTopic(input: HTMLInputElement): Promise<void> {
    if (this.saving) return;
    await saveQuickTopicInput({
      input,
      currentDraft: () => this.quickDraft,
      save: title => this.plugin.saveManualTopic(title).then(() => undefined),
      clearDraft: () => { this.quickDraft = ""; },
      refreshCards: () => this.renderCards(),
      reportError: error => new Notice(errorMessage(error)),
      setSaving: value => { this.saving = value; },
    });
  }

  private openTopicMenu(event: MouseEvent, topic: TopicIdea): void {
    const source = topic.sourceNotePath ? this.app.vault.getAbstractFileByPath(topic.sourceNotePath) : null;
    const menu = new Menu();
    menu.addItem(item => item.setTitle("改标题").setIcon("pencil").onClick(() => this.editTitle(topic)));
    if (source instanceof TFile) menu.addItem(item => item.setTitle("打开来源").setIcon("file-text").onClick(() => void this.plugin.openTopicSource(topic.id).catch(error => new Notice(errorMessage(error)))));
    menu.addSeparator();
    menu.addItem(item => item.setTitle("删除").setIcon("trash-2").onClick(() => new TopicDeleteConfirmModal(this.app, topic.title, async () => {
      await this.plugin.deleteTopic(topic.id); this.render();
    }).open()));
    menu.showAtMouseEvent(event);
  }

  private editTitle(topic: TopicIdea): void {
    new TopicRenameModal(this.app, topic.title, async value => { await this.plugin.renameTopic(topic.id, value); this.render(); }).open();
  }
}

class TopicDeleteConfirmModal extends Modal {
  constructor(app: import("obsidian").App, private readonly title: string, private readonly confirm: () => Promise<void>) { super(app); }
  override onOpen(): void {
    this.setTitle("删除选题？");
    this.contentEl.createEl("p", { text: `“${this.title}”将从本地选题库删除，原 Chat 回答、来源笔记和正文不会受影响。` });
    const actions = this.contentEl.createDiv({ cls: "oa-topic-delete-actions" });
    actions.createEl("button", { text: "取消", attr: { type: "button" } }).onclick = () => this.close();
    const remove = actions.createEl("button", { cls: "mod-warning", text: "删除", attr: { type: "button" } });
    remove.onclick = async () => { remove.disabled = true; try { await this.confirm(); this.close(); } catch (error) { remove.disabled = false; new Notice(errorMessage(error)); } };
  }
}

class TopicRenameModal extends Modal {
  constructor(app: import("obsidian").App, private readonly title: string, private readonly save: (value: string) => Promise<void>) { super(app); }
  override onOpen(): void {
    this.setTitle("改标题");
    const input = this.contentEl.createEl("input", { attr: { type: "text", value: this.title, maxlength: "120", "aria-label": "选题标题" } });
    const actions = this.contentEl.createDiv({ cls: "oa-topic-delete-actions" });
    actions.createEl("button", { text: "取消", attr: { type: "button" } }).onclick = () => this.close();
    const confirm = actions.createEl("button", { cls: "mod-cta", text: "保存", attr: { type: "button" } });
    confirm.onclick = async () => { confirm.disabled = true; try { await this.save(input.value); this.close(); } catch (error) { confirm.disabled = false; new Notice(errorMessage(error)); } };
    window.setTimeout(() => { input.focus(); input.select(); }, 0);
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
