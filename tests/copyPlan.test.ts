import assert from "node:assert/strict";
import test from "node:test";
import { buildCopyPlan, COPY_HTML_BUDGET_BYTES, type CopyPlanImageInput } from "../src/copyPlan.ts";
import type { ImageInspection } from "../src/images.ts";

function image(
  source: string,
  byteLength: number,
  overrides: Partial<ImageInspection> = {},
): CopyPlanImageInput {
  return {
    source,
    sha256: source.padEnd(64, "a").slice(0, 64).replace(/[^a-f0-9]/g, "a"),
    inspection: {
      mimeType: "image/png",
      byteLength,
      complete: true,
      width: 900,
      height: 600,
      animated: false,
      extensionMismatch: false,
      mimeMismatch: false,
      issues: [],
      ...overrides,
    },
  };
}

test("CopyPlan estimates Base64 before encoding and blocks a 92 MB clipboard payload", () => {
  const images = [
    ...Array.from({ length: 8 }, (_, index) => image(`static-${index}.png`, 160_000)),
    image("tuck video_2x.gif", 11_833_825, {
      mimeType: "image/gif",
      width: 960,
      height: 540,
      animated: true,
      frameCount: 220,
      frameRate: 15,
      durationSeconds: 14.67,
    }),
    image("reframed.gif", 56_228_212, {
      mimeType: "image/gif",
      width: 5120,
      height: 2820,
      animated: true,
      frameCount: 631,
      frameRate: 50,
      durationSeconds: 12.62,
    }),
  ];
  const plan = buildCopyPlan({ articleCharacters: 3200, layoutLabel: "小黑", baseHtmlBytes: 84_000, images });
  assert.equal(plan.imageCount, 10);
  assert.equal(plan.originalImageBytes, images.reduce((sum, item) => sum + item.inspection.byteLength, 0));
  assert.ok(plan.estimatedClipboardHtmlBytes > 90_000_000);
  assert.ok(plan.estimatedClipboardHtmlBytes > COPY_HTML_BUDGET_BYTES);
  assert.equal(plan.canDirectCopy, false);
  assert.equal(plan.requiresRelay, false);
  assert.match(plan.relayRecommendation, /动态 GIF/);
  assert.equal(plan.images.at(-1)?.path, "optimize-gif");
  assert.equal(plan.images.at(-1)?.frameCount, 631);
  assert.equal(plan.images.at(-1)?.frameRate, 50);
  assert.equal(plan.issues.some(issue => issue.code === "clipboard_budget_exceeded" && issue.level === "block"), true);
});

test("small static images remain directly copyable under the explicit budget", () => {
  const plan = buildCopyPlan({
    articleCharacters: 800,
    layoutLabel: "gzh-design · 摸鱼绿",
    baseHtmlBytes: 20_000,
    images: [image("a.png", 80_000), image("b.jpg", 120_000, { mimeType: "image/jpeg", hasAlpha: false })],
  });
  assert.equal(plan.canDirectCopy, true);
  assert.equal(plan.requiresRelay, false);
  assert.equal(plan.relayRecommendation, "不需要");
  assert.deepEqual(plan.images.map(item => item.path), ["inline", "inline"]);
  assert.equal(plan.estimatedBase64Bytes, 4 * Math.ceil(80_000 / 3) + 4 * Math.ceil(120_000 / 3));
});

test("damaged images are blocked and static oversized images get optimization and Relay paths", () => {
  const damaged = image("broken.png", 100, { complete: false });
  const large = image("photo.webp", 4 * 1024 * 1024, { mimeType: "image/webp", width: 3000, height: 2000 });
  const plan = buildCopyPlan({ articleCharacters: 100, layoutLabel: "小黑", baseHtmlBytes: 1000, images: [damaged, large] });
  assert.equal(plan.images[0]?.path, "blocked");
  assert.equal(plan.images[1]?.path, "optimize-static");
  assert.equal(plan.images[1]?.relayEligible, true);
  assert.equal(plan.canDirectCopy, false);
});
