import assert from "node:assert/strict";
import test from "node:test";
import { CreatedTopicArticleUnlinkedError, createOrAssociateTopicArticle } from "../src/topicArticleCreation.ts";

test("a persistence failure leaves one recoverable article and retries association without creating a suffix", async () => {
  const files = new Map<string, { path: string }>();
  let creates = 0;
  let failPersist = true;
  const run = (pendingPath?: string) => createOrAssociateTopicArticle({
    pendingPath,
    fileAtPath: path => files.get(path) ?? null,
    nextPath: () => "文章.md",
    create: async path => { creates += 1; const file = { path }; files.set(path, file); return file; },
    pathOf: file => file.path,
    associate: async () => { if (failPersist) throw new Error("disk full"); },
  });
  await assert.rejects(run(), error => error instanceof CreatedTopicArticleUnlinkedError && error.filePath === "文章.md");
  failPersist = false;
  const recovered = await run("文章.md");
  assert.equal(recovered.path, "文章.md");
  assert.equal(creates, 1);
});
