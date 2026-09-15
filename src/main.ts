import {
  App,
  type ButtonComponent,
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
import { chmod, link, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CodexImageUnavailableError, CodexRuntime } from "./codex";
import { ChatAgentRuntime } from "./chatAgents";
import { agentModelOptions, mergeDiscoveredModels } from "./modelCatalog";
import { buildTopicAnalysisPrompt, parseTopicRating, setTopicDecision } from "./topicStrategy";
import { SerializedTopicMutationQueue, acceptsTopicAnalysisResult, topicDecisionVersion, type TopicAnalysisSnapshot } from "./topicMutation";
import { archiveActiveConversation, restoreArchivedConversation } from "./conversations";
import { buildMarkdownBlockInsertion } from "./chatBlocks";
import { CHAT_ATTACHMENT_MAX_BYTES, validateChatAttachmentInputs } from "./chatAttachments";
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
import { TopicLibraryView, TOPIC_LIBRARY_VIEW_TYPE } from "./topicLibraryView";
import { topicArticleFileName } from "./topicLibraryController";
import { CreatedTopicArticleUnlinkedError, createOrAssociateTopicArticle } from "./topicArticleCreation";
import { WRITING_STYLE_SKILL_PATH, buildStyleExtractionPrompt, renderStyleSkill, sha256Text } from "./writingStyle";
import { allocateWritingStyleSources, exportStyleSkillTransaction, persistWritingStyleProfile, replaceCapturedRange, routeTopicToChat, withIsolatedStyleExtractionCwd } from "./writingStyleController";
import { cleanAssistantMarkdown as normalizeAssistantMarkdown, computeSelectionReplacement as computeFinalSelectionReplacement } from "./selectionReplacement";
import { extractMarkdownImageSources } from "./wechat";
import {
  deleteTopicRecord,
  createManualTopic,
  findTopicBySourceMessage,
  moveTopicSourcePaths,
  renameTopicRecord,
  saveMessageAsTopic,
  setTopicArticlePath,
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
  type ChatAttachment,
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
  type WritingStyleProfile,
  type WritingStyleSourceRef,
  type WeChatImageCacheEntry,
} from "./types";

// Compatibility keys are vault-global SecretStorage IDs. Do not rename them with the public plugin ID.
const IMAGE_KEY_ID = "obsidian-agent-openai-image-key";
const RELAY_KEY_ID = "write-wechat-relay-key";
const CLOUD_TOKEN_ID = "writex-cloud-access-token";
const CLOUD_INSTALLATION_TOKEN_ID = "writex-cloud-installation-token";
const MAX_IMAGE_BYTES = 100 * 1024 * 1024;
const WORKBUDDY_INSTALLER_URL = "https://copilot.tencent.com/cli/install.sh";
const WORKBUDDY_QUICKSTART_URL = "https://www.codebuddy.cn/docs/cli/quickstart";

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
  data: PersistedData = { version: 6, settings: { ...DEFAULT_SETTINGS }, notes: {}, topics: [] };
  runtime = new CodexRuntime(() => this.data.settings.codexPath);
  chatRuntime = new ChatAgentRuntime(this.runtime, () => this.data.settings);
  themeService!: ThemeService;
  private imageCapability: ImageCapability = "unknown";
  private persistChain: Promise<void> = Promise.resolve();
  private referencedImageSyncChain: Promise<void> = Promise.resolve();
  private readonly topicArticleCreatePending = new Set<string>();
  private readonly topicArticleUnlinkedPaths = new Map<string, string>();
  private readonly topicMutationQueue = new SerializedTopicMutationQueue();
  private readonly topicAnalysisRequests = new Map<string, { token: string; controller: AbortController }>();
  private agentSettingTab: AgentSettingTab | null = null;
  private modelRefreshStatus: Record<import("./types").ChatAgentId, { state: "idle" | "refreshing" | "updated" | "cached" | "failed"; error?: string }> = {
    codex: { state: "idle" },
    claude: { state: "idle" },
    workbuddy: { state: "idle" },
  };
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
    this.registerView(TOPIC_LIBRARY_VIEW_TYPE, leaf => new TopicLibraryView(leaf, this));
    this.addRibbonIcon(WRITEX_ICON, "打开 WriteX", () => void this.activateView());

    this.addCommand({
      id: "open-agent",
      name: "打开 Agent 面板",
      callback: () => void this.activateView(),
    });
    this.addCommand({
      id: "open-topic-library",
      name: "打开 WriteX 选题库",
      callback: () => void this.activateTopicLibrary(),
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
      void this.rebindNotePath(oldPath, file.path).catch(error => console.error("WriteX failed to rebind a renamed note", error));
      void this.rebindTopicPositioningProfile(oldPath, file.path).catch(error => console.error("WriteX failed to update a renamed positioning file", error));
    }));
    this.registerEvent(this.app.vault.on("modify", file => {
      if (file instanceof TFile && file.extension === "md") void this.markTopicRatingsStaleForPositioningFile(file.path).catch(error => console.error("WriteX failed to update positioning freshness", error));
    }));
    this.registerEvent(this.app.vault.on("delete", file => {
      if (file instanceof TFile && file.extension === "md") void this.clearTopicPositioningProfileForDeletedFile(file.path).catch(error => console.error("WriteX failed to clear a deleted positioning file", error));
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
    this.agentSettingTab = new AgentSettingTab(this.app, this);
    this.addSettingTab(this.agentSettingTab);
    void this.refreshDiscoveredModels().catch(() => undefined);
  }

  async refreshDiscoveredModels(): Promise<void> {
    const previous = structuredClone(this.data.discoveredAgentModels ?? {});
    for (const agent of ["codex", "workbuddy", "claude"] as const) this.modelRefreshStatus[agent] = { state: "refreshing" };
    this.agentSettingTab?.renderModelRefreshStatus();
    const [codex, workbuddy, claude] = await Promise.allSettled([this.runtime.listModels(), this.chatRuntime.listWorkBuddyModels(), this.chatRuntime.listClaudeModels()]);
    let next = previous;
    if (codex.status === "fulfilled") next = mergeDiscoveredModels(next, "codex", codex.value, Date.now());
    if (workbuddy.status === "fulfilled") next = mergeDiscoveredModels(next, "workbuddy", workbuddy.value.map(model => ({ model })), Date.now());
    if (claude.status === "fulfilled") next = mergeDiscoveredModels(next, "claude", claude.value.map(item => ({ model: item.model, displayName: item.displayName })), Date.now());
    this.modelRefreshStatus.codex = codex.status === "fulfilled" ? { state: "updated" } : { state: previous.codex ? "cached" : "failed", error: errorMessage(codex.reason) };
    this.modelRefreshStatus.workbuddy = workbuddy.status === "fulfilled" ? { state: "updated" } : { state: previous.workbuddy ? "cached" : "failed", error: errorMessage(workbuddy.reason) };
    this.modelRefreshStatus.claude = claude.status === "fulfilled" ? { state: "updated" } : { state: previous.claude ? "cached" : "failed", error: errorMessage(claude.reason) };
    this.agentSettingTab?.renderModelRefreshStatus();
    if (codex.status === "rejected" && workbuddy.status === "rejected" && claude.status === "rejected") throw new Error("无法刷新本机模型列表；已保留上次成功列表。");
    this.data.discoveredAgentModels = next;
    await this.persist();
    this.agentSettingTab?.refreshTopicAnalysisModelOptions();
    this.agentSettingTab?.renderModelRefreshStatus();
  }

  getModelRefreshStatus(): Record<import("./types").ChatAgentId, { state: "idle" | "refreshing" | "updated" | "cached" | "failed"; error?: string }> {
    return this.modelRefreshStatus;
  }

  override onunload(): void {
    this.agentSettingTab?.cancelWorkBuddyConnection();
    for (const { controller } of this.topicAnalysisRequests.values()) controller.abort();
    this.topicAnalysisRequests.clear();
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

  async activateTopicLibrary(focusedTopicId = "", candidateTargetPath?: string): Promise<TopicLibraryView | null> {
    let leaf = this.app.workspace.getLeavesOfType(TOPIC_LIBRARY_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: TOPIC_LIBRARY_VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    const view = leaf.view instanceof TopicLibraryView ? leaf.view : null;
    view?.setActivation({ focusedTopicId, candidateTargetPath });
    return view;
  }

  private refreshTopicLibraryViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(TOPIC_LIBRARY_VIEW_TYPE)) {
      if (leaf.view instanceof TopicLibraryView) leaf.view.refresh();
    }
  }

  async continueTopicToChat(topicId: string, targetPath: string): Promise<boolean> {
    const topic = this.findTopicById(topicId);
    const target = this.app.vault.getAbstractFileByPath(targetPath);
    if (!topic) throw new Error("这条选题已经不存在。");
    if (!(target instanceof TFile) || target.extension !== "md") throw new Error("“继续到”笔记已移动或删除，请重新选择。");
    return routeTopicToChat({
      hasDraft: () => {
        const current = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
        return current instanceof AgentView && current.hasComposerDraft();
      },
      openTarget: async () => {
        const openLeaf = this.app.workspace.getLeavesOfType("markdown").find(leaf => (
          leaf.view instanceof MarkdownView && leaf.view.file?.path === target.path
        ));
        if (openLeaf) this.app.workspace.revealLeaf(openLeaf);
        else await this.app.workspace.getLeaf("tab").openFile(target);
      },
      activateChat: async () => this.activateView().then(view => view ? { prepare: () => view.prepareTopicDraft(topic) } : null),
    });
  }

  async associateTopicArticle(topicId: string, articlePath: string): Promise<void> {
    const article = this.app.vault.getAbstractFileByPath(articlePath);
    if (!(article instanceof TFile) || article.extension !== "md") throw new Error("选择的文章已移动或删除，请重新选择。");
    await this.persistTopicMutation(() => setTopicArticlePath(this.data.topics, topicId, article.path));
    this.topicArticleUnlinkedPaths.delete(topicId);
  }

  getTopicArticleTargetPath(topicId: string): string {
    const topic = this.findTopicById(topicId);
    if (!topic) throw new Error("这条选题已经不存在。");
    const pendingPath = this.topicArticleUnlinkedPaths.get(topicId);
    if (pendingPath && this.app.vault.getAbstractFileByPath(pendingPath) instanceof TFile) return pendingPath;
    const source = topic.sourceNotePath && this.app.vault.getAbstractFileByPath(topic.sourceNotePath) instanceof TFile
      ? topic.sourceNotePath
      : this.app.workspace.getActiveFile()?.path ?? "";
    const fileName = topicArticleFileName(topic.title);
    const folder = this.app.fileManager.getNewFileParent(source, fileName);
    const prefix = folder.path ? `${folder.path}/` : "";
    const base = fileName.replace(/\.md$/i, "");
    let path = normalizePath(`${prefix}${fileName}`);
    for (let suffix = 2; this.app.vault.getAbstractFileByPath(path); suffix += 1) path = normalizePath(`${prefix}${base} ${suffix}.md`);
    return path;
  }

  async createTopicArticle(topicId: string, confirmedPath?: string): Promise<TFile> {
    const topic = this.findTopicById(topicId);
    if (!topic) throw new Error("这条选题已经不存在。");
    const linked = topic.articleNotePath ? this.app.vault.getAbstractFileByPath(topic.articleNotePath) : null;
    if (linked instanceof TFile && linked.extension === "md") return linked;
    if (this.topicArticleCreatePending.has(topicId)) throw new Error("这条选题正在创建文章，请勿重复点击。");
    this.topicArticleCreatePending.add(topicId);
    try {
      const path = this.getTopicArticleTargetPath(topicId);
      if (confirmedPath && confirmedPath !== path) throw new Error("目标路径已被占用或新建笔记位置已变化，请重新确认后再创建。");
      const file = await createOrAssociateTopicArticle<TFile>({
        linkedPath: linked instanceof TFile ? linked.path : undefined,
        pendingPath: this.topicArticleUnlinkedPaths.get(topicId),
        fileAtPath: candidate => {
          const value = this.app.vault.getAbstractFileByPath(candidate);
          return value instanceof TFile && value.extension === "md" ? value : null;
        },
        nextPath: () => path,
        create: candidate => this.app.vault.create(candidate, ""),
        pathOf: candidate => candidate.path,
        associate: candidate => this.persistTopicMutation(() => setTopicArticlePath(this.data.topics, topicId, candidate.path)).then(() => undefined),
      });
      this.topicArticleUnlinkedPaths.delete(topicId);
      return file;
    } catch (error) {
      if (error instanceof CreatedTopicArticleUnlinkedError) this.topicArticleUnlinkedPaths.set(topicId, error.filePath);
      throw error;
    } finally { this.topicArticleCreatePending.delete(topicId); }
  }


  async setWritingStyleEnabled(notePath: string, enabled: boolean): Promise<void> {
    const state = this.getNoteState(notePath);
    const previous = state.writingStyleEnabled;
    state.writingStyleEnabled = enabled;
    try { await this.persist(); }
    catch (error) {
      if (previous === undefined) delete state.writingStyleEnabled;
      else state.writingStyleEnabled = previous;
      throw error;
    }
  }

  async saveWritingStyleProfile(profile: WritingStyleProfile): Promise<void> {
    await persistWritingStyleProfile({
      state: this.data,
      profile,
      persist: () => this.persist(),
      refreshViews: () => {
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
          if (leaf.view instanceof AgentView) leaf.view.refreshWritingStyle();
        }
      },
    });
  }

  async extractWritingStyle(sources: Array<{ kind: "note" | "selection"; filePath?: string; content: string }>): Promise<{ markdown: string; sources: WritingStyleSourceRef[]; agent: import("./types").ChatAgentId; model: string }> {
    if (!sources.length) throw new Error("请至少选择一篇代表作或当前选段。");
    const captured = allocateWritingStyleSources(sources, this.data.settings.maxContextChars, Date.now, sha256Text)
      .filter(source => source.content.length);
    if (!captured.length) throw new Error("代表作内容为空或上下文预算为 0。");
    const agent = this.data.settings.activeChatAgent;
    const model = agent === "codex" ? this.data.settings.codexModel : agent === "claude" ? this.data.settings.claudeModel : this.data.settings.workbuddyModel;
    const result = await withIsolatedStyleExtractionCwd(cwd => this.chatRuntime.runNoToolOneShot({
      agent,
      cwd,
      prompt: buildStyleExtractionPrompt(captured),
      model,
      reasoningEffort: agent === "codex" ? this.data.settings.codexReasoningEffort || undefined : undefined,
    }));
    return { markdown: result.text, sources: captured.map(({ content: _content, ...source }) => source), agent, model: model || "默认" };
  }

  async exportWritingStyleSkill(): Promise<void> {
    const profile = this.data.writingStyleProfile;
    if (!profile) throw new Error("请先确认一份我的文风档案。");
    const relativePath = WRITING_STYLE_SKILL_PATH;
    const absolutePath = join(this.getVaultBasePath(), relativePath);
    const content = renderStyleSkill(profile);
    const previous = profile.lastSkillExport;
    const next = { path: relativePath, contentHash: sha256Text(content), exportedAt: Date.now() };
    const transactionId = randomUUID();
    const recoveryDirectory = join(this.getVaultBasePath(), ".writex-recovery", transactionId);
    await exportStyleSkillTransaction({
      adapter: {
        identity: async path => stat(path, { bigint: true })
          .then(file => ({ owner: `${file.dev}:${file.ino}`, version: `${file.ctimeNs}:${file.size}` }))
          .catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : Promise.reject(error)),
        prepareRecoveryDirectory: async path => {
          await mkdir(dirname(path), { recursive: true });
          await mkdir(path, { mode: 0o700 });
        },
        prepareTargetParent: async path => { await mkdir(dirname(path), { recursive: true }); },
        writeExclusive: async (path, value) => {
          const file = await open(path, "wx", 0o600);
          try {
            await file.writeFile(value, "utf8"); await file.sync();
            const written = await file.stat({ bigint: true });
            return { owner: `${written.dev}:${written.ino}`, version: `${written.ctimeNs}:${written.size}` };
          }
          finally { await file.close(); }
        },
        linkNoReplace: async (from, to) => {
          try { await link(from, to); return { linked: true }; }
          catch (error) { return { linked: false, error }; }
        },
        updateExisting: async ({ path, backupPath, content, previousExportHash, hash }) => {
          let file;
          try { file = await open(path, "r+"); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, updated: false };
            return { exists: true, updated: false, error };
          }
          let backup: import("./writingStyleController").StyleFileIdentity | undefined;
          try {
            const beforeStat = await file.stat({ bigint: true });
            const beforeIdentity = { owner: `${beforeStat.dev}:${beforeStat.ino}`, version: `${beforeStat.ctimeNs}:${beforeStat.size}` };
            const before = Buffer.from(await file.readFile()).toString("utf8");
            const pathBefore = await stat(path, { bigint: true });
            if (`${pathBefore.dev}:${pathBefore.ino}` !== beforeIdentity.owner || `${pathBefore.ctimeNs}:${pathBefore.size}` !== beforeIdentity.version) {
              return { exists: true, updated: false, error: new Error("本地 Skill 在更新前已变化") };
            }
            if (!previousExportHash || hash(before) !== previousExportHash) {
              return { exists: true, updated: false, error: new Error("本地 Skill 已被手动修改，WriteX 不会覆盖。请先在外部处理冲突。") };
            }
            const recovery = await open(backupPath, "wx", 0o600);
            try {
              await recovery.writeFile(before, "utf8"); await recovery.sync();
              const written = await recovery.stat({ bigint: true });
              backup = { owner: `${written.dev}:${written.ino}`, version: `${written.ctimeNs}:${written.size}` };
            } finally { await recovery.close(); }
            const beforeWrite = await file.stat({ bigint: true });
            const pathBeforeWrite = await stat(path, { bigint: true });
            if (`${beforeWrite.dev}:${beforeWrite.ino}` !== beforeIdentity.owner || `${beforeWrite.ctimeNs}:${beforeWrite.size}` !== beforeIdentity.version
              || `${pathBeforeWrite.dev}:${pathBeforeWrite.ino}` !== beforeIdentity.owner || `${pathBeforeWrite.ctimeNs}:${pathBeforeWrite.size}` !== beforeIdentity.version) {
              return { exists: true, updated: false, backup, error: new Error("本地 Skill 在写入前已变化，旧字节已保留") };
            }
            const bytes = Buffer.from(content, "utf8");
            await file.truncate(0);
            await file.write(bytes, 0, bytes.length, 0);
            await file.truncate(bytes.length);
            await file.sync();
            const written = await file.stat({ bigint: true });
            const target = await stat(path, { bigint: true });
            const targetIdentity = { owner: `${target.dev}:${target.ino}`, version: `${target.ctimeNs}:${target.size}` };
            if (`${written.dev}:${written.ino}` !== beforeIdentity.owner || targetIdentity.owner !== beforeIdentity.owner || await readFile(path, "utf8") !== content) {
              return { exists: true, updated: false, backup, error: new Error("本地 Skill 路径已被外部替换，旧字节已保留") };
            }
            return { exists: true, updated: true, backup, target: targetIdentity };
          } catch (error) {
            return { exists: true, updated: false, backup, error };
          } finally { await file.close(); }
        },
      },
      path: absolutePath,
      tempPath: join(recoveryDirectory, "candidate.SKILL.md"),
      backupPath: join(recoveryDirectory, "previous.SKILL.md"),
      recoveryDirectory,
      content,
      previousExportHash: previous?.contentHash,
      hash: sha256Text,
      persist: async () => {
        profile.lastSkillExport = next;
        try { await this.persist(); }
        catch (error) { profile.lastSkillExport = previous; throw error; }
      },
    });
  }

  openSettings(): void {
    const app = this.app as ObsidianAppWithSettings;
    app.setting?.open();
    app.setting?.openTabById(this.manifest.id);
  }

  async connectWorkBuddy(signal?: AbortSignal, installIfMissing = false): Promise<"existing-account" | "authorized"> {
    try {
      await this.chatRuntime.workBuddyCliPath();
    } catch (error) {
      if (this.agentSettings.workbuddyPath.trim() || !installIfMissing) throw error;
      await this.installWorkBuddyCli(signal);
      await this.chatRuntime.workBuddyCliPath();
    }
    const result = await this.chatRuntime.connectWorkBuddy({
      signal,
      onAuthorizationUrl: async url => {
        const electron = require("electron") as { shell: { openExternal(url: string): Promise<void> } };
        await electron.shell.openExternal(url);
      },
    });
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof AgentView) void leaf.view.refreshAgentConnectionStatus();
    }
    if (result.status === "not-connected") throw new Error("WorkBuddy 尚未连接账号，请重试。");
    return result.status;
  }

  async openWorkBuddyInstallInstructions(): Promise<void> {
    const electron = require("electron") as { shell: { openExternal(url: string): Promise<void> } };
    await electron.shell.openExternal(WORKBUDDY_QUICKSTART_URL);
  }

  private async installWorkBuddyCli(signal?: AbortSignal): Promise<void> {
    if (process.platform !== "darwin") {
      throw new Error("当前系统请按 WorkBuddy 官方安装说明安装 CLI 后，再点击连接。");
    }
    if (signal?.aborted) throw new Error("已取消 WorkBuddy 安装。");
    let timer = 0;
    try {
      const response = await Promise.race([
        requestUrl({ url: WORKBUDDY_INSTALLER_URL, method: "GET", throw: false }),
        new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error("下载 WorkBuddy 官方安装器超时，请重试。")), 30_000); }),
      ]);
      if (signal?.aborted) throw new Error("已取消 WorkBuddy 安装。");
      if (response.status < 200 || response.status >= 300 || new TextEncoder().encode(response.text).byteLength > 1024 * 1024) {
        throw new Error("无法获取 WorkBuddy 官方安装器，请重试或使用官方安装说明。");
      }
      const directory = await mkdtemp(join(tmpdir(), "writex-workbuddy-installer-"));
      const scriptPath = join(directory, "install.sh");
      try {
        await writeFile(scriptPath, response.text, { encoding: "utf8", mode: 0o700 });
        await chmod(scriptPath, 0o700);
        await this.chatRuntime.installWorkBuddy(scriptPath, signal);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    } finally { window.clearTimeout(timer); }
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

  private persistTopicMutation<T>(mutate: () => T | Promise<T>): Promise<T> {
    return this.topicMutationQueue.run({
      snapshot: () => ({ topics: structuredClone(this.data.topics), profile: structuredClone(this.data.topicPositioningProfile) }),
      mutate,
      persist: () => this.persist(),
      restore: snapshot => {
        this.data.topics = snapshot.topics;
        if (snapshot.profile) this.data.topicPositioningProfile = snapshot.profile;
        else delete this.data.topicPositioningProfile;
      },
    });
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
    await this.persistTopicMutation(() => {
      const topic = renameTopicRecord(this.data.topics, topicId, title);
      if (topic.rating) topic.ratingStale = true;
    });
  }

  async setTopicPositioningProfile(path: string, markdown: string): Promise<void> {
    if (!path.trim() || !markdown.trim()) throw new Error("请选择一份非空的账号定位 Markdown。");
    const profilePath = path.trim();
    const contentHash = sha256Text(markdown);
    const changed = await this.persistTopicMutation(() => {
      const previous = this.data.topicPositioningProfile;
      if (previous?.path === profilePath && previous.contentHash === contentHash) return false;
      this.data.topicPositioningProfile = { path: profilePath, contentHash, updatedAt: Date.now() };
      this.markTopicRatingsStale();
      return true;
    });
    if (changed) {
      this.cancelTopicAnalysisRequests();
      this.refreshTopicLibraryViews();
    }
  }

  async markTopicRatingsStaleForPositioningFile(path: string): Promise<void> {
    if (this.data.topicPositioningProfile?.path !== path) return;
    const file = await this.readTopicPositioningFile(path);
    if (!file) return;
    const changed = await this.persistTopicMutation(() => {
      const profile = this.data.topicPositioningProfile;
      if (!profile || profile.path !== path || profile.contentHash === file.contentHash) return false;
      profile.contentHash = file.contentHash;
      profile.updatedAt = Date.now();
      this.markTopicRatingsStale();
      return true;
    });
    if (changed) {
      this.cancelTopicAnalysisRequests();
      this.refreshTopicLibraryViews();
    }
  }

  private async rebindTopicPositioningProfile(oldPath: string, newPath: string): Promise<void> {
    if (this.data.topicPositioningProfile?.path !== oldPath) return;
    const changed = await this.persistTopicMutation(() => {
      const profile = this.data.topicPositioningProfile;
      if (!profile || profile.path !== oldPath) return false;
      profile.path = newPath;
      profile.updatedAt = Date.now();
      this.markTopicRatingsStale();
      return true;
    });
    if (changed) {
      this.cancelTopicAnalysisRequests();
      this.refreshTopicLibraryViews();
    }
  }

  private async clearTopicPositioningProfileForDeletedFile(path: string): Promise<void> {
    if (this.data.topicPositioningProfile?.path !== path) return;
    const changed = await this.persistTopicMutation(() => {
      if (this.data.topicPositioningProfile?.path !== path) return false;
      delete this.data.topicPositioningProfile;
      this.markTopicRatingsStale();
      return true;
    });
    if (changed) {
      this.cancelTopicAnalysisRequests();
      this.refreshTopicLibraryViews();
    }
  }

  private markTopicRatingsStale(): void {
    for (const topic of this.data.topics) if (topic.rating) topic.ratingStale = true;
  }

  private cancelTopicAnalysisRequests(): void {
    for (const { controller } of this.topicAnalysisRequests.values()) controller.abort();
    this.topicAnalysisRequests.clear();
  }

  private async readTopicPositioningFile(path: string): Promise<{ path: string; contentHash: string } | undefined> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension !== "md" || file.path !== path) return undefined;
    return { path: file.path, contentHash: sha256Text(await this.app.vault.read(file)) };
  }

  async setTopicDecision(topicId: string, value: import("./types").TopicDecisionValue, reason = "", correction = ""): Promise<void> {
    await this.persistTopicMutation(() => {
      const topic = this.findTopicById(topicId);
      if (!topic) throw new Error("这条选题已经不存在。");
      Object.assign(topic, setTopicDecision(topic, value, reason, correction, Date.now()));
    });
  }

  async clearTopicDecision(topicId: string): Promise<void> {
    await this.persistTopicMutation(() => {
      const topic = this.findTopicById(topicId);
      if (!topic) throw new Error("这条选题已经不存在。");
      delete topic.decision;
      topic.updatedAt = Date.now();
    });
  }

  async analyzeTopic(topicId: string, positioningMarkdown: string): Promise<void> {
    const topic = this.findTopicById(topicId);
    let profile = this.data.topicPositioningProfile;
    if (!topic) throw new Error("这条选题已经不存在。");
    if (!profile) throw new Error("请先选择并保存账号定位 Markdown。");
    const positioningHash = sha256Text(positioningMarkdown);
    if (profile.contentHash !== positioningHash) {
      const changed = await this.persistTopicMutation(() => {
        const currentProfile = this.data.topicPositioningProfile;
        if (!currentProfile || currentProfile.path !== profile!.path) throw new Error("账号定位已变化，请重新开始分析。");
        if (currentProfile.contentHash === positioningHash) return false;
        currentProfile.contentHash = positioningHash;
        currentProfile.updatedAt = Date.now();
        this.markTopicRatingsStale();
        return true;
      });
      if (changed) {
        this.cancelTopicAnalysisRequests();
        this.refreshTopicLibraryViews();
      }
      profile = this.data.topicPositioningProfile;
    }
    if (!profile || profile.contentHash !== positioningHash) throw new Error("账号定位已变化，请重新开始分析。");
    if (positioningMarkdown.length > this.data.settings.maxContextChars || topic.content.length > this.data.settings.maxContextChars) throw new Error("账号定位或选题材料超过当前上下文上限；请先精简后再分析。");
    const previousRequest = this.topicAnalysisRequests.get(topicId);
    previousRequest?.controller.abort();
    const controller = new AbortController();
    const decisions = this.data.topics.map(({ title, decision }) => ({ title, decision: decision && { ...decision } }));
    const snapshot: TopicAnalysisSnapshot = { topicId, title: topic.title, content: topic.content, profilePath: profile.path, profileHash: profile.contentHash, decisionVersion: topicDecisionVersion(decisions), token: randomUUID() };
    this.topicAnalysisRequests.set(topicId, { token: snapshot.token, controller });
    const agent = this.agentSettings.topicAnalysisAgent;
    const model = this.agentSettings.topicAnalysisModel;
    try {
      const result = await withIsolatedStyleExtractionCwd(cwd => this.chatRuntime.runNoToolOneShot({ agent, cwd, model, signal: controller.signal, prompt: buildTopicAnalysisPrompt({ topic: snapshot, positioningMarkdown, profileHash: snapshot.profileHash, maxChars: this.data.settings.maxContextChars, decisions }) }));
      const rating = parseTopicRating(result.text, { agent, model: model || "默认", profileHash: snapshot.profileHash, analyzedAt: Date.now() });
      await this.persistTopicMutation(async () => {
        const current = this.findTopicById(topicId);
        const currentProfile = this.data.topicPositioningProfile;
        const file = await this.readTopicPositioningFile(snapshot.profilePath);
        if (!current || !acceptsTopicAnalysisResult({ snapshot, requestToken: this.topicAnalysisRequests.get(topicId)?.token, topic: current, profile: currentProfile, file, decisionVersion: topicDecisionVersion(this.data.topics) })) throw new Error("选题、账号定位或用户决定已变化，未覆盖为旧分析结果。");
        current.rating = rating;
        delete current.ratingStale;
      });
    } finally {
      if (this.topicAnalysisRequests.get(topicId)?.token === snapshot.token) this.topicAnalysisRequests.delete(topicId);
    }
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

  async replaceOriginalSelection(context: SelectionContext, replacement: string): Promise<void> {
    const view = this.findMarkdownView(context.filePath);
    if (!view) throw new Error("请先打开原笔记，再替换选中文字。");
    const editor = view.editor;
    replaceCapturedRange(editor, context, replacement);
  }

  computeSelectionReplacement(context: SelectionContext, markdown: string): string {
    return computeFinalSelectionReplacement(context.text, markdown);
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

  async stageChatAttachments(notePath: string, messageId: string, files: readonly File[]): Promise<ChatAttachment[]> {
    const inputError = validateChatAttachmentInputs(files);
    if (inputError) throw new Error(inputError);
    const noteName = safeSegment(notePath.split("/").pop()?.replace(/\.md$/i, "") ?? "note") || "note";
    const folder = normalizePath(`attachments/agent/${noteName}/chat/${messageId}`);
    await this.ensureFolder(folder);
    const created: ChatAttachment[] = [];
    try {
      for (const file of files) {
        const bytes = await file.arrayBuffer();
        if (!bytes.byteLength || bytes.byteLength > CHAT_ATTACHMENT_MAX_BYTES) throw new Error(`“${file.name || "未命名附件"}”无法作为 Chat 上下文保存。`);
        const inspected = inspectImage(bytes, { fileName: file.name, declaredMime: file.type });
        if (file.type.startsWith("image/") && (!inspected.mimeType || !inspected.complete)) {
          throw new Error(`“${file.name || "未命名图片"}”无法通过文件签名确认图片完整性。`);
        }
        const image = inspected.mimeType && inspected.complete ? inspected : undefined;
        const originalName = chatAttachmentName(file.name);
        let candidate = normalizePath(`${folder}/${originalName}`);
        let suffix = 1;
        while (this.app.vault.getAbstractFileByPath(candidate)) {
          const dot = originalName.lastIndexOf(".");
          const stem = dot > 0 ? originalName.slice(0, dot) : originalName;
          const extension = dot > 0 ? originalName.slice(dot) : "";
          candidate = normalizePath(`${folder}/${stem}-${suffix}${extension}`);
          suffix += 1;
        }
        await this.app.vault.createBinary(candidate, bytes);
        created.push({
          id: randomUUID(),
          name: originalName,
          filePath: candidate,
          mimeType: image?.mimeType ?? ((file.type || "application/octet-stream").trim().toLowerCase().replace(/[^a-z0-9.+/-]/g, "").slice(0, 127) || "application/octet-stream"),
          byteLength: bytes.byteLength,
          kind: image?.mimeType ? "image" : "file",
        });
      }
      return created;
    } catch (error) {
      for (const attachment of created) {
        const file = this.app.vault.getAbstractFileByPath(attachment.filePath);
        if (file instanceof TFile) await this.app.vault.delete(file).catch(() => undefined);
      }
      throw error;
    }
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
  private workBuddyController: AbortController | null = null;
  private workBuddyDisplayGeneration = 0;
  private modelRefreshStatusEl: HTMLElement | null = null;
  private modelRefreshButton: ButtonComponent | null = null;
  private topicAnalysisModelSelect: HTMLSelectElement | null = null;

  constructor(app: App, private readonly plugin: ObsidianAgentPlugin) {
    super(app, plugin);
  }

  private createSettingsGroup(containerEl: HTMLElement, title: string): HTMLElement {
    const group = containerEl.createEl("details", { cls: "oa-settings-group" });
    group.createEl("summary", { text: title });
    return group.createDiv({ cls: "oa-settings-group-content" });
  }

  cancelWorkBuddyConnection(): void {
    this.workBuddyController?.abort();
  }

  renderModelRefreshStatus(): void {
    if (!this.modelRefreshStatusEl) return;
    const labels: Record<import("./types").ChatAgentId, string> = { codex: "Codex", claude: "Claude", workbuddy: "WorkBuddy" };
    const status = this.plugin.getModelRefreshStatus();
    const text = (agent: import("./types").ChatAgentId): string => {
      const current = status[agent];
      if (current.state === "refreshing") return `${labels[agent]}：刷新中…`;
      if (current.state === "updated") return `${labels[agent]}：已更新`;
      if (current.state === "cached") return `${labels[agent]}：刷新失败，继续使用缓存`;
      if (current.state === "failed") return `${labels[agent]}：刷新失败，暂无可用列表`;
      return `${labels[agent]}：尚未刷新`;
    };
    this.modelRefreshStatusEl.setText(["模型列表状态：", ...(["codex", "claude", "workbuddy"] as const).map(text)].join("\n"));
    const refreshing = (["codex", "claude", "workbuddy"] as const).some(agent => status[agent].state === "refreshing");
    this.modelRefreshButton?.setDisabled(refreshing).setButtonText(refreshing ? "刷新中…" : "刷新模型列表");
  }

  refreshTopicAnalysisModelOptions(): void {
    const select = this.topicAnalysisModelSelect;
    if (!select?.isConnected) return;
    select.replaceChildren();
    for (const option of agentModelOptions(this.plugin.agentSettings.topicAnalysisAgent, this.plugin.data.discoveredAgentModels, this.plugin.agentSettings.topicAnalysisModel)) {
      const element = document.createElement("option");
      element.value = option.value;
      element.text = option.label;
      select.append(element);
    }
    select.value = this.plugin.agentSettings.topicAnalysisModel;
  }

  override hide(): void {
    this.workBuddyDisplayGeneration += 1;
    this.cancelWorkBuddyConnection();
    super.hide();
  }

  override display(): void {
    this.workBuddyDisplayGeneration += 1;
    this.cancelWorkBuddyConnection();
    const displayGeneration = this.workBuddyDisplayGeneration;
    const { containerEl } = this;
    containerEl.empty();
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
          new Notice(`Codex CLI 已检测：${await this.plugin.chatRuntime.check("codex")}`);
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
          new Notice(`Claude CLI 已检测：${await this.plugin.chatRuntime.check("claude")}`);
        } catch (error) {
          new Notice(errorMessage(error));
        } finally {
          button.setDisabled(false).setButtonText("检测");
        }
      }));
    const workBuddyStatus = aiSettings.createEl("p", {
      cls: "setting-item-description",
      text: "连接检查不会发送写作请求或消耗模型额度；不会读取 WorkBuddy 桌面 App 的私有登录信息。",
    });
    let installRequired = false;
    let showInstallInstructions = false;
    let refreshWorkBuddyAction: (() => void) | null = null;
    new Setting(aiSettings)
      .setName("连接 WorkBuddy")
      .setDesc("已有账号会直接复用；未登录时才打开腾讯官方授权页（中国站）。没有 CLI 时会显示“安装并连接”；已发现的 CLI 不会自动升级。")
      .addButton(button => {
        let detection = 0;
        refreshWorkBuddyAction = () => {
          const current = ++detection;
          installRequired = false;
          showInstallInstructions = false;
          button.setDisabled(true).setButtonText("检查 WorkBuddy…");
          void this.plugin.chatRuntime.workBuddyCliPath().then(() => {
            if (displayGeneration !== this.workBuddyDisplayGeneration || current !== detection) return;
            button.setDisabled(false).setButtonText("连接 WorkBuddy");
          }).catch(() => {
            if (displayGeneration !== this.workBuddyDisplayGeneration || current !== detection) return;
            if (this.plugin.agentSettings.workbuddyPath.trim()) {
              button.setDisabled(false).setButtonText("连接 WorkBuddy");
              workBuddyStatus.setText("填写的 WorkBuddy CLI 路径不可执行。请修正或清空该路径；清空后才可选择安装。");
              return;
            }
            if (process.platform !== "darwin") {
              showInstallInstructions = true;
              button.setDisabled(false).setButtonText("查看官方安装说明");
              workBuddyStatus.setText("当前系统请先按 WorkBuddy 官方说明安装 CLI，再回来连接。");
              return;
            }
            installRequired = true;
            button.setDisabled(false).setButtonText("安装并连接");
            workBuddyStatus.setText("未发现 WorkBuddy CLI。点击“安装并连接”才会下载并执行官方 macOS 安装器。");
          });
        };
        refreshWorkBuddyAction();
        return button.setButtonText("检查 WorkBuddy…").setDisabled(true).setCta().onClick(async () => {
          if (showInstallInstructions) {
            button.setDisabled(true).setButtonText("正在打开…");
            try {
              await this.plugin.openWorkBuddyInstallInstructions();
              workBuddyStatus.setText("已打开 WorkBuddy 官方安装说明。安装完成后重新打开此设置页即可连接。");
            } catch {
              workBuddyStatus.setText("无法打开 WorkBuddy 官方安装说明，请稍后重试。");
            } finally {
              if (displayGeneration === this.workBuddyDisplayGeneration) button.setDisabled(false).setButtonText("查看官方安装说明");
            }
            return;
          }
          if (this.workBuddyController) {
            this.workBuddyController.abort();
            button.setDisabled(true).setButtonText("正在取消…");
            workBuddyStatus.setText("正在取消 WorkBuddy 连接…");
            return;
          }
          const controller = new AbortController();
          this.workBuddyController = controller;
          button.setButtonText("取消连接");
          workBuddyStatus.setText(installRequired
            ? "正在下载并执行 WorkBuddy 官方 macOS 安装器…"
            : "正在检查 WorkBuddy；如未登录，将打开腾讯官方授权页（中国站）…");
          try {
            const status = await this.plugin.connectWorkBuddy(controller.signal, installRequired);
            installRequired = false;
            workBuddyStatus.setText(status === "existing-account"
              ? "已连接已有 WorkBuddy 账号。账号有效期、服务可用性和额度将在实际对话时由 WorkBuddy 确认。"
              : "WorkBuddy 授权已完成。账号有效期、服务可用性和额度将在实际对话时由 WorkBuddy 确认。");
            new Notice("WorkBuddy 已连接。");
          } catch (error) {
            if (!controller.signal.aborted) {
              workBuddyStatus.setText("WorkBuddy 连接未完成，可重试。");
              new Notice(errorMessage(error));
            }
          } finally {
            if (this.workBuddyController === controller) this.workBuddyController = null;
            if (displayGeneration === this.workBuddyDisplayGeneration) {
              if (controller.signal.aborted) workBuddyStatus.setText("已取消 WorkBuddy 连接，可重试。");
              button.setDisabled(false).setButtonText(installRequired ? "安装并连接" : "连接 WorkBuddy");
            }
          }
        });
      });
    new Setting(aiSettings)
      .setName("WorkBuddy CLI 路径（可选）")
      .setDesc("留空时自动发现 codebuddy/cbc。填写后只使用该路径；路径无效时不会静默切换到其他安装。")
      .addText(text => text
        .setPlaceholder("未连接")
        .setValue(this.plugin.agentSettings.workbuddyPath)
        .onChange(async value => {
          this.plugin.agentSettings.workbuddyPath = value.trim();
          await this.plugin.persist();
          refreshWorkBuddyAction?.();
        }));
    new Setting(aiSettings)
      .setName("选题分析 Agent")
      .setDesc("独立于 Chat 的选择；模型列表会在启动后从本机 Agent 刷新，当前选择不会被覆盖。")
      .addDropdown(dropdown => {
        (["codex", "claude", "workbuddy"] as const).forEach(agent => dropdown.addOption(agent, agent === "workbuddy" ? "WorkBuddy" : agent === "codex" ? "Codex" : "Claude"));
        return dropdown.setValue(this.plugin.agentSettings.topicAnalysisAgent).onChange(async value => {
          this.plugin.agentSettings.topicAnalysisAgent = value as AgentSettings["topicAnalysisAgent"];
          await this.plugin.persist(); this.display();
        });
      })
      .addDropdown(dropdown => {
        this.topicAnalysisModelSelect = dropdown.selectEl;
        this.refreshTopicAnalysisModelOptions();
        return dropdown.setValue(this.plugin.agentSettings.topicAnalysisModel).onChange(async value => {
          this.plugin.agentSettings.topicAnalysisModel = value;
          await this.plugin.persist();
        });
      });
    new Setting(aiSettings)
      .setName("模型列表")
      .setDesc("自动刷新会保留你的主动选择；刷新失败时继续使用最近成功的缓存列表。")
      .addButton(button => {
        this.modelRefreshButton = button;
        return button.setButtonText("刷新模型列表").onClick(async () => {
          button.setDisabled(true).setButtonText("刷新中…");
          try {
            await this.plugin.refreshDiscoveredModels();
            new Notice("模型列表已刷新。各提供方状态见下方。 ");
          } catch (error) {
            new Notice(errorMessage(error));
          } finally {
            this.renderModelRefreshStatus();
          }
        });
      });
    this.modelRefreshStatusEl = aiSettings.createEl("p", { cls: "setting-item-description" });
    this.renderModelRefreshStatus();
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
      .setName("允许 Codex 联网检索")
      .setDesc("默认关闭。开启后仅 Codex Chat 可使用已验证的原生联网检索；Claude 与 WorkBuddy 保持禁网，不会静默切换 Agent。设置开启不代表本轮已检索。")
      .addToggle(toggle => toggle.setValue(this.plugin.agentSettings.codexWebSearchEnabled).onChange(async value => {
        this.plugin.agentSettings.codexWebSearchEnabled = value;
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
  return normalizeAssistantMarkdown(value);
}

function safeSegment(value: string): string {
  return value.replace(/[\\/:*?"<>|#^[\]]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80);
}

function chatAttachmentName(value: string): string {
	const name = safeSegment(value).slice(0, 160);
	return name && name !== "." && name !== ".." ? name : "attachment";
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
