import type { ImageAsset, ImageCapability, ImageProvider } from "./types";

export function chooseAutomaticImageProvider(capability: ImageCapability): ImageProvider | null {
  return capability === "available" ? "agent" : null;
}

export function resolveGeneratedProvider(
  asset: Pick<ImageAsset, "source" | "provider">,
): ImageProvider | null {
  if (asset.source !== "generated") return null;
  return asset.provider ?? "openai-api";
}

export function canUseWriteCloudV01(): false {
  return false;
}

export function imageProviderLabel(asset: Pick<ImageAsset, "source" | "provider">): string {
  if (asset.source === "manual") return "手动导入";
  if (asset.source === "original") return "原图";
  if (asset.source === "optimized") return "公众号优化版";
  return resolveGeneratedProvider(asset) === "agent" ? "AI · Agent" : "AI · 自带 API";
}
