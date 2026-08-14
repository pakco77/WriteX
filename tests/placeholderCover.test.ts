import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import test from "node:test";
import { getPlaceholderCover } from "../src/placeholderCover.ts";

function pngChunks(bytes: Uint8Array): Map<string, Uint8Array[]> {
  const chunks = new Map<string, Uint8Array[]>();
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    const data = bytes.slice(offset + 8, offset + 8 + length);
    chunks.set(type, [...(chunks.get(type) ?? []), data]);
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return chunks;
}

test("placeholder PNG pixels are all #FFFFFF and use RGB without alpha", () => {
  const cover = getPlaceholderCover();
  const bytes = new Uint8Array(cover.bytes);
  const chunks = pngChunks(bytes);
  const ihdr = chunks.get("IHDR")?.[0];
  assert.ok(ihdr);
  const view = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);
  assert.equal(view.getUint32(0), 900);
  assert.equal(view.getUint32(4), 383);
  assert.equal(ihdr[9], 2, "PNG color type 2 is opaque RGB");
  const raw = inflateSync(Buffer.concat((chunks.get("IDAT") ?? []).map(value => Buffer.from(value))));
  assert.equal(raw.length, 383 * (1 + 900 * 3));
  for (let row = 0; row < 383; row += 1) {
    const start = row * (1 + 900 * 3);
    assert.equal(raw[start], 0, "each scanline uses filter 0");
    assert.equal(raw.subarray(start + 1, start + 1 + 900 * 3).every(value => value === 255), true);
  }
});
