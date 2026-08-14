import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BUILTIN_THEMES } from "../src/themeBuiltins.ts";
import { buildCodexArgs } from "../src/codex.ts";
import {
  buildThemeCompilePrompt,
  parseThemeCompileResult,
  type ThemeCompileSource,
} from "../src/themeCompiler.ts";

const source: ThemeCompileSource = {
  kind: "vault",
  name: "my-layout.md",
  path: "排版/my-layout.md",
  sha256: "a".repeat(64),
  content: "# 排版要求\n正文 15px，绿色标题。",
};

function themeJson(): string {
  const theme = structuredClone(BUILTIN_THEMES.default);
  theme.manifest.id = "pakco.compiled";
  theme.manifest.name = "编译排版";
  return JSON.stringify(theme);
}

test("theme compile prompt is source-bound, schema-bound and contains no article or secret context", () => {
  const prompt = buildThemeCompilePrompt(source);
  assert.match(prompt, /只返回一个 JSON 对象/);
  assert.match(prompt, /schemaVersion/);
  assert.match(prompt, /\{\{children\}\}/);
  assert.match(prompt, /\{\{src\}\}/);
  assert.match(prompt, /排版\/my-layout\.md/);
  assert.match(prompt, new RegExp("a{64}"));
  assert.match(prompt, /正文 15px/);
  assert.match(prompt, /不要修改源文件/);
  assert.match(prompt, /不要添加 script、style、class、id 或网络资源/);
  assert.match(prompt, /tokens 的每个值必须是字符串/);
  assert.match(prompt, /允许的 HTML 标签：section, p, span/);
  assert.match(prompt, /delete 节点必须使用 span/);
  assert.match(prompt, /允许的 CSS 属性：align-items/);
  assert.match(prompt, /word-spacing/);
  assert.match(prompt, /不要使用 del、transform、transform-origin 或 table-layout/);
  assert.doesNotMatch(prompt, /当前文章|Chat 历史|Relay|AppSecret|Access Token/);
});

test("theme compile parser accepts one plain or fenced JSON object only", () => {
  assert.equal(parseThemeCompileResult(themeJson()).manifest.id, "pakco.compiled");
  assert.equal(parseThemeCompileResult("```json\n" + themeJson() + "\n```").manifest.name, "编译排版");
  assert.throws(() => parseThemeCompileResult(`这是结果：\n${themeJson()}`), /只允许返回一个 JSON 对象/);
  assert.throws(() => parseThemeCompileResult(`${themeJson()}\n${themeJson()}`), /JSON|对象/);
  assert.throws(() => parseThemeCompileResult("{broken"), /JSON/);
  assert.throws(() => parseThemeCompileResult("x".repeat(2 * 1024 * 1024 + 1)), /2 MiB/);
});

test("theme compile parser rejects locally invalid packages and fixture render failures", () => {
  const invalid = JSON.parse(themeJson());
  invalid.components.paragraph.template = '<p onclick="evil()">{{children}}</p>';
  assert.throws(() => parseThemeCompileResult(JSON.stringify(invalid)), /校验失败/);

  const incomplete = JSON.parse(themeJson());
  delete incomplete.mapping.paragraph;
  assert.throws(() => parseThemeCompileResult(JSON.stringify(incomplete)), /样例渲染失败/);
});

test("theme compile parser normalizes only known safe Agent drift before strict validation", () => {
  const drifted = JSON.parse(themeJson());
  drifted.tokens = {
    colors: { text: "rgb(89, 89, 89)" },
    fontSizes: { body: "16px" },
    lineHeights: { body: "1.75" },
    keepMe: "flat-token",
  };
  drifted.components.document.template = '<section style="word-wrap:break-word">{{children}}</section>';
  drifted.components.delete.template = '<del style="color:rgb(0, 0, 0)">{{children}}</del>';
  drifted.components.horizontalRule.template = '<hr style="border-top:1px solid rgba(0,0,0,.1);transform:scale(1,.5);transform-origin:center">';
  drifted.components.table.template = '<table style="width:100%;table-layout:fixed">{{children}}</table>';

  const parsed = parseThemeCompileResult(JSON.stringify(drifted));
  assert.deepEqual(parsed.tokens, { keepMe: "flat-token" });
  assert.match(parsed.components.document.template, /overflow-wrap:break-word/);
  assert.match(parsed.components.delete.template, /^<span/);
  assert.match(parsed.components.delete.template, /text-decoration:line-through/);
  assert.doesNotMatch(parsed.components.horizontalRule.template, /transform/);
  assert.doesNotMatch(parsed.components.table.template, /table-layout/);

  const unsafe = JSON.parse(themeJson());
  unsafe.components.paragraph.template = '<p style="position:fixed">{{children}}</p>';
  assert.throws(() => parseThemeCompileResult(JSON.stringify(unsafe)), /不允许 CSS 属性 position/);
});

test("only a new explicit one-shot Codex turn adds ephemeral; normal and resumed Chat args stay unchanged", () => {
  const normal = buildCodexArgs({ cwd: "/vault", model: "gpt-5.6-sol" });
  const oneShot = buildCodexArgs({ cwd: "/vault", model: "gpt-5.6-sol", ephemeral: true });
  const resumed = buildCodexArgs({ cwd: "/vault", threadId: "thread-1", model: "gpt-5.6-sol", ephemeral: true });
  assert.equal(normal.includes("--ephemeral"), false);
  assert.equal(oneShot.includes("--ephemeral"), true);
  assert.equal(resumed.includes("--ephemeral"), false);
  assert.deepEqual(normal.filter(value => value !== "--ephemeral"), oneShot.filter(value => value !== "--ephemeral"));
  assert.deepEqual(resumed.slice(-2), ["thread-1", "-"]);
});

test("production theme compilation is explicit, cancellable and isolated from Chat state", async () => {
  const [main, agents, library] = await Promise.all([
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/chatAgents.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/themeLibraryModal.ts", import.meta.url), "utf8"),
  ]);
  const compileMethod = main.match(/async compileThemeSource\([\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(agents, /async runOneShot\(/);
  assert.match(compileMethod, /chatRuntime\.runOneShot\(/);
  assert.doesNotMatch(compileMethod, /messages\.push|setAgentSession|sessionId/);
  assert.match(library, /使用当前 Agent 账号\/API 额度/);
  assert.match(library, /WriteX 积分 0/);
  assert.match(library, /不会切换到 WriteX Cloud/);
  assert.match(library, /ThemeCompileStage/);
  assert.match(library, /new AbortController\(\)/);
  assert.match(library, /sourceType: "compiled"/);
});

test("theme compilation keeps the concrete failure visible after the transient Notice", async () => {
  const library = await readFile(new URL("../src/themeLibraryModal.ts", import.meta.url), "utf8");
  assert.match(library, /private compileError = ""/);
  assert.match(library, /oa-theme-compile-error/);
  assert.match(library, /this\.compileError = errorMessage\(error\)/);
});
