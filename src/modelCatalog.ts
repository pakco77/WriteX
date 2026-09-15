import type { ChatAgentId, DiscoveredAgentModels } from "./types.ts";

export interface AgentModelOption { value: string; label: string; }
export type ModelCatalogCache = Partial<Record<ChatAgentId, DiscoveredAgentModels>>;

const FALLBACK: Record<ChatAgentId, AgentModelOption[]> = {
  codex: [],
  claude: [{ value: "sonnet", label: "Sonnet" }, { value: "opus", label: "Opus" }],
  workbuddy: [],
};

export function mergeDiscoveredModels(cache: ModelCatalogCache, agent: ChatAgentId, models: Array<{ model: string; displayName?: string; hidden?: boolean }>, fetchedAt: number): ModelCatalogCache {
  const next = models.filter(item => item.model.trim() && !item.hidden)
    .map(item => ({ value: item.model.trim(), label: item.displayName?.trim() || item.model.trim() }));
  return { ...cache, [agent]: { fetchedAt, models: dedupe(next) } };
}

export function agentModelOptions(agent: ChatAgentId, cache: ModelCatalogCache | undefined, explicit = ""): AgentModelOption[] {
  const values = dedupe([...(cache?.[agent]?.models ?? []), ...FALLBACK[agent]]);
  if (explicit.trim() && !values.some(item => item.value === explicit.trim())) values.push({ value: explicit.trim(), label: `${explicit.trim()}（当前选择，待确认）` });
  return [{ value: "", label: "默认" }, ...values];
}

export function parseWorkBuddyModels(help: string): string[] {
  const payload = help.match(/Currently supported(?: models)?[ \t]*:[ \t]*([^\r\n]*)/i)?.[1]?.trim();
  if (payload === "()") return [];
  const parenthesized = Boolean(payload?.startsWith("(") && payload.endsWith(")"));
  if (!payload || (payload.startsWith("(") !== payload.endsWith(")"))) throw new Error("无法识别 WorkBuddy 模型列表。");
  const list = parenthesized ? payload.slice(1, -1) : payload;
  const values = list.includes(",") ? list.split(",") : list.includes("|") ? list.split("|") : [list];
  if (!values.length || values.some(value => !/^[a-z][a-z0-9]*(?:[-._][a-z0-9]+)*$/i.test(value.trim()))) throw new Error("无法识别 WorkBuddy 模型列表。");
  return [...new Set(values.map(value => value.trim()))];
}

export type ClaudeInitializeModelsParseResult =
  | { kind: "ignore" }
  | { kind: "malformed" }
  | { kind: "error"; message: string }
  | { kind: "models"; models: AgentModelOption[] };

/** Official Claude SDK control initialize response, correlated to the request that WriteX sent. */
export function parseClaudeInitializeModels(line: string): ClaudeInitializeModelsParseResult {
  let event: unknown;
  try { event = JSON.parse(line); } catch { return { kind: "malformed" }; }
  if (!event || typeof event !== "object" || Array.isArray(event)) return { kind: "malformed" };
  const root = event as Record<string, unknown>;
  if (root.type !== "control_response") return { kind: "ignore" };
  if (!root.response || typeof root.response !== "object" || Array.isArray(root.response)) return { kind: "malformed" };
  const response = root.response as Record<string, unknown>;
  if (response.request_id !== "writex-models") return { kind: "ignore" };
  if (response.subtype === "error") {
    const error = response.error;
    const message = typeof error === "string" ? error.trim() : error && typeof error === "object" && !Array.isArray(error) && typeof (error as Record<string, unknown>).message === "string"
      ? ((error as Record<string, unknown>).message as string).trim()
      : "Claude 模型目录初始化失败。";
    return { kind: "error", message: message || "Claude 模型目录初始化失败。" };
  }
  if (response.subtype !== "success" || !response.response || typeof response.response !== "object" || Array.isArray(response.response)) return { kind: "malformed" };
  const payload = response.response as Record<string, unknown>;
  if (!Array.isArray(payload.models)) return { kind: "malformed" };
  const models: AgentModelOption[] = [];
  for (const item of payload.models) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { kind: "malformed" };
    const model = item as Record<string, unknown>;
    if (typeof model.value !== "string" || !model.value.trim() || typeof model.displayName !== "string" || !model.displayName.trim()) return { kind: "malformed" };
    models.push({ value: model.value.trim(), label: model.displayName.trim() });
  }
  return { kind: "models", models: dedupe(models) };
}

function dedupe(items: AgentModelOption[]): AgentModelOption[] {
  const seen = new Set<string>();
  return items.filter(item => !seen.has(item.value) && seen.add(item.value));
}
