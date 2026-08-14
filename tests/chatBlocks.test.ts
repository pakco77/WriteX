import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMarkdownBlockInsertion,
  splitAssistantMarkdownBlocks,
  type AssistantMarkdownBlock,
  type MarkdownBlockInsertion,
} from "../src/chatBlocks.ts";

test("assistant blocks normalize CRLF, discard separator-only input, and split paragraphs", () => {
  assert.deepEqual(splitAssistantMarkdownBlocks("empty", "\r\n \t\r\n"), []);

  const blocks = splitAssistantMarkdownBlocks(
    "answer",
    "第一行。\r\n仍属于第一段。\r\n\r\n第二段。",
  );
  assert.deepEqual(blocks.map(block => [block.kind, block.markdown]), [
    ["paragraph", "第一行。\n仍属于第一段。"],
    ["paragraph", "第二段。"],
  ]);
});

test("ATX and Setext headings are independent blocks while a standalone rule stays a rule", () => {
  const blocks = splitAssistantMarkdownBlocks(
    "headings",
    ["## ATX", "", "Setext title", "---", "", "___"].join("\n"),
  );
  assert.deepEqual(blocks.map(block => [block.kind, block.markdown]), [
    ["heading", "## ATX"],
    ["heading", "Setext title\n---"],
    ["rule", "___"],
  ]);
});

test("ordered and unordered list items keep indented children in one block", () => {
  const markdown = [
    "- 第一项",
    "  延续说明",
    "  - 子项",
    "1. 第二项",
    "   1) 子项",
  ].join("\n");
  assert.deepEqual(splitAssistantMarkdownBlocks("list", markdown), [
    { id: "list:0", kind: "list", markdown },
  ] satisfies AssistantMarkdownBlock[]);
});

test("consecutive explicit quote lines remain one block", () => {
  const markdown = ["> 第一行", ">", "> 第二行"].join("\n");
  assert.deepEqual(splitAssistantMarkdownBlocks("quote", markdown), [
    { id: "quote:0", kind: "blockquote", markdown },
  ]);
});

test("backtick and tilde fences preserve internal Markdown and closing fence length", () => {
  const source = [
    "````ts",
    "# 不是标题",
    "",
    "```",
    "- 也不是列表",
    "````",
    "",
    "~~~",
    "> 不是引用",
    "~~~",
  ].join("\n");
  const blocks = splitAssistantMarkdownBlocks("code", source);
  assert.deepEqual(blocks.map(block => block.kind), ["code", "code"]);
  assert.equal(blocks[0]?.markdown, source.split("\n\n~~~")[0]);
  assert.equal(blocks[1]?.markdown, ["~~~", "> 不是引用", "~~~"].join("\n"));
});

test("an unclosed fence consumes the rest of the answer as code", () => {
  const markdown = ["前文", "", "```js", "const value = 1;", "", "## 仍是代码"].join("\n");
  const blocks = splitAssistantMarkdownBlocks("open", markdown);
  assert.deepEqual(blocks.map(block => block.kind), ["paragraph", "code"]);
  assert.equal(blocks[1]?.markdown, ["```js", "const value = 1;", "", "## 仍是代码"].join("\n"));
});

test("a Markdown table remains one block", () => {
  const markdown = [
    "| 项目 | 结果 |",
    "| :--- | ---: |",
    "| A | 通过 |",
    "| B | 保留 `|` 字符 |",
  ].join("\n");
  assert.deepEqual(splitAssistantMarkdownBlocks("table", markdown), [
    { id: "table:0", kind: "table", markdown },
  ]);
});

test("a standalone image takes one adjacent caption but not the next explicit block", () => {
  const source = [
    "![替代文字](assets/demo.png \"标题\")",
    "*图：紧邻说明*",
    "## 后续标题",
  ].join("\n");
  assert.deepEqual(
    splitAssistantMarkdownBlocks("image", source).map(block => [block.kind, block.markdown]),
    [
      ["image", "![替代文字](assets/demo.png \"标题\")\n*图：紧邻说明*"],
      ["heading", "## 后续标题"],
    ],
  );
});

test("unknown Markdown stays verbatim in a conservative paragraph", () => {
  const markdown = ["<custom-tag data-x=\"1\">", "[link][reference]  ", "{unknown}"].join("\n");
  const block = splitAssistantMarkdownBlocks("unknown", markdown);
  assert.deepEqual(block, [{ id: "unknown:0", kind: "paragraph", markdown }]);
});

test("block order, IDs, and Markdown characters are deterministic", () => {
  const source = [
    "## 先说结论",
    "",
    "这是第一段。",
    "仍属于第一段。",
    "",
    "- 第一项",
    "  - 子项",
    "- 第二项",
    "",
    "```ts",
    "const title = '# 不是标题';",
    "",
    "console.log(title);",
    "```",
  ].join("\n");
  const first = splitAssistantMarkdownBlocks("assistant-1", source);
  const second = splitAssistantMarkdownBlocks("assistant-1", source);

  assert.deepEqual(first, second);
  assert.deepEqual(first.map(block => block.id), [
    "assistant-1:0",
    "assistant-1:1",
    "assistant-1:2",
    "assistant-1:3",
  ]);
  assert.deepEqual(first.map(block => block.kind), ["heading", "paragraph", "list", "code"]);
  assert.equal(first.map(block => block.markdown).join("\n\n"), source);
});

test("Markdown insertion handles an empty document, document start, line start, and document end", () => {
  assert.deepEqual(buildMarkdownBlockInsertion("", 0, "素材块"), {
    text: "素材块",
    cursorOffset: "素材块".length,
  } satisfies MarkdownBlockInsertion);

  assert.deepEqual(buildMarkdownBlockInsertion("原文", 0, "素材块"), {
    text: "素材块\n\n",
    cursorOffset: "素材块".length,
  });

  const documentText = "上文\n当前行";
  const offset = "上文\n".length;
  const markdown = "- 一\n- 二";
  assert.deepEqual(buildMarkdownBlockInsertion(documentText, offset, markdown), {
    text: `\n${markdown}\n\n`,
    cursorOffset: offset + 1 + markdown.length,
  });

  assert.deepEqual(buildMarkdownBlockInsertion("原文", "原文".length, "素材块"), {
    text: "\n\n素材块",
    cursorOffset: "原文".length + 2 + "素材块".length,
  });
});

test("Markdown insertion adds only the missing 0, 1, or 2 boundary newlines", () => {
  const leftCases = [
    { documentText: "前文", prefix: "\n\n" },
    { documentText: "前文\n", prefix: "\n" },
    { documentText: "前文\n\n", prefix: "" },
  ];
  for (const { documentText, prefix } of leftCases) {
    assert.deepEqual(buildMarkdownBlockInsertion(documentText, documentText.length, "块"), {
      text: `${prefix}块`,
      cursorOffset: documentText.length + prefix.length + 1,
    });
  }

  const rightCases = [
    { documentText: "后文", suffix: "\n\n" },
    { documentText: "\n后文", suffix: "\n" },
    { documentText: "\n\n后文", suffix: "" },
  ];
  for (const { documentText, suffix } of rightCases) {
    assert.deepEqual(buildMarkdownBlockInsertion(documentText, 0, "块"), {
      text: `块${suffix}`,
      cursorOffset: 1,
    });
  }
});

test("Markdown insertion adopts CRLF and keeps fenced-code indentation and internal blank lines", () => {
  const documentText = "上文\r\n下文";
  const offset = "上文\r\n".length;
  const markdown = "\r\n```ts\r\n  const value = 1;  \r\n\r\n  value;\r\n```\r\n\t\r\n";
  const block = "```ts\r\n  const value = 1;  \r\n\r\n  value;\r\n```";

  assert.deepEqual(buildMarkdownBlockInsertion(documentText, offset, markdown), {
    text: `\r\n${block}\r\n\r\n`,
    cursorOffset: offset + 2 + block.length,
  });
});

test("Markdown insertion preserves list, quote, table, and fence content", () => {
  const fixtures = [
    "- 一\n  - 子项\n- 二",
    "> 引用\n> 第二行",
    "| A | B |\n| --- | --- |\n| 1 | 2 |",
    "~~~js\nconst x = 1;\n\n~~~",
  ];
  for (const markdown of fixtures) {
    assert.deepEqual(buildMarkdownBlockInsertion("", 0, markdown), {
      text: markdown,
      cursorOffset: markdown.length,
    });
  }
});

test("Markdown insertion rejects invalid offsets and treats separator-only Markdown as empty", () => {
  for (const offset of [-1, 4, 0.5, Number.NaN]) {
    assert.throws(
      () => buildMarkdownBlockInsertion("abc", offset, "块"),
      /offset/i,
    );
  }
  assert.deepEqual(buildMarkdownBlockInsertion("abc", 1, "\n \t\n"), {
    text: "",
    cursorOffset: 1,
  });
});
