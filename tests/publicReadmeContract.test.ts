import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("public README leads to a real 30-second install and keeps product capabilities concise", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

  assert.match(readme, /## 30 秒安装 WriteX/);
  assert.ok(readme.indexOf("## 30 秒安装 WriteX") < readme.indexOf("## 它适合什么场景"));
  assert.doesNotMatch(readme, /## 30 秒开始/);
  assert.doesNotMatch(readme, /使用 WorkBuddy，为什么还要装 CodeBuddy/);
  assert.doesNotMatch(readme, /### 在当前笔记里用 Agent/);
  assert.doesNotMatch(readme, /### 图片和公众号排版/);
  assert.doesNotMatch(readme, /### 安全同步到草稿箱/);
});

test("WorkBuddy connection explanation lives in product settings", async () => {
  const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const settings = main.match(/class AgentSettingTab[\s\S]*?function cleanAssistantMarkdown/)?.[0] ?? "";

  assert.match(settings, /WriteX 通过腾讯官方 codebuddy\/cbc CLI 连接 WorkBuddy/);
  assert.match(settings, /不会读取 WorkBuddy 桌面 App 的私有登录信息/);
  assert.match(settings, /npm install -g @tencent-ai\/codebuddy-code/);
  assert.match(settings, /运行 codebuddy 完成登录/);
});
