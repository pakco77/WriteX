import assert from "node:assert/strict";
import test from "node:test";
import {
  assetIdempotencyKey,
  assetPlaceholder,
  buildConfirmationSummary,
  characterCount,
  measureWeChatContent,
  visibleHtmlText,
  computeContentHash,
  planContentImage,
  preflightDraft,
  resolveDraftMetadata,
  resolveDraftIdForTitle,
  resolveCoverPath,
  utf8Bytes,
  uploadFileName,
  type DraftMetadata,
} from "../src/wechatSync.ts";

test("draft metadata uses deterministic frontmatter, H1, and filename fallbacks", () => {
  assert.deepEqual(resolveDraftMetadata({
    frontmatter: {
      title: " Frontmatter 标题 ",
      description: " 说明 ",
      "write-wechat-draft-id": "draft-123",
      "write-wechat-content-hash": "hash-123",
      "write-wechat-cover": "covers/main.png",
    },
    markdown: "# H1 标题\n\n正文",
    fileName: "文件名",
    defaultAuthor: " 默认作者 ",
  }), {
    title: "文件名",
    author: "默认作者",
    digest: "说明",
    commentsEnabled: true,
    onlyFansCanComment: false,
    draftId: "draft-123",
    previousContentHash: "hash-123",
    coverPath: "covers/main.png",
  });

  assert.equal(resolveDraftMetadata({
    frontmatter: {},
    markdown: "## 章节\n\n# 第一个 H1\n\n# 第二个 H1",
    fileName: "文件名",
    defaultAuthor: "",
  }).title, "文件名");

  assert.equal(resolveDraftMetadata({
    frontmatter: {},
    markdown: "只有正文",
    fileName: "文件名.md",
    defaultAuthor: "",
  }).title, "文件名");
});

test("content limits measure visible body separately and use Unicode code points for Relay parity", () => {
  const metrics = measureWeChatContent("<p>👨‍👩‍👧‍👦正文</p>", "👨‍👩‍👧‍👦正文");
  assert.equal(metrics.htmlCharacters, Array.from("<p>👨‍👩‍👧‍👦正文</p>").length);
  assert.equal(metrics.visibleBodyCharacters, characterCount("👨‍👩‍👧‍👦正文"));
  assert.equal(metrics.htmlBytes, utf8Bytes("<p>👨‍👩‍👧‍👦正文</p>"));
});

test("visible HTML text excludes URLs and image attributes while retaining rendered entities and code", () => {
  const visible = visibleHtmlText('<p><a href="https://example.test/a-very-long-url">短链接</a> &amp; <strong>粗体</strong></p><img src="image.png" alt="图片说明"><pre><code>&lt;x&gt;</code></pre>');
  assert.equal(visible, "短链接 & 粗体<x>");
  const metrics = measureWeChatContent('<p><a href="https://example.test/a-very-long-url">短链接</a></p><img src="image.png" alt="图片说明">');
  assert.equal(metrics.visibleBodyCharacters, characterCount("短链接"));
});

test("visible HTML parsing respects quoted greater-than attributes and common named entities", () => {
  assert.equal(visibleHtmlText('<p data-label="a > b">甲&mdash;乙</p><span title=\'c > d\'>丙</span>'), "甲—乙丙");
});

test("draft metadata prefers explicit author and digest fields", () => {
  const metadata = resolveDraftMetadata({
    frontmatter: { author: "作者", digest: "摘要", description: "不应使用" },
    markdown: "# 标题",
    fileName: "文件名",
    defaultAuthor: "默认作者",
  });
  assert.equal(metadata.author, "作者");
  assert.equal(metadata.digest, "摘要");
});

test("draft metadata preserves the route and account binding used for safe updates", () => {
  const metadata = resolveDraftMetadata({
    frontmatter: {
      "write-wechat-draft-id": "draft-1",
      "write-wechat-sync-route": "write-cloud",
      "write-wechat-account-id": "account-1",
      "write-wechat-synced-title": "标题",
    },
    markdown: "# 标题\n\n正文",
    fileName: "文件名",
    defaultAuthor: "",
  });
  assert.equal(metadata.previousSyncRoute, "write-cloud");
  assert.equal(metadata.previousAccountId, "account-1");
  assert.equal(metadata.previousTitle, "标题");
});

test("draft binding is reused for body edits and reset only after a recorded title change", () => {
  const base: DraftMetadata = {
    title: "原标题",
    author: "Write",
    digest: "摘要",
    commentsEnabled: false,
    onlyFansCanComment: false,
    draftId: "draft-1",
    previousContentHash: "old-hash",
    coverPath: "cover.png",
  };

  assert.equal(resolveDraftIdForTitle(base), "draft-1", "legacy notes must keep updating their existing draft");
  assert.equal(resolveDraftIdForTitle({ ...base, previousTitle: "原标题" }), "draft-1");
  assert.equal(resolveDraftIdForTitle({ ...base, title: "新标题", previousTitle: "原标题" }), "");
});

test("explicit cover choices win and the placeholder never overwrites a user cover", () => {
  assert.equal(resolveCoverPath("gallery/cover.png", "frontmatter/cover.jpg"), "gallery/cover.png");
  assert.equal(resolveCoverPath("", "frontmatter/cover.jpg"), "frontmatter/cover.jpg");
  assert.equal(resolveCoverPath("", "", false), "");
  assert.equal(resolveCoverPath("", "frontmatter/cover.jpg", true), "");
});

test("WeChat character and byte limits are checked before network access", () => {
  assert.equal(characterCount("A😀"), 2);
  assert.equal(characterCount("e\u0301"), 1);
  assert.equal(characterCount("👨‍👩‍👧‍👦"), 1);
  assert.equal(utf8Bytes("A😀"), 5);

  const metadata: DraftMetadata = {
    title: "标".repeat(61),
    author: "作".repeat(17),
    digest: "摘".repeat(121),
    commentsEnabled: false,
    onlyFansCanComment: false,
    draftId: "",
    previousContentHash: "",
    coverPath: "cover.png",
  };
  const issues = preflightDraft({
    metadata,
    markdown: "# 标题\n\n正文",
    html: "文".repeat(20000),
    cover: { role: "cover", source: "cover.png", mimeType: "image/png", byteLength: 1000, converted: false },
  });
  const codes = new Set(issues.map(issue => issue.code));
  assert.equal(codes.has("title_too_long"), true);
  assert.equal(codes.has("author_too_long"), true);
  assert.equal(codes.has("digest_too_long"), true);
  assert.equal(codes.has("content_too_long"), true);
});

test("title accepts 60 visible graphemes and blocks 61 without truncation", () => {
  const metadata = (title: string): DraftMetadata => ({
    title,
    author: "Write",
    digest: "",
    commentsEnabled: false,
    onlyFansCanComment: false,
    draftId: "",
    previousContentHash: "",
    coverPath: "",
  });
  const input = (title: string) => ({
    metadata: metadata(title),
    markdown: `# ${title}\n\n正文`,
    html: "<p>正文</p>",
    cover: { role: "cover" as const, source: "cover.png", mimeType: "image/png", byteLength: 1000, converted: false },
  });
  assert.equal(preflightDraft(input("题".repeat(60))).some(issue => issue.code === "title_too_long"), false);
  assert.equal(preflightDraft(input("题".repeat(61))).some(issue => issue.code === "title_too_long"), true);
  assert.equal(preflightDraft(input("👨‍👩‍👧‍👦".repeat(60))).some(issue => issue.code === "title_too_long"), false);
});

test("empty article, placeholder cover, empty author, and empty digest have distinct severities", () => {
  const issues = preflightDraft({
    metadata: {
      title: "标题",
      author: "",
      digest: "",
      commentsEnabled: false,
      onlyFansCanComment: false,
      draftId: "",
      previousContentHash: "",
      coverPath: "",
    },
    markdown: "# 标题",
    html: "<h1>标题</h1>",
  });
  const byCode = new Map(issues.map(issue => [issue.code, issue.level]));
  assert.equal(byCode.get("empty_body"), "block");
  assert.equal(byCode.has("missing_cover"), false);
  assert.equal(byCode.get("empty_author"), "warn");
  assert.equal(byCode.get("empty_digest"), "warn");
});

test("content image planning keeps compliant files and marks lossy conversions", () => {
  assert.deepEqual(planContentImage({ source: "small.jpg", mimeType: "image/jpeg", byteLength: 999999 }), {
    action: "direct",
    targetMime: "image/jpeg",
    requiresConfirmation: false,
    animationLoss: false,
  });
  assert.deepEqual(planContentImage({ source: "small.png", mimeType: "image/png", byteLength: 1000 }), {
    action: "direct",
    targetMime: "image/png",
    requiresConfirmation: false,
    animationLoss: false,
  });
  assert.deepEqual(planContentImage({ source: "figure.webp", mimeType: "image/webp", byteLength: 400000 }), {
    action: "convert",
    targetMime: "image/jpeg",
    requiresConfirmation: false,
    animationLoss: false,
  });
  assert.deepEqual(planContentImage({ source: "large.png", mimeType: "image/png", byteLength: 1024 * 1024 }), {
    action: "convert",
    targetMime: "image/jpeg",
    requiresConfirmation: false,
    animationLoss: false,
  });
  assert.deepEqual(planContentImage({ source: "animation.GIF", mimeType: "image/gif", byteLength: 400000, animated: true }), {
    action: "convert",
    targetMime: "image/jpeg",
    requiresConfirmation: true,
    animationLoss: true,
  });
  assert.deepEqual(planContentImage({ source: "vector.svg", mimeType: "image/svg+xml", byteLength: 1000 }), {
    action: "blocked",
    targetMime: "image/jpeg",
    requiresConfirmation: false,
    animationLoss: false,
  });
});

test("image preflight blocks unresolved, remote, or invalid final assets and warns on conversion", () => {
  const metadata: DraftMetadata = {
    title: "标题",
    author: "Write",
    digest: "摘要",
    commentsEnabled: false,
    onlyFansCanComment: false,
    draftId: "",
    previousContentHash: "",
    coverPath: "cover.webp",
  };
  const issues = preflightDraft({
    metadata,
    markdown: "# 标题\n\n正文",
    html: "<p>正文</p>",
    contentAssets: [
      { role: "content", source: "too-large.jpg", mimeType: "image/jpeg", byteLength: 1024 * 1024, converted: true },
      { role: "content", source: "bad.gif", mimeType: "image/gif", byteLength: 1000, converted: false },
    ],
    cover: { role: "cover", source: "cover.webp", mimeType: "image/webp", byteLength: 1000, converted: false },
    unresolvedImages: ["missing.png"],
    remoteImages: ["https://example.com/a.png"],
  });
  const codes = new Set(issues.map(issue => issue.code));
  assert.equal(codes.has("content_image_too_large"), true);
  assert.equal(codes.has("content_image_type"), true);
  assert.equal(codes.has("cover_image_type"), true);
  assert.equal(codes.has("unresolved_image"), true);
  assert.equal(codes.has("remote_image"), true);
  assert.equal(codes.has("image_converted"), true);
});

test("content hash is stable and covers every input that changes the draft", () => {
  const base = {
    metadata: {
      title: "标题",
      author: "Write",
      digest: "摘要",
      commentsEnabled: false,
      onlyFansCanComment: false,
    },
    markdown: "# 标题\n\n正文",
    themeId: "moyu-green",
    rendererVersion: "wechat-renderer-v1",
    coverHash: "cover-hash",
    contentAssetHashes: ["image-a", "image-b"],
  };
  const expected = computeContentHash(base);
  assert.equal(computeContentHash(structuredClone(base)), expected);

  for (const changed of [
    { ...base, metadata: { ...base.metadata, title: "新标题" } },
    { ...base, metadata: { ...base.metadata, commentsEnabled: true } },
    { ...base, markdown: base.markdown + "。" },
    { ...base, themeId: "xiaohei" },
    { ...base, rendererVersion: "wechat-renderer-v2" },
    { ...base, coverHash: "new-cover" },
    { ...base, contentAssetHashes: ["image-a", "changed"] },
  ]) assert.notEqual(computeContentHash(changed), expected);
});

test("successful sync frontmatter does not make unchanged content look stale", () => {
  const input = {
    metadata: {
      title: "标题",
      author: "Write",
      digest: "摘要",
      commentsEnabled: false,
      onlyFansCanComment: false,
    },
    markdown: "---\ntitle: 标题\nauthor: Write\ndigest: 摘要\nwrite-wechat-cover: cover.png\n---\n\n# 标题\n\n正文",
    themeId: "moyu-green",
    rendererVersion: "wechat-renderer-v1",
    coverHash: "cover-hash",
    contentAssetHashes: ["image-a"],
  };
  const afterSync = {
    ...input,
    markdown: "---\ntitle: 标题\nauthor: Write\ndigest: 摘要\nwrite-wechat-cover: folder/cover.png\nwrite-wechat-draft-id: draft-123\nwrite-wechat-content-hash: previous-hash\nwrite-wechat-synced-at: 2026-08-08T12:10:20.959Z\nwrite-wechat-theme: moyu-green\n---\n\n# 标题\n\n正文",
  };

  assert.equal(computeContentHash(afterSync), computeContentHash(input));
});

test("asset placeholders and idempotency keys are stable bounded ASCII", () => {
  const hash = "a".repeat(64);
  assert.equal(assetPlaceholder(hash), "https://write.invalid/assets/" + hash);
  assert.equal(assetIdempotencyKey("content", hash), "asset-content-" + hash);
  assert.equal(assetIdempotencyKey("cover", hash), "asset-cover-" + hash);
});

test("upload file names follow detected bytes instead of misleading extensions", () => {
  assert.equal(uploadFileName("1786-implementation.png", "image/jpeg"), "1786-implementation.jpg");
  assert.equal(uploadFileName("封面.webp", "image/png"), "封面.png");
  assert.equal(uploadFileName("no-extension", "image/gif"), "no-extension.gif");
});

test("confirmation summary exposes target, cost, action, and blocking state", () => {
  const summary = buildConfirmationSummary({
    title: "Write v0.2 安全验收",
    accountName: "测试公众号",
    coverPath: "covers/main.png",
    imageCount: 1,
    themeLabel: "摸鱼绿",
    draftId: "",
    issues: [{ level: "warn", code: "empty_digest", message: "摘要为空" }],
  });
  assert.deepEqual(summary, {
    article: "Write v0.2 安全验收",
    target: "测试公众号",
    action: "创建微信公众号草稿",
    cover: "covers/main.png",
    imageCount: 1,
    theme: "摸鱼绿",
    route: "用户自建 Relay",
    credits: 0,
    canConfirm: true,
  });

  assert.equal(buildConfirmationSummary({
    title: "标题",
    accountName: "测试号",
    coverPath: "",
    imageCount: 0,
    themeLabel: "小黑",
    draftId: "draft-1",
    issues: [{ level: "block", code: "missing_cover", message: "缺封面" }],
  }).canConfirm, false);

  const cloud = buildConfirmationSummary({
    title: "标题",
    accountName: "测试号",
    coverPath: "默认封面",
    imageCount: 2,
    themeLabel: "小黑",
    draftId: "",
    issues: [],
    route: "Write Cloud（体验）",
    credits: 1,
  });
  assert.equal(cloud.route, "Write Cloud（体验）");
  assert.equal(cloud.credits, 1);
});
