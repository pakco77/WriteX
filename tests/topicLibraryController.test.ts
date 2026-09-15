import assert from "node:assert/strict";
import test from "node:test";
import { searchDraftForTopicActivation, saveQuickTopicInput, shouldSaveQuickTopicOnKey, shouldScrollFocusedTopic, topicArticleFileName } from "../src/topicLibraryController.ts";

test("quick topic input preserves IME composition and supports consecutive Chinese and English saves", async () => {
  assert.equal(shouldSaveQuickTopicOnKey("Enter", true), false);
  assert.equal(shouldSaveQuickTopicOnKey("Enter", false), true);
  const input = { value: "第一个", disabled: false, focuses: 0, focus() { this.focuses += 1; } };
  let draft = "第一个";
  const saved: string[] = [];
  const run = () => saveQuickTopicInput({ input, currentDraft: () => draft, save: async value => { saved.push(value); }, clearDraft: () => { draft = ""; }, refreshCards: () => undefined, reportError: () => assert.fail("unexpected error"), setSaving: () => undefined });
  assert.equal(await run(), true);
  draft = input.value = "second";
  assert.equal(await run(), true);
  assert.deepEqual(saved, ["第一个", "second"]);
  assert.equal(input.value, "");
  assert.equal(input.disabled, false);
  assert.equal(input.focuses, 2);
});

test("quick topic failure keeps draft, re-enables, and restores focus", async () => {
  const input = { value: "保留草稿", disabled: false, focuses: 0, focus() { this.focuses += 1; } };
  let reported = "";
  const saved = await saveQuickTopicInput({ input, currentDraft: () => "保留草稿", save: async () => { throw new Error("save failed"); }, clearDraft: () => assert.fail("must not clear"), refreshCards: () => assert.fail("must not refresh"), reportError: error => { reported = String(error); }, setSaving: () => undefined });
  assert.equal(saved, false);
  assert.equal(input.value, "保留草稿");
  assert.equal(input.disabled, false);
  assert.equal(input.focuses, 1);
  assert.match(reported, /save failed/);
});

test("focusing a topic clears a stale local search so its card can render and scroll", () => {
  assert.equal(searchDraftForTopicActivation("只匹配另一条", "topic-hidden"), "");
  assert.equal(searchDraftForTopicActivation("保留搜索", undefined), "保留搜索");
  assert.equal(shouldScrollFocusedTopic("topic-hidden", "topic-hidden"), true);
  assert.equal(shouldScrollFocusedTopic("other", "topic-hidden"), false);
});

test("new article names remain one Markdown filename and cannot escape the configured folder", () => {
  assert.equal(topicArticleFileName("路径/../../草稿:一"), "路径-草稿-一.md");
  assert.equal(topicArticleFileName("  "), "未命名文章.md");
});
