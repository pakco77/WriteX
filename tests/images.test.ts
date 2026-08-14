import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  inspectImage,
  planWeChatImage,
} from "../src/images.ts";
import { getPlaceholderCover } from "../src/placeholderCover.ts";

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(
  bytes.byteOffset,
  bytes.byteOffset + bytes.byteLength,
) as ArrayBuffer;

const gif = (version: "87a" | "89a"): ArrayBuffer => toArrayBuffer(Uint8Array.from([
  0x47, 0x49, 0x46, ...version.slice(0, 3).split("").map(value => value.charCodeAt(0)),
  0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0x02, 0x02, 0x4c, 0x01, 0x00,
  0x3b,
]));

test("GIF87a and GIF89a are complete signature-checked bitmaps", () => {
  for (const version of ["87a", "89a"] as const) {
    const result = inspectImage(gif(version), { fileName: `ANIMATION.${version === "89a" ? "GIF" : "gif"}` });
    assert.equal(result.mimeType, "image/gif");
    assert.equal(result.complete, true);
    assert.equal(result.width, 1);
    assert.equal(result.height, 1);
    assert.equal(result.frameCount, 1);
    assert.equal(result.extensionMismatch, false);
  }
});

test("magic bytes win over extension and declared MIME, while conflicts stay visible", () => {
  const result = inspectImage(gif("89a"), {
    fileName: "misleading.png",
    declaredMime: "image/png",
  });
  assert.equal(result.mimeType, "image/gif");
  assert.equal(result.extensionMismatch, true);
  assert.equal(result.mimeMismatch, true);
});

test("truncated or signature-only GIF is blocked before any decoder runs", () => {
  const truncated = toArrayBuffer(new TextEncoder().encode("GIF89a"));
  const result = inspectImage(truncated, { fileName: "broken.gif" });
  assert.equal(result.mimeType, "image/gif");
  assert.equal(result.complete, false);
  assert.equal(planWeChatImage(result, "content").status, "blocked");
});

test("WeChat planning distinguishes direct, confirmed conversion, and animation loss", () => {
  const animation = { ...inspectImage(gif("89a"), { fileName: "animation.gif" }), animated: true, frameCount: 2 };
  const pending = planWeChatImage(animation, "content");
  assert.equal(pending.status, "convert");
  assert.equal(pending.requiresConfirmation, true);
  assert.equal(pending.animationLoss, true);

  const futureDirect = planWeChatImage(animation, "content", { contentGifAccepted: true });
  assert.equal(futureDirect.status, "direct");
  assert.equal(futureDirect.targetMime, "image/gif");
});

test("JPEG, PNG, WebP, BMP, TIFF, and AVIF are signature checked with dimensions", () => {
  const jpeg = Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x03, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
  const bmp = new Uint8Array(58);
  const bmpView = new DataView(bmp.buffer);
  bmp.set([0x42, 0x4d]);
  bmpView.setUint32(2, 58, true);
  bmpView.setUint32(10, 54, true);
  bmpView.setUint32(14, 40, true);
  bmpView.setInt32(18, 1, true);
  bmpView.setInt32(22, 1, true);
  bmpView.setUint16(26, 1, true);
  bmpView.setUint16(28, 24, true);
  const webp = Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 22, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0,
    0, 0, 0, 0, 2, 0, 0, 1, 0, 0,
  ]);
  const tiff = new Uint8Array(38);
  const tiffView = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49, 0x2a, 0x00]);
  tiffView.setUint32(4, 8, true);
  tiffView.setUint16(8, 2, true);
  for (const [offset, tag, value] of [[10, 256, 640], [22, 257, 480]] as const) {
    tiffView.setUint16(offset, tag, true);
    tiffView.setUint16(offset + 2, 4, true);
    tiffView.setUint32(offset + 4, 1, true);
    tiffView.setUint32(offset + 8, value, true);
  }
  const avif = new Uint8Array(44);
  const avifView = new DataView(avif.buffer);
  avifView.setUint32(0, 24);
  avif.set(new TextEncoder().encode("ftyp"), 4);
  avif.set(new TextEncoder().encode("avif"), 8);
  avif.set(new TextEncoder().encode("avif"), 16);
  avifView.setUint32(24, 20);
  avif.set(new TextEncoder().encode("ispe"), 28);
  avifView.setUint32(36, 1920);
  avifView.setUint32(40, 1080);

  for (const [name, bytes, mime, width, height] of [
    ["photo.jpg", jpeg, "image/jpeg", 3, 2],
    ["icon.bmp", bmp, "image/bmp", 1, 1],
    ["figure.webp", webp, "image/webp", 3, 2],
    ["scan.tiff", tiff, "image/tiff", 640, 480],
    ["photo.avif", avif, "image/avif", 1920, 1080],
  ] as const) {
    const result = inspectImage(toArrayBuffer(bytes), { fileName: name });
    assert.equal(result.mimeType, mime);
    assert.equal(result.complete, true);
    assert.equal(result.width, width);
    assert.equal(result.height, height);
  }
  assert.equal(planWeChatImage(inspectImage(toArrayBuffer(avif), { fileName: "photo.avif" }), "content").status, "convert");
  const placeholder = getPlaceholderCover();
  assert.equal(inspectImage(placeholder.bytes, { fileName: "cover.png" }).mimeType, "image/png");
});

test("JPEG EXIF Orientation is read before conversion", () => {
  const tiff = Uint8Array.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00,
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
  const exif = Uint8Array.from([...new TextEncoder().encode("Exif\0\0"), ...tiff]);
  const length = exif.length + 2;
  const jpeg = Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe1, length >> 8, length & 0xff, ...exif,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x03, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
  assert.equal(inspectImage(toArrayBuffer(jpeg), { fileName: "rotated.jpg" }).orientation, 6);
});

test("placeholder cover is one memoized 900x383 opaque white PNG", () => {
  const first = getPlaceholderCover();
  const second = getPlaceholderCover();
  assert.equal(first, second);
  assert.equal(first.source, "write://placeholder-cover/white-900x383.png");
  assert.equal(first.mimeType, "image/png");

  const inspection = inspectImage(first.bytes, { fileName: "white-900x383.png", declaredMime: first.mimeType });
  assert.equal(inspection.complete, true);
  assert.equal(inspection.width, 900);
  assert.equal(inspection.height, 383);
  assert.equal(inspection.hasAlpha, false);
  assert.equal(first.pixelProof.width, 900);
  assert.equal(first.pixelProof.height, 383);
  assert.equal(first.pixelProof.rgb.every(value => value === 255), true);
});

const REAL_GIFS = (process.env.WRITEX_REAL_GIF_FIXTURES ?? "").split("\n").filter(Boolean);
const REAL_GIF_EXPECTATIONS = [
  { frames: 220, fps: 15, duration: 14.67 },
  { frames: 631, fps: 50, duration: 12.62 },
];

test("two optional acceptance GIFs are recognized without static decoding", {
  skip: REAL_GIFS.length !== 2 || !REAL_GIFS.every(existsSync),
}, async () => {
  for (const [index, path] of REAL_GIFS.entries()) {
    const source = await readFile(path);
    const bytes = toArrayBuffer(source);
    const result = inspectImage(bytes, { fileName: path });
    assert.equal(result.mimeType, "image/gif");
    assert.equal(result.complete, true);
    assert.equal(result.animated, true);
    const expected = REAL_GIF_EXPECTATIONS[index];
    assert.equal(result.frameCount, expected.frames);
    assert.ok(Math.abs((result.frameRate ?? 0) - expected.fps) < 0.01);
    assert.equal(result.durationSeconds, expected.duration);
    assert.ok((result.width ?? 0) > 0);
    assert.ok((result.height ?? 0) > 0);
    assert.equal(planWeChatImage(result, "content").requiresConfirmation, true);
    const before = createHash("sha256").update(source).digest("hex");
    const after = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
    assert.equal(after, before);
  }
});
