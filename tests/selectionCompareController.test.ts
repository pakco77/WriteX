import assert from "node:assert/strict";
import test from "node:test";
import { prepareSelectionComparison, SelectionCompareController } from "../src/selectionCompareController.ts";
import { replaceCapturedRange } from "../src/writingStyleController.ts";
import { computeSelectionReplacement } from "../src/selectionReplacement.ts";

function rebuilt(parts: Array<{ kind: "same" | "added" | "removed"; text: string }>): { original: string; suggestion: string } {
  return {
    original: parts.filter(part => part.kind !== "added").map(part => part.text).join(""),
    suggestion: parts.filter(part => part.kind !== "removed").map(part => part.text).join(""),
  };
}

test("bounded selection diff preserves every comparison case and reconstructs both sides", () => {
  for (const [original, suggestion] of [
    ["完全相同", "完全相同"],
    ["", "纯新增"],
    ["纯删除", ""],
    [" \t", "  \t"],
    ["甲\r\n乙", "甲\r\n丙\r\n乙"],
    ["第一行\n\n第三行", "第一行\n\n第二行\n\n第三行"],
  ]) {
    const comparison = prepareSelectionComparison(original, suggestion, 1_000);
    assert.equal(comparison.truncated, false);
    assert.deepEqual(rebuilt(comparison.parts), { original, suggestion });
  }
  const long = prepareSelectionComparison("原".repeat(101), "新".repeat(101), 100);
  assert.deepEqual(long, { parts: [], truncated: true });
});

test("comparison preview and keeping the original make zero editor writes", () => {
  let writes = 0;
  let closes = 0;
  const controller = new SelectionCompareController(async () => { writes += 1; }, () => { closes += 1; });
  const preview = prepareSelectionComparison("原文", "建议");
  assert.equal(preview.truncated, false);
  assert.equal(writes, 0);
  controller.keepOriginal();
  assert.equal(writes, 0);
  assert.equal(closes, 1);
});

test("comparison preview and the protected write share one whitespace-safe replacement", () => {
  for (const [original, markdown, expected] of [
    ["  原文\r\n", "建议", "  建议\r\n"],
    ["\n\n原文\n\n", "```md\n建议\n```", "\n\n建议\n\n"],
    ["   \r\n\t", "建议", "建议"],
  ]) {
    const replacement = computeSelectionReplacement(original, markdown);
    assert.equal(replacement, expected);
    const preview = prepareSelectionComparison(original, replacement);
    assert.equal(preview.truncated, false);
    let applied = "";
    replaceCapturedRange({
      getRange: () => original,
      replaceRange: value => { applied = value; },
      focus: () => undefined,
    }, { text: original, from: { line: 0, ch: 0 }, to: { line: 0, ch: original.length } }, replacement);
    assert.equal(applied, replacement);
  }
});

test("comparison apply consumes the modal after the first replacement attempt", async () => {
  let writes = 0;
  let closes = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const controller = new SelectionCompareController(async () => { writes += 1; await pending; }, () => { closes += 1; });
  const first = controller.applyOnce();
  assert.equal(await controller.applyOnce(), false);
  assert.equal(writes, 1);
  release();
  assert.equal(await first, true);
  assert.equal(closes, 1);

  let attempts = 0;
  let errorCloses = 0;
  const retry = new SelectionCompareController(async () => { attempts += 1; throw new Error("range changed"); }, () => { errorCloses += 1; });
  await assert.rejects(retry.applyOnce(), /结果可能不确定/);
  assert.equal(await retry.applyOnce(), false);
  assert.equal(attempts, 1);
  assert.equal(errorCloses, 1);

  let editorWrites = 0;
  const uncertainEditorWrite = new SelectionCompareController(async () => {
    replaceCapturedRange({
      getRange: () => "原文",
      replaceRange: () => { editorWrites += 1; throw new Error("editor replaceRange result is unknown"); },
      focus: () => undefined,
    }, { text: "原文", from: { line: 0, ch: 0 }, to: { line: 0, ch: 2 } }, "建议");
  }, () => undefined);
  await assert.rejects(uncertainEditorWrite.applyOnce(), /结果可能不确定/);
  assert.equal(await uncertainEditorWrite.applyOnce(), false);
  assert.equal(editorWrites, 1);
});
