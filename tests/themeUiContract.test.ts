import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("WriteX settings are grouped into collapsed sections and empty reserved sections stay hidden", async () => {
  const [main, styles] = await Promise.all([
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
  ]);
  const settings = main.match(/class AgentSettingTab[\s\S]*?function cleanAssistantMarkdown/)?.[0] ?? "";
  const groupHelper = settings.match(/private createSettingsGroup[\s\S]*?\n  \}/)?.[0] ?? "";

  for (const title of ["AI设置", "公众号账号设置", "WriteX云服务", "其它"]) {
    assert.match(settings, new RegExp(`createSettingsGroup\\(containerEl, "${title}"\\)`));
  }
  assert.match(groupHelper, /createEl\("details"/);
  assert.match(groupHelper, /createEl\("summary"/);
  assert.doesNotMatch(groupHelper, /open/);
  assert.match(settings, /if \(!otherSettings\.childElementCount\) otherSettings\.parentElement\?\.remove\(\)/);
  assert.doesNotMatch(settings, /setName\("WriteX"\)\.setHeading\(\);/);
  assert.doesNotMatch(settings, /createEl\("h2", \{ text: "WriteX" \}\)/);
  assert.doesNotMatch(settings, /createEl\("h3", \{ text: "微信公众号草稿同步" \}\)/);
  assert.match(styles, /\.oa-settings-group/);
  assert.match(styles, /\.oa-settings-group > summary/);
});

test("Chat welcome uses the WriteX logo and draft sync enables comments by default", async () => {
  const [view, sync] = await Promise.all([
    readFile(new URL("../src/view.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/sync.ts", import.meta.url), "utf8"),
  ]);
  const welcome = view.match(/private renderChatWelcome[\s\S]*?private startOutline/)?.[0] ?? "";

  assert.match(welcome, /setIcon\(icon, WRITEX_ICON\)/);
  assert.doesNotMatch(welcome, /setIcon\(icon, "sparkles"\)/);
  assert.match(sync, /private commentsEnabled = true/);
  assert.match(sync, /默认开启，可在本次同步前关闭。/);
});

test("preview uses one installed-theme selector and local ThemeService rendering", async () => {
  const view = await readFile(new URL("../src/view.ts", import.meta.url), "utf8");
  const preview = view.match(/private renderPreview\([\s\S]*?private async switchTab/)?.[0] ?? "";

  assert.equal((preview.match(/createEl\("select"/g) ?? []).length, 1);
  assert.match(preview, /管理排版/);
  assert.match(preview, /themeService\.listThemes\(\)/);
  assert.match(preview, /themeService\.render\(/);
  assert.match(preview, /state\.themeId = selectedId/);
  assert.match(preview, /await this\.plugin\.themeService\.install\(selectedId\)/);
  assert.match(preview, /theme\.value = currentThemeId/);
  assert.match(preview, /正在安装|正在下载|正在校验|等待网络/);
  assert.match(preview, /重试/);
  assert.doesNotMatch(preview, /layoutSkillNamesForTheme|isSkillBackedTheme|runSkillPreviewRender/);
  assert.doesNotMatch(preview, /生成排版|排版已过期|未安装对应排版 Skill/);
});

test("preview subscribes to theme changes and preserves the last valid HTML", async () => {
  const view = await readFile(new URL("../src/view.ts", import.meta.url), "utf8");

  assert.match(view, /themeService\.subscribe\(\(\) => this\.render\(\)\)/);
  assert.match(view, /this\.unsubscribeThemeService\?\.\(\)/);
  assert.match(view, /private previewHtml = ""/);
  assert.match(view, /private previewRenderKey = ""/);
  assert.match(view, /private previewRenderError = ""/);
  assert.match(view, /this\.previewHtml = rendered\.html/);
  assert.match(view, /catch \(error\)[\s\S]*this\.previewRenderError = errorMessage\(error\)/);
  assert.match(view, /article\.appendChild\(sanitizeHTMLToDom\(this\.previewHtml\)\)/);
  assert.doesNotMatch(view, /article\.innerHTML/);
});

test("directory-review UI rules use Obsidian helpers instead of forbidden DOM shortcuts", async () => {
  const [themeLibrary, view] = await Promise.all([
    readFile(new URL("../src/themeLibraryModal.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/view.ts", import.meta.url), "utf8"),
  ]);

  assert.match(themeLibrary, /preview\.appendChild\(sanitizeHTMLToDom\(this\.html\)\)/);
  assert.doesNotMatch(themeLibrary, /innerHTML|createContextualFragment/);
  assert.doesNotMatch(view, /textarea\.style\.height/);
  assert.match(view, /textarea\.setCssProps\(\{ height: "auto" \}\)/);
  assert.match(view, /textarea\.setCssProps\(\{ height: `\$\{Math\.min\(180, Math\.max\(76, textarea\.scrollHeight\)\)\}px` \}\)/);
});

test("editor debounce is local and copy or sync require a usable current theme", async () => {
  const [view, main] = await Promise.all([
    readFile(new URL("../src/view.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
  ]);
  const editorChange = view.match(/workspace\.on\("editor-change"[\s\S]*?\}\)\);/)?.[0] ?? "";

  assert.match(editorChange, /window\.setTimeout/);
  assert.match(editorChange, /this\.render\(\)/);
  assert.doesNotMatch(editorChange, /Agent|Skill|generate|runtime/);
  assert.match(view, /private isPreviewThemeReady\(\): boolean/);
  assert.match(view, /copy\.disabled = [^;]*!this\.isPreviewThemeReady\(\)/);
  assert.match(view, /sync\.disabled = [^;]*!this\.isPreviewThemeReady\(\)/);
  assert.doesNotMatch(main, /async generateSkillRender\(/);
});

test("note rename, editor image sync, and image-size selection stay connected to native Obsidian", async () => {
  const [view, main, styles] = await Promise.all([
    readFile(new URL("../src/view.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(main, /vault\.on\("rename"/);
  assert.match(view, /vault\.on\("rename"/);
  const renameHandler = view.match(/vault\.on\("rename"[\s\S]*?this\.render\(\);\n      void this\.refreshSkills\(\);/)?.[0] ?? "";
  assert.match(renameHandler, /this\.noteComposerStates\.rename\(oldPath, file\.path\);[\s\S]*if \(!renamedCurrentNote\) return;/);
  assert.match(view, /getActiveFile\(\)[\s\S]*当前 Markdown 笔记已经移动或删除/);
  assert.match(main, /syncReferencedImages/);
  assert.match(view, /editor-change[\s\S]*scheduleReferencedImageSync/);
  assert.match(view, /tab === "gallery"[\s\S]*syncReferencedImages/);
  assert.match(view, /oa-image-size-select/);
  assert.match(view, /横图 3:2/);
  assert.match(view, /方图 1:1/);
  assert.match(view, /竖图 2:3/);
  assert.match(styles, /\.oa-image-size-select/);
});

test("Chat starts an outline from real local material without auto-sending", async () => {
  const [view, styles] = await Promise.all([
    readFile(new URL("../src/view.ts", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(view, /const OUTLINE_PROMPT =/);
  assert.match(view, /文章结构设计师/);
  assert.match(view, /七段式递进[\s\S]*漏斗式教程[\s\S]*情绪弧线[\s\S]*剥洋葱/);
  assert.match(view, /5Why[\s\S]*MECE[\s\S]*快思维[\s\S]*慢思维/);
  assert.match(view, /Step 1：选题定性[\s\S]*Step 2：核心观点萃取[\s\S]*Step 3：结构选择[\s\S]*Step 4：血肉填充[\s\S]*Step 5：大纲成型 \+ 校准/);
  assert.match(view, /方案A：七段式递进[\s\S]*方案B：漏斗式教程[\s\S]*方案C：情绪弧线叙事[\s\S]*方案D：剥洋葱式诊断/);
  assert.match(view, /第1段（起）[\s\S]*钩子层[\s\S]*具体的画面或时刻[\s\S]*大多数人看到的「症状」/);
  assert.match(view, /## 文章定位[\s\S]*## 大纲骨架[\s\S]*## 情绪曲线设计[\s\S]*## 逻辑曲线设计[\s\S]*## 表达理论标签[\s\S]*## 写作建议/);
  assert.match(view, /不直接给答案[\s\S]*强制收敛[\s\S]*结构先行[\s\S]*情绪可视化[\s\S]*可回包/);
  assert.match(view, /优先使用当前选区、当前笔记和当前对话里的真实材料/);
  assert.match(view, /材料不足或关键方向冲突时，才问 1–3 个必要问题/);
  assert.match(view, /材料充分时可以直接产出可写大纲/);
  assert.match(view, /材料不足时先输出必要问题，再在最后另起一行输出 \$\{OUTLINE_NEEDS_INPUT_MARKER\}/);
  assert.match(view, /from "\.\/outlineResult"/);
  assert.match(view, /parseOutlineResult\(result\.text\)/);
  assert.match(view, /completedOutline && this\.outlineSession && this\.controller === controller/);
  assert.match(view, /outlineSession && !turnSucceeded && this\.controller === controller/);
  assert.match(view, /private stopRun\(\): void \{\s*this\.outlineSession = false;/);
  assert.match(view, /不要编造用户经历、数据或论据/);
  assert.match(view, /aria-label": "大纲：通过五步问答搭建文章骨架"/);
  assert.match(view, /title: "通过五步问答搭建文章骨架"/);
  assert.match(view, /setIcon\(outlineIcon, "list-tree"\)/);
  assert.match(view, /outline\.createSpan\(\{ text: "大纲" \}\)/);
  assert.doesNotMatch(view, /aria-label": "找切口：随机准备 3 个观察方向"/);
  assert.match(view, /outlineResult/);
  assert.match(view, /outlineSession/);
  assert.match(view, /private prepareComposerDraft/);
  assert.match(view, /private startOutline\(\): void/);
  assert.match(view, /this\.prepareComposerDraft\(OUTLINE_PROMPT, \{ plan: true, prefix: true \}\)/);
  assert.doesNotMatch(view, /buildCutPrompt|sampleCutLenses/);
  assert.match(view, /if \(!options\.prefix && current && current !== target\)/);
  assert.match(view, /options\.prefix && current \? `\$\{target\}\\n\\n\$\{current\}` : target/);
  const shortcutMarkup = view.match(/const shortcuts = form\.createDiv\([\s\S]*?if \(this\.imageMode\)/)?.[0] ?? "";
  assert.doesNotMatch(shortcutMarkup, /真实经历 → 选题 → 写作/);
  assert.doesNotMatch(shortcutMarkup, /createEl\("small"/);
  const shortcutRule = styles.match(/\.oa-chat-shortcuts button\s*\{[^}]*\}/s)?.[0] ?? "";
  assert.match(shortcutRule, /border:\s*0/);
  assert.match(shortcutRule, /color:\s*var\(--text-muted\)/);
  assert.match(shortcutRule, /background:\s*transparent/);
  assert.doesNotMatch(shortcutRule, /var\(--oa-accent\)/);
  assert.match(styles, /\.oa-chat-shortcuts button:hover[\s\S]*?color:\s*var\(--oa-accent\)/);
  assert.doesNotMatch(view, /DIVERGE_PROMPT|startDivergence|aria-label": "发散/);
  const shortcuts = view.match(/private startOutline\([\s\S]*?private openTopicLibrary/)?.[0] ?? "";
  assert.doesNotMatch(shortcuts, /sendMessage|requestSubmit|chatRuntime|createRelayClient|openWeChatSync/);
  assert.match(styles, /\.oa-chat-shortcuts/);
});

test("assistant insertion uses a short visible label with a precise accessible name", async () => {
  const view = await readFile(new URL("../src/view.ts", import.meta.url), "utf8");
  const actions = view.match(/private renderMessageActions\([\s\S]*?private actionButton/)?.[0] ?? "";
  const helper = view.match(/private actionButton\([\s\S]*?\n  \}/)?.[0] ?? "";

  assert.doesNotMatch(actions, /"插入光标"/);
  assert.match(actions, /"text-cursor-input",\s*"插入"/);
  assert.match(actions, /"插入当前光标位置"/);
  assert.match(helper, /title:\s*accessibleLabel/);
  assert.match(helper, /"aria-label":\s*accessibleLabel/);
});

test("assistant Markdown blocks keep selectable text and expose one cancellable drag handle", async () => {
  const [view, styles] = await Promise.all([
    readFile(new URL("../src/view.ts", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(view, /splitAssistantMarkdownBlocks/);
  assert.match(view, /private renderAssistantBlocks\(/);
  const render = view.match(/private renderAssistantBlocks\([\s\S]*?private renderMessageActions/)?.[0] ?? "";
  assert.match(render, /oa-assistant-block/);
  assert.match(render, /oa-assistant-block-content/);
  assert.match(render, /MarkdownRenderer\.render\([\s\S]*?block\.markdown/);
  assert.match(render, /oa-block-drag-handle/);
  assert.match(render, /type:\s*"button"/);
  assert.match(render, /aria-label":\s*"拖动或插入这一块"/);
  assert.match(render, /setIcon\(handle,\s*"hand"\)/);
  assert.match(render, /insertAssistantBlock\(this\.notePath, block\.markdown\)/);
  assert.match(render, /armAssistantBlockDrag\(event, blockEl, block\.markdown\)/);
  assert.doesNotMatch(render, /draggable/);

  const drag = view.match(/private armAssistantBlockDrag\([\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(drag, /Math\.hypot\([\s\S]*?< 6/);
  assert.match(drag, /pointermove/);
  assert.match(drag, /pointerup/);
  assert.match(drag, /pointercancel/);
  assert.match(drag, /event\.key === "Escape"/);
  assert.match(drag, /resolveAssistantDropTarget/);
  assert.match(drag, /target\.kind === "precise"/);
  assert.match(drag, /target\.offset/);
  assert.match(drag, /target\.offset, target\.view/);
  assert.match(drag, /target\.kind === "cursor-fallback"/);
  assert.match(drag, /markdown, undefined, target\.view/);
  assert.match(drag, /未识别拖放位置，已插入当前光标。/);

  assert.match(view, /private clearBlockDropHandlers: \(\(\) => void\) \| null = null/);
  assert.match(view, /this\.clearBlockDropHandlers\?\.\(\)/);
  assert.match(styles, /\.oa-assistant-block-content[\s\S]*?user-select:\s*text/);
  assert.match(styles, /\.oa-block-drop-indicator[\s\S]*?height:\s*1px/);
  assert.match(styles, /\.oa-block-drop-indicator[\s\S]*?pointer-events:\s*none/);
  assert.match(drag, /oa-block-drag-ghost/);
  assert.match(drag, /markdownToPlainText\(markdown\)/);
  assert.match(drag, /ghost\.style\.transform/);
  assert.match(styles, /\.oa-block-drag-ghost[\s\S]*?position:\s*fixed/);
  assert.match(styles, /\.oa-block-drag-ghost[\s\S]*?pointer-events:\s*none/);
  const handleRule = styles.match(/\.oa-block-drag-handle\s*\{[^}]*\}/s)?.[0] ?? "";
  const handleIconRule = styles.match(/\.oa-block-drag-handle svg\s*\{[^}]*\}/s)?.[0] ?? "";
  assert.match(handleRule, /width:\s*17px/);
  assert.match(handleRule, /height:\s*19px/);
  assert.match(handleIconRule, /width:\s*11px/);
  assert.match(handleIconRule, /height:\s*11px/);
});

test("gallery image dragging shows the image under the pointer and a valid-editor state", async () => {
  const [view, styles] = await Promise.all([
    readFile(new URL("../src/view.ts", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
  ]);
  const drag = view.match(/private armImageDrag\([\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(drag, /oa-image-drag-ghost/);
  assert.match(drag, /this\.resourcePath\(asset\)/);
  assert.match(drag, /ghost\.toggleClass\("is-over-editor"/);
  assert.match(drag, /ghost\.style\.transform/);
  assert.match(styles, /\.oa-image-drag-ghost[\s\S]*?position:\s*fixed/);
  assert.match(styles, /\.oa-image-drag-ghost\.is-over-editor/);
});

test("assistant block drop validates the real Markdown editor and writes once through public Editor APIs", async () => {
  const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(main, /type AssistantDropTarget/);
  assert.match(main, /kind:\s*"precise"/);
  assert.match(main, /kind:\s*"cursor-fallback"/);
  assert.match(main, /kind:\s*"rejected"/);
  const resolve = main.match(/resolveAssistantDropTarget\([\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(resolve, /getLeavesOfType\("markdown"\)/);
  assert.match(resolve, /file\?\.path !== filePath/);
  assert.match(resolve, /getMode\(\) !== "source"/);
  assert.match(resolve, /elementFromPoint/);
  assert.match(resolve, /\.cm-editor/);
  assert.match(resolve, /\.cm-content/);
  assert.match(resolve, /content\.contains\(pointElement\)/);
  assert.match(resolve, /clientX >= contentBounds\.left/);
  assert.match(resolve, /clientX <= contentBounds\.right/);
  assert.match(resolve, /asCodeMirrorDropBridge/);
  assert.match(resolve, /resolveLineDrop/);

  const insert = main.match(/async insertAssistantBlock\([\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(insert, /buildMarkdownBlockInsertion/);
  assert.match(insert, /editor\.posToOffset\(editor\.getCursor\(\)\)/);
  assert.match(insert, /editor\.offsetToPos\(/);
  assert.equal((insert.match(/editor\.replaceRange\(/g) ?? []).length, 1);
  assert.match(insert, /editor\.setCursor\(/);
  assert.match(insert, /editor\.focus\(\)/);
  assert.match(insert, /targetView/);
  assert.match(insert, /leaf\.view === targetView/);
  assert.doesNotMatch(insert, /vault\.modify|MarkdownRenderer|chatRuntime|requestUrl|createRelayClient/);
});

test("one Vault Skill index serves Chat and Theme Library and invalidates only after install", async () => {
  const [main, themeLibrary] = await Promise.all([
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/themeLibraryModal.ts", import.meta.url), "utf8"),
  ]);

  assert.match(main, /VaultSkillIndex/);
  assert.match(main, /private skillIndex/);
  assert.equal((main.match(/new VaultSkillIndex\(/g) ?? []).length, 1);
  const discover = main.match(/async discoverSkills\([\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(discover, /refresh\?: boolean/);
  assert.match(discover, /getActiveFile\(\)/);
  assert.match(discover, /this\.skillIndex\.discover/);
  assert.match(main, /getSkillPathStatus\(path: string\)/);
  assert.match(main, /this\.skillIndex\.getPathStatus\(path\)/);
  const install = main.match(/async installSkill\([\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(install, /await installLocalSkill/);
  assert.match(install, /this\.skillIndex\.invalidate\(\)/);
  assert.ok(install.indexOf("await installLocalSkill") < install.indexOf("this.skillIndex.invalidate()"));
  assert.match(themeLibrary, /this\.plugin\.discoverSkills\(\)/);
  assert.doesNotMatch(themeLibrary, /new VaultSkillIndex|discoverLocalSkills/);
});

test("Skill discovery exposes four truthful states and stale scans cannot mutate another note", async () => {
  const [view, styles] = await Promise.all([
    readFile(new URL("../src/view.ts", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(view, /type SkillDiscoveryState = "loading" \| "ready" \| "empty" \| "failed"/);
  assert.match(view, /private skillDiscoveryState: SkillDiscoveryState/);
  assert.match(view, /private skillScanError = ""/);
  assert.match(view, /private skillScanRequestId = 0/);
  for (const copy of ["正在查找 Skill…", "选择 Skill", "安装 Skill", "Skill 扫描失败", "Skill 文件无效", "重新扫描"]) {
    assert.match(view, new RegExp(copy));
  }
  assert.match(view, /loader-circle/);
  assert.match(view, /aria-live":\s*"polite"/);
  assert.match(view, /refreshSkills\(true\)/);
  assert.match(styles, /\.oa-skill-spinner svg[\s\S]*?animation:\s*oa-spin/);

  const refresh = view.match(/private async refreshSkills\([\s\S]*?private openSkillPicker/)?.[0] ?? "";
  assert.match(refresh, /const requestId = \+\+this\.skillScanRequestId/);
  assert.match(refresh, /const notePath = this\.notePath/);
  const guards = refresh.match(/!isCurrentSkillScan\(requestId, notePath, this\.skillScanRequestId, this\.notePath\)/g) ?? [];
  assert.ok(guards.length >= 3);
  assert.match(refresh, /skills = await this\.plugin\.discoverSkills\(notePath, \{ refresh \}\)/);
  assert.match(refresh, /this\.localSkills = skills/);
  const failure = refresh.match(/catch \(error\) \{[\s\S]*?\n    \}/)?.[0] ?? "";
  assert.doesNotMatch(failure, /this\.localSkills = \[\]/);
  assert.doesNotMatch(failure, /delete state\.activeSkillPath/);
  assert.match(refresh, /const staleSkillPath = state\?\.activeSkillPath/);
  assert.match(refresh, /const pathStatus = this\.plugin\.getSkillPathStatus\(staleSkillPath\)/);
  assert.match(refresh, /pathStatus\.kind === "invalid"/);
  assert.match(refresh, /Skill 文件无效/);
  assert.ok(refresh.indexOf('pathStatus.kind === "invalid"') < refresh.indexOf("delete state.activeSkillPath"));
  assert.match(refresh, /pathStatus\.kind === "missing"/);
  assert.match(refresh, /state\.activeSkillPath = staleSkillPath/);
  assert.match(refresh, /Skill 状态保存失败/);
  assert.match(view, /this\.skillScanRequestId \+= 1/);

  assert.match(view, /findLocalSkillByPath/);
  assert.doesNotMatch(view, /localSkills\.find\(skill => skill\.skillFile === state\.activeSkillPath\)/);
  assert.match(view, /当前项目/);
  assert.match(view, /Vault 其他项目/);
  assert.match(view, /当前 Vault 未发现 Skill。/);
  assert.match(view, /没有匹配的 Skill/);
  assert.match(view, /重新扫描/);
});

test("an explicitly selected Skill blocks unresolved text or image turns and reaches image generation", async () => {
  const view = await readFile(new URL("../src/view.ts", import.meta.url), "utf8");
  const send = view.match(/private async sendMessage\([\s\S]*?private async runPendingImageWithAgent/)?.[0] ?? "";
  assert.match(send, /state\.activeSkillPath && !activeSkill/);
  assert.doesNotMatch(send, /!imageRequest && state\.activeSkillPath && !activeSkill/);
  assert.match(send, /当前启用的 Skill 尚未加载，请重新扫描或先停用 Skill。/);
  const guardIndex = send.indexOf("当前启用的 Skill 尚未加载");
  assert.ok(guardIndex >= 0);
  assert.ok(guardIndex < send.indexOf("state.messages.push"));
  assert.ok(guardIndex < send.indexOf("this.plugin.persist()"));
  assert.match(send, /const requestComposerState = \{[\s\S]*attachments: queuedAttachments/);
  assert.match(send, /await this\.plugin\.persist\(\);\s*const clearedRequestComposer = consumeCommittedComposerRequest\(\{/);
  assert.match(send, /request: requestComposerState[\s\S]*active: \{[\s\S]*notePath: this\.notePath/);
  assert.match(send, /if \(clearedRequestComposer\) \{/);
  assert.ok(guardIndex < send.indexOf("this.plugin.chatRuntime.runTurn"));
  const pendingImage = send.match(/this\.pendingImageRequest = \{[\s\S]*?\n\s*\};/)?.[0] ?? "";
  assert.match(pendingImage, /activeSkill \? buildExplicitSkillInstruction\(activeSkill\) : ""/);

  const chat = view.match(/private renderChat\([\s\S]*?private renderChatWelcome/)?.[0] ?? "";
  assert.match(chat, /if \(state\.activeSkillPath\)/);
  assert.match(chat, /停用当前 Skill/);
});

test("Skill selection rolls back failed persistence and every caller reports the error", async () => {
  const view = await readFile(new URL("../src/view.ts", import.meta.url), "utf8");
  const select = view.match(/private async selectChatSkill\([\s\S]*?private async startNewConversation/)?.[0] ?? "";
  assert.match(select, /const previousSkillPath = state\.activeSkillPath/);
  assert.match(select, /try \{[\s\S]*?await this\.plugin\.persist\(\)/);
  assert.match(select, /catch \(error\) \{[\s\S]*?state\.activeSkillPath = previousSkillPath/);
  assert.match(select, /throw error/);

  const picker = view.match(/private skillButton\([\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(picker, /try \{[\s\S]*?await this\.choose\(path\)/);
  assert.match(picker, /catch \(error\)[\s\S]*?new Notice\(errorMessage\(error\)\)/);
  const chat = view.match(/private renderChat\([\s\S]*?private renderChatWelcome/)?.[0] ?? "";
  assert.match(chat, /selectChatSkill\(""\)\.catch\(error => new Notice\(errorMessage\(error\)\)\)/);
});

test("assistant answers expose one-click local topic saving without an Agent path", async () => {
  const view = await readFile(new URL("../src/view.ts", import.meta.url), "utf8");
  const actions = view.match(/private renderMessageActions\([\s\S]*?private actionButton/)?.[0] ?? "";

  assert.match(actions, /"收为选题"/);
  assert.match(actions, /"已收住"/);
  assert.match(actions, /"bookmark-plus"/);
  assert.match(actions, /findTopicByMessage\(message\.id\)/);
  assert.match(actions, /saveTopicFromMessage\(this\.notePath, message\.id\)/);
  assert.match(view, /private topicSavePending = new Set<string>\(\)/);
  assert.match(actions, /topicSavePending\.has\(message\.id\)/);
  assert.match(actions, /已收进选题库/);
  assert.match(actions, /finally \{\s*this\.topicSavePending\.delete\(message\.id\);\s*this\.render\(\);\s*\}/);
  assert.doesNotMatch(actions, /sendMessage|chatRuntime|createRelayClient|Write Cloud|openWeChatSync/);
});

test("Topic Library is a standalone local card page and never auto-sends", async () => {
  const [view, topicPage, main, styles] = await Promise.all([
    readFile(new URL("../src/view.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/topicLibraryView.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(topicPage, /TOPIC_LIBRARY_VIEW_TYPE = "writex-topic-library-view"/);
  assert.match(topicPage, /getDisplayText\(\): string \{ return "WriteX 选题库"/);
  assert.match(topicPage, /把还没开始写、但不想忘记的一句话收住/);
  assert.match(topicPage, /想到什么，回车收住/);
  assert.match(topicPage, /shouldSaveQuickTopicOnKey\(event\.key, event\.isComposing\)/);
  assert.match(topicPage, /搜索标题或来源/);
  assert.match(topicPage, /groupTopicsByCreatedAt/);
  assert.match(topicPage, /继续写作[\s\S]*新建文章/);
  assert.match(topicPage, /关联已有文章/);
  assert.match(topicPage, /window\.confirm/);
  assert.match(topicPage, /getTopicArticleTargetPath/);
  assert.match(topicPage, /将创建：\$\{targetPath\}/);
  assert.match(topicPage, /continueTopicToChat/);
  assert.match(topicPage, /打开来源/);
  assert.match(topicPage, /改标题/);
  assert.match(topicPage, /删除/);
  assert.match(topicPage, /saveQuickTopicInput\(/);
  assert.match(topicPage, /refreshCards: \(\) => this\.renderCards\(\)/);
  assert.doesNotMatch(topicPage, /筛选选题状态|写作中|已完成/);
  assert.match(view, /选题库，\$\{this\.plugin\.data\.topics\.length\} 条/);
  assert.match(view, /activateTopicLibrary/);
  assert.match(view, /this\.prepareComposerDraft\(/);
  assert.doesNotMatch(view, /type ActiveTab = "chat" \| "gallery" \| "preview" \| "topics"/);
  assert.match(main, /registerView\(TOPIC_LIBRARY_VIEW_TYPE/);
  assert.match(main, /open-topic-library/);
  assert.match(main, /markTopicRatingsStaleForPositioningFile[\s\S]*?this\.refreshTopicLibraryViews\(\)/);
  assert.match(main, /private refreshTopicLibraryViews\(\): void/);
  assert.match(topicPage, /refresh\(\): void \{ this\.render\(\); \}/);
  assert.match(main, /getLeavesOfType\("markdown"\)[\s\S]*MarkdownView[\s\S]*file\?\.path === target\.path/);
  assert.match(styles, /\.oa-topic-card-grid/);
  assert.match(styles, /\.oa-topic-quick-input/);
  assert.doesNotMatch(styles, /\.oa-topic-filter\.is-active/);
});

test("v0.58 keeps writing style opt-in, local, and separate from the task Skill", async () => {
  const [view, main, modal, style, controller, types] = await Promise.all([
    readFile(new URL("../src/view.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/writingStyleModal.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/writingStyle.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/writingStyleController.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/types.ts", import.meta.url), "utf8"),
  ]);
  assert.match(types, /version: 6/);
  assert.match(types, /writingStyleProfile\?: WritingStyleProfile/);
  assert.match(types, /writingStyleEnabled\?: boolean/);
  assert.match(types, /writingStyle\?: WritingStyleSnapshot/);
  assert.match(view, /我的文风/);
  assert.match(view, /setWritingStyleEnabled/);
  assert.match(view, /buildStyleInstruction\(writingStyleProfile\)/);
  assert.match(view, /我的文风 · v\$\{message\.writingStyle\.revision\}/);
  assert.match(modal, /明确选择代表作/);
  assert.match(modal, /提炼候选文风/);
  assert.match(modal, /确认文风/);
  assert.match(modal, /确认导出/);
  assert.match(modal, /不会自动扫描正文或持续学习/);
  assert.match(modal, /private readonly selectionContext: SelectionContext \| null/);
  assert.doesNotMatch(modal, /private readonly selection: SelectionContext \| null/);
  assert.match(main, /exportWritingStyleSkill/);
  assert.match(main, /本地 Skill 已被手动修改，WriteX 不会覆盖/);
  assert.match(controller, /updateExisting/);
  assert.match(style, /WRITING_STYLE_SKILL_PATH/);
  assert.doesNotMatch(modal, /Write Cloud|createWriteRelayClient|openWeChatSync|requestUrl/);
});

test("v0.58 compares a captured selection before one protected replacement", async () => {
  const [view, diff, main, controller] = await Promise.all([
    readFile(new URL("../src/view.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/selectionDiff.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/writingStyleController.ts", import.meta.url), "utf8"),
  ]);
  assert.match(view, /class SelectionCompareModal extends Modal/);
  assert.match(view, /"差异".*"原文".*"建议"/s);
  assert.match(view, /"保留原文"/);
  assert.match(view, /"应用建议"/);
  assert.match(view, /computeSelectionReplacement\(this\.context, this\.markdown\)/);
  assert.match(view, /replaceOriginalSelection\(this\.context, this\.replacement\)/);
  assert.match(diff, /before\.length \+ after\.length > budget/);
  assert.match(diff, /Array\.from\(original\)/);
  assert.match(main, /replaceCapturedRange\(editor, context, replacement\)/);
  assert.match(controller, /原选区已经变化，请重新划词后再替换/);
});

test("WriteX branding changes user-facing copy but preserves compatibility identifiers", async () => {
  const [manifest, versions, pkg, packageLock, view, main, sync, relay] = await Promise.all([
    readFile(new URL("../manifest.json", import.meta.url), "utf8"),
    readFile(new URL("../versions.json", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
    readFile(new URL("../src/view.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/sync.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/writeRelay.ts", import.meta.url), "utf8"),
  ]);
  const metadata = JSON.parse(manifest);
  const lock = JSON.parse(packageLock);
  assert.deepEqual([metadata.id, metadata.name, metadata.version], ["writex", "WriteX", "0.6.2"]);
  assert.equal(metadata.minAppVersion, "1.11.4");
  assert.equal(JSON.parse(versions)["0.6.2"], "1.11.4");
  assert.equal(JSON.parse(pkg).name, "writex");
  assert.equal(JSON.parse(pkg).version, "0.6.2");
  assert.equal(lock.name, "writex");
  assert.equal(lock.version, "0.6.2");
  assert.equal(lock.packages[""].name, "writex");
  assert.equal(lock.packages[""].version, "0.6.2");
  assert.match(view, /aria-label": "WriteX"/);
  const brand = view.match(/const brand = header\.createDiv[\s\S]*?const actions =/)?.[0] ?? "";
  assert.match(brand, /createSpan\(\{ text: "Write" \}\)/);
  assert.match(brand, /createSpan\(\{ cls: "oa-brand-accent", text: "X" \}\)/);
  assert.equal((brand.match(/oa-brand-accent/g) ?? []).length, 1);
  assert.match(view, /export const WRITEX_ICON = "sprout"/);
  assert.match(view, /override getIcon\(\): string \{\s*return WRITEX_ICON;/);
  assert.doesNotMatch(main, /addIcon\(\s*WRITEX_ICON,/);
  assert.match(main, /addRibbonIcon\(WRITEX_ICON, "打开 WriteX"/);
  assert.doesNotMatch(`${view}\n${main}`, /return "bot"|addRibbonIcon\("pen-line"/);
  assert.match(`${view}\n${main}\n${sync}`, /WriteX 积分/);
  assert.match(relay, /X-Write-Relay-Key/);
  assert.match(sync, /write-wechat-theme/);
});

test("image generation keeps a visible timer, uncertain-duration copy, and Agent cancellation", async () => {
  const [view, styles] = await Promise.all([
    readFile(new URL("../src/view.ts", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(view, /耗时由当前模型和服务决定，可能需要几分钟/);
  assert.match(view, /已等待 \$\{minutes\}:\$\{remainder\}/);
  assert.match(view, /停止生图/);
  assert.match(view, /window\.setInterval\(\(\) => this\.updateImageProgress\(\), 1000\)/);
  assert.match(styles, /\.oa-image-progress-spinner svg/);
  assert.match(styles, /animation:\s*oa-spin/);
});

test("iPhone 16 preview is literally 375 by 813 and never scales with the pane", async () => {
  const [view, styles] = await Promise.all([
    readFile(new URL("../src/view.ts", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
  ]);
  const device = styles.match(/\.oa-preview-device\s*\{[^}]*\}/s)?.[0] ?? "";
  const stage = styles.match(/\.oa-preview-stage\s*\{[^}]*\}/s)?.[0] ?? "";
  const article = styles.match(/\.oa-wechat-article\s*\{[^}]*\}/s)?.[0] ?? "";
  assert.match(device, /width:\s*375px/);
  assert.match(device, /height:\s*813px/);
  assert.match(device, /flex:\s*0 0 375px/);
  assert.doesNotMatch(device, /min\(|aspect-ratio|max-height:\s*100%|transform/);
  assert.match(stage, /overflow:\s*auto/);
  assert.match(stage, /align-items:\s*flex-start/);
  assert.match(stage, /justify-content:\s*flex-start/);
  assert.match(device, /margin:\s*auto/);
  assert.match(article, /overflow-y:\s*auto/);
  assert.doesNotMatch(view, /--oa-device-width|--oa-device-height|--oa-device-ratio/);
});

test("Write Cloud entry is a resumable free trial without invite or endpoint friction", async () => {
  const [main, cloud, types] = await Promise.all([
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/writeCloud.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/types.ts", import.meta.url), "utf8"),
  ]);

  assert.match(main, /Write Cloud · 免费体验 8 次同步/);
  assert.match(main, /开始免费体验/);
  assert.match(main, /CLOUD_INSTALLATION_TOKEN_ID/);
  assert.doesNotMatch(main, /pendingCloudInvite|输入一次性邀请码/);
  assert.match(cloud, /\/v1\/auth\/trial/);
  assert.match(types, /https:\/\/cloud\.write\.pakcochan\.com/);
});

test("the final confirmation is rendered at the top of its sync step", async () => {
  const sync = await readFile(new URL("../src/sync.ts", import.meta.url), "utf8");
  const render = sync.match(/private render\(\): void \{[\s\S]*?private renderMeta/)?.[0] ?? "";
  const confirmation = render.indexOf("this.renderConfirmation(container)");

  assert.notEqual(confirmation, -1);
  for (const detail of [
    "this.renderTitle(container)",
    "this.renderMeta(container)",
    "this.renderIssues(container)",
    "this.renderCover(container)",
    "this.renderComments(container)",
  ]) assert.ok(confirmation < render.indexOf(detail), `最后确认应位于 ${detail} 之前`);
});

test("sync distinguishes visible text from final HTML limits and gives animated GIFs a copy route", async () => {
  const sync = await readFile(new URL("../src/sync.ts", import.meta.url), "utf8");
  assert.match(sync, /measureWeChatContent/);
  assert.match(sync, /可见正文/);
  assert.match(sync, /排版 HTML/);
  assert.match(sync, /formatBytes\(metrics\.htmlBytes\)/);
  assert.match(sync, /转为复制微信格式/);
  assert.match(sync, /精简排版并预览/);
  assert.match(sync, /previewCompactLayout\(this\.notePath\)/);
  assert.match(sync, /openCopyPlanForNote\(this\.notePath\)/);
  const view = await readFile(new URL("../src/view.ts", import.meta.url), "utf8");
  assert.match(view, /async openCopyPlanForNote\(notePath: string\)/);
});
