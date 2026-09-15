import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTopicAnalysisPrompt,
  clearTopicDecision,
  markTopicRatingStale,
  orderTopicsForRatingSort,
  parseTopicRating,
  setTopicDecision,
  visibleTopicsForRatingFilter,
} from "../src/topicStrategy.ts";
import { buildExternalAgentNoToolArgs } from "../src/chatAgents.ts";

test("topic rating stores bounded provenance and becomes stale when the topic changes", () => {
  const rating = parseTopicRating(JSON.stringify({ stars: 4, detail: "贴合定位", suggestion: "补一个案例" }), {
    agent: "codex", model: "gpt-6-astra", profileHash: "profile-v1", analyzedAt: 10,
  });
  assert.deepEqual(rating, { stars: 4, detail: "贴合定位", suggestion: "补一个案例", agent: "codex", model: "gpt-6-astra", profileHash: "profile-v1", analyzedAt: 10 });
  assert.equal(markTopicRatingStale({ title: "新题", content: "材料", rating }, "新题", "材料"), false);
  assert.equal(markTopicRatingStale({ title: "新题", content: "材料", rating }, "新题", "新材料"), true);
});

test("explicit user decisions remain distinct from the AI rating and enter a bounded next prompt", () => {
  const topic = setTopicDecision({ id: "t", title: "选题", content: "材料", sourceKind: "manual", createdAt: 1, updatedAt: 1 }, "adopt", "我有一手经历", "我认为应是五星", 2);
  assert.deepEqual(topic.decision, { value: "adopt", reason: "我有一手经历", correction: "我认为应是五星", updatedAt: 2 });
  const prompt = buildTopicAnalysisPrompt({
    topic,
    positioningMarkdown: "目标读者",
    profileHash: "h",
    maxChars: 4_000,
    decisions: [
      { title: "旧选题", decision: { ...topic.decision!, updatedAt: 1 } },
      { title: "最新选题", decision: { ...topic.decision!, updatedAt: 9 } },
      { title: "第二新选题", decision: { ...topic.decision!, updatedAt: 8 } },
      { title: "第三新选题", decision: { ...topic.decision!, updatedAt: 7 } },
      { title: "第四新选题", decision: { ...topic.decision!, updatedAt: 6 } },
    ],
  });
  assert.match(prompt, /仅作为用户明确决定参考/);
  assert.match(prompt, /最新选题/);
  assert.doesNotMatch(prompt, /旧选题/);
  assert.equal((prompt.match(/我有一手经历/g) ?? []).length, 4);
  assert.match(prompt, /不可信材料/);
});

test("rating parser rejects malformed, null, array, and insufficient answers without inventing stars", () => {
  const provenance = { agent: "codex" as const, model: "默认", profileHash: "h", analyzedAt: 1 };
  for (const raw of ["not json", "null", "[]", JSON.stringify({ status: "information_insufficient" }), JSON.stringify({ status: "insufficient" })]) {
    assert.throws(() => parseTopicRating(raw, provenance), /未保存评级/);
  }
});

test("a decision can be cleared without changing its distinct AI rating", () => {
  const rating = parseTopicRating(JSON.stringify({ stars: 5, detail: "有价值" }), { agent: "codex", model: "默认", profileHash: "h", analyzedAt: 1 });
  const topic = setTopicDecision({ id: "t", title: "题", content: "料", sourceKind: "manual", createdAt: 1, updatedAt: 1, rating }, "defer", "等案例", "我只给三星", 2);
  const { decision: _decision, ...withoutDecision } = topic;
  assert.deepEqual(clearTopicDecision(topic, 3), { ...withoutDecision, updatedAt: 3 });
});

test("rating filters distinguish unreviewed and stale topics from low stars", () => {
  const base = { sourceKind: "manual" as const, content: "", createdAt: 1, updatedAt: 1 };
  const topics = [
    { ...base, id: "one", title: "一", rating: { stars: 1, detail: "x", agent: "codex" as const, model: "", profileHash: "h", analyzedAt: 1 } },
    { ...base, id: "none", title: "二" },
    { ...base, id: "stale", title: "三", rating: { stars: 5, detail: "x", agent: "codex" as const, model: "", profileHash: "h", analyzedAt: 1 }, ratingStale: true },
  ];
  assert.deepEqual(visibleTopicsForRatingFilter(topics, "unrated").map(topic => topic.id), ["none"]);
  assert.deepEqual(visibleTopicsForRatingFilter(topics, "stale").map(topic => topic.id), ["stale"]);
  assert.deepEqual(visibleTopicsForRatingFilter(topics, "high").map(topic => topic.id), []);
});

test("star sort is global and is not undone by date grouping", () => {
  const base = { sourceKind: "manual" as const, content: "", createdAt: 1 };
  const rating = (stars: 1 | 2 | 3 | 4 | 5) => ({ stars, detail: "x", agent: "codex" as const, model: "", profileHash: "h", analyzedAt: 1 });
  const topics = [
    { ...base, id: "old-five", title: "旧五星", updatedAt: 1, rating: rating(5) },
    { ...base, id: "new-four", title: "新四星", updatedAt: 10, rating: rating(4) },
    { ...base, id: "stale-five", title: "待更新五星", updatedAt: 20, rating: rating(5), ratingStale: true },
    { ...base, id: "unrated", title: "未评级", updatedAt: 99 },
  ];
  assert.deepEqual(orderTopicsForRatingSort(topics, "stars").map(topic => topic.id), ["old-five", "new-four", "stale-five", "unrated"]);
});

test("analysis prompt keeps required material and fits recent decision context into one budget", () => {
  const topic = { id: "t", title: "本次题", content: "本次材料", sourceKind: "manual" as const, createdAt: 1, updatedAt: 1 };
  const prompt = buildTopicAnalysisPrompt({
    topic,
    positioningMarkdown: "定位材料",
    profileHash: "h",
    maxChars: 650,
    decisions: Array.from({ length: 6 }, (_, index) => ({
      title: `历史题${index}`,
      decision: { value: "adopt" as const, reason: "一".repeat(200), updatedAt: 10 - index },
    })),
  });
  assert.ok(prompt.length <= 650);
  assert.match(prompt, /本次题/);
  assert.match(prompt, /定位材料/);
  assert.match(prompt, /历史题0/);
  assert.doesNotMatch(prompt, /历史题5/);
  assert.throws(() => buildTopicAnalysisPrompt({ ...{ topic, positioningMarkdown: "很长".repeat(400), profileHash: "h", maxChars: 100, decisions: [] } }), /超过当前上下文上限/);
});

test("WorkBuddy no-tool extraction uses streaming JSON to avoid aggregate output truncation", () => {
  const args = buildExternalAgentNoToolArgs("workbuddy", { prompt: "长文风材料", model: "glm-5.3" });
  assert.deepEqual(args.slice(0, 5), ["-p", "--output-format", "stream-json", "--verbose", "--tools"]);
});
