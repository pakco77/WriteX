import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  FuzzySuggestModal,
  Modal,
  Notice,
  Setting,
  TFile,
  requestUrl,
} from "obsidian";
import { inspectImage, planWeChatImage, type ImageInspection } from "./images";
import { describeImageProblem, missingImageInspection, type ImageProblem } from "./imageProblems";
import { convertForWeChat } from "./imageConversion";
import type ObsidianAgentPlugin from "./main";
import { runSync, type SyncAsset, type SyncSnapshot } from "./syncFlow";
import type { SyncSuccessState } from "./syncFlow";
import { getPlaceholderCover } from "./placeholderCover";
import {
  assetPlaceholder,
  buildConfirmationSummary,
  computeContentHash,
  characterCount,
  MAX_TITLE_GRAPHEMES,
  preflightDraft,
  resolveCoverPath,
  resolveDraftIdForTitle,
  resolveDraftMetadata,
  uploadFileName,
  type DraftMetadata,
  type PreflightIssue,
} from "./wechatSync";
import { extractMarkdownImageSources } from "./wechat";
import { WriteRelayClient, type RelayTransport } from "./writeRelay";
import { WriteCloudClient, type CloudQuote, type CloudTransport } from "./writeCloud";
import { localizedRemoteImageName, replaceRemoteMarkdownImages } from "./remoteImages";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif"]);
const REMOTE_IMAGE = /^(https?:|data:|blob:|app:)/i;
const DOWNLOADABLE_REMOTE_IMAGE = /^https?:/i;
const MAX_REMOTE_IMAGE_BYTES = 100 * 1024 * 1024;

interface DownloadedRemoteImage {
  source: string;
  bytes: ArrayBuffer;
  mimeType: string;
  sha256: string;
}

interface PreparedNote {
  file: TFile;
  originalMarkdown: string;
  metadata: DraftMetadata;
  contentAssets: SyncAsset[];
  cover?: SyncAsset;
  html: string;
  issues: PreflightIssue[];
  rendererLabel: string;
  gifCount: number;
  pendingAnimationConversions: number;
  coverLabel: string;
  remoteImages: string[];
  imageProblems: ImageProblem[];
  snapshot?: SyncSnapshot;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(bytes: ArrayBuffer): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function remoteImageLabel(source: string): string {
  try {
    return new URL(source).hostname;
  } catch {
    return "远程来源";
  }
}

async function downloadRemoteImage(source: string): Promise<DownloadedRemoteImage> {
  if (!DOWNLOADABLE_REMOTE_IMAGE.test(source)) throw new Error("仅支持保存 HTTP 或 HTTPS 远程图片。");
  let timeout = 0;
  const response = await Promise.race([
    requestUrl({ url: source, method: "GET", throw: false }),
    new Promise<never>((_, reject) => {
      timeout = window.setTimeout(() => reject(new Error("下载超过 30 秒，请检查图片地址后重试。")), 30000);
    }),
  ]).finally(() => window.clearTimeout(timeout));
  if (response.status < 200 || response.status >= 300) throw new Error(`图片服务器返回 HTTP ${response.status}。`);
  const bytes = response.arrayBuffer;
  if (!bytes.byteLength) throw new Error("下载结果为空。");
  if (bytes.byteLength > MAX_REMOTE_IMAGE_BYTES) throw new Error("远程图片超过 100 MB，已停止保存。");
  const declaredMime = Object.entries(response.headers)
    .find(([name]) => name.toLowerCase() === "content-type")?.[1]
    ?.split(";", 1)[0]
    ?.trim();
  let fileName = "remote-image";
  try {
    fileName = decodeURIComponent(new URL(source).pathname.split("/").filter(Boolean).at(-1) ?? fileName);
  } catch {
    // The signature check below remains authoritative when a URL cannot be decoded.
  }
  const inspection = inspectImage(bytes, { fileName, declaredMime });
  if (!inspection.mimeType) throw new Error("下载内容不是 WriteX 支持的图片格式。");
  if (!inspection.complete) throw new Error("下载到的图片文件不完整或已经损坏。");
  return { source, bytes, mimeType: inspection.mimeType, sha256: sha256(bytes) };
}

async function findExistingLocalizedImage(
  plugin: ObsidianAgentPlugin,
  fileName: string,
  expectedSha256: string,
): Promise<TFile | null> {
  const dot = fileName.lastIndexOf(".");
  const stem = dot === -1 ? fileName : fileName.slice(0, dot);
  const extension = dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
  const candidates = plugin.app.vault.getFiles().filter(file => (
    file.extension.toLowerCase() === extension && file.basename.startsWith(stem)
  ));
  for (const file of candidates) {
    try {
      if (sha256(await plugin.app.vault.readBinary(file)) === expectedSha256) return file;
    } catch {
      // An unreadable candidate is not reusable; normal attachment creation can still continue.
    }
  }
  return null;
}

async function normalizeAsset(
  plugin: ObsidianAgentPlugin,
  file: TFile,
  role: "content" | "cover",
  allowAnimationLoss: boolean,
): Promise<SyncAsset> {
  let bytes = await plugin.app.vault.readBinary(file);
  let inspection = inspectImage(bytes, { fileName: file.name });
  let mimeType = inspection.mimeType;
  if (!mimeType) throw new Error(`无法通过文件签名识别图片内容：${file.path}`);
  if (!inspection.complete) throw new Error(`图片文件不完整或损坏：${file.path}`);
  const originalSha256 = sha256(bytes);
  const originalMimeType = mimeType;
  let converted = false;
  const plan = planWeChatImage(inspection, role);
  if (plan.status === "blocked") throw new Error(`${plan.reason ?? "图片当前无法处理"}：${file.path}`);
  if (plan.status === "convert" && plan.requiresConfirmation && !allowAnimationLoss) {
    return {
      role,
      source: file.path,
      fileName: file.name,
      mimeType,
      bytes,
      sha256: originalSha256,
      converted: false,
      originalSha256,
      originalMimeType: mimeType,
      inspection,
      pendingConversion: true,
      animationLoss: true,
    };
  }
  if (plan.status === "convert") {
    const targetMime = plan.targetMime === "image/png" ? "image/png" : "image/jpeg";
    bytes = await convertForWeChat(
      bytes,
      inspection,
      targetMime,
      role === "content" ? 1024 * 1024 : 10 * 1024 * 1024 + 1,
    );
    mimeType = targetMime;
    inspection = inspectImage(bytes, { fileName: uploadFileName(file.name, mimeType), declaredMime: mimeType });
    if (!inspection.complete) throw new Error(`图片转换结果无效：${file.path}`);
    converted = true;
  }
  return {
    role,
    source: file.path,
    fileName: uploadFileName(file.name, mimeType),
    mimeType,
    bytes,
    sha256: sha256(bytes),
    converted,
    originalSha256,
    originalMimeType,
    inspection,
    animationLoss: plan.animationLoss,
  };
}

function placeholderCoverAsset(): SyncAsset {
  const cover = getPlaceholderCover();
  return {
    role: "cover",
    source: cover.source,
    fileName: cover.fileName,
    mimeType: cover.mimeType,
    bytes: cover.bytes,
    sha256: cover.sha256,
    converted: false,
    originalSha256: cover.sha256,
    originalMimeType: cover.mimeType,
    inspection: inspectImage(cover.bytes, { fileName: cover.fileName, declaredMime: cover.mimeType }),
    placeholder: true,
  };
}

function resolveVaultImage(plugin: ObsidianAgentPlugin, source: string, notePath: string): TFile | null {
  const direct = plugin.app.vault.getAbstractFileByPath(source);
  if (direct instanceof TFile) return direct;
  return plugin.app.metadataCache.getFirstLinkpathDest(source, notePath);
}

async function prepareNote(
  plugin: ObsidianAgentPlugin,
  notePath: string,
  themeId: string,
  selectedCoverPath: string,
  commentsEnabled: boolean,
  onlyFansCanComment: boolean,
  selectedTitle: string,
  allowAnimationLoss: boolean,
  forcePlaceholderCover: boolean,
  onProgress: (message: string) => void = () => undefined,
): Promise<PreparedNote> {
  const file = plugin.app.vault.getAbstractFileByPath(notePath);
  if (!(file instanceof TFile)) throw new Error("当前笔记已经移动或删除。");
  const markdown = await plugin.app.vault.cachedRead(file);
  const cache = plugin.app.metadataCache.getFileCache(file);
  const metadata = resolveDraftMetadata({
    frontmatter: cache?.frontmatter ?? {},
    markdown,
    fileName: file.name,
    defaultAuthor: plugin.agentSettings.defaultWeChatAuthor,
  });
  metadata.commentsEnabled = commentsEnabled;
  metadata.onlyFansCanComment = commentsEnabled && onlyFansCanComment;
  if (selectedTitle.trim()) metadata.title = selectedTitle.trim();
  metadata.coverPath = resolveCoverPath(selectedCoverPath, metadata.coverPath, forcePlaceholderCover);

  const issues: PreflightIssue[] = [];
  const unresolvedImages: string[] = [];
  const remoteImages: string[] = [];
  const imageProblems: ImageProblem[] = [];
  const placeholderBySource = new Map<string, string>();
  const assetByHash = new Map<string, SyncAsset>();

  const imageSources = extractMarkdownImageSources(markdown);
  for (let index = 0; index < imageSources.length; index += 1) {
    const source = imageSources[index];
    onProgress(`${allowAnimationLoss ? "正在准备微信图片" : "正在检查图片"} ${index + 1}/${imageSources.length} · ${source}`);
    if (REMOTE_IMAGE.test(source)) {
      remoteImages.push(source);
      continue;
    }
    const imageFile = resolveVaultImage(plugin, source, file.path);
    if (!imageFile) {
      unresolvedImages.push(source);
      imageProblems.push(describeImageProblem({ source, articleIndex: index + 1, total: imageSources.length, inspection: missingImageInspection("无法在 Vault 中找到正文图片。") }));
      continue;
    }
    try {
      const asset = await normalizeAsset(plugin, imageFile, "content", allowAnimationLoss);
      imageProblems.push(describeImageProblem({ source, articleIndex: index + 1, total: imageSources.length, inspection: asset.inspection! }));
      assetByHash.set(asset.sha256, assetByHash.get(asset.sha256) ?? asset);
      placeholderBySource.set(source, assetPlaceholder(asset.sha256));
    } catch (error) {
      issues.push({ level: "block", code: "invalid_content_image", message: errorMessage(error), assetPath: source });
      imageProblems.push(describeImageProblem({ source, articleIndex: index + 1, total: imageSources.length, inspection: missingImageInspection(errorMessage(error)) }));
    }
  }

  let cover: SyncAsset | undefined;
  if (metadata.coverPath) {
    onProgress(`正在检查封面 · ${metadata.coverPath}`);
    const coverFile = resolveVaultImage(plugin, metadata.coverPath, file.path);
    if (!coverFile) {
      issues.push({ level: "block", code: "missing_cover_file", message: "找不到所选封面。", assetPath: metadata.coverPath });
    } else {
      try {
        cover = await normalizeAsset(plugin, coverFile, "cover", allowAnimationLoss);
        metadata.coverPath = coverFile.path;
      } catch (error) {
        issues.push({ level: "block", code: "invalid_cover", message: errorMessage(error), assetPath: metadata.coverPath });
      }
    }
  } else {
    cover = placeholderCoverAsset();
  }

  const contentAssets = [...assetByHash.values()];
  const rendered = plugin.themeService.render(
    markdown,
    themeId,
    source => placeholderBySource.get(source) ?? source,
  );
  const html = rendered.html;
  const rendererVersion = `theme:${rendered.themeId}:${rendered.themeVersion}:${rendered.themeHash}`;
  const rendererLabel = rendered.themeName;
  for (const source of imageSources) {
    const placeholder = placeholderBySource.get(source);
    if (placeholder && !html.includes(placeholder)) {
      issues.push({
        level: "block",
        code: "theme_render_missing_image",
        message: "当前排版没有保留正文图片，已阻止同步。",
        assetPath: source,
      });
    }
  }
  issues.push(...preflightDraft({
    metadata,
    markdown,
    html,
    contentAssets: contentAssets.map(asset => ({
      role: asset.role,
      source: asset.source,
      mimeType: asset.mimeType,
      byteLength: asset.bytes.byteLength,
      converted: asset.converted,
      originalMimeType: asset.originalMimeType,
      pendingConversion: asset.pendingConversion,
      animated: asset.inspection?.animated,
      frameCount: asset.inspection?.frameCount,
      width: asset.inspection?.width,
      height: asset.inspection?.height,
      animationLoss: asset.animationLoss,
    })),
    cover: cover ? {
      role: "cover",
      source: cover.source,
      mimeType: cover.mimeType,
      byteLength: cover.bytes.byteLength,
      converted: cover.converted,
      originalMimeType: cover.originalMimeType,
      pendingConversion: cover.pendingConversion,
      animated: cover.inspection?.animated,
      frameCount: cover.inspection?.frameCount,
      width: cover.inspection?.width,
      height: cover.inspection?.height,
      animationLoss: cover.animationLoss,
      placeholder: cover.placeholder,
    } : undefined,
    unresolvedImages,
    remoteImages,
  }));

  const prepared: PreparedNote = {
    file,
    originalMarkdown: markdown,
    metadata,
    contentAssets,
    cover,
    html,
    issues,
    rendererLabel,
    gifCount: contentAssets.filter(asset => asset.originalMimeType === "image/gif").length,
    pendingAnimationConversions: contentAssets.filter(asset => asset.pendingConversion).length + (cover?.pendingConversion ? 1 : 0),
    coverLabel: cover?.placeholder ? "纯白占位封面（默认）" : metadata.coverPath,
    remoteImages: [...new Set(remoteImages)],
    imageProblems,
  };
  if (cover && !issues.some(issue => issue.level === "block")) {
    const contentHash = computeContentHash({
      metadata,
      markdown,
      themeId,
      rendererVersion,
      coverHash: cover.sha256,
      contentAssetHashes: contentAssets.map(asset => asset.sha256),
    });
    prepared.snapshot = {
      notePath,
      metadata,
      markdown,
      html,
      themeId,
      contentHash,
      contentAssets,
      cover,
    };
  }
  return prepared;
}

function relayTransport(): RelayTransport {
  return async request => {
    let timeout = 0;
    // ponytail: requestUrl has no AbortSignal; Relay idempotency makes a UI timeout safe to retry.
    const response = await Promise.race([
      requestUrl({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body,
        throw: false,
      }),
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(() => reject(new Error("Relay 请求超时，请使用同一内容重试。")), 60000);
      }),
    ]).finally(() => window.clearTimeout(timeout));
    return { status: response.status, json: response.json as unknown };
  };
}

function cloudTransport(): CloudTransport {
  return relayTransport();
}

export async function createRelayClient(plugin: ObsidianAgentPlugin): Promise<WriteRelayClient> {
  const key = await plugin.getRelayKey();
  return new WriteRelayClient(plugin.agentSettings.relayUrl, key, relayTransport());
}

export async function verifyRelayConnection(plugin: ObsidianAgentPlugin) {
  return (await createRelayClient(plugin)).verify();
}

export async function createCloudClient(
  plugin: ObsidianAgentPlugin,
  accessToken?: string,
): Promise<WriteCloudClient> {
  const token = accessToken ?? await plugin.getCloudToken();
  return new WriteCloudClient(plugin.agentSettings.cloudUrl, token, cloudTransport());
}

class VaultImageSuggestModal extends FuzzySuggestModal<TFile> {
  private readonly choose: (file: TFile) => void;

  constructor(plugin: ObsidianAgentPlugin, choose: (file: TFile) => void) {
    super(plugin.app);
    this.choose = choose;
    this.setPlaceholder("选择 Vault 中的封面图片…");
  }

  getItems(): TFile[] {
    return this.app.vault.getFiles().filter(file => IMAGE_EXTENSIONS.has(file.extension.toLowerCase()));
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.choose(file);
  }
}

class WeChatSyncModal extends Modal {
  private readonly plugin: ObsidianAgentPlugin;
  private readonly notePath: string;
  private readonly themeId: string;
  private selectedCoverPath = "";
  private selectedTitle = "";
  private commentsEnabled = true;
  private onlyFansCanComment = false;
  private allowAnimationLoss = false;
  private forcePlaceholderCover = false;
  private prepared: PreparedNote | null = null;
  private accountName = "";
  private accountId = "";
  private relayClient: WriteRelayClient | null = null;
  private cloudClient: WriteCloudClient | null = null;
  private cloudQuote: CloudQuote | null = null;
  private busy = false;
  private fatalError = "";
  private syncProgress = "";

  constructor(plugin: ObsidianAgentPlugin, notePath: string, themeId: string) {
    super(plugin.app);
    this.plugin = plugin;
    this.notePath = notePath;
    this.themeId = themeId;
  }

  onOpen(): void {
    this.modalEl.addClass("oa-sync-modal");
    this.setTitle("同步到微信公众号草稿箱");
    void this.refreshPreparation();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async refreshPreparation(): Promise<void> {
    this.busy = true;
    this.fatalError = "";
    this.render();
    try {
      this.prepared = await prepareNote(
        this.plugin,
        this.notePath,
        this.themeId,
        this.selectedCoverPath,
        this.commentsEnabled,
        this.onlyFansCanComment,
        this.selectedTitle,
      this.allowAnimationLoss,
      this.forcePlaceholderCover,
      message => {
        this.syncProgress = message;
        this.render();
      },
      );
      if (!this.selectedCoverPath) this.selectedCoverPath = this.prepared.metadata.coverPath;
      if (!this.selectedTitle) this.selectedTitle = this.prepared.metadata.title;
    } catch (error) {
      this.prepared = null;
      this.fatalError = errorMessage(error);
    } finally {
      this.busy = false;
      this.syncProgress = "";
      this.accountName = "";
      this.accountId = "";
      this.relayClient = null;
      this.cloudClient = null;
      this.cloudQuote = null;
      this.render();
    }
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();
    if (this.busy) {
      container.createEl("p", { text: this.syncProgress || "正在生成本地同步快照…" });
      return;
    }
    if (this.fatalError) {
      container.createEl("p", { cls: "oa-sync-error", text: this.fatalError });
      if (!this.prepared) return;
    }
    if (!this.prepared) return;

    container.createEl("p", {
      cls: "setting-item-description",
      text: this.plugin.agentSettings.syncRoute === "self-hosted"
        ? "只创建或更新草稿，不发布、不群发。用户自建 Relay 的 WriteX 积分永远为 0。"
        : "只创建或更新草稿，不发布、不群发。Write Cloud 每次同步消耗 1 个体验积分，执行前明确报价并确认。",
    });
    if (this.accountName) this.renderConfirmation(container);
    this.renderTitle(container);
    this.renderMeta(container);
    this.renderIssues(container);
    this.renderAnimationConsent(container);
    this.renderCover(container);
    this.renderComments(container);

    const unchanged = this.prepared.snapshot
      && this.prepared.metadata.draftId
      && this.sameDraftTarget()
      && this.prepared.snapshot.contentHash === this.prepared.metadata.previousContentHash;
    if (unchanged) {
      container.createEl("div", { cls: "oa-sync-success", text: "这篇草稿已经是最新版本，本次没有连接 Relay。" });
      return;
    }

    const hasBlock = this.prepared.issues.some(issue => issue.level === "block");
    if (hasBlock) return;
    const route = this.plugin.agentSettings.syncRoute;
    const missingConfiguration = route === "self-hosted"
      ? !this.plugin.agentSettings.relayUrl || !this.plugin.agentSettings.hasRelayKey
      : !this.plugin.agentSettings.cloudUrl
        || !this.plugin.agentSettings.hasCloudToken
        || !this.plugin.agentSettings.cloudConnectionId
        || !this.plugin.agentSettings.cloudAccountId;
    if (missingConfiguration) {
      const row = container.createDiv({ cls: "oa-sync-config-needed" });
      row.createEl("p", { text: route === "self-hosted"
        ? "请先在 WriteX 设置中保存 Relay URL 和 Relay Key。"
        : "请先在 WriteX 设置中开始免费体验，并验证目标公众号。" });
      const open = row.createEl("button", { text: "打开设置", attr: { type: "button" } });
      open.onclick = () => this.plugin.openSettings();
      return;
    }

    if (!this.accountName) {
      const verify = container.createEl("button", {
        cls: "mod-cta",
        text: route === "self-hosted" ? "检查 Relay 并进入确认" : "读取体验积分报价",
        attr: { type: "button" },
      });
      verify.onclick = () => void (route === "self-hosted" ? this.verifyRelay() : this.quoteCloud());
      return;
    }
  }

  private renderMeta(container: HTMLElement): void {
    const grid = container.createDiv({ cls: "oa-sync-grid" });
    const themeLabel = this.prepared?.rendererLabel ?? this.themeId;
    for (const [label, value] of [
      ["文章", this.prepared?.metadata.title ?? ""],
      ["笔记", this.notePath],
      ["排版", themeLabel],
      ["正文图片", `${this.prepared?.contentAssets.length ?? 0} 张`],
    ]) {
      const row = grid.createDiv({ cls: "oa-sync-grid-row" });
      row.createEl("span", { text: label });
      row.createEl("strong", { text: value });
    }
  }

  private renderTitle(container: HTMLElement): void {
    const section = container.createDiv({ cls: "oa-sync-title" });
    section.createEl("strong", { text: "同步标题" });
    const input = section.createEl("input", {
      attr: { type: "text", maxlength: "240", "aria-label": "微信公众号草稿标题" },
    });
    input.value = this.selectedTitle || this.prepared?.metadata.title || "";
    const count = section.createEl("span", { cls: "oa-sync-title-count" });
    const updateCount = () => {
      const characters = characterCount(input.value.trim());
      count.setText(`${characters} / ${MAX_TITLE_GRAPHEMES}`);
      count.toggleClass("is-over", characters > MAX_TITLE_GRAPHEMES || characters === 0);
    };
    input.oninput = updateCount;
    input.onchange = () => {
      this.selectedTitle = input.value.trim();
      void this.refreshPreparation();
    };
    updateCount();
  }

  private renderIssues(container: HTMLElement): void {
    if (!this.prepared?.issues.length) return;
    const list = container.createDiv({ cls: "oa-sync-issues" });
    for (const issue of this.prepared.issues) {
      if (issue.code === "remote_image" && issue.assetPath) {
        this.renderRemoteImageIssue(list, issue.assetPath);
        continue;
      }
      const problem = issue.assetPath ? this.prepared.imageProblems.find(item => item.source === issue.assetPath) : undefined;
      if (problem?.status === "unrepairable") {
        const row = list.createDiv({ cls: "oa-sync-image-issue" });
        const file = resolveVaultImage(this.plugin, problem.source, this.notePath);
        if (file) row.createEl("img", { attr: { src: this.plugin.app.vault.getResourcePath(file), alt: problem.articleLabel ?? "异常图片" } });
        else row.createDiv({ cls: "oa-sync-image-fallback", text: "图片不可用" });
        const detail = row.createDiv();
        detail.createEl("strong", { text: `${problem.articleLabel ?? "正文图片"} · 需要替换` });
        detail.createEl("span", { text: problem.reason });
        detail.createEl("code", { text: problem.source });
        continue;
      }
      const label = issue.level === "block" ? "阻塞" : issue.level === "warn" ? "警告" : "已处理";
      list.createEl("div", {
        cls: `oa-sync-issue is-${issue.level}`,
        text: `${label} · ${issue.message}${issue.assetPath ? `（${issue.assetPath}）` : ""}`,
      });
    }
    if (this.prepared.remoteImages.length) {
      const actions = list.createDiv({ cls: "oa-sync-remote-actions" });
      actions.createEl("p", {
        text: this.prepared.remoteImages.length === 1
          ? "保存后会更新正文图片链接，并自动重新检查。"
          : `一次保存这 ${this.prepared.remoteImages.length} 张图片，更新正文链接后自动重新检查。`,
      });
      const save = actions.createEl("button", {
        cls: "mod-cta",
        text: this.prepared.remoteImages.length === 1 ? "保存到 Vault 并继续" : `全部保存到 Vault 并继续（${this.prepared.remoteImages.length}）`,
        attr: { type: "button" },
      });
      save.onclick = () => void this.localizeRemoteImages();
    }
  }

  private renderRemoteImageIssue(container: HTMLElement, source: string): void {
    const row = container.createDiv({ cls: "oa-sync-remote-issue" });
    const preview = row.createEl("img", {
      cls: "oa-sync-remote-preview",
      attr: {
        src: source,
        alt: "需要保存到 Vault 的远程图片",
        loading: "lazy",
        referrerpolicy: "no-referrer",
      },
    });
    preview.onerror = () => row.addClass("is-preview-failed");
    const detail = row.createDiv({ cls: "oa-sync-remote-detail" });
    detail.createEl("strong", { text: "远程图片需要先保存" });
    detail.createEl("span", { cls: "oa-sync-remote-status", text: "阻塞 · 需要本地化" });
    detail.createEl("span", { cls: "oa-sync-remote-source", text: remoteImageLabel(source) });
    detail.createEl("code", { text: source, attr: { title: source } });
  }

  private async localizeRemoteImages(): Promise<void> {
    const prepared = this.prepared;
    if (!prepared?.remoteImages.length || this.busy) return;
    const current = await this.plugin.app.vault.cachedRead(prepared.file);
    if (current !== prepared.originalMarkdown) {
      new Notice("正文在检查后发生了变化，已重新预检；未下载图片。");
      await this.refreshPreparation();
      return;
    }
    this.busy = true;
    this.fatalError = "";
    const createdFiles: TFile[] = [];
    let startedMarkdownWrite = false;
    this.render();
    try {
      const replacements = new Map<string, string>();
      for (let index = 0; index < prepared.remoteImages.length; index += 1) {
        const source = prepared.remoteImages[index];
        this.syncProgress = `正在保存远程图片 ${index + 1}/${prepared.remoteImages.length} · ${remoteImageLabel(source)}`;
        this.render();
        try {
          const downloaded = await downloadRemoteImage(source);
          const name = localizedRemoteImageName(source, downloaded.mimeType, downloaded.sha256, index);
          const existing = await findExistingLocalizedImage(this.plugin, name, downloaded.sha256);
          if (existing) {
            replacements.set(source, existing.path);
          } else {
            const path = await this.plugin.app.fileManager.getAvailablePathForAttachment(name, prepared.file.path);
            const stored = await this.plugin.app.vault.createBinary(path, downloaded.bytes);
            createdFiles.push(stored);
            replacements.set(source, path);
          }
        } catch (error) {
          throw new Error(`保存第 ${index + 1} 张远程图片失败（${remoteImageLabel(source)}）：${errorMessage(error)}`, { cause: error });
        }
      }
      const updated = replaceRemoteMarkdownImages(prepared.originalMarkdown, replacements);
      if (updated === prepared.originalMarkdown) throw new Error("没有在正文中找到可替换的远程图片链接。");
      startedMarkdownWrite = true;
      await this.plugin.app.vault.modify(prepared.file, updated);
      const reused = prepared.remoteImages.length - createdFiles.length;
      new Notice(`已准备 ${prepared.remoteImages.length} 张图片并更新正文链接${reused ? `（复用 ${reused} 张）` : ""}。`);
      this.busy = false;
      this.syncProgress = "";
      await this.refreshPreparation();
    } catch (error) {
      if (!startedMarkdownWrite) {
        for (const file of createdFiles.reverse()) {
          try {
            await this.plugin.app.vault.delete(file);
          } catch {
            // Leave the recoverable attachment in place if cleanup itself fails.
          }
        }
      }
      this.busy = false;
      this.syncProgress = "";
      this.fatalError = errorMessage(error);
      this.render();
    }
  }

  private renderAnimationConsent(container: HTMLElement): void {
    const pending = this.prepared?.pendingAnimationConversions ?? 0;
    if (!pending) return;
    const panel = container.createDiv({ cls: "oa-sync-animation-consent" });
    panel.createEl("strong", { text: `${pending} 张动态 GIF 需要你的决定` });
    panel.createEl("p", {
      text: "微信草稿正文 API 只接受小于 1 MB 的 JPG/PNG。继续会生成静态替代图，原 GIF 保留在 Vault，但草稿正文中的动画会丢失。",
    });
    const button = panel.createEl("button", {
      text: "我确认生成静态替代图",
      attr: { type: "button" },
    });
    button.onclick = () => {
      this.allowAnimationLoss = true;
      void this.refreshPreparation();
    };
  }

  private renderCover(container: HTMLElement): void {
    const section = container.createDiv({ cls: "oa-sync-cover" });
    section.createEl("strong", { text: "封面" });
    const cover = this.prepared?.cover;
    if (cover) {
      const preview = section.createEl("img", {
        cls: "oa-sync-cover-preview",
        attr: { alt: this.prepared?.coverLabel ?? "封面预览" },
      });
      preview.src = cover.placeholder
        ? `data:${cover.mimeType};base64,${Buffer.from(cover.bytes).toString("base64")}`
        : this.app.vault.getResourcePath(this.app.vault.getAbstractFileByPath(cover.source) as TFile);
    }
    section.createEl("p", { text: `来源：${this.prepared?.coverLabel || "未选择"}` });
    const actions = section.createDiv({ cls: "oa-sync-cover-actions" });
    for (const asset of this.plugin.getNoteState(this.notePath).assets.slice(0, 4)) {
      const button = actions.createEl("button", { text: `图片集 · ${asset.name}`, attr: { type: "button", title: asset.filePath } });
      button.onclick = () => {
        this.forcePlaceholderCover = false;
        this.selectedCoverPath = asset.filePath;
        void this.refreshPreparation();
      };
    }
    const vault = actions.createEl("button", { text: "从 Vault 选择", attr: { type: "button" } });
    vault.onclick = () => new VaultImageSuggestModal(this.plugin, file => {
      this.forcePlaceholderCover = false;
      this.selectedCoverPath = file.path;
      void this.refreshPreparation();
    }).open();
    if (!cover?.placeholder) {
      const reset = actions.createEl("button", { text: "使用默认纯白封面", attr: { type: "button" } });
      reset.onclick = () => {
        this.forcePlaceholderCover = true;
        this.selectedCoverPath = "";
        void this.refreshPreparation();
      };
    }
  }

  private renderComments(container: HTMLElement): void {
    new Setting(container)
      .setName("允许留言")
      .setDesc("默认开启，可在本次同步前关闭。")
      .addToggle(toggle => toggle.setValue(this.commentsEnabled).onChange(value => {
        this.commentsEnabled = value;
        if (!value) this.onlyFansCanComment = false;
        void this.refreshPreparation();
      }));
    new Setting(container)
      .setName("仅粉丝可留言")
      .addToggle(toggle => toggle.setValue(this.onlyFansCanComment).setDisabled(!this.commentsEnabled).onChange(value => {
        this.onlyFansCanComment = this.commentsEnabled && value;
        void this.refreshPreparation();
      }));
  }

  private async verifyRelay(): Promise<void> {
    this.busy = true;
    this.render();
    try {
      this.relayClient = await createRelayClient(this.plugin);
      const result = await this.relayClient.verify();
      this.accountName = result.accountName;
      this.accountId = result.accountId;
    } catch (error) {
      this.relayClient = null;
      new Notice(errorMessage(error));
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async quoteCloud(): Promise<void> {
    if (!this.prepared?.snapshot) return;
    this.busy = true;
    this.syncProgress = "正在读取测试账户与报价…";
    this.render();
    try {
      this.cloudClient = await createCloudClient(this.plugin);
      await this.cloudClient.health();
      const profile = await this.cloudClient.profile();
      this.accountName = this.plugin.agentSettings.cloudAccountName;
      this.accountId = this.plugin.agentSettings.cloudAccountId;
      const snapshot = this.effectiveSnapshot();
      this.cloudQuote = await this.cloudClient.createQuote(
        this.plugin.agentSettings.cloudConnectionId,
        snapshot.metadata.draftId ? "update" : "create",
        snapshot.contentHash,
        snapshot.contentAssets.length,
      );
      if (this.cloudQuote.balance !== profile.credits) {
        throw new Error("体验积分余额在报价期间发生变化，请重新读取。");
      }
    } catch (error) {
      this.accountName = "";
      this.accountId = "";
      this.cloudClient = null;
      this.cloudQuote = null;
      new Notice(errorMessage(error));
    } finally {
      this.busy = false;
      this.syncProgress = "";
      this.render();
    }
  }

  private sameDraftTarget(): boolean {
    const metadata = this.prepared?.metadata;
    if (!metadata?.draftId) return true;
    const route = this.plugin.agentSettings.syncRoute;
    if (route === "self-hosted" && !metadata.previousSyncRoute) return true;
    const currentAccountId = route === "self-hosted" ? this.accountId : this.plugin.agentSettings.cloudAccountId;
    return metadata.previousSyncRoute === route
      && Boolean(metadata.previousAccountId)
      && metadata.previousAccountId === currentAccountId;
  }

  private effectiveSnapshot(): SyncSnapshot {
    const snapshot = this.prepared?.snapshot;
    if (!snapshot) throw new Error("本地同步快照不存在。");
    const draftId = this.sameDraftTarget() ? resolveDraftIdForTitle(snapshot.metadata) : "";
    if (draftId === snapshot.metadata.draftId) return snapshot;
    return {
      ...snapshot,
      metadata: { ...snapshot.metadata, draftId, previousContentHash: "" },
    };
  }

  private async writeSuccessState(state: SyncSuccessState): Promise<void> {
    await this.plugin.app.fileManager.processFrontMatter(this.prepared!.file, frontmatter => {
      frontmatter["write-wechat-draft-id"] = state.draftId;
      frontmatter["write-wechat-synced-title"] = state.title;
      frontmatter["write-wechat-content-hash"] = state.contentHash;
      frontmatter["write-wechat-synced-at"] = state.syncedAt;
      frontmatter["write-wechat-theme"] = state.themeId;
      frontmatter["write-wechat-sync-route"] = this.plugin.agentSettings.syncRoute;
      frontmatter["write-wechat-account-id"] = this.accountId;
      if (state.coverPath) frontmatter["write-wechat-cover"] = state.coverPath;
      else delete frontmatter["write-wechat-cover"];
    });
  }

  private renderConfirmation(container: HTMLElement): void {
    if (!this.prepared?.snapshot) return;
    const themeLabel = this.prepared.rendererLabel;
    const snapshot = this.effectiveSnapshot();
    const cloud = this.plugin.agentSettings.syncRoute === "write-cloud";
    const summary = buildConfirmationSummary({
      title: this.prepared.metadata.title,
      accountName: this.accountName,
      coverPath: this.prepared.coverLabel,
      imageCount: this.prepared.contentAssets.length,
      themeLabel,
      draftId: snapshot.metadata.draftId,
      issues: this.prepared.issues,
      route: cloud ? "Write Cloud（体验）" : "用户自建 Relay",
      credits: cloud ? this.cloudQuote?.credits ?? 0 : 0,
    });
    const panel = container.createDiv({ cls: "oa-sync-confirm" });
    panel.createEl("h3", { text: "最后确认" });
    const lines = [
      `文章：${summary.article}`,
      `目标：${summary.target}`,
      `动作：${summary.action}`,
      `封面：${summary.cover}`,
      `正文图片：${summary.imageCount} 张`,
      `排版：${summary.theme}`,
      `路径：${summary.route}`,
      `WriteX 积分：${summary.credits}`,
      "不会执行：发布、群发、删除旧草稿",
    ];
    if (cloud && this.cloudQuote) {
      lines.splice(lines.length - 1, 0,
        `体验积分余额：${this.cloudQuote.balance} → ${this.cloudQuote.balance - this.cloudQuote.credits}`,
        "计费规则：先预留；草稿成功才扣除，明确失败会释放",
      );
    }
    if (this.prepared.metadata.draftId && !snapshot.metadata.draftId) {
      lines.splice(3, 0, this.prepared.metadata.previousTitle
        && this.prepared.metadata.previousTitle !== this.prepared.metadata.title
        ? "标题已修改：本次将创建新草稿，原草稿不会删除"
        : "安全处理：旧草稿不属于当前路线或账号，本次将创建新草稿");
    }
    for (const line of lines) panel.createEl("div", { text: line });
    const confirm = panel.createEl("button", {
      cls: "mod-cta",
      text: summary.action === "创建微信公众号草稿" ? "确认创建到草稿箱" : "确认更新草稿箱",
      attr: { type: "button" },
    });
    confirm.disabled = !summary.canConfirm || this.busy;
    confirm.onclick = () => void this.confirmSync();
  }

  private async confirmSync(): Promise<void> {
    if (!this.prepared?.snapshot) return;
    const cloud = this.plugin.agentSettings.syncRoute === "write-cloud";
    if (cloud ? !this.cloudClient || !this.cloudQuote : !this.relayClient) return;
    const current = await this.plugin.app.vault.cachedRead(this.prepared.file);
    if (current !== this.prepared.originalMarkdown) {
      new Notice("正文在确认期间发生了变化，请重新点击同步。");
      await this.refreshPreparation();
      return;
    }
    this.busy = true;
    this.syncProgress = "正在准备上传…";
    this.render();
    try {
      const snapshot = this.effectiveSnapshot();
      const syncClient = cloud ? this.cloudClient! : this.relayClient!;
      if (cloud) {
        this.syncProgress = "正在预留体验积分…";
        this.render();
        await this.cloudClient!.beginJob(
          this.cloudQuote!.id,
          `job-${this.cloudQuote!.id}`,
          snapshot.contentHash,
        );
      }
      const result = await runSync(
        snapshot,
        syncClient,
        state => this.writeSuccessState(state),
        undefined,
        progress => {
          this.syncProgress = progress.stage === "uploading-content"
            ? `正在上传正文图片 ${progress.completed}/${progress.total}${progress.source ? ` · ${progress.source}` : ""}`
            : progress.stage === "uploading-cover"
              ? `正在上传封面 ${progress.completed}/${progress.total}`
              : "正在创建或更新微信草稿…";
          this.render();
        },
      );
      if (result.status === "unchanged") new Notice("这篇草稿已经是最新版本，没有发起网络请求。");
      else if (cloud) {
        const receipt = this.cloudClient!.receipt;
        new Notice(`${result.operation === "created" ? "草稿已创建" : "草稿已更新"} · 体验积分 ${receipt?.credits ?? 0} · 余额 ${receipt?.balance ?? "—"}`);
      } else {
        new Notice(`${result.operation === "created" ? "草稿已创建" : "草稿已更新"} · ${result.imageCount} 张正文图片 · WriteX 积分 0`);
      }
      this.close();
    } catch (error) {
      if (cloud && this.cloudClient?.receipt) {
        const receipt = this.cloudClient.receipt;
        try {
          const snapshot = this.effectiveSnapshot();
          await this.writeSuccessState({
            draftId: receipt.draftId,
            title: snapshot.metadata.title,
            contentHash: snapshot.contentHash,
            syncedAt: receipt.completedAt,
            themeId: snapshot.themeId,
            coverPath: snapshot.cover.placeholder ? "" : snapshot.metadata.coverPath || snapshot.cover.source,
          });
          new Notice(`微信草稿已成功；本地状态已恢复 · 体验积分 ${receipt.credits} · 余额 ${receipt.balance}`);
          this.close();
          return;
        } catch {
          new Notice(`微信草稿已成功并扣除 ${receipt.credits} 体验积分，但本地状态写入失败。草稿 ID：${receipt.draftId}`);
        }
      }
      if (cloud && this.cloudClient && !this.cloudClient.receipt) {
        try {
          await this.cloudClient.cancelJob();
        } catch {
          // An unknown WeChat outcome intentionally refuses cancellation and remains reserved for review.
        }
      }
      new Notice(errorMessage(error));
      if (cloud) {
        this.accountName = "";
        this.accountId = "";
        this.cloudClient = null;
        this.cloudQuote = null;
      }
      this.busy = false;
      this.syncProgress = "";
      this.render();
    }
  }
}

export function openWeChatSync(
  plugin: ObsidianAgentPlugin,
  notePath: string,
  themeId: string,
): void {
  new WeChatSyncModal(plugin, notePath, themeId).open();
}
