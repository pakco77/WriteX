import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCutPrompt,
  createManualTopic,
  deriveTopicTitle,
  deleteTopicRecord,
  findTopicBySourceMessage,
  moveTopicSourcePaths,
  normalizeTopicTitle,
  renameTopicRecord,
  sampleCutLenses,
  saveMessageAsTopic,
  sortTopicsNewestFirst,
} from "../src/topics.ts";
import type { ChatMessage, TopicIdea } from "../src/types.ts";

test("topic titles are extracted locally from structured or plain Agent answers", () => {
  assert.equal(
    deriveTopicTitle("推荐选题：一次模型更新，杀死了我的 AI App\n后续材料"),
    "一次模型更新，杀死了我的 AI App",
  );
  assert.equal(deriveTopicTitle("## 我为什么重新做判断系统\n正文"), "我为什么重新做判断系统");
  assert.equal(deriveTopicTitle("先说明背景\n选题：真正值得写的方向"), "真正值得写的方向");
  assert.equal(deriveTopicTitle("- **普通第一行**\n正文"), "普通第一行");
  assert.equal(deriveTopicTitle("   \n\t"), "未命名选题");

  const longTitle = deriveTopicTitle("题".repeat(60));
  assert.equal(Array.from(longTitle).length, 42);
  assert.equal(longTitle.endsWith("…"), true);
});

test("topic lookup and compact library ordering stay local and newest-first", () => {
  const topics: TopicIdea[] = [
    {
      id: "older",
      title: "判断系统",
      content: "从真实经历找写作角度",
      status: "idea",
      sourceKind: "chat",
      sourceNotePath: "旧笔记.md",
      sourceMessageId: "message-1",
      sourceAgent: "claude",
      sourceModel: "claude-sonnet",
      createdAt: 10,
      updatedAt: 20,
    },
    {
      id: "newer",
      title: "模型更新杀死 AI App",
      content: "推荐选题和文章主线",
      status: "writing",
      sourceKind: "chat",
      sourceNotePath: "产品复盘.md",
      sourceMessageId: "message-2",
      sourceAgent: "codex",
      sourceModel: "gpt-5.6-sol",
      createdAt: 30,
      updatedAt: 40,
    },
  ];

  assert.equal(findTopicBySourceMessage(topics, "message-2")?.id, "newer");
  assert.deepEqual(sortTopicsNewestFirst(topics).map(topic => topic.id), ["newer", "older"]);
  assert.deepEqual(topics.map(topic => topic.id), ["older", "newer"]);
});

test("manual topics validate Unicode length and keep optional note provenance", () => {
  assert.equal(normalizeTopicTitle("  一次真实经历  "), "一次真实经历");
  assert.throws(() => normalizeTopicTitle("   "), /不能为空/);
  assert.throws(() => normalizeTopicTitle("题".repeat(121)), /120/);

  const topics: TopicIdea[] = [];
  const topic = createManualTopic(topics, " 一次真实经历 ", "事件.md", () => "manual-1", () => 10);
  assert.deepEqual(topic, {
    id: "manual-1",
    title: "一次真实经历",
    content: "一次真实经历",
    sourceKind: "manual",
    sourceNotePath: "事件.md",
    createdAt: 10,
    updatedAt: 10,
  });
  assert.equal(topics[0], topic);

  const withoutNote = createManualTopic([], "纯手动记录", undefined, () => "manual-2", () => 20);
  assert.equal("sourceNotePath" in withoutNote, false);
});

test("cut lenses are exactly three unique local choices and produce a bounded prompt", () => {
  const values = [0.1, 0.7, 0.4];
  let index = 0;
  const selected = sampleCutLenses(["具体物件", "一次误判", "隐性代价", "时间差"], 3, () => values[index++] ?? 0);
  assert.equal(selected.length, 3);
  assert.equal(new Set(selected).size, 3);
  assert.throws(() => sampleCutLenses(["A", "B"], 3, () => 0), /至少 3 个/);

  const prompt = buildCutPrompt(selected);
  for (const lens of selected) assert.match(prompt, new RegExp(lens));
  assert.match(prompt, /当前对话、当前笔记或选中文字/);
  assert.match(prompt, /3 个彼此真正不同的写作切口/);
  assert.match(prompt, /不要编造经历/);
  assert.match(prompt, /不要生成完整标题组、大纲或成稿/);
});

test("saving an assistant answer as a topic is local and idempotent by message", () => {
  const topics: TopicIdea[] = [];
  const message: ChatMessage = {
    id: "message-1",
    role: "assistant",
    kind: "text",
    content: "推荐选题：我做了两个 AI App，一个死了，一个没来得及发布",
    createdAt: 10,
    agent: "codex",
    model: "gpt-5.6-sol",
  };

  const first = saveMessageAsTopic(topics, "产品复盘.md", message, () => "topic-1", () => 20);
  const second = saveMessageAsTopic(topics, "产品复盘.md", message, () => "unused", () => 30);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.topic, second.topic);
  assert.equal(topics.length, 1);
  assert.deepEqual(topics[0], {
    id: "topic-1",
    title: "我做了两个 AI App，一个死了，一个没来得及发布",
    content: message.content,
    status: "idea",
    sourceKind: "chat",
    sourceNotePath: "产品复盘.md",
    sourceMessageId: "message-1",
    sourceAgent: "codex",
    sourceModel: "gpt-5.6-sol",
    createdAt: 20,
    updatedAt: 20,
  });
});

test("topic edits, source renames, status changes, and deletion stay scoped to topics", () => {
  const topics: TopicIdea[] = [
    {
      id: "topic-1",
      title: "旧标题",
      content: "完整回答",
      status: "idea",
      sourceKind: "chat",
      sourceNotePath: "旧名字.md",
      sourceMessageId: "message-1",
      sourceAgent: "codex",
      createdAt: 10,
      updatedAt: 10,
    },
    {
      id: "topic-2",
      title: "保留",
      content: "另一条回答",
      status: "idea",
      sourceKind: "chat",
      sourceNotePath: "其他.md",
      sourceMessageId: "message-2",
      sourceAgent: "claude",
      createdAt: 11,
      updatedAt: 11,
    },
  ];

  renameTopicRecord(topics, "topic-1", "  新标题  ", () => 20);
  assert.equal(moveTopicSourcePaths(topics, "旧名字.md", "新名字.md"), true);
  assert.equal(topics[0]?.title, "新标题");
  assert.equal(topics[0]?.status, "idea");
  assert.equal(topics[0]?.sourceNotePath, "新名字.md");
  assert.equal(topics[0]?.updatedAt, 20);
  assert.throws(() => renameTopicRecord(topics, "topic-1", "  "), /标题不能为空/);

  assert.equal(deleteTopicRecord(topics, "topic-1")?.id, "topic-1");
  assert.deepEqual(topics.map(topic => topic.id), ["topic-2"]);
});
