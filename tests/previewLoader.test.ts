import assert from "node:assert/strict";
import test from "node:test";
import { loadPreviewIfCurrent } from "../src/previewLoader.ts";

test("a delayed preview for A cannot commit after the active note becomes B", async () => {
  let releaseA!: (value: string) => void;
  const delayedA = new Promise<string>(resolve => { releaseA = resolve; });
  let activePath = "A.md";
  let generation = 1;
  let committed = "";
  const load = loadPreviewIfCurrent({
    notePath: "A.md",
    generation,
    isCurrent: (path, token) => path === activePath && token === generation,
    read: async () => delayedA,
    commit: markdown => { committed = markdown; },
  });
  activePath = "B.md";
  generation += 1;
  releaseA("A content");
  assert.equal(await load, false);
  assert.equal(committed, "");
});
