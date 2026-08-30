import {
  App,
  ItemView,
  MarkdownView,
  MarkdownRenderer,
  Menu,
  Modal,
  Notice,
  sanitizeHTMLToDom,
  TFile,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type ObsidianAgentPlugin from "./main";
import { buildWritingPrompt } from "./codex";
import { runAndRecordAssistant } from "./chatTurnController";
import {
  AGENT_LABELS,
  AGENT_MODELS,
  CODEX_REASONING_OPTIONS,
  codexReasoningLabel,
  configuredCodexReasoningEffort,
  configuredAgentModel,
  setConfiguredAgentModel,
} from "./chatAgents";
import { writeClipboardText } from "./clipboard";
import { splitAssistantMarkdownBlocks } from "./chatBlocks";
import { validateChatAttachmentInputs } from "./chatAttachments";
import {
  buildCopyPlan,
  COPY_HTML_BUDGET_BYTES,
  formatBytes,
  type CopyPlan,
  type CopyTaskState,
} from "./copyPlan";
import { convertForWeChat } from "./imageConversion";
import { optimizeAnimatedGif } from "./gifOptimizer";
import { getAgentSession, setAgentSession } from "./conversations";
import { buildFeedbackInstruction } from "./feedback";
import { inspectImage, planWeChatImage } from "./images";
import { describeImageProblem, galleryProblemSummary, missingImageInspection, type ImageProblem } from "./imageProblems";
import { imageProviderLabel, resolveGeneratedProvider } from "./imageRouting";
import { buildCutPrompt, sampleCutLenses, sortTopicsNewestFirst } from "./topics";
import { prepareSelectionComparison, SelectionCompareController } from "./selectionCompareController";
import { buildStyleInstruction, sha256Text, styleEnabled } from "./writingStyle";
import { WritingStyleModal } from "./writingStyleModal";
import { ThemeLibraryModal } from "./themeLibraryModal";
import { assetIdempotencyKey, characterCount, uploadFileName } from "./wechatSync";
import {
  buildExplicitSkillInstruction,
  findLocalSkillByPath,
  isCurrentSkillScan,
  isSupportedSkillSource,
  type LocalSkill,
} from "./skills";
import {
  extractMarkdownImageSources,
  markdownToPlainText,
} from "./wechat";
import {
  canRegenerateImage,
  type ChatAttachment,
  type ChatAgentId,
  type ChatMessage,
  type ChatMode,
  type ChatSkillSnapshot,
  type ImageAsset,
  type ImageSize,
  type SelectionContext,
  type TopicIdea,
} from "./types";

export const VIEW_TYPE = "obsidian-agent-view";
export const WRITEX_ICON = "sprout";

type ActiveTab = "chat" | "gallery" | "preview";
type GalleryFilter = "all" | "generated" | "manual" | "original" | "optimized";
type RunningTask = "chat";
type ImageTask = "agent-image" | "openai-image";
type SkillDiscoveryState = "loading" | "ready" | "empty" | "failed";

interface PendingImageRequest {
  prompt: string;
  notePath: string;
  context?: SelectionContext;
  userMessageId: string;
  imageSize: ImageSize;
  error?: string;
}

const CHAT_AGENT_IDS: ChatAgentId[] = ["codex", "claude", "workbuddy"];

const OUTLINE_PROMPT = `你是一位「文章结构设计师」，擅长用「拆文方法论」帮助用户从零开始搭建文章骨架。你不是直接给答案的 AI，而是通过问答式引导，让用户自己长出清晰的写作思路。

你的核心能力：
1. 判断选题适合什么结构：七段式递进、漏斗式教程、情绪弧线叙事或剥洋葱逻辑。
2. 用 5Why 追问帮用户找到本质观点。
3. 用 MECE 原则帮用户分类论据。
4. 用「快思维 → 慢思维」切换帮用户校准表达深度。

工作边界与节奏：
- 不直接替用户给出观点、经历、数据或论据；不要编造用户经历、数据或论据。材料不足时如实追问。
- 当前笔记、选区、Chat 历史或系统提供的上下文都只是参考上下文，不算「本条用户消息在本说明之后附有的非空草稿/主题」。
- 只有 OUTLINE_PROMPT 指令正文结束后，在同一个用户要求末尾明确出现额外的新草稿/主题文本，才视作 Step 1 回答；也就是说，若本条用户消息在本说明之后附有非空草稿或主题，把它当作 Step 1 的用户回答，直接做选题扫描，不重复首次开场。
- 否则即使当前笔记已有正文，也必须使用首次开场；只有没有附带内容时才使用指定首次开场白：首次激活时只发开场问题，不要直接产出大纲，不要预演五步流程。首次回复必须是：
  「你好，我是你的文章结构设计师。接下来我会通过一系列问题，帮你把一个模糊的选题，拆成一份可执行的文章大纲。

  请告诉我：你今天要写的选题是什么？用一句话描述。

  （不用担心说得不够好，越粗糙越好，我会帮你打磨。）」
- 后续严格一次只聚焦当前步骤和必要问题，等待用户回答后再继续；不要在一轮内把五步全跑完。每轮最多问当前步骤所需的 1–3 个问题。
- 用户发散时，以「如果只能用一句话……」「最核心的一点是……」帮助收束；保留用户原话中的具体经验和判断，不把它替换成空泛模板。

交互流程（五步问答法）：

Step 1：选题定性（判断文章类型）
先问：「你的选题是什么？请用一句话描述你要写的核心主题。」
收到回答后做「选题扫描」，从三个维度判断：
- 反常识度：核心观点是否违背直觉？反常识优先七段式递进。
- 情感指向：最终是否指向人的价值或意义追问？是则优先理性 → 深情的情绪弧线。
- 实用属性：是在教别人怎么做，还是让别人怎么想？教程优先漏斗式，观点优先剥洋葱。
输出判断并说明：「根据你的选题，我初步判断这篇文章适合【XX结构】。接下来我会通过几个问题，帮你把这个选题拆成可执行的大纲。」然后进入 Step 2。

Step 2：核心观点萃取（找到那颗洋葱芯）
从下列 5Why 式追问中选 2–3 个最关键的问题，不要全部堆给用户：
- 如果只能用一句话告诉别人「这篇文章到底在说什么」，你会怎么说？
- 你的观点和大多数人的直觉有什么不同？
- 如果抛开所有行业术语和假设，这件事最底层的真相是什么？
- 读者读完这篇文章后，应该带走一个什么判断或行动？
回答后提炼并请用户确认：「你的核心命题似乎是：【一句话】。接下来我们围绕这个命题，搭建支撑它的骨架。」然后进入 Step 3。

Step 3：结构选择（匹配最适合的框架）
基于 Step 1 和 Step 2 给出有理由的结构建议，并让用户选择或混合：

方案A：七段式递进（反常识观点文）
适合核心观点违背直觉、需要层层剥开说服读者：
- 起（1）：抛出反常识现象，建立悬念。
- 承（2–3）：第一层拆解（组织/机制层面），第二层拆解（数据/底座层面）。
- 转（4–5）：第三层拆解（人的价值浮现），第四层拆解（时间/伦理层面）。
- 深（6）：最残酷的部分（权力/成长/管理者）。
- 合（7）：回归本质，情感升华。

方案B：漏斗式教程（产品/工具教学）
适合教别人用某个工具、学某个方法：
- 钩子层：为什么学这个（痛点 + 价值判断）。
- 全景层：整体地图是什么（建立心理模型）。
- 展开层：按重要性/使用频率拆解 Step 1 → Step 2 → Step 3。
- 场景层：具体怎么用（代入真实场景）。
- 收尾层：常见问题 + 下一步行动。

方案C：情绪弧线叙事（个人经历/反思）
适合创业故事、年终总结、公开信：
- 起：具体场景切入，一个画面或时刻。
- 承：理性展开，补充事实、数据、逻辑论证。
- 转：遇到冲突、困境或反常识发现。
- 合：情感升华，回归人的价值或意义追问。

方案D：剥洋葱式诊断（问题分析/战略思考）
适合分析一个问题、提出创新方案：
- 表层：大家看到的症状/常识。
- 剥开第一层：挑战基本假设。
- 剥开第二层：拆解到最基本要素。
- 剥开第三层：重新定义问题。
- 核心：本质结论 + 可执行方案。

接着问：「以上【X】种结构中，你觉得哪种最贴近你的写作意图？或者你想混合使用？」等待回答后进入 Step 4。

Step 4：血肉填充（问答式梳理每一部分）
按用户选定的结构，逐段推进；每次只问当前一段或一层。每收到一段回答都先总结：「好的，这一段的核心是：【一句话】。我们把它记下来。」再问下一段。

如果是七段式递进，依次问：
- 第1段（起）：你想用什么反常识现象或钩子开头？是一个故事、一个数据，还是一个冲突场景？
- 第2–3段（承）：支撑你观点的第一层证据是什么？是亲身经历、行业观察，还是数据？
- 第4–5段（转）：当读者可能产生质疑时，你用什么来回应？有没有一个「但是」的转折？
- 第6段（深）：这篇文章最扎心或最反直觉的部分是什么？
- 第7段（合）：你最终想落在哪里？是一个金句、一个行动号召，还是一个开放的思考？

如果是漏斗式教程，依次问：
- 钩子层：读者不学这个，会损失什么？
- 全景层：用一句话描述这个工具的核心能力模型是什么？
- 展开层：按使用频率排序，最重要的 3 个功能是什么？
- 场景层：举一个读者最熟悉的使用前 vs 使用后对比场景。
- 收尾层：读者第一步应该做什么（最小可行行动）？

如果是情绪弧线叙事，依次问：
- 起：有没有一个具体的画面或时刻，能让读者一秒钟代入你的处境？
- 承：支撑这个故事的事实、数据或逻辑是什么？
- 转：你在什么时刻遇到了最大的冲突或困境？
- 合：你最终想传达什么情感或价值？

如果是剥洋葱式诊断，依次问：
- 表层：大多数人看到的「症状」或「常识」是什么？
- 第一层：如果挑战这个常识，哪个基本假设最值得质疑？
- 第二层：拆解到最基本要素后，真正的驱动因素是什么？
- 第三层：重新定义这个问题后，它变成了什么问题？
- 核心：你的本质结论和可执行方案是什么？

Step 5：大纲成型 + 校准
只有在用户已提供相应素材、确认可以汇总时，才整合为以下 Markdown 结构化大纲；缺失项标为「待补充」，不能自行虚构：

# 【文章标题（建议）】

## 文章定位
- 类型：【七段式递进 / 漏斗式教程 / 情绪弧线 / 剥洋葱】
- 核心命题：【一句话】
- 目标读者：【谁】
- 阅读时长预估：【X分钟 / X字】

## 大纲骨架

### 第1段：【段落功能】（约X字）
- 核心任务：【这一段要解决什么问题】
- 内容要点：【用户回答的要点】
- 情绪基调：【理性 / 亲切 / 悬念 / 轻快】

### 第2段：【段落功能】（约X字）
……按所选结构补全其余段落。

## 情绪曲线设计
用简单折线图示意，并标注每段情绪值（-5 到 +5）。

## 逻辑曲线设计
用箭头图示意从现象到本质的剥洋葱路径。

## 表达理论标签
- 【自动匹配：如亚里士多德修辞三要素、金字塔原理、第一性原理、MECE 等】

## 写作建议
- 根据大纲给出 3–5 条具体建议，例如第3段需要一个具体案例、第5段情绪需要再压低一点。

最后问：「这个大纲是否符合你的预期？有没有哪一段你觉得需要调整方向、补充素材，或者情绪不对？我们可以继续打磨。」

核心原则：
- 不直接给答案：永远用问题引导用户思考，让用户自己长出大纲。
- 强制收敛：发散时用一句话收束到最核心的一点。
- 结构先行，文字后行：先确定骨架，再讨论具体内容。
- 情绪可视化：每一段都标注情绪基调，让用户感知文章的呼吸感。
- 可回包：最终大纲要能让用户用本质命题回包解释其他现象。`;

const PREVIEW_DEVICE = { label: "iPhone 16", width: 375, height: 813, camera: "is-island" } as const;
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function imageStageError(stage: string, source: string, error: unknown): Error {
  return new Error(`${stage}失败：${source} · ${errorMessage(error)}`, { cause: error });
}

type CopyChoice = "inline" | "optimize" | "relay" | "text-only" | "exclude";

class CopyPlanModal extends Modal {
  private chosen = false;

  constructor(
    app: App,
    private readonly plan: CopyPlan,
    private readonly relayConfigured: boolean,
    private readonly choose: (choice: CopyChoice) => void,
    private readonly cancel: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("oa-copy-plan-modal");
    this.setTitle("复制微信格式 · 预检");
    const container = this.contentEl;
    container.empty();
    container.createEl("p", {
      text: "WriteX 还没有编码图片或写入剪贴板。请先确认体积和处理路径。",
    });
    const summary = container.createDiv({ cls: "oa-copy-plan-summary" });
    for (const [label, value] of [
      ["文章", `${this.plan.articleCharacters} 字`],
      ["排版", this.plan.layoutLabel],
      ["图片", `${this.plan.imageCount} 张`],
      ["原图总量", formatBytes(this.plan.originalImageBytes)],
      ["预计 Base64", formatBytes(this.plan.estimatedBase64Bytes)],
      ["预计剪贴板 HTML", formatBytes(this.plan.estimatedClipboardHtmlBytes)],
      ["Relay", this.plan.relayRecommendation],
      ["远程上传", "尚未发生"],
      ["WriteX 积分", "0"],
    ]) {
      const row = summary.createDiv();
      row.createSpan({ text: label });
      row.createEl("strong", { text: value });
    }
    const issues = container.createDiv({ cls: "oa-copy-plan-issues" });
    for (const issue of this.plan.issues) {
      issues.createDiv({
        cls: `oa-copy-plan-issue is-${issue.level}`,
        text: `${issue.level === "block" ? "阻塞" : issue.level === "warn" ? "警告" : "已处理"} · ${issue.message}${issue.source ? `（${issue.source}）` : ""}`,
      });
    }
    const images = container.createDiv({ cls: "oa-copy-plan-images" });
    for (const image of this.plan.images) {
      const row = images.createDiv({ cls: "oa-copy-plan-image" });
      if (image.problem.status === "unrepairable") {
        const file = this.app.vault.getAbstractFileByPath(image.source);
        if (file instanceof TFile) row.createEl("img", {
          cls: "oa-copy-plan-problem-preview",
          attr: { src: this.app.vault.getResourcePath(file), alt: image.problem.articleLabel ?? "异常图片" },
        });
        else row.createDiv({ cls: "oa-copy-plan-problem-preview is-fallback", text: image.problem.articleLabel ?? "异常图片" });
      }
      row.createEl("strong", { text: image.source });
      if (image.problem.status !== "ready") {
        row.createEl("span", { cls: image.problem.status === "unrepairable" ? "oa-copy-plan-problem" : "oa-copy-plan-route", text: `${image.problem.articleLabel ? `${image.problem.articleLabel} · ` : ""}${image.problem.reason}` });
      }
      const dimensions = image.width && image.height ? `${image.width}×${image.height}` : "宽高未知";
      const animation = image.animated
        ? ` · ${image.frameCount ?? "?"} 帧 · ${image.frameRate?.toFixed(1) ?? "?"} fps · ${image.durationSeconds?.toFixed(2) ?? "?"} 秒`
        : "";
      row.createSpan({ text: `${image.mimeType} · ${formatBytes(image.byteLength)} · ${dimensions}${animation}` });
      row.createSpan({ cls: "oa-copy-plan-route", text: `路径：${image.path} · ${image.recommendation}` });
    }
    const actions = container.createDiv({ cls: "oa-copy-plan-actions" });
    this.action(actions, "直接内嵌并复制", "inline", !this.plan.canDirectCopy, this.plan.canDirectCopy);
    this.action(actions, "优化图片后复制", "optimize", !this.plan.images.some(image => image.path.startsWith("optimize")));
    this.action(actions, `排除 ${this.plan.excludableImages.length} 张异常图片并复制`, "exclude", !this.plan.excludableImages.length);
    const relayEligible = this.plan.images.every(image => image.path === "inline" || image.relayEligible);
    this.action(actions, "使用自建 Relay 准备公众号图片", "relay", !this.relayConfigured || !relayEligible);
    this.action(actions, "只复制文字和排版", "text-only", false);
    const cancel = actions.createEl("button", { text: "取消", attr: { type: "button" } });
    cancel.onclick = () => this.close();
  }

  override onClose(): void {
    if (!this.chosen) this.cancel();
  }

  private action(container: HTMLElement, label: string, choice: CopyChoice, disabled: boolean, primary = false): void {
    const button = container.createEl("button", {
      cls: primary ? "mod-cta" : "",
      text: label,
      attr: { type: "button" },
    });
    button.disabled = disabled;
    button.onclick = () => {
      this.chosen = true;
      this.close();
      this.choose(choice);
    };
  }
}

class RelayCopyConfirmModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly accountName: string,
    private readonly imageSources: string[],
    private readonly settle: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("确认准备公众号图片");
    const container = this.contentEl;
    container.createEl("p", { text: `目标公众号：${this.accountName}` });
    container.createEl("p", { text: `即将准备正文图片：${this.imageSources.length} 张` });
    const list = container.createEl("ul", { cls: "oa-relay-image-list" });
    for (const source of this.imageSources) list.createEl("li", { text: source });
    container.createEl("p", { text: "只上传正文图片并取得微信 URL；不创建草稿、不更新草稿、不发布、不群发。" });
    container.createEl("p", { text: "路径：用户自建 Relay · WriteX 积分：0" });
    const actions = container.createDiv({ cls: "oa-modal-actions" });
    const cancel = actions.createEl("button", { text: "取消", attr: { type: "button" } });
    cancel.onclick = () => this.close();
    const confirm = actions.createEl("button", { cls: "mod-cta", text: "确认准备并复制", attr: { type: "button" } });
    confirm.onclick = () => {
      this.settled = true;
      this.settle(true);
      this.close();
    };
  }

  override onClose(): void {
    if (!this.settled) this.settle(false);
  }
}

class RelayIdentityConfirmModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly relayUrl: string,
    private readonly settle: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("确认检查 Relay 公众号身份");
    const container = this.contentEl;
    container.createEl("p", { text: `即将连接：${this.relayUrl}` });
    container.createEl("p", { text: "这一步只读取 Relay 绑定的公众号名称和账号 ID；不上传图片、不创建或更新草稿、不发布、不群发。" });
    container.createEl("p", { text: "确认前 WriteX 不会发送任何 Relay 请求。" });
    const actions = container.createDiv({ cls: "oa-modal-actions" });
    const cancel = actions.createEl("button", { text: "取消", attr: { type: "button" } });
    cancel.onclick = () => this.close();
    const confirm = actions.createEl("button", { cls: "mod-cta", text: "确认检查 Relay", attr: { type: "button" } });
    confirm.onclick = () => {
      this.settled = true;
      this.settle(true);
      this.close();
    };
  }

  override onClose(): void {
    if (!this.settled) this.settle(false);
  }
}

class SkillInstallModal extends Modal {
  private source = "";
  private busy = false;

  constructor(app: App, private readonly install: (source: string) => Promise<void>) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("安装 Skill 到当前 Vault");
    this.render();
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();
    container.createEl("p", {
      text: "只接受 HTTPS GitHub 地址。确认后会调用开源 skills CLI，把 Skill 复制到当前 Vault 的 .agents/skills。请只安装你信任的仓库。",
    });
    const input = container.createEl("input", {
      cls: "oa-skill-source-input",
      attr: { type: "url", placeholder: "https://github.com/owner/skill-repo", "aria-label": "Skill GitHub 地址" },
    });
    input.value = this.source;
    input.disabled = this.busy;
    input.oninput = () => { this.source = input.value.trim(); };
    const actions = container.createDiv({ cls: "oa-modal-actions" });
    const cancel = actions.createEl("button", { text: "取消", attr: { type: "button" } });
    cancel.disabled = this.busy;
    cancel.onclick = () => this.close();
    const confirm = actions.createEl("button", { cls: "mod-cta", text: this.busy ? "安装中…" : "确认安装", attr: { type: "button" } });
    confirm.disabled = this.busy || !isSupportedSkillSource(this.source);
    input.oninput = () => {
      this.source = input.value.trim();
      confirm.disabled = this.busy || !isSupportedSkillSource(this.source);
    };
    confirm.onclick = async () => {
      if (!isSupportedSkillSource(this.source)) return;
      this.busy = true;
      this.render();
      try {
        await this.install(this.source);
        new Notice("Skill 已安装到当前 Vault。");
        this.close();
      } catch (error) {
        this.busy = false;
        new Notice(errorMessage(error));
        this.render();
      }
    };
  }
}

class SkillPickerModal extends Modal {
  constructor(
    app: App,
    private readonly skills: LocalSkill[],
    private readonly activePath: string,
    private readonly choose: (skillPath: string) => Promise<void>,
    private readonly rescan: () => void,
    private readonly install: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("oa-chat-modal");
    this.setTitle("Chat Skill");
    const container = this.contentEl;
    container.empty();
    container.createEl("p", { text: "每次只显式启用一个 Skill。未选择时，WriteX 不会让 Codex 自动猜。" });
    const search = container.createEl("input", {
      cls: "oa-chat-search oa-skill-search",
      attr: { type: "search", placeholder: "搜索 Skill 名称、说明或来源", "aria-label": "搜索 Skill" },
    });
    const list = container.createDiv({ cls: "oa-skill-list" });
    const renderList = () => {
      list.empty();
      this.skillButton(list, "", "不使用 Skill", "使用 WriteX 的基础写作提示");
      const query = search.value.trim().toLocaleLowerCase();
      const matches = query
        ? this.skills.filter(skill => `${skill.name} ${skill.description} ${skill.rootLabel}`.toLocaleLowerCase().includes(query))
        : this.skills;
      for (const [scope, heading] of [
        ["current", "当前项目"],
        ["vault", "Vault 其他项目"],
      ] as const) {
        const group = matches.filter(skill => skill.scope === scope);
        if (!group.length) continue;
        list.createEl("h3", { cls: "oa-skill-group-title", text: heading });
        for (const skill of group) {
          this.skillButton(list, skill.skillFile, skill.name, `${skill.description} · ${skill.rootLabel}`);
        }
      }
      if (!matches.length) {
        list.createEl("p", {
          cls: "oa-skill-no-results",
          text: this.skills.length
            ? "没有匹配的 Skill。"
            : "当前 Vault 未发现 Skill。可以重新扫描，或从 GitHub 安装。",
        });
      }
    };
    search.oninput = renderList;
    renderList();
    const actions = container.createDiv({ cls: "oa-skill-modal-actions" });
    const rescan = actions.createEl("button", { cls: "oa-rescan-skill", text: "重新扫描", attr: { type: "button" } });
    rescan.onclick = () => {
      this.close();
      this.rescan();
    };
    const install = actions.createEl("button", { cls: "oa-install-skill", text: "从 GitHub 安装 Skill…", attr: { type: "button" } });
    install.onclick = () => {
      this.close();
      this.install();
    };
  }

  private skillButton(container: HTMLElement, path: string, title: string, description: string): void {
    const button = container.createEl("button", { cls: "oa-skill-option", attr: { type: "button" } });
    const activeSkill = findLocalSkillByPath(this.skills, this.activePath);
    button.toggleClass("is-active", path === (activeSkill?.skillFile ?? this.activePath));
    button.createEl("strong", { text: title });
    button.createEl("span", { text: description });
    button.onclick = async () => {
      try {
        await this.choose(path);
        this.close();
      } catch (error) {
        new Notice(errorMessage(error));
      }
    };
  }
}

class ConversationHistoryModal extends Modal {
  constructor(app: App, private readonly plugin: ObsidianAgentPlugin) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("oa-chat-modal");
    this.setTitle("Chat 历史");
    const container = this.contentEl;
    container.empty();
    const items: Array<{ filePath: string; id?: string; title: string; updatedAt: number; active: boolean; detail: string; searchText: string }> = [];
    for (const [filePath, state] of Object.entries(this.plugin.data.notes)) {
      if (state.messages.length) {
        const first = state.messages.find(message => message.role === "user") ?? state.messages[0];
        items.push({
          filePath,
          title: first?.content.replace(/\s+/g, " ").trim().slice(0, 42) || "当前对话",
          updatedAt: state.messages.at(-1)?.createdAt ?? 0,
          active: true,
          detail: this.messageDetail(state.messages.at(-1)),
          searchText: state.messages.map(message => message.content).join(" "),
        });
      }
      for (const conversation of state.archivedConversations ?? []) {
        items.push({
          filePath,
          id: conversation.id,
          title: conversation.title,
          updatedAt: conversation.updatedAt,
          active: false,
          detail: this.messageDetail(conversation.messages.at(-1)),
          searchText: conversation.messages.map(message => message.content).join(" "),
        });
      }
    }
    if (!items.length) {
      container.createEl("p", { text: "还没有保存的对话。" });
      return;
    }
    const search = container.createEl("input", {
      cls: "oa-chat-search oa-history-search",
      attr: { type: "search", placeholder: "搜索历史标题、回答或笔记路径", "aria-label": "搜索 Chat 历史" },
    });
    const list = container.createDiv({ cls: "oa-history-list" });
    const sortedItems = items.sort((a, b) => b.updatedAt - a.updatedAt);
    const renderList = () => {
      list.empty();
      const query = search.value.trim().toLocaleLowerCase();
      const matches = query
        ? sortedItems.filter(item => `${item.title} ${item.searchText} ${item.detail} ${item.filePath}`.toLocaleLowerCase().includes(query))
        : sortedItems;
      for (const item of matches) {
        const button = list.createEl("button", { cls: "oa-history-item", attr: { type: "button" } });
        const title = button.createDiv();
        title.createEl("strong", { text: item.title });
        title.createEl("span", { text: item.active ? "当前会话" : "已归档" });
        button.createEl("small", { text: `${item.detail} · ${item.filePath}` });
        button.onclick = () => {
          void this.plugin.openConversation(item.filePath, item.id).then(() => this.close()).catch(error => new Notice(errorMessage(error)));
        };
      }
      if (!matches.length) list.createEl("p", { cls: "oa-skill-no-results", text: "没有匹配的历史对话。" });
    };
    search.oninput = renderList;
    renderList();
  }

  private messageDetail(message?: ChatMessage): string {
    const agent = message?.agent ?? "codex";
    const model = message?.model || "默认模型";
    const reasoning = message?.reasoningEffort ? ` · 推理${codexReasoningLabel(message.reasoningEffort)}` : "";
    return `${AGENT_LABELS[agent]} · ${model}${reasoning}`;
  }
}

class TopicDeleteConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly topicTitle: string,
    private readonly confirm: () => Promise<void>,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("oa-topic-delete-modal");
    this.setTitle("删除选题？");
    const container = this.contentEl;
    container.empty();
    container.createEl("p", { text: `“${this.topicTitle}”将从本地选题库删除，原 Chat 回答和笔记不会受影响。` });
    const actions = container.createDiv({ cls: "oa-topic-delete-actions" });
    const cancel = actions.createEl("button", { text: "取消", attr: { type: "button" } });
    const remove = actions.createEl("button", { cls: "mod-warning", text: "删除", attr: { type: "button" } });
    cancel.onclick = () => this.close();
    remove.onclick = async () => {
      remove.disabled = true;
      try {
        await this.confirm();
        this.close();
      } catch (error) {
        remove.disabled = false;
        new Notice(errorMessage(error));
      }
    };
  }
}

class TopicLibraryModal extends Modal {
  private editingTopicId = "";
  private quickDraft = "";
  private saving = false;

  constructor(
    app: App,
    private readonly plugin: ObsidianAgentPlugin,
    private readonly continueWriting: (topic: TopicIdea) => boolean,
    private readonly focusedTopicId = "",
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("oa-chat-modal");
    this.modalEl.addClass("oa-topic-library-modal");
    this.renderModal();
  }

  private renderModal(): void {
    this.setTitle(`选题库 · ${this.plugin.data.topics.length}`);
    const container = this.contentEl;
    container.empty();
    container.createEl("p", {
      cls: "oa-topic-intro",
      text: "把还没开始写、但不想忘记的一句话收住。",
    });
    const quickInput = container.createEl("input", {
      cls: "oa-topic-quick-input",
      attr: {
        type: "text",
        maxlength: "120",
        placeholder: "想到什么，回车收住……",
        "aria-label": "快速记录选题",
      },
    });
    quickInput.value = this.quickDraft;
    quickInput.disabled = this.saving;
    quickInput.oninput = () => { this.quickDraft = quickInput.value; };
    quickInput.onkeydown = event => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        void this.saveQuickTopic(quickInput);
      }
    };
    if (!this.plugin.data.topics.length) {
      const empty = container.createDiv({ cls: "oa-topic-empty" });
      const icon = empty.createSpan();
      setIcon(icon, "lightbulb");
      empty.createEl("strong", { text: "一句话就够，先把它收住。" });
      empty.createEl("span", { text: "只保存在本地，不会自动调用 Agent。" });
      window.setTimeout(() => quickInput.focus(), 0);
      return;
    }
    const list = container.createDiv({ cls: "oa-topic-list" });
    for (const topic of sortTopicsNewestFirst(this.plugin.data.topics)) {
      const item = list.createDiv({ cls: "oa-topic-item" });
      item.toggleClass("is-focused", topic.id === this.focusedTopicId);
      if (this.editingTopicId === topic.id) {
        this.renderTitleInput(item, topic);
        continue;
      }
      const main = item.createEl("button", {
        cls: "oa-topic-main",
        attr: { type: "button", "aria-label": `继续：${topic.title}` },
      });
      main.createEl("strong", { cls: "oa-topic-title", text: topic.title });
      main.createEl("small", { cls: "oa-topic-meta", text: this.topicSourceLabel(topic) });
      main.onclick = () => {
        if (!this.continueWriting(topic)) return;
        this.close();
      };
      const more = item.createEl("button", {
        cls: "oa-topic-more",
        text: "···",
        attr: { type: "button", "aria-label": `更多操作：${topic.title}` },
      });
      more.onclick = event => {
        event.stopPropagation();
        this.openTopicMenu(event, topic);
      };
      if (topic.id === this.focusedTopicId) {
        window.setTimeout(() => item.scrollIntoView({ block: "nearest" }), 0);
      }
    }
  }

  private async saveQuickTopic(input: HTMLInputElement): Promise<void> {
    if (this.saving) return;
    this.quickDraft = input.value;
    this.saving = true;
    input.disabled = true;
    try {
      const file = this.app.workspace.getActiveFile();
      const sourceNotePath = file instanceof TFile && file.extension === "md" ? file.path : undefined;
      await this.plugin.saveManualTopic(this.quickDraft, sourceNotePath);
      this.quickDraft = "";
      this.saving = false;
      this.renderModal();
    } catch (error) {
      this.saving = false;
      input.disabled = false;
      input.focus();
      new Notice(errorMessage(error));
    }
  }

  private topicSourceLabel(topic: TopicIdea): string {
    if (!topic.sourceNotePath) return topic.sourceKind === "chat" ? "来自 Chat" : "手动记录";
    const file = this.app.vault.getAbstractFileByPath(topic.sourceNotePath);
    if (!(file instanceof TFile)) return "来源已移动或删除";
    return topic.sourceKind === "chat" ? `来自 Chat · ${file.basename}` : `来自 ${file.basename}`;
  }

  private openTopicMenu(event: MouseEvent, topic: TopicIdea): void {
    const sourceFile = topic.sourceNotePath ? this.app.vault.getAbstractFileByPath(topic.sourceNotePath) : null;
    const menu = new Menu();
    menu.addItem(item => item.setTitle("改标题").setIcon("pencil").onClick(() => {
      this.editingTopicId = topic.id;
      this.renderModal();
    }));
    if (sourceFile instanceof TFile) {
      menu.addItem(item => item.setTitle("打开来源").setIcon("file-text").onClick(() => {
        void this.plugin.openTopicSource(topic.id)
          .then(() => this.close())
          .catch(error => new Notice(errorMessage(error)));
      }));
    }
    menu.addSeparator();
    menu.addItem(item => item.setTitle("删除").setIcon("trash-2").onClick(() => {
      new TopicDeleteConfirmModal(this.app, topic.title, async () => {
        await this.plugin.deleteTopic(topic.id);
        new Notice("已从选题库删除。");
        this.renderModal();
      }).open();
    }));
    menu.showAtMouseEvent(event);
  }

  private renderTitleInput(container: HTMLElement, topic: TopicIdea): void {
    const input = container.createEl("input", {
      cls: "oa-topic-title-input",
      attr: { type: "text", value: topic.title, maxlength: "120", "aria-label": "选题标题" },
    });
    input.onkeydown = event => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        input.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.editingTopicId = "";
        this.renderModal();
      }
    };
    input.onblur = () => {
      if (this.editingTopicId !== topic.id) return;
      const title = input.value;
      this.editingTopicId = "";
      void this.plugin.renameTopic(topic.id, title)
        .then(() => this.renderModal())
        .catch(error => {
          new Notice(errorMessage(error));
          this.editingTopicId = topic.id;
          this.renderModal();
        });
    };
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

}

class SelectionCompareModal extends Modal {
  private mode: "diff" | "original" | "suggestion" = "diff";
  private readonly controller: SelectionCompareController;
  private readonly replacement: string;

  constructor(
    app: App,
    private readonly plugin: ObsidianAgentPlugin,
    private readonly context: SelectionContext,
    private readonly markdown: string,
  ) {
    super(app);
    this.replacement = this.plugin.computeSelectionReplacement(this.context, this.markdown);
    this.controller = new SelectionCompareController(
      () => this.plugin.replaceOriginalSelection(this.context, this.replacement),
      () => this.close(),
    );
  }

  override onOpen(): void {
    this.modalEl.addClass("oa-selection-compare-modal");
    this.setTitle("对比替换");
    this.renderModal();
  }

  private renderModal(): void {
    const root = this.contentEl; root.empty();
    const suggestion = this.replacement;
    const controls = root.createDiv({ cls: "oa-selection-compare-tabs", attr: { role: "tablist", "aria-label": "对比视图" } });
    for (const [mode, label] of [["diff", "差异"], ["original", "原文"], ["suggestion", "建议"]] as const) {
      const button = controls.createEl("button", { text: label, attr: { type: "button", role: "tab", "aria-selected": String(mode === this.mode) } });
      button.toggleClass("is-active", mode === this.mode);
      button.onclick = () => { this.mode = mode; this.renderModal(); };
    }
    const content = root.createDiv({ cls: `oa-selection-compare-content is-${this.mode}` });
    if (this.mode === "diff") {
      const diff = prepareSelectionComparison(this.context.text, suggestion);
      if (diff.truncated) content.createEl("p", { cls: "oa-selection-compare-note", text: "选段较长，未做细粒度高亮；请在下方完整对照。" });
      const columns = content.createDiv({ cls: "oa-selection-compare-columns" });
      const original = columns.createDiv(); original.createEl("strong", { text: "原选段" }); original.createEl("pre", { text: this.context.text });
      const proposed = columns.createDiv(); proposed.createEl("strong", { text: "AI 建议" });
      if (diff.truncated) proposed.createEl("pre", { text: suggestion });
      else {
        const pre = proposed.createEl("pre", { cls: "oa-selection-diff" });
        for (const part of diff.parts) pre.createSpan({ cls: `is-${part.kind}`, text: part.text });
      }
    } else {
      const panel = content.createEl("pre", { text: this.mode === "original" ? this.context.text : suggestion });
      panel.setAttribute("aria-label", this.mode === "original" ? "原选段" : "AI 建议");
    }
    const actions = root.createDiv({ cls: "oa-selection-compare-actions" });
    actions.createEl("button", { text: "保留原文", attr: { type: "button" } }).onclick = () => this.controller.keepOriginal();
    const apply = actions.createEl("button", { cls: "mod-cta", text: "应用建议", attr: { type: "button" } });
    apply.onclick = async () => {
      apply.disabled = true;
      try { await this.controller.applyOnce(); }
      catch (error) { apply.disabled = false; new Notice(errorMessage(error)); }
    };
  }
}

export class AgentView extends ItemView {
  private activeTab: ActiveTab = "chat";
  private notePath = "";
  private selectionContext: SelectionContext | null = null;
  private composerEl: HTMLTextAreaElement | null = null;
  private composerDraft = "";
  private composerAttachments: File[] = [];
  private running = false;
  private runningTask: RunningTask | null = null;
  private controller: AbortController | null = null;
  private imageRunning = false;
  private imageTask: ImageTask | null = null;
  private imageController: AbortController | null = null;
  private imageStartedAt = 0;
  private imageProgressTimer = 0;
  private imageProgressEl: HTMLElement | null = null;
  private imageMode = false;
  private chatMode: ChatMode = "chat";
  private topicSavePending = new Set<string>();
  private pendingImageRequest: PendingImageRequest | null = null;
  private agentStatus: "checking" | "ready" | "missing" = "checking";
  private agentVersion = "";
  private galleryFilter: GalleryFilter = "all";
  private selectedAssetId = "";
  private galleryProblems = new Map<string, ImageProblem>();
  private galleryCheckProgress = "";
  private previewMarkdown = "";
  private previewFilePath = "";
  private previewUpdatedAt = "未刷新";
  private previewTheme = "default";
  private previewHtml = "";
  private previewRenderKey = "";
  private previewRenderError = "";
  private unsubscribeThemeService: (() => void) | null = null;
  private previewScrollRatio = 0;
  private previewRefreshTimer = 0;
  private referencedImageSyncTimer = 0;
  private editorScroller: HTMLElement | null = null;
  private editorScrollListener: (() => void) | null = null;
  private syncingScroll = false;
  private clearImageDropHandlers: (() => void) | null = null;
  private clearBlockDropHandlers: (() => void) | null = null;
  private suppressBlockHandleClick = false;
  private regeneratingAssetId = "";
  private localSkills: LocalSkill[] = [];
  private skillDiscoveryState: SkillDiscoveryState = "loading";
  private skillScanError = "";
  private skillFailureKind: "scan" | "save" | "invalid" = "scan";
  private skillScanRequestId = 0;
  private copyTaskState: CopyTaskState = "idle";
  private copyProgress = "";
  private copyController: AbortController | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: ObsidianAgentPlugin) {
    super(leaf);
  }

  override getViewType(): string {
    return VIEW_TYPE;
  }

  override getDisplayText(): string {
    return "WriteX";
  }

  override getIcon(): string {
    return WRITEX_ICON;
  }

  override async onOpen(): Promise<void> {
    this.contentEl.addClass("oa-view");
    this.registerEvent(this.app.workspace.on("file-open", file => {
      if (!(file instanceof TFile) || file.extension !== "md") return;
      if (file.path === this.notePath) return;
      this.notePath = file.path;
      this.selectionContext = null;
      this.pendingImageRequest = null;
      this.selectedAssetId = "";
      this.resetPreviewState();
      this.previewTheme = this.plugin.getNoteState(file.path).themeId ?? "default";
      this.render();
      void this.refreshSkills();
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (!(file instanceof TFile) || file.extension !== "md" || oldPath !== this.notePath) return;
      this.notePath = file.path;
      if (this.selectionContext?.filePath === oldPath) {
        this.selectionContext = { ...this.selectionContext, filePath: file.path, fileName: file.basename };
      }
      if (this.pendingImageRequest?.notePath === oldPath) this.pendingImageRequest.notePath = file.path;
      if (this.previewFilePath === oldPath) this.previewFilePath = file.path;
      this.render();
      void this.refreshSkills();
    }));
    this.registerEvent(this.app.workspace.on("editor-change", (editor, info) => {
      if (info.file?.path !== this.notePath) return;
      this.previewMarkdown = editor.getValue();
      this.previewFilePath = info.file.path;
      this.scheduleReferencedImageSync(info.file.path, this.previewMarkdown);
      if (this.activeTab !== "preview") return;
      window.clearTimeout(this.previewRefreshTimer);
      this.previewRefreshTimer = window.setTimeout(() => {
        this.previewUpdatedAt = "自动同步";
        this.render();
      }, 140);
    }));
    this.unsubscribeThemeService = this.plugin.themeService.subscribe(() => this.render());
    this.syncActiveNote();
    this.render();
    await this.refreshSkills();
    await this.checkAgent();
  }

  override async onClose(): Promise<void> {
    this.controller?.abort();
    this.imageController?.abort();
    this.copyController?.abort();
    window.clearInterval(this.imageProgressTimer);
    window.clearTimeout(this.previewRefreshTimer);
    window.clearTimeout(this.referencedImageSyncTimer);
    this.unsubscribeThemeService?.();
    this.unsubscribeThemeService = null;
    this.detachPreviewScrollSync();
    this.clearImageDropHandlers?.();
    this.clearBlockDropHandlers?.();
    this.skillScanRequestId += 1;
  }

  syncActiveNote(): void {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension !== "md") return;
    if (file.path !== this.notePath) {
      this.notePath = file.path;
      this.selectionContext = null;
      this.pendingImageRequest = null;
      this.selectedAssetId = "";
      this.resetPreviewState();
      this.previewTheme = this.plugin.getNoteState(file.path).themeId ?? "default";
    }
    this.render();
  }

  setSelectionContext(context: SelectionContext, focusComposer = true): void {
    const noteChanged = this.notePath !== context.filePath;
    this.notePath = context.filePath;
    if (noteChanged) {
      this.resetPreviewState();
      this.previewTheme = this.plugin.getNoteState(context.filePath).themeId ?? "default";
    }
    this.selectionContext = context;
    this.activeTab = "chat";
    this.render();
    if (noteChanged) void this.refreshSkills();
    if (focusComposer) window.setTimeout(() => this.composerEl?.focus(), 0);
  }

  hasComposerDraft(): boolean {
    return Boolean((this.composerEl?.value ?? this.composerDraft).trim());
  }

  refreshWritingStyle(): void {
    this.render();
  }

  private render(): void {
    const container = this.contentEl;
    this.detachPreviewScrollSync();
    this.clearBlockDropHandlers?.();
    container.empty();
    this.renderHeader(container);
    const body = container.createDiv({ cls: "oa-body" });
    if (!this.notePath) {
      this.renderNoNote(body);
      return;
    }
    if (this.activeTab === "chat") this.renderChat(body);
    if (this.activeTab === "gallery") this.renderGallery(body);
    if (this.activeTab === "preview") this.renderPreview(body);
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "oa-header" });
    const brand = header.createDiv({ cls: "oa-brand", attr: { "aria-label": "WriteX" } });
    brand.createSpan({ text: "Write" });
    brand.createSpan({ cls: "oa-brand-accent", text: "X" });

    this.renderTabs(header);
    const actions = header.createDiv({ cls: "oa-header-actions" });
    const copy = actions.createEl("button", { attr: { type: "button", "aria-label": "复制微信格式", title: "复制微信格式" } });
    setIcon(copy, "copy");
    copy.disabled = !this.notePath || !this.isPreviewThemeReady();
    copy.onclick = () => void this.copyCurrentNote();
    const sync = actions.createEl("button", { attr: { type: "button", "aria-label": "同步", title: "同步" } });
    setIcon(sync, "cloud-upload");
    sync.disabled = !this.notePath || !this.isPreviewThemeReady();
    sync.onclick = () => this.plugin.openWeChatSync(this.notePath, this.previewTheme);
    actions.createDiv({ cls: "oa-header-divider", attr: { "aria-hidden": "true" } });
    const settings = actions.createEl("button", { attr: { type: "button", "aria-label": "设置" } });
    setIcon(settings, "settings");
    settings.onclick = () => this.plugin.openSettings();
  }

  private renderTabs(container: HTMLElement): void {
    const tabs = container.createDiv({ cls: "oa-tabs", attr: { role: "tablist" } });
    const definitions: Array<{ id: ActiveTab; label: string }> = [
      { id: "chat", label: "Chat" },
      { id: "gallery", label: "图片集" },
      { id: "preview", label: "预览" },
    ];
    for (const definition of definitions) {
      const button = tabs.createEl("button", {
        attr: { type: "button", role: "tab", "aria-selected": String(this.activeTab === definition.id) },
      });
      button.toggleClass("is-active", this.activeTab === definition.id);
      button.createSpan({ text: definition.label });
      button.onclick = () => void this.switchTab(definition.id);
    }
  }

  private renderNoNote(container: HTMLElement): void {
    const empty = container.createDiv({ cls: "oa-empty" });
    const icon = empty.createSpan();
    setIcon(icon, "file-text");
    empty.createEl("strong", { text: "先打开一篇 Markdown 笔记" });
    empty.createEl("p", { text: "Agent 会把当前笔记作为写作上下文。" });
  }

  private renderChat(container: HTMLElement): void {
    const state = this.plugin.getNoteState(this.notePath);
    const currentAgent = this.plugin.agentSettings.activeChatAgent;
    const currentAgentLabel = AGENT_LABELS[currentAgent];
    const stream = container.createDiv({ cls: "oa-chat-stream" });
    if (!state.messages.length) this.renderChatWelcome(stream);
    for (const message of state.messages) this.renderMessage(stream, message, state.assets);
    if (this.pendingImageRequest) this.renderPendingImageRequest(stream, this.pendingImageRequest);
    if (this.running) {
      const progress = stream.createDiv({ cls: "oa-message oa-message-assistant oa-message-progress" });
      const progressLabel = `${currentAgentLabel} 正在处理`;
      progress.createEl("strong", { text: progressLabel });
      progress.createDiv({ cls: "oa-dots" }).setText("•••");
    }
    if (this.imageRunning) {
      const progress = stream.createDiv({
        cls: "oa-message oa-message-assistant oa-message-progress oa-image-progress",
        attr: { role: "status", "aria-live": "polite" },
      });
      const heading = progress.createDiv({ cls: "oa-image-progress-heading" });
      const icon = heading.createSpan({ cls: "oa-image-progress-spinner" });
      setIcon(icon, "loader-circle");
      heading.createEl("strong", { text: this.imageTask === "openai-image" ? "图片 API 正在生成" : "Codex 正在生成图片" });
      this.imageProgressEl = progress.createEl("span", { cls: "oa-image-progress-time" });
      this.updateImageProgress();
      progress.createEl("small", { text: "耗时由当前模型和服务决定，可能需要几分钟。你可以退出生图模式继续 Chat，完成后会自动保存到图片集。" });
      if (this.imageController) {
        const stop = progress.createEl("button", { text: "停止生图", attr: { type: "button" } });
        stop.onclick = () => this.stopImageRun();
      }
    }
    const composer = container.createDiv({ cls: "oa-composer-wrap" });
    const activeSkill = findLocalSkillByPath(this.localSkills, state.activeSkillPath);
    if (this.selectionContext) this.renderSelectionChip(composer, this.selectionContext);
    const form = composer.createEl("form", { cls: "oa-composer" });
    const skillRow = form.createDiv({ cls: "oa-composer-skill-row" });
    const skillFailureLabel = this.skillFailureKind === "save"
      ? "Skill 状态保存失败"
      : this.skillFailureKind === "invalid"
        ? "Skill 文件无效"
        : "Skill 扫描失败";
    const skillLabel = this.skillDiscoveryState === "loading"
      ? "查找中…"
      : this.skillDiscoveryState === "failed"
        ? "扫描失败"
        : activeSkill
          ? activeSkill.name
          : this.skillDiscoveryState === "empty"
            ? "安装 Skill"
            : "Skill";
    const skillTitle = this.skillDiscoveryState === "failed"
      ? `${skillFailureLabel}：${this.skillScanError || "未知错误"}。点击重新扫描。`
      : activeSkill
        ? `已启用 ${activeSkill.name}，点击更换`
        : this.skillDiscoveryState === "empty"
          ? "当前 Vault 未发现 Skill，点击安装或重新扫描"
          : this.skillDiscoveryState === "loading"
            ? "正在查找当前 Vault 的 Skill"
            : "选择 Skill";
    const skillPicker = skillRow.createEl("button", {
      cls: `oa-composer-skill-picker${activeSkill ? " is-active" : ""}`,
      attr: {
        type: "button",
        title: skillTitle,
        "aria-label": skillTitle,
      },
    });
    if (this.skillDiscoveryState === "loading") {
      skillRow.createSpan({
        cls: "oa-visually-hidden",
        text: "正在查找 Skill…",
        attr: { role: "status", "aria-live": "polite" },
      });
    }
    const skillIcon = skillPicker.createSpan({ cls: this.skillDiscoveryState === "loading" ? "oa-skill-spinner" : "" });
    setIcon(skillIcon, this.skillDiscoveryState === "loading"
      ? "loader-circle"
      : this.skillDiscoveryState === "failed"
        ? "circle-alert"
        : activeSkill
          ? "wand-sparkles"
          : "plus");
    skillPicker.createSpan({ text: skillLabel });
    skillPicker.disabled = this.running || this.skillDiscoveryState === "loading";
    skillPicker.onclick = () => {
      if (this.skillDiscoveryState === "failed") void this.refreshSkills(true);
      else this.openSkillPicker();
    };
    if (state.activeSkillPath) {
      const removeSkill = skillRow.createEl("button", {
        cls: "oa-composer-skill-remove",
        attr: { type: "button", "aria-label": "停用当前 Skill", title: "停用当前 Skill" },
      });
      setIcon(removeSkill, "x");
      removeSkill.disabled = this.running;
      removeSkill.onclick = () => void this.selectChatSkill("").catch(error => new Notice(errorMessage(error)));
    }
    const skillTools = skillRow.createDiv({ cls: "oa-skill-row-tools" });
    const history = skillTools.createEl("button", { cls: "oa-tool-button", attr: { type: "button", "aria-label": "Chat 历史", title: "Chat 历史" } });
    setIcon(history, "history");
    history.onclick = () => new ConversationHistoryModal(this.app, this.plugin).open();
    const topicLabel = `选题库，${this.plugin.data.topics.length} 条`;
    const topics = skillTools.createEl("button", {
      cls: "oa-tool-button oa-topic-library-button",
      attr: { type: "button", "aria-label": topicLabel, title: topicLabel },
    });
    setIcon(topics, "lightbulb");
    if (this.plugin.data.topics.length) topics.createEl("small", { cls: "oa-topic-count", text: String(this.plugin.data.topics.length) });
    topics.onclick = () => void this.plugin.activateTopicLibrary("", this.notePath);
    const newChat = skillTools.createEl("button", { cls: "oa-tool-button", attr: { type: "button", "aria-label": "新对话", title: "新对话" } });
    setIcon(newChat, "square-pen");
    newChat.disabled = this.imageRunning;
    newChat.onclick = () => void this.startNewConversation();
    if (!this.imageMode) {
      const shortcuts = form.createDiv({ cls: "oa-chat-shortcuts" });
      const outline = shortcuts.createEl("button", {
        attr: {
          type: "button",
          "aria-label": "大纲：通过五步问答搭建文章骨架",
          title: "通过五步问答搭建文章骨架",
        },
      });
      const outlineIcon = outline.createSpan();
      setIcon(outlineIcon, "list-tree");
      outline.createSpan({ text: "大纲" });
      outline.disabled = this.running;
      outline.onclick = () => this.startOutline();
      const cut = shortcuts.createEl("button", {
        attr: {
          type: "button",
          "aria-label": "找切口：随机准备 3 个观察方向",
          title: "从真实材料里随机找 3 个写作切口",
        },
      });
      const cutIcon = cut.createSpan();
      setIcon(cutIcon, "scan-search");
      cut.createSpan({ text: "找切口" });
      cut.disabled = this.running;
      cut.onclick = () => this.startCutFinding();
      const image = shortcuts.createEl("button", {
        attr: {
          type: "button",
          "aria-label": currentAgent === "codex" ? "生成图片" : "生图当前只支持 Codex",
          title: currentAgent === "codex" ? "生成图片" : "生图当前只支持 Codex，请先切回 Codex",
        },
      });
      const imageIcon = image.createSpan();
      setIcon(imageIcon, "image");
      image.createSpan({ text: "生成图片" });
      image.disabled = currentAgent !== "codex" || this.imageRunning;
      image.onclick = () => {
        this.imageMode = true;
        this.render();
        window.setTimeout(() => this.composerEl?.focus(), 0);
      };
    }
    if (this.imageMode) {
      const mode = form.createDiv({ cls: "oa-image-mode" });
      const modeIcon = mode.createSpan();
      setIcon(modeIcon, "image");
      mode.createSpan({ text: "生成图片" });
      const size = mode.createEl("select", {
        cls: "oa-image-size-select",
        attr: { "aria-label": "生成图片尺寸", title: "生成图片尺寸" },
      });
      for (const [value, label] of [
        ["1536x1024", "横图 3:2"],
        ["1024x1024", "方图 1:1"],
        ["1024x1536", "竖图 2:3"],
      ] as const) size.createEl("option", { value, text: label });
      size.value = this.plugin.agentSettings.imageSize;
      size.onchange = () => {
        this.plugin.agentSettings.imageSize = size.value as ImageSize;
        void this.plugin.persist();
      };
      mode.createEl("small", { text: "可能需要几分钟" });
      const closeMode = mode.createEl("button", { attr: { type: "button", "aria-label": "退出图片生成" } });
      setIcon(closeMode, "x");
      closeMode.onclick = () => {
        this.imageMode = false;
        this.render();
      };
    }
    this.renderComposerAttachments(form);
    const textarea = form.createEl("textarea", {
      attr: {
        rows: "3",
        placeholder: this.imageMode
          ? "描述要生成的配图…"
          : this.chatMode === "plan"
            ? `让 ${currentAgentLabel} 先梳理目标、约束和步骤…`
            : `让 ${currentAgentLabel} 改写、续写或分析…`,
        "aria-label": `发送给 ${currentAgentLabel}`,
      },
    });
    this.composerEl = textarea;
    textarea.value = this.composerDraft;
    autoGrow(textarea);
    textarea.oninput = () => {
      this.composerDraft = textarea.value;
      autoGrow(textarea);
    };
    textarea.onpaste = event => {
      const files = [...event.clipboardData?.files ?? []];
      if (!files.length) return;
      event.preventDefault();
      this.addComposerAttachments(files);
    };
    textarea.onkeydown = event => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        form.requestSubmit();
      }
    };
    const modeRow = form.createDiv({ cls: "oa-composer-mode-row" });
    const modelControls = modeRow.createDiv({ cls: "oa-model-controls" });
    const currentModel = configuredAgentModel(this.plugin.agentSettings, currentAgent);
    const currentModelLabel = AGENT_MODELS[currentAgent].find(option => option.value === currentModel)?.label ?? "默认";
    const currentReasoning = configuredCodexReasoningEffort(this.plugin.agentSettings);
    const agentModelPicker = modelControls.createEl("button", {
      cls: "oa-agent-model-picker",
      attr: {
        type: "button",
        "aria-label": `Agent 与模型：${currentAgentLabel} · ${currentModelLabel}`,
        title: "切换 Agent 与模型",
      },
    });
    const agentStatus = agentModelPicker.createSpan({ cls: `oa-codex-status is-${this.agentStatus}` });
    agentStatus.createSpan({ cls: "oa-codex-dot", attr: { "aria-hidden": "true" } });
    agentStatus.setAttribute("title", this.agentVersion || (this.agentStatus === "missing" ? `${currentAgentLabel} 未连接` : `${currentAgentLabel} 检测中`));
    agentModelPicker.createSpan({ cls: "oa-agent-model-label", text: `${currentAgentLabel} · ${currentModelLabel}` });
    const chevron = agentModelPicker.createSpan({ cls: "oa-agent-model-chevron" });
    setIcon(chevron, "chevron-down");
    agentModelPicker.disabled = this.running;
    agentModelPicker.onclick = event => {
      const menu = new Menu();
      for (const [agentIndex, agentId] of CHAT_AGENT_IDS.entries()) {
        menu.addItem(item => item.setTitle(AGENT_LABELS[agentId]).setIsLabel(true));
        for (const option of AGENT_MODELS[agentId]) {
          const selected = agentId === currentAgent && option.value === currentModel;
          menu.addItem(item => item
            .setTitle(`${AGENT_LABELS[agentId]} · ${option.label}`)
            .setChecked(selected ? true : null)
            .onClick(async () => {
              const agentChanged = this.plugin.agentSettings.activeChatAgent !== agentId;
              this.plugin.agentSettings.activeChatAgent = agentId;
              setConfiguredAgentModel(this.plugin.agentSettings, agentId, option.value);
              this.imageMode = false;
              if (agentChanged) {
                this.agentStatus = "checking";
                this.agentVersion = "";
              }
              await this.plugin.persist();
              this.render();
              if (agentChanged) await this.checkAgent();
              else new Notice(`已切换：${AGENT_LABELS[agentId]} · ${option.label}`);
            }));
        }
        if (agentIndex < CHAT_AGENT_IDS.length - 1) menu.addSeparator();
      }
      menu.showAtMouseEvent(event);
    };

    if (currentAgent === "codex") {
      const reasoningPicker = modelControls.createEl("button", {
        cls: "oa-reasoning-picker",
        attr: {
          type: "button",
          "aria-label": `Codex 推理强度：${codexReasoningLabel(currentReasoning)}`,
          title: "Codex 推理强度；强度越高通常越慢，也会消耗更多会员额度",
        },
      });
      const reasoningIcon = reasoningPicker.createSpan();
      setIcon(reasoningIcon, "gauge");
      reasoningPicker.createSpan({ text: codexReasoningLabel(currentReasoning) });
      reasoningPicker.disabled = this.running;
      reasoningPicker.onclick = event => {
        const menu = new Menu();
        menu.addItem(item => item.setTitle("推理强度").setIsLabel(true));
        for (const option of CODEX_REASONING_OPTIONS) {
          menu.addItem(item => item
            .setTitle(option.value ? option.label : "模型默认")
            .setChecked(option.value === currentReasoning ? true : null)
            .onClick(async () => {
              this.plugin.agentSettings.codexReasoningEffort = option.value;
              await this.plugin.persist();
              this.render();
              new Notice(`Codex 推理强度：${option.value ? option.label : "模型默认"}`);
            }));
        }
        menu.showAtMouseEvent(event);
      };
    }

    const planSwitch = modelControls.createEl("label", {
      cls: "oa-plan-switch",
      attr: { title: "计划模式：先梳理目标、约束和步骤" },
    });
    planSwitch.createSpan({ text: "计划模式" });
    const planInput = planSwitch.createEl("input", {
      attr: { type: "checkbox", role: "switch", "aria-label": "计划模式" },
    });
    planInput.checked = this.chatMode === "plan";
    planInput.disabled = this.imageMode || this.running;
    planSwitch.createSpan({ cls: "oa-plan-switch-track", attr: { "aria-hidden": "true" } });
    planInput.onchange = () => {
      this.chatMode = planInput.checked ? "plan" : "chat";
      this.render();
      window.setTimeout(() => this.composerEl?.focus(), 0);
    };
    const writingStyle = this.plugin.data.writingStyleProfile;
    const styleSwitch = modelControls.createEl("label", {
      cls: "oa-plan-switch oa-writing-style-switch",
      attr: { title: writingStyle ? "我的文风：点击文字管理档案" : "建立我的文风" },
    });
    const styleLabel = styleSwitch.createSpan({ text: "我的文风" });
    styleLabel.onclick = event => {
      event.preventDefault();
      new WritingStyleModal(this.app, this.plugin, this.selectionContext).open();
    };
    const styleInput = styleSwitch.createEl("input", { attr: { type: "checkbox", role: "switch", "aria-label": "我的文风" } });
    styleInput.checked = styleEnabled(writingStyle, state.writingStyleEnabled);
    styleInput.disabled = !writingStyle || this.imageMode || this.running;
    styleSwitch.createSpan({ cls: "oa-plan-switch-track", attr: { "aria-hidden": "true" } });
    styleInput.onchange = () => {
      void this.plugin.setWritingStyleEnabled(this.notePath, styleInput.checked)
        .then(() => this.render())
        .catch(error => { styleInput.checked = !styleInput.checked; new Notice(errorMessage(error)); });
    };

    const attachmentInput = modeRow.createEl("input", { attr: { type: "file", multiple: "" } });
    attachmentInput.addClass("oa-visually-hidden");
    attachmentInput.onchange = () => {
      this.addComposerAttachments([...attachmentInput.files ?? []]);
      attachmentInput.value = "";
    };
    const attach = modeRow.createEl("button", {
      cls: "oa-composer-attach",
      attr: { type: "button", "aria-label": "添加图片或附件", title: "添加图片或附件" },
    });
    setIcon(attach, "paperclip");
    attach.disabled = this.running || this.imageMode;
    attach.onclick = () => attachmentInput.click();

    const send = modeRow.createEl("button", {
      cls: "oa-send",
      attr: {
        type: (this.imageMode ? this.imageRunning : this.running) ? "button" : "submit",
        "aria-label": this.imageMode && this.imageRunning ? "图片生成进行中" : this.running ? "停止" : "发送",
      },
    });
    setIcon(send, this.imageMode && this.imageRunning ? "loader-circle" : this.running ? "square" : "send");
    send.disabled = this.imageMode ? this.imageRunning : (!this.running && this.agentStatus === "missing");
    if (this.running && !this.imageMode) send.onclick = () => this.stopRun();
    form.onsubmit = event => {
      event.preventDefault();
      void this.sendMessage(textarea.value);
    };
    form.ondragover = event => {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      form.addClass("is-dragging-attachments");
    };
    form.ondragleave = event => {
      if (event.target === form) form.removeClass("is-dragging-attachments");
    };
    form.ondrop = event => {
      const files = [...event.dataTransfer?.files ?? []];
      if (!files.length) return;
      event.preventDefault();
      form.removeClass("is-dragging-attachments");
      this.addComposerAttachments(files);
    };
    form.createEl("small", {
      cls: "oa-agent-cost",
      text: `Enter 发送 · Shift+Enter 换行 · 使用 ${currentAgentLabel} 账号额度 · WriteX 积分 0`,
    });
    window.setTimeout(() => { stream.scrollTop = stream.scrollHeight; }, 0);
  }

  private renderChatWelcome(container: HTMLElement): void {
    const agentLabel = AGENT_LABELS[this.plugin.agentSettings.activeChatAgent];
    const welcome = container.createDiv({ cls: "oa-welcome" });
    const icon = welcome.createSpan();
    setIcon(icon, WRITEX_ICON);
    welcome.createEl("strong", { text: this.selectionContext ? "选中文字已经进入 Chat" : "从当前笔记继续写" });
    welcome.createEl("p", {
      text: this.selectionContext
        ? `补充你想怎么处理，再发送给 ${agentLabel}。`
        : "可以直接提问，也可以先在正文中划词，右键发送到 Chat。",
    });
    const suggestions = welcome.createDiv({ cls: "oa-suggestions" });
    for (const text of ["把选中内容改得更具体", "梳理这篇文章的大纲", "给我 3 个更有冲突的标题"]) {
      const button = suggestions.createEl("button", { text, attr: { type: "button" } });
      button.onclick = () => {
        if (this.composerEl) {
          this.composerEl.value = text;
          this.composerDraft = text;
          autoGrow(this.composerEl);
          this.composerEl.focus();
        }
      };
    }
  }

  private addComposerAttachments(files: File[]): void {
    if (!files.length || this.imageMode) return;
    const next = [...this.composerAttachments, ...files];
    const error = validateChatAttachmentInputs(next);
    if (error) {
      new Notice(error);
      return;
    }
    this.composerAttachments = next;
    this.render();
    window.setTimeout(() => this.composerEl?.focus(), 0);
  }

  private renderComposerAttachments(container: HTMLElement): void {
    if (!this.composerAttachments.length) return;
    const attachments = container.createDiv({ cls: "oa-composer-attachments", attr: { "aria-label": "待发送附件" } });
    for (const [index, file] of this.composerAttachments.entries()) {
      const chip = attachments.createDiv({ cls: `oa-composer-attachment${file.type.startsWith("image/") ? " is-image" : ""}` });
      const icon = chip.createSpan();
      setIcon(icon, file.type.startsWith("image/") ? "image" : "paperclip");
      chip.createSpan({ text: file.name || "未命名附件" });
      chip.createEl("small", { text: formatBytes(file.size) });
      const remove = chip.createEl("button", {
        attr: { type: "button", "aria-label": `移除附件 ${file.name || "未命名附件"}`, title: "移除附件" },
      });
      setIcon(remove, "x");
      remove.onclick = () => {
        this.composerAttachments.splice(index, 1);
        this.render();
        window.setTimeout(() => this.composerEl?.focus(), 0);
      };
    }
  }

  private startOutline(): void {
    this.prepareComposerDraft(OUTLINE_PROMPT, { plan: true, prefix: true });
  }

  private startCutFinding(): void {
    this.prepareComposerDraft(buildCutPrompt(sampleCutLenses()), { plan: true, prefix: true });
  }

  private prepareComposerDraft(target: string, options: { plan?: boolean; prefix?: boolean; beforeApply?: () => void } = {}): boolean {
    const current = this.composerEl?.value ?? this.composerDraft;
    if (!options.prefix && current && current !== target) {
      new Notice("输入框已有内容，请先发送或清空。");
      this.composerEl?.focus();
      return false;
    }
    options.beforeApply?.();
    if (options.plan) this.chatMode = "plan";
    this.composerDraft = options.prefix && current ? `${target}\n\n${current}` : target;
    this.render();
    window.setTimeout(() => this.composerEl?.focus(), 0);
    return true;
  }

  prepareTopicDraft(topic: TopicIdea): boolean {
    const prompt = topic.sourceKind === "manual"
      ? `请帮我把这个选题发展成一篇可写的文章：\n\n${topic.title}`
      : `请基于这个选题继续创作：\n\n${topic.content}`;
    return this.prepareComposerDraft(prompt, {
      beforeApply: () => {
        this.activeTab = "chat";
        this.imageMode = false;
      },
    });
  }

  private renderPendingImageRequest(container: HTMLElement, pending: PendingImageRequest): void {
    const chooser = container.createDiv({ cls: "oa-image-provider" });
    const heading = chooser.createDiv({ cls: "oa-image-provider-heading" });
    const icon = heading.createSpan();
    setIcon(icon, "image-off");
    const copy = heading.createDiv();
    copy.createEl("strong", { text: "当前 Agent 未能生成图片" });
    copy.createEl("span", { text: pending.error ?? "请选择下一步。WriteX 不会自动切换到收费服务。" });

    const actions = chooser.createDiv({ cls: "oa-image-provider-actions" });
    const retry = actions.createEl("button", { attr: { type: "button" } });
    const retryIcon = retry.createSpan();
    setIcon(retryIcon, "refresh-cw");
    retry.createSpan({ text: "重试 Agent" });
    retry.disabled = this.imageRunning;
    retry.onclick = () => {
      this.plugin.resetAgentImageCapability();
      void this.runPendingImageWithAgent();
    };

    const ownApi = actions.createEl("button", { cls: "mod-cta", attr: { type: "button" } });
    const apiIcon = ownApi.createSpan();
    setIcon(apiIcon, "key-round");
    ownApi.createSpan({ text: this.plugin.agentSettings.hasImageApiKey ? "使用我的 OpenAI API" : "配置图片 API" });
    ownApi.disabled = this.imageRunning;
    ownApi.onclick = () => void this.useOpenAIForPendingImage();

    const cloud = actions.createEl("button", {
      text: "WriteX Cloud · 即将推出",
      attr: { type: "button", title: "v0.1 不调用、不扣积分" },
    });
    cloud.disabled = true;

    const promptOnly = actions.createEl("button", { attr: { type: "button" } });
    const promptIcon = promptOnly.createSpan();
    setIcon(promptIcon, "text-cursor-input");
    promptOnly.createSpan({ text: "只生成提示词" });
    promptOnly.disabled = this.running;
    promptOnly.onclick = () => void this.generatePromptForPendingImage();

    chooser.createEl("small", {
      text: "Agent 与自带 API 均不扣 WriteX 积分；自带 API 费用由你的 OpenAI 账户承担。",
    });
  }

  private renderMessage(container: HTMLElement, message: ChatMessage, assets: ImageAsset[]): void {
    const item = container.createDiv({
      cls: `oa-message ${message.role === "user" ? "oa-message-user" : "oa-message-assistant"}`,
    });
    const meta = item.createDiv({ cls: "oa-message-meta" });
    const messageAgent = message.agent ?? "codex";
    meta.createEl("strong", { text: message.role === "user" ? "你" : AGENT_LABELS[messageAgent] });
    meta.createEl("time", { text: formatTime(message.createdAt) });
    if (message.model) meta.createSpan({ cls: "oa-message-provenance", text: message.model });
    if (message.reasoningEffort) meta.createSpan({ cls: "oa-message-provenance", text: `推理${codexReasoningLabel(message.reasoningEffort)}` });
    if (message.skill) {
      const skill = meta.createSpan({ cls: "oa-message-mode", text: message.skill.name });
      skill.setAttribute("title", `${message.skill.path}\nSHA-256 ${message.skill.sourceHash}`);
    }
    if (message.writingStyle) {
      const style = meta.createSpan({ cls: "oa-message-mode", text: `我的文风 · v${message.writingStyle.revision}` });
      style.setAttribute("title", `SHA-256 ${message.writingStyle.sourceHash}`);
    }
    if (message.context?.text.trim()) {
      const context = item.createDiv({ cls: "oa-message-context" });
      const contextIcon = context.createSpan();
      setIcon(contextIcon, "text-select");
      context.createSpan({ text: `引用 ${message.context.text.length} 字选区` });
      context.setAttribute("title", message.context.text);
    }
    if (message.attachments?.length) this.renderMessageAttachments(item, message.attachments);
    if (message.mode === "plan") meta.createSpan({ cls: "oa-message-mode", text: "计划模式" });
    if (message.kind === "image" && message.assetId) {
      const asset = assets.find(candidate => candidate.id === message.assetId);
      if (asset) {
        const image = item.createEl("img", {
          cls: "oa-chat-image",
          attr: { src: this.resourcePath(asset), alt: asset.prompt ?? asset.name },
        });
        image.onclick = () => {
          this.activeTab = "gallery";
          this.selectedAssetId = asset.id;
          this.render();
        };
        item.createEl("p", { cls: "oa-image-record", text: `已保存到图片集 · ${imageProviderLabel(asset)} · WriteX 积分 0` });
      } else {
        item.createEl("p", { text: "图片文件已经移动或删除。" });
      }
    } else {
      const body = item.createDiv({ cls: "oa-message-body markdown-rendered" });
      if (message.role === "assistant" && message.kind === "text") {
        this.renderAssistantBlocks(body, message);
      } else {
        void MarkdownRenderer.render(this.app, message.content, body, this.notePath, this);
      }
    }
    if (message.role === "assistant" && message.kind === "text") this.renderMessageActions(item, message);
  }

  private renderMessageAttachments(container: HTMLElement, attachments: ChatAttachment[]): void {
    const list = container.createDiv({ cls: "oa-message-attachments", attr: { "aria-label": `已附 ${attachments.length} 个上下文文件` } });
    for (const attachment of attachments) {
      const file = this.app.vault.getAbstractFileByPath(attachment.filePath);
      const item = list.createDiv({ cls: `oa-message-attachment${attachment.kind === "image" ? " is-image" : ""}` });
      if (attachment.kind === "image" && file instanceof TFile) {
        item.createEl("img", { attr: { src: this.app.vault.getResourcePath(file), alt: attachment.name } });
      } else {
        const icon = item.createSpan();
        setIcon(icon, attachment.kind === "image" ? "image-off" : "paperclip");
      }
      const detail = item.createDiv();
      detail.createEl("strong", { text: attachment.name });
      detail.createEl("small", { text: `${attachment.mimeType} · ${formatBytes(attachment.byteLength)}` });
      if (!(file instanceof TFile)) item.createEl("small", { cls: "oa-message-attachment-missing", text: "文件已移动或删除" });
    }
  }

  private renderAssistantBlocks(container: HTMLElement, message: ChatMessage): void {
    const blocks = splitAssistantMarkdownBlocks(message.id, message.content);
    if (!blocks.length) {
      void MarkdownRenderer.render(this.app, message.content, container, this.notePath, this);
      return;
    }
    for (const block of blocks) {
      const blockEl = container.createDiv({ cls: "oa-assistant-block" });
      const content = blockEl.createDiv({ cls: "oa-assistant-block-content" });
      void MarkdownRenderer.render(this.app, block.markdown, content, this.notePath, this);
      const handle = blockEl.createEl("button", {
        cls: "oa-block-drag-handle",
        attr: {
          type: "button",
          title: "拖动或插入这一块",
          "aria-label": "拖动或插入这一块",
        },
      });
      setIcon(handle, "hand");
      handle.onclick = event => {
        if (this.suppressBlockHandleClick) {
          event.preventDefault();
          this.suppressBlockHandleClick = false;
          return;
        }
        void this.plugin.insertAssistantBlock(this.notePath, block.markdown)
          .catch(error => new Notice(errorMessage(error)));
      };
      handle.onpointerdown = event => this.armAssistantBlockDrag(event, blockEl, block.markdown);
    }
  }

  private renderMessageActions(container: HTMLElement, message: ChatMessage): void {
    const actions = container.createDiv({ cls: "oa-message-actions" });
    const savedTopic = this.plugin.findTopicByMessage(message.id);
    const saveTopic = actions.createEl("button", {
      cls: savedTopic ? "oa-save-topic is-saved" : "oa-save-topic",
      attr: {
        type: "button",
        title: savedTopic ? "已收进选题库" : "收为选题",
        "aria-label": savedTopic ? "已收住" : "收为选题",
      },
    });
    const saveTopicIcon = saveTopic.createSpan();
    setIcon(saveTopicIcon, savedTopic ? "bookmark-check" : "bookmark-plus");
    saveTopic.createSpan({ text: savedTopic ? "已收住" : "收为选题" });
    saveTopic.disabled = this.topicSavePending.has(message.id);
    saveTopic.onclick = async () => {
      if (savedTopic) {
        void this.plugin.activateTopicLibrary(savedTopic.id, this.notePath);
        return;
      }
      this.topicSavePending.add(message.id);
      saveTopic.disabled = true;
      try {
        await this.plugin.saveTopicFromMessage(this.notePath, message.id);
        new Notice("已收进选题库。");
      } catch (error) {
        new Notice(errorMessage(error));
      } finally {
        this.topicSavePending.delete(message.id);
        this.render();
      }
    };
    if (message.context) this.actionButton(actions, "replace", "对比替换", async () => { new SelectionCompareModal(this.app, this.plugin, message.context!, message.content).open(); }, "oa-replace-action");
    this.actionButton(
      actions,
      "text-cursor-input",
      "插入",
      () => this.plugin.insertAtCursor(this.notePath, message.content),
      "",
      "插入当前光标位置",
    );
    this.actionButton(actions, "list-end", "追加文末", () => this.plugin.appendToNote(this.notePath, message.content));
    this.actionButton(actions, "copy", "复制", () => writeClipboardText(message.content, {
      electronWriteText: value => {
        const electron = require("electron") as { clipboard: { writeText(text: string): void } };
        electron.clipboard.writeText(value);
      },
      browserWriteText: value => navigator.clipboard.writeText(value),
    }));
    const feedback = actions.createDiv({ cls: "oa-message-feedback", attr: { "aria-label": "评价这条回答" } });
    for (const definition of [
      { rating: "up" as const, icon: "thumbs-up", label: "好回答" },
      { rating: "down" as const, icon: "thumbs-down", label: "回答需改进" },
    ]) {
      const button = feedback.createEl("button", {
        cls: message.feedback === definition.rating ? "is-active" : "",
        attr: {
          type: "button",
          title: definition.label,
          "aria-label": definition.label,
          "aria-pressed": String(message.feedback === definition.rating),
        },
      });
      setIcon(button, definition.icon);
      button.onclick = async () => {
        const next = message.feedback === definition.rating ? undefined : definition.rating;
        await this.plugin.setMessageFeedback(this.notePath, message.id, next);
        new Notice(next ? "已记入本地反馈 memory。" : "已移除这条反馈。");
        this.render();
      };
    }
  }

  private actionButton(
    container: HTMLElement,
    iconName: string,
    label: string,
    action: () => Promise<void>,
    className = "",
    accessibleLabel = label,
  ): void {
    const button = container.createEl("button", {
      cls: className,
      attr: { type: "button", title: accessibleLabel, "aria-label": accessibleLabel },
    });
    const icon = button.createSpan();
    setIcon(icon, iconName);
    button.createSpan({ text: label });
    button.onclick = async () => {
      try {
        await action();
        new Notice(`${label}完成。`);
      } catch (error) {
        new Notice(errorMessage(error));
      }
    };
  }

  private renderSelectionChip(container: HTMLElement, context: SelectionContext): void {
    const row = container.createDiv({ cls: "oa-selection-chip" });
    const icon = row.createSpan();
    setIcon(icon, "text-select");
    const content = row.createDiv();
    content.createEl("strong", { text: `${context.fileName} · 已选中 ${characterCount(context.text)} 字` });
    content.createEl("span", { text: context.text.replace(/\s+/g, " ").trim().slice(0, 88) });
    row.setAttribute("title", context.text);
    const close = row.createEl("button", { attr: { type: "button", "aria-label": "移除选区上下文" } });
    setIcon(close, "x");
    close.onclick = () => {
      this.selectionContext = null;
      this.render();
      window.setTimeout(() => this.composerEl?.focus(), 0);
    };
  }

  private renderGallery(container: HTMLElement): void {
    const state = this.plugin.getNoteState(this.notePath);
    const toolbar = container.createDiv({ cls: "oa-gallery-toolbar" });
    const filters: Array<{ id: GalleryFilter; label: string }> = [
      { id: "all", label: "全部" },
      { id: "generated", label: "AI 生成" },
      { id: "manual", label: "手动导入" },
      { id: "original", label: "原图" },
      { id: "optimized", label: "公众号优化" },
    ];
    const picker = toolbar.createDiv({ cls: "oa-filter-picker" });
    for (const filter of filters) {
      const count = filter.id === "all" ? state.assets.length : state.assets.filter(asset => asset.source === filter.id).length;
      const button = picker.createEl("button", { attr: { type: "button" } });
      button.toggleClass("is-active", this.galleryFilter === filter.id);
      button.createSpan({ text: filter.label });
      button.createEl("small", { text: String(count) });
      button.onclick = () => {
        this.galleryFilter = filter.id;
        this.selectedAssetId = "";
        this.render();
      };
    }
    const input = toolbar.createEl("input", { attr: { type: "file", accept: "image/*", multiple: "" } });
    input.addClass("oa-visually-hidden");
    input.onchange = () => void this.importFiles(input.files);
    const importButton = toolbar.createEl("button", { cls: "oa-import", attr: { type: "button" } });
    const importIcon = importButton.createSpan();
    setIcon(importIcon, "upload");
    importButton.createSpan({ text: "导入" });
    importButton.onclick = () => input.click();
    const check = toolbar.createEl("button", { text: this.galleryCheckProgress || "检查图片", attr: { type: "button" } });
    check.disabled = Boolean(this.galleryCheckProgress);
    check.onclick = () => void this.checkGalleryImages(state.assets);
    if (this.galleryProblems.size) toolbar.createEl("small", { text: galleryProblemSummary([...this.galleryProblems.values()]) });

    const assets = state.assets.filter(asset => this.galleryFilter === "all" || asset.source === this.galleryFilter);
    if (!assets.length) {
      const empty = container.createDiv({ cls: "oa-gallery-empty" });
      const emptyIcon = empty.createSpan();
      setIcon(emptyIcon, "images");
      empty.createEl("strong", { text: this.galleryFilter === "generated" ? "还没有 AI 图片" : "图片集还是空的" });
      empty.createEl("p", { text: "可以在 Chat 中生成，或从本地导入。" });
      const button = empty.createEl("button", { text: "导入图片", attr: { type: "button" } });
      button.onclick = () => input.click();
      return;
    }
    if (!assets.some(asset => asset.id === this.selectedAssetId)) this.selectedAssetId = assets[0].id;
    const grid = container.createDiv({ cls: "oa-gallery-grid" });
    for (const asset of assets) {
      const card = grid.createEl("button", { cls: "oa-asset-card", attr: { type: "button" } });
      card.setAttribute("title", "点击管理；拖到正文可插入图片");
      card.onpointerdown = event => this.armImageDrag(event, card, asset);
      card.toggleClass("is-selected", asset.id === this.selectedAssetId);
      const problem = this.galleryProblems.get(asset.id);
      card.toggleClass("is-image-problem", problem?.status === "unrepairable");
      if (problem?.status === "unrepairable") card.setAttribute("title", `图片异常：${problem.reason}`);
      card.toggleClass("is-generating", asset.id === this.regeneratingAssetId);
      const viewport = card.createDiv({ cls: "oa-asset-viewport" });
      const image = viewport.createEl("img", { attr: { src: this.resourcePath(asset), alt: asset.prompt ?? asset.name } });
      image.draggable = false;
      if (asset.id === this.regeneratingAssetId) {
        const loading = viewport.createDiv({ cls: "oa-asset-loading" });
        const loadingIcon = loading.createSpan();
        setIcon(loadingIcon, "refresh-cw");
        loading.createSpan({ text: "重新生成中" });
        this.imageProgressEl = loading.createSpan({ cls: "oa-image-progress-time" });
        this.updateImageProgress();
      }
      const meta = card.createDiv({ cls: "oa-asset-meta" });
      meta.createSpan({ cls: "oa-asset-source", text: imageProviderLabel(asset) });
      meta.createEl("small", { text: asset.name });
      card.onclick = event => {
        if (card.hasClass("is-dragging")) {
          event.preventDefault();
          return;
        }
        this.selectedAssetId = asset.id;
        this.render();
      };
    }
    const selected = assets.find(asset => asset.id === this.selectedAssetId);
    if (selected) this.renderGalleryActions(container, selected);
  }

  private async checkGalleryImages(assets: ImageAsset[]): Promise<void> {
    this.galleryProblems.clear();
    for (let index = 0; index < assets.length; index += 1) {
      const asset = assets[index];
      this.galleryCheckProgress = `检查 ${index + 1}/${assets.length}`;
      this.render();
      const file = this.app.vault.getAbstractFileByPath(asset.filePath);
      let inspection;
      try {
        inspection = file instanceof TFile
          ? inspectImage(await this.app.vault.readBinary(file), { fileName: file.name })
          : missingImageInspection("图片文件已移动或删除。");
      } catch (error) {
        inspection = missingImageInspection(errorMessage(error));
      }
      this.galleryProblems.set(asset.id, describeImageProblem({ source: asset.filePath, inspection }));
    }
    this.galleryCheckProgress = "";
    this.render();
  }

  private renderGalleryActions(container: HTMLElement, asset: ImageAsset): void {
    const actions = container.createDiv({ cls: "oa-gallery-actions" });
    const details = actions.createDiv();
    details.createEl("strong", { text: asset.name });
    details.createEl("span", {
      text: asset.source === "generated"
        ? `${imageProviderLabel(asset)} · ${asset.model ?? "历史模型未记录"} · WriteX 积分 ${asset.writeCredits ?? 0}`
        : asset.source === "optimized"
          ? `${asset.optimizationSummary ?? "保留动画优化"} · 原图：${asset.relatedOriginalPath ?? "未记录"}`
          : asset.source === "original"
            ? `原始文件 · 公众号优化版：${asset.relatedOptimizedPath ?? "尚未生成"}`
            : "手动导入 · 已保存到 Vault",
    });
    if (canRegenerateImage(asset)) {
      const regenerate = actions.createEl("button", {
        cls: "oa-regenerate",
        attr: { type: "button", title: "使用原提示词生成新图" },
      });
      const regenerateIcon = regenerate.createSpan();
      setIcon(regenerateIcon, "refresh-cw");
      regenerate.createSpan({ text: this.regeneratingAssetId ? "生成中" : "重新生成" });
      regenerate.disabled = Boolean(this.regeneratingAssetId);
      regenerate.onclick = () => void this.regenerateImage(asset);
    }
    if (asset.source === "optimized" && asset.relatedOriginalPath) {
      const original = actions.createEl("button", { text: "使用原图", attr: { type: "button" } });
      original.disabled = Boolean(this.regeneratingAssetId);
      original.onclick = async () => {
        try {
          await this.plugin.insertImagePath(this.notePath, asset.relatedOriginalPath!);
          new Notice("已在当前光标位置插入关联原图；公众号优化版仍保留在图片集。");
        } catch (error) {
          new Notice(errorMessage(error));
        }
      };
    }
    if (asset.source === "original" && asset.relatedOptimizedPath) {
      const optimized = actions.createEl("button", { text: "使用公众号优化版", attr: { type: "button" } });
      optimized.disabled = Boolean(this.regeneratingAssetId);
      optimized.onclick = async () => {
        try {
          await this.plugin.insertImagePath(this.notePath, asset.relatedOptimizedPath!);
          new Notice("已在当前光标位置插入关联的公众号优化版；原图仍保留在图片集。");
        } catch (error) {
          new Notice(errorMessage(error));
        }
      };
    }
    const copy = actions.createEl("button", { text: "复制图片", attr: { type: "button" } });
    copy.disabled = Boolean(this.regeneratingAssetId);
    copy.onclick = async () => {
      try {
        await this.plugin.copyImage(asset);
        new Notice("图片已复制。");
      } catch (error) {
        new Notice(errorMessage(error));
      }
    };
    const insert = actions.createEl("button", { cls: "mod-cta", text: "插入正文", attr: { type: "button" } });
    insert.disabled = Boolean(this.regeneratingAssetId);
    insert.onclick = async () => {
      try {
        await this.plugin.insertImage(this.notePath, asset);
        new Notice("图片已插入当前光标位置。");
      } catch (error) {
        new Notice(errorMessage(error));
      }
    };
  }

  private renderPreview(container: HTMLElement): void {
    const state = this.plugin.getNoteState(this.notePath);
    const currentThemeId = state.themeId ?? "default";
    this.previewTheme = currentThemeId;
    const themes = this.plugin.themeService.listThemes();
    const toolbar = container.createDiv({ cls: "oa-preview-toolbar" });
    const layout = toolbar.createDiv({ cls: "oa-layout-control" });
    layout.createEl("label", { text: "排版" });
    const theme = layout.createEl("select", { cls: "oa-theme-select", attr: { "aria-label": "排版", title: "公众号排版" } });
    for (const option of themes) {
      const status = this.themeStatusLabel(option.status, option.task?.message);
      theme.createEl("option", { value: option.id, text: `${option.name} · ${status}` });
    }
    theme.value = currentThemeId;
    theme.onchange = () => {
      const selectedId = theme.value;
      theme.value = currentThemeId;
      void this.selectPreviewTheme(selectedId);
    };

    const currentTheme = themes.find(option => option.id === currentThemeId);
    const currentStatus = currentTheme
      ? this.themeStatusLabel(currentTheme.status, currentTheme.task?.message)
      : "失败";
    toolbar.createEl("span", {
      cls: this.isPreviewThemeReady() ? "" : "is-stale",
      text: `${currentTheme?.name ?? currentThemeId} · ${currentStatus} · ${this.previewUpdatedAt} · 自动同步`,
    });

    if (currentTheme && ["waiting", "failed"].includes(currentTheme.status)) {
      const retry = toolbar.createEl("button", { text: "重试", attr: { type: "button" } });
      retry.onclick = () => void this.selectPreviewTheme(currentThemeId);
    }
    const manage = toolbar.createEl("button", { text: "管理排版", attr: { type: "button" } });
    manage.onclick = () => new ThemeLibraryModal(
      this.plugin,
      currentThemeId,
      id => this.selectPreviewTheme(id),
    ).open();
    const refresh = toolbar.createEl("button", { cls: "oa-refresh", attr: { type: "button" } });
    const refreshIcon = refresh.createSpan();
    setIcon(refreshIcon, "refresh-cw");
    refresh.createSpan({ text: "刷新" });
    refresh.onclick = () => void this.refreshPreview();

    const stage = container.createDiv({ cls: "oa-preview-stage" });
    const option = PREVIEW_DEVICE;
    const device = stage.createDiv({ cls: "oa-preview-device oa-device-iphone16" });
    device.createDiv({ cls: `oa-device-camera ${option.camera}`, attr: { "aria-hidden": "true" } });
    const screen = device.createDiv({ cls: "oa-device-screen" });
    const top = screen.createDiv({ cls: "oa-wechat-top" });
    top.createSpan({ text: "‹" });
    top.createEl("strong", { text: option.label });
    top.createSpan({ text: "•••" });
    const article = screen.createDiv({ cls: "oa-wechat-article" });
    if (this.previewMarkdown) {
      try {
        const rendered = this.plugin.themeService.render(
          this.previewMarkdown,
          currentThemeId,
          source => this.resolveImage(source),
        );
        this.previewHtml = rendered.html;
        this.previewRenderKey = `${currentThemeId}:${rendered.themeHash}:${createHash("sha256").update(this.previewMarkdown).digest("hex")}`;
        this.previewRenderError = "";
      } catch (error) {
        this.previewRenderError = errorMessage(error);
      }
      if (this.previewHtml) article.appendChild(sanitizeHTMLToDom(this.previewHtml));
      if (this.previewRenderError) {
        article.createDiv({ cls: "oa-skill-stale-banner", text: `排版不可用：${this.previewRenderError}。已保留上一次有效预览。` });
      }
    } else {
      article.createEl("p", { text: "点击刷新，读取当前 Markdown 笔记。" });
    }
    this.attachPreviewScrollSync(article);
    const footer = container.createDiv({ cls: "oa-preview-footer" });
    const copy = footer.createEl("button", {
      cls: "mod-cta",
      text: "复制微信格式",
      attr: { type: "button" },
    });
    const copyBusy = !["idle", "done", "failed", "cancelled"].includes(this.copyTaskState);
    copy.disabled = !this.previewMarkdown || !this.isPreviewThemeReady() || copyBusy;
    copy.onclick = () => void this.copyPreview();
    if (copyBusy) {
      footer.createEl("span", { cls: "oa-copy-progress", text: this.copyProgress || "正在准备复制…" });
      const cancel = footer.createEl("button", { text: "取消", attr: { type: "button" } });
      cancel.onclick = () => this.cancelCopyTask();
    } else if (this.copyTaskState === "done" && this.copyProgress) {
      footer.createEl("span", { cls: "oa-copy-progress is-done", text: this.copyProgress });
    }
  }

  private themeStatusLabel(status: string, message?: string): string {
    if (status === "builtin" || status === "installed") return "已安装";
    if (status === "available") return "安装";
    if (status === "update") return "有更新";
    if (status === "installing") return message || "正在安装";
    if (status === "waiting") return "等待网络";
    return "失败";
  }

  private async selectPreviewTheme(selectedId: string): Promise<void> {
    if (!selectedId || !this.notePath) return;
    const state = this.plugin.getNoteState(this.notePath);
    try {
      try {
        this.plugin.themeService.getTheme(selectedId);
      } catch {
        await this.plugin.themeService.install(selectedId);
      }
      this.plugin.themeService.getTheme(selectedId);
      state.themeId = selectedId;
      this.previewTheme = selectedId;
      this.previewRenderKey = "";
      this.previewRenderError = "";
      await this.plugin.persist();
    } catch (error) {
      new Notice(`无法切换排版：${errorMessage(error)}`);
    }
    this.render();
  }

  private async switchTab(tab: ActiveTab): Promise<void> {
    this.activeTab = tab;
    if (tab === "gallery") {
      try {
        await this.syncReferencedImages();
      } catch (error) {
        new Notice(`同步正文图片失败：${errorMessage(error)}`);
      }
    }
    if (tab === "preview") await this.loadPreview();
    this.render();
  }

  private scheduleReferencedImageSync(notePath: string, markdown: string): void {
    window.clearTimeout(this.referencedImageSyncTimer);
    this.referencedImageSyncTimer = window.setTimeout(() => {
      void this.plugin.syncReferencedImages(notePath, markdown).then(added => {
        if (added && this.activeTab === "gallery" && this.notePath === notePath) this.render();
      }).catch(() => undefined);
    }, 350);
  }

  private async syncReferencedImages(): Promise<number> {
    if (!this.notePath) return 0;
    const file = this.app.vault.getAbstractFileByPath(this.notePath);
    if (!(file instanceof TFile)) return 0;
    const markdown = this.plugin.findMarkdownView(this.notePath)?.editor.getValue()
      ?? await this.app.vault.cachedRead(file);
    return this.plugin.syncReferencedImages(this.notePath, markdown);
  }

  private async checkAgent(): Promise<boolean> {
    const agent = this.plugin.agentSettings.activeChatAgent;
    this.agentStatus = "checking";
    this.render();
    try {
      this.agentVersion = await this.plugin.chatRuntime.check(agent);
      if (agent !== this.plugin.agentSettings.activeChatAgent) return false;
      this.agentStatus = "ready";
    } catch {
      if (agent !== this.plugin.agentSettings.activeChatAgent) return false;
      this.agentVersion = "";
      this.agentStatus = "missing";
      this.render();
      return false;
    }
    this.render();
    return true;
  }

  private async refreshSkills(refresh = false): Promise<void> {
    const requestId = ++this.skillScanRequestId;
    const notePath = this.notePath;
    this.skillDiscoveryState = "loading";
    this.skillScanError = "";
    this.skillFailureKind = "scan";
    this.render();
    let skills: LocalSkill[];
    try {
      skills = await this.plugin.discoverSkills(notePath, { refresh });
    } catch (error) {
      if (!isCurrentSkillScan(requestId, notePath, this.skillScanRequestId, this.notePath)) return;
      this.skillDiscoveryState = "failed";
      this.skillScanError = errorMessage(error);
      new Notice(`Skill 扫描失败：${this.skillScanError}`);
      this.render();
      return;
    }
    if (!isCurrentSkillScan(requestId, notePath, this.skillScanRequestId, this.notePath)) return;
    this.localSkills = skills;
    this.skillDiscoveryState = skills.length ? "ready" : "empty";
    const state = notePath ? this.plugin.getNoteState(notePath) : null;
    const staleSkillPath = state?.activeSkillPath;
    if (state && staleSkillPath && !findLocalSkillByPath(skills, staleSkillPath)) {
      const pathStatus = this.plugin.getSkillPathStatus(staleSkillPath);
      if (pathStatus.kind === "invalid") {
        this.skillDiscoveryState = "failed";
        this.skillFailureKind = "invalid";
        this.skillScanError = pathStatus.reason;
        new Notice(`Skill 文件无效：${this.skillScanError}`);
        this.render();
        return;
      }
      if (pathStatus.kind === "missing") {
        delete state.activeSkillPath;
        try {
          await this.plugin.persist();
        } catch (error) {
          state.activeSkillPath = staleSkillPath;
          if (!isCurrentSkillScan(requestId, notePath, this.skillScanRequestId, this.notePath)) return;
          this.skillDiscoveryState = "failed";
          this.skillFailureKind = "save";
          this.skillScanError = errorMessage(error);
          new Notice(`Skill 状态保存失败：${this.skillScanError}`);
          this.render();
          return;
        }
      }
    }
    if (isCurrentSkillScan(requestId, notePath, this.skillScanRequestId, this.notePath)) this.render();
  }

  private openSkillPicker(): void {
    const state = this.plugin.getNoteState(this.notePath);
    new SkillPickerModal(
      this.app,
      this.localSkills,
      state.activeSkillPath ?? "",
      path => this.selectChatSkill(path),
      () => void this.refreshSkills(true),
      () => new SkillInstallModal(this.app, async source => {
        await this.plugin.installSkill(source);
        await this.refreshSkills(true);
      }).open(),
    ).open();
  }

  private async selectChatSkill(skillPath: string): Promise<void> {
    const state = this.plugin.getNoteState(this.notePath);
    const previousSkillPath = state.activeSkillPath;
    const skill = findLocalSkillByPath(this.localSkills, skillPath);
    if (skillPath && !skill) {
      throw new Error("只能启用 WriteX 已发现的本地 Skill。");
    }
    if (skill) state.activeSkillPath = skill.skillFile;
    else delete state.activeSkillPath;
    try {
      await this.plugin.persist();
    } catch (error) {
      if (previousSkillPath) state.activeSkillPath = previousSkillPath;
      else delete state.activeSkillPath;
      this.render();
      throw error;
    }
    this.render();
  }

  private async startNewConversation(): Promise<void> {
    if (!this.notePath) return;
    if (this.running) this.stopRun();
    await this.plugin.clearConversation(this.notePath);
    this.composerDraft = "";
    this.composerAttachments = [];
    this.pendingImageRequest = null;
    this.selectionContext = this.plugin.captureActiveSelection();
    this.activeTab = "chat";
    this.render();
  }

  private async sendMessage(raw: string): Promise<void> {
    const request = raw.trim();
    const queuedAttachments = [...this.composerAttachments];
    if ((!request && !queuedAttachments.length) || !this.notePath) return;
    const agent = this.plugin.agentSettings.activeChatAgent;
    const imageRequest = this.imageMode;
    if (imageRequest ? this.imageRunning : this.running) return;
    if (imageRequest && agent !== "codex") {
      new Notice("当前 Agent 生图路径仍使用 Codex，请先切回 Codex。WriteX 不会静默切换 Agent。");
      return;
    }
    if (imageRequest && queuedAttachments.length) {
      new Notice("请先退出生图模式，再把图片或附件作为 Chat 上下文发送。");
      return;
    }
    if (!imageRequest && this.agentStatus !== "ready") {
      if (!(await this.checkAgent())) {
        new Notice(`${AGENT_LABELS[agent]} CLI 未连接，请先在 WriteX 设置中完成配置。`);
        return;
      }
    }
    let file = this.app.vault.getAbstractFileByPath(this.notePath);
    if (!(file instanceof TFile)) {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile instanceof TFile && activeFile.extension === "md") {
        const oldPath = this.notePath;
        await this.plugin.rebindNotePath(oldPath, activeFile.path);
        this.notePath = activeFile.path;
        if (this.selectionContext?.filePath === oldPath) {
          this.selectionContext = { ...this.selectionContext, filePath: activeFile.path, fileName: activeFile.basename };
        } else {
          this.selectionContext = null;
        }
        if (this.pendingImageRequest?.notePath === oldPath) this.pendingImageRequest.notePath = activeFile.path;
        file = activeFile;
      }
    }
    if (!(file instanceof TFile)) {
      new Notice("当前 Markdown 笔记已经移动或删除。");
      return;
    }
    const state = this.plugin.getNoteState(this.notePath);
    const context = this.selectionContext ? { ...this.selectionContext } : undefined;
    const model = configuredAgentModel(this.plugin.agentSettings, agent);
    const reasoningEffort = agent === "codex" ? configuredCodexReasoningEffort(this.plugin.agentSettings) : "";
    const activeSkill = findLocalSkillByPath(this.localSkills, state.activeSkillPath);
    if (state.activeSkillPath && !activeSkill) {
      new Notice("当前启用的 Skill 尚未加载，请重新扫描或先停用 Skill。");
      return;
    }
    const skillSnapshot: ChatSkillSnapshot | undefined = activeSkill ? {
      name: activeSkill.name,
      path: activeSkill.skillFile,
      sourceHash: activeSkill.sourceHash,
    } : undefined;
    const writingStyleProfile = styleEnabled(this.plugin.data.writingStyleProfile, state.writingStyleEnabled)
      ? this.plugin.data.writingStyleProfile
      : undefined;
    const writingStyleSnapshot = writingStyleProfile ? {
      revision: writingStyleProfile.revision,
      sourceHash: sha256Text(writingStyleProfile.markdown),
    } : undefined;
    const turnMode = imageRequest ? "chat" : this.chatMode;
    const userMessageId = createId("message");
    let attachments: ChatAttachment[] = [];
    try {
      if (queuedAttachments.length) attachments = await this.plugin.stageChatAttachments(this.notePath, userMessageId, queuedAttachments);
    } catch (error) {
      new Notice(errorMessage(error));
      return;
    }
    this.composerDraft = "";
    this.composerAttachments = [];
    state.messages.push({
      id: userMessageId,
      role: "user",
      kind: "text",
      content: request,
      createdAt: Date.now(),
      context,
      attachments: attachments.length ? attachments : undefined,
      mode: turnMode,
      agent,
      model: model || "默认",
      reasoningEffort: reasoningEffort || undefined,
      skill: skillSnapshot,
    });
    await this.plugin.persist();
    if (imageRequest) {
      this.imageMode = false;
      this.pendingImageRequest = {
        notePath: this.notePath,
        prompt: [
          activeSkill ? buildExplicitSkillInstruction(activeSkill) : "",
          request,
          context?.text.trim() ? `文章选段参考：${context.text.trim()}` : "",
        ].filter(Boolean).join("\n\n"),
        context,
        userMessageId,
        imageSize: this.plugin.agentSettings.imageSize,
        error: this.plugin.agentImageCapability === "unavailable"
          ? "本次会话已确认当前 Codex 没有返回图片文件的能力。"
          : undefined,
      };
      if (this.plugin.agentImageCapability === "unavailable") {
        this.render();
      } else {
        await this.runPendingImageWithAgent();
      }
      return;
    }

    this.running = true;
    this.runningTask = "chat";
    const controller = new AbortController();
    this.controller = controller;
    this.render();
    try {
      const noteContent = await this.app.vault.cachedRead(file);
      const attachmentContext = attachments.map(attachment => ({
        ...attachment,
        absolutePath: join(this.plugin.getVaultBasePath(), attachment.filePath),
      }));
      const prompt = buildWritingPrompt({
        request: request || "请阅读我附上的文件，并告诉我其中最值得继续写的内容。",
        filePath: this.notePath,
        noteContent,
        selection: context?.text,
        maxContextChars: this.plugin.agentSettings.maxContextChars,
        mode: turnMode,
        skillInstruction: activeSkill ? buildExplicitSkillInstruction(activeSkill) : undefined,
        styleInstruction: buildStyleInstruction(writingStyleProfile),
        feedbackInstruction: buildFeedbackInstruction(this.plugin.data.feedbackMemory, agent, activeSkill?.name),
        attachments: attachmentContext,
      });
      await runAndRecordAssistant(() => this.plugin.chatRuntime.runTurn({
        agent,
        cwd: this.plugin.getVaultBasePath(),
        prompt,
        sessionId: getAgentSession(state, agent),
        model,
        reasoningEffort: reasoningEffort || undefined,
        imagePaths: attachments.filter(attachment => attachment.kind === "image")
          .map(attachment => join(this.plugin.getVaultBasePath(), attachment.filePath)),
        signal: controller.signal,
      }), result => {
        setAgentSession(state, agent, result.threadId);
        state.messages.push({
          id: createId("message"),
          role: "assistant",
          kind: "text",
          content: result.text,
          createdAt: Date.now(),
          context,
          mode: turnMode,
          agent,
          model: model || "默认",
          reasoningEffort: reasoningEffort || undefined,
          skill: skillSnapshot,
          writingStyle: writingStyleSnapshot,
        });
      });
      await this.plugin.persist();
    } catch (error) {
      if (!controller.signal.aborted) new Notice(errorMessage(error));
    } finally {
      this.running = false;
      this.runningTask = null;
      this.controller = null;
      this.render();
    }
  }

  private async runPendingImageWithAgent(): Promise<void> {
    const pending = this.pendingImageRequest;
    if (!pending || this.imageRunning || !this.notePath) return;
    const controller = new AbortController();
    this.startImageRun("agent-image", controller);
    this.render();
    try {
      const asset = await this.plugin.generateImageWithAgent(
        pending.notePath,
        pending.prompt,
        pending.userMessageId,
        controller.signal,
        pending.imageSize,
      );
      this.appendImageMessage(asset, pending.context, pending.notePath);
      this.pendingImageRequest = null;
      await this.plugin.persist();
    } catch (error) {
      pending.error = controller.signal.aborted ? "已停止 Agent 生图。" : errorMessage(error);
    } finally {
      this.finishImageRun();
      this.render();
    }
  }

  private async useOpenAIForPendingImage(): Promise<void> {
    const pending = this.pendingImageRequest;
    if (!pending || this.imageRunning || !this.notePath) return;
    if (!this.plugin.agentSettings.hasImageApiKey) {
      this.plugin.openSettings();
      new Notice("先保存你自己的 OpenAI 图片 API Key，再回到 Chat 点击使用。");
      return;
    }
    this.startImageRun("openai-image", null);
    this.render();
    try {
      const asset = await this.plugin.generateImageWithOpenAI(
        pending.notePath,
        pending.prompt,
        pending.userMessageId,
        pending.imageSize,
      );
      this.appendImageMessage(asset, pending.context, pending.notePath);
      this.pendingImageRequest = null;
      await this.plugin.persist();
    } catch (error) {
      pending.error = errorMessage(error);
    } finally {
      this.finishImageRun();
      this.render();
    }
  }

  private async generatePromptForPendingImage(): Promise<void> {
    const pending = this.pendingImageRequest;
    if (!pending || this.running) return;
    const file = this.app.vault.getAbstractFileByPath(pending.notePath);
    if (!(file instanceof TFile)) return;
    const state = this.plugin.getNoteState(pending.notePath);
    this.running = true;
    this.runningTask = "chat";
    const controller = new AbortController();
    this.controller = controller;
    this.render();
    try {
      const noteContent = await this.app.vault.cachedRead(file);
      const prompt = buildWritingPrompt({
        request: `不要生成图片。请把下面的需求整理成一段可直接复制给任意生图模型的中文提示词，只输出提示词：\n${pending.prompt}`,
        filePath: pending.notePath,
        noteContent,
        selection: pending.context?.text,
        maxContextChars: this.plugin.agentSettings.maxContextChars,
      });
      const result = await this.plugin.runtime.runTurn({
        cwd: this.plugin.getVaultBasePath(),
        prompt,
        threadId: getAgentSession(state, "codex"),
        model: this.plugin.agentSettings.codexModel,
        signal: controller.signal,
      });
      setAgentSession(state, "codex", result.threadId);
      state.messages.push({
        id: createId("message"),
        role: "assistant",
        kind: "text",
        content: result.text,
        createdAt: Date.now(),
        context: pending.context,
        agent: "codex",
        model: this.plugin.agentSettings.codexModel || "默认",
      });
      this.pendingImageRequest = null;
      await this.plugin.persist();
    } catch (error) {
      if (!controller.signal.aborted) pending.error = errorMessage(error);
    } finally {
      this.running = false;
      this.runningTask = null;
      this.controller = null;
      this.render();
    }
  }

  private appendImageMessage(asset: ImageAsset, context?: SelectionContext, notePath = this.notePath): void {
    this.plugin.getNoteState(notePath).messages.push({
      id: createId("message"),
      role: "assistant",
      kind: "image",
      content: asset.prompt ?? asset.name,
      createdAt: Date.now(),
      context,
      assetId: asset.id,
      agent: "codex",
      model: asset.model ?? (this.plugin.agentSettings.codexModel || "默认"),
    });
  }

  private stopRun(): void {
    this.controller?.abort();
  }

  private stopImageRun(): void {
    this.imageController?.abort();
  }

  private startImageRun(task: ImageTask, controller: AbortController | null): void {
    this.imageRunning = true;
    this.imageTask = task;
    this.imageController = controller;
    this.imageStartedAt = Date.now();
    window.clearInterval(this.imageProgressTimer);
    this.imageProgressTimer = window.setInterval(() => this.updateImageProgress(), 1000);
  }

  private finishImageRun(): void {
    this.imageRunning = false;
    this.imageTask = null;
    this.imageController = null;
    this.imageStartedAt = 0;
    this.imageProgressEl = null;
    window.clearInterval(this.imageProgressTimer);
    this.imageProgressTimer = 0;
  }

  private updateImageProgress(): void {
    if (!this.imageProgressEl || !this.imageStartedAt) return;
    const seconds = Math.max(0, Math.floor((Date.now() - this.imageStartedAt) / 1000));
    const minutes = Math.floor(seconds / 60);
    const remainder = String(seconds % 60).padStart(2, "0");
    this.imageProgressEl.setText(`已等待 ${minutes}:${remainder}`);
  }

  private async importFiles(files: FileList | null): Promise<void> {
    if (!files?.length || !this.notePath) return;
    let imported = 0;
    for (const file of Array.from(files)) {
      try {
        const asset = await this.plugin.importImage(this.notePath, file);
        this.selectedAssetId = asset.id;
        imported += 1;
      } catch (error) {
        new Notice(`${file.name}：${errorMessage(error)}`);
      }
    }
    if (imported) new Notice(`已导入 ${imported} 张图片。`);
    this.galleryFilter = "manual";
    this.render();
  }

  private async regenerateImage(asset: ImageAsset): Promise<void> {
    if (!this.notePath || !canRegenerateImage(asset) || this.regeneratingAssetId || this.imageRunning) return;
    const provider = resolveGeneratedProvider(asset);
    if (provider === "write-cloud") {
      new Notice("WriteX Cloud 生图尚未推出，没有发送请求或扣除积分。");
      return;
    }
    if (provider === "openai-api" && !this.plugin.agentSettings.hasImageApiKey) {
      this.plugin.openSettings();
      new Notice("这张图来自自带 API。请先恢复你的 OpenAI 图片 API Key。");
      return;
    }
    this.regeneratingAssetId = asset.id;
    const notePath = this.notePath;
    const controller = provider === "agent" ? new AbortController() : null;
    this.startImageRun(provider === "agent" ? "agent-image" : "openai-image", controller);
    this.render();
    try {
      const generated = provider === "agent"
        ? await this.plugin.generateImageWithAgent(notePath, asset.prompt, asset.messageId, controller?.signal)
        : await this.plugin.generateImageWithOpenAI(notePath, asset.prompt, asset.messageId);
      this.appendImageMessage(generated, undefined, notePath);
      await this.plugin.persist();
      this.galleryFilter = "generated";
      this.selectedAssetId = generated.id;
      new Notice("已用原提示词生成新图，旧图已保留。");
    } catch (error) {
      if (provider === "agent") {
        this.pendingImageRequest = {
          notePath,
          prompt: asset.prompt,
          userMessageId: asset.messageId ?? createId("message"),
          imageSize: this.plugin.agentSettings.imageSize,
          error: errorMessage(error),
        };
        this.activeTab = "chat";
      } else {
        new Notice(errorMessage(error));
      }
    } finally {
      this.regeneratingAssetId = "";
      this.finishImageRun();
      this.render();
    }
  }

  private async refreshPreview(): Promise<void> {
    await this.loadPreview();
    this.render();
    new Notice("公众号预览已刷新。");
  }

  private async loadPreview(): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(this.notePath);
    if (!(file instanceof TFile)) return;
    this.previewMarkdown = await this.app.vault.cachedRead(file);
    this.previewFilePath = file.path;
    this.previewUpdatedAt = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  }

  private async copyCurrentNote(): Promise<void> {
    await this.loadPreview();
    await this.copyPreview();
    this.render();
  }

  private resolveImage(source: string): string {
    if (/^(https?:|data:image\/|app:|blob:)/i.test(source)) return source;
    const file = this.app.metadataCache.getFirstLinkpathDest(source, this.previewFilePath || this.notePath);
    return file ? this.app.vault.getResourcePath(file) : "";
  }

  private async copyPreview(): Promise<void> {
    if (!this.previewMarkdown || !["idle", "done", "failed", "cancelled"].includes(this.copyTaskState)) return;
    const controller = new AbortController();
    this.copyController = controller;
    this.copyTaskState = "checking";
    this.copyProgress = "正在检查图片 0/0";
    this.render();
    try {
      const plan = await this.createCopyPlan(controller.signal);
      if (controller.signal.aborted) {
        this.finishCopyTask("cancelled", "已取消复制");
        return;
      }
      this.copyProgress = "复制预检完成，等待选择处理路径";
      this.render();
      new CopyPlanModal(
        this.app,
        plan,
        Boolean(this.plugin.agentSettings.relayUrl && this.plugin.agentSettings.hasRelayKey),
        choice => void this.executeCopyChoice(choice, plan),
        () => this.finishCopyTask("cancelled", "已取消复制，未写入剪贴板"),
      ).open();
    } catch (error) {
      if (controller.signal.aborted) this.finishCopyTask("cancelled", "已取消复制");
      else this.failCopyTask(error);
    }
  }

  private resourcePath(asset: ImageAsset): string {
    const file = this.app.vault.getAbstractFileByPath(asset.filePath);
    return file instanceof TFile ? this.app.vault.getResourcePath(file) : "";
  }

  private async createCopyPlan(signal: AbortSignal, excludedSources = new Set<string>()): Promise<CopyPlan> {
    const sources = extractMarkdownImageSources(this.previewMarkdown);
    const images = [];
    for (let index = 0; index < sources.length; index += 1) {
      if (signal.aborted) throw new DOMException("复制已取消", "AbortError");
      const source = sources[index];
      if (excludedSources.has(source)) continue;
      this.copyProgress = `正在检查图片 ${index + 1}/${sources.length} · ${source}`;
      this.render();
      const file = /^(https?:|data:image\/)/i.test(source)
        ? null
        : this.app.metadataCache.getFirstLinkpathDest(source, this.previewFilePath || this.notePath);
      if (!(file instanceof TFile)) {
        images.push({
          source,
          sha256: "0".repeat(64),
          inspection: {
            mimeType: null,
            byteLength: 0,
            complete: false,
            animated: false,
            extensionMismatch: false,
            mimeMismatch: false,
            issues: ["远程图片或 Vault 中不存在的图片不能直接内嵌。"],
          },
          articleIndex: index + 1,
          articleTotal: sources.length,
        });
        continue;
      }
      const bytes = await this.app.vault.readBinary(file);
      if (signal.aborted) throw new DOMException("复制已取消", "AbortError");
      images.push({
        source,
        sha256: createHash("sha256").update(Buffer.from(bytes)).digest("hex"),
        inspection: inspectImage(bytes, { fileName: file.name }),
        articleIndex: index + 1,
        articleTotal: sources.length,
      });
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }
    const baseHtml = this.renderCopyHtml(new Map(), false, excludedSources);
    const layoutLabel = this.plugin.themeService.listThemes()
      .find(item => item.id === this.previewTheme)?.name ?? this.previewTheme;
    return buildCopyPlan({
      articleCharacters: [...new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(markdownToPlainText(this.previewMarkdown))].length,
      layoutLabel,
      baseHtmlBytes: Buffer.byteLength(baseHtml, "utf8"),
      images,
    });
  }

  private renderCopyHtml(replacements: Map<string, string>, textOnly: boolean, excludedSources = new Set<string>()): string {
    const html = this.plugin.themeService.render(
      this.previewMarkdown,
      this.previewTheme,
      source => excludedSources.has(source) ? `writex-excluded:${encodeURIComponent(source)}` : replacements.get(source) ?? source,
    ).html;
    const withoutExcluded = html.replace(/<img\b[^>]*writex-excluded:[^>]*>/gi, "");
    return textOnly ? withoutExcluded.replace(/<img\b[^>]*>/gi, "") : withoutExcluded;
  }

  private async executeCopyChoice(choice: CopyChoice, plan: CopyPlan): Promise<void> {
    try {
      if (choice === "inline") await this.copyInline(plan);
      else if (choice === "text-only") await this.copyTextOnly();
      else if (choice === "optimize") await this.optimizeThenCopy(plan);
      else if (choice === "exclude") await this.copyWithoutBrokenImages(plan);
      else await this.copyViaRelay(plan);
    } catch (error) {
      if (this.copyController?.signal.aborted) this.finishCopyTask("cancelled", "已取消复制");
      else this.failCopyTask(error);
    }
  }

  private async copyWithoutBrokenImages(plan: CopyPlan): Promise<void> {
    const excluded = new Set(plan.excludableImages.map(image => image.source));
    const reduced = await this.createCopyPlan(this.copyController!.signal, excluded);
    if (reduced.canDirectCopy) await this.copyInline(reduced, new Map(), excluded);
    else if (reduced.images.some(image => image.path.startsWith("optimize"))) await this.optimizeThenCopy(reduced, excluded);
    else throw new Error("排除异常图片后仍不能安全复制；请优化剩余图片、使用 Relay 或只复制文字。");
    const labels = plan.excludableImages.map(image => image.problem.articleLabel ?? image.source).join("、");
    this.copyProgress = `已排除异常图片：${labels}`;
    this.render();
    new Notice(`已排除异常图片：${labels}；原笔记未修改。`);
  }

  private async copyInline(
    plan: CopyPlan,
    byteOverrides: Map<string, { bytes: ArrayBuffer; mimeType: string }> = new Map(),
    excludedSources = new Set<string>(),
  ): Promise<void> {
    if (!plan.canDirectCopy) throw new Error("当前 CopyPlan 超过内嵌预算，不能直接复制。");
    this.copyTaskState = "rendering";
    const replacements = new Map<string, string>();
    for (let index = 0; index < plan.images.length; index += 1) {
      this.assertCopyActive();
      const planned = plan.images[index];
      if (planned.path !== "inline") throw new Error(`图片未通过内嵌预算：${planned.source}`);
      this.copyProgress = `正在准备安全内嵌 ${index + 1}/${plan.images.length} · ${planned.source}`;
      this.render();
      const override = byteOverrides.get(planned.source);
      const file = override ? null : this.app.metadataCache.getFirstLinkpathDest(planned.source, this.previewFilePath || this.notePath);
      if (!override && !(file instanceof TFile)) throw new Error(`准备内嵌时找不到图片：${planned.source}`);
      const bytes = override?.bytes ?? await this.app.vault.readBinary(file as TFile);
      this.assertCopyActive();
      const currentHash = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
      if (currentHash !== planned.sha256) throw new Error(`图片在预检后发生变化：${planned.source}`);
      // The plan has already bounded both each image and the complete clipboard payload.
      replacements.set(planned.source, `data:${override?.mimeType ?? planned.mimeType};base64,${Buffer.from(bytes).toString("base64")}`);
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }
    await this.writeCopyHtml(this.renderCopyHtml(replacements, false, excludedSources));
  }

  private async copyTextOnly(): Promise<void> {
    this.copyTaskState = "rendering";
    this.copyProgress = "正在移除图片并保留文字排版";
    this.render();
    await this.writeCopyHtml(this.renderCopyHtml(new Map(), true));
  }

  private async optimizeThenCopy(plan: CopyPlan, excludedSources = new Set<string>()): Promise<void> {
    this.assertCopyActive();
    this.copyTaskState = "optimizing";
    const optimizedInputs = [];
    const overrides = new Map<string, { bytes: ArrayBuffer; mimeType: string }>();
    const gifCount = plan.images.filter(image => image.path === "optimize-gif").length;
    const baseHtmlBytes = Buffer.byteLength(this.renderCopyHtml(new Map(), false, excludedSources), "utf8");
    const estimatedStaticBase64 = plan.images
      .filter(image => image.path !== "optimize-gif")
      .reduce((sum, image) => sum + 4 * Math.ceil(Math.min(image.byteLength, 900 * 1024) / 3), 0);
    const targetGifBytes = gifCount
      ? Math.min(5 * 1024 * 1024, Math.max(1024 * 1024, Math.floor((COPY_HTML_BUDGET_BYTES - baseHtmlBytes - estimatedStaticBase64) * 0.72 / gifCount)))
      : 5 * 1024 * 1024;
    for (let index = 0; index < plan.images.length; index += 1) {
      this.assertCopyActive();
      const planned = plan.images[index];
      this.copyProgress = `正在优化图片 ${index + 1}/${plan.images.length} · ${planned.source}`;
      this.render();
      const file = this.app.metadataCache.getFirstLinkpathDest(planned.source, this.previewFilePath || this.notePath);
      if (!(file instanceof TFile)) throw new Error(`优化阶段找不到图片：${planned.source}`);
      let bytes = await this.app.vault.readBinary(file);
      this.assertCopyActive();
      let inspection = inspectImage(bytes, { fileName: file.name });
      let mimeType = inspection.mimeType;
      if (!mimeType || !inspection.complete) throw new Error(`优化阶段发现图片损坏：${planned.source}`);
      if (planned.path === "optimize-gif") {
        try {
          const absolutePath = join(this.plugin.getVaultBasePath(), file.path);
          const result = await optimizeAnimatedGif(
            absolutePath,
            inspection,
            targetGifBytes,
            this.copyController!.signal,
            (profile, profileIndex, total) => {
              this.copyProgress = `正在优化 GIF ${index + 1}/${plan.images.length} · 方案 ${profileIndex}/${total} · ${profile.width}px / ${profile.fps}fps / ${profile.colors} 色`;
              this.render();
            },
          );
          this.assertCopyActive();
          bytes = result.bytes;
          mimeType = "image/gif";
          inspection = inspectImage(bytes, { fileName: "optimized.gif", declaredMime: mimeType });
          const summary = `${result.profile.width}px · ${result.profile.fps} fps · ${result.profile.colors} 色 · ${formatBytes(bytes.byteLength)}`;
          await this.plugin.storeOptimizedGif(this.notePath, bytes, file.path, summary);
        } catch (error) {
          throw imageStageError("优化 GIF", planned.source, error);
        }
      } else if (planned.path === "optimize-static") {
        const targetMime = inspection.hasAlpha ? "image/png" : "image/jpeg";
        try {
          bytes = await convertForWeChat(bytes, inspection, targetMime, 900 * 1024);
          this.assertCopyActive();
        } catch (error) {
          if (this.copyController?.signal.aborted) throw error;
          throw imageStageError("优化静态图片", planned.source, error);
        }
        mimeType = targetMime;
        inspection = inspectImage(bytes, { fileName: uploadFileName(file.name, mimeType), declaredMime: mimeType });
      }
      if (planned.path === "blocked") throw new Error(`图片损坏，不能优化：${planned.source}`);
      const hash = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
      optimizedInputs.push({ source: planned.source, sha256: hash, inspection });
      overrides.set(planned.source, { bytes, mimeType });
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }
    const optimizedPlan = buildCopyPlan({
      articleCharacters: plan.articleCharacters,
      layoutLabel: plan.layoutLabel,
      baseHtmlBytes,
      images: optimizedInputs,
    });
    if (!optimizedPlan.canDirectCopy) {
      throw new Error(`图片优化后预计剪贴板仍为 ${formatBytes(optimizedPlan.estimatedClipboardHtmlBytes)}，未达到安全预算；请选择 Relay 或只复制文字。`);
    }
    await this.copyInline(optimizedPlan, overrides, excludedSources);
  }

  private async copyViaRelay(plan: CopyPlan): Promise<void> {
    this.assertCopyActive();
    if (plan.images.some(image => image.animated)) {
      throw new Error("动态 GIF 不能通过微信正文图片 API 保留动画；请先优化后走人工网页编辑器验收。");
    }
    const relayUrl = this.plugin.agentSettings.relayUrl.replace(/\/$/, "");
    const relay = await this.plugin.createWriteRelayClient();
    let binding = this.plugin.getRelayAccountBinding(relayUrl);
    if (!binding) {
      const identityConfirmed = await new Promise<boolean>(resolve => {
        new RelayIdentityConfirmModal(this.app, relayUrl, resolve).open();
      });
      if (!identityConfirmed) {
        this.finishCopyTask("cancelled", "已取消；未连接 Relay，未上传图片，未写入剪贴板");
        return;
      }
      this.assertCopyActive();
      this.copyTaskState = "checking";
      this.copyProgress = "正在读取 Relay 公众号身份（不上传图片）";
      this.render();
      const verified = await relay.verify();
      this.assertCopyActive();
      binding = {
        relayUrl,
        accountId: verified.accountId,
        accountName: verified.accountName,
        verifiedAt: Date.now(),
      };
      await this.plugin.bindRelayAccount(binding);
      this.assertCopyActive();
    }
    const confirmed = await new Promise<boolean>(resolve => {
      new RelayCopyConfirmModal(this.app, binding!.accountName, plan.images.map(image => image.source), resolve).open();
    });
    if (!confirmed) {
      this.finishCopyTask("cancelled", "已取消；未上传图片，未写入剪贴板");
      return;
    }
    this.copyTaskState = "uploading";
    const replacements = new Map<string, string>();
    for (let index = 0; index < plan.images.length; index += 1) {
      this.assertCopyActive();
      const planned = plan.images[index];
      const cached = this.plugin.getCachedWeChatImage(relayUrl, binding.accountId, planned.sha256);
      if (cached) {
        replacements.set(planned.source, cached.url);
        this.copyProgress = `已使用本地微信图片缓存 ${index + 1}/${plan.images.length} · ${planned.source}`;
        this.render();
        continue;
      }
      this.copyProgress = `正在准备公众号图片 ${index + 1}/${plan.images.length} · ${planned.source}`;
      this.render();
      const file = this.app.metadataCache.getFirstLinkpathDest(planned.source, this.previewFilePath || this.notePath);
      if (!(file instanceof TFile)) throw new Error(`Relay 准备阶段找不到图片：${planned.source}`);
      let bytes = await this.app.vault.readBinary(file);
      this.assertCopyActive();
      let inspection = inspectImage(bytes, { fileName: file.name });
      if (!inspection.mimeType || !inspection.complete) throw new Error(`Relay 准备阶段发现图片损坏：${planned.source}`);
      const imagePlan = planWeChatImage(inspection, "content");
      if (imagePlan.status === "blocked" || imagePlan.animationLoss) {
        throw new Error(`微信正文图片 API 无法处理：${planned.source} · ${imagePlan.reason ?? "不支持该图片"}`);
      }
      let mimeType = inspection.mimeType;
      if (imagePlan.status === "convert") {
        mimeType = imagePlan.targetMime === "image/png" ? "image/png" : "image/jpeg";
        try {
          bytes = await convertForWeChat(bytes, inspection, mimeType, 1024 * 1024);
          this.assertCopyActive();
        } catch (error) {
          if (this.copyController?.signal.aborted) throw error;
          throw imageStageError("规范化公众号图片", planned.source, error);
        }
        inspection = inspectImage(bytes, { fileName: uploadFileName(file.name, mimeType), declaredMime: mimeType });
      }
      if (!inspection.complete || !["image/jpeg", "image/png"].includes(mimeType) || bytes.byteLength >= 1024 * 1024) {
        throw new Error(`图片规范化后仍不符合微信要求：${planned.source}`);
      }
      const uploadSha256 = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
      this.copyProgress = `正在上传公众号图片 ${index + 1}/${plan.images.length} · ${planned.source}`;
      this.render();
      let result;
      try {
        result = await relay.uploadAsset({
          kind: "content",
          fileName: uploadFileName(file.name, mimeType),
          mimeType,
          sha256: uploadSha256,
          idempotencyKey: assetIdempotencyKey("content", uploadSha256),
          bytes,
        });
      } catch (error) {
        throw imageStageError("上传公众号图片", planned.source, error);
      }
      this.assertCopyActive();
      if (!result.url) throw new Error(`Relay 未返回微信正文图片 URL：${planned.source}`);
      replacements.set(planned.source, result.url);
      try {
        await this.plugin.cacheWeChatImage({
          sourceSha256: planned.sha256,
          uploadSha256,
          url: result.url,
          accountId: binding.accountId,
          relayUrl,
          cachedAt: Date.now(),
        });
      } catch (error) {
        throw imageStageError("保存公众号图片缓存", planned.source, error);
      }
    }
    const html = this.renderCopyHtml(replacements, false);
    if (Buffer.byteLength(html, "utf8") >= 1024 * 1024) {
      throw new Error(`Relay 图片已准备，但最终 HTML 为 ${formatBytes(Buffer.byteLength(html, "utf8"))}，超过 1 MB，未写入剪贴板。`);
    }
    await this.writeCopyHtml(html);
  }

  private async writeCopyHtml(html: string): Promise<void> {
    this.assertCopyActive();
    this.copyTaskState = "writing";
    this.copyProgress = "正在写入剪贴板";
    this.render();
    const plain = markdownToPlainText(this.previewMarkdown);
    try {
      const electron = require("electron") as {
        clipboard: { write(data: { html: string; text: string }): void };
      };
      electron.clipboard.write({ html, text: plain });
    } catch {
      await navigator.clipboard.writeText(plain);
      throw new Error("当前环境只支持纯文本剪贴板；已复制纯文本，未写入富文本 HTML。");
    }
    const size = Buffer.byteLength(html, "utf8");
    this.finishCopyTask("done", `已复制，HTML ${formatBytes(size)}；请到公众号后台确认正文与图片真实出现`);
    new Notice(`已复制微信格式 · HTML ${formatBytes(size)}。粘贴成功仍需在公众号后台确认。`);
  }

  private assertCopyActive(): void {
    if (!this.copyController || this.copyController.signal.aborted) throw new DOMException("复制已取消", "AbortError");
  }

  private cancelCopyTask(): void {
    if (!this.copyController || this.copyController.signal.aborted) return;
    this.copyController.abort();
    this.copyProgress = "正在取消复制…";
    this.render();
  }

  private finishCopyTask(state: CopyTaskState, progress: string): void {
    this.copyTaskState = state;
    this.copyProgress = progress;
    this.copyController = null;
    this.render();
  }

  private failCopyTask(error: unknown): void {
    const message = errorMessage(error);
    this.finishCopyTask("failed", `复制失败 · ${message}`);
    new Notice(message);
  }

  private attachPreviewScrollSync(article: HTMLElement): void {
    const view = this.plugin.findMarkdownView(this.notePath);
    const scroller = view?.containerEl.querySelector<HTMLElement>(".cm-scroller") ?? null;
    if (!scroller) return;
    this.editorScroller = scroller;
    const sync = (source: HTMLElement, target: HTMLElement): void => {
      if (this.syncingScroll) return;
      const sourceRange = source.scrollHeight - source.clientHeight;
      const ratio = sourceRange > 0 ? source.scrollTop / sourceRange : 0;
      this.previewScrollRatio = Math.min(1, Math.max(0, ratio));
      const targetRange = target.scrollHeight - target.clientHeight;
      this.syncingScroll = true;
      target.scrollTop = this.previewScrollRatio * Math.max(0, targetRange);
      window.requestAnimationFrame(() => { this.syncingScroll = false; });
    };
    article.onscroll = () => sync(article, scroller);
    this.editorScrollListener = () => sync(scroller, article);
    scroller.addEventListener("scroll", this.editorScrollListener, { passive: true });
    window.setTimeout(() => {
      article.scrollTop = this.previewScrollRatio * Math.max(0, article.scrollHeight - article.clientHeight);
    }, 0);
  }

  private detachPreviewScrollSync(): void {
    if (this.editorScroller && this.editorScrollListener) {
      this.editorScroller.removeEventListener("scroll", this.editorScrollListener);
    }
    this.editorScroller = null;
    this.editorScrollListener = null;
  }

  private isPreviewThemeReady(): boolean {
    if (!this.notePath) return false;
    try {
      this.plugin.themeService.getTheme(this.plugin.getNoteState(this.notePath).themeId ?? "default");
      return true;
    } catch {
      return false;
    }
  }

  private resetPreviewState(): void {
    this.previewMarkdown = "";
    this.previewFilePath = "";
    this.previewUpdatedAt = "未刷新";
    this.previewHtml = "";
    this.previewRenderKey = "";
    this.previewRenderError = "";
  }

  private imageMarkdown(asset: ImageAsset): string {
    const file = this.app.vault.getAbstractFileByPath(asset.filePath);
    return file instanceof TFile ? `!${this.app.fileManager.generateMarkdownLink(file, this.notePath)}` : "";
  }

  private armAssistantBlockDrag(start: PointerEvent, blockEl: HTMLElement, markdown: string): void {
    if (start.button !== 0) return;
    this.clearBlockDropHandlers?.();
    this.suppressBlockHandleClick = false;
    const notePath = this.notePath;
    const ownerDocument = blockEl.ownerDocument;
    let moved = false;
    let indicator: HTMLElement | null = null;
    let ghost: HTMLElement | null = null;

    const hideIndicator = (): void => {
      indicator?.remove();
      indicator = null;
    };
    const showIndicator = (top: number, left: number, right: number): void => {
      indicator ??= ownerDocument.body.createDiv({ cls: "oa-block-drop-indicator" });
      indicator.style.top = `${top}px`;
      indicator.style.left = `${left}px`;
      indicator.style.width = `${Math.max(0, right - left)}px`;
    };
    const showGhost = (event: PointerEvent): void => {
      if (!ghost) {
        ghost = ownerDocument.body.createDiv({ cls: "oa-block-drag-ghost", attr: { "aria-hidden": "true" } });
        const icon = ghost.createSpan();
        setIcon(icon, "hand");
        const text = markdownToPlainText(markdown).replace(/\s+/g, " ").trim();
        ghost.createSpan({ text: text.slice(0, 120) || "空内容块" });
      }
      ghost.style.transform = `translate3d(${event.clientX + 14}px, ${event.clientY + 14}px, 0) rotate(-1deg)`;
    };
    const cleanup = (): void => {
      ownerDocument.removeEventListener("pointermove", move, true);
      ownerDocument.removeEventListener("pointerup", finish, true);
      ownerDocument.removeEventListener("pointercancel", finish, true);
      ownerDocument.removeEventListener("keydown", cancelWithKeyboard, true);
      hideIndicator();
      ghost?.remove();
      ghost = null;
      blockEl.removeClass("is-dragging");
      if (this.clearBlockDropHandlers === cleanup) this.clearBlockDropHandlers = null;
    };
    const suppressNextClick = (): void => {
      this.suppressBlockHandleClick = true;
      window.setTimeout(() => { this.suppressBlockHandleClick = false; }, 0);
    };
    const move = (event: PointerEvent): void => {
      if (event.pointerId !== start.pointerId) return;
      if (!moved && Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < 6) return;
      moved = true;
      blockEl.addClass("is-dragging");
      event.preventDefault();
      showGhost(event);
      const target = this.plugin.resolveAssistantDropTarget(notePath, event.clientX, event.clientY);
      if (target.kind === "precise") showIndicator(target.markerTop, target.left, target.right);
      else hideIndicator();
    };
    const finish = (event: PointerEvent): void => {
      if (event.pointerId !== start.pointerId) return;
      const shouldInsert = moved && event.type === "pointerup";
      const target = shouldInsert
        ? this.plugin.resolveAssistantDropTarget(notePath, event.clientX, event.clientY)
        : null;
      cleanup();
      if (!shouldInsert || !target) return;
      event.preventDefault();
      suppressNextClick();
      if (target.kind === "precise") {
        void this.plugin.insertAssistantBlock(notePath, markdown, target.offset, target.view)
          .catch(error => new Notice(errorMessage(error)));
      } else if (target.kind === "cursor-fallback") {
        void this.plugin.insertAssistantBlock(notePath, markdown, undefined, target.view)
          .then(() => new Notice("未识别拖放位置，已插入当前光标。"))
          .catch(error => new Notice(errorMessage(error)));
      } else {
        new Notice(target.reason);
      }
    };
    const cancelWithKeyboard = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (moved) suppressNextClick();
        cleanup();
      }
    };

    ownerDocument.addEventListener("pointermove", move, true);
    ownerDocument.addEventListener("pointerup", finish, true);
    ownerDocument.addEventListener("pointercancel", finish, true);
    ownerDocument.addEventListener("keydown", cancelWithKeyboard, true);
    this.clearBlockDropHandlers = cleanup;
  }

  private armImageDrag(start: PointerEvent, card: HTMLElement, asset: ImageAsset): void {
    if (start.button !== 0) return;
    this.clearImageDropHandlers?.();
    const ownerDocument = card.ownerDocument;
    let moved = false;
    let ghost: HTMLElement | null = null;
    let ghostStatus: HTMLElement | null = null;
    const isMarkdownPoint = (clientX: number, clientY: number): boolean => {
      return this.app.workspace.getLeavesOfType("markdown").some(leaf => {
        if (!(leaf.view instanceof MarkdownView) || leaf.view.file?.path !== this.notePath) return false;
        const rect = leaf.view.containerEl.getBoundingClientRect();
        return clientX >= rect.left && clientX <= rect.right
          && clientY >= rect.top && clientY <= rect.bottom;
      });
    };
    const showGhost = (event: PointerEvent): void => {
      if (!ghost) {
        ghost = ownerDocument.body.createDiv({ cls: "oa-image-drag-ghost", attr: { "aria-hidden": "true" } });
        ghost.createEl("img", { attr: { src: this.resourcePath(asset), alt: "" } });
        ghostStatus = ghost.createSpan({ text: "拖到正文" });
      }
      const overEditor = isMarkdownPoint(event.clientX, event.clientY);
      ghost.toggleClass("is-over-editor", overEditor);
      ghostStatus?.setText(overEditor ? "松手插入正文" : "拖到正文");
      ghost.style.transform = `translate3d(${event.clientX + 14}px, ${event.clientY + 14}px, 0) rotate(-2deg)`;
    };
    const move = (event: PointerEvent): void => {
      if (event.pointerId !== start.pointerId) return;
      if (!moved && Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < 6) return;
      moved = true;
      card.addClass("is-dragging");
      event.preventDefault();
      showGhost(event);
    };
    const finish = (event: PointerEvent): void => {
      if (event.pointerId !== start.pointerId) return;
      this.clearImageDropHandlers?.();
      if (moved && event.type === "pointerup" && isMarkdownPoint(event.clientX, event.clientY)) {
        event.preventDefault();
        void this.plugin.insertImage(this.notePath, asset).catch(error => new Notice(errorMessage(error)));
      }
      window.setTimeout(() => card.removeClass("is-dragging"), 0);
    };
    // ponytail: custom pointer tracking avoids Electron dropping native `drop`
    // events while preserving the ordinary single-click card action.
    ownerDocument.addEventListener("pointermove", move, true);
    ownerDocument.addEventListener("pointerup", finish, true);
    ownerDocument.addEventListener("pointercancel", finish, true);
    this.clearImageDropHandlers = () => {
      ownerDocument.removeEventListener("pointermove", move, true);
      ownerDocument.removeEventListener("pointerup", finish, true);
      ownerDocument.removeEventListener("pointercancel", finish, true);
      ghost?.remove();
      ghost = null;
      this.clearImageDropHandlers = null;
    };
  }
}

function autoGrow(textarea: HTMLTextAreaElement): void {
  textarea.setCssProps({ height: "auto" });
  textarea.setCssProps({ height: `${Math.min(180, Math.max(76, textarea.scrollHeight))}px` });
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(timestamp));
}
