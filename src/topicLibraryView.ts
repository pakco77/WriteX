import { ItemView, Menu, Modal, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type ObsidianAgentPlugin from "./main";
import { groupTopicsByCreatedAt } from "./topics";
import { saveQuickTopicInput, searchDraftForTopicActivation, shouldSaveQuickTopicOnKey, shouldScrollFocusedTopic } from "./topicLibraryController";
import { orderTopicsForRatingSort, visibleTopicsForRatingFilter, type TopicRatingFilter, type TopicRatingSort } from "./topicStrategy";
import type { TopicDecisionValue, TopicIdea } from "./types";

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
  private ratingFilter: TopicRatingFilter = "all";
  private ratingSort: TopicRatingSort = "recent";
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

  refresh(): void { this.render(); }

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
    const ratingFilter = controls.createEl("select", { attr: { "aria-label": "选题评级筛选" } });
    ([['all', '全部'], ['high', '高星'], ['unrated', '未评级'], ['stale', '待更新']] as const).forEach(([value, text]) => ratingFilter.createEl("option", { value, text }));
    ratingFilter.value = this.ratingFilter;
    ratingFilter.onchange = () => { this.ratingFilter = ratingFilter.value as TopicRatingFilter; this.renderCards(); };
    const ratingSort = controls.createEl("select", { attr: { "aria-label": "选题排序" } });
    ([['recent', '最新'], ['stars', '星级']] as const).forEach(([value, text]) => ratingSort.createEl("option", { value, text }));
    ratingSort.value = this.ratingSort;
    ratingSort.onchange = () => { this.ratingSort = ratingSort.value as TopicRatingSort; this.renderCards(); };
    const profile = root.createDiv({ cls: "oa-topic-positioning" });
    profile.createEl("strong", { text: this.plugin.data.topicPositioningProfile ? `账号定位：${this.plugin.data.topicPositioningProfile.path}` : "账号定位：尚未选择" });
    const positioning = profile.createEl("select", { attr: { "aria-label": "账号定位 Markdown" } });
    positioning.createEl("option", { value: "", text: "选择一份 Markdown 作为账号定位…" });
    for (const file of this.app.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path))) positioning.createEl("option", { value: file.path, text: file.path });
    positioning.value = this.plugin.data.topicPositioningProfile?.path ?? "";
    const savePositioning = profile.createEl("button", { text: "保存定位", attr: { type: "button" } });
    savePositioning.onclick = async () => {
      const file = this.app.vault.getAbstractFileByPath(positioning.value);
      if (!(file instanceof TFile)) { new Notice("请选择一份 Markdown 文件。"); return; }
      try { await this.plugin.setTopicPositioningProfile(file.path, await this.app.vault.read(file)); this.render(); }
      catch (error) { new Notice(errorMessage(error)); }
    };
    const openPositioning = profile.createEl("button", { text: "打开定位", attr: { type: "button" } });
    openPositioning.disabled = !this.plugin.data.topicPositioningProfile;
    openPositioning.onclick = async () => {
      const selected = this.app.vault.getAbstractFileByPath(positioning.value || this.plugin.data.topicPositioningProfile?.path || "");
      if (!(selected instanceof TFile)) { new Notice("请先选择一份账号定位 Markdown。"); return; }
      await this.app.workspace.getLeaf("tab").openFile(selected);
    };
    const createPositioning = profile.createEl("button", { text: "新建定位模板", attr: { type: "button" } });
    createPositioning.onclick = async () => {
      const path = "账号定位.md";
      if (this.app.vault.getAbstractFileByPath(path)) { new Notice("账号定位.md 已存在，请在上方选择它。"); return; }
      const template = "# 账号定位\n\n## 为谁写\n\n\n## 内容主线\n\n\n## 我有什么一手经验\n\n\n## 当前目标\n\n\n## 不写什么\n";
      try {
        const file = await this.app.vault.create(path, template);
        await this.plugin.setTopicPositioningProfile(file.path, template);
        await this.app.workspace.getLeaf("tab").openFile(file);
        this.render();
      }
      catch (error) { new Notice(errorMessage(error)); }
    };
    const targetRow = root.createDiv({ cls: "oa-topic-target-row" });
    targetRow.createEl("label", { text: "关联已有文章", attr: { for: "writex-topic-target" } });
    const target = targetRow.createEl("select", { attr: { id: "writex-topic-target", "aria-label": "继续到目标笔记" } });
    target.createEl("option", { value: "", text: "选择一篇 Markdown 文章…" });
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
    if (this.ratingSort === "stars") {
      cards.createEl("h3", { cls: "oa-topic-group-title", text: "按星级" });
      const grid = cards.createDiv({ cls: "oa-topic-card-grid" });
      for (const topic of visible) this.renderTopicCard(grid, topic);
      return;
    }
    for (const group of groupTopicsByCreatedAt(visible)) {
      cards.createEl("h3", { cls: "oa-topic-group-title", text: group.label });
      const grid = cards.createDiv({ cls: "oa-topic-card-grid" });
      for (const topic of group.topics) this.renderTopicCard(grid, topic);
    }
  }

  private visibleTopics(): TopicIdea[] {
    const needle = this.searchDraft.trim().toLocaleLowerCase();
    const filtered = visibleTopicsForRatingFilter(this.plugin.data.topics, this.ratingFilter);
    const matched = !needle ? filtered : filtered.filter(topic => `${topic.title}\n${this.sourceLabel(topic)}`.toLocaleLowerCase().includes(needle));
    return orderTopicsForRatingSort(matched, this.ratingSort);
  }

  private renderTopicCard(grid: HTMLElement, topic: TopicIdea): void {
    const card = grid.createDiv({ cls: "oa-topic-card" });
    card.toggleClass("is-focused", topic.id === this.focusedTopicId);
    card.createEl("strong", { text: topic.title });
    card.createEl("small", { text: this.sourceLabel(topic) });
    card.createEl("time", { text: new Date(topic.createdAt).toLocaleString() });
    const rating = card.createEl("button", { cls: "oa-topic-rating", text: topic.rating ? `${"★".repeat(topic.rating.stars)}${"☆".repeat(5 - topic.rating.stars)}${topic.ratingStale ? " · 待更新" : ""}` : "未评级", attr: { type: "button", "aria-expanded": "false", "aria-label": topic.rating ? `选题评级 ${topic.rating.stars} 星，展开明细` : "未评级，展开说明" } });
    rating.onclick = () => {
      const existing = card.querySelector<HTMLElement>(".oa-topic-rating-detail");
      if (existing) { existing.remove(); rating.removeAttribute("aria-controls"); rating.setAttribute("aria-expanded", "false"); return; }
      rating.setAttribute("aria-expanded", "true");
      const detail = card.createDiv({ cls: "oa-topic-rating-detail" });
      detail.id = `writex-topic-rating-${topic.id}`;
      rating.setAttribute("aria-controls", detail.id);
      if (!topic.rating) detail.createEl("p", { text: "尚未分析。请先选择并保存账号定位，再点击“分析评级”。" });
      else {
        detail.createEl("strong", { text: "AI 评级" });
        detail.createEl("p", { text: topic.rating.detail });
        if (topic.rating.suggestion) detail.createEl("p", { text: `建议：${topic.rating.suggestion}` });
        detail.createEl("small", { text: `${new Date(topic.rating.analyzedAt).toLocaleString()} · ${topic.rating.agent} · ${topic.rating.model} · 定位 ${topic.rating.profileHash.slice(0, 8)}${topic.ratingStale ? " · 旧评级待更新" : ""}` });
      }
      if (topic.decision) {
        detail.createEl("strong", { text: "你的决定" });
        detail.createEl("p", { text: `${decisionLabel(topic.decision.value)}${topic.decision.reason ? `：${topic.decision.reason}` : ""}` });
        if (topic.decision.correction) detail.createEl("p", { text: `你对 AI 评级的补充：${topic.decision.correction}` });
      }
    };
    const actions = card.createDiv({ cls: "oa-topic-card-actions" });
    const analyze = actions.createEl("button", { text: topic.rating ? "重新评级" : "分析评级", attr: { type: "button" } });
    analyze.onclick = async () => {
      const profile = this.plugin.data.topicPositioningProfile;
      const file = profile && this.app.vault.getAbstractFileByPath(profile.path);
      if (!(file instanceof TFile)) { new Notice("请先选择并保存账号定位 Markdown。"); return; }
      analyze.disabled = true;
      try { await this.plugin.analyzeTopic(topic.id, await this.app.vault.read(file)); this.render(); }
      catch (error) { new Notice(errorMessage(error)); }
      finally { analyze.disabled = false; }
    };
    const article = topic.articleNotePath ? this.app.vault.getAbstractFileByPath(topic.articleNotePath) : null;
    const write = actions.createEl("button", { text: article instanceof TFile ? "继续写作" : "新建文章", attr: { type: "button" } });
    write.onclick = async () => {
      const targetPath = article instanceof TFile ? "" : this.plugin.getTopicArticleTargetPath(topic.id);
      if (!(article instanceof TFile) && !window.confirm(`将创建：${targetPath}\n\n按 Obsidian 的新建笔记位置规则创建空白文章，然后打开 WriteX Chat。继续吗？`)) return;
      write.disabled = true;
      try {
        const file = article instanceof TFile ? article : await this.plugin.createTopicArticle(topic.id, targetPath);
        const sent = await this.plugin.continueTopicToChat(topic.id, file.path);
        if (!sent) new Notice("Chat 输入框已有内容，请先发送或清空；选题未被覆盖。 ");
      } catch (error) { new Notice(errorMessage(error)); }
      finally { write.disabled = false; }
    };
    const link = actions.createEl("button", { text: "关联已有文章", attr: { type: "button" } });
    link.onclick = async () => {
      const target = this.targetFile();
      if (!target) { new Notice("请先在“关联已有文章”选择一篇 Markdown 文章。 "); return; }
      link.disabled = true;
      try { await this.plugin.associateTopicArticle(topic.id, target.path); this.render(); }
      catch (error) { new Notice(errorMessage(error)); }
      finally { link.disabled = false; }
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
    menu.addItem(item => item.setTitle("记录决定／人工纠偏").setIcon("message-square-text").onClick(() => this.editDecision(topic)));
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

  private editDecision(topic: TopicIdea): void {
    new TopicDecisionModal(this.app, topic, {
      save: (value, reason, correction) => this.plugin.setTopicDecision(topic.id, value, reason, correction),
      clear: () => this.plugin.clearTopicDecision(topic.id),
      done: () => this.render(),
    }).open();
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

class TopicDecisionModal extends Modal {
  constructor(
    app: import("obsidian").App,
    private readonly topic: TopicIdea,
    private readonly actions: {
      save: (value: TopicDecisionValue, reason: string, correction: string) => Promise<void>;
      clear: () => Promise<void>;
      done: () => void;
    },
  ) { super(app); }

  override onOpen(): void {
    this.modalEl.addClass("oa-topic-decision-modal");
    this.setTitle("记录你的决定");
    this.contentEl.createEl("p", { text: "你的决定会与 AI 评级分开保存；后续评级只把它当作有限参考。" });
    const decision = this.contentEl.createEl("select", { attr: { "aria-label": "选题决定" } });
    ([['adopt', '采用'], ['defer', '暂缓'], ['dismiss', '放弃']] as const).forEach(([value, text]) => decision.createEl("option", { value, text }));
    decision.value = this.topic.decision?.value ?? "adopt";
    const reason = this.contentEl.createEl("textarea", { attr: { rows: "3", maxlength: "500", placeholder: "理由（可选）", "aria-label": "决定理由" } });
    reason.value = this.topic.decision?.reason ?? "";
    const correction = this.contentEl.createEl("textarea", { attr: { rows: "3", maxlength: "500", placeholder: "你对 AI 评级的补充（可选）", "aria-label": "对 AI 评级的补充" } });
    correction.value = this.topic.decision?.correction ?? "";
    const actions = this.contentEl.createDiv({ cls: "oa-topic-delete-actions" });
    actions.createEl("button", { text: "取消", attr: { type: "button" } }).onclick = () => this.close();
    if (this.topic.decision) {
      const clear = actions.createEl("button", { text: "清除决定", attr: { type: "button" } });
      clear.onclick = async () => {
        clear.disabled = true;
        try { await this.actions.clear(); this.actions.done(); this.close(); }
        catch (error) { clear.disabled = false; new Notice(errorMessage(error)); }
      };
    }
    const save = actions.createEl("button", { cls: "mod-cta", text: "保存", attr: { type: "button" } });
    save.onclick = async () => {
      save.disabled = true;
      try { await this.actions.save(decision.value as TopicDecisionValue, reason.value, correction.value); this.actions.done(); this.close(); }
      catch (error) { save.disabled = false; new Notice(errorMessage(error)); }
    };
    window.setTimeout(() => decision.focus(), 0);
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function decisionLabel(value: TopicDecisionValue): string { return value === "adopt" ? "采用" : value === "defer" ? "暂缓" : "放弃"; }
