import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { CodexRuntime, CodexTurnRequest, CodexTurnResult } from "./codex.ts";
import type { AgentSettings, ChatAgentId, CodexReasoningEffort } from "./types.ts";

export interface AgentModelOption {
  value: string;
  label: string;
}

export const AGENT_LABELS: Record<ChatAgentId, string> = {
  codex: "Codex",
  claude: "Claude",
  workbuddy: "WorkBuddy",
};

export const AGENT_MODELS: Record<ChatAgentId, readonly AgentModelOption[]> = {
  codex: [
    { value: "", label: "默认" },
    { value: "gpt-5.6-sol", label: "Sol" },
    { value: "gpt-5.6-terra", label: "Terra" },
  ],
  claude: [
    { value: "", label: "默认" },
    { value: "sonnet", label: "Sonnet" },
    { value: "opus", label: "Opus" },
  ],
  workbuddy: [{ value: "", label: "默认" }],
};

export const CODEX_REASONING_OPTIONS: ReadonlyArray<{ value: CodexReasoningEffort; label: string }> = [
  { value: "", label: "默认" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" },
  { value: "max", label: "最大" },
  { value: "ultra", label: "Ultra" },
];

export function configuredCodexReasoningEffort(settings: AgentSettings): CodexReasoningEffort {
  return CODEX_REASONING_OPTIONS.some(option => option.value === settings.codexReasoningEffort)
    ? settings.codexReasoningEffort
    : "";
}

export function codexReasoningLabel(effort: CodexReasoningEffort): string {
  return CODEX_REASONING_OPTIONS.find(option => option.value === effort)?.label ?? "默认";
}

export function configuredAgentModel(settings: AgentSettings, agent: ChatAgentId): string {
  const configured = agent === "claude"
    ? settings.claudeModel
    : agent === "workbuddy"
      ? settings.workbuddyModel
      : settings.codexModel;
  return AGENT_MODELS[agent].some(option => option.value === configured) ? configured : "";
}

export function setConfiguredAgentModel(settings: AgentSettings, agent: ChatAgentId, model: string): void {
  if (agent === "claude") settings.claudeModel = model;
  else if (agent === "workbuddy") settings.workbuddyModel = model;
  else settings.codexModel = model;
}

interface ExternalAgentArgsRequest {
  prompt: string;
  model?: string;
  sessionId?: string;
}

export function buildExternalAgentArgs(
  agent: Exclude<ChatAgentId, "codex">,
  request: ExternalAgentArgsRequest,
): string[] {
  const args = [
    "-p",
    "--output-format", "json",
    "--allowedTools", "Read",
    "--disallowedTools", "Bash", "Edit", "Write", "WebFetch", "WebSearch",
  ];
  if (request.model?.trim() && request.model !== "default") args.push("--model", request.model.trim());
  if (request.sessionId?.trim()) args.push("--resume", request.sessionId.trim());
  args.push("--permission-mode", "default");
  args.push(request.prompt);
  return args;
}

export interface ExternalAgentResult extends CodexTurnResult {
  sessionId?: string;
}

function describeExternalAgentJson(value: unknown): string {
  const shape = (item: unknown): string => {
    if (item === null) return "null";
    if (Array.isArray(item)) return `array[${item.length}]`;
    if (typeof item !== "object") return typeof item;
    return Object.entries(item as Record<string, unknown>)
      .map(([key, nested]) => `${key}:${nested === null ? "null" : Array.isArray(nested) ? `array[${nested.length}]` : typeof nested}`)
      .join(",");
  };
  return Array.isArray(value)
    ? `root=array;items=${value.map(shape).join("|")}`
    : `root=${value === null ? "null" : typeof value};${shape(value)}`;
}

export function parseExternalAgentJson(stdout: string): ExternalAgentResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout.trim()) as unknown;
  } catch {
    throw new Error("Agent 返回了无法识别的 JSON。");
  }
  const selected = Array.isArray(decoded)
    ? decoded.slice().reverse().find(item => item && typeof item === "object" && !Array.isArray(item) && item.type === "result")
    : decoded;
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) {
    throw new Error("Agent 返回了无法识别的 JSON。");
  }
  const payload = selected as Record<string, unknown>;
  if (payload.is_error === true) {
    const message = typeof payload.result === "string" ? payload.result.trim() : "Agent 执行失败。";
    throw new Error(message || "Agent 执行失败。");
  }
  const assistantMessage = Array.isArray(decoded)
    ? decoded.slice().reverse().find(item => item && typeof item === "object" && !Array.isArray(item)
      && item.type === "message" && item.role === "assistant") as Record<string, unknown> | undefined
    : payload.type === "message" && payload.role === "assistant"
      ? payload
      : undefined;
  const assistantContent = Array.isArray(assistantMessage?.content) ? assistantMessage.content : [];
  const assistantOutput = assistantContent.find(item => item && typeof item === "object" && !Array.isArray(item)
    && item.type === "output_text" && typeof item.text === "string") as Record<string, unknown> | undefined;
  const resultText = typeof payload.result === "string" ? payload.result.trim() : "";
  const payloadText = typeof payload.text === "string" ? payload.text.trim() : "";
  const assistantText = typeof assistantOutput?.text === "string" ? assistantOutput.text.trim() : "";
  const text = resultText || payloadText || assistantText;
  if (!text) throw new Error(`Agent 没有返回文本（结构：${describeExternalAgentJson(decoded)}）。`);
  const sessionId = typeof payload.session_id === "string"
    ? payload.session_id
    : typeof payload.sessionId === "string"
      ? payload.sessionId
      : undefined;
  return { text, sessionId, threadId: sessionId, warnings: [] };
}

const EXTERNAL_CANDIDATES: Record<Exclude<ChatAgentId, "codex">, string[]> = {
  claude: [
    join(homedir(), ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ],
  workbuddy: [
    join(homedir(), ".local", "bin", "codebuddy"),
    join(homedir(), ".local", "bin", "cbc"),
    "/opt/homebrew/bin/codebuddy",
    "/usr/local/bin/codebuddy",
  ],
};

export interface ChatAgentTurnRequest extends Omit<CodexTurnRequest, "threadId"> {
  agent: ChatAgentId;
  sessionId?: string;
}

export interface ChatAgentOneShotRequest extends Omit<ChatAgentTurnRequest, "sessionId" | "ephemeral"> {}

export class ChatAgentRuntime {
  private readonly children = new Set<ChildProcess>();
  private readonly codex: CodexRuntime;
  private readonly settings: () => AgentSettings;

  constructor(codex: CodexRuntime, settings: () => AgentSettings) {
    this.codex = codex;
    this.settings = settings;
  }

  async check(agent: ChatAgentId): Promise<string> {
    if (agent === "codex") return this.codex.check();
    const binary = await this.resolveExternalPath(agent);
    const result = await this.runProcess(binary, ["--version"], process.cwd());
    const version = result.stdout.trim() || result.stderr.trim();
    if (result.code !== 0 || !version) throw new Error(`${AGENT_LABELS[agent]} CLI 检测失败。`);
    return version;
  }

  async runTurn(request: ChatAgentTurnRequest): Promise<CodexTurnResult> {
    if (request.agent === "codex") {
      return this.codex.runTurn({ ...request, threadId: request.sessionId });
    }
    const binary = await this.resolveExternalPath(request.agent);
    const result = await this.runProcess(
      binary,
      buildExternalAgentArgs(request.agent, request),
      request.cwd,
      request.signal,
    );
    if (result.code !== 0) throw new Error(result.stderr.trim() || `${AGENT_LABELS[request.agent]} 执行失败。`);
    return parseExternalAgentJson(result.stdout);
  }

  async runOneShot(request: ChatAgentOneShotRequest): Promise<CodexTurnResult> {
    if (request.agent === "codex") {
      return this.codex.runTurn({ ...request, ephemeral: true });
    }
    const binary = await this.resolveExternalPath(request.agent);
    const result = await this.runProcess(
      binary,
      buildExternalAgentArgs(request.agent, request),
      request.cwd,
      request.signal,
    );
    if (result.code !== 0) throw new Error(result.stderr.trim() || `${AGENT_LABELS[request.agent]} 执行失败。`);
    return parseExternalAgentJson(result.stdout);
  }

  stop(): void {
    for (const child of this.children) child.kill("SIGTERM");
    this.codex.stop();
  }

  private async resolveExternalPath(agent: Exclude<ChatAgentId, "codex">): Promise<string> {
    const settings = this.settings();
    const configured = agent === "claude" ? settings.claudePath.trim() : settings.workbuddyPath.trim();
    const candidates = configured ? [configured] : EXTERNAL_CANDIDATES[agent];
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue to the next verified executable location.
      }
    }
    const commands = agent === "claude" ? ["claude"] : ["codebuddy", "cbc"];
    for (const command of commands) {
      for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
        const candidate = join(directory, command);
        try {
          await access(candidate, constants.X_OK);
          return candidate;
        } catch {
          // Continue through PATH without invoking a shell.
        }
      }
    }
    throw new Error(`${AGENT_LABELS[agent]} CLI 未连接，请先安装官方 CLI 或在 WriteX 设置中填写可执行文件路径。`);
  }

  private runProcess(
    binary: string,
    args: string[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolveRun, reject) => {
      const child = spawn(binary, args, {
        cwd,
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      this.children.add(child);
      let stdout = "";
      let stderr = "";
      let aborted = false;
      const abort = (): void => {
        aborted = true;
        child.kill("SIGTERM");
      };
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { stdout = `${stdout}${String(chunk)}`.slice(-2_000_000); });
      child.stderr.on("data", chunk => { stderr = `${stderr}${String(chunk)}`.slice(-16000); });
      child.on("error", error => reject(error));
      child.on("close", code => {
        signal?.removeEventListener("abort", abort);
        this.children.delete(child);
        if (aborted) reject(new Error("已停止本次 Agent 生成。"));
        else resolveRun({ stdout, stderr, code: code ?? -1 });
      });
    });
  }
}
