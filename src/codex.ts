import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { inspectImage, type SupportedImageMime } from "./images.ts";
import type { ChatAttachmentContext, CodexReasoningEffort, ImageSize } from "./types.ts";

export interface CodexTurnRequest {
  cwd: string;
  prompt: string;
  threadId?: string;
  model?: string;
  reasoningEffort?: Exclude<CodexReasoningEffort, "">;
  imagePaths?: string[];
  ephemeral?: boolean;
  allowWebSearch?: boolean;
  signal?: AbortSignal;
}

export interface CodexTurnResult {
  text: string;
  threadId?: string;
  warnings: string[];
  webSearchCount?: number;
}

export interface CodexImageRequest {
  cwd: string;
  prompt: string;
  outputDirectory: string;
  size?: ImageSize;
  model?: string;
  reasoningEffort?: Exclude<CodexReasoningEffort, "">;
  signal?: AbortSignal;
}

export interface CodexImageResult {
  filePath: string;
  mimeType: Exclude<SupportedImageMime, "image/gif">;
  text: string;
  warnings: string[];
}

export class CodexImageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexImageUnavailableError";
  }
}

export interface ParsedCodexEvent {
  text?: string;
  threadId?: string;
  warning?: string;
  completed?: boolean;
  webSearch?: boolean;
}

export function parseCodexJsonLine(line: string): ParsedCodexEvent {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      return { threadId: event.thread_id };
    }
    if (event.type === "turn.completed") return { completed: true };
    if (event.type === "item.completed" && event.item && typeof event.item === "object") {
      const item = event.item as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string") return { text: item.text };
      if (item.type === "web_search" && (item.action as Record<string, unknown> | undefined)?.type === "search") return { webSearch: true };
      if (item.type === "error" && typeof item.message === "string") return { warning: item.message };
    }
  } catch {
    // stderr and startup warnings are not JSONL events; the caller retains them for diagnostics.
  }
  return {};
}

export function buildWritingPrompt(input: {
  request: string;
  filePath: string;
  noteContent: string;
  selection?: string;
  maxContextChars: number;
  mode?: "chat" | "plan";
  skillInstruction?: string;
  styleInstruction?: string;
  feedbackInstruction?: string;
  attachments?: ChatAttachmentContext[];
  allowWebSearch?: boolean;
  relatedContext?: string;
  conversationContext?: string;
}): string {
  const context = allocateWritingContext({
    noteContent: input.noteContent,
    selection: input.selection,
    conversation: input.conversationContext,
    related: input.relatedContext,
    maxChars: input.maxContextChars,
  });
  const selection = context.selection
    ? `\n用户选中的原文：\n---\n${context.selection}\n---\n`
    : "";
  const modeInstruction = input.mode === "plan"
    ? "当前是 Plan 模式。不要直接给成稿或假装已经执行；请先给出目标、约束、分步方案，以及需要用户确认的关键选择。"
    : "需要改写时，直接给出可以放回正文的 Markdown；需要分析时，给出简洁、具体、可执行的判断。";
  const attachments = input.attachments?.length
    ? [
      "用户附上的上下文：只允许读取这个列表中的本地文件；不要访问未列出的 Vault 文件。",
      ...input.attachments.map(attachment => `- ${attachment.kind === "image" ? "图片" : "文件"}：${attachment.name}（${attachment.mimeType}，${attachment.byteLength} bytes）\n  ${attachment.absolutePath}`),
    ].join("\n")
    : "";
  const networkBoundary = input.allowWebSearch
    ? "必要时可使用原生联网检索。实际检索后给出支持结论的链接与日期；未检索就明确说明。不要上传或读取未明确提供的本地文件。"
    : "不要访问网络。";
  const toolBoundary = input.allowWebSearch
    ? "不要修改文件；除原生联网检索外，不要运行命令或调用其他工具。"
    : input.skillInstruction?.trim() && input.attachments?.length
    ? "只允许读取显式启用的 Skill 及下面明确附上的本地文件；不要修改文件，不要访问网络，不要运行其他命令。"
    : input.skillInstruction?.trim()
      ? "只允许读取显式启用的 Skill 及其任务所需引用；不要修改文件，不要访问网络，不要运行其他命令。"
      : input.attachments?.length
        ? "只允许读取下面明确附上的本地文件；不要修改文件，不要访问网络，不要运行其他命令。"
      : "不要修改文件，不要运行命令，不要调用工具。";
  return [
    "你是运行在 Obsidian 右侧的中文公众号写作助手。当前用户要求、事实材料和明确格式约束优先级最高。",
    `只完成用户提出的写作任务。${toolBoundary}${networkBoundary}`,
    modeInstruction,
    input.feedbackInstruction?.trim() || "",
    input.styleInstruction?.trim() || "",
    input.skillInstruction?.trim() || "",
    attachments,
    `当前笔记：${input.filePath}`,
    selection,
    "当前笔记内容：",
    "---",
    context.noteContent,
    "---",
    context.conversation ? `当前对话摘录：\n${context.conversation}` : "",
    context.related ? context.related : "",
    "用户要求：",
    input.request.trim(),
  ].filter(Boolean).join("\n");
}

export function allocateWritingContext(input: {
  noteContent: string;
  selection?: string;
  conversation?: string;
  related?: string;
  maxChars: number;
}): { noteContent: string; selection: string; conversation: string; related: string } {
  let remaining = Math.max(0, input.maxChars);
  const take = (value: string, suffix = ""): string => {
    const text = value.trim();
    if (!text || remaining <= 0) return "";
    if (text.length <= remaining) { remaining -= text.length; return text; }
    if (remaining <= suffix.length) {
      const valueWithinBudget = text.slice(0, remaining);
      remaining = 0;
      return valueWithinBudget;
    }
    const available = remaining - suffix.length;
    remaining = 0;
    return `${text.slice(0, available)}${suffix}`;
  };
  // The currently selected passage is strongest evidence, then the active note, visible history, and title-matched notes.
  const selection = take(input.selection ?? "", "\n[选段已截断]");
  const noteContent = take(input.noteContent, "\n[正文已截断]");
  const conversation = take(input.conversation ?? "", "\n[对话已截断]");
  const related = take(input.related ?? "", "\n[相关材料已截断]");
  return { noteContent, selection, conversation, related };
}

export function preserveSelectionWhitespace(original: string, replacement: string): string {
  const leading = original.match(/^\s*/)?.[0] ?? "";
  const trailing = original.match(/\s*$/)?.[0] ?? "";
  return `${leading}${replacement}${trailing}`;
}

const CODEX_CANDIDATES = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
];

const LEAN_FLAGS = [
  "--json",
  "--skip-git-repo-check",
  "--ignore-user-config",
  "--ignore-rules",
  "--disable", "plugins",
  "--disable", "memories",
  "--disable", "apps",
  "--disable", "browser_use",
  "--disable", "computer_use",
  "--disable", "skill_search",
];

export function buildCodexArgs(request: Pick<CodexTurnRequest, "cwd" | "threadId" | "model" | "reasoningEffort" | "ephemeral" | "imagePaths" | "allowWebSearch">): string[] {
  const model = request.model?.trim();
  const modelArgs = model ? ["--model", model] : [];
  const reasoningArgs = request.reasoningEffort
    ? ["-c", `model_reasoning_effort="${request.reasoningEffort}"`]
    : [];
  const imageArgs = request.imagePaths?.length ? ["--image", ...request.imagePaths] : [];
  const searchArgs = ["-c", request.allowWebSearch ? 'web_search="live"' : 'web_search="disabled"'];
  return request.threadId
    ? ["exec", "resume", ...LEAN_FLAGS, ...searchArgs, ...modelArgs, ...reasoningArgs, ...imageArgs, "-c", 'sandbox_mode="read-only"', request.threadId, "-"]
    : ["exec", ...LEAN_FLAGS, ...searchArgs, ...(request.ephemeral ? ["--ephemeral"] : []), ...modelArgs, ...reasoningArgs, ...imageArgs, "--sandbox", "read-only", "-C", request.cwd, "-"];
}

export function buildCodexNoToolArgs(request: Pick<CodexTurnRequest, "cwd" | "model" | "reasoningEffort">): string[] {
  const modelArgs = request.model?.trim() ? ["--model", request.model.trim()] : [];
  const reasoningArgs = request.reasoningEffort ? ["-c", `model_reasoning_effort="${request.reasoningEffort}"`] : [];
  return [
    "exec", ...LEAN_FLAGS,
    "--disable", "shell_tool",
    "--disable", "code_mode",
    "--disable", "code_mode_host",
    "--disable", "browser_use",
    "--disable", "browser_use_external",
    "--disable", "browser_use_full_cdp_access",
    "--disable", "computer_use",
    "--disable", "image_generation",
    "--disable", "in_app_browser",
    "--disable", "multi_agent",
    "--disable", "view_image",
    "--disable", "web_search_request",
    "--ephemeral",
    "--sandbox", "read-only",
    ...modelArgs,
    ...reasoningArgs,
    "-C", request.cwd,
    "-",
  ];
}

export function buildCodexImageArgs(
  request: Pick<CodexImageRequest, "cwd" | "outputDirectory" | "model" | "reasoningEffort">,
): string[] {
  const model = request.model?.trim();
  const modelArgs = model ? ["--model", model] : [];
  const reasoningArgs = request.reasoningEffort
    ? ["-c", `model_reasoning_effort="${request.reasoningEffort}"`]
    : [];
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-rules",
    ...modelArgs,
    ...reasoningArgs,
    "--sandbox",
    "workspace-write",
    "-C",
    request.outputDirectory,
    "-",
  ];
}

export function buildCodexImagePrompt(input: Pick<CodexImageRequest, "prompt" | "outputDirectory" | "size">): string {
  const sizeLabel: Record<ImageSize, string> = {
    "1536x1024": "横图 3:2",
    "1024x1024": "方图 1:1",
    "1024x1536": "竖图 2:3",
  };
  return [
    "请显式调用 $imagegen 完成下面的图片生成任务。",
    "只生成用户要求的图片，不要修改正文、笔记或其他任何文件。",
    `将最终选定的一张图片保存或复制到这个已经存在的输出目录：${input.outputDirectory}`,
    input.size ? `目标画布：${input.size.replace("x", " × ")}（${sizeLabel[input.size]}）。请严格按这个比例构图。` : "",
    "只允许向这个输出目录写入生成结果。最终回复简短说明即可，不要输出二进制或 base64。",
    "用户的图片要求：",
    "---",
    input.prompt.trim(),
    "---",
  ].filter(Boolean).join("\n");
}

export async function findGeneratedImageFile(
  outputDirectory: string,
): Promise<Pick<CodexImageResult, "filePath" | "mimeType"> | null> {
  const candidates: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile()) candidates.push(candidate);
    }
  };
  await visit(outputDirectory);
  for (const filePath of candidates) {
    const info = await stat(filePath);
    if (!info.size || info.size > 25 * 1024 * 1024) continue;
    const bytes = await readFile(filePath);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const inspection = inspectImage(buffer, { fileName: filePath });
    if (inspection.complete && (inspection.mimeType === "image/png" || inspection.mimeType === "image/jpeg" || inspection.mimeType === "image/webp")) {
      return { filePath, mimeType: inspection.mimeType };
    }
  }
  return null;
}

export class CodexRuntime {
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  private readonly configuredPath: () => string;

  constructor(configuredPath: () => string) {
    this.configuredPath = configuredPath;
  }

  async resolvePath(): Promise<string> {
    const configured = this.configuredPath().trim();
    if (configured) {
      await access(configured, constants.X_OK);
      return configured;
    }
    for (const candidate of CODEX_CANDIDATES) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Try the next known desktop installation path.
      }
    }
    return "codex";
  }

  async check(): Promise<string> {
    const binary = await this.resolvePath();
    return this.runProcess(binary, ["--version"], undefined, undefined).then(result => result.stdout.trim());
  }

  /** Reads the local Codex app-server catalog; it never starts a model turn. */
  async listModels(): Promise<Array<{ model: string; displayName: string; hidden: boolean }>> {
    const binary = await this.resolvePath();
    return new Promise((resolveList, rejectList) => {
      const child = spawn(binary, ["app-server", "--stdio"], { env: process.env, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      this.children.add(child);
      let buffer = "";
      let stderr = "";
      let stdoutBytes = 0;
      let initialized = false;
      let cursor: string | null = null;
      const collected: Array<{ model: string; displayName: string; hidden: boolean }> = [];
      let completed = false;
      let closed = false;
      const finish = (value?: Array<{ model: string; displayName: string; hidden: boolean }>, error?: unknown) => {
        if (completed) return;
        completed = true; clearTimeout(deadline); child.kill("SIGTERM");
        setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 500);
        if (error) rejectList(error); else resolveList(value ?? []);
      };
      const deadline = setTimeout(() => finish(undefined, new Error("Codex 模型目录读取超时。")), 12_000);
      const send = (id: number, method: string, params: Record<string, unknown>) => {
        try { child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); }
        catch (error) { finish(undefined, error); }
      };
      child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => { stderr = `${stderr}${String(chunk)}`.slice(-4000); });
      child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => {
        stdoutBytes += Buffer.byteLength(String(chunk));
        if (stdoutBytes > 1_000_000) return finish(undefined, new Error("Codex 模型目录输出超过安全上限。"));
        buffer += String(chunk);
        const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const response = JSON.parse(line) as { id?: number; result?: { data?: unknown[]; nextCursor?: unknown }; error?: { message?: string } };
            if (response.id === 1) { if (response.error) return finish(undefined, new Error(response.error.message || "Codex 初始化失败。")); initialized = true; try { child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`); } catch (error) { return finish(undefined, error); } send(2, "model/list", { limit: 100, includeHidden: false }); continue; }
            if (response.id !== 2 || !initialized) continue;
            if (response.error) return finish(undefined, new Error(response.error.message || "Codex 模型列表读取失败。"));
            if (!response.result || !Array.isArray(response.result.data) || !(response.result.nextCursor === null || typeof response.result.nextCursor === "string" || response.result.nextCursor === undefined)) return finish(undefined, new Error("Codex 返回了无效模型目录。"));
            collected.push(...response.result.data.flatMap(item => {
              if (!item || typeof item !== "object") return [];
              const value = item as Record<string, unknown>;
              return typeof value.model === "string" ? [{ model: value.model, displayName: typeof value.displayName === "string" ? value.displayName : value.model, hidden: value.hidden === true }] : [];
            }));
            cursor = typeof response.result.nextCursor === "string" ? response.result.nextCursor : null;
            if (cursor) { send(2, "model/list", { limit: 100, includeHidden: false, cursor }); continue; }
            return finish(collected);
          } catch { /* wait for a complete JSON response line */ }
        }
      });
      child.stdin.on("error", error => finish(undefined, error));
      child.on("error", error => finish(undefined, error));
      child.on("close", code => { closed = true; this.children.delete(child); if (!completed) finish(undefined, new Error(stderr || `Codex 模型列表退出：${code ?? -1}`)); });
      send(1, "initialize", { clientInfo: { name: "writex", title: "WriteX", version: "0.6.0" }, capabilities: null });
    });
  }

  async runTurn(request: CodexTurnRequest): Promise<CodexTurnResult> {
    const binary = await this.resolvePath();
    const args = buildCodexArgs(request);
    const result = await this.runProcess(binary, args, request.prompt, request.signal);
    let text = "";
    let threadId = request.threadId;
    const warnings: string[] = [];
    let webSearchCount = 0;
    for (const line of result.stdout.split("\n")) {
      const event = parseCodexJsonLine(line);
      if (event.text) text = event.text;
      if (event.threadId) threadId = event.threadId;
      if (event.warning) warnings.push(event.warning);
      if (event.webSearch) webSearchCount += 1;
    }
    if (!text.trim()) {
      const detail = warnings.at(-1) ?? result.stderr.trim() ?? `Codex exited with code ${result.code}.`;
      throw new Error(detail);
    }
    return { text: text.trim(), threadId, warnings, webSearchCount };
  }

  async runNoToolTurn(request: Omit<CodexTurnRequest, "threadId" | "imagePaths">): Promise<CodexTurnResult> {
    const binary = await this.resolvePath();
    const result = await this.runProcess(binary, buildCodexNoToolArgs(request), request.prompt, request.signal);
    let text = "";
    const warnings: string[] = [];
    for (const line of result.stdout.split("\n")) {
      const event = parseCodexJsonLine(line);
      if (event.text) text = event.text;
      if (event.warning) warnings.push(event.warning);
    }
    if (!text.trim()) throw new Error(warnings.at(-1) ?? result.stderr.trim() ?? `Codex exited with code ${result.code}.`);
    return { text: text.trim(), warnings };
  }

  async runImageTurn(request: CodexImageRequest): Promise<CodexImageResult> {
    const workspace = resolve(request.cwd);
    const outputDirectory = resolve(request.outputDirectory);
    const outputRelativePath = relative(workspace, outputDirectory);
    if (!outputRelativePath || outputRelativePath.startsWith("..") || isAbsolute(outputRelativePath)) {
      throw new Error("Codex 图片输出目录必须位于当前 Vault 内部。");
    }
    const binary = await this.resolvePath();
    const result = await this.runProcess(
      binary,
      buildCodexImageArgs(request),
      buildCodexImagePrompt({ ...request, outputDirectory }),
      request.signal,
    );
    let text = "";
    const warnings: string[] = [];
    for (const line of result.stdout.split("\n")) {
      const event = parseCodexJsonLine(line);
      if (event.text) text = event.text;
      if (event.warning) warnings.push(event.warning);
    }
    const image = await findGeneratedImageFile(outputDirectory);
    if (!image) {
      const detail = warnings.at(-1) ?? result.stderr.trim() ?? text.trim();
      throw new CodexImageUnavailableError(
        detail ? `当前 Codex 未返回可用图片：${detail}` : "当前 Codex 没有可用的生图能力。",
      );
    }
    return { ...image, text: text.trim(), warnings };
  }

  stop(): void {
    for (const child of this.children) child.kill("SIGTERM");
  }

  private runProcess(
    binary: string,
    args: string[],
    input?: string,
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, {
        env: process.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
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
      child.stdout.on("data", chunk => { stdout += String(chunk); });
      child.stderr.on("data", chunk => {
        stderr = `${stderr}${String(chunk)}`.slice(-16000);
      });
      child.on("error", error => reject(error));
      child.on("close", code => {
        signal?.removeEventListener("abort", abort);
        this.children.delete(child);
        if (aborted) {
          reject(new Error("已停止本次 Codex 生成。"));
          return;
        }
        resolve({ stdout, stderr, code: code ?? -1 });
      });
      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    });
  }
}
