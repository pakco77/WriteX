import { Buffer } from "node:buffer";
import type { ImageInspection } from "./images.ts";

const JPEG_QUALITY_STEPS = [88, 78, 68] as const;

interface NativeImageValue {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: { width?: number; height?: number; quality?: "good" | "better" | "best" }): NativeImageValue;
  toJPEG(quality: number): Buffer;
  toPNG(): Buffer;
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

function arrayBuffer(value: Buffer): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function nativeImageFrom(bytes: ArrayBuffer): NativeImageValue {
  const electron = require("electron") as {
    nativeImage: { createFromBuffer(value: Buffer): NativeImageValue };
  };
  const image = electron.nativeImage.createFromBuffer(Buffer.from(bytes));
  if (image.isEmpty()) throw new Error("桌面图片解码器无法处理该格式。");
  return image;
}

function convertNative(bytes: ArrayBuffer, targetMime: "image/jpeg" | "image/png", maxBytes: number): ArrayBuffer {
  const image = nativeImageFrom(bytes);
  const { width, height } = image.getSize();
  for (const longest of [Math.max(width, height), 1920, 1440, 1200, 960, 720, 540]) {
    const bounded = Math.min(longest, Math.max(width, height));
    const resized = bounded < Math.max(width, height)
      ? image.resize(width >= height ? { width: bounded, quality: "better" } : { height: bounded, quality: "better" })
      : image;
    if (targetMime === "image/png") {
      const output = resized.toPNG();
      if (output.byteLength < maxBytes) return arrayBuffer(output);
      continue;
    }
    for (const quality of JPEG_QUALITY_STEPS) {
      const output = resized.toJPEG(quality);
      if (output.byteLength < maxBytes) return arrayBuffer(output);
    }
  }
  throw new Error(`图片转换后仍超过 ${Math.round(maxBytes / 1024 / 1024)} MB。`);
}

async function convertCanvas(
  bytes: ArrayBuffer,
  sourceMime: string,
  targetMime: "image/jpeg" | "image/png",
  maxBytes: number,
): Promise<ArrayBuffer> {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: sourceMime }), { imageOrientation: "from-image" });
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    for (const bound of [longest, 1920, 1440, 1200, 960, 720, 540]) {
      const scale = Math.min(1, bound / longest);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("当前环境无法创建图片转换画布。");
      if (targetMime === "image/jpeg") {
        context.fillStyle = "#FFFFFF";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of targetMime === "image/jpeg" ? JPEG_QUALITY_STEPS : [100] as const) {
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, targetMime, quality / 100));
        if (blob && blob.size < maxBytes) return blob.arrayBuffer();
      }
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }
  } finally {
    bitmap.close();
  }
  throw new Error(`图片转换后仍超过 ${Math.round(maxBytes / 1024 / 1024)} MB。`);
}

export async function convertForWeChat(
  bytes: ArrayBuffer,
  inspection: ImageInspection,
  targetMime: "image/jpeg" | "image/png",
  maxBytes: number,
): Promise<ArrayBuffer> {
  const canvasFirst = inspection.mimeType === "image/gif" || inspection.mimeType === "image/avif";
  const attempts = canvasFirst
    ? [() => convertCanvas(bytes, inspection.mimeType!, targetMime, maxBytes), () => Promise.resolve(convertNative(bytes, targetMime, maxBytes))]
    : [() => Promise.resolve(convertNative(bytes, targetMime, maxBytes)), () => convertCanvas(bytes, inspection.mimeType!, targetMime, maxBytes)];
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`WriteX 无法把 ${inspection.mimeType} 转换为微信图片：${message(lastError)}`);
}
