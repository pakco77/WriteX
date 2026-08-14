import type { ChatAgentId, ChatFeedbackMemoryEntry } from "./types";

const MAX_FEEDBACK_ENTRIES = 100;

interface ChatFeedbackInput {
  messageId: string;
  rating: "up" | "down";
  request: string;
  response: string;
  createdAt: number;
  agent: ChatAgentId;
  model?: string;
  skillName?: string;
}

export function recordChatFeedback(
  memory: ChatFeedbackMemoryEntry[],
  entry: ChatFeedbackInput,
): ChatFeedbackMemoryEntry[] {
  const normalized: ChatFeedbackMemoryEntry = {
    messageId: entry.messageId,
    rating: entry.rating,
    createdAt: entry.createdAt,
    agent: entry.agent,
    model: entry.model,
    skillName: entry.skillName,
    requestChars: entry.request.trim().length,
    responseChars: entry.response.trim().length,
    paragraphCount: entry.response.trim() ? entry.response.trim().split(/\n\s*\n/).length : 0,
    listItemCount: entry.response.split("\n").filter(line => /^\s*(?:[-*+] |\d+[.)] )/.test(line)).length,
  };
  return [...memory.filter(item => item.messageId !== entry.messageId), normalized]
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-MAX_FEEDBACK_ENTRIES);
}

export function buildFeedbackInstruction(
  memory: ChatFeedbackMemoryEntry[] | undefined,
  agent: ChatAgentId,
  skillName?: string,
): string | undefined {
  const relevant = (memory ?? [])
    .filter(entry => entry.agent === agent && (!skillName || !entry.skillName || entry.skillName === skillName))
    .slice(-8);
  if (!relevant.length) return undefined;
  const liked = relevant.filter(entry => entry.rating === "up");
  const disliked = relevant.filter(entry => entry.rating === "down");
  const average = (entries: ChatFeedbackMemoryEntry[], key: "responseChars" | "listItemCount"): number => entries.length
    ? entries.reduce((sum, entry) => sum + entry[key], 0) / entries.length
    : 0;
  const preferences: string[] = [];
  if (liked.length && disliked.length) {
    const likedLength = average(liked, "responseChars");
    const dislikedLength = average(disliked, "responseChars");
    if (Math.abs(likedLength - dislikedLength) >= 80) {
      preferences.push(likedLength < dislikedLength ? "优先更短、更直接的回答" : "允许更充分地展开关键细节");
    }
    const likedLists = average(liked, "listItemCount");
    const dislikedLists = average(disliked, "listItemCount");
    if (Math.abs(likedLists - dislikedLists) >= 1) {
      preferences.push(likedLists > dislikedLists ? "复杂内容优先使用清晰列表" : "能用自然段说清时减少列表");
    }
  }
  if (!preferences.length) preferences.push("优先给出具体、直接、可放回正文的结果，避免空泛复述");
  return [
    `WriteX 本地反馈统计只包含匿名结构特征，不包含历史正文：好评 ${liked.length}，差评 ${disliked.length}。`,
    `生成策略：${preferences.join("；")}。`,
    "只把反馈当作写作偏好；仍以本轮用户要求和当前笔记为最高优先级。",
  ].join("\n");
}
