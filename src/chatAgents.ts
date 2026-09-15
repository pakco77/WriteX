import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { CodexRuntime, CodexTurnRequest, CodexTurnResult } from "./codex.ts";
import type { AgentSettings, ChatAgentId, CodexReasoningEffort } from "./types.ts";
import { parseClaudeInitializeModels } from "./modelCatalog.ts";

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
  // An explicit model remains selected even when discovery has not refreshed yet.
  return typeof configured === "string" ? configured : "";
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

const CLAUDE_NO_TOOL_FLAGS = ["--tools", "--strict-mcp-config", "--no-session-persistence", "--setting-sources"] as const;

export interface ClaudeNoToolCapabilities {
  supported: boolean;
  missing: string[];
}

export function parseClaudeNoToolCapabilities(result: { code: number; stdout: string; stderr?: string }): ClaudeNoToolCapabilities {
  const help = `${result.stdout}\n${result.stderr ?? ""}`;
  const missing = result.code === 0
    ? CLAUDE_NO_TOOL_FLAGS.filter(flag => !help.includes(flag))
    : [...CLAUDE_NO_TOOL_FLAGS];
  return { supported: missing.length === 0, missing };
}

export function buildExternalAgentArgs(
  agent: Exclude<ChatAgentId, "codex">,
  request: ExternalAgentArgsRequest,
): string[] {
  const args = [
    "-p",
    "--output-format", agent === "workbuddy" ? "stream-json" : "json",
    ...(agent === "workbuddy" ? ["--verbose"] : []),
    "--allowedTools", "Read",
    "--disallowedTools", "Bash", "Edit", "Write", "WebFetch", "WebSearch",
  ];
  if (request.model?.trim() && request.model !== "default") args.push("--model", request.model.trim());
  if (request.sessionId?.trim()) args.push("--resume", request.sessionId.trim());
  args.push("--permission-mode", "default");
  args.push(request.prompt);
  return args;
}

export function buildExternalAgentNoToolArgs(
  agent: Exclude<ChatAgentId, "codex">,
  request: Pick<ExternalAgentArgsRequest, "prompt" | "model">,
  claudeCapabilities?: ClaudeNoToolCapabilities,
): string[] {
  if (agent === "claude" && !claudeCapabilities?.supported) {
    throw new Error("无法确认 Claude CLI 的无工具能力；为保护未选择的 Vault 内容，文风提炼已拒绝执行。请修复官方 CLI 后再试。");
  }
  const args = [
    "-p",
    "--output-format", agent === "workbuddy" ? "stream-json" : "json",
    ...(agent === "workbuddy" ? ["--verbose"] : []),
    "--tools", "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--setting-sources", "",
  ];
  if (request.model?.trim() && request.model !== "default") args.push("--model", request.model.trim());
  args.push("--permission-mode", "default", request.prompt);
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

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeWorkBuddyStreamEvent(value: unknown): unknown {
  if (!isJsonRecord(value) || value.type !== "assistant" || !isJsonRecord(value.message)) return value;
  const message = value.message;
  const content = Array.isArray(message.content)
    ? message.content.map(block => isJsonRecord(block) && block.type === "text" && typeof block.text === "string"
      ? { ...block, type: "output_text" }
      : block)
    : message.content;
  return {
    ...message,
    type: "message",
    role: typeof message.role === "string" ? message.role : "assistant",
    content,
    session_id: typeof message.session_id === "string" ? message.session_id : value.session_id,
  };
}

/** CodeBuddy stream-json is NDJSON; tolerate one malformed progress line when a final result arrives. */
export function parseWorkBuddyStreamJson(stdout: string): ExternalAgentResult {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("WorkBuddy 没有返回流式结果。");
  try {
    const decoded = JSON.parse(trimmed) as unknown;
    if (Array.isArray(decoded)) return parseExternalAgentJson(JSON.stringify(decoded.map(normalizeWorkBuddyStreamEvent)));
    if (isJsonRecord(decoded) && (decoded.type === "result" || decoded.type === "message")) return parseExternalAgentJson(trimmed);
    if (isJsonRecord(decoded)) return parseExternalAgentJson(JSON.stringify([normalizeWorkBuddyStreamEvent(decoded)]));
  } catch {
    // A stream contains one independent JSON value per line; parse it below.
  }
  const events: unknown[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(normalizeWorkBuddyStreamEvent(JSON.parse(line) as unknown)); }
    catch { /* Progress diagnostics can be malformed; a later final result remains authoritative. */ }
  }
  if (!events.length) throw new Error("WorkBuddy 返回了无法识别的流式事件。");
  return parseExternalAgentJson(JSON.stringify(events));
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
    "/opt/homebrew/bin/cbc",
    "/usr/local/bin/codebuddy",
    "/usr/local/bin/cbc",
  ],
};

const WORKBUDDY_INITIALIZE_TIMEOUT_MS = 30_000;
const WORKBUDDY_AUTHORIZATION_TIMEOUT_MS = 300_000;
const WORKBUDDY_INSTALL_TIMEOUT_MS = 300_000;
const WORKBUDDY_TERMINATE_GRACE_MS = 1_500;
const WORKBUDDY_CONTROL_OUTPUT_LIMIT = 64 * 1024;
const WORKBUDDY_AUTH_HOSTS = ["codebuddy.cn", "codebuddy.ai", "copilot.tencent.com"] as const;

export type WorkBuddyConnectionStatus = "existing-account" | "authorized" | "not-connected";

export interface WorkBuddyConnectionResult {
  status: WorkBuddyConnectionStatus;
  path: string;
}

export type WorkBuddyControlEvent =
  | { kind: "initialize"; requestId: string; hasUserId: boolean; hasToken: boolean }
  | { kind: "authorization-url"; requestId: string; url: string }
  | { kind: "invalid-authorization-url"; requestId: string }
  | { kind: "authorization-result"; requestId: string }
  | { kind: "unknown-control"; requestId: string }
  | { kind: "failure" };

export function externalAgentEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const current = (environment.PATH ?? "").split(delimiter).filter(Boolean);
  // macOS GUI apps commonly omit package-manager Node paths; append fallbacks without reordering a user's PATH.
  const path = [...new Set([...current, "/opt/homebrew/bin", "/usr/local/bin"])].join(delimiter);
  return { ...environment, PATH: path };
}

function isOfficialWorkBuddyAuthorizationUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && WORKBUDDY_AUTH_HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}

export function parseWorkBuddyControlEvent(line: string): WorkBuddyControlEvent | null {
  let event: unknown;
  try { event = JSON.parse(line); }
  catch { return null; }
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const value = event as Record<string, unknown>;
  if (value.type === "control_response" && value.response && typeof value.response === "object" && !Array.isArray(value.response)) {
    const response = value.response as Record<string, unknown>;
    if (response.subtype !== "success") return { kind: "failure" };
    const payload = response.response && typeof response.response === "object" && !Array.isArray(response.response)
      ? response.response as Record<string, unknown>
      : undefined;
    const account = payload?.account && typeof payload.account === "object" && !Array.isArray(payload.account)
      ? payload.account as Record<string, unknown>
      : undefined;
    if (typeof response.request_id === "string") {
      return {
        kind: "initialize",
        requestId: response.request_id,
        hasUserId: typeof account?.userId === "string" && Boolean(account.userId),
        hasToken: typeof account?.token === "string" && Boolean(account.token),
      };
    }
    return { kind: "failure" };
  }
  if (value.type !== "control_request" || typeof value.request_id !== "string" || !value.request || typeof value.request !== "object" || Array.isArray(value.request)) return null;
  const request = value.request as Record<string, unknown>;
  if (request.subtype === "auth_url_callback") {
    const authState = request.authState && typeof request.authState === "object" && !Array.isArray(request.authState)
      ? request.authState as Record<string, unknown>
      : undefined;
    return isOfficialWorkBuddyAuthorizationUrl(authState?.authUrl)
      ? { kind: "authorization-url", requestId: value.request_id, url: authState.authUrl }
      : { kind: "invalid-authorization-url", requestId: value.request_id };
  }
  if (request.subtype === "auth_result_callback") {
    const userinfo = request.userinfo && typeof request.userinfo === "object" && !Array.isArray(request.userinfo)
      ? request.userinfo as Record<string, unknown>
      : undefined;
    return request.success === true && typeof userinfo?.userId === "string" && Boolean(userinfo.userId)
      && typeof userinfo.token === "string" && Boolean(userinfo.token)
      ? { kind: "authorization-result", requestId: value.request_id }
      : { kind: "failure" };
  }
  return { kind: "unknown-control", requestId: value.request_id };
}

export function buildWorkBuddyControlResponse(requestId: string, acknowledgement: "received" | "handled"): Record<string, unknown> {
  return {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: acknowledgement === "received" ? { received: true } : { handled: true },
    },
  };
}

async function withIsolatedWorkBuddyConnectionCwd<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "writex-workbuddy-connect-"));
  await chmod(cwd, 0o700);
  try { return await run(cwd); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}

export interface ChatAgentTurnRequest extends Omit<CodexTurnRequest, "threadId"> {
  agent: ChatAgentId;
  sessionId?: string;
}

export interface ChatAgentOneShotRequest extends Omit<ChatAgentTurnRequest, "sessionId" | "ephemeral"> {}

export class ChatAgentRuntime {
  private readonly children = new Set<ChildProcess>();
  private readonly processGroupChildren = new Set<ChildProcess>();
  private readonly codex: CodexRuntime;
  private readonly settings: () => AgentSettings;

  constructor(codex: CodexRuntime, settings: () => AgentSettings) {
    this.codex = codex;
    this.settings = settings;
  }

  async check(agent: ChatAgentId): Promise<string> {
    if (agent === "codex") return this.codex.check();
    if (agent === "workbuddy") {
      const connection = await this.inspectWorkBuddyConnection();
      if (connection.status === "existing-account") return "已检测到已登录账号";
      throw new Error("WorkBuddy CLI 已检测到，但尚未连接账号。请在 WriteX 设置中点击“连接 WorkBuddy”。");
    }
    const binary = await this.resolveExternalPath(agent);
    const result = await this.runProcess(binary, ["--version"], process.cwd());
    const version = result.stdout.trim() || result.stderr.trim();
    if (result.code !== 0 || !version) throw new Error(`${AGENT_LABELS[agent]} CLI 检测失败。`);
    return version;
  }

  async runTurn(request: ChatAgentTurnRequest): Promise<CodexTurnResult> {
    if (request.agent === "codex") {
      return this.codex.runTurn({ ...request, threadId: request.sessionId, allowWebSearch: this.settings().codexWebSearchEnabled });
    }
    const binary = await this.resolveExternalPath(request.agent);
    const result = await this.runProcess(
      binary,
      buildExternalAgentArgs(request.agent, request),
      request.cwd,
      request.signal,
    );
    if (result.code !== 0) throw new Error(result.stderr.trim() || `${AGENT_LABELS[request.agent]} 执行失败。`);
    return request.agent === "workbuddy" ? parseWorkBuddyStreamJson(result.stdout) : parseExternalAgentJson(result.stdout);
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
    return request.agent === "workbuddy" ? parseWorkBuddyStreamJson(result.stdout) : parseExternalAgentJson(result.stdout);
  }

  async runNoToolOneShot(request: ChatAgentOneShotRequest): Promise<CodexTurnResult> {
    if (request.agent === "codex") return this.codex.runNoToolTurn({ ...request, ephemeral: true });
    const binary = await this.resolveExternalPath(request.agent);
    const claudeCapabilities = request.agent === "claude"
      ? parseClaudeNoToolCapabilities(await this.runProcess(binary, ["--help"], request.cwd, request.signal))
      : undefined;
    const result = await this.runProcess(binary, buildExternalAgentNoToolArgs(request.agent, request, claudeCapabilities), request.cwd, request.signal);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `${AGENT_LABELS[request.agent]} 执行失败。`);
    return request.agent === "workbuddy" ? parseWorkBuddyStreamJson(result.stdout) : parseExternalAgentJson(result.stdout);
  }

  async inspectWorkBuddyConnection(signal?: AbortSignal): Promise<WorkBuddyConnectionResult> {
    return this.runWorkBuddyConnection({ signal, authorize: false });
  }

  async listWorkBuddyModels(): Promise<string[]> {
    const binary = await this.resolveExternalPath("workbuddy");
    const result = await this.runProcess(binary, ["--help"], process.cwd());
    if (result.code !== 0) throw new Error(result.stderr.trim() || "无法读取 WorkBuddy 模型列表。");
    const { parseWorkBuddyModels } = await import("./modelCatalog.ts");
    return parseWorkBuddyModels(result.stdout);
  }

  async listClaudeModels(): Promise<Array<{ model: string; displayName: string }>> {
    const binary = await this.resolveExternalPath("claude");
    return new Promise((resolveModels, rejectModels) => {
      const child = spawn(binary, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--setting-sources", ""], { cwd: process.cwd(), env: externalAgentEnvironment(), shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      this.children.add(child); let lineBuffer = ""; let stderr = ""; let done = false; let closed = false; let forceKill = 0;
      const finish = (error?: unknown, models: Array<{ value: string; label: string }> = []) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        if (!closed && !child.killed) {
          child.kill("SIGTERM");
          forceKill = setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, WORKBUDDY_TERMINATE_GRACE_MS) as unknown as number;
        }
        if (error) rejectModels(error);
        else resolveModels(models.map(item => ({ model: item.value, displayName: item.label })));
      };
      const timeout = setTimeout(() => finish(new Error("Claude 模型目录初始化超时。")), 8_000);
      child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => {
        lineBuffer += String(chunk);
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const parsed = parseClaudeInitializeModels(line);
          if (parsed.kind === "models") return finish(undefined, parsed.models);
          if (parsed.kind === "error") return finish(new Error(parsed.message));
          if (parsed.kind === "malformed") return finish(new Error("Claude 模型目录初始化返回了无法识别的协议响应。"));
        }
      });
      child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => { stderr = `${stderr}${String(chunk)}`.slice(-4000); });
      child.stdin.on("error", error => finish(error));
      child.on("error", error => finish(error)); child.on("close", () => { closed = true; clearTimeout(forceKill); this.children.delete(child); if (!done) finish(new Error(stderr || "Claude 模型目录初始化失败。")); });
      child.stdin.end(`${JSON.stringify({ type: "control_request", request_id: "writex-models", request: { subtype: "initialize" } })}\n`);
    });
  }

  async workBuddyCliPath(): Promise<string> {
    return this.resolveExternalPath("workbuddy");
  }

  async installWorkBuddy(scriptPath: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("已取消 WorkBuddy 安装。");
    const controller = new AbortController();
    let timedOut = false;
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, WORKBUDDY_INSTALL_TIMEOUT_MS);
    try {
      const result = await this.runProcess("/bin/bash", [scriptPath], process.cwd(), controller.signal, { processGroup: true });
      if (result.code !== 0) throw new Error("WorkBuddy 官方安装未完成，请重试或使用官方安装说明。");
    } catch (error) {
      if (timedOut) throw new Error("等待 WorkBuddy 安装超时，请重试或使用官方安装说明。");
      if (signal?.aborted) throw new Error("已取消 WorkBuddy 安装。");
      throw error instanceof Error && error.message === "已停止本次 Agent 生成。"
        ? new Error("WorkBuddy 官方安装未完成，请重试或使用官方安装说明。")
        : error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  async connectWorkBuddy(input: {
    signal?: AbortSignal;
    onAuthorizationUrl: (url: string) => Promise<void> | void;
  }): Promise<WorkBuddyConnectionResult> {
    return this.runWorkBuddyConnection({ ...input, authorize: true });
  }

  stop(): void {
    for (const child of this.children) {
      const processGroup = this.processGroupChildren.has(child);
      this.terminateChild(child, processGroup, "SIGTERM");
      if (processGroup) setTimeout(() => this.terminateChild(child, true, "SIGKILL"), WORKBUDDY_TERMINATE_GRACE_MS);
    }
    this.codex.stop();
  }

  private async resolveExternalPath(agent: Exclude<ChatAgentId, "codex">): Promise<string> {
    const settings = this.settings();
    const configured = agent === "claude" ? settings.claudePath.trim() : settings.workbuddyPath.trim();
    if (configured) {
      try {
        await access(configured, constants.X_OK);
        return configured;
      } catch {
        throw new Error(`${AGENT_LABELS[agent]} CLI 路径不可执行：${configured}`);
      }
    }
    const candidates = EXTERNAL_CANDIDATES[agent];
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
    options?: { processGroup?: boolean },
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolveRun, reject) => {
      const child = spawn(binary, args, {
        cwd,
        env: externalAgentEnvironment(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: Boolean(options?.processGroup && process.platform !== "win32"),
      });
      this.children.add(child);
      if (options?.processGroup && process.platform !== "win32") this.processGroupChildren.add(child);
      let stdout = "";
      let stderr = "";
      let aborted = false;
      let forceKill = 0;
      let completed = false;
      const finish = (code: number | null): void => {
        if (completed) return;
        completed = true;
        signal?.removeEventListener("abort", abort);
        clearTimeout(forceKill);
        this.children.delete(child);
        this.processGroupChildren.delete(child);
        if (aborted) reject(new Error("已停止本次 Agent 生成。"));
        else resolveRun({ stdout, stderr, code: code ?? -1 });
      };
      const abort = (): void => {
        if (aborted) return;
        aborted = true;
        this.terminateChild(child, Boolean(options?.processGroup), "SIGTERM");
        forceKill = setTimeout(() => {
          this.terminateChild(child, Boolean(options?.processGroup), "SIGKILL");
          if (options?.processGroup) finish(child.exitCode);
        }, WORKBUDDY_TERMINATE_GRACE_MS) as unknown as number;
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { stdout = `${stdout}${String(chunk)}`.slice(-2_000_000); });
      child.stderr.on("data", chunk => { stderr = `${stderr}${String(chunk)}`.slice(-16000); });
      child.on("error", error => reject(error));
      child.on("close", code => {
        if (aborted && options?.processGroup) return;
        finish(code);
      });
    });
  }

  private terminateChild(child: ChildProcess, processGroup: boolean, signal: NodeJS.Signals): void {
    if (processGroup && child.pid && process.platform !== "win32") {
      try { process.kill(-child.pid, signal); return; }
      catch { /* The group may already have exited; fall through to the direct child. */ }
    }
    child.kill(signal);
  }

  private async runWorkBuddyConnection(input: {
    signal?: AbortSignal;
    authorize: boolean;
    onAuthorizationUrl?: (url: string) => Promise<void> | void;
  }): Promise<WorkBuddyConnectionResult> {
    if (input.signal?.aborted) throw new Error("已取消 WorkBuddy 连接。");
    const path = await this.resolveExternalPath("workbuddy");
    if (input.signal?.aborted) throw new Error("已取消 WorkBuddy 连接。");
    return withIsolatedWorkBuddyConnectionCwd(cwd => {
      if (input.signal?.aborted) return Promise.reject(new Error("已取消 WorkBuddy 连接。"));
      return new Promise<WorkBuddyConnectionResult>((resolveConnection, rejectConnection) => {
      const child = spawn(path, [
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--tools", "",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--setting-sources", "none",
      ], {
        cwd,
        env: externalAgentEnvironment(),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.children.add(child);
      let lineBuffer = "";
      let outputBytes = 0;
      let settled = false;
      let authenticateSent = false;
      let timeout = 0;
      const cleanup = (): void => {
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", abort);
        this.children.delete(child);
      };
      const settle = (result: WorkBuddyConnectionResult | Error): void => {
        if (settled) return;
        settled = true;
        const finish = (): void => {
          cleanup();
          if (result instanceof Error) rejectConnection(result);
          else resolveConnection(result);
        };
        if (child.exitCode !== null || child.signalCode !== null || !child.pid) return finish();
        const forceKill = setTimeout(() => {
          child.kill("SIGKILL");
        }, WORKBUDDY_TERMINATE_GRACE_MS);
        child.once("close", () => {
          clearTimeout(forceKill);
          finish();
        });
        if (!child.killed) child.kill("SIGTERM");
      };
      const abort = (): void => settle(new Error("已取消 WorkBuddy 连接。"));
      const armTimeout = (milliseconds: number, message: string): void => {
        if (settled) return;
        clearTimeout(timeout);
        timeout = setTimeout(() => settle(new Error(message)), milliseconds) as unknown as number;
      };
      const write = (message: Record<string, unknown>): void => {
        if (settled || !child.stdin.writable) return;
        child.stdin.write(`${JSON.stringify(message)}\n`);
      };
      const handle = async (event: WorkBuddyControlEvent): Promise<void> => {
        if (settled) return;
        if (event.kind === "initialize") {
          if (event.requestId !== "writex-initialize") return;
          if (event.hasUserId && event.hasToken) return settle({ status: "existing-account", path });
          if (!input.authorize) return settle({ status: "not-connected", path });
          authenticateSent = true;
          write({
            type: "control_request",
            request_id: "writex-authenticate",
            request: { subtype: "authenticate", methodId: "external", environment: "internal" },
          });
          return;
        }
        if (!authenticateSent) return;
        if (event.kind === "authorization-url") {
          try {
            await input.onAuthorizationUrl?.(event.url);
            if (settled || input.signal?.aborted) return;
            write(buildWorkBuddyControlResponse(event.requestId, "received"));
            armTimeout(WORKBUDDY_AUTHORIZATION_TIMEOUT_MS, "等待 WorkBuddy 授权超时，请重试。");
          } catch { settle(new Error("无法打开 WorkBuddy 官方授权页面，请重试。")); }
          return;
        }
        if (event.kind === "authorization-result") {
          write(buildWorkBuddyControlResponse(event.requestId, "handled"));
          settle({ status: "authorized", path });
          return;
        }
        if (event.kind === "invalid-authorization-url") return settle(new Error("WorkBuddy 返回了不受信任的授权地址，已拒绝打开。"));
        if (event.kind === "unknown-control" || event.kind === "failure") return settle(new Error("WorkBuddy 返回了无法识别的连接控制消息。"));
      };
      const consume = (): void => {
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const event = parseWorkBuddyControlEvent(line);
          if (event) void handle(event);
        }
      };
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) return abort();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        outputBytes += new TextEncoder().encode(String(chunk)).byteLength;
        if (outputBytes > WORKBUDDY_CONTROL_OUTPUT_LIMIT) return settle(new Error("WorkBuddy 连接输出超过安全上限。"));
        lineBuffer += String(chunk);
        consume();
      });
      child.stderr.on("data", () => { /* Connection diagnostics can contain account data; never retain or display them. */ });
      child.on("error", () => settle(new Error("WorkBuddy CLI 无法启动，请检查设置中的可执行文件路径。")));
      child.on("close", code => {
        if (!settled) settle(new Error(code === 0 ? "WorkBuddy 连接未完成，请重试。" : "WorkBuddy CLI 连接失败，请重试。"));
      });
      write({ type: "control_request", request_id: "writex-initialize", request: { subtype: "initialize" } });
      armTimeout(WORKBUDDY_INITIALIZE_TIMEOUT_MS, "等待 WorkBuddy 初始化超时，请重试。");
      });
    });
  }
}
