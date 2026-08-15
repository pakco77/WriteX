import {
  App,
  FileSystemAdapter,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  requestUrl,
  type Editor,
} from "obsidian";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { CodexImageUnavailableError, CodexRuntime, preserveSelectionWhitespace } from "./codex";
import { ChatAgentRuntime } from "./chatAgents";
import { archiveActiveConversation, restoreArchivedConversation } from "./conversations";
import { buildMarkdownBlockInsertion } from "./chatBlocks";
import { asCodeMirrorDropBridge, resolveLineDrop } from "./editorDrop";
import { inspectImage } from "./images";
import { recordChatFeedback } from "./feedback";
import { createCloudClient, createRelayClient, openWeChatSync as showWeChatSync, verifyRelayConnection } from "./sync";
import { normalizeRelayUrl, type WriteRelayClient } from "./writeRelay";
import { canReuseRelayAccountBinding, wechatImageCacheKey } from "./wechatImageCache";
import { installLocalSkill, VaultSkillIndex, type LocalSkill, type SkillPathStatus } from "./skills";
import { CURRENT_PLUGIN_ID, isLegacyPluginEnabled, readInitialPluginData } from "./pluginMigration";
import { THEME_CATALOG } from "./themeCatalog";
import { ThemeInstaller } from "./themeInstaller";
import { ThemeService } from "./themeService";
import { ThemeStore } from "./themeStore";
import { buildThemeCompilePrompt, type ThemeCompileSource } from "./themeCompiler";
import { AgentView, VIEW_TYPE, WRITEX_ICON } from "./view";
import { extractMarkdownImageSources } from "./wechat";
import {
  deleteTopicRecord,
  createManualTopic,
  findTopicBySourceMessage,
  moveTopicSourcePaths,
  renameTopicRecord,
  saveMessageAsTopic,
} from "./topics";
import {
  DEFAULT_SETTINGS,
  ensureOriginalAssetPairs,
  emptyNoteState,
  mergeReferencedImageAssets,
  migratePersistedData,
  migrateSettings,
  moveNoteStatePath,
  type AgentSettings,
  type CursorPosition,
  type ImageAsset,
  type ImageCapability,
  type ImageProvider,
  type ImageSize,
  type NoteState,
  type PersistedData,
  type SelectionContext,
  type RelayAccountBinding,
  type TopicIdea,
  type WeChatImageCacheEntry,
} from "./types";

// Compatibility keys are vault-global SecretStorage IDs. Do not rename them with the public plugin ID.
const IMAGE_KEY_ID = "obsidian-agent-openai-image-key";
const RELAY_KEY_ID = "write-wechat-relay-key";
const CLOUD_TOKEN_ID = "writex-cloud-access-token";
const CLOUD_INSTALLATION_TOKEN_ID = "writex-cloud-installation-token";
const MAX_IMAGE_BYTES = 100 * 1024 * 1024;

interface StoreImageMetadata {
  source: ImageAsset["source"];
  prompt?: string;
  provider?: ImageProvider;
  model?: string;
  messageId?: string;
  writeCredits?: number;
  relatedOriginalPath?: string;
  optimizationSummary?: string;
}

interface ObsidianAppWithSettings extends App {
  setting?: {
    open(): void;
    openTabById(id: string): void;
  };
}

export type AssistantDropTarget =
  | { kind: "precise"; view: MarkdownView; offset: number; markerTop: number; left: number; right: number }
  | { kind: "cursor-fallback"; view: MarkdownView; reason: string }
  | { kind: "rejected"; reason: string };

export default class ObsidianAgentPlugin extends Plugin {
  data: PersistedData = { version: 5, settings: { ...DEFAULT_SETTINGS }, notes: {}, topics: [] };
  runtime = new CodexRuntime(() => this.data.settings.codexPath);
  chatRuntime = new ChatAgentRuntime(this.runtime, () => this.data.settings);
  themeService!: ThemeService;
  private imageCapability: ImageCapability = "unknown";
  private persistChain: Promise<void> = Promise.resolve();
  private referencedImageSyncChain: Promise<void> = Promise.resolve();
  private skillIndex!: VaultSkillIndex;
  // ponytail: session verification preserves zero-request repeat copies; recheck after changing the Relay's account in place.
  private verifiedRelayUrls = new Set<string>();

  override async onload(): Promise<void> {
    await this.requireSafePluginIdMigration();
    await this.loadState();
    this.skillIndex = new VaultSkillIndex(this.getVaultBasePath());
    const themeStore = new ThemeStore(this.getVaultBasePath());
    const themeInstaller = new ThemeInstaller(themeStore, THEME_CATALOG, async ({ url, signal }) => {
      if (signal.aborted) throw new DOMException("cancelled", "AbortError");
      const response = await requestUrl({ url, method: "GET", throw: false });
      if (signal.aborted) throw new DOMException("cancelled", "AbortError");
      if (response.status < 200 || response.status >= 300) throw new Error(`下载排版失败：HTTP ${response.status}`);
      return new Uint8Array(response.arrayBuffer);
    });
    this.themeService = new ThemeService({ store: themeStore, installer: themeInstaller, catalog: THEME_CATALOG });
    await this.themeService.initialize();
    this.themeService.bootstrapStarterThemes();
    this.registerView(VIEW_TYPE, leaf => new AgentView(leaf, this));
    this.addRibbonIcon(WRITEX_ICON, "打开 WriteX", () => void this.activateView());

    this.addCommand({
      id: "open-agent",
      name: "打开 Agent 面板",
      callback: () => void this.activateView(),
    });
    this.addCommand({
      id: "send-selection-to-chat",
      name: "将选中文字发送到 Agent Chat",
      editorCheckCallback: (checking, editor, view) => {
        const available = Boolean(view.file && editor.getSelection().trim());
        if (available && !checking && view.file) {
          void this.activateView(this.captureSelection(editor, view.file));
        }
        return available;
      },
    });
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, info) => {
      if (!info.file || !editor.getSelection().trim()) return;
      const context = this.captureSelection(editor, info.file);
      menu.addItem(item => item
        .setTitle("发送选中内容到 Agent Chat")
        .setIcon("message-square-plus")
        .onClick(() => void this.activateView(context)));
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (!(file instanceof TFile) || file.extension !== "md") return;
      void this.rebindNotePath(oldPath, file.path);
    }));
    const syncSelection = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".markdown-source-view")) return;
      window.setTimeout(() => this.syncSelectionToOpenView(), 0);
    };
    this.registerDomEvent(document, "mouseup", syncSelection);
    this.registerDomEvent(document, "keyup", event => {
      if (event.shiftKey) syncSelection(event);
    });
    this.addSettingTab(new AgentSettingTab(this.app, this));
  }

  override onunload(): void {
    this.chatRuntime.stop();
  }

  private async requireSafePluginIdMigration(): Promise<void> {
    if (this.manifest.id !== CURRENT_PLUGIN_ID) {
      throw new Error(`WriteX ${this.manifest.version} 必须安装在 ${CURRENT_PLUGIN_ID} 目录，当前 ID 为 ${this.manifest.id}。`);
    }
    if (!await isLegacyPluginEnabled(this.app.vault.adapter, this.app.vault.configDir)) return;
    const message = "检测到旧版 WriteX（obsidian-agent）仍处于启用状态。请先在第三方插件中停用旧版，再启用新版 WriteX；旧数据不会被删除。";
    new Notice(message, 15_000);
    throw new Error(message);
  }

  async activateView(context?: SelectionContext): Promise<AgentView | null> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    const view = leaf.view instanceof AgentView ? leaf.view : null;
    if (view && context) view.setSelectionContext(context);
    else view?.syncActiveNote();
    return view;
  }

  openSettings(): void {
    const app = this.app as ObsidianAppWithSettings;
    app.setting?.open();
    app.setting?.openTabById(this.manifest.id);
  }

  openWeChatSync(filePath: string, themeId: string): void {
    showWeChatSync(this, filePath, themeId);
  }

  get agentSettings(): AgentSettings {
    return this.data.settings;
  }

  get agentImageCapability(): ImageCapability {
    return this.imageCapability;
  }

  resetAgentImageCapability(): void {
    this.imageCapability = "unknown";
  }

  getNoteState(filePath: string): NoteState {
    this.data.notes[filePath] ??= emptyNoteState();
    return this.data.notes[filePath];
  }

  async persist(): Promise<void> {
    const write = this.persistChain.then(() => this.saveData(this.data));
    this.persistChain = write.catch(() => undefined);
    await write;
  }

  async rebindNotePath(oldPath: string, newPath: string): Promise<boolean> {
    const movedState = moveNoteStatePath(this.data.notes, oldPath, newPath);
    const movedTopics = moveTopicSourcePaths(this.data.topics, oldPath, newPath);
    if (!movedState && !movedTopics) return false;
    try {
      await this.persist();
      return true;
    } catch (error) {
      if (movedState) moveNoteStatePath(this.data.notes, newPath, oldPath);
      if (movedTopics) moveTopicSourcePaths(this.data.topics, newPath, oldPath);
      throw error;
    }
  }

  findTopicByMessage(messageId: string): TopicIdea | undefined {
    return findTopicBySourceMessage(this.data.topics, messageId);
  }

  findTopicById(topicId: string): TopicIdea | undefined {
    return this.data.topics.find(topic => topic.id === topicId);
  }

  private async persistTopicMutation<T>(mutate: () => T): Promise<T> {
    const snapshot = structuredClone(this.data.topics);
    try {
      const result = mutate();
      await this.persist();
      return result;
    } catch (error) {
      this.data.topics = snapshot;
      throw error;
    }
  }

  async saveTopicFromMessage(notePath: string, messageId: string): Promise<TopicIdea> {
    const existing = this.findTopicByMessage(messageId);
    if (existing) return existing;
    const message = this.getNoteState(notePath).messages.find(candidate => candidate.id === messageId);
    if (!message) throw new Error("这条回答已经不存在。");
    return this.persistTopicMutation(() => saveMessageAsTopic(
      this.data.topics,
      notePath,
      message,
      () => randomUUID(),
    ).topic);
  }

  async saveManualTopic(title: string, sourceNotePath?: string): Promise<TopicIdea> {
    return this.persistTopicMutation(() => createManualTopic(
      this.data.topics,
      title,
      sourceNotePath,
      () => randomUUID(),
    ));
  }

  async renameTopic(topicId: string, title: string): Promise<void> {
    await this.persistTopicMutation(() => renameTopicRecord(this.data.topics, topicId, title));
  }

  async deleteTopic(topicId: string): Promise<void> {
    await this.persistTopicMutation(() => {
      if (!deleteTopicRecord(this.data.topics, topicId)) throw new Error("这条选题已经不存在。");
    });
  }

  async openTopicSource(topicId: string): Promise<void> {
    const topic = this.findTopicById(topicId);
    if (!topic) throw new Error("这条选题已经不存在。");
    const file = topic.sourceNotePath ? this.app.vault.getAbstractFileByPath(topic.sourceNotePath) : null;
    if (!(file instanceof TFile)) throw new Error("来源已移动或删除。");
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  async createWriteRelayClient(): Promise<WriteRelayClient> {
    return createRelayClient(this);
  }

  getRelayAccountBinding(relayUrl: string): RelayAccountBinding | undefined {
    const canonicalUrl = normalizeRelayUrl(relayUrl);
    const binding = this.data.relayAccountBindings?.[canonicalUrl];
    return canReuseRelayAccountBinding(binding, canonicalUrl, this.verifiedRelayUrls.has(canonicalUrl))
      ? binding
      : undefined;
  }

  async bindRelayAccount(binding: RelayAccountBinding): Promise<void> {
    const relayUrl = normalizeRelayUrl(binding.relayUrl);
    const normalized = { ...binding, relayUrl };
    this.data.relayAccountBindings ??= {};
    this.data.relayAccountBindings[relayUrl] = normalized;
    this.verifiedRelayUrls.add(relayUrl);
    await this.persist();
  }

  getCachedWeChatImage(relayUrl: string, accountId: string, sourceSha256: string): WeChatImageCacheEntry | undefined {
    return this.data.wechatImageCache?.[wechatImageCacheKey(relayUrl, accountId, sourceSha256)];
  }

  async cacheWeChatImage(entry: WeChatImageCacheEntry): Promise<void> {
    this.data.wechatImageCache ??= {};
    this.data.wechatImageCache[wechatImageCacheKey(entry.relayUrl, entry.accountId, entry.sourceSha256)] = entry;
    await this.persist();
  }

  async setMessageFeedback(notePath: string, messageId: string, rating?: "up" | "down"): Promise<void> {
    const state = this.getNoteState(notePath);
    const index = state.messages.findIndex(message => message.id === messageId && message.role === "assistant");
    const message = state.messages[index];
    if (!message) throw new Error("这条回答已经不存在。");
    message.feedback = rating;
    this.data.feedbackMemory = (this.data.feedbackMemory ?? []).filter(entry => entry.messageId !== messageId);
    if (rating) {
      const request = [...state.messages.slice(0, index)].reverse().find(item => item.role === "user")?.content ?? "";
      this.data.feedbackMemory = recordChatFeedback(this.data.feedbackMemory, {
        messageId,
        rating,
        request,
        response: message.content,
        createdAt: Date.now(),
        agent: message.agent ?? "codex",
        model: message.model,
        skillName: message.skill?.name,
      });
    }
    await this.persist();
  }

  async clearConversation(filePath: string): Promise<void> {
    const state = this.getNoteState(filePath);
    archiveActiveConversation(state, () => randomUUID());
    await this.persist();
  }

  async openConversation(filePath: string, archivedConversationId?: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) throw new Error("这篇历史笔记已经移动或删除。");
    if (archivedConversationId) {
      const restored = restoreArchivedConversation(
        this.getNoteState(filePath),
        archivedConversationId,
        () => randomUUID(),
      );
      if (!restored) throw new Error("这段历史对话已经不存在。");
      await this.persist();
    }
    await this.app.workspace.getLeaf(false).openFile(file);
    await this.activateView();
  }

  async discoverSkills(
    activeFilePath?: string,
    options?: { refresh?: boolean },
  ): Promise<LocalSkill[]> {
    const activeFile = this.app.workspace.getActiveFile();
    const notePath = activeFilePath
      ?? (activeFile instanceof TFile && activeFile.extension === "md" ? activeFile.path : undefined);
    return this.skillIndex.discover(notePath, options);
  }

  getSkillPathStatus(path: string): SkillPathStatus {
    return this.skillIndex.getPathStatus(path);
  }

  async installSkill(source: string): Promise<void> {
    await installLocalSkill(source, this.getVaultBasePath());
    this.skillIndex.invalidate();
  }

  async compileThemeSource(source: ThemeCompileSource, agent: import("./types").ChatAgentId, model: string, signal?: AbortSignal) {
    await this.chatRuntime.check(agent);
    return this.chatRuntime.runOneShot({
      agent,
      cwd: this.getVaultBasePath(),
      prompt: buildThemeCompilePrompt(source),
      model,
      signal,
    });
  }

  getVaultBasePath(): string {
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
      throw new Error("WriteX 当前仅支持桌面文件系统 Vault。");
    }
    return this.app.vault.adapter.getBasePath();
  }

  findMarkdownView(filePath: string): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file?.path === filePath) return active;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === filePath) return leaf.view;
    }
    return null;
  }

  resolveAssistantDropTarget(filePath: string, clientX: number, clientY: number): AssistantDropTarget {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile) || file.extension !== "md") {
      return { kind: "rejected", reason: "原 Markdown 笔记已经移动或删除。" };
    }

    let hit: MarkdownView | null = null;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (!(leaf.view instanceof MarkdownView) || leaf.view.file?.path !== filePath) continue;
      const rect = leaf.view.containerEl.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
        hit = leaf.view;
        break;
      }
    }
    if (!hit) return { kind: "rejected", reason: "请拖到当前绑定笔记的正文编辑区。" };
    if (hit.file?.path !== filePath) return { kind: "rejected", reason: "不能把内容拖到另一篇笔记。" };
    if (hit.getMode() !== "source") return { kind: "rejected", reason: "阅读模式不能接收内容，请切换到编辑模式。" };

    const pointElement = hit.containerEl.ownerDocument.elementFromPoint(clientX, clientY);
    const editorRoot = pointElement?.closest(".cm-editor");
    if (!(editorRoot instanceof HTMLElement) || !hit.containerEl.contains(editorRoot)) {
      return { kind: "rejected", reason: "请拖到当前笔记的正文编辑区。" };
    }
    if (pointElement?.closest(".cm-gutters")) {
      return { kind: "rejected", reason: "请拖到正文内容区，不要拖到行号栏。" };
    }
    const scroller = editorRoot.querySelector<HTMLElement>(".cm-scroller");
    const content = editorRoot.querySelector<HTMLElement>(".cm-content");
    if (!scroller || !content || !pointElement || !scroller.contains(pointElement)) {
      return { kind: "rejected", reason: "请拖到当前笔记的正文内容区。" };
    }
    const bounds = scroller.getBoundingClientRect();
    const contentBounds = content.getBoundingClientRect();
    const inContent = content.contains(pointElement);
    const inContentBlank = clientX >= contentBounds.left
      && clientX <= contentBounds.right
      && clientY > contentBounds.bottom
      && clientY <= bounds.bottom;
    if (!inContent && !inContentBlank) {
      return { kind: "rejected", reason: "请拖到当前笔记的正文内容区。" };
    }

    const bridge = asCodeMirrorDropBridge((hit.editor as unknown as { cm?: unknown }).cm);
    if (!bridge) {
      return { kind: "cursor-fallback", view: hit, reason: "当前编辑器没有提供精确坐标能力。" };
    }
    const resolved = resolveLineDrop(bridge, { x: clientX, y: clientY }, { top: bounds.top, bottom: bounds.bottom });
    if (resolved.kind === "fallback") {
      return { kind: "cursor-fallback", view: hit, reason: resolved.reason };
    }
    return {
      kind: "precise",
      view: hit,
      offset: resolved.offset,
      markerTop: resolved.markerTop,
      left: contentBounds.left,
      right: contentBounds.right,
    };
  }

  async insertAssistantBlock(
    filePath: string,
    markdown: string,
    offset?: number,
    targetView?: MarkdownView,
  ): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile) || file.extension !== "md") throw new Error("原 Markdown 笔记已经移动或删除。");
    if (targetView && !this.app.workspace.getLeavesOfType("markdown").some(leaf => leaf.view === targetView)) {
      throw new Error("目标编辑器已经关闭，请重新拖入。");
    }
    const view = targetView ?? this.findMarkdownView(filePath);
    if (!view) throw new Error("请先打开这篇笔记，再插入内容。");
    if (view.file?.path !== filePath) throw new Error("目标编辑器已经切换到另一篇笔记，请重新拖入。");
    if (view.getMode() !== "source") throw new Error("请先把这篇笔记切换到编辑模式。");
    const editor = view.editor;
    const documentText = editor.getValue();
    const insertionOffset = offset ?? editor.posToOffset(editor.getCursor());
    if (!Number.isInteger(insertionOffset) || insertionOffset < 0 || insertionOffset > documentText.length) {
      throw new Error("正文落点已经变化，请重新拖入。");
    }
    const insertion = buildMarkdownBlockInsertion(documentText, insertionOffset, markdown);
    editor.replaceRange(insertion.text, editor.offsetToPos(insertionOffset));
    editor.setCursor(editor.offsetToPos(insertion.cursorOffset));
    editor.focus();
  }

  captureActiveSelection(): SelectionContext | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file || !view.editor.getSelection().trim()) return null;
    return this.captureSelection(view.editor, view.file);
  }

  private syncSelectionToOpenView(): void {
    const context = this.captureActiveSelection();
    if (!context) return;
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
    if (view instanceof AgentView) view.setSelectionContext(context, false);
  }

  async replaceOriginalSelection(context: SelectionContext, markdown: string): Promise<void> {
    const view = this.findMarkdownView(context.filePath);
    if (!view) throw new Error("请先打开原笔记，再替换选中文字。");
    const editor = view.editor;
    const replacement = preserveSelectionWhitespace(context.text, cleanAssistantMarkdown(markdown));
    const current = editor.getSelection();
    if (current === context.text) {
      editor.replaceSelection(replacement);
      editor.focus();
      return;
    }
    const original = editor.getRange(context.from, context.to);
    if (original !== context.text) throw new Error("原选区已经变化，请重新划词后再替换。");
    editor.replaceRange(replacement, context.from, context.to);
    editor.focus();
  }

  async insertAtCursor(filePath: string, markdown: string): Promise<void> {
    const view = this.findMarkdownView(filePath);
    if (!view) throw new Error("请先打开这篇笔记，再插入内容。");
    const editor = view.editor;
    editor.replaceRange(cleanAssistantMarkdown(markdown), editor.getCursor());
    editor.focus();
  }

  async appendToNote(filePath: string, markdown: string): Promise<void> {
    const view = this.findMarkdownView(filePath);
    if (!view) throw new Error("请先打开这篇笔记，再追加内容。");
    const editor = view.editor;
    const line = editor.lastLine();
    const end = { line, ch: editor.getLine(line).length };
    editor.replaceRange(`\n\n${cleanAssistantMarkdown(markdown)}`, end);
    editor.setCursor(editor.lastLine(), editor.getLine(editor.lastLine()).length);
    editor.focus();
  }

  async insertImage(filePath: string, asset: ImageAsset): Promise<void> {
    await this.insertImagePath(filePath, asset.filePath);
  }

  async insertImagePath(filePath: string, imagePath: string): Promise<void> {
    const view = this.findMarkdownView(filePath);
    const imageFile = this.app.vault.getAbstractFileByPath(imagePath);
    if (!view || !(imageFile instanceof TFile)) throw new Error("图片或原笔记已经移动，请刷新后重试。");
    const link = this.app.fileManager.generateMarkdownLink(imageFile, filePath);
    view.editor.replaceRange(`\n!${link}\n`, view.editor.getCursor());
    view.editor.focus();
  }

  async importImage(filePath: string, file: File): Promise<ImageAsset> {
    if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) throw new Error("图片必须小于 100 MB。");
    const bytes = await file.arrayBuffer();
    const inspection = inspectImage(bytes, { fileName: file.name, declaredMime: file.type });
    if (!inspection.mimeType || !inspection.complete) {
      throw new Error(`无法通过文件签名确认图片完整性${inspection.issues.length ? `：${inspection.issues.join("；")}` : "。"}`);
    }
    return this.storeImage(filePath, bytes, file.name, inspection.mimeType, { source: "manual" });
  }

  async syncReferencedImages(notePath: string, markdown: string): Promise<number> {
    let added = 0;
    const sync = this.referencedImageSyncChain.then(async () => {
      const candidates = [];
      for (const source of extractMarkdownImageSources(markdown)) {
        if (/^(?:https?:|data:|blob:|app:|write-image:)/i.test(source)) continue;
        const file = this.app.metadataCache.getFirstLinkpathDest(source, notePath);
        if (!(file instanceof TFile)) continue;
        const bytes = await this.app.vault.readBinary(file);
        if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) continue;
        const inspection = inspectImage(bytes, { fileName: file.name });
        if (!inspection.mimeType || !inspection.complete) continue;
        candidates.push({ filePath: file.path, name: file.name, mimeType: inspection.mimeType });
      }
      added = mergeReferencedImageAssets(this.getNoteState(notePath).assets, candidates);
      if (added) await this.persist();
    });
    this.referencedImageSyncChain = sync.then(() => undefined, () => undefined);
    await sync;
    return added;
  }

  async generateImageWithAgent(
    filePath: string,
    prompt: string,
    messageId?: string,
    signal?: AbortSignal,
    imageSize: ImageSize = this.agentSettings.imageSize,
  ): Promise<ImageAsset> {
    const outputDirectory = join(
      this.getVaultBasePath(),
      this.app.vault.configDir,
      "plugins",
      this.manifest.id,
      ".write-image-output",
      randomUUID(),
    );
    await mkdir(outputDirectory, { recursive: true });
    try {
      const result = await this.runtime.runImageTurn({
        cwd: this.getVaultBasePath(),
        prompt,
        outputDirectory,
        size: imageSize,
        model: this.agentSettings.codexModel,
        reasoningEffort: this.agentSettings.codexReasoningEffort || undefined,
        signal,
      });
      const file = await readFile(result.filePath);
      const bytes = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
      const asset = await this.storeImage(filePath, bytes, basename(result.filePath), result.mimeType, {
        source: "generated",
        prompt,
        provider: "agent",
        model: this.agentSettings.codexModel || "Codex 默认模型",
        messageId,
        writeCredits: 0,
      });
      this.imageCapability = "available";
      return asset;
    } catch (error) {
      this.imageCapability = error instanceof CodexImageUnavailableError ? "unavailable" : "unknown";
      throw error;
    } finally {
      await rm(outputDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async generateImageWithOpenAI(
    filePath: string,
    prompt: string,
    messageId?: string,
    imageSize: ImageSize = this.agentSettings.imageSize,
  ): Promise<ImageAsset> {
    const apiKey = await this.getImageApiKey();
    if (!apiKey) throw new Error("请先在 WriteX 设置中保存 OpenAI 图片 API Key。");
    const response = await requestUrl({
      url: "https://api.openai.com/v1/images/generations",
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.agentSettings.imageModel,
        prompt,
        n: 1,
        size: imageSize,
      }),
      throw: false,
    });
    const payload = response.json as {
      data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
      error?: { message?: string };
    };
    if (response.status < 200 || response.status >= 300) {
      throw new Error(payload.error?.message ?? `图片生成失败（HTTP ${response.status}）。`);
    }
    const generated = payload.data?.[0];
    if (!generated) throw new Error("图片 API 没有返回图片。");
    let bytes: ArrayBuffer;
    if (generated.b64_json) {
      const buffer = Buffer.from(generated.b64_json, "base64");
      bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    } else if (generated.url) {
      const imageResponse = await requestUrl({ url: generated.url, throw: true });
      bytes = imageResponse.arrayBuffer;
    } else {
      throw new Error("图片 API 返回了无法识别的数据格式。");
    }
    const generatedName = `generated-${Date.now()}.png`;
    const inspection = inspectImage(bytes, { fileName: generatedName });
    if (!inspection.mimeType || !inspection.complete) throw new Error("图片 API 返回的文件不是完整、有效的图片。");
    return this.storeImage(filePath, bytes, generatedName, inspection.mimeType, {
      source: "generated",
      prompt,
      provider: "openai-api",
      model: this.agentSettings.imageModel,
      messageId,
      writeCredits: 0,
    });
  }

  async copyImage(asset: ImageAsset): Promise<void> {
    const imageFile = this.app.vault.getAbstractFileByPath(asset.filePath);
    if (!(imageFile instanceof TFile)) throw new Error("图片文件已经移动或删除。");
    const bytes = await this.app.vault.readBinary(imageFile);
    const inspection = inspectImage(bytes, { fileName: imageFile.name, declaredMime: asset.mimeType });
    if (!inspection.mimeType || !inspection.complete) throw new Error("图片文件不完整或无法通过文件签名识别。");
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ [inspection.mimeType]: new Blob([bytes], { type: inspection.mimeType }) }),
      ]);
      return;
    } catch {
      if (inspection.animated) {
        throw new Error("当前剪贴板不能保留这张图片的动画；WriteX 未转换为静态第一帧。请拖入编辑器，或从预览使用安全复制流程。");
      }
      if (!(this.app.vault.adapter instanceof FileSystemAdapter)) throw new Error("当前环境无法复制图片。");
      const electron = require("electron") as {
        clipboard: { writeImage(image: unknown): void };
        nativeImage: { createFromPath(path: string): { isEmpty(): boolean } };
      };
      const image = electron.nativeImage.createFromPath(this.app.vault.adapter.getFullPath(asset.filePath));
      if (image.isEmpty()) throw new Error("当前图片格式无法复制。");
      electron.clipboard.writeImage(image);
    }
  }

  async storeOptimizedGif(
    notePath: string,
    bytes: ArrayBuffer,
    originalPath: string,
    summary: string,
  ): Promise<ImageAsset> {
    const originalName = originalPath.split("/").pop()?.replace(/\.gif$/i, "") || "animation";
    const optimized = await this.storeImage(notePath, bytes, `${originalName}-wechat.gif`, "image/gif", {
      source: "optimized",
      relatedOriginalPath: originalPath,
      optimizationSummary: summary,
      writeCredits: 0,
    });
    if (ensureOriginalAssetPairs(this.getNoteState(notePath).assets, path => {
      const file = this.app.vault.getAbstractFileByPath(path);
      return file instanceof TFile ? { name: file.name } : null;
    })) {
      await this.persist();
    }
    return optimized;
  }

  async getImageApiKey(): Promise<string> {
    return (await this.app.secretStorage.getSecret(IMAGE_KEY_ID)) ?? "";
  }

  async setImageApiKey(value: string): Promise<void> {
    const trimmed = value.trim();
    if (trimmed) await this.app.secretStorage.setSecret(IMAGE_KEY_ID, trimmed);
    else await this.app.secretStorage.setSecret(IMAGE_KEY_ID, "");
    this.data.settings.hasImageApiKey = Boolean(trimmed);
    await this.persist();
  }

  async getRelayKey(): Promise<string> {
    return (await this.app.secretStorage.getSecret(RELAY_KEY_ID)) ?? "";
  }

  async setRelayKey(value: string): Promise<void> {
    const trimmed = value.trim();
    await this.app.secretStorage.setSecret(RELAY_KEY_ID, trimmed);
    this.data.settings.hasRelayKey = Boolean(trimmed);
    await this.persist();
  }

  async getCloudToken(): Promise<string> {
    return (await this.app.secretStorage.getSecret(CLOUD_TOKEN_ID)) ?? "";
  }

  async setCloudToken(value: string): Promise<void> {
    const trimmed = value.trim();
    await this.app.secretStorage.setSecret(CLOUD_TOKEN_ID, trimmed);
    this.data.settings.hasCloudToken = Boolean(trimmed);
    if (!trimmed) {
      this.data.settings.cloudConnectionId = "";
      this.data.settings.cloudAccountName = "";
      this.data.settings.cloudAccountId = "";
    }
    await this.persist();
  }

  async clearCloudCredentials(): Promise<void> {
    await this.app.secretStorage.setSecret(CLOUD_TOKEN_ID, "");
    await this.app.secretStorage.setSecret(CLOUD_INSTALLATION_TOKEN_ID, "");
    this.data.settings.hasCloudToken = false;
    this.data.settings.cloudConnectionId = "";
    this.data.settings.cloudAccountName = "";
    this.data.settings.cloudAccountId = "";
    await this.persist();
  }

  async getOrCreateCloudInstallationToken(): Promise<string> {
    const existing = (await this.app.secretStorage.getSecret(CLOUD_INSTALLATION_TOKEN_ID))?.trim();
    if (existing) return existing;
    const created = `writex-${randomUUID()}-${randomUUID()}`;
    await this.app.secretStorage.setSecret(CLOUD_INSTALLATION_TOKEN_ID, created);
    return created;
  }

  private captureSelection(editor: Editor, file: TFile): SelectionContext {
    return {
      filePath: file.path,
      fileName: file.basename,
      text: editor.getSelection(),
      from: editor.getCursor("from") as CursorPosition,
      to: editor.getCursor("to") as CursorPosition,
      capturedAt: Date.now(),
    };
  }

  private async loadState(): Promise<void> {
    const initial = await readInitialPluginData(
      await this.loadData(),
      this.app.vault.adapter,
      this.app.vault.configDir,
    );
    this.data = migratePersistedData(initial.data);
    this.data.settings.hasImageApiKey = Boolean(await this.getImageApiKey());
    this.data.settings.hasRelayKey = Boolean(await this.getRelayKey());
    this.data.settings.hasCloudToken = Boolean(await this.getCloudToken());
    let pairedAssetsChanged = false;
    for (const state of Object.values(this.data.notes)) {
      pairedAssetsChanged = ensureOriginalAssetPairs(state.assets, path => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? { name: file.name } : null;
      }) || pairedAssetsChanged;
    }
    if (pairedAssetsChanged || initial.source === "legacy") await this.persist();
    if (initial.source === "legacy") {
      new Notice("WriteX 已把旧版数据复制到新插件目录；旧版 data.json 保留未动，可用于回滚。", 10_000);
    }
  }

  private async storeImage(
    notePath: string,
    bytes: ArrayBuffer,
    originalName: string,
    mimeType: string,
    metadata: StoreImageMetadata,
  ): Promise<ImageAsset> {
    if (bytes.byteLength <= 0 || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("图片必须小于 100 MB。");
    const noteName = safeSegment(notePath.split("/").pop()?.replace(/\.md$/i, "") ?? "note");
    const folder = normalizePath(`attachments/agent/${noteName}`);
    await this.ensureFolder(folder);
    const extension = imageExtension(mimeType, originalName);
    const stem = safeSegment(originalName.replace(/\.[^.]+$/, "")) || metadata.source;
    let candidate = normalizePath(`${folder}/${Date.now()}-${stem}${extension}`);
    let suffix = 1;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = normalizePath(`${folder}/${Date.now()}-${stem}-${suffix}${extension}`);
      suffix += 1;
    }
    await this.app.vault.createBinary(candidate, bytes);
    const asset: ImageAsset = {
      id: `asset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      filePath: candidate,
      name: originalName,
      mimeType,
      source: metadata.source,
      createdAt: Date.now(),
      prompt: metadata.prompt,
      provider: metadata.provider,
      model: metadata.model,
      messageId: metadata.messageId,
      writeCredits: metadata.writeCredits,
      relatedOriginalPath: metadata.relatedOriginalPath,
      optimizationSummary: metadata.optimizationSummary,
    };
    this.getNoteState(notePath).assets.unshift(asset);
    await this.persist();
    return asset;
  }

  private async ensureFolder(path: string): Promise<void> {
    let current = "";
    for (const part of normalizePath(path).split("/")) {
      current = current ? `${current}/${part}` : part;
      if (this.app.vault.getAbstractFileByPath(current)) continue;
      try {
        await this.app.vault.createFolder(current);
      } catch (error) {
        if (!this.app.vault.getAbstractFileByPath(current)) throw error;
      }
    }
  }
}

class AgentSettingTab extends PluginSettingTab {
  private pendingApiKey = "";
  private pendingRelayKey = "";
  private pendingCloudAccountName = "";
  private pendingCloudAppid = "";
  private pendingCloudAppsecret = "";

  constructor(app: App, private readonly plugin: ObsidianAgentPlugin) {
    super(app, plugin);
  }

  private createSettingsGroup(containerEl: HTMLElement, title: string): HTMLElement {
    const group = containerEl.createEl("details", { cls: "oa-settings-group" });
    group.createEl("summary", { text: title });
    return group.createDiv({ cls: "oa-settings-group-content" });
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("WriteX").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Chat 使用你选择的 Agent 账号额度，WriteX 积分为 0。未连接的 Agent 不会静默回退；生图仍优先使用 Codex，OpenAI 图片 API Key 只作为你明确选择的备用路径。",
    });
    const aiSettings = this.createSettingsGroup(containerEl, "AI设置");
    new Setting(aiSettings)
      .setName("Codex 可执行文件")
      .setDesc("留空时自动检测 ChatGPT/Codex App 与常见安装路径。")
      .addText(text => text
        .setPlaceholder("自动检测")
        .setValue(this.plugin.agentSettings.codexPath)
        .onChange(async value => {
          this.plugin.agentSettings.codexPath = value.trim();
          await this.plugin.persist();
        }))
      .addButton(button => button.setButtonText("检测").onClick(async () => {
        button.setDisabled(true).setButtonText("检测中…");
        try {
          new Notice(`Codex 已连接：${await this.plugin.chatRuntime.check("codex")}`);
        } catch (error) {
          new Notice(errorMessage(error));
        } finally {
          button.setDisabled(false).setButtonText("检测");
        }
      }));
    new Setting(aiSettings)
      .setName("Claude Code 可执行文件")
      .setDesc("留空时检测官方 claude CLI；不会调用 Claude 桌面 App 私有接口。")
      .addText(text => text
        .setPlaceholder("未连接")
        .setValue(this.plugin.agentSettings.claudePath)
        .onChange(async value => {
          this.plugin.agentSettings.claudePath = value.trim();
          await this.plugin.persist();
        }))
      .addButton(button => button.setButtonText("检测").onClick(async () => {
        button.setDisabled(true).setButtonText("检测中…");
        try {
          new Notice(`Claude 已连接：${await this.plugin.chatRuntime.check("claude")}`);
        } catch (error) {
          new Notice(errorMessage(error));
        } finally {
          button.setDisabled(false).setButtonText("检测");
        }
      }));
    new Setting(aiSettings)
      .setName("WorkBuddy CLI 可执行文件")
      .setDesc("WriteX 通过腾讯官方 codebuddy/cbc CLI 连接 WorkBuddy，不会读取 WorkBuddy 桌面 App 的私有登录信息。首次使用请在终端运行 npm install -g @tencent-ai/codebuddy-code，再运行 codebuddy 完成登录，回到这里点击检测。")
      .addText(text => text
        .setPlaceholder("未连接")
        .setValue(this.plugin.agentSettings.workbuddyPath)
        .onChange(async value => {
          this.plugin.agentSettings.workbuddyPath = value.trim();
          await this.plugin.persist();
        }))
      .addButton(button => button.setButtonText("检测").onClick(async () => {
        button.setDisabled(true).setButtonText("检测中…");
        try {
          new Notice(`WorkBuddy 已连接：${await this.plugin.chatRuntime.check("workbuddy")}`);
        } catch (error) {
          new Notice(errorMessage(error));
        } finally {
          button.setDisabled(false).setButtonText("检测");
        }
      }));
    new Setting(aiSettings)
      .setName("发送给 Agent 的正文上限")
      .setDesc("超出部分会截断，避免长文请求无限增长。")
      .addText(text => text
        .setValue(String(this.plugin.agentSettings.maxContextChars))
        .onChange(async value => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed)) return;
          this.plugin.agentSettings.maxContextChars = Math.min(100000, Math.max(2000, parsed));
          await this.plugin.persist();
        }));
    new Setting(aiSettings)
      .setName("OpenAI 图片 API Key")
      .setDesc(this.plugin.agentSettings.hasImageApiKey ? "已保存。仅在你点击“使用我的 OpenAI API”时调用。" : "可选备用路径；不会从 Agent 静默切换过来。")
      .addText(text => {
        text.inputEl.type = "password";
        text.setPlaceholder(this.plugin.agentSettings.hasImageApiKey ? "••••••••" : "sk-…");
        text.onChange(value => { this.pendingApiKey = value; });
      })
      .addButton(button => button.setButtonText("保存").setCta().onClick(async () => {
        if (!this.pendingApiKey.trim()) {
          new Notice("没有输入新的 API Key。");
          return;
        }
        await this.plugin.setImageApiKey(this.pendingApiKey);
        this.pendingApiKey = "";
        new Notice("图片 API Key 已安全保存。");
        this.display();
      }))
      .addExtraButton(button => button.setIcon("trash-2").setTooltip("清除图片 API Key").onClick(async () => {
        await this.plugin.setImageApiKey("");
        new Notice("图片 API Key 已清除。");
        this.display();
      }));
    new Setting(aiSettings)
      .setName("图片模型")
      .setDesc("默认使用 GPT Image 2；也可以填入账号可用的其他图片模型。")
      .addText(text => text.setValue(this.plugin.agentSettings.imageModel).onChange(async value => {
        this.plugin.agentSettings.imageModel = value.trim() || DEFAULT_SETTINGS.imageModel;
        await this.plugin.persist();
      }));
    new Setting(aiSettings)
      .setName("图片尺寸")
      .addDropdown(dropdown => dropdown
        .addOption("1536x1024", "横图 3:2")
        .addOption("1024x1024", "方图 1:1")
        .addOption("1024x1536", "竖图 2:3")
        .setValue(this.plugin.agentSettings.imageSize)
        .onChange(async value => {
          this.plugin.agentSettings.imageSize = value as AgentSettings["imageSize"];
          await this.plugin.persist();
        }));

    const accountSettings = this.createSettingsGroup(containerEl, "公众号账号设置");
    new Setting(accountSettings)
      .setName("默认作者")
      .setDesc("文章 Frontmatter 中的 author 优先。")
      .addText(text => text
        .setValue(this.plugin.agentSettings.defaultWeChatAuthor)
        .onChange(async value => {
          this.plugin.agentSettings.defaultWeChatAuthor = value.trim();
          await this.plugin.persist();
        }));
    new Setting(accountSettings)
      .setName("同步路线")
      .setDesc("两条路线完全独立，不会自动或静默切换。")
      .addDropdown(dropdown => dropdown
        .addOption("self-hosted", "自建 Relay · 不消耗 WriteX 积分")
        .addOption("write-cloud", "Write Cloud · 免费体验 8 次同步")
        .setValue(this.plugin.agentSettings.syncRoute)
        .onChange(async value => {
          this.plugin.agentSettings.syncRoute = value as AgentSettings["syncRoute"];
          await this.plugin.persist();
          this.display();
        }));

    if (this.plugin.agentSettings.syncRoute === "self-hosted") {
      accountSettings.createEl("p", {
        cls: "setting-item-description",
        text: "AppID/AppSecret 只放在你的固定 IP Relay。自建 Relay 的 WriteX 积分永远为 0；只写草稿箱，不发布。",
      });
      new Setting(accountSettings)
        .setName("Relay URL")
        .setDesc("非本机地址必须使用 HTTPS。不会自动导入 WorkBuddy 配置。")
        .addText(text => text
          .setPlaceholder("https://relay.example.com")
          .setValue(this.plugin.agentSettings.relayUrl)
          .onChange(async value => {
            this.plugin.agentSettings.relayUrl = value.trim();
            await this.plugin.persist();
          }));
      new Setting(accountSettings)
        .setName("Relay Key")
        .setDesc(this.plugin.agentSettings.hasRelayKey ? "已保存到 Obsidian SecretStorage。" : "只保存到 Obsidian SecretStorage，不进入 data.json。")
        .addText(text => {
          text.inputEl.type = "password";
          text.setPlaceholder(this.plugin.agentSettings.hasRelayKey ? "••••••••" : "输入 Relay Key");
          text.onChange(value => { this.pendingRelayKey = value; });
        })
        .addButton(button => button.setButtonText("保存").setCta().onClick(async () => {
          if (!this.pendingRelayKey.trim()) {
            new Notice("没有输入新的 Relay Key。");
            return;
          }
          await this.plugin.setRelayKey(this.pendingRelayKey);
          this.pendingRelayKey = "";
          new Notice("Relay Key 已安全保存。");
          this.display();
        }))
        .addExtraButton(button => button.setIcon("trash-2").setTooltip("清除 Relay Key").onClick(async () => {
          await this.plugin.setRelayKey("");
          new Notice("Relay Key 已清除。");
          this.display();
        }));
      new Setting(accountSettings)
        .setName("检查连接")
        .setDesc("只验证 Relay 和微信凭据，不创建素材或草稿。")
        .addButton(button => button.setButtonText("检查").onClick(async () => {
          button.setDisabled(true).setButtonText("检查中…");
          try {
            const result = await verifyRelayConnection(this.plugin);
            await this.plugin.bindRelayAccount({
              relayUrl: normalizeRelayUrl(this.plugin.agentSettings.relayUrl),
              accountId: result.accountId,
              accountName: result.accountName,
              verifiedAt: Date.now(),
            });
            new Notice(`Relay 已连接：${result.accountName} · ${result.protocolVersion}`);
          } catch (error) {
            new Notice(errorMessage(error));
          } finally {
            button.setDisabled(false).setButtonText("检查");
          }
        }));
    } else {
      const cloudSettings = this.createSettingsGroup(containerEl, "WriteX云服务");
      cloudSettings.createEl("p", {
        cls: "setting-item-description",
        text: "无需自己的固定 IP，也无需邀请码或立即注册。首次成功连接公众号后赠送 8 个体验积分；每次同步前明确报价并确认，不会自动发布、群发或静默切换服务。",
      });
      new Setting(cloudSettings)
        .setName("Write Cloud 服务")
        .setDesc(this.plugin.agentSettings.cloudUrl);
      new Setting(cloudSettings)
        .setName("免费体验")
        .setDesc(this.plugin.agentSettings.hasCloudToken
          ? "体验账户已连接。设备令牌和匿名安装凭证只保存在 Obsidian SecretStorage。"
          : "开始时余额为 0；第一个公众号真实验证成功后一次性赠送 8 个体验积分。")
        .addButton(button => button
          .setButtonText(this.plugin.agentSettings.hasCloudToken ? "恢复连接" : "开始免费体验")
          .setCta()
          .onClick(async () => {
          button.setDisabled(true).setButtonText("连接中…");
          try {
            const installationToken = await this.plugin.getOrCreateCloudInstallationToken();
            const session = await (await createCloudClient(this.plugin, "")).startTrial(installationToken);
            await this.plugin.setCloudToken(session.accessToken);
            const profile = await (await createCloudClient(this.plugin)).profile();
            new Notice(`Write Cloud 体验账户已连接 · ${profile.credits} 体验积分`);
            this.display();
          } catch (error) {
            new Notice(errorMessage(error));
          } finally {
            button.setDisabled(false).setButtonText(this.plugin.agentSettings.hasCloudToken ? "恢复连接" : "开始免费体验");
          }
        }))
        .addExtraButton(button => button.setIcon("log-out").setTooltip("断开 Write Cloud").onClick(async () => {
          await this.plugin.setCloudToken("");
          new Notice("本机 Write Cloud 会话已断开；匿名安装凭证仍保留，稍后可恢复同一体验账户。");
          this.display();
        }));

      if (this.plugin.agentSettings.hasCloudToken) {
        new Setting(cloudSettings)
          .setName("体验积分")
          .setDesc("只读取体验账户与余额，不调用微信。")
          .addButton(button => button.setButtonText("刷新余额").onClick(async () => {
            button.setDisabled(true).setButtonText("读取中…");
            try {
              const profile = await (await createCloudClient(this.plugin)).profile();
              new Notice(`${profile.displayName}：${profile.credits} 体验积分`);
            } catch (error) {
              new Notice(errorMessage(error));
            } finally {
              button.setDisabled(false).setButtonText("刷新余额");
            }
          }));
        new Setting(cloudSettings)
          .setName("撤销当前设备")
          .setDesc("撤销服务端当前安装凭证和该体验账户全部设备会话，并清除本机凭证。此设备不能再恢复同一体验账户；不会删除已产生的草稿记录。")
          .addButton(button => button.setButtonText("撤销并清除").setWarning().onClick(async () => {
            if (!window.confirm("撤销后，当前设备和同一体验账户的全部会话都会失效；本机匿名安装凭证也会清除。继续吗？")) return;
            button.setDisabled(true).setButtonText("撤销中…");
            try {
              const installationToken = await this.plugin.getOrCreateCloudInstallationToken();
              await (await createCloudClient(this.plugin)).revokeCurrentInstallation(installationToken);
              await this.plugin.clearCloudCredentials();
              new Notice("当前设备与全部体验会话已撤销，本机凭证已清除。");
              this.display();
            } catch (error) {
              new Notice(errorMessage(error));
            } finally {
              button.setDisabled(false).setButtonText("撤销并清除");
            }
          }));
        new Setting(accountSettings)
          .setName("公众号名称")
          .setDesc(this.plugin.agentSettings.cloudConnectionId
            ? `已验证：${this.plugin.agentSettings.cloudAccountName}`
            : "只用于你在 WriteX 中识别目标公众号。")
          .addText(text => text
            .setPlaceholder("我的公众号")
            .onChange(value => { this.pendingCloudAccountName = value; }));
        new Setting(accountSettings)
          .setName("公众号 AppID")
          .setDesc("点击下方按钮前不会发送。")
          .addText(text => text
            .setPlaceholder("wx…")
            .onChange(value => { this.pendingCloudAppid = value; }));
        new Setting(accountSettings)
          .setName("公众号 AppSecret")
          .setDesc("点击“保存到 Write Cloud 并验证”后会加密存入测试服务；不会进入 Vault 或 data.json。")
          .addText(text => {
            text.inputEl.type = "password";
            text.setPlaceholder("输入 AppSecret");
            text.onChange(value => { this.pendingCloudAppsecret = value; });
          })
          .addButton(button => button.setButtonText("保存到 Write Cloud 并验证").setCta().onClick(async () => {
            if (!this.pendingCloudAccountName.trim() || !this.pendingCloudAppid.trim() || !this.pendingCloudAppsecret.trim()) {
              new Notice("请完整填写公众号名称、AppID 和 AppSecret。");
              return;
            }
            button.setDisabled(true).setButtonText("加密保存并验证中…");
            try {
              const client = await createCloudClient(this.plugin);
              const connection = await client.addConnection(
                this.pendingCloudAccountName,
                this.pendingCloudAppid,
                this.pendingCloudAppsecret,
              );
              const verified = await client.verifyConnection(connection.id);
              this.plugin.agentSettings.cloudConnectionId = verified.id;
              this.plugin.agentSettings.cloudAccountName = verified.accountName;
              this.plugin.agentSettings.cloudAccountId = verified.accountId ?? "";
              await this.plugin.persist();
              this.pendingCloudAccountName = "";
              this.pendingCloudAppid = "";
              this.pendingCloudAppsecret = "";
              new Notice(verified.trialGranted
                ? `公众号已验证：${verified.accountName} · 已赠送 ${verified.grantedCredits} 个体验积分 · 余额 ${verified.balance}`
                : `公众号已验证：${verified.accountName} · 该公众号不重复赠送体验积分 · 余额 ${verified.balance}`);
              this.display();
            } catch (error) {
              new Notice(errorMessage(error));
            } finally {
              button.setDisabled(false).setButtonText("保存到 Write Cloud 并验证");
            }
          }));
        if (this.plugin.agentSettings.cloudConnectionId) {
          new Setting(accountSettings)
            .setName("删除云端公众号连接")
            .setDesc("会从 Write Cloud 删除该连接并擦除加密保存的 AppSecret。若存在进行中的同步或待人工核查结果，会拒绝删除以避免丢失处理依据。")
            .addButton(button => button.setButtonText("删除连接与 AppSecret").setWarning().onClick(async () => {
              const accountName = this.plugin.agentSettings.cloudAccountName || "当前公众号";
              if (!window.confirm(`删除“${accountName}”的 Write Cloud 连接及 AppSecret？已完成的草稿记录不会删除。`)) return;
              button.setDisabled(true).setButtonText("删除中…");
              try {
                await (await createCloudClient(this.plugin)).deleteConnection(this.plugin.agentSettings.cloudConnectionId);
                this.plugin.agentSettings.cloudConnectionId = "";
                this.plugin.agentSettings.cloudAccountName = "";
                this.plugin.agentSettings.cloudAccountId = "";
                await this.plugin.persist();
                new Notice("云端公众号连接与 AppSecret 已删除。");
                this.display();
              } catch (error) {
                new Notice(errorMessage(error));
              } finally {
                button.setDisabled(false).setButtonText("删除连接与 AppSecret");
              }
            }));
        }
      }
    }
    const otherSettings = this.createSettingsGroup(containerEl, "其它");
    if (!otherSettings.childElementCount) otherSettings.parentElement?.remove();
  }
}

function cleanAssistantMarkdown(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function safeSegment(value: string): string {
  return value.replace(/[\\/:*?"<>|#^[\]]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80);
}

function imageExtension(mimeType: string, name: string): string {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/bmp") return ".bmp";
  if (mimeType === "image/tiff") return ".tiff";
  if (mimeType === "image/heic") return ".heic";
  if (mimeType === "image/avif") return ".avif";
  const original = name.match(/\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif)$/i)?.[0];
  return original?.toLowerCase() ?? ".png";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
