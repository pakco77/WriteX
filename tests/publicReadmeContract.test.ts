import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("public README leads to a real 30-second install and keeps product capabilities concise", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

  assert.match(readme, /## English/);
  assert.match(readme, /WriteX is an Obsidian-native writing workspace/);
  assert.match(readme, /create or update WeChat drafts only/);
  assert.match(readme, /does not scan or learn from your Vault automatically/);
  assert.match(readme, /## AI 强化原创/);
  assert.doesNotMatch(readme, /## 让 AI 强化原创/);
  assert.match(readme, /## 30 秒安装 WriteX/);
  assert.ok(readme.indexOf("## 30 秒安装 WriteX") < readme.indexOf("## 它适合什么场景"));
  assert.doesNotMatch(readme, /## 30 秒开始/);
  assert.match(readme, /\[WriteX v0\.5\.8\]\(https:\/\/github\.com\/pakco77\/WriteX\/releases\/tag\/0\.5\.8\)/);
  assert.match(readme, /`main\.js`、`manifest\.json` 和 `styles\.css`/);
  assert.match(readme, /GitHub Release 是当前可用的手动安装来源/);
  assert.doesNotMatch(readme, /尚未发布可下载安装包/);
  assert.doesNotMatch(readme, /使用 WorkBuddy，为什么还要装 CodeBuddy/);
  assert.doesNotMatch(readme, /### 在当前笔记里用 Agent/);
  assert.doesNotMatch(readme, /### 图片和公众号排版/);
  assert.doesNotMatch(readme, /### 安全同步到草稿箱/);
  assert.match(readme, /Vault Skill/);
  assert.match(readme, /文字创作与图片生成/);
  assert.match(readme, /直接在 Chat 中生成图片/);
  assert.match(readme, /Codex、Claude 和 WorkBuddy/);
  assert.match(readme, /自己的 Agent 订阅或 API 额度/);
  assert.match(readme, /会话历史/);
  assert.match(readme, /选题/);
  assert.match(readme, /我的文风/);
  assert.match(readme, /独立选题页/);
  assert.match(readme, /对比替换/);
  assert.match(readme, /Chat 附件与图片上下文/);
  assert.match(readme, /复制微信公众号格式/);
  assert.match(readme, /高级同步/);
  assert.match(readme, /!\[WriteX：Obsidian \+ Chat、图片集与预览\]\(docs\/images\/writex-product-overview-v2\.png\)/);
  assert.doesNotMatch(readme, /writex-chat-light-v1\.png/);
  assert.doesNotMatch(readme, /writex-gallery-light-v1\.png/);
  assert.doesNotMatch(readme, /writex-preview-light-v1\.png/);
  assert.doesNotMatch(readme, /writex-product-overview-v1\.png/);
  assert.doesNotMatch(readme, /writex-30s-demo-placeholder\.png/);
  assert.match(readme, /!\[WriteX 30 秒安装流程\]\(docs\/images\/writex-install-30s-v1\.png\)/);
  assert.match(readme, /!\[WriteX 适用场景\]\(docs\/images\/writex-use-cases-v1\.png\)/);
  assert.ok(readme.indexOf("writex-install-30s-v1.png") < readme.indexOf("## 它适合什么场景"));
});

test("public README infographics are real wide PNG assets", async () => {
  for (const name of [
    "writex-product-overview-v2.png",
    "writex-install-30s-v1.png",
    "writex-use-cases-v1.png",
  ]) {
    const bytes = await readFile(new URL(`../docs/images/${name}`, import.meta.url));
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(bytes.readUInt32BE(16) >= 1600);
    assert.ok(bytes.readUInt32BE(20) >= 900);
  }
});

test("WorkBuddy connection explanation lives in product settings", async () => {
  const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const settings = main.match(/class AgentSettingTab[\s\S]*?function cleanAssistantMarkdown/)?.[0] ?? "";

  assert.match(settings, /WriteX 通过腾讯官方 codebuddy\/cbc CLI 连接 WorkBuddy/);
  assert.match(settings, /不会读取 WorkBuddy 桌面 App 的私有登录信息/);
  assert.match(settings, /npm install -g @tencent-ai\/codebuddy-code/);
  assert.match(settings, /运行 codebuddy 完成登录/);
});
