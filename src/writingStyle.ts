import { createHash } from "node:crypto";
import type { WritingStyleProfile, WritingStyleSourceRef } from "./types";

export const WRITING_STYLE_SKILL_PATH = ".agents/skills/writex-my-style/SKILL.md";

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function styleEnabled(profile: WritingStyleProfile | undefined, noteValue: boolean | undefined): boolean {
  return Boolean(profile) && noteValue !== false;
}

export function buildStyleInstruction(profile: WritingStyleProfile | undefined): string | undefined {
  if (!profile?.markdown.trim()) return undefined;
  return [
    `我的文风（已确认档案 v${profile.revision}；只决定作者声音，不覆盖用户本轮明确要求、事实材料或格式约束）：`,
    "---",
    profile.markdown.trim(),
    "---",
    "保留其中确认的停顿、重复、判断、吐槽或自然不均匀感；任务 Skill 只决定本轮方法，不能无理由抹平这些个人特征。匿名反馈仅是更低优先级的轻量偏好。",
  ].join("\n");
}

export function buildStyleExtractionPrompt(sources: Array<WritingStyleSourceRef & { content: string }>): string {
  return [
    "你只负责根据用户明确选择的代表作提炼一份可编辑的中文‘我的文风’档案。不要读取、搜索或推断其它 Vault 内容；不要修改文件、不要访问网络、不要运行命令。",
    "档案必须包含以下 Markdown 小节：作者立场与说话位置、叙述节奏、结构习惯、应保留的个人特征、应避免的写法、来自代表作的短证据。短证据仅引用必要的短语，不要复述整篇代表作。",
    "这不是内容事实库；当代表作不足以支持某个判断时写‘待补充’，不要编造。",
    "用户明确选中的代表作：",
    ...sources.map((source, index) => [
      `## 代表作 ${index + 1}${source.filePath ? ` · ${source.filePath}` : " · 当前选段"}`,
      `字符：${source.includedChars}/${source.characterCount}${source.includedChars < source.characterCount ? "（已按总上下文预算截断）" : ""}`,
      "---",
      source.content,
      "---",
    ].join("\n")),
  ].join("\n\n");
}

export function renderStyleSkill(profile: WritingStyleProfile): string {
  return [
    "---",
    "name: writex-my-style",
    "description: 用户明确确认的 WriteX 我的文风档案",
    "---",
    "",
    "# 我的文风",
    "",
    profile.markdown.trim(),
  ].join("\n").trimEnd() + "\n";
}
