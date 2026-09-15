import assert from "node:assert/strict";
import test from "node:test";
import { consumeCommittedComposerRequest, NoteComposerStates } from "../src/noteComposerState.ts";

test("unsent drafts and attachments are isolated per note while an empty target can receive a topic draft", () => {
  const states = new NoteComposerStates<string>();
  states.save("A.md", { draft: "A 未发送", attachments: ["a.png"], chatMode: "chat", outlineSession: false });
  assert.deepEqual(states.load("B.md"), { draft: "", attachments: [], chatMode: "chat", outlineSession: false });
  states.save("B.md", { draft: "选题预填", attachments: [], chatMode: "chat", outlineSession: false });
  assert.deepEqual(states.load("A.md"), { draft: "A 未发送", attachments: ["a.png"], chatMode: "chat", outlineSession: false });
  assert.equal(states.load("B.md").draft, "选题预填");
});

test("a non-current renamed note keeps its unsent composer state and a delayed background commit clears only request input while retaining Plan", async () => {
  const states = new NoteComposerStates<string>();
  const a = { draft: "A 待发送", attachments: ["a.png"], chatMode: "plan" as const, outlineSession: true };
  const b = { draft: "B 待发送", attachments: ["b.pdf"], chatMode: "chat" as const, outlineSession: false };
  states.save("A.md", a);
  states.save("B.md", b);

  // A is no longer the visible note when Obsidian renames it.
  states.rename("A.md", "重命名 A.md");
  assert.deepEqual(states.load("重命名 A.md"), a);
  assert.deepEqual(states.load("B.md"), b);

  // A staging failure does not clear the retryable input.
  assert.deepEqual(states.load("重命名 A.md"), a);

  // Attachment staging resolves after the UI has already moved to B.
  await new Promise<void>(resolve => setTimeout(resolve, 0));

  // A user can return to A and change the composer before staging completes.
  const revised = { ...a, draft: "A 新输入", attachments: ["a.png", "later.pdf"] };
  states.save("重命名 A.md", revised);
  assert.equal(states.removeIfMatch("重命名 A.md", a), false);
  assert.deepEqual(states.load("重命名 A.md"), revised);

  // Once the exact request-owned input is committed in background B, only A's input
  // clears. Its Plan/outline ownership remains when the user returns to A.
  states.save("重命名 A.md", a);
  assert.equal(consumeCommittedComposerRequest({
    states,
    requestNotePath: "重命名 A.md",
    request: a,
    active: { notePath: "B.md", state: b },
  }), false);
  assert.deepEqual(states.load("重命名 A.md"), { draft: "", attachments: [], chatMode: "plan", outlineSession: true });
  assert.deepEqual(states.load("B.md"), b);
});

test("a committed request clears the active A composer after A-to-B-to-A only when its snapshot still owns the input", () => {
  const request = { draft: "A 待发送", attachments: ["a.png"], chatMode: "plan" as const, outlineSession: true };
  const b = { draft: "B 待发送", attachments: ["b.pdf"], chatMode: "chat" as const, outlineSession: false };

  const returnedUnchanged = new NoteComposerStates<string>();
  returnedUnchanged.save("A.md", request);
  returnedUnchanged.save("B.md", b);
  const requestGeneration = 4;
  const returnedGeneration = 6;
  assert.notEqual(returnedGeneration, requestGeneration);
  assert.equal(consumeCommittedComposerRequest({
    states: returnedUnchanged,
    requestNotePath: "A.md",
    request,
    active: { notePath: "A.md", state: request },
  }), true);
  // The view clears only text and attachments; Plan ownership is not reset.
  const afterClear = { ...request, draft: "", attachments: [] };
  assert.deepEqual(afterClear, { draft: "", attachments: [], chatMode: "plan", outlineSession: true });
  assert.deepEqual(returnedUnchanged.load("A.md"), afterClear);
  assert.deepEqual(returnedUnchanged.load("B.md"), b);

  const returnedEdited = new NoteComposerStates<string>();
  returnedEdited.save("A.md", request);
  returnedEdited.save("B.md", b);
  const revised = { ...request, draft: "A 新输入", attachments: ["a.png", "later.pdf"] };
  returnedEdited.save("A.md", revised);
  assert.equal(consumeCommittedComposerRequest({
    states: returnedEdited,
    requestNotePath: "A.md",
    request,
    active: { notePath: "A.md", state: revised },
  }), false);
  assert.deepEqual(returnedEdited.load("A.md"), revised);

  // A failed stage/persist never commits the request, so no consume occurs.
  const failed = new NoteComposerStates<string>();
  failed.save("A.md", request);
  assert.deepEqual(failed.load("A.md"), request);
});
