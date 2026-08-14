import assert from "node:assert/strict";
import test from "node:test";
import { assetPlaceholder, type DraftMetadata } from "../src/wechatSync.ts";
import { runSync, type SyncAsset, type SyncRelay, type SyncSnapshot } from "../src/syncFlow.ts";
import type { AssetUploadInput, DraftPayload } from "../src/writeRelay.ts";

const CONTENT_HASH = "c".repeat(64);
const IMAGE_HASH = "a".repeat(64);
const COVER_HASH = "b".repeat(64);

function metadata(overrides: Partial<DraftMetadata> = {}): DraftMetadata {
  return {
    title: "安全验收",
    author: "Write",
    digest: "摘要",
    commentsEnabled: false,
    onlyFansCanComment: false,
    draftId: "",
    previousContentHash: "",
    coverPath: "cover.png",
    ...overrides,
  };
}

function asset(role: "content" | "cover", hash: string): SyncAsset {
  return {
    role,
    source: role + ".jpg",
    fileName: role + ".jpg",
    mimeType: "image/jpeg",
    bytes: Uint8Array.from([0xff, 0xd8, 0xff]).buffer,
    sha256: hash,
    converted: false,
  };
}

function snapshot(overrides: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return {
    notePath: "Write Sync Acceptance.md",
    metadata: metadata(),
    markdown: "# 安全验收\n\n正文",
    html: `<p>正文<img src="${assetPlaceholder(IMAGE_HASH)}"></p>`,
    themeId: "moyu-green",
    contentHash: CONTENT_HASH,
    contentAssets: [asset("content", IMAGE_HASH)],
    cover: asset("cover", COVER_HASH),
    ...overrides,
  };
}

function relay(calls: string[]): SyncRelay {
  return {
    async uploadAsset(input: AssetUploadInput) {
      calls.push("asset:" + input.kind + ":" + input.idempotencyKey);
      return input.kind === "content"
        ? { ok: true, kind: "content", sha256: input.sha256, url: "https://mmbiz.qpic.cn/content", cached: false }
        : { ok: true, kind: "cover", sha256: input.sha256, mediaId: "cover-media", cached: false };
    },
    async createDraft(payload: DraftPayload, key: string) {
      calls.push("create:" + key + ":" + payload.content);
      return { ok: true, draftId: "draft-123", operation: "created", cached: false };
    },
    async updateDraft(draftId: string, payload: DraftPayload, key: string) {
      calls.push("update:" + draftId + ":" + key + ":" + payload.content);
      return { ok: true, draftId, operation: "updated", cached: false };
    },
  };
}

test("unchanged content with a bound draft performs zero relay and frontmatter calls", async () => {
  const calls: string[] = [];
  const writes: unknown[] = [];
  const result = await runSync(snapshot({
    metadata: metadata({ draftId: "draft-123", previousContentHash: CONTENT_HASH }),
  }), relay(calls), value => { writes.push(value); }, () => new Date("2026-08-08T12:00:00+08:00"));
  assert.deepEqual(result, { status: "unchanged", draftId: "draft-123" });
  assert.deepEqual(calls, []);
  assert.deepEqual(writes, []);
});

test("matching hash without a bound draft still creates a draft", async () => {
  const calls: string[] = [];
  await runSync(snapshot({ metadata: metadata({ previousContentHash: CONTENT_HASH }) }), relay(calls), () => undefined);
  assert.equal(calls.some(call => call.startsWith("create:")), true);
});

test("create flow uploads content then cover, replaces placeholders, and writes success last", async () => {
  const calls: string[] = [];
  const writes: unknown[] = [];
  const result = await runSync(
    snapshot(),
    relay(calls),
    value => { calls.push("frontmatter"); writes.push(value); },
    () => new Date("2026-08-08T12:00:00+08:00"),
  );
  assert.equal(calls[0], "asset:content:asset-content-" + IMAGE_HASH);
  assert.equal(calls[1], "asset:cover:asset-cover-" + COVER_HASH);
  assert.match(calls[2], /^create:draft-/);
  assert.match(calls[2], /https:\/\/mmbiz\.qpic\.cn\/content/);
  assert.equal(calls[3], "frontmatter");
  assert.deepEqual(result, { status: "synced", draftId: "draft-123", operation: "created", imageCount: 1 });
  assert.deepEqual(writes, [{
    draftId: "draft-123",
    title: "安全验收",
    contentHash: CONTENT_HASH,
    syncedAt: "2026-08-08T04:00:00.000Z",
    themeId: "moyu-green",
    coverPath: "cover.png",
  }]);
});

test("sync reports per-image, cover, and draft progress with the concrete source", async () => {
  const progress: string[] = [];
  await runSync(snapshot(), relay([]), () => undefined, () => new Date(), value => {
    progress.push(`${value.stage}:${value.completed}/${value.total}:${value.source ?? ""}`);
  });
  assert.deepEqual(progress, [
    "uploading-content:0/1:content.jpg",
    "uploading-content:1/1:content.jpg",
    "uploading-cover:0/1:cover.jpg",
    "uploading-cover:1/1:cover.jpg",
    "writing-draft:0/1:",
    "writing-draft:1/1:",
  ]);
});

test("a bound draft uses update instead of create", async () => {
  const calls: string[] = [];
  const result = await runSync(snapshot({ metadata: metadata({ draftId: "draft-123" }) }), relay(calls), () => undefined);
  assert.equal(calls.some(call => call.startsWith("update:draft-123:")), true);
  assert.equal(calls.some(call => call.startsWith("create:")), false);
  assert.equal(result.status, "synced");
});

test("a recorded title change creates a new draft and writes the new title binding", async () => {
  const calls: string[] = [];
  const writes: unknown[] = [];
  const result = await runSync(snapshot({
    metadata: metadata({ draftId: "draft-123", title: "新标题", previousTitle: "原标题" }),
  }), relay(calls), value => { writes.push(value); });

  assert.equal(calls.some(call => call.startsWith("update:")), false);
  assert.equal(calls.some(call => call.startsWith("create:")), true);
  assert.equal(result.status === "synced" && result.operation, "created");
  assert.equal((writes[0] as { title: string }).title, "新标题");
});

test("a body-only change keeps updating the same draft and writes the synchronized title", async () => {
  const calls: string[] = [];
  const writes: unknown[] = [];
  const result = await runSync(snapshot({
    metadata: metadata({ draftId: "draft-123", title: "原标题", previousTitle: "原标题" }),
    markdown: "# 原标题\n\n正文已修改",
    contentHash: "d".repeat(64),
  }), relay(calls), value => { writes.push(value); });

  assert.equal(calls.some(call => call.startsWith("update:draft-123:")), true);
  assert.equal(calls.some(call => call.startsWith("create:")), false);
  assert.equal(result.status === "synced" && result.operation, "updated");
  assert.equal((writes[0] as { title: string }).title, "原标题");
});

test("placeholder cover uploads only as cover and never enters body or frontmatter", async () => {
  const calls: string[] = [];
  const writes: unknown[] = [];
  const placeholder = {
    ...asset("cover", COVER_HASH),
    source: "write://placeholder-cover/white-900x383.png",
    placeholder: true,
  };
  const value = snapshot({
    metadata: metadata({ coverPath: "" }),
    cover: placeholder,
  });
  await runSync(value, relay(calls), state => { writes.push(state); });
  assert.equal(calls.filter(call => call.startsWith("asset:cover:")).length, 1);
  assert.equal(calls.filter(call => call.startsWith("asset:content:")).length, 1);
  assert.equal(calls.some(call => call.includes("write://placeholder-cover")), false);
  assert.equal((writes[0] as { coverPath: string }).coverPath, "");
});

test("asset or draft failure never writes success frontmatter", async () => {
  const writes: unknown[] = [];
  const brokenAsset = relay([]);
  brokenAsset.uploadAsset = async () => { throw new Error("asset failed"); };
  await assert.rejects(() => runSync(snapshot(), brokenAsset, value => { writes.push(value); }), /asset failed/);
  assert.deepEqual(writes, []);

  const brokenDraft = relay([]);
  brokenDraft.createDraft = async () => { throw new Error("draft failed"); };
  await assert.rejects(() => runSync(snapshot(), brokenDraft, value => { writes.push(value); }), /draft failed/);
  assert.deepEqual(writes, []);
});

test("unresolved placeholders or oversized final HTML stop before draft creation", async () => {
  const calls: string[] = [];
  const unresolved = snapshot({ contentAssets: [] });
  await assert.rejects(() => runSync(unresolved, relay(calls), () => undefined), /占位符/);
  assert.equal(calls.some(call => call.startsWith("create:")), false);

  const huge = snapshot({ html: "文".repeat(20000), contentAssets: [] });
  await assert.rejects(() => runSync(huge, relay(calls), () => undefined), /2 万字符/);
});
