import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

export const PLACEHOLDER_COVER_WIDTH = 900;
export const PLACEHOLDER_COVER_HEIGHT = 383;
export const PLACEHOLDER_COVER_SOURCE = "write://placeholder-cover/white-900x383.png";

export interface PlaceholderCover {
  source: typeof PLACEHOLDER_COVER_SOURCE;
  fileName: "white-900x383.png";
  mimeType: "image/png";
  bytes: ArrayBuffer;
  sha256: string;
  pixelProof: {
    width: typeof PLACEHOLDER_COVER_WIDTH;
    height: typeof PLACEHOLDER_COVER_HEIGHT;
    rgb: Uint8Array;
  };
}

let cached: PlaceholderCover | undefined;

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data = Buffer.alloc(0)): Buffer {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function buildWhitePng(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(PLACEHOLDER_COVER_WIDTH, 0);
  header.writeUInt32BE(PLACEHOLDER_COVER_HEIGHT, 4);
  header[8] = 8;
  header[9] = 2; // RGB, intentionally no alpha channel.
  const rowBytes = 1 + PLACEHOLDER_COVER_WIDTH * 3;
  const pixels = Buffer.alloc(rowBytes * PLACEHOLDER_COVER_HEIGHT, 0xff);
  for (let row = 0; row < PLACEHOLDER_COVER_HEIGHT; row += 1) pixels[row * rowBytes] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels, { level: 9 })),
    chunk("IEND"),
  ]);
}

export function getPlaceholderCover(): PlaceholderCover {
  if (cached) return cached;
  const png = buildWhitePng();
  const bytes = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
  cached = {
    source: PLACEHOLDER_COVER_SOURCE,
    fileName: "white-900x383.png",
    mimeType: "image/png",
    bytes,
    sha256: createHash("sha256").update(png).digest("hex"),
    pixelProof: {
      width: PLACEHOLDER_COVER_WIDTH,
      height: PLACEHOLDER_COVER_HEIGHT,
      rgb: Uint8Array.of(255, 255, 255),
    },
  };
  return cached;
}
