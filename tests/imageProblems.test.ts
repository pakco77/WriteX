import assert from "node:assert/strict";
import test from "node:test";
import {
  describeImageProblem,
  galleryProblemClass,
  galleryProblemSummary,
  missingImageInspection,
} from "../src/imageProblems.ts";
import type { ImageInspection } from "../src/images.ts";

const completePng: ImageInspection = {
  mimeType: "image/png",
  byteLength: 100,
  complete: true,
  width: 1,
  height: 1,
  animated: false,
  extensionMismatch: false,
  mimeMismatch: false,
  issues: [],
};

test("image problem labels article position and only lets broken files be excluded", () => {
  const missing = describeImageProblem({
    source: "assets/missing.jpg",
    articleIndex: 3,
    total: 8,
    inspection: missingImageInspection("无法在 Vault 中找到正文图片。"),
  });
  const ready = describeImageProblem({ source: "ready.png", articleIndex: 1, total: 8, inspection: completePng });

  assert.equal(missing.status, "unrepairable");
  assert.equal(missing.articleLabel, "正文图 3 / 8");
  assert.equal(missing.canExcludeFromCopy, true);
  assert.match(missing.reason, /无法在 Vault/);
  assert.equal(ready.status, "ready");
  assert.equal(ready.canExcludeFromCopy, false);
});

test("complete non-WeChat static images are repairable rather than damaged", () => {
  const webp = describeImageProblem({
    source: "photo.webp",
    inspection: { ...completePng, mimeType: "image/webp" },
  });
  assert.equal(webp.status, "repairable");
  assert.equal(webp.canExcludeFromCopy, false);
  assert.match(webp.reason, /转换|优化/);
});

test("gallery helpers mark only unrepairable files and report a concise summary", () => {
  const damaged = describeImageProblem({
    source: "broken.png",
    inspection: { ...completePng, complete: false, issues: ["图片文件不完整或损坏。"] },
  });
  const ready = describeImageProblem({ source: "ready.png", inspection: completePng });
  assert.equal(galleryProblemClass(damaged), "is-image-problem");
  assert.equal(galleryProblemClass(ready), "");
  assert.equal(galleryProblemSummary([ready, damaged]), "已检查 2 张 · 1 张需处理");
});
