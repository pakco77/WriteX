import type { ImageInspection } from "./images.ts";

export const COPY_INLINE_STATIC_MAX_BYTES = 1024 * 1024;
export const COPY_INLINE_GIF_MAX_BYTES = 5 * 1024 * 1024;
export const COPY_HTML_BUDGET_BYTES = 15 * 1024 * 1024;

export type CopyTaskState =
  | "idle"
  | "checking"
  | "optimizing"
  | "uploading"
  | "rendering"
  | "writing"
  | "done"
  | "failed"
  | "cancelled";

export type CopyImagePath = "inline" | "optimize-static" | "optimize-gif" | "relay" | "text-only" | "blocked";

export interface CopyPlanIssue {
  level: "block" | "warn" | "handled";
  code: string;
  message: string;
  source?: string;
}

export interface CopyPlanImageInput {
  source: string;
  sha256: string;
  inspection: ImageInspection;
}

export interface CopyPlanImage {
  source: string;
  sha256: string;
  mimeType: string;
  byteLength: number;
  width?: number;
  height?: number;
  animated: boolean;
  frameCount?: number;
  frameRate?: number;
  durationSeconds?: number;
  path: CopyImagePath;
  relayEligible: boolean;
  recommendation: string;
}

export interface CopyPlanInput {
  articleCharacters: number;
  layoutLabel: string;
  baseHtmlBytes: number;
  images: CopyPlanImageInput[];
}

export interface CopyPlan {
  articleCharacters: number;
  layoutLabel: string;
  imageCount: number;
  images: CopyPlanImage[];
  originalImageBytes: number;
  estimatedBase64Bytes: number;
  estimatedClipboardHtmlBytes: number;
  requiresRelay: boolean;
  relayRecommendation: string;
  performsRemoteUpload: false;
  writeCredits: 0;
  canDirectCopy: boolean;
  issues: CopyPlanIssue[];
}

const base64Bytes = (bytes: number): number => 4 * Math.ceil(bytes / 3);

function routeImage(input: CopyPlanImageInput): CopyPlanImage {
  const image = input.inspection;
  if (!image.mimeType || !image.complete) {
    return {
      source: input.source,
      sha256: input.sha256,
      mimeType: image.mimeType ?? "unknown",
      byteLength: image.byteLength,
      width: image.width,
      height: image.height,
      animated: image.animated,
      frameCount: image.frameCount,
      frameRate: image.frameRate,
      durationSeconds: image.durationSeconds,
      path: "blocked",
      relayEligible: false,
      recommendation: "文件损坏或格式无法识别，需先更换图片。",
    };
  }
  if (image.mimeType === "image/gif" && image.animated) {
    const inline = image.byteLength <= COPY_INLINE_GIF_MAX_BYTES;
    return {
      source: input.source,
      sha256: input.sha256,
      mimeType: image.mimeType,
      byteLength: image.byteLength,
      width: image.width,
      height: image.height,
      animated: true,
      frameCount: image.frameCount,
      frameRate: image.frameRate,
      durationSeconds: image.durationSeconds,
      path: inline ? "inline" : "optimize-gif",
      relayEligible: false,
      recommendation: inline
        ? "GIF 在单图预算内；仍需在公众号网页编辑器验证动画是否保留。"
        : "保留时长，建议降到 12–15 fps、缩小分辨率并优化色板，目标小于 8 MB。",
    };
  }
  const inline = image.byteLength <= COPY_INLINE_STATIC_MAX_BYTES
    && (image.mimeType === "image/jpeg" || image.mimeType === "image/png" || image.mimeType === "image/gif");
  return {
    source: input.source,
    sha256: input.sha256,
    mimeType: image.mimeType,
    byteLength: image.byteLength,
    width: image.width,
    height: image.height,
    animated: image.animated,
    frameCount: image.frameCount,
    frameRate: image.frameRate,
    durationSeconds: image.durationSeconds,
    path: inline ? "inline" : "optimize-static",
    relayEligible: true,
    recommendation: inline
      ? "在本地内嵌预算内。"
      : "先转换或压缩为微信接受的小于 1 MB 的 JPG/PNG；也可经自建 Relay 准备微信 URL。",
  };
}

export function buildCopyPlan(input: CopyPlanInput): CopyPlan {
  const images = input.images.map(routeImage);
  const originalImageBytes = images.reduce((sum, image) => sum + image.byteLength, 0);
  const estimatedBase64Bytes = images.reduce((sum, image) => sum + base64Bytes(image.byteLength), 0);
  const dataUrlOverhead = images.reduce((sum, image) => sum + `data:${image.mimeType};base64,`.length, 0);
  const estimatedClipboardHtmlBytes = input.baseHtmlBytes + estimatedBase64Bytes + dataUrlOverhead;
  const issues: CopyPlanIssue[] = [{
    level: "handled",
    code: "images_inspected",
    message: `已通过文件签名检查 ${images.length} 张图片。`,
  }];
  for (const image of images) {
    if (image.path === "blocked") {
      issues.push({ level: "block", code: "image_blocked", message: image.recommendation, source: image.source });
    } else if (image.path === "optimize-gif") {
      issues.push({
        level: "block",
        code: "gif_optimization_required",
        message: "动态 GIF 超过直接内嵌预算，必须先优化或改为只复制文字。",
        source: image.source,
      });
    } else if (image.path === "optimize-static") {
      issues.push({
        level: "warn",
        code: "static_optimization_recommended",
        message: "静态图片较大或格式不适合直接内嵌，建议优化或使用 Relay。",
        source: image.source,
      });
    }
  }
  if (estimatedClipboardHtmlBytes > COPY_HTML_BUDGET_BYTES) {
    issues.push({
      level: "block",
      code: "clipboard_budget_exceeded",
      message: `预计剪贴板 HTML 超过 ${Math.round(COPY_HTML_BUDGET_BYTES / 1024 / 1024)} MB 预算，已阻止直接复制。`,
    });
  }
  const canDirectCopy = images.every(image => image.path === "inline")
    && estimatedClipboardHtmlBytes <= COPY_HTML_BUDGET_BYTES
    && !issues.some(issue => issue.level === "block");
  const requiresRelay = !canDirectCopy && images.length > 0 && images.every(image => image.relayEligible);
  const relayRecommendation = canDirectCopy
    ? "不需要"
    : images.some(image => image.animated)
      ? "动态 GIF 不可走微信正文图片 API"
      : images.some(image => image.relayEligible)
        ? "可选；确认后才连接和上传"
        : "不可用";
  return {
    articleCharacters: input.articleCharacters,
    layoutLabel: input.layoutLabel,
    imageCount: images.length,
    images,
    originalImageBytes,
    estimatedBase64Bytes,
    estimatedClipboardHtmlBytes,
    requiresRelay,
    relayRecommendation,
    performsRemoteUpload: false,
    writeCredits: 0,
    canDirectCopy,
    issues,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
