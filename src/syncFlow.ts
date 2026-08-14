import {
  ASSET_PLACEHOLDER_PREFIX,
  assetIdempotencyKey,
  assetPlaceholder,
  characterCount,
  resolveDraftIdForTitle,
  utf8Bytes,
  type DraftMetadata,
} from "./wechatSync.ts";
import type {
  AssetResult,
  AssetUploadInput,
  DraftPayload,
  DraftResult,
} from "./writeRelay.ts";
import type { ImageInspection } from "./images.ts";

export interface SyncAsset {
  role: "content" | "cover";
  source: string;
  fileName: string;
  mimeType: string;
  bytes: ArrayBuffer;
  sha256: string;
  converted: boolean;
  originalSha256?: string;
  originalMimeType?: string;
  inspection?: ImageInspection;
  pendingConversion?: boolean;
  animationLoss?: boolean;
  placeholder?: boolean;
}

export interface SyncSnapshot {
  notePath: string;
  metadata: DraftMetadata;
  markdown: string;
  html: string;
  themeId: string;
  contentHash: string;
  contentAssets: SyncAsset[];
  cover: SyncAsset;
}

export interface SyncProgress {
  stage: "uploading-content" | "uploading-cover" | "writing-draft";
  completed: number;
  total: number;
  source?: string;
}

export interface SyncRelay {
  uploadAsset(input: AssetUploadInput): Promise<AssetResult>;
  createDraft(payload: DraftPayload, idempotencyKey: string): Promise<DraftResult>;
  updateDraft(draftId: string, payload: DraftPayload, idempotencyKey: string): Promise<DraftResult>;
}

export interface SyncSuccessState {
  draftId: string;
  title: string;
  contentHash: string;
  syncedAt: string;
  themeId: string;
  coverPath: string;
}

export type SyncResult =
  | { status: "unchanged"; draftId: string }
  | { status: "synced"; draftId: string; operation: "created" | "updated"; imageCount: number };

export type SuccessWriter = (value: SyncSuccessState) => void | Promise<void>;

export function assertWeChatContentLimits(html: string): void {
  if (characterCount(html) >= 20000 || utf8Bytes(html) >= 1024 * 1024) {
    throw new Error("渲染后的正文必须少于 2 万字符且小于 1 MB。");
  }
}

function ensurePlaceholderCoverage(snapshot: SyncSnapshot): void {
  if (!snapshot.html.includes(ASSET_PLACEHOLDER_PREFIX)) return;
  const expected = new Set(snapshot.contentAssets.map(asset => assetPlaceholder(asset.sha256)));
  const found = snapshot.html.match(/https:\/\/write\.invalid\/assets\/[a-f0-9]{64}/gi) ?? [];
  if (!found.length || found.some(value => !expected.has(value.toLowerCase()))) {
    throw new Error("正文仍包含无法解析的图片占位符。");
  }
}

function assetInput(asset: SyncAsset): AssetUploadInput {
  return {
    kind: asset.role,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    sha256: asset.sha256,
    idempotencyKey: assetIdempotencyKey(asset.role, asset.sha256),
    bytes: asset.bytes,
  };
}

export async function runSync(
  snapshot: SyncSnapshot,
  relay: SyncRelay,
  writeSuccess: SuccessWriter,
  now: () => Date = () => new Date(),
  onProgress: (progress: SyncProgress) => void = () => undefined,
): Promise<SyncResult> {
  const draftId = resolveDraftIdForTitle(snapshot.metadata);
  if (draftId && snapshot.contentHash === snapshot.metadata.previousContentHash) {
    return { status: "unchanged", draftId };
  }

  assertWeChatContentLimits(snapshot.html);
  ensurePlaceholderCoverage(snapshot);

  let finalHtml = snapshot.html;
  // ponytail: v0.2 uploads serially so an error names one asset; add bounded concurrency only after measured need.
  for (let index = 0; index < snapshot.contentAssets.length; index += 1) {
    const asset = snapshot.contentAssets[index];
    onProgress({ stage: "uploading-content", completed: index, total: snapshot.contentAssets.length, source: asset.source });
    let result: AssetResult;
    try {
      result = await relay.uploadAsset(assetInput(asset));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`上传正文图片失败：${asset.source} · ${detail}`, { cause: error });
    }
    if (!result.url) throw new Error(`Relay 没有返回正文图片 URL：${asset.source}`);
    finalHtml = finalHtml.replaceAll(assetPlaceholder(asset.sha256), result.url);
    onProgress({ stage: "uploading-content", completed: index + 1, total: snapshot.contentAssets.length, source: asset.source });
  }
  if (finalHtml.includes(ASSET_PLACEHOLDER_PREFIX)) throw new Error("正文仍包含未替换的图片占位符。");
  assertWeChatContentLimits(finalHtml);

  onProgress({ stage: "uploading-cover", completed: 0, total: 1, source: snapshot.cover.source });
  let cover: AssetResult;
  try {
    cover = await relay.uploadAsset(assetInput(snapshot.cover));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`上传封面失败：${snapshot.cover.source} · ${detail}`, { cause: error });
  }
  if (!cover.mediaId) throw new Error("Relay 没有返回封面素材 ID。");
  onProgress({ stage: "uploading-cover", completed: 1, total: 1, source: snapshot.cover.source });
  const payload: DraftPayload = {
    title: snapshot.metadata.title,
    author: snapshot.metadata.author,
    digest: snapshot.metadata.digest,
    content: finalHtml,
    contentHash: snapshot.contentHash,
    coverMediaId: cover.mediaId,
    commentsEnabled: snapshot.metadata.commentsEnabled,
    onlyFansCanComment: snapshot.metadata.commentsEnabled && snapshot.metadata.onlyFansCanComment,
  };
  const key = `draft-${snapshot.contentHash}`;
  onProgress({ stage: "writing-draft", completed: 0, total: 1 });
  const draft = draftId
    ? await relay.updateDraft(draftId, payload, key)
    : await relay.createDraft(payload, key);

  await writeSuccess({
    draftId: draft.draftId,
    title: snapshot.metadata.title,
    contentHash: snapshot.contentHash,
    syncedAt: now().toISOString(),
    themeId: snapshot.themeId,
    coverPath: snapshot.cover.placeholder ? "" : snapshot.metadata.coverPath || snapshot.cover.source,
  });
  onProgress({ stage: "writing-draft", completed: 1, total: 1 });
  return {
    status: "synced",
    draftId: draft.draftId,
    operation: draft.operation,
    imageCount: snapshot.contentAssets.length,
  };
}
