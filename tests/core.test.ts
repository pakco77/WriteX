import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeClipboardText } from "../src/clipboard.ts";
import {
  archiveActiveConversation,
  getAgentSession,
  restoreArchivedConversation,
  setAgentSession,
} from "../src/conversations.ts";
import {
  AGENT_MODELS,
  buildExternalAgentArgs,
  buildExternalAgentNoToolArgs,
  buildWorkBuddyControlResponse,
  externalAgentEnvironment,
  parseWorkBuddyControlEvent,
  parseClaudeNoToolCapabilities,
  parseExternalAgentJson,
  parseWorkBuddyStreamJson,
  ChatAgentRuntime,
} from "../src/chatAgents.ts";
import {
  buildCodexArgs,
  buildCodexNoToolArgs,
  buildCodexImageArgs,
  buildCodexImagePrompt,
  buildWritingPrompt,
  allocateWritingContext,
  findGeneratedImageFile,
  parseCodexJsonLine,
  preserveSelectionWhitespace,
  CodexRuntime,
} from "../src/codex.ts";
import { detectImageMime } from "../src/images.ts";
import { buildFeedbackInstruction, recordChatFeedback } from "../src/feedback.ts";
import {
  canUseWriteCloudV01,
  chooseAutomaticImageProvider,
  imageProviderLabel,
  resolveGeneratedProvider,
} from "../src/imageRouting.ts";
import { canRegenerateImage, DEFAULT_SETTINGS, ensureOriginalAssetPairs, type ImageAsset } from "../src/types.ts";
import { buildStyleExtractionPrompt, buildStyleInstruction, renderStyleSkill, sha256Text, styleEnabled } from "../src/writingStyle.ts";
import { buildBoundedTextDiff } from "../src/selectionDiff.ts";
import { extractMarkdownImageSources, markdownToPlainText } from "../src/wechat.ts";
import {
  buildSkillInstallArgs,
  buildExplicitSkillInstruction,
  discoverLocalSkills,
  isSupportedSkillSource,
} from "../src/skills.ts";

test("assistant answers explicitly restore native text selection", async () => {
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const rule = styles.match(/\.oa-message-assistant\s+\.oa-message-body\s*\{[^}]*\}/s)?.[0] ?? "";
  assert.match(rule, /(?:-webkit-)?user-select:\s*text/);
  assert.match(rule, /cursor:\s*text/);
});

test("v0.4 creator loop keeps selection, keyboard, concurrent image, feedback, and local theme contracts", async () => {
  const [view, main, types, sync] = await Promise.all([
    readFile(new URL("../src/view.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/types.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/sync.ts", import.meta.url), "utf8"),
  ]);

  assert.match(main, /registerDomEvent\(document,\s*"mouseup"/);
  assert.match(view, /"对比替换"/);
  assert.match(view, /SelectionCompareModal/);
  assert.match(view, /event\.key === "Enter" && !event\.shiftKey && !event\.isComposing/);
  assert.match(types, /"manual" \| "original" \| "optimized"/);
  assert.match(main, /ensureOriginalAssetPairs/);
  assert.match(view, /"使用公众号优化版"/);
  assert.match(view, /"使用原图"/);
  assert.match(view, /确认前 WriteX 不会发送任何 Relay 请求/);
  assert.match(view, /if \(!identityConfirmed\)[\s\S]*return;[\s\S]*relay\.verify\(\)/);
  assert.match(view, /plan\.images\.map\(image => image\.source\)/);
  assert.match(view, /imageStageError\("优化 GIF", planned\.source, error\)/);
  assert.match(view, /imageStageError\("上传公众号图片", planned\.source, error\)/);
  assert.match(view, /const controller = new AbortController\(\)/);
  assert.match(view, /this\.copyProgress = "正在取消复制…"/);
  assert.doesNotMatch(view, /cancelCopyTask\(\): void \{\s*this\.copyController\?\.abort\(\);\s*this\.finishCopyTask/);
  assert.match(view, /result = await relay\.uploadAsset[\s\S]*?this\.assertCopyActive\(\)/);
  const copyImage = main.match(/async copyImage\([\s\S]*?async storeOptimizedGif/)?.[0] ?? "";
  assert.match(copyImage, /inspectImage\(bytes/);
  assert.match(copyImage, /if \(inspection\.animated\)/);
  assert.match(copyImage, /未转换为静态第一帧/);

  assert.match(view, /private imageRunning = false/);
  assert.match(view, /private imageController: AbortController \| null = null/);
  assert.match(view, /oa-image-progress/);
  assert.match(view, /imageStartedAt/);
  assert.match(view, /this\.running[\s\S]*this\.imageRunning/);

  assert.match(types, /feedback\?: "up" \| "down"/);
  assert.match(types, /feedbackMemory\?: ChatFeedbackMemoryEntry\[\]/);
  assert.match(view, /oa-message-feedback/);
  assert.match(view, /buildFeedbackInstruction/);

  assert.match(view, /themeService\.render\(/);
  assert.match(sync, /themeService\.render\(/);
  assert.doesNotMatch(`${view}\n${sync}`, /isSkillBackedTheme|layoutSkillNamesForTheme/);
});

test("topic mutations use the local persistence chain and note renames keep source links", async () => {
  const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(main, /findTopicByMessage\(messageId: string\)/);
  assert.match(main, /async saveTopicFromMessage\(notePath: string, messageId: string\)/);
  assert.match(main, /async saveManualTopic\(title: string, sourceNotePath\?: string\)/);
  assert.match(main, /async renameTopic\(topicId: string, title: string\)/);
  assert.doesNotMatch(main, /async setTopicStatus/);
  assert.match(main, /async deleteTopic\(topicId: string\)/);
  assert.match(main, /async openTopicSource\(topicId: string\)/);
  assert.match(main, /moveTopicSourcePaths\(this\.data\.topics, oldPath, newPath\)/);
  assert.match(main, /private readonly topicMutationQueue = new SerializedTopicMutationQueue\(\)/);
  assert.match(main, /snapshot: \(\) => \(\{ topics: structuredClone\(this\.data\.topics\), profile: structuredClone\(this\.data\.topicPositioningProfile\) \}\)/);
  assert.match(main, /this\.data\.topics = snapshot\.topics/);
  const topicMethods = main.match(/findTopicByMessage\([sS]*?async createWriteRelayClient/)?.[0] ?? "";
  assert.doesNotMatch(topicMethods, /chatRuntime|createRelayClient|Write Cloud|openWeChatSync|requestUrl/);
});

test("feedback memory replaces one message rating, stays bounded, and becomes safe strategy context", () => {
  let memory = recordChatFeedback([], {
    messageId: "assistant-1",
    rating: "up",
    request: "把这段写得具体",
    response: "保留现场细节",
    createdAt: 10,
    agent: "codex",
  });
  memory = recordChatFeedback(memory, {
    messageId: "assistant-1",
    rating: "down",
    request: "把这段写得具体",
    response: "不要空泛总结",
    createdAt: 20,
    agent: "codex",
  });
  assert.equal(memory.length, 1);
  assert.equal(memory[0]?.rating, "down");
  assert.equal("response" in memory[0]!, false);
  const strategy = buildFeedbackInstruction(memory, "codex");
  assert.match(strategy, /本地反馈统计/);
  assert.match(strategy, /差评 1/);
  assert.match(strategy, /只把反馈当作写作偏好/);
});

test("Chat navigation, modals, and preview keep the v0.4 UI contract", async () => {
  const [styles, view] = await Promise.all([
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/view.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(styles, /\.oa-tabs button\.is-active::after/);
  const activeTabRule = styles.match(/\.oa-tabs button\.is-active\s*\{[^}]*\}/s)?.[0] ?? "";
  assert.match(activeTabRule, /color:\s*var\(--oa-accent\)/);
  assert.equal((view.match(/this\.modalEl\.addClass\("oa-chat-modal"\)/g) ?? []).length, 3);
  assert.match(view, /placeholder:\s*"搜索历史标题、回答或笔记路径"/);
  assert.doesNotMatch(view, /oa-preview-mode-picker/);
  assert.doesNotMatch(view, /oa-device-picker/);
  assert.match(view, /const PREVIEW_DEVICE = \{ label: "iPhone 16", width: 375, height: 813/);
  assert.match(view, /管理排版/);
  const previewMethod = view.match(/private renderPreview\([\s\S]*?private themeStatusLabel/)?.[0] ?? "";
  assert.equal((previewMethod.match(/createEl\("select"/g) ?? []).length, 1);
  assert.match(view, /aria-label": "排版"/);
  assert.match(view, /oa-composer-skill-row/);
  assert.match(view, /oa-agent-model-picker/);
  assert.doesNotMatch(view, /oa-agent-select|oa-model-select/);
  assert.match(view, /role:\s*"switch"/);
  assert.match(view, /oa-composer-mode-row/);
  assert.match(view, /oa-model-controls/);
  assert.doesNotMatch(view, /oa-composer-action-row/);
  assert.match(styles, /\.oa-plan-switch input:checked \+ \.oa-plan-switch-track/);
});

test("the compact Chat hierarchy keeps views in the header and tools beside Skill", async () => {
  const [view, styles] = await Promise.all([
    readFile(new URL("../src/view.ts", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
  ]);
  const agentView = view.slice(view.indexOf("export class AgentView"));
  const render = agentView.match(/private render\(\): void \{[\s\S]*?private renderHeader/)?.[0] ?? "";
  assert.doesNotMatch(render, /this\.renderTabs\(container\)/);
  const header = agentView.match(/private renderHeader\([\s\S]*?private renderTabs/)?.[0] ?? "";
  assert.match(header, /this\.renderTabs\(header\)/);
  assert.ok(header.indexOf("oa-brand") < header.indexOf("this.renderTabs(header)"));
  assert.ok(header.indexOf("this.renderTabs(header)") < header.indexOf("oa-header-actions"));
  assert.match(styles, /\.oa-tabs\s*\{[\s\S]*?border-radius:\s*999px/);

  const chat = agentView.match(/private renderChat\([\s\S]*?private renderPendingImageRequest/)?.[0] ?? "";
  const skillRow = chat.match(/const skillRow = form\.createDiv\([\s\S]*?if \(!this\.imageMode\)/)?.[0] ?? "";
  assert.match(skillRow, /oa-skill-row-tools/);
  assert.match(skillRow, /Chat 历史/);
  assert.match(skillRow, /选题库/);
  assert.match(skillRow, /新对话/);
  assert.doesNotMatch(chat, /const utilities = actionRow\.createDiv/);
  assert.doesNotMatch(chat, /oa-image-action/);
  assert.doesNotMatch(chat, /· 已加载/);
  const skillPicker = styles.match(/\.oa-composer-skill-row button\.oa-composer-skill-picker\s*\{[^}]*\}/s)?.[0] ?? "";
  assert.match(skillPicker, /max-width:\s*45%/);

  const shortcuts = chat.match(/const shortcuts = form\.createDiv\([\s\S]*?if \(this\.imageMode\)/)?.[0] ?? "";
  assert.ok(shortcuts.indexOf('text: "找切口"') < shortcuts.indexOf('text: "生成图片"'));
  assert.match(shortcuts, /setIcon\(imageIcon, "image"\)/);
  assert.match(shortcuts, /this\.imageMode = true/);

  const modelPicker = styles.match(/\.oa-composer-mode-row button\.oa-agent-model-picker\s*\{[^}]*\}/s)?.[0] ?? "";
  assert.match(modelPicker, /flex:\s*0 1 104px/);
  assert.match(modelPicker, /max-width:\s*104px/);
  assert.match(chat, /if \(currentAgent === "codex"\)/);
  assert.match(chat, /oa-reasoning-picker/);
  assert.match(chat, /codexReasoningEffort/);
  assert.match(chat, /createSpan\(\{ text: "计划模式" \}\)/);
  assert.doesNotMatch(chat, /createSpan\(\{ text: "计划" \}\)/);
  const controls = chat.match(/const modeRow = form\.createDiv\([\s\S]*?form\.onsubmit/)?.[0] ?? "";
  assert.match(controls, /oa-model-controls/);
  assert.match(controls, /const send = modeRow\.createEl/);
  assert.doesNotMatch(chat, /oa-composer-action-row/);
  assert.match(styles, /\.oa-composer-mode-row button\.oa-send[\s\S]*?margin-left:\s*auto/);
});

test("Chat uploads stay local, show removable context chips, and keep image input explicit", async () => {
  const [view, main, styles] = await Promise.all([
    readFile(new URL("../src/view.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(view, /"添加图片或附件"/);
  assert.match(view, /textarea\.onpaste[\s\S]*clipboardData\?\.files/);
  assert.match(view, /form\.ondrop[\s\S]*dataTransfer\?\.files/);
  assert.match(view, /renderComposerAttachments/);
  assert.match(view, /renderMessageAttachments/);
  assert.match(view, /request \|\| "请阅读我附上的文件/);
  assert.match(view, /imagePaths: attachments\.filter/);
  assert.match(main, /attachments\/agent\/\$\{noteName\}\/chat\/\$\{messageId\}/);
  assert.match(main, /stageChatAttachments/);
  assert.match(main, /vault\.createBinary/);
  assert.match(styles, /\.oa-composer\.is-dragging-attachments/);
  assert.match(styles, /\.oa-message-attachment\.is-image img/);
});

test("assistant copy uses the desktop clipboard and reports a real write", async () => {
  const writes: string[] = [];
  await writeClipboardText("可复制的回答", {
    electronWriteText: value => { writes.push(`electron:${value}`); },
    browserWriteText: async value => { writes.push(`browser:${value}`); },
  });
  assert.deepEqual(writes, ["electron:可复制的回答"]);

  await writeClipboardText("浏览器后备", {
    electronWriteText: () => { throw new Error("Electron unavailable"); },
    browserWriteText: async value => { writes.push(`fallback:${value}`); },
  });
  assert.equal(writes.at(-1), "fallback:浏览器后备");
});

test("new conversation archives messages instead of deleting them", () => {
  const state = {
    messages: [
      { id: "m1", role: "user" as const, kind: "text" as const, content: "第一轮", createdAt: 10 },
      { id: "m2", role: "assistant" as const, kind: "text" as const, content: "回答", createdAt: 20 },
    ],
    assets: [],
    codexThreadId: "thread-1",
  };
  assert.equal(archiveActiveConversation(state, () => "conversation-1"), true);
  assert.equal(state.messages.length, 0);
  assert.equal(state.codexThreadId, undefined);
  assert.equal(state.archivedConversations?.[0]?.title, "第一轮");
  assert.equal(state.archivedConversations?.[0]?.codexThreadId, "thread-1");
  assert.equal(archiveActiveConversation(state, () => "unused"), false);
});

test("opening an archived conversation preserves the current active conversation", () => {
  const state = {
    messages: [
      { id: "active", role: "user" as const, kind: "text" as const, content: "当前对话", createdAt: 30 },
    ],
    assets: [],
    codexThreadId: "thread-active",
    archivedConversations: [{
      id: "old",
      title: "旧对话",
      createdAt: 10,
      updatedAt: 20,
      messages: [{ id: "old-message", role: "user" as const, kind: "text" as const, content: "旧内容", createdAt: 10 }],
      codexThreadId: "thread-old",
    }],
  };
  assert.equal(restoreArchivedConversation(state, "old", () => "active-archive"), true);
  assert.equal(state.messages[0]?.content, "旧内容");
  assert.equal(state.codexThreadId, "thread-old");
  assert.equal(state.archivedConversations?.[0]?.title, "当前对话");
});

test("legacy Codex thread migrates into per-Agent sessions and archives without loss", () => {
  const state = {
    messages: [{ id: "m1", role: "user" as const, kind: "text" as const, content: "继续", createdAt: 10 }],
    assets: [],
    codexThreadId: "legacy-codex-thread",
  };
  assert.equal(getAgentSession(state, "codex"), "legacy-codex-thread");
  setAgentSession(state, "claude", "claude-session");
  setAgentSession(state, "workbuddy", "workbuddy-session");
  assert.equal(archiveActiveConversation(state, () => "archive"), true);
  assert.deepEqual(state.archivedConversations?.[0]?.agentSessions, {
    codex: "legacy-codex-thread",
    claude: "claude-session",
    workbuddy: "workbuddy-session",
  });
  assert.equal(getAgentSession(state, "codex"), undefined);
  assert.equal(getAgentSession(state, "claude"), undefined);
});

test("Vault skills are discovered and explicit skill use is visible in the prompt", async t => {
  const root = await mkdtemp(join(tmpdir(), "write-skill-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skillDirectory = join(root, "projects", "writing", ".agents", "skills", "human-writing");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(skillDirectory, "SKILL.md"), [
    "---",
    "name: human-writing",
    "description: 写出有活人感的中文。",
    "---",
    "# 活人感写作",
  ].join("\n"));
  const claudeSkillDirectory = join(root, "projects", "writing", ".claude", "skills", "multi-line");
  await mkdir(claudeSkillDirectory, { recursive: true });
  await writeFile(join(claudeSkillDirectory, "SKILL.md"), [
    "---",
    "name: multi-line",
    "description: >",
    "  第一行说明。",
    "  第二行说明。",
    "---",
  ].join("\n"));
  const skills = await discoverLocalSkills(root, "projects/writing/article.md");
  assert.equal(skills.length, 2);
  const humanWriting = skills.find(skill => skill.name === "human-writing");
  const multiLine = skills.find(skill => skill.name === "multi-line");
  assert.match(humanWriting?.rootLabel ?? "", /项目/);
  assert.equal(multiLine?.description, "第一行说明。 第二行说明。");
  assert.match(buildExplicitSkillInstruction(humanWriting!), /先完整读取/);
  assert.match(buildExplicitSkillInstruction(humanWriting!), /human-writing/);
  assert.match(buildExplicitSkillInstruction(humanWriting!), /# 活人感写作/);
  assert.match(humanWriting?.sourceHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(isSupportedSkillSource("https://github.com/isjiamu/gzh-design-skill"), true);
  assert.equal(isSupportedSkillSource("git@github.com:isjiamu/gzh-design-skill.git"), false);
  assert.equal(isSupportedSkillSource("https://example.com/not-allowed"), false);
  assert.deepEqual(buildSkillInstallArgs("https://github.com/isjiamu/gzh-design-skill"), [
    "skills@latest",
    "add",
    "https://github.com/isjiamu/gzh-design-skill",
    "--agent",
    "universal",
    "--yes",
    "--copy",
  ]);
});

test("external Agent adapters use distinct real CLIs, models, sessions, and read-only tools", () => {
  const claude = buildExternalAgentArgs("claude", {
    prompt: "改写",
    model: "sonnet",
    sessionId: "claude-session",
  });
  assert.deepEqual(claude.slice(0, 3), ["-p", "--output-format", "json"]);
  assert.equal(claude[claude.indexOf("--model") + 1], "sonnet");
  assert.equal(claude[claude.indexOf("--resume") + 1], "claude-session");
  assert.equal(claude.includes("Read"), true);
  assert.equal(claude.includes("Edit"), true);
  assert.equal(claude.at(-1), "改写");

  const workbuddy = buildExternalAgentArgs("workbuddy", {
    prompt: "梳理大纲",
    model: "default",
    sessionId: "workbuddy-session",
  });
  assert.deepEqual(workbuddy.slice(0, 5), ["-p", "--output-format", "stream-json", "--verbose", "--allowedTools"]);
  assert.equal(workbuddy.includes("--model"), false);
  assert.equal(workbuddy[workbuddy.indexOf("--resume") + 1], "workbuddy-session");
  assert.equal(workbuddy.at(-1), "梳理大纲");
  assert.deepEqual(AGENT_MODELS.codex.map(option => option.value), ["", "gpt-5.6-sol", "gpt-5.6-terra"]);
  assert.deepEqual(AGENT_MODELS.claude.map(option => option.value), ["", "sonnet", "opus"]);
  assert.deepEqual(AGENT_MODELS.workbuddy.map(option => option.value), [""]);
});

test("external Agent launch preserves GUI PATH first and adds only Node fallbacks", () => {
  const env = externalAgentEnvironment({ PATH: "/custom/bin:/usr/bin", KEEP: "value" });
  assert.equal(env.KEEP, "value");
  assert.equal(env.PATH?.split(":").slice(0, 2).join(":"), "/custom/bin:/usr/bin");
  assert.equal(env.PATH?.split(":").includes("/usr/local/bin"), true);
  assert.equal(env.PATH?.split(":").includes("/opt/homebrew/bin"), true);
});

test("WorkBuddy control events project account state, validate official authorization URLs, and never retain payloads", () => {
  assert.deepEqual(parseWorkBuddyControlEvent(JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: "init", response: { account: { userId: "u", token: "secret" } } },
  })), { kind: "initialize", requestId: "init", hasUserId: true, hasToken: true });
  assert.deepEqual(parseWorkBuddyControlEvent(JSON.stringify({
    type: "control_request",
    request_id: "url",
    request: { subtype: "auth_url_callback", authState: { authUrl: "https://login.codebuddy.cn/authorize?token=secret" } },
  })), { kind: "authorization-url", requestId: "url", url: "https://login.codebuddy.cn/authorize?token=secret" });
  assert.deepEqual(parseWorkBuddyControlEvent(JSON.stringify({
    type: "control_request",
    request_id: "bad-url",
    request: { subtype: "auth_url_callback", authState: { authUrl: "http://evil.example/authorize" } },
  })), { kind: "invalid-authorization-url", requestId: "bad-url" });
  // Official @tencent-ai/agent-sdk auth.js destructures success/userinfo/error from request.request directly.
  assert.deepEqual(parseWorkBuddyControlEvent(JSON.stringify({
    type: "control_request",
    request_id: "auth_result_1",
    request: { subtype: "auth_result_callback", success: true, userinfo: { userId: "synthetic-user", userName: "test", userNickname: "test", token: "synthetic-token" } },
  })), { kind: "authorization-result", requestId: "auth_result_1" });
  assert.deepEqual(parseWorkBuddyControlEvent(JSON.stringify({
    type: "control_request",
    request_id: "failed-result",
    request: { subtype: "auth_result_callback", success: false, error: { type: "auth_failed", message: "synthetic failure" } },
  })), { kind: "failure" });
  assert.deepEqual(parseWorkBuddyControlEvent(JSON.stringify({
    type: "control_response",
    response: { subtype: "error", request_id: "init", response: {} },
  })), { kind: "failure" });
  assert.deepEqual(buildWorkBuddyControlResponse("url", "received"), {
    type: "control_response",
    response: { subtype: "success", request_id: "url", response: { received: true } },
  });
  assert.deepEqual(buildWorkBuddyControlResponse("result", "handled"), {
    type: "control_response",
    response: { subtype: "success", request_id: "result", response: { handled: true } },
  });
});

async function withFakeWorkBuddy<T>(mode: "existing" | "authorize" | "idle" | "mismatch", run: (runtime: ChatAgentRuntime, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "writex-workbuddy-fake-"));
  const binary = join(root, `${mode}-codebuddy`);
  const marker = join(root, "spawned");
  const script = `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(marker)}, "1");
let pending = "";
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
const request = value => value && value.type === "control_request" ? value.request : null;
process.stdin.on("data", chunk => {
  pending += chunk;
  const lines = pending.split(/\\r?\\n/); pending = lines.pop() || "";
  for (const line of lines) {
    if (!line) continue;
    const value = JSON.parse(line); const body = request(value);
    if (body?.subtype === "initialize") {
      if ("${mode}" === "existing") {
        const output = JSON.stringify({type:"control_response",response:{subtype:"success",request_id:"writex-initialize",response:{account:{userId:"u",token:"secret"}}}}) + "\\n";
        process.stdout.write(output.slice(0, 13)); setTimeout(() => process.stdout.write(output.slice(13)), 3);
      } else if ("${mode}" === "mismatch") { send({type:"control_response",response:{subtype:"success",request_id:"different",response:{account:{userId:"u",token:"secret"}}}}); setTimeout(() => process.exit(0), 3); }
      else if ("${mode}" === "authorize") send({type:"control_response",response:{subtype:"success",request_id:"writex-initialize",response:{}}});
      continue;
    }
    if (body?.subtype === "authenticate") {
      if (body.methodId !== "external" || body.environment !== "internal") process.exit(3);
      send({type:"control_request",request_id:"url",request:{subtype:"auth_url_callback",authState:{authUrl:"https://login.codebuddy.cn/authorize?token=secret"}}});
      continue;
    }
    if (value.type === "control_response" && value.response?.request_id === "url") {
      send({type:"control_request",request_id:"result",request:{subtype:"auth_result_callback",success:true,userinfo:{userId:"synthetic-user",userName:"test",userNickname:"test",token:"synthetic-token"}}});
    }
  }
});`;
  await writeFile(binary, script, "utf8");
  await chmod(binary, 0o700);
  const runtime = new ChatAgentRuntime(new CodexRuntime(() => ""), () => ({ ...DEFAULT_SETTINGS, workbuddyPath: binary }));
  try { return await run(runtime, root); }
  finally { runtime.stop(); await rm(root, { recursive: true, force: true }); }
}

test("WorkBuddy connection uses a real isolated stream process for an existing account", async () => {
  await withFakeWorkBuddy("existing", async runtime => {
    const result = await runtime.connectWorkBuddy({ onAuthorizationUrl: () => assert.fail("existing account must not authorize") });
    assert.equal(result.status, "existing-account");
  });
});

test("WorkBuddy connection completes the official callback handshake without retaining the URL", async () => {
  await withFakeWorkBuddy("authorize", async runtime => {
    let opened = false;
    const result = await runtime.connectWorkBuddy({ onAuthorizationUrl: url => {
      opened = new URL(url).hostname === "login.codebuddy.cn";
    } });
    assert.equal(result.status, "authorized");
    assert.equal(opened, true);
  });
});

test("WorkBuddy connection cancellation kills an idle control process and rejects mismatched initialization", async () => {
  await withFakeWorkBuddy("idle", async runtime => {
    const controller = new AbortController();
    const pending = runtime.connectWorkBuddy({ signal: controller.signal, onAuthorizationUrl: () => assert.fail("idle process must not authorize") });
    setTimeout(() => controller.abort(), 15);
    await assert.rejects(pending, /已取消 WorkBuddy 连接/);
  });
  await withFakeWorkBuddy("mismatch", async runtime => {
    await assert.rejects(runtime.connectWorkBuddy({ onAuthorizationUrl: () => assert.fail("mismatched response must not authorize") }), /连接未完成/);
  });
});

test("WorkBuddy aborts before a delayed resolver can spawn a control process", async () => {
  await withFakeWorkBuddy("existing", async (runtime, root) => {
    const path = await runtime.workBuddyCliPath();
    let releaseResolver: (() => void) | undefined;
    const resolver = new Promise<void>(resolve => { releaseResolver = resolve; });
    let resolverStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { resolverStarted = resolve; });
    const privateRuntime = runtime as unknown as { resolveExternalPath(agent: "workbuddy"): Promise<string> };
    privateRuntime.resolveExternalPath = async () => {
      resolverStarted?.();
      await resolver;
      return path;
    };
    const controller = new AbortController();
    const pending = runtime.connectWorkBuddy({ signal: controller.signal, onAuthorizationUrl: () => assert.fail("aborted resolver must not authorize") });
    await started;
    controller.abort();
    releaseResolver?.();
    await assert.rejects(pending, /已取消 WorkBuddy 连接/);
    await assert.rejects(access(join(root, "spawned")));
  });
});

test("WorkBuddy cancellation during a delayed authorization opener does not arm an authorization timeout", async () => {
  await withFakeWorkBuddy("authorize", async runtime => {
    let releaseOpener: (() => void) | undefined;
    const opener = new Promise<void>(resolve => { releaseOpener = resolve; });
    let openerStarted: (() => void) | undefined;
    const opened = new Promise<void>(resolve => { openerStarted = resolve; });
    const timerHost = globalThis as unknown as { setTimeout: typeof setTimeout };
    const originalSetTimeout = timerHost.setTimeout;
    let authorizationTimeouts = 0;
    timerHost.setTimeout = ((callback: () => void, milliseconds?: number) => {
      if (milliseconds === 300_000) authorizationTimeouts += 1;
      return originalSetTimeout(callback, milliseconds);
    }) as typeof setTimeout;
    try {
      const controller = new AbortController();
      const pending = runtime.connectWorkBuddy({
        signal: controller.signal,
        onAuthorizationUrl: async () => { openerStarted?.(); await opener; },
      });
      await opened;
      controller.abort();
      releaseOpener?.();
      await assert.rejects(pending, /已取消 WorkBuddy 连接/);
      assert.equal(authorizationTimeouts, 0);
    } finally {
      timerHost.setTimeout = originalSetTimeout;
    }
  });
});

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await access(path); return; }
    catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

test("WorkBuddy installer cancellation kills an ignored-TERM child process group before returning", async () => {
  const root = await mkdtemp(join(tmpdir(), "writex-workbuddy-installer-test-"));
  const script = join(root, "install.sh");
  const pidFile = join(root, "child.pid");
  const childSource = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)';
  await writeFile(script, `node -e '${childSource}' &\nchild=$!\nprintf '%s' "$child" > ${JSON.stringify(pidFile)}\nwait "$child"\n`, "utf8");
  await chmod(script, 0o700);
  const runtime = new ChatAgentRuntime(new CodexRuntime(() => ""), () => ({ ...DEFAULT_SETTINGS }));
  try {
    const controller = new AbortController();
    const pending = runtime.installWorkBuddy(script, controller.signal);
    await waitForFile(pidFile);
    const childPid = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
    assert.equal(processExists(childPid), true);
    const started = Date.now();
    controller.abort();
    await assert.rejects(pending, /已取消 WorkBuddy 安装/);
    assert.ok(Date.now() - started >= 1_200, "cancellation must wait through the process-group grace period");
    assert.equal(processExists(childPid), false);
  } finally {
    runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("writing-style extraction uses a dedicated no-tool one-shot path for all Agents", () => {
  const codex = buildCodexNoToolArgs({ cwd: "/tmp/writex-style-isolated", model: "gpt-5.6-sol" });
  for (const feature of ["shell_tool", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use", "image_generation", "in_app_browser", "multi_agent", "view_image", "web_search_request"]) {
    assert.equal(codex.includes(feature), true, `${feature} must be disabled for style extraction`);
  }
  assert.equal(codex.includes("--ephemeral"), true);
  assert.equal(codex[codex.indexOf("--sandbox") + 1], "read-only");
  assert.equal(codex[codex.indexOf("-C") + 1], "/tmp/writex-style-isolated");
  const workbuddy = buildExternalAgentNoToolArgs("workbuddy", { prompt: "只总结已嵌入的文字", model: "default" });
  assert.deepEqual(workbuddy.slice(0, 9), ["-p", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--setting-sources"]);
  assert.equal(workbuddy[workbuddy.indexOf("--setting-sources") + 1], "");
  assert.equal(workbuddy.includes("Read"), false);
  const supportedClaude = parseClaudeNoToolCapabilities({ code: 0, stdout: "--tools <value>\n--strict-mcp-config\n--no-session-persistence\n--setting-sources <sources>" });
  assert.equal(supportedClaude.supported, true);
  assert.equal(buildExternalAgentNoToolArgs("claude", { prompt: "只总结已嵌入的文字", model: "default" }, supportedClaude).includes("--tools"), true);
  assert.deepEqual(parseClaudeNoToolCapabilities({ code: 0, stdout: "--tools <value>\n--strict-mcp-config" }).missing, ["--no-session-persistence", "--setting-sources"]);
  assert.equal(parseClaudeNoToolCapabilities({ code: 126, stdout: "", stderr: "permission denied" }).supported, false);
  assert.throws(() => buildExternalAgentNoToolArgs("claude", { prompt: "只总结已嵌入的文字", model: "default" }), /无法确认 Claude CLI 的无工具能力/);
});

test("Claude-like JSON output keeps the real session and rejects empty responses", () => {
  assert.deepEqual(parseExternalAgentJson(JSON.stringify({ result: "改写结果", session_id: "session-1" })), {
    text: "改写结果",
    sessionId: "session-1",
    threadId: "session-1",
    warnings: [],
  });
  assert.deepEqual(parseExternalAgentJson(JSON.stringify([
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "过程消息" }] },
    { type: "result", subtype: "success", is_error: false, result: "WorkBuddy 结果", session_id: "workbuddy-session" },
  ])), {
    text: "WorkBuddy 结果",
    sessionId: "workbuddy-session",
    threadId: "workbuddy-session",
    warnings: [],
  });
  assert.deepEqual(parseExternalAgentJson(JSON.stringify([
    { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "事件结果" }] },
    { type: "result", subtype: "success", is_error: false, session_id: "workbuddy-event-session" },
  ])), {
    text: "事件结果",
    sessionId: "workbuddy-event-session",
    threadId: "workbuddy-event-session",
    warnings: [],
  });
  assert.equal(parseExternalAgentJson(JSON.stringify([
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "无状态事件结果" }] },
    { type: "result", subtype: "success", is_error: false, result: "", session_id: "workbuddy-statusless-session" },
  ])).text, "无状态事件结果");
  assert.equal(parseExternalAgentJson(JSON.stringify({
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "单消息结果" }],
    session_id: "workbuddy-single-message-session",
  })).text, "单消息结果");
  assert.throws(
    () => parseExternalAgentJson(JSON.stringify({
      type: "result",
      result: { secret: "不得进入诊断" },
      session_id: "session-1",
    })),
    error => error instanceof Error
      && /没有返回文本/.test(error.message)
      && /root=object/.test(error.message)
      && /result:object/.test(error.message)
      && !error.message.includes("不得进入诊断"),
  );
});

async function withFakeWorkBuddyTurn<T>(run: (runtime: ChatAgentRuntime, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "writex-workbuddy-turn-"));
  const binary = join(root, "codebuddy");
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args.at(-1) || "";
const format = args[args.indexOf("--output-format") + 1];
const stream = format === "stream-json" && args.includes("--verbose");
if (!stream) {
  // Mirrors CodeBuddy's long JSON response failure: a valid response is cut at 64 KiB.
  const whole = JSON.stringify({ type: "result", result: "x".repeat(70000), session_id: "cut-session" });
  process.stdout.write(whole.slice(0, 65536));
  process.exit(0);
}
if (prompt.includes("失败事件")) {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "synthetic WorkBuddy failure", session_id: "failed-session" }) + "\\n");
  process.exit(0);
}
const events = [
  { type: "system", subtype: "init", session_id: "stream-session", tools: ["Read"] },
  { type: "file-history-snapshot", session_id: "stream-session", snapshot: {} },
  { type: "assistant", session_id: "stream-session", message: { role: "assistant", content: [{ type: "thinking", thinking: "分析" }, { type: "text", text: "流式长请求结果" }] } },
  { type: "result", subtype: "success", is_error: false, result: "流式长请求结果", session_id: "stream-session" },
];
const output = (prompt.includes("坏事件") ? "not-json-event\\n" : "") + events.map(JSON.stringify).join("\\n") + "\\n";
// Exercise process-output chunk boundaries; the runtime must reconstruct complete NDJSON lines.
process.stdout.write(output.slice(0, 37));
setTimeout(() => process.stdout.write(output.slice(37, 211)), 2);
setTimeout(() => { process.stdout.write(output.slice(211)); process.exit(0); }, 4);`;
  await writeFile(binary, script, "utf8");
  await chmod(binary, 0o700);
  const runtime = new ChatAgentRuntime(new CodexRuntime(() => ""), () => ({ ...DEFAULT_SETTINGS, workbuddyPath: binary }));
  try { return await run(runtime, root); }
  finally { runtime.stop(); await rm(root, { recursive: true, force: true }); }
}

test("WorkBuddy normal turns survive a 64 KiB JSON-mode cutover by consuming its real stream-json result", async () => {
  await withFakeWorkBuddyTurn(async (runtime, root) => {
    const result = await runtime.runTurn({
      agent: "workbuddy",
      cwd: root,
      prompt: "把这段长上下文整理为可执行提纲",
    });
    assert.deepEqual(result, {
      text: "流式长请求结果",
      sessionId: "stream-session",
      threadId: "stream-session",
      warnings: [],
    });
  });
});

test("WorkBuddy one-shot ignores one malformed stream event when a final result follows", async () => {
  await withFakeWorkBuddyTurn(async (runtime, root) => {
    const result = await runtime.runOneShot({
      agent: "workbuddy",
      cwd: root,
      prompt: "坏事件后仍应返回答案",
    });
    assert.equal(result.text, "流式长请求结果");
    assert.equal(result.threadId, "stream-session");
  });
});

test("WorkBuddy stream parser uses the final result, retains the session, rejects error results, and accepts legacy JSON", () => {
  assert.deepEqual(parseWorkBuddyStreamJson([
    JSON.stringify({ type: "system", subtype: "init", session_id: "stream-session" }),
    JSON.stringify({ type: "assistant", session_id: "stream-session", message: { role: "assistant", content: [{ type: "text", text: "过程文本" }] } }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "最终文本", session_id: "stream-session" }),
  ].join("\n")), {
    text: "最终文本",
    sessionId: "stream-session",
    threadId: "stream-session",
    warnings: [],
  });
  assert.throws(
    () => parseWorkBuddyStreamJson(JSON.stringify({ type: "result", is_error: true, result: "可显示的失败原因", session_id: "failed-session" })),
    /可显示的失败原因/,
  );
  assert.equal(parseWorkBuddyStreamJson(JSON.stringify([
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "旧格式" }] },
    { type: "result", is_error: false, result: "", session_id: "legacy-session" },
  ])).text, "旧格式");
});

test("Codex JSONL parser returns thread and final assistant message", () => {
  assert.deepEqual(
    parseCodexJsonLine('{"type":"thread.started","thread_id":"thread-123"}'),
    { threadId: "thread-123" },
  );
  assert.deepEqual(
    parseCodexJsonLine('{"type":"item.completed","item":{"type":"agent_message","text":"改写结果"}}'),
    { text: "改写结果" },
  );
  assert.deepEqual(
    parseCodexJsonLine('{"type":"item.completed","item":{"type":"web_search","action":{"type":"search","query":"WriteX"}}}'),
    { webSearch: true },
  );
  assert.deepEqual(parseCodexJsonLine("not-json"), {});
});

test("Codex arguments use an optional model and exact reasoning effort for new and resumed conversations", () => {
  const defaultArgs = buildCodexArgs({ cwd: "/vault" });
  assert.equal(defaultArgs.includes("--model"), false);
  assert.equal(defaultArgs.some(value => value.includes("model_reasoning_effort")), false);
  assert.deepEqual(defaultArgs.slice(-5), ["--sandbox", "read-only", "-C", "/vault", "-"]);

  const newThread = buildCodexArgs({ cwd: "/vault", model: "gpt-5.6-terra", reasoningEffort: "high" });
  const newModelIndex = newThread.indexOf("--model");
  assert.equal(newThread[newModelIndex + 1], "gpt-5.6-terra");
  assert.ok(newThread.includes('model_reasoning_effort="high"'));

  const resumed = buildCodexArgs({ cwd: "/vault", threadId: "thread-123", model: "gpt-5.6-sol", reasoningEffort: "xhigh" });
  const resumedModelIndex = resumed.indexOf("--model");
  assert.equal(resumed[resumedModelIndex + 1], "gpt-5.6-sol");
  assert.ok(resumed.includes('model_reasoning_effort="xhigh"'));
  assert.deepEqual(resumed.slice(-2), ["thread-123", "-"]);
});

test("Codex native web search is opt-in and leaves browser automation disabled", () => {
  const off = buildCodexArgs({ cwd: "/vault", allowWebSearch: false });
  const on = buildCodexArgs({ cwd: "/vault", allowWebSearch: true });
  assert.equal(off.includes('web_search="disabled"'), true);
  assert.equal(on.includes('web_search="live"'), true);
  assert.equal(on.includes("browser_use"), true);
  const prompt = buildWritingPrompt({ request: "查最新资料", filePath: "a.md", noteContent: "正文", maxContextChars: 100, allowWebSearch: true });
  assert.match(prompt, /必要时可使用原生联网检索/);
  assert.doesNotMatch(prompt, /不要访问网络/);
});

test("Codex receives only explicitly attached local images as native visual input", () => {
  const args = buildCodexArgs({
    cwd: "/vault",
    imagePaths: ["/vault/attachments/agent/文章/chat/m-1/photo.png"],
  });
  assert.equal(args[args.indexOf("--image") + 1], "/vault/attachments/agent/文章/chat/m-1/photo.png");
  assert.equal(args.includes("--sandbox"), true);

  const resumed = buildCodexArgs({
    cwd: "/vault",
    threadId: "thread-1",
    imagePaths: ["/vault/attachments/agent/文章/chat/m-2/chart.jpg"],
  });
  assert.equal(resumed[resumed.indexOf("--image") + 1], "/vault/attachments/agent/文章/chat/m-2/chart.jpg");
  assert.equal(resumed.at(-2), "thread-1");
});

test("Codex image turns are ephemeral and only the image entry gets workspace write access", () => {
  const args = buildCodexImageArgs({
    cwd: "/vault",
    outputDirectory: "/vault/.write-output/1",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
  });
  assert.equal(args.includes("--ephemeral"), true);
  assert.equal(args.includes("workspace-write"), true);
  assert.equal(args.includes("read-only"), false);
  assert.equal(args.includes("plugins"), false);
  assert.equal(args.includes("skill_search"), false);
  assert.equal(args[args.indexOf("--model") + 1], "gpt-5.6-sol");
  assert.ok(args.includes('model_reasoning_effort="medium"'));
  assert.deepEqual(args.slice(-3), ["-C", "/vault/.write-output/1", "-"]);

  const prompt = buildCodexImagePrompt({
    prompt: "一张绿色流程图",
    outputDirectory: "/vault/.write-output/1",
    size: "1536x1024",
  });
  assert.match(prompt, /\$imagegen/);
  assert.match(prompt, /\/vault\/\.write-output\/1/);
  assert.match(prompt, /不要修改正文/);
  assert.match(prompt, /1536.*1024/);
  assert.match(prompt, /横图 3:2/);
});

test("Codex image output finder only accepts non-empty PNG, JPEG, or WebP files", async t => {
  const root = await mkdtemp(join(tmpdir(), "write-image-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "empty.png"), new Uint8Array());
  await writeFile(join(root, "not-an-image.png"), "hello");
  await mkdir(join(root, "nested"));
  const expected = join(root, "nested", "final.webp");
  await writeFile(expected, Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x01, 0x00, 0x00,
  ]));

  assert.deepEqual(await findGeneratedImageFile(root), {
    filePath: expected,
    mimeType: "image/webp",
  });
});

test("writing prompt includes selection and clips long note context", () => {
  const prompt = buildWritingPrompt({
    request: "改得更具体",
    filePath: "文章.md",
    noteContent: "A".repeat(40),
    selection: "原句",
    maxContextChars: 12,
    feedbackInstruction: "Write 本地反馈统计只包含匿名结构特征：好评 2，差评 1。",
  });
  assert.match(prompt, /用户选中的原文/);
  assert.match(prompt, /原句/);
  assert.match(prompt, /A{2}/);
  assert.match(prompt, /匿名结构特征/);
  assert.doesNotMatch(prompt, /A{3}/);
});

test("outline prompts show bounded local related material with its source path", () => {
  const prompt = buildWritingPrompt({
    request: "搭大纲",
    filePath: "当前.md",
    noteContent: "当前正文",
    maxContextChars: 100,
    relatedContext: "相关本地笔记（标题匹配，最多 3 篇）：\n- 来源：相关.md\n  相关材料",
  });
  assert.match(prompt, /相关本地笔记（标题匹配，最多 3 篇）/);
  assert.match(prompt, /来源：相关\.md/);
});

test("writing prompt exposes only the user-attached local files and permits reading that bounded list", () => {
  const prompt = buildWritingPrompt({
    request: "根据这些材料给我三个切口",
    filePath: "文章.md",
    noteContent: "正文",
    maxContextChars: 100,
    attachments: [{
      id: "attachment-1",
      name: "访谈记录.pdf",
      filePath: "attachments/agent/文章/chat/message-1/访谈记录.pdf",
      absolutePath: "/vault/attachments/agent/文章/chat/message-1/访谈记录.pdf",
      mimeType: "application/pdf",
      byteLength: 1024,
      kind: "file",
    }, {
      id: "attachment-2",
      name: "现场照片.png",
      filePath: "attachments/agent/文章/chat/message-1/现场照片.png",
      absolutePath: "/vault/attachments/agent/文章/chat/message-1/现场照片.png",
      mimeType: "image/png",
      byteLength: 2048,
      kind: "image",
    }],
  });
  assert.match(prompt, /只允许读取下面明确附上的本地文件/);
  assert.match(prompt, /访谈记录\.pdf/);
  assert.match(prompt, /现场照片\.png/);
  assert.match(prompt, /\/vault\/attachments\/agent\/文章\/chat\/message-1/);
  assert.match(prompt, /不要访问未列出的 Vault 文件/);
});

test("writing prompt includes only the explicitly selected Skill instruction", () => {
  const prompt = buildWritingPrompt({
    request: "改写",
    filePath: "文章.md",
    noteContent: "正文",
    maxContextChars: 100,
    skillInstruction: "Skill 名称：human-writing\n先完整读取 /vault/.agents/skills/human-writing/SKILL.md",
  });
  assert.match(prompt, /Skill 名称：human-writing/);
  assert.match(prompt, /允许读取显式启用的 Skill/);
  assert.doesNotMatch(prompt, /不要调用工具/);
});

test("writing prompt keeps confirmed personal style separate from the selected task Skill", () => {
  const style = buildStyleInstruction({ markdown: "## 叙述节奏\n保留停顿。", sources: [], revision: 2, agent: "codex", model: "gpt-5.6-sol", createdAt: 1, updatedAt: 2 });
  const prompt = buildWritingPrompt({
    request: "改写", filePath: "文章.md", noteContent: "正文", maxContextChars: 100,
    skillInstruction: "Skill 名称：human-writing", styleInstruction: style,
  });
  assert.match(prompt, /我的文风（已确认档案 v2/);
  assert.match(prompt, /Skill 名称：human-writing/);
  assert.match(prompt, /当前用户要求、事实材料和明确格式约束优先/);
});

test("writing style is opt-in per note, records a compact snapshot, and exports only confirmed text", () => {
  const profile = { markdown: "## 结构习惯\n从现场进入。", sources: [], revision: 3, agent: "claude" as const, model: "sonnet", createdAt: 1, updatedAt: 2 };
  assert.equal(styleEnabled(profile, undefined), true);
  assert.equal(styleEnabled(profile, false), false);
  assert.equal(styleEnabled(undefined, true), false);
  assert.equal(sha256Text(profile.markdown).length, 64);
  assert.match(renderStyleSkill(profile), /# 我的文风/);
  assert.match(buildStyleExtractionPrompt([{ kind: "selection", sourceHash: "a".repeat(64), capturedAt: 1, characterCount: 8, includedChars: 4, content: "一段代表作" }]), /作者立场与说话位置/);
});

test("bounded local text diff preserves Chinese punctuation and degrades safely for long input", () => {
  const diff = buildBoundedTextDiff("我，停一下。", "我，真的停一下。", 100);
  assert.equal(diff.truncated, false);
  assert.equal(diff.parts.some(part => part.kind === "added" && part.text === "真的"), true);
  const long = buildBoundedTextDiff("原".repeat(101), "新".repeat(101), 100);
  assert.equal(long.truncated, true);
});

test("Plan mode asks Codex for a decision-ready plan instead of a finished draft", () => {
  const prompt = buildWritingPrompt({
    request: "规划这篇文章",
    filePath: "文章.md",
    noteContent: "正文",
    maxContextChars: 100,
    mode: "plan",
  });
  assert.match(prompt, /Plan 模式/);
  assert.match(prompt, /不要直接给成稿/);
  assert.match(prompt, /关键选择/);
});

test("writing context gives current, selection, history, and related material one total budget", () => {
  const context = allocateWritingContext({
    noteContent: "正文".repeat(8), selection: "选段".repeat(5), conversation: "历史".repeat(8), related: "材料".repeat(8), maxChars: 30,
  });
  assert.ok(Object.values(context).join("").length <= 30);
  assert.match(context.selection, /选段/);
  assert.match(context.noteContent, /正文/);
  assert.ok(context.conversation.length <= 4);
  assert.equal(context.related, "");
});

test("selection replacement preserves surrounding whitespace", () => {
  assert.equal(
    preserveSelectionWhitespace("原句\n\n", "改写后的句子。"),
    "改写后的句子。\n\n",
  );
  assert.equal(
    preserveSelectionWhitespace("  原句  ", "改写"),
    "  改写  ",
  );
});

test("image type is detected from bytes instead of a misleading extension", () => {
  assert.equal(detectImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]).buffer), "image/jpeg");
  assert.equal(detectImageMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer), "image/png");
  assert.equal(detectImageMime(Uint8Array.from([0x42, 0x4d, 0x00, 0x00]).buffer), "image/bmp");
  assert.equal(detectImageMime(Uint8Array.from([0x00, 0x01, 0x02, 0x03]).buffer), null);
});

test("only generated images with an original prompt can be regenerated", () => {
  assert.equal(canRegenerateImage({ source: "generated", prompt: "一张绿色写作流程图" }), true);
  assert.equal(canRegenerateImage({ source: "generated" }), false);
  assert.equal(canRegenerateImage({ source: "manual", prompt: "不应使用" }), false);
});

test("image routing only tries the current Agent automatically", () => {
  assert.equal(chooseAutomaticImageProvider("unknown"), null);
  assert.equal(chooseAutomaticImageProvider("available"), "agent");
  assert.equal(chooseAutomaticImageProvider("unavailable"), null);
  assert.equal(canUseWriteCloudV01(), false);
});

test("legacy generated images keep using the user's OpenAI API when regenerated", () => {
  assert.equal(resolveGeneratedProvider({ source: "generated", provider: "agent" }), "agent");
  assert.equal(resolveGeneratedProvider({ source: "generated" }), "openai-api");
  assert.equal(resolveGeneratedProvider({ source: "manual" }), null);
});

test("image source labels distinguish Agent, own API, and manual imports", () => {
  assert.equal(imageProviderLabel({ source: "generated", provider: "agent" }), "AI · Agent");
  assert.equal(imageProviderLabel({ source: "generated", provider: "openai-api" }), "AI · 自带 API");
  assert.equal(imageProviderLabel({ source: "generated" }), "AI · 自带 API");
  assert.equal(imageProviderLabel({ source: "manual" }), "手动导入");
  assert.equal(imageProviderLabel({ source: "original" }), "原图");
  assert.equal(imageProviderLabel({ source: "optimized" }), "公众号优化版");
});

test("optimized GIFs gain one adjacent original card and migration stays idempotent", () => {
  const assets: ImageAsset[] = [{
    id: "optimized-1",
    filePath: "attachments/agent/article/demo-wechat.gif",
    name: "demo-wechat.gif",
    mimeType: "image/gif",
    source: "optimized",
    createdAt: 10,
    relatedOriginalPath: "media/demo.gif",
  }];
  const resolve = (path: string) => path === "media/demo.gif" ? { name: "demo.gif" } : null;
  assert.equal(ensureOriginalAssetPairs(assets, resolve, () => "original-1"), true);
  assert.equal(assets.length, 2);
  assert.deepEqual(assets[1], {
    id: "original-1",
    filePath: "media/demo.gif",
    name: "demo.gif",
    mimeType: "image/gif",
    source: "original",
    createdAt: 10,
    relatedOptimizedPath: "attachments/agent/article/demo-wechat.gif",
    writeCredits: 0,
  });
  assert.equal(ensureOriginalAssetPairs(assets, resolve, () => "should-not-run"), false);
  assert.equal(assets.length, 2);
});

test("plain text conversion removes Markdown chrome", () => {
  assert.equal(
    markdownToPlainText("# 标题\n\n> **一句话**\n\n![图](a.png)"),
    "标题\n\n一句话\n\n图",
  );
});

test("local images can be collected once for rich clipboard embedding", () => {
  assert.deepEqual(
    extractMarkdownImageSources("![[a.png]]\n![说明](images/b.webp)\n![[a.png|重复]]\n证书：![[c.png]]"),
    ["a.png", "images/b.webp", "c.png"],
  );
});
