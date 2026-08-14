import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeReferencedImageAssets,
  moveNoteStatePath,
  type ImageAsset,
  type NoteState,
} from "../src/types.ts";

test("renaming a Markdown note moves its complete WriteX state once", () => {
  const state: NoteState = {
    messages: [{ id: "m1", role: "user", kind: "text", content: "继续", createdAt: 1 }],
    assets: [{
      id: "a1",
      filePath: "images/a.png",
      name: "a.png",
      mimeType: "image/png",
      source: "generated",
      createdAt: 2,
    }],
    themeId: "moyu-green",
  };
  const notes = { "旧名字.md": state };

  assert.equal(moveNoteStatePath(notes, "旧名字.md", "新名字.md"), true);
  assert.equal(notes["旧名字.md"], undefined);
  assert.equal(notes["新名字.md"], state);
  assert.equal(moveNoteStatePath(notes, "旧名字.md", "新名字.md"), false);
});

test("referenced local images enter the gallery as manual assets without duplicates", () => {
  const assets: ImageAsset[] = [{
    id: "generated",
    filePath: "images/generated.png",
    name: "generated.png",
    mimeType: "image/png",
    source: "generated",
    createdAt: 1,
  }];
  const added = mergeReferencedImageAssets(assets, [
    { filePath: "images/generated.png", name: "generated.png", mimeType: "image/png" },
    { filePath: "Pasted image.png", name: "Pasted image.png", mimeType: "image/png" },
    { filePath: "Pasted image.png", name: "Pasted image.png", mimeType: "image/png" },
  ], () => "manual-1", () => 10);

  assert.equal(added, 1);
  assert.equal(assets.length, 2);
  assert.deepEqual(assets[0], {
    id: "manual-1",
    filePath: "Pasted image.png",
    name: "Pasted image.png",
    mimeType: "image/png",
    source: "manual",
    createdAt: 10,
    writeCredits: 0,
  });
  assert.equal(assets[1]?.source, "generated");
});

