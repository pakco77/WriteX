import type { ChatMessage, TopicIdea } from "./types";

const TOPIC_TITLE_LIMIT = 42;
const TOPIC_FIELD = /^(?:推荐选题|一句选题|选题)\s*[:：]\s*/;

function stripTopicLineChrome(line: string): string {
  return line
    .trim()
    .replace(/^>\s*/, "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)、]\s*/, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/(?:\*\*|__|~~|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTopicLine(line: string): string {
  return stripTopicLineChrome(line).replace(TOPIC_FIELD, "").trim();
}

export function deriveTopicTitle(content: string): string {
  const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const preferred = lines.find(line => TOPIC_FIELD.test(stripTopicLineChrome(line)));
  const heading = lines.find(line => /^#{1,6}\s+/.test(line));
  const title = cleanTopicLine(preferred ?? heading ?? lines[0] ?? "") || "未命名选题";
  const characters = Array.from(title);
  return characters.length > TOPIC_TITLE_LIMIT
    ? `${characters.slice(0, TOPIC_TITLE_LIMIT - 1).join("")}…`
    : title;
}

export function findTopicBySourceMessage(topics: TopicIdea[], messageId: string): TopicIdea | undefined {
  return topics.find(topic => topic.sourceMessageId === messageId);
}

export function normalizeTopicTitle(title: string): string {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error("选题标题不能为空。");
  if (Array.from(normalized).length > 120) throw new Error("选题标题不能超过 120 字。");
  return normalized;
}

export function sortTopicsNewestFirst(topics: TopicIdea[]): TopicIdea[] {
  return [...topics].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createManualTopic(
  topics: TopicIdea[],
  title: string,
  sourceNotePath: string | undefined,
  createId: () => string,
  now: () => number = Date.now,
): TopicIdea {
  const normalized = normalizeTopicTitle(title);
  const createdAt = now();
  const topic: TopicIdea = {
    id: createId(),
    title: normalized,
    content: normalized,
    sourceKind: "manual",
    ...(sourceNotePath ? { sourceNotePath } : {}),
    createdAt,
    updatedAt: createdAt,
  };
  topics.unshift(topic);
  return topic;
}

export function saveMessageAsTopic(
  topics: TopicIdea[],
  notePath: string,
  message: ChatMessage,
  createId: () => string,
  now: () => number = Date.now,
): { topic: TopicIdea; created: boolean } {
  const existing = findTopicBySourceMessage(topics, message.id);
  if (existing) return { topic: existing, created: false };
  if (message.role !== "assistant" || message.kind !== "text" || !message.content.trim()) {
    throw new Error("只有文字类型的 Agent 回答可以保存为选题。");
  }
  const createdAt = now();
  const topic: TopicIdea = {
    id: createId(),
    title: deriveTopicTitle(message.content),
    content: message.content,
    sourceKind: "chat",
    status: "idea",
    sourceNotePath: notePath,
    sourceMessageId: message.id,
    sourceAgent: message.agent ?? "codex",
    sourceModel: message.model,
    createdAt,
    updatedAt: createdAt,
  };
  topics.unshift(topic);
  return { topic, created: true };
}

function requireTopic(topics: TopicIdea[], topicId: string): TopicIdea {
  const topic = topics.find(candidate => candidate.id === topicId);
  if (!topic) throw new Error("这条选题已经不存在。");
  return topic;
}

export function renameTopicRecord(
  topics: TopicIdea[],
  topicId: string,
  title: string,
  now: () => number = Date.now,
): TopicIdea {
  const normalized = normalizeTopicTitle(title);
  const topic = requireTopic(topics, topicId);
  topic.title = normalized;
  topic.updatedAt = now();
  return topic;
}

export function deleteTopicRecord(topics: TopicIdea[], topicId: string): TopicIdea | undefined {
  const index = topics.findIndex(topic => topic.id === topicId);
  if (index < 0) return undefined;
  return topics.splice(index, 1)[0];
}

export function moveTopicSourcePaths(topics: TopicIdea[], oldPath: string, newPath: string): boolean {
  let moved = false;
  for (const topic of topics) {
    if (topic.sourceNotePath !== oldPath) continue;
    topic.sourceNotePath = newPath;
    moved = true;
  }
  return moved;
}

export const CUT_LENSES = [
  "具体物件",
  "反常细节",
  "一次误判",
  "隐性代价",
  "时间差",
  "关系变化",
  "第一次失败",
  "未预期后果",
  "局外人视角",
  "做法与口号的矛盾",
  "习以为常的动作",
  "改变前后的同一瞬间",
] as const;

function randomUnit(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 0x1_0000_0000;
}

export function sampleCutLenses(
  candidates: readonly string[] = CUT_LENSES,
  count = 3,
  random: () => number = randomUnit,
): string[] {
  if (candidates.length < count) throw new Error(`找切口至少 ${count} 个观察方向才能抽取。`);
  const pool = [...candidates];
  for (let index = 0; index < count; index += 1) {
    const remaining = pool.length - index;
    const offset = Math.min(remaining - 1, Math.floor(Math.max(0, random()) * remaining));
    [pool[index], pool[index + offset]] = [pool[index + offset]!, pool[index]!];
  }
  return pool.slice(0, count);
}

export function buildCutPrompt(lenses: readonly string[]): string {
  if (lenses.length !== 3 || new Set(lenses).size !== 3) throw new Error("找切口需要恰好 3 个不重复的观察方向。");
  return [
    "找切口：请只基于当前对话、当前笔记或选中文字中的真实材料，",
    "参考下面三个随机观察方向，给出 3 个彼此真正不同的写作切口。",
    "",
    ...lenses.map((lens, index) => `${index + 1}. ${lens}`),
    "",
    "每个切口包含：",
    "1. 一句话切口；",
    "2. 从哪个具体瞬间、动作、物件或反常细节进入；",
    "3. 隐藏的冲突；",
    "4. 为什么这件事值得由我来写；",
    "5. 一句可以继续修改的开头。",
    "",
    "三者不能只是换措辞。不要默认使用‘AI 提效’‘工具教程’或‘时代变化’作为切口；不要生成完整标题组、大纲或成稿；不要编造经历。材料不足时只指出缺少哪些真实材料。",
  ].join("\n");
}
