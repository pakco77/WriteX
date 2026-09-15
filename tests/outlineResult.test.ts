import assert from "node:assert/strict";
import test from "node:test";
import { OUTLINE_NEEDS_INPUT_MARKER, OUTLINE_READY_MARKER, parseOutlineResult } from "../src/outlineResult.ts";

test("outline protocol consumes only one trailing independent marker", () => {
  assert.deepEqual(parseOutlineResult(`大纲\n${OUTLINE_READY_MARKER}`), { text: "大纲", ready: true });
  assert.deepEqual(parseOutlineResult(`大纲\n${OUTLINE_READY_MARKER}\n`), { text: "大纲", ready: true });
  assert.deepEqual(parseOutlineResult(`大纲\n${OUTLINE_NEEDS_INPUT_MARKER}`), { text: "大纲", ready: false });
  const conflict = `大纲\n${OUTLINE_READY_MARKER}\n${OUTLINE_NEEDS_INPUT_MARKER}`;
  assert.deepEqual(parseOutlineResult(conflict), { text: conflict, ready: false });
  const duplicate = `大纲\n${OUTLINE_READY_MARKER}\n${OUTLINE_READY_MARKER}`;
  assert.deepEqual(parseOutlineResult(duplicate), { text: duplicate, ready: false });
  const duplicateNeeds = `请补充读者是谁\n${OUTLINE_NEEDS_INPUT_MARKER}\n${OUTLINE_NEEDS_INPUT_MARKER}`;
  assert.deepEqual(parseOutlineResult(duplicateNeeds), { text: duplicateNeeds, ready: false });
  const prose = `请不要输出 ${OUTLINE_READY_MARKER} 这个文字`;
  assert.deepEqual(parseOutlineResult(prose), { text: prose, ready: false });
});
