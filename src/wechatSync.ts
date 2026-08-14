import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "");
}

export interface DraftMetadata {
  title: string;
  author: string;
  digest: string;
  commentsEnabled: boolean;
  onlyFansCanComment: boolean;
  draftId: string;
  previousContentHash: string;
  coverPath: string;
  previousTitle?: string;
  previousSyncRoute?: "self-hosted" | "write-cloud";
  previousAccountId?: string;
}

export interface DraftMetadataInput {
  frontmatter: Record<string, unknown>;
  markdown: string;
  fileName: string;
  defaultAuthor: string;
}

export interface PreflightIssue {
  level: "block" | "warn" | "handled";
  code: string;
  message: string;
  assetPath?: string;
}

export interface PreflightAsset {
  role: "content" | "cover";
  source: string;
  mimeType: string;
  byteLength: number;
  converted: boolean;
  originalMimeType?: string;
  pendingConversion?: boolean;
  animated?: boolean;
  frameCount?: number;
  width?: number;
  height?: number;
  animationLoss?: boolean;
  placeholder?: boolean;
}

export interface PreflightInput {
  metadata: DraftMetadata;
  markdown: string;
  html: string;
  contentAssets?: PreflightAsset[];
  cover?: PreflightAsset;
  unresolvedImages?: string[];
  remoteImages?: string[];
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function firstH1(markdown: string): string {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
}

export function resolveDraftMetadata(input: DraftMetadataInput): DraftMetadata {
  const fm = input.frontmatter;
  const route = text(fm["write-wechat-sync-route"]);
  const accountId = text(fm["write-wechat-account-id"]);
  const previousTitle = text(fm["write-wechat-synced-title"]);
  return {
    title: text(fm.title) || firstH1(input.markdown) || input.fileName.replace(/\.md$/i, "").trim(),
    author: text(fm.author) || input.defaultAuthor.trim(),
    digest: text(fm.digest) || text(fm.description),
    commentsEnabled: true,
    onlyFansCanComment: false,
    draftId: text(fm["write-wechat-draft-id"]),
    previousContentHash: text(fm["write-wechat-content-hash"]),
    coverPath: text(fm["write-wechat-cover"]),
    ...(previousTitle ? { previousTitle } : {}),
    ...(route === "self-hosted" || route === "write-cloud" ? { previousSyncRoute: route } : {}),
    ...(accountId ? { previousAccountId: accountId } : {}),
  };
}

export function resolveDraftIdForTitle(metadata: DraftMetadata): string {
  if (!metadata.draftId) return "";
  // ponytail: legacy notes have no recorded title; keep updating once so upgrades never fork an existing draft by surprise.
  return metadata.previousTitle && metadata.previousTitle !== metadata.title ? "" : metadata.draftId;
}

export function resolveCoverPath(selectedPath: string, frontmatterPath: string, forcePlaceholder = false): string {
  return forcePlaceholder ? "" : selectedPath.trim() || frontmatterPath.trim();
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter("zh", { granularity: "grapheme" });
export const characterCount = (value: string): number => [...GRAPHEME_SEGMENTER.segment(value)].length;
export const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");
export const MAX_TITLE_GRAPHEMES = 60;
export const MAX_CONTENT_IMAGE_BYTES = 1024 * 1024;
export const MAX_COVER_IMAGE_BYTES = 10 * 1024 * 1024;
export const ASSET_PLACEHOLDER_PREFIX = "https://write.invalid/assets/";

const DECODABLE_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
]);
const COVER_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/bmp"]);

export interface ContentImagePlanInput {
  source: string;
  mimeType: string;
  byteLength: number;
  animated?: boolean;
}

export interface ContentImagePlan {
  action: "direct" | "convert" | "blocked";
  targetMime: "image/jpeg" | "image/png";
  requiresConfirmation: boolean;
  animationLoss: boolean;
}

export function planContentImage(input: ContentImagePlanInput): ContentImagePlan {
  if (
    (input.mimeType === "image/jpeg" || input.mimeType === "image/png")
    && input.byteLength < MAX_CONTENT_IMAGE_BYTES
  ) {
    return {
      action: "direct",
      targetMime: input.mimeType,
      requiresConfirmation: false,
      animationLoss: false,
    };
  }
  const convertible = DECODABLE_IMAGE_MIMES.has(input.mimeType)
    || ["image/tiff", "image/heic", "image/avif"].includes(input.mimeType);
  const animationLoss = input.mimeType === "image/gif" && Boolean(input.animated);
  return {
    action: convertible ? "convert" : "blocked",
    targetMime: "image/jpeg",
    requiresConfirmation: animationLoss,
    animationLoss,
  };
}

export interface ContentHashInput {
  metadata: Pick<DraftMetadata, "title" | "author" | "digest" | "commentsEnabled" | "onlyFansCanComment">;
  markdown: string;
  themeId: string;
  rendererVersion: string;
  coverHash: string;
  contentAssetHashes: string[];
}

export function computeContentHash(input: ContentHashInput): string {
  const segments = [
    "write-wechat-v1",
    input.metadata.title,
    input.metadata.author,
    input.metadata.digest,
    String(input.metadata.commentsEnabled),
    String(input.metadata.onlyFansCanComment),
    input.themeId,
    input.rendererVersion,
    stripFrontmatter(input.markdown),
    input.coverHash,
    ...input.contentAssetHashes,
  ];
  const hash = createHash("sha256");
  for (const segment of segments) {
    hash.update(String(Buffer.byteLength(segment, "utf8")));
    hash.update(":");
    hash.update(segment);
    hash.update(";");
  }
  return hash.digest("hex");
}

export function assetPlaceholder(hash: string): string {
  return ASSET_PLACEHOLDER_PREFIX + hash;
}

export function assetIdempotencyKey(kind: "content" | "cover", hash: string): string {
  return `asset-${kind}-${hash}`;
}

export function uploadFileName(source: string, mimeType: string): string {
  const name = source.split("/").pop()?.replace(/\.[^.]+$/, "") || "image";
  const extension = mimeType === "image/jpeg" ? ".jpg"
    : mimeType === "image/png" ? ".png"
      : mimeType === "image/gif" ? ".gif"
        : mimeType === "image/bmp" ? ".bmp"
          : mimeType === "image/webp" ? ".webp"
            : ".img";
  return name + extension;
}

export interface ConfirmationSummaryInput {
  title: string;
  accountName: string;
  coverPath: string;
  imageCount: number;
  themeLabel: string;
  draftId: string;
  issues: PreflightIssue[];
  route?: "用户自建 Relay" | "Write Cloud（体验）";
  credits?: number;
}

export interface ConfirmationSummary {
  article: string;
  target: string;
  action: "创建微信公众号草稿" | "更新微信公众号草稿";
  cover: string;
  imageCount: number;
  theme: string;
  route: "用户自建 Relay" | "Write Cloud（体验）";
  credits: number;
  canConfirm: boolean;
}

export function buildConfirmationSummary(input: ConfirmationSummaryInput): ConfirmationSummary {
  return {
    article: input.title,
    target: input.accountName,
    action: input.draftId ? "更新微信公众号草稿" : "创建微信公众号草稿",
    cover: input.coverPath,
    imageCount: input.imageCount,
    theme: input.themeLabel,
    route: input.route ?? "用户自建 Relay",
    credits: input.credits ?? 0,
    canConfirm: !input.issues.some(issue => issue.level === "block"),
  };
}

function articleBody(markdown: string): string {
  return stripFrontmatter(markdown)
    .replace(/^#\s+.*$/m, "")
    .trim();
}

export function preflightDraft(input: PreflightInput): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const block = (code: string, message: string, assetPath?: string): void => {
    issues.push({ level: "block", code, message, assetPath });
  };
  const warn = (code: string, message: string, assetPath?: string): void => {
    issues.push({ level: "warn", code, message, assetPath });
  };
  const handled = (code: string, message: string, assetPath?: string): void => {
    issues.push({ level: "handled", code, message, assetPath });
  };

  if (!input.metadata.title) block("empty_title", "文章没有可用标题。");
  if (!articleBody(input.markdown)) block("empty_body", "文章正文为空。");
  const titleCharacters = characterCount(input.metadata.title);
  if (titleCharacters > MAX_TITLE_GRAPHEMES) block("title_too_long", `标题为 ${titleCharacters}/60，不能超过 60 个可见字符。`);
  else if (input.metadata.title) handled("title_valid", `标题：${titleCharacters}/60。`);
  if (characterCount(input.metadata.author) > 16) block("author_too_long", "作者不能超过 16 个字。");
  if (characterCount(input.metadata.digest) > 120) block("digest_too_long", "摘要不能超过 120 个字。");
  if (characterCount(input.html) >= 20000 || utf8Bytes(input.html) >= 1024 * 1024) {
    block("content_too_long", "渲染后的正文必须少于 2 万字符且小于 1 MB。");
  }
  if (!input.cover) warn("placeholder_cover_pending", "未选择封面，将使用 900×383 纯白占位封面。");
  for (const asset of input.contentAssets ?? []) {
    if (asset.originalMimeType === "image/gif") {
      handled("gif_recognized", `已识别 GIF${asset.animated ? " 动画" : ""}${asset.frameCount ? `（${asset.frameCount} 帧）` : ""}。`, asset.source);
    }
    if (asset.pendingConversion) {
      block(
        "animation_conversion_confirmation_required",
        "微信正文 API 不接受 GIF；如继续，将生成静态 JPG 替代图并丢失动画，必须先确认。",
        asset.source,
      );
      continue;
    }
    if (asset.mimeType !== "image/jpeg" && asset.mimeType !== "image/png") {
      block("content_image_type", "正文图片必须是 JPG 或 PNG。", asset.source);
    }
    if (asset.byteLength >= MAX_CONTENT_IMAGE_BYTES) {
      block("content_image_too_large", "正文图片必须小于 1 MB。", asset.source);
    }
    if (asset.converted) {
      warn("image_converted", asset.animationLoss
        ? "已按你的确认生成静态替代图；原 GIF 未被覆盖，动画不会进入 API 草稿。"
        : "图片已为适配微信而转换或压缩；原图未被覆盖。", asset.source);
      handled("image_conversion_ready", "转换结果已符合微信正文图片要求。", asset.source);
    }
  }
  if (input.cover) {
    if (!COVER_IMAGE_MIMES.has(input.cover.mimeType)) {
      block("cover_image_type", "封面不是微信永久图片素材支持的格式。", input.cover.source);
    }
    if (input.cover.byteLength > MAX_COVER_IMAGE_BYTES) {
      block("cover_image_too_large", "封面不能超过 10 MB。", input.cover.source);
    }
    if (input.cover.converted) warn("image_converted", "封面已为适配微信而转换；原图未被覆盖。", input.cover.source);
    if (input.cover.placeholder) {
      handled("placeholder_cover_used", "已使用纯白占位封面。", input.cover.source);
      warn("placeholder_cover", "当前使用纯白占位封面，正式发布前建议更换。", input.cover.source);
    }
  }
  for (const source of input.unresolvedImages ?? []) {
    block("unresolved_image", "无法在 Vault 中找到正文图片。", source);
  }
  for (const source of input.remoteImages ?? []) {
    block("remote_image", "远程图片不能直接同步，请先保存到 Vault。", source);
  }
  if (!input.metadata.author) warn("empty_author", "作者为空，将由公众号账号规则处理。");
  if (!input.metadata.digest) warn("empty_digest", "摘要为空，微信可能从正文自动提取。");
  return issues;
}
