export type ImageMime =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "image/bmp"
  | "image/tiff"
  | "image/heic"
  | "image/avif";

export type SupportedImageMime = ImageMime;

export interface ImageInspectionOptions {
  fileName?: string;
  declaredMime?: string;
}

export interface ImageInspection {
  mimeType: ImageMime | null;
  byteLength: number;
  complete: boolean;
  width?: number;
  height?: number;
  animated: boolean;
  frameCount?: number;
  frameRate?: number;
  durationSeconds?: number;
  orientation?: number;
  hasAlpha?: boolean;
  extensionMismatch: boolean;
  mimeMismatch: boolean;
  issues: string[];
}

export interface WeChatImagePlan {
  status: "direct" | "convert" | "blocked";
  targetMime: "image/jpeg" | "image/png" | "image/gif" | "image/bmp";
  requiresConfirmation: boolean;
  animationLoss: boolean;
  reason?: string;
}

const EXTENSION_MIME: Record<string, ImageMime> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heic",
  avif: "image/avif",
};

function ascii(data: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...data.subarray(start, start + length));
}

function declaredMime(value?: string): ImageMime | null {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg";
  if (normalized === "image/heif") return "image/heic";
  return normalized && Object.values(EXTENSION_MIME).includes(normalized as ImageMime)
    ? normalized as ImageMime
    : null;
}

function extensionMime(value?: string): ImageMime | null {
  const clean = value?.split(/[?#]/, 1)[0] ?? "";
  const extension = clean.match(/\.([^.\/]+)$/)?.[1]?.toLowerCase() ?? "";
  return EXTENSION_MIME[extension] ?? null;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parsePng(data: Uint8Array): Partial<ImageInspection> {
  let offset = 8;
  let width: number | undefined;
  let height: number | undefined;
  let hasAlpha = false;
  let complete = false;
  while (offset + 12 <= data.length) {
    const view = new DataView(data.buffer, data.byteOffset + offset, 8);
    const length = view.getUint32(0);
    const end = offset + 12 + length;
    if (end > data.length) return { complete: false, width, height, hasAlpha };
    const type = ascii(data, offset + 4, 4);
    const expectedCrc = new DataView(data.buffer, data.byteOffset + offset + 8 + length, 4).getUint32(0);
    if (crc32(data.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) {
      return { complete: false, width, height, hasAlpha };
    }
    if (type === "IHDR") {
      if (length !== 13) return { complete: false };
      const header = new DataView(data.buffer, data.byteOffset + offset + 8, length);
      width = header.getUint32(0);
      height = header.getUint32(4);
      const colorType = data[offset + 17];
      hasAlpha = colorType === 4 || colorType === 6;
    } else if (type === "tRNS") {
      hasAlpha = true;
    } else if (type === "IEND") {
      complete = length === 0 && end === data.length;
      break;
    }
    offset = end;
  }
  return { complete: complete && Boolean(width && height), width, height, hasAlpha, animated: false };
}

function skipGifSubBlocks(data: Uint8Array, start: number): number | null {
  let offset = start;
  while (offset < data.length) {
    const length = data[offset];
    offset += 1;
    if (length === 0) return offset;
    if (offset + length > data.length) return null;
    offset += length;
  }
  return null;
}

function parseGif(data: Uint8Array): Partial<ImageInspection> {
  if (data.length < 13) return { complete: false, animated: false, frameCount: 0 };
  const width = data[6] | (data[7] << 8);
  const height = data[8] | (data[9] << 8);
  const globalTableBytes = data[10] & 0x80 ? 3 * (1 << ((data[10] & 0x07) + 1)) : 0;
  let offset = 13 + globalTableBytes;
  let frameCount = 0;
  let durationHundredths = 0;
  let pendingDelay = 0;
  let complete = false;
  while (offset < data.length) {
    const introducer = data[offset];
    offset += 1;
    if (introducer === 0x3b) {
      complete = offset === data.length;
      break;
    }
    if (introducer === 0x21) {
      if (offset >= data.length) break;
      const label = data[offset];
      offset += 1;
      if (label === 0xf9) {
        if (offset + 6 > data.length || data[offset] !== 4 || data[offset + 5] !== 0) break;
        pendingDelay = data[offset + 2] | (data[offset + 3] << 8);
        offset += 6;
      } else {
        const next = skipGifSubBlocks(data, offset);
        if (next === null) break;
        offset = next;
      }
      continue;
    }
    if (introducer !== 0x2c || offset + 9 > data.length) break;
    const packed = data[offset + 8];
    offset += 9;
    if (packed & 0x80) offset += 3 * (1 << ((packed & 0x07) + 1));
    if (offset >= data.length) break;
    offset += 1; // LZW minimum code size
    const next = skipGifSubBlocks(data, offset);
    if (next === null) break;
    offset = next;
    frameCount += 1;
    durationHundredths += pendingDelay;
    pendingDelay = 0;
  }
  const durationSeconds = durationHundredths > 0 ? durationHundredths / 100 : undefined;
  return {
    complete: complete && width > 0 && height > 0 && frameCount > 0,
    width,
    height,
    animated: frameCount > 1,
    frameCount,
    durationSeconds,
    frameRate: durationSeconds ? frameCount / durationSeconds : undefined,
    hasAlpha: true,
  };
}

function tiffValue(
  data: Uint8Array,
  little: boolean,
  base: number,
  entryOffset: number,
  type: number,
  count: number,
): number | undefined {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const unit = type === 3 ? 2 : type === 4 ? 4 : 0;
  if (!unit || count < 1) return undefined;
  const inline = unit * count <= 4;
  const valueOffset = inline ? entryOffset + 8 : base + view.getUint32(entryOffset + 8, little);
  if (valueOffset < 0 || valueOffset + unit > data.length) return undefined;
  return type === 3 ? view.getUint16(valueOffset, little) : view.getUint32(valueOffset, little);
}

function parseTiff(data: Uint8Array, base = 0): Partial<ImageInspection> {
  if (base + 8 > data.length) return { complete: false };
  const order = ascii(data, base, 2);
  const little = order === "II";
  if (!little && order !== "MM") return { complete: false };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint16(base + 2, little) !== 42) return { complete: false };
  const ifd = base + view.getUint32(base + 4, little);
  if (ifd + 2 > data.length) return { complete: false };
  const count = view.getUint16(ifd, little);
  if (ifd + 2 + count * 12 + 4 > data.length) return { complete: false };
  let width: number | undefined;
  let height: number | undefined;
  let orientation: number | undefined;
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    const tag = view.getUint16(entry, little);
    const type = view.getUint16(entry + 2, little);
    const values = view.getUint32(entry + 4, little);
    const value = tiffValue(data, little, base, entry, type, values);
    if (tag === 256) width = value;
    if (tag === 257) height = value;
    if (tag === 274) orientation = value;
  }
  return { complete: true, width, height, orientation, animated: false };
}

function jpegOrientation(data: Uint8Array, start: number, length: number): number | undefined {
  if (length < 14 || ascii(data, start, 6) !== "Exif\u0000\u0000") return undefined;
  return parseTiff(data.subarray(start + 6, start + length)).orientation;
}

function parseJpeg(data: Uint8Array): Partial<ImageInspection> {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return { complete: false };
  let offset = 2;
  let width: number | undefined;
  let height: number | undefined;
  let orientation: number | undefined;
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (data[offset] === 0xff) offset += 1;
    const marker = data[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > data.length) break;
    const length = (data[offset] << 8) | data[offset + 1];
    if (length < 2 || offset + length > data.length) break;
    if (sof.has(marker) && length >= 7) {
      height = (data[offset + 3] << 8) | data[offset + 4];
      width = (data[offset + 5] << 8) | data[offset + 6];
    }
    if (marker === 0xe1) orientation = jpegOrientation(data, offset + 2, length - 2) ?? orientation;
    offset += length;
  }
  const complete = data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9;
  return { complete: complete && Boolean(width && height), width, height, orientation, animated: false, hasAlpha: false };
}

function parseBmp(data: Uint8Array): Partial<ImageInspection> {
  if (data.length < 26) return { complete: false };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const declared = view.getUint32(2, true);
  const pixelOffset = view.getUint32(10, true);
  const dib = view.getUint32(14, true);
  if (declared > data.length || pixelOffset > data.length || dib < 12 || 14 + dib > data.length) return { complete: false };
  const width = dib === 12 ? view.getUint16(18, true) : Math.abs(view.getInt32(18, true));
  const height = dib === 12 ? view.getUint16(20, true) : Math.abs(view.getInt32(22, true));
  const bits = dib === 12 ? view.getUint16(24, true) : view.getUint16(28, true);
  return {
    complete: width > 0 && height > 0 && (declared === 0 || declared === data.length),
    width,
    height,
    animated: false,
    hasAlpha: bits === 32,
  };
}

function parseWebp(data: Uint8Array): Partial<ImageInspection> {
  if (data.length < 20) return { complete: false };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const declared = view.getUint32(4, true) + 8;
  let offset = 12;
  let width: number | undefined;
  let height: number | undefined;
  let animated = false;
  let frameCount = 0;
  let hasAlpha = false;
  while (offset + 8 <= Math.min(declared, data.length)) {
    const type = ascii(data, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + length;
    if (end > data.length) return { complete: false, width, height, animated, frameCount, hasAlpha };
    if (type === "VP8X" && length >= 10) {
      animated = Boolean(data[start] & 0x02);
      hasAlpha = Boolean(data[start] & 0x10);
      width = 1 + data[start + 4] + (data[start + 5] << 8) + (data[start + 6] << 16);
      height = 1 + data[start + 7] + (data[start + 8] << 8) + (data[start + 9] << 16);
    } else if (type === "VP8 " && length >= 10 && data[start + 3] === 0x9d && data[start + 4] === 0x01 && data[start + 5] === 0x2a) {
      width = (data[start + 6] | (data[start + 7] << 8)) & 0x3fff;
      height = (data[start + 8] | (data[start + 9] << 8)) & 0x3fff;
    } else if (type === "VP8L" && length >= 5 && data[start] === 0x2f) {
      const packed = view.getUint32(start + 1, true);
      width = 1 + (packed & 0x3fff);
      height = 1 + ((packed >>> 14) & 0x3fff);
      hasAlpha = true;
    } else if (type === "ANMF") {
      frameCount += 1;
    }
    offset = end + (length & 1);
  }
  return {
    complete: declared === data.length && Boolean(width && height),
    width,
    height,
    animated,
    frameCount: animated ? frameCount : 1,
    hasAlpha,
  };
}

function parseIsoBitmap(data: Uint8Array): Partial<ImageInspection> {
  let offset = 0;
  let complete = data.length >= 16;
  while (offset + 8 <= data.length) {
    const size = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0);
    if (size < 8 || offset + size > data.length) {
      complete = false;
      break;
    }
    offset += size;
  }
  if (offset !== data.length) complete = false;
  const index = data.findIndex((_, position) => position + 16 <= data.length && ascii(data, position, 4) === "ispe");
  const view = index >= 0 ? new DataView(data.buffer, data.byteOffset + index + 8, 8) : null;
  return {
    complete,
    width: view?.getUint32(0),
    height: view?.getUint32(4),
    animated: false,
  };
}

function detectMime(data: Uint8Array): ImageMime | null {
  if (data.length >= 8 && ascii(data, 0, 8) === "\u0089PNG\r\n\u001a\n") return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 6 && (ascii(data, 0, 6) === "GIF87a" || ascii(data, 0, 6) === "GIF89a")) return "image/gif";
  if (data.length >= 12 && ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 4) === "WEBP") return "image/webp";
  if (data.length >= 2 && ascii(data, 0, 2) === "BM") return "image/bmp";
  if (data.length >= 4 && ["II*\u0000", "MM\u0000*"].includes(ascii(data, 0, 4))) return "image/tiff";
  if (data.length >= 12 && ascii(data, 4, 4) === "ftyp") {
    const brands = ascii(data, 8, Math.min(data.length - 8, 32));
    if (/avif|avis/.test(brands)) return "image/avif";
    if (/heic|heix|hevc|hevx|heim|heis|mif1|msf1/.test(brands)) return "image/heic";
  }
  return null;
}

export function detectImageMime(bytes: ArrayBuffer): ImageMime | null {
  return detectMime(new Uint8Array(bytes));
}

export function inspectImage(bytes: ArrayBuffer, options: ImageInspectionOptions = {}): ImageInspection {
  const data = new Uint8Array(bytes);
  const mimeType = detectMime(data);
  const parsed = mimeType === "image/png" ? parsePng(data)
    : mimeType === "image/jpeg" ? parseJpeg(data)
      : mimeType === "image/gif" ? parseGif(data)
        : mimeType === "image/webp" ? parseWebp(data)
          : mimeType === "image/bmp" ? parseBmp(data)
            : mimeType === "image/tiff" ? parseTiff(data)
              : mimeType === "image/heic" || mimeType === "image/avif" ? parseIsoBitmap(data)
                : { complete: false };
  const extension = extensionMime(options.fileName);
  const declared = declaredMime(options.declaredMime);
  const extensionMismatch = Boolean(extension && mimeType && extension !== mimeType);
  const mimeMismatch = Boolean(declared && mimeType && declared !== mimeType);
  const issues: string[] = [];
  if (!mimeType) issues.push("无法通过文件签名识别图片格式。");
  if (!parsed.complete) issues.push("图片文件不完整或结构损坏。");
  if (extensionMismatch) issues.push(`扩展名与真实格式不一致；以 ${mimeType} 为准。`);
  if (mimeMismatch) issues.push(`MIME 与真实格式不一致；以 ${mimeType} 为准。`);
  return {
    mimeType,
    byteLength: data.byteLength,
    complete: Boolean(parsed.complete),
    width: parsed.width,
    height: parsed.height,
    animated: Boolean(parsed.animated),
    frameCount: parsed.frameCount,
    frameRate: parsed.frameRate,
    durationSeconds: parsed.durationSeconds,
    orientation: parsed.orientation,
    hasAlpha: parsed.hasAlpha,
    extensionMismatch,
    mimeMismatch,
    issues,
  };
}

export function planWeChatImage(
  image: ImageInspection,
  role: "content" | "cover",
  options: { contentGifAccepted?: boolean } = {},
): WeChatImagePlan {
  const fallback: WeChatImagePlan = {
    status: "blocked",
    targetMime: "image/jpeg",
    requiresConfirmation: false,
    animationLoss: false,
    reason: "图片损坏或格式无法识别。",
  };
  if (!image.mimeType || !image.complete) return fallback;
  if (image.mimeType === "image/gif") {
    const withinLimit = image.byteLength < (role === "content" ? 1024 * 1024 : 10 * 1024 * 1024 + 1);
    if ((role === "cover" || options.contentGifAccepted) && withinLimit) {
      return { status: "direct", targetMime: "image/gif", requiresConfirmation: false, animationLoss: false };
    }
    return {
      status: "convert",
      targetMime: "image/jpeg",
      requiresConfirmation: image.animated,
      animationLoss: image.animated,
      reason: role === "content"
        ? "微信正文图片接口只接受小于 1 MB 的 JPG/PNG。"
        : "GIF 超过微信封面素材 10 MB 限制。",
    };
  }
  if (image.mimeType === "image/jpeg" || image.mimeType === "image/png") {
    const limit = role === "content" ? 1024 * 1024 : 10 * 1024 * 1024 + 1;
    if (image.byteLength < limit) {
      return { status: "direct", targetMime: image.mimeType, requiresConfirmation: false, animationLoss: false };
    }
    return {
      status: "convert",
      targetMime: image.hasAlpha ? "image/png" : "image/jpeg",
      requiresConfirmation: false,
      animationLoss: false,
      reason: `图片超过微信${role === "content" ? "正文 1 MB" : "封面 10 MB"}限制。`,
    };
  }
  if (["image/webp", "image/bmp", "image/tiff", "image/heic", "image/avif"].includes(image.mimeType)) {
    return {
      status: "convert",
      targetMime: image.hasAlpha ? "image/png" : "image/jpeg",
      requiresConfirmation: false,
      animationLoss: false,
      reason: "微信上传接口不直接接受该格式。",
    };
  }
  return fallback;
}
